import { lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runGit, runLocationGit } from "@rainver/folder-read";
import { configDir } from "./config.js";
import { captureWorkspaceTree } from "./gitDiff.js";
import { commitOfRef, resolveMainBranch } from "./mainBranch.js";
import { releaseLocationLeases, tryAcquireLease } from "./locationLease.js";
import {
  addTaskWorktree,
  checkLocationRepository,
  gitOrThrow,
  ID_SEGMENT,
  isAncestor,
  listWorktrees,
  mergeRecordPath,
  moveBranch,
  ownEntry,
  readJson,
  readyWorktreeForMerge,
  retireWorktree,
  TASK_BUSY,
  taskBranchName,
  taskBranchRef,
  taskLeaseKey,
  validTaskWorktreeIds,
  withTaskHeld,
  worktreesBase,
  WORKTREE_TIMEOUT_MS,
  writeCommit,
  writeJson,
  type GitIdentity,
  type LocationRepository,
} from "./taskWorktree.js";

/**
 * Merging a done Task's branch into the main branch, in the Task's worktree
 * (ADR 0016 §11; hosts.md "Merging a done Task"). The control plane drives it one
 * step per frame, each with the Task's lease held:
 *
 * - `task_merge_prepare` squashes the branch since its merge base with the
 *   main branch into one unsigned commit (the "squashed commit"), merges it
 *   with the main branch's tip in memory (`git merge-tree --write-tree`) and,
 *   when that is clean, commits the result on top of the tip — the rebased
 *   Task commit. A conflict writes the merged tree, markers and all, into the
 *   worktree (HEAD stays the squashed commit) for a resolution Run, then
 *   `task_merge_continue` commits what the worktree holds; or
 *   `task_merge_abort` puts it back.
 * - `task_merge_finish` moves the main branch to the verified Task commit by
 *   fast-forward only, and removes the Task's worktree and branch.
 *
 * Git's sequencer (`rebase`, `cherry-pick`) is never used: its state lives in
 * the worktree's entry under `.git/worktrees/`, which a strict resolution Run
 * can write, and `--continue`/`--abort` obey it — a planted `exec` line, a
 * signing option, or a `head-name` naming the main branch. Every commit here
 * is written by `commit-tree` from a tree the daemon computed or captured,
 * with an author, committer and message the daemon holds; every ref moves by
 * compare-and-swap. Merges need git 2.38 (`merge-tree --write-tree`).
 *
 * `merge-tree` can run a merge driver the repository's own configuration
 * defines and `.gitattributes` selects — configuration an Agent can write —
 * so each such driver is replaced by `false` (the file conflicts instead).
 *
 * While a merge is in progress its record
 * (`<config>/task-records/<location_id>/<task_id>.merge.json`) holds the
 * worktree: no settle or sweep touches it, and no ordinary launch while it is
 * `preparing` or `conflict` (one finding it `rebased` drops it). A finished
 * merge's answer is kept at `<config>/task-merges/<merge_id>.json`.
 */

type MergeState = "preparing" | "conflict" | "rebased";

interface MergeRecord {
  merge_id: string;
  state: MergeState;
  main_branch: string;
  /** The main branch's tip the Task is merged onto. */
  onto_commit: string;
  /** The single commit the branch was squashed to; abort returns the branch here. */
  squash_commit: string;
  /** The Task commit on top of `onto_commit`, once `rebased`. */
  task_commit: string | null;
  /**
   * The commit about to become the Task commit, written before the branch
   * moves: a step cut short between the two finds the branch there and
   * finishes rather than redoing the resolution.
   */
  pending_task_commit: string | null;
  /** The tree `merge-tree` wrote, markers and all: what the worktree was given, and what continue captures on top of. */
  merged_tree: string | null;
  /** Every path that conflicted (never cut to what the wire carries). */
  conflicts: ConflictEntry[];
  author: GitIdentity;
  message: string;
  updated_at: string;
}

/**
 * One conflicted path as the merge left it: the object `merge-tree` wrote
 * there (null when it wrote none — a deleted side) and whether that object
 * held conflict markers. A path without markers (a binary file, a
 * modify/delete) is resolved only by changing it.
 */
interface ConflictEntry {
  path: string;
  merged: string | null;
  markers: boolean;
}

interface FinishedMerge {
  location_id: string;
  task_id: string;
  merged_commit: string;
}

const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_FILES = 500;
const MAX_PATH = 4096;
/** A conflicted file larger than this is not searched and counts as holding markers. */
const MARKER_SCAN_LIMIT = 64 * 1024 * 1024;
/**
 * A conflict hunk always opens and closes with these — seven or more, since
 * the `conflict-marker-size` attribute lengthens them; a lone `=======` (a
 * Markdown underline) is not one.
 */
const CONFLICT_MARKER = /^(?:<{7,}|>{7,})(?:[ \r]|$)/m;
/** Merge state files git writes in a checkout's git directory, read at most this far. */
const STATE_READ_LIMIT = 4096;

export interface TaskMergeStepResult {
  ok: boolean;
  outcome: "rebased" | "conflict" | "unresolved" | "no_changes" | null;
  main_branch: string | null;
  onto_commit: string | null;
  task_commit: string | null;
  conflicted_files: string[];
  error: string | null;
}

export interface TaskMergeAbortResult {
  ok: boolean;
  error: string | null;
}

export interface TaskMergeFinishResult {
  ok: boolean;
  outcome: "merged" | "main_moved" | "waiting_local_changes" | null;
  merged_commit: string | null;
  overlapping_files: string[];
  error: string | null;
}

interface MergeTarget {
  locationRoot: string | null;
  locationId: string;
  taskId: string;
  mergeId: string;
}

function stepError(error: string): TaskMergeStepResult {
  return { ok: false, outcome: null, main_branch: null, onto_commit: null, task_commit: null, conflicted_files: [], error };
}

function finishError(error: string): TaskMergeFinishResult {
  return { ok: false, outcome: null, merged_commit: null, overlapping_files: [], error };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validTarget(target: MergeTarget): boolean {
  return validTaskWorktreeIds(target.locationId, target.taskId) && ID_SEGMENT.test(target.mergeId);
}

/** Git's version, once it has been read (`merge-tree --write-tree` arrived in 2.38). */
let mergeGitVersion: readonly [number, number] | null = null;

async function requireMergeGit(): Promise<void> {
  if (!mergeGitVersion) {
    const result = await runGit(["version"], tmpdir(), 10_000);
    const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
    if (!match) throw new Error("git_too_old");
    mergeGitVersion = [Number(match[1]), Number(match[2])];
  }
  const [major, minor] = mergeGitVersion;
  if (major < 2 || (major === 2 && minor < 38)) throw new Error("git_too_old");
}

// ---------------------------------------------------------------------------
// Records

async function readMergeRecord(locationId: string, taskId: string): Promise<MergeRecord | null> {
  return storedMergeRecord(await readJson(mergeRecordPath(locationId, taskId)));
}

/** The record a stored value holds, or null when it is not one this daemon wrote. */
function storedMergeRecord(value: Record<string, unknown> | null): MergeRecord | null {
  if (!value) return null;
  const { merge_id, state, main_branch, onto_commit, squash_commit, task_commit, pending_task_commit, merged_tree, conflicts, author, message, updated_at } = value;
  const identity = author as Partial<GitIdentity> | null;
  if (typeof merge_id !== "string" || !ID_SEGMENT.test(merge_id)
    || (state !== "preparing" && state !== "conflict" && state !== "rebased")
    || typeof main_branch !== "string" || typeof onto_commit !== "string" || !COMMIT_ID.test(onto_commit)
    || typeof squash_commit !== "string" || !COMMIT_ID.test(squash_commit)
    || (task_commit !== null && (typeof task_commit !== "string" || !COMMIT_ID.test(task_commit)))
    || (pending_task_commit !== null && (typeof pending_task_commit !== "string" || !COMMIT_ID.test(pending_task_commit)))
    || (merged_tree !== null && (typeof merged_tree !== "string" || !COMMIT_ID.test(merged_tree)))
    || !Array.isArray(conflicts) || !conflicts.every(isConflictEntry)
    || !identity || typeof identity.name !== "string" || typeof identity.email !== "string"
    || typeof message !== "string" || typeof updated_at !== "string") return null;
  return {
    merge_id, state, main_branch, onto_commit, squash_commit, task_commit,
    pending_task_commit, merged_tree, conflicts: conflicts as ConflictEntry[],
    author: { name: identity.name, email: identity.email }, message, updated_at,
  };
}

function isConflictEntry(value: unknown): value is ConflictEntry {
  const entry = value as Partial<ConflictEntry> | null;
  return Boolean(entry && typeof entry.path === "string" && typeof entry.markers === "boolean"
    && (entry.merged === null || (typeof entry.merged === "string" && COMMIT_ID.test(entry.merged))));
}

/** The conflicted paths the wire carries (at most 500, none over 4096 characters). */
function wireFiles(record: MergeRecord): string[] {
  return boundedFiles(record.conflicts.map((conflict) => conflict.path));
}

/** Whether the wire could not carry every conflicted path: the resolution Run was not shown them all. */
function conflictsCut(record: MergeRecord): boolean {
  return record.conflicts.length > MAX_FILES || record.conflicts.some((conflict) => conflict.path.length > MAX_PATH);
}

async function writeMergeRecord(locationId: string, taskId: string, record: MergeRecord): Promise<void> {
  await writeJson(mergeRecordPath(locationId, taskId), { ...record, updated_at: new Date().toISOString() });
}

async function removeMergeRecord(locationId: string, taskId: string): Promise<void> {
  await rm(mergeRecordPath(locationId, taskId), { force: true });
}

function finishedMergePath(mergeId: string): string {
  return join(configDir(), "task-merges", `${mergeId}.json`);
}

async function readFinishedMerge(mergeId: string): Promise<FinishedMerge | null> {
  const value = await readJson(finishedMergePath(mergeId));
  if (!value) return null;
  const { location_id, task_id, merged_commit } = value;
  if (typeof location_id !== "string" || typeof task_id !== "string" || typeof merged_commit !== "string" || !COMMIT_ID.test(merged_commit)) return null;
  return { location_id, task_id, merged_commit };
}

// ---------------------------------------------------------------------------
// Git

/** Git's stdout untouched — `-z` output must not be trimmed (a status line starts with a space). */
async function gitRaw(args: readonly string[], cwd: string): Promise<string> {
  const result = await runLocationGit(args, cwd);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 400) || `exit ${result.code}`}`);
  return result.stdout;
}

/** `-z` output split into its non-empty fields. */
function nulFields(output: string): string[] {
  return output.split("\0").filter((field) => field.length > 0);
}

function boundedFiles(files: Iterable<string>): string[] {
  return [...new Set(files)].filter((file) => file.length <= MAX_PATH).sort().slice(0, MAX_FILES);
}

/**
 * `-c merge.<name>.driver=false` for each merge driver the repository's own
 * configuration defines (global and system ones are the owner's). A driver
 * name `-c` cannot carry refuses the merge instead.
 */
async function mergeDriverOverrides(cwd: string): Promise<string[]> {
  const probe = await runLocationGit(["config", "-z", "--show-scope", "--get-regexp", "^merge\\..*\\.driver$"], cwd);
  if (probe.code === 1) return [];
  if (probe.code !== 0) throw new Error(`the repository's merge configuration could not be read: ${probe.stderr.trim().slice(0, 400)}`);
  const overrides: string[] = [];
  const fields = probe.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index]!;
    const key = fields[index + 1]!.split("\n", 1)[0]!;
    if (scope === "global" || scope === "system") continue;
    if (key.includes("=")) throw new Error("the repository configures a merge driver Rainver cannot neutralise");
    overrides.push("-c", `${key}=false`);
  }
  return overrides;
}

/**
 * `git merge-tree --write-tree` of the squashed commit onto the main branch's
 * tip: the merged tree (conflict markers written into it) and the paths that
 * conflicted. Git picks the merge base, the squashed commit's parent.
 */
async function mergeTrees(path: string, onto: string, squash: string): Promise<{ tree: string; conflicted: string[] }> {
  const overrides = await mergeDriverOverrides(path);
  const result = await runLocationGit(
    [...overrides, "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", onto, squash],
    path,
    WORKTREE_TIMEOUT_MS,
  );
  if (result.code !== 0 && result.code !== 1) throw new Error(`git merge-tree failed: ${result.stderr.trim().slice(0, 400) || `exit ${result.code}`}`);
  const [tree, ...conflicted] = nulFields(result.stdout);
  if (!tree || !COMMIT_ID.test(tree)) throw new Error("git merge-tree answered no tree");
  return { tree, conflicted: result.code === 1 ? [...new Set(conflicted)] : [] };
}

async function treeOf(repoRoot: string, commit: string): Promise<string> {
  return gitOrThrow(["rev-parse", `${commit}^{tree}`], repoRoot);
}

/**
 * The worktree checked out at its branch's tip, clean: `reset --hard` and
 * `clean -fdx` when HEAD is the Task branch, otherwise (a Run switched it)
 * removed and made again.
 */
async function resetWorktreeToBranch(repo: LocationRepository, locationId: string, taskId: string, path: string): Promise<void> {
  const head = await runLocationGit(["symbolic-ref", "-q", "HEAD"], path);
  if (head.code === 0 && head.stdout.trim() === taskBranchRef(taskId)) {
    await gitOrThrow(["reset", "-q", "--hard", "HEAD"], path, WORKTREE_TIMEOUT_MS);
    await gitOrThrow(["clean", "-q", "-f", "-d", "-x"], path, WORKTREE_TIMEOUT_MS);
    return;
  }
  await retireWorktree(repo, locationId, taskId, path);
  await addTaskWorktree(repo, locationId, taskId, path);
}

/**
 * Puts the Task back as the merge found it after its squash: the branch on
 * the squashed commit (compare-and-swap from wherever it is), the worktree
 * reset to it, the record gone. What abort does, and what every error after
 * the record was written does.
 */
async function restoreSquash(repo: LocationRepository, locationId: string, taskId: string, record: MergeRecord): Promise<void> {
  const ref = taskBranchRef(taskId);
  const tip = await commitOfRef(repo.root, ref);
  if (!tip) {
    // Deleted (a Run ran `git branch -D`): made again, or the squashed commit
    // — the Task's whole change — would be referenced by nothing.
    await gitOrThrow(["update-ref", "-m", "rainver: restore the squashed Task", ref, record.squash_commit, ""], repo.root);
  } else if (tip !== record.squash_commit) {
    await moveBranch(repo.root, ref, record.squash_commit, tip, "rainver: restore the squashed Task");
  }
  const { path, entry } = await worktreeAt(repo, locationId, taskId);
  if (entry) await resetWorktreeToBranch(repo, locationId, taskId, path);
  await removeMergeRecord(locationId, taskId);
}

/** Runs a merge step; on any error after the record exists, puts the squashed commit back first. */
async function orRestore<T>(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  step: () => Promise<T>,
  onError: (error: unknown) => T,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const record = await readMergeRecord(locationId, taskId).catch(() => null);
    if (record) await restoreSquash(repo, locationId, taskId, record).catch(() => undefined);
    return onError(error);
  }
}

/** The Task worktree's path and, when it is a recognisable worktree, its entry. */
async function worktreeAt(repo: LocationRepository, locationId: string, taskId: string): Promise<{ path: string; entry: string | null }> {
  const base = await worktreesBase(locationId, false);
  if (!base) return { path: "", entry: null };
  const path = join(base, taskId);
  return { path, entry: await ownEntry(repo, path) };
}

async function usableRepository(locationRoot: string | null): Promise<LocationRepository> {
  if (!locationRoot) throw new Error("This daemon has no local path registered for that workspace.");
  const check = await checkLocationRepository(locationRoot);
  if (check.kind !== "repository") {
    throw new Error(`The Location's repository cannot be used: ${check.kind === "unusable" ? check.reason : check.kind}`);
  }
  return check.repo;
}

function rebasedAnswer(record: MergeRecord, taskCommit: string): TaskMergeStepResult {
  return {
    ok: true, outcome: "rebased", main_branch: record.main_branch, onto_commit: record.onto_commit,
    task_commit: taskCommit, conflicted_files: [], error: null,
  };
}

function conflictAnswer(record: MergeRecord, outcome: "conflict" | "unresolved", files: string[] = wireFiles(record)): TaskMergeStepResult {
  return {
    ok: true, outcome, main_branch: record.main_branch, onto_commit: record.onto_commit,
    task_commit: null, conflicted_files: boundedFiles(files), error: null,
  };
}

function noChanges(mainBranch: string | null, onto: string | null): TaskMergeStepResult {
  return { ok: true, outcome: "no_changes", main_branch: mainBranch, onto_commit: onto, task_commit: null, conflicted_files: [], error: null };
}

/**
 * Commits `tree` on top of `onto_commit` as the Task commit (the record's
 * author, committer and message; unsigned), moves the branch to it by
 * compare-and-swap from `expectedTip`, checks the worktree out at it, and
 * records the merge `rebased`.
 */
async function commitRebased(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  path: string,
  record: MergeRecord,
  tree: string,
  expectedTip: string,
): Promise<TaskMergeStepResult> {
  const commit = await writeCommit(repo.root, tree, record.onto_commit, record.author, record.message);
  await writeMergeRecord(locationId, taskId, { ...record, pending_task_commit: commit });
  await moveBranch(repo.root, taskBranchRef(taskId), commit, expectedTip, "rainver: the Task on the main branch");
  return settleRebased(repo, locationId, taskId, path, record, commit);
}

/** The branch is at the Task commit: the worktree checked out there, the merge recorded `rebased`. */
async function settleRebased(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  path: string,
  record: MergeRecord,
  commit: string,
): Promise<TaskMergeStepResult> {
  await resetWorktreeToBranch(repo, locationId, taskId, path);
  const rebased: MergeRecord = { ...record, state: "rebased", task_commit: commit, pending_task_commit: null };
  await writeMergeRecord(locationId, taskId, rebased);
  return rebasedAnswer(rebased, commit);
}

/**
 * What a tree holds at a path: its object and type, or null when nothing is
 * there. Asked with `ls-tree` from the worktree's root and `./` in front, so
 * no path is read as pathspec magic; throws when git cannot say (a caller
 * treats that as unresolved).
 */
async function entryAt(path: string, tree: string, file: string): Promise<{ oid: string; type: string } | null> {
  const listed = await runLocationGit(["ls-tree", "-z", tree, "--", `./${file}`], path);
  if (listed.code !== 0) throw new Error(`git ls-tree failed for ${file}`);
  for (const record of nulFields(listed.stdout)) {
    const match = /^\d+ (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (match && match[3] === file) return { type: match[1]!, oid: match[2]! };
  }
  return null;
}

/**
 * Whether a blob holds a conflict hunk: a line opening (`<<<<<<<`) or closing
 * (`>>>>>>>`) one. A blob too large to search counts as holding one.
 */
async function blobHoldsMarkers(path: string, oid: string): Promise<boolean> {
  const size = Number(await gitOrThrow(["cat-file", "-s", oid], path));
  if (!Number.isFinite(size) || size > MARKER_SCAN_LIMIT) return true;
  return CONFLICT_MARKER.test(await gitRaw(["cat-file", "blob", oid], path));
}

/** Each conflicted path as `merge-tree` wrote it into `tree`. */
async function describeConflicts(path: string, tree: string, files: string[]): Promise<ConflictEntry[]> {
  const conflicts: ConflictEntry[] = [];
  for (const file of files) {
    const entry = await entryAt(path, tree, file);
    const markers = entry?.type === "blob" ? await blobHoldsMarkers(path, entry.oid) : false;
    conflicts.push({ path: file, merged: entry?.oid ?? null, markers });
  }
  return conflicts;
}

/**
 * Whether the resolution left a conflicted path unresolved, read from the
 * captured tree (never the working file): it still holds a conflict hunk, or
 * — for a conflict that had none (a binary file, a modify/delete) — it is
 * exactly as the merge left it, so nobody decided. Anything git cannot answer
 * counts as unresolved.
 */
async function unresolvedPath(path: string, tree: string, conflict: ConflictEntry): Promise<boolean> {
  try {
    const entry = await entryAt(path, tree, conflict.path);
    if (entry?.type === "blob" && await blobHoldsMarkers(path, entry.oid)) return true;
    if (!conflict.markers) return (entry?.oid ?? null) === conflict.merged;
    return false;
  } catch {
    return true;
  }
}

/**
 * The merged tree with each conflicted path — and whatever lies under it,
 * should it have become a directory — taken from the captured worktree:
 * built in a private index (`read-tree <merged_tree>`, then `update-index`
 * per path, `write-tree`). A path absent from the capture is removed. Changes
 * the capture holds anywhere else are not taken.
 */
async function composeResolution(path: string, mergedTree: string, captured: string, conflicts: readonly ConflictEntry[]): Promise<string> {
  const indexDir = await mkdtemp(join(tmpdir(), "rainver-merge-index-"));
  const env = { GIT_INDEX_FILE: join(indexDir, "index") };
  const git = async (args: string[]): Promise<string> => {
    const result = await runLocationGit(args, path, WORKTREE_TIMEOUT_MS, { env });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 400) || `exit ${result.code}`}`);
    return result.stdout;
  };
  try {
    await git(["read-tree", mergedTree]);
    for (const conflict of conflicts) {
      const inMerged = await entriesUnder(path, mergedTree, conflict.path);
      const inCapture = await entriesUnder(path, captured, conflict.path);
      for (const entry of inMerged) await git(["update-index", "--force-remove", "--", entry.name]);
      for (const entry of inCapture) await git(["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.oid},${entry.name}`]);
    }
    return (await git(["write-tree"])).trim();
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

/** A tree's entries at `file` or below it (recursively; a submodule is one entry). */
async function entriesUnder(path: string, tree: string, file: string): Promise<Array<{ mode: string; oid: string; name: string }>> {
  const listed = await runLocationGit(["ls-tree", "-r", "-z", tree, "--", `./${file}`], path);
  if (listed.code !== 0) throw new Error(`git ls-tree failed for ${file}`);
  const entries: Array<{ mode: string; oid: string; name: string }> = [];
  for (const record of nulFields(listed.stdout)) {
    const match = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (match && (match[3] === file || match[3]!.startsWith(`${file}/`))) entries.push({ mode: match[1]!, oid: match[2]!, name: match[3]! });
  }
  return entries;
}

/**
 * Writes the conflict out again exactly as the merge left it: the branch on
 * the squashed commit (made again if deleted), the worktree's HEAD on the
 * branch, the merged tree with its markers over it. What the Run did is gone;
 * the merge record stays.
 */
async function rewriteConflict(repo: LocationRepository, taskId: string, path: string, record: MergeRecord, tip: string | null): Promise<void> {
  const ref = taskBranchRef(taskId);
  if (!tip) await gitOrThrow(["update-ref", "-m", "rainver: restore the squashed Task", ref, record.squash_commit, ""], repo.root);
  else if (tip !== record.squash_commit) await moveBranch(repo.root, ref, record.squash_commit, tip, "rainver: restore the squashed Task");
  await gitOrThrow(["symbolic-ref", "HEAD", ref], path);
  await gitOrThrow(["reset", "-q", "--hard", "HEAD"], path, WORKTREE_TIMEOUT_MS);
  await gitOrThrow(["clean", "-q", "-f", "-d", "-x"], path, WORKTREE_TIMEOUT_MS);
  await gitOrThrow(["read-tree", "--reset", "-u", record.merged_tree!], path, WORKTREE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Frames

/**
 * `task_merge_prepare`. Idempotent per `merge_id`: while this merge's
 * conflict is open it answers `conflict` again; already rebased onto the main
 * branch's current tip it answers `rebased` again; after the main branch moved
 * it squashes and merges again. Another merge's record is dropped (the
 * control plane runs one merge per Task, so an older one is abandoned) after
 * putting its squashed commit back.
 */
export async function prepareTaskMerge(input: MergeTarget & { author: GitIdentity; message: string }): Promise<TaskMergeStepResult> {
  if (!validTarget(input)) return stepError("The Location, Task or merge id cannot name a Task worktree.");
  const { locationId, taskId, mergeId } = input;
  const outcome = await withTaskHeld(taskLeaseKey(locationId, taskId), async (): Promise<TaskMergeStepResult> => {
    // A Location the Task's Runs worked in place — not a git checkout, or one
    // with no commit yet — has no Task branch: nothing to merge.
    if (input.locationRoot) {
      const check = await checkLocationRepository(input.locationRoot);
      if (check.kind === "not_git" || check.kind === "no_commit") return noChanges(null, null);
    }
    await requireMergeGit();
    const repo = await usableRepository(input.locationRoot);
    return orRestore(repo, locationId, taskId, async () => {
      // A record this daemon cannot read is still a record: what the worktree
      // holds is a merge's, and is discarded like any merge's leftovers.
      const stored = await readJson(mergeRecordPath(locationId, taskId));
      const hadRecord = stored !== null;
      let record = storedMergeRecord(stored);
      if (record?.merge_id === mergeId && record.state === "conflict") return conflictAnswer(record, "conflict");
      if (record && record.merge_id !== mergeId) {
        await restoreSquash(repo, locationId, taskId, record);
        record = null;
      }
      const main = await resolveMainBranch(repo.root);
      if (!main?.branch || main.branch === taskBranchName(taskId)) {
        await removeMergeRecord(locationId, taskId);
        return stepError("no_main_branch");
      }
      const ref = taskBranchRef(taskId);
      if (record?.state === "rebased" && record.onto_commit === main.commit && record.task_commit
        && await commitOfRef(repo.root, ref) === record.task_commit) {
        return rebasedAnswer(record, record.task_commit);
      }
      // After an earlier step of a merge what is left in the worktree is the
      // merge's own (conflicted files, what verification built): discarded.
      const ready = await readyWorktreeForMerge(repo, locationId, taskId, hadRecord);
      if (!ready) {
        await removeMergeRecord(locationId, taskId);
        return noChanges(main.branch, main.commit);
      }
      const tip = ready.tip;
      const base = await runLocationGit(["merge-base", main.commit, tip], repo.root);
      const mergeBase = base.code === 0 ? base.stdout.trim() : "";
      if (!COMMIT_ID.test(mergeBase)) {
        await removeMergeRecord(locationId, taskId);
        return stepError(`The Task branch shares no history with ${main.branch}.`);
      }
      const tipTree = await treeOf(repo.root, tip);
      if (await isAncestor(repo.root, tip, main.commit) || tipTree === await treeOf(repo.root, mergeBase)) {
        await removeMergeRecord(locationId, taskId);
        return noChanges(main.branch, main.commit);
      }
      const squash = await writeCommit(repo.root, tipTree, mergeBase, input.author, input.message);
      await moveBranch(repo.root, ref, squash, tip, "rainver: squash the Task for its merge");
      await gitOrThrow(["reset", "-q", "--hard", "HEAD"], ready.path, WORKTREE_TIMEOUT_MS);
      const preparing: MergeRecord = {
        merge_id: mergeId, state: "preparing", main_branch: main.branch, onto_commit: main.commit, squash_commit: squash,
        task_commit: null, pending_task_commit: null, merged_tree: null, conflicts: [],
        author: input.author, message: input.message, updated_at: "",
      };
      await writeMergeRecord(locationId, taskId, preparing);
      const merged = await mergeTrees(ready.path, main.commit, squash);
      if (merged.conflicted.length === 0) {
        if (merged.tree === await treeOf(repo.root, main.commit)) {
          // The main branch already holds the Task's change.
          await restoreSquash(repo, locationId, taskId, preparing);
          return noChanges(main.branch, main.commit);
        }
        return commitRebased(repo, locationId, taskId, ready.path, preparing, merged.tree, squash);
      }
      // The merged tree, markers and all, into the worktree and its index;
      // HEAD stays the squashed commit and no sequencer state is written.
      await gitOrThrow(["read-tree", "--reset", "-u", merged.tree], ready.path, WORKTREE_TIMEOUT_MS);
      const conflicted: MergeRecord = {
        ...preparing,
        state: "conflict",
        merged_tree: merged.tree,
        conflicts: await describeConflicts(ready.path, merged.tree, merged.conflicted),
      };
      await writeMergeRecord(locationId, taskId, conflicted);
      return conflictAnswer(conflicted, "conflict");
    }, (error) => stepError(errorText(error)));
  }).catch((error: unknown) => stepError(errorText(error)));
  return outcome ?? stepError(TASK_BUSY);
}

/**
 * `task_merge_continue`, after a resolution Run. The result is the merged
 * tree with only the conflicted paths taken from the worktree (captured on
 * top of the merged tree; a file the Run deleted is simply absent) — a
 * resolution Run may resolve conflicted files and nothing else; anything more
 * the Task needs is for a later Task Run. A conflicted path still holding a
 * conflict hunk, or a marker-less one left as the merge wrote it, answers
 * `unresolved` with the files; so does a result equal to `onto_commit`'s tree
 * (keeping nothing of the Task is the person's call) and a conflict list too
 * long for the wire. Otherwise the result is committed on top of
 * `onto_commit` → `rebased`. Continue never answers `no_changes`.
 *
 * The Run's own ref moves count for nothing. If it deleted the Task branch,
 * moved it anywhere but onto a descendant of the squashed commit, or took the
 * worktree's HEAD off the branch, the conflict is written out again as the
 * merge left it and the answer is `unresolved`.
 */
export async function continueTaskMerge(input: MergeTarget): Promise<TaskMergeStepResult> {
  if (!validTarget(input)) return stepError("The Location, Task or merge id cannot name a Task worktree.");
  const { locationId, taskId, mergeId } = input;
  const outcome = await withTaskHeld(taskLeaseKey(locationId, taskId), async (): Promise<TaskMergeStepResult> => {
    const record = await readMergeRecord(locationId, taskId);
    if (!record || record.merge_id !== mergeId) return stepError("no_merge");
    if (record.state === "rebased" && record.task_commit) return rebasedAnswer(record, record.task_commit);
    if (record.state !== "conflict") return stepError("no_conflict");
    await requireMergeGit();
    const repo = await usableRepository(input.locationRoot);
    return orRestore(repo, locationId, taskId, async () => {
      const ref = taskBranchRef(taskId);
      const { path, entry } = await worktreeAt(repo, locationId, taskId);
      if (!entry) throw new Error("The Task worktree is not a git worktree Rainver recognises.");
      if (!record.merged_tree) throw new Error("the merge recorded no merged tree");
      const tip = await commitOfRef(repo.root, ref);
      // A continue cut short after moving the branch: finish it.
      if (tip && record.pending_task_commit && tip === record.pending_task_commit) {
        return settleRebased(repo, locationId, taskId, path, record, tip);
      }
      // The resolution Run was not shown every conflicted path: the person decides.
      if (conflictsCut(record)) return conflictAnswer(record, "unresolved");
      // The Run moved what it must not: the branch (deleted it, reset it
      // elsewhere) or the worktree's HEAD (checked something else out). The
      // conflict is written out again as the merge left it, for the person.
      const head = await runLocationGit(["symbolic-ref", "-q", "HEAD"], path);
      if (!tip || head.code !== 0 || head.stdout.trim() !== ref
        || (tip !== record.squash_commit && !(await isAncestor(repo.root, record.squash_commit, tip)))) {
        await rewriteConflict(repo, taskId, path, record, tip);
        return conflictAnswer(record, "unresolved");
      }
      const captured = await captureWorkspaceTree(path, WORKTREE_TIMEOUT_MS, record.merged_tree);
      if (!captured) throw new Error("Git could not capture the Task worktree.");
      // Only the conflicted paths come from the worktree; everything else is
      // what the merge wrote, whatever the Run did to it.
      const tree = await composeResolution(path, record.merged_tree, captured, record.conflicts);
      const unresolved: string[] = [];
      for (const conflict of record.conflicts) {
        if (await unresolvedPath(path, tree, conflict)) unresolved.push(conflict.path);
      }
      if (unresolved.length > 0) return conflictAnswer(record, "unresolved", unresolved);
      // A resolution that keeps nothing of the Task is the person's call.
      if (tree === await treeOf(repo.root, record.onto_commit)) return conflictAnswer(record, "unresolved");
      return commitRebased(repo, locationId, taskId, path, record, tree, tip);
    }, (error) => stepError(errorText(error)));
  }).catch((error: unknown) => stepError(errorText(error)));
  return outcome ?? stepError(TASK_BUSY);
}

/**
 * `task_merge_abort`: the branch goes back to the merge's squashed commit
 * (compare-and-swap from wherever it is), the worktree is reset to it
 * (`reset --hard`, `clean -fdx`) and the record goes. Idempotent: no merge in
 * progress is success. Another merge's record is refused (`another_merge`).
 */
export async function abortTaskMerge(input: MergeTarget): Promise<TaskMergeAbortResult> {
  if (!validTarget(input)) return { ok: false, error: "The Location, Task or merge id cannot name a Task worktree." };
  const { locationId, taskId, mergeId } = input;
  const outcome = await withTaskHeld(taskLeaseKey(locationId, taskId), async (): Promise<TaskMergeAbortResult> => {
    const record = await readMergeRecord(locationId, taskId);
    if (!record) {
      await removeMergeRecord(locationId, taskId);
      return { ok: true, error: null };
    }
    if (record.merge_id !== mergeId) return { ok: false, error: "another_merge" };
    const repo = await usableRepository(input.locationRoot);
    await restoreSquash(repo, locationId, taskId, record);
    return { ok: true, error: null };
  }).catch((error: unknown): TaskMergeAbortResult => ({ ok: false, error: errorText(error) }));
  return outcome ?? { ok: false, error: TASK_BUSY };
}

/**
 * `task_merge_finish`: the main branch moves to `task_commit`, by
 * fast-forward only, from exactly `onto_commit`.
 *
 * - The record must be this merge, `rebased`, with these commits
 *   (`no_rebased_merge`, `merge_mismatch`); the Task branch's tip must be
 *   `task_commit` with `onto_commit` as its parent (`task_commit_mismatch`).
 * - Main already at `task_commit` (a finish that stopped right after moving
 *   it) is `merged`. Main anywhere else but `onto_commit` is `main_moved`.
 * - Main checked out in a worktree other than the Location's own checkout:
 *   `main_checked_out_elsewhere`.
 * - Someone mid-way through something on main — a rebase or bisect of it in
 *   any checkout, or a merge, cherry-pick or revert in the checkout that has
 *   it — answers `waiting_local_changes` with no files.
 * - Main checked out in the Location's checkout: its lease is taken without
 *   waiting (`location_busy`); HEAD must still be main at `onto_commit`
 *   (`main_moved`); the person's uncommitted files — modified, staged,
 *   untracked — and files the Task adds that exist there as ignored files,
 *   when the Task commit also changes them, answer `waiting_local_changes`
 *   with them; otherwise `merge --ff-only --no-overwrite-ignore
 *   --no-autostash`, after which main must be `task_commit`.
 * - Main checked out nowhere: compare-and-swap `update-ref`.
 *
 * On `merged` the answer is stored first (a repeat answers it again and
 * retries the cleanup), then the record, the worktree (nested repositories
 * kept, as a settle does) and the Task branch go.
 */
export async function finishTaskMerge(
  input: MergeTarget & { mainBranch: string; ontoCommit: string; taskCommit: string; log?: (line: string) => void },
): Promise<TaskMergeFinishResult> {
  if (!validTarget(input)) return finishError("The Location, Task or merge id cannot name a Task worktree.");
  const { locationId, taskId, mergeId, mainBranch, ontoCommit, taskCommit } = input;
  const log = input.log ?? (() => {});
  const merged = (commit: string): TaskMergeFinishResult => ({ ok: true, outcome: "merged", merged_commit: commit, overlapping_files: [], error: null });
  const finished = await readFinishedMerge(mergeId);
  if (finished && (finished.location_id !== locationId || finished.task_id !== taskId)) return finishError("That merge finished for another Task.");
  const outcome = await withTaskHeld(taskLeaseKey(locationId, taskId), async (): Promise<TaskMergeFinishResult> => {
    const stored = await readFinishedMerge(mergeId);
    if (stored) {
      // Answered again; the cleanup a crash may have cut short is retried.
      await usableRepository(input.locationRoot)
        .then((repo) => cleanUpMerged(repo, locationId, taskId, mergeId, stored.merged_commit, log))
        .catch((error: unknown) => log(`task ${taskId}: cleanup after its merge failed: ${errorText(error)}`));
      return merged(stored.merged_commit);
    }
    const repo = await usableRepository(input.locationRoot);
    const record = await readMergeRecord(locationId, taskId);
    if (!record || record.merge_id !== mergeId || record.state !== "rebased") return finishError("no_rebased_merge");
    if (record.main_branch !== mainBranch || record.onto_commit !== ontoCommit || record.task_commit !== taskCommit) {
      return finishError("merge_mismatch");
    }
    const taskRef = taskBranchRef(taskId);
    if (await commitOfRef(repo.root, taskRef) !== taskCommit) return finishError("task_commit_mismatch");
    if (await commitOfRef(repo.root, `${taskCommit}^1`) !== ontoCommit) return finishError("task_commit_mismatch");
    const mainRef = `refs/heads/${mainBranch}`;
    const moved = (): TaskMergeFinishResult => ({ ok: true, outcome: "main_moved", merged_commit: null, overlapping_files: [], error: null });
    const waiting = (files: string[]): TaskMergeFinishResult => ({ ok: true, outcome: "waiting_local_changes", merged_commit: null, overlapping_files: boundedFiles(files), error: null });
    const mainTip = await commitOfRef(repo.root, mainRef);
    if (mainTip === taskCommit) {
      // A finish that stopped right after moving main.
      await recordMerged(repo, locationId, taskId, mergeId, taskCommit, log);
      return merged(taskCommit);
    }
    if (mainTip !== ontoCommit) return moved();
    const holders = (await listWorktrees(repo.root)).filter((worktree) => worktree.branch === mainRef);
    if (holders.some((worktree) => worktree.path !== repo.root)) return finishError("main_checked_out_elsewhere");
    const checkoutHoldsMain = holders.length > 0;
    if (await mainIsBusy(repo, mainBranch, checkoutHoldsMain)) return waiting([]);
    if (checkoutHoldsMain) {
      const holder = `merge:${randomUUID()}`;
      if (!tryAcquireLease(locationId, holder)) return finishError("location_busy");
      try {
        const head = await runLocationGit(["symbolic-ref", "-q", "HEAD"], repo.root);
        if (head.code !== 0 || head.stdout.trim() !== mainRef || await commitOfRef(repo.root, "HEAD") !== ontoCommit) return moved();
        const overlap = await overlappingLocalChanges(repo.root, ontoCommit, taskCommit);
        if (overlap.length > 0) return waiting(overlap);
        const merge = await runLocationGit(
          ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", "--no-autostash", taskCommit],
          repo.root,
          WORKTREE_TIMEOUT_MS,
          { env: { GIT_EDITOR: ":" } },
        );
        if (merge.code !== 0) return finishError(`git merge --ff-only failed: ${merge.stderr.trim().slice(0, 400)}`);
        if (await commitOfRef(repo.root, mainRef) !== taskCommit) return finishError("the fast-forward did not leave the main branch at the Task commit");
      } finally {
        releaseLocationLeases([locationId], holder);
      }
    } else {
      const update = await runLocationGit(["update-ref", "-m", `rainver: merge Task ${taskId}`, mainRef, taskCommit, ontoCommit], repo.root);
      if (update.code !== 0) {
        if (await commitOfRef(repo.root, mainRef) !== ontoCommit) return moved();
        return finishError(`git update-ref failed: ${update.stderr.trim().slice(0, 400)}`);
      }
    }
    await recordMerged(repo, locationId, taskId, mergeId, taskCommit, log);
    return merged(taskCommit);
  }).catch((error: unknown) => finishError(errorText(error)));
  if (outcome) return outcome;
  // Busy: a finished merge still answers, its cleanup retried by a later repeat.
  return finished ? merged(finished.merged_commit) : finishError(TASK_BUSY);
}

/** Stores the merged answer, then cleans up (`cleanUpMerged`). */
async function recordMerged(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  mergeId: string,
  mergedCommit: string,
  log: (line: string) => void,
): Promise<void> {
  await writeJson(finishedMergePath(mergeId), { location_id: locationId, task_id: taskId, merged_commit: mergedCommit, at: new Date().toISOString() });
  await cleanUpMerged(repo, locationId, taskId, mergeId, mergedCommit, log);
}

/**
 * After `merged`, best-effort and repeatable: this merge's record goes, and
 * while the Task branch still stands at the merged commit, the worktree and
 * the branch (compare-and-swap) go too.
 */
async function cleanUpMerged(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  mergeId: string,
  mergedCommit: string,
  log: (line: string) => void,
): Promise<void> {
  const record = await readMergeRecord(locationId, taskId);
  if (record?.merge_id === mergeId) await removeMergeRecord(locationId, taskId);
  const taskRef = taskBranchRef(taskId);
  if (await commitOfRef(repo.root, taskRef) !== mergedCommit) return;
  const { path, entry } = await worktreeAt(repo, locationId, taskId);
  if (entry) {
    await retireWorktree(repo, locationId, taskId, path)
      .catch((error: unknown) => log(`task ${taskId}: its merged worktree could not be removed: ${errorText(error)}`));
  }
  const deleted = await runLocationGit(["update-ref", "-m", "rainver: the Task is merged", "-d", taskRef, mergedCommit], repo.root);
  if (deleted.code !== 0) log(`task ${taskId}: its merged branch could not be deleted: ${deleted.stderr.trim().slice(0, 400)}`);
}

/** A git state file's first 4 KiB: only a regular file, never through a final symlink, never a FIFO. */
async function readStateFile(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(STATE_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, STATE_READ_LIMIT, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Whether someone is mid-way through something on the main branch: a rebase
 * of it (`rebase-merge/head-name` or `rebase-apply/head-name` naming it) or a
 * bisect started from it (`BISECT_START`), in the Location's checkout or any
 * of its worktrees — both detach HEAD, which hides the branch from the
 * worktree list — or, in the checkout that has main, a merge, cherry-pick or
 * revert in progress.
 */
async function mainIsBusy(repo: LocationRepository, mainBranch: string, checkoutHoldsMain: boolean): Promise<boolean> {
  const mainRef = `refs/heads/${mainBranch}`;
  const gitDirs = [repo.gitCommonDir];
  const entries = join(repo.gitCommonDir, "worktrees");
  const info = await lstat(entries).catch(() => null);
  if (info?.isDirectory() && !info.isSymbolicLink()) {
    for (const name of await readdir(entries).catch(() => [] as string[])) gitDirs.push(join(entries, name));
  }
  for (const dir of gitDirs) {
    for (const file of [join(dir, "rebase-merge", "head-name"), join(dir, "rebase-apply", "head-name")]) {
      if (await readStateFile(file) === mainRef) return true;
    }
    const bisect = await readStateFile(join(dir, "BISECT_START"));
    if (bisect === mainBranch || bisect === mainRef) return true;
  }
  if (checkoutHoldsMain) {
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (await lstat(join(repo.gitCommonDir, name)).then(() => true, () => false)) return true;
    }
  }
  return false;
}

/**
 * The person's local files the Task commit would touch: uncommitted ones in
 * the checkout — modified, staged, deleted, renamed (both names), untracked —
 * that the Task commit also changes, and files the Task adds that exist in the
 * checkout already (ignored ones, which `status` does not list), or whose
 * directory is a file of the person's.
 */
async function overlappingLocalChanges(root: string, ontoCommit: string, taskCommit: string): Promise<string[]> {
  const status = await gitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  const dirty = new Set<string>();
  const fields = status.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    dirty.add(field.slice(3));
    // A rename or copy is followed by its original name.
    if (field[0] === "R" || field[0] === "C" || field[1] === "R" || field[1] === "C") {
      const original = fields[index + 1];
      if (original) dirty.add(original);
      index += 1;
    }
  }
  const changes = nulFields(await gitRaw(["diff", "--name-status", "--no-renames", "-z", ontoCommit, taskCommit], root));
  const overlap: string[] = [];
  for (let index = 0; index + 1 < changes.length; index += 2) {
    const status = changes[index]!;
    const file = changes[index + 1]!;
    if (dirty.has(file)) {
      overlap.push(file);
    } else if (status === "A") {
      // Something of the person's already where the Task adds a file, or a
      // file of theirs where it needs a directory. Content `onto_commit`
      // tracks there (a directory the Task turns into a file, a file it turns
      // into a directory) is the Task's to replace, not the person's.
      if (await lstat(join(root, file)).then(() => true, () => false)) {
        if (!(await trackedAt(root, ontoCommit, file))) overlap.push(file);
        continue;
      }
      const parts = file.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        const prefix = parts.slice(0, depth).join("/");
        const info = await lstat(join(root, prefix)).catch(() => null);
        if (!info) break;
        if (!info.isDirectory()) {
          if (!(await trackedAt(root, ontoCommit, prefix))) overlap.push(prefix);
          break;
        }
      }
    }
  }
  return overlap;
}

/** Whether `commit` tracks anything at `file` (a file, or a directory with content). Unknown counts as not. */
async function trackedAt(root: string, commit: string, file: string): Promise<boolean> {
  const listed = await runLocationGit(["ls-tree", "-z", commit, "--", `./${file}`], root);
  return listed.code === 0 && nulFields(listed.stdout).some((record) => record.endsWith(`\t${file}`));
}

/**
 * Where a merge's resolution Run works: the Task worktree as the merge left
 * it — the squashed commit checked out, the merged files with their conflict
 * markers over it. Called with the Task's lease held; throws unless this
 * merge's conflict is what is waiting there.
 */
export async function mergeResolutionWorktree(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  mergeId: string,
): Promise<{ root: string; gitCommonDir: string }> {
  if (!validTarget({ locationRoot: null, locationId, taskId, mergeId })) throw new Error("the Location, Task or merge id cannot name a Task worktree");
  const record = await readMergeRecord(locationId, taskId);
  if (!record || record.merge_id !== mergeId || record.state !== "conflict") {
    throw new Error("no conflict of that merge is waiting in this Task's worktree");
  }
  const { path, entry } = await worktreeAt(repo, locationId, taskId);
  if (!entry) throw new Error("the Task worktree is not a git worktree Rainver recognises");
  return { root: path, gitCommonDir: repo.gitCommonDir };
}
