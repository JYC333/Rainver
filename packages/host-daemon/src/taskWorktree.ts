import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { runLocationGit } from "@rainver/folder-read";
import { configDir } from "./config.js";
import { captureWorkspaceTree } from "./gitDiff.js";
import { commitOfRef, resolveMainBranch } from "./mainBranch.js";
import { isLeaseBusy, releaseLocationLeases, tryAcquireLease } from "./locationLease.js";

/**
 * One git worktree per Task, in the daemon's own directory (ADR 0016 §11,
 * hosts.md "Task worktrees").
 *
 * `<config>/task-worktrees/<location_id>/<task_id>` checks out the Task's
 * branch `rainver/task-<task_id>`, created at the main branch's tip
 * (`resolveMainBranch`) when absent. Its Runs execute there one at a time
 * (the Task's lease, `taskLeaseKey`); it outlives each Run's `complete` so
 * verification can run in it, and `task_run_settle` squashes everything since
 * the Run's start commit into one unsigned commit on the branch and removes it.
 * Nothing is written inside the person's checkout beyond what git itself
 * keeps for a worktree and a branch in the repository's git directory.
 *
 * The Location is a directory Agents write, and so are the worktree and the
 * repository's git directory (a strict Run has it bound read-write): every git
 * call goes through `runLocationGit` (nothing planted in `.git/` runs as the
 * daemon), the repository must be the Location's own top level, nothing under
 * the directories the daemon creates is followed through a symlink, a file an
 * Agent can write is read only when it is a regular file and only its first
 * 4 KiB, and neither `git worktree prune` nor `git worktree repair` is ever
 * run: both walk every entry under `.git/worktrees/`, which an Agent can
 * plant — prune deletes through a planted entry, repair writes a `.git` file
 * wherever a planted entry names — and prune would also drop the person's own
 * worktree entries. The daemon removes and relinks only this Task's own entry,
 * found by its backlink.
 *
 * Files a Run left that the repository ignores (`.gitignore`, `info/exclude`,
 * `core.excludesFile`) are never committed; they go with the worktree when it
 * is removed — at settle, branch delete and sweep — and when a different Run
 * of the Task takes it over, which recreates it. A retry or resumption of the
 * same Run finds them where it left them.
 *
 * What the branch cannot hold is moved to quarantine
 * (`<config>/task-worktrees-quarantine/<location_id>/`), never deleted on the
 * spot: the whole directory when it is not a recognisable worktree, when git
 * could not capture it, or when removing it failed — kept until its owner
 * deletes it; otherwise, for a worktree whose work is on the branch, only the
 * nested repositories in it (at their relative paths) and a submodule's git
 * directory from the worktree's entry (`<target>.git-modules`), in a
 * `-retired` target the sweep deletes after 30 days.
 *
 * What the daemon remembers lives beside, never inside, the worktree:
 * `<config>/task-records/<location_id>/<task_id>.json` names the Run the
 * worktree currently belongs to, with its start commit, until that Run is
 * settled; `<config>/task-runs/<run_id>.json` is each settled Run's answer.
 */

/** One path segment: ids come from a frame, and `join` would follow `../`. */
export const ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
/** A Task id also names a branch, so nothing a ref cannot hold (`:`, `..`, a trailing `.lock`). */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Who writes a commit no Run is the author of: leftovers of a Run that was never settled. */
export const SYSTEM_GIT_IDENTITY = Object.freeze({ name: "Rainver", email: "rainver@localhost" });
/** What a refused settle or branch delete answers while the Task is in use; the control plane retries it later. */
export const TASK_BUSY = "task_busy";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a settled Run's answer is kept for a repeated settle. */
export const RUN_RECORD_RETENTION_MS = 30 * DAY_MS;
/**
 * How long the nested repositories and submodule histories of a worktree whose
 * work is on the branch are kept in quarantine. A repository with submodules
 * leaves one set per Run, so keeping them for good fills the disk.
 */
export const RETIRED_QUARANTINE_RETENTION_MS = 30 * DAY_MS;
/** A `-retired` quarantine target (or its `.git-modules` sibling), with the time it was made. */
const RETIRED_TARGET = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}-retired(?:\.git-modules)?$/;
/** Capturing a whole worktree (`add --all`) can take minutes on a large checkout. */
const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;
/** Checking out or deleting a large worktree takes as long. */
export const WORKTREE_TIMEOUT_MS = 10 * 60 * 1000;
/** A `.git` pointer or `gitdir` backlink is one line; anything longer is not one. */
const POINTER_READ_LIMIT = 4096;
/** A lock younger than this may belong to a git still running (a person's `pack-refs`); it is left alone. */
const STALE_LOCK_MS = 10 * 60 * 1000;

export interface GitIdentity {
  name: string;
  email: string;
}

export function taskBranchName(taskId: string): string {
  return `rainver/task-${taskId}`;
}

export function taskBranchRef(taskId: string): string {
  return `refs/heads/${taskBranchName(taskId)}`;
}

/** The lease a Task worktree's Runs, settle, delete and sweep share (`locationLease.ts`). */
export function taskLeaseKey(locationId: string, taskId: string): string {
  return `task:${locationId}:${taskId}`;
}

export function validTaskWorktreeIds(locationId: string, taskId: string): boolean {
  return ID_SEGMENT.test(locationId) && TASK_ID.test(taskId);
}

/** A Location that owns its repository at its top level: the only kind a Task worktree is made of. */
export interface LocationRepository {
  /** The Location, canonical. */
  root: string;
  /** `<root>/.git`; a strict namespace binds it for git to work inside the worktree. */
  gitCommonDir: string;
}

/**
 * What a Location is, for a Task worktree:
 * - `not_git` — no real `.git` directory at its top level (not a checkout, a
 *   subdirectory of one, or a `.git` file pointing at another repository, whose
 *   git directory would otherwise be bound read-write into the Run's
 *   namespace): the Run works in place.
 * - `no_commit` — a repository with nothing committed yet: there is nothing to
 *   start a branch from, so the Run works in place too.
 * - `repository` — the Task gets its worktree.
 * - `unusable` — it is a checkout, but git refuses it or it is not what it
 *   looks like: the launch fails rather than running in the person's checkout.
 */
export type LocationRepositoryCheck =
  | { kind: "not_git" }
  | { kind: "no_commit" }
  | { kind: "repository"; repo: LocationRepository }
  | { kind: "unusable"; reason: string };

/** Decided from the filesystem first (`<root>/.git` a real directory), then by git. */
export async function checkLocationRepository(locationRoot: string): Promise<LocationRepositoryCheck> {
  const root = await realpath(locationRoot).catch(() => null);
  if (!root) return { kind: "not_git" };
  const dotGit = join(root, ".git");
  if (!(await isRealDirectory(dotGit))) return { kind: "not_git" };
  const [inside, prefix, commonDir] = await Promise.all([
    runLocationGit(["rev-parse", "--is-inside-work-tree"], root),
    runLocationGit(["rev-parse", "--show-prefix"], root),
    runLocationGit(["rev-parse", "--git-common-dir"], root),
  ]);
  for (const result of [inside, prefix, commonDir]) {
    if (result.code !== 0) return { kind: "unusable", reason: result.stderr.trim().slice(0, 400) || `git exited ${result.code}` };
  }
  if (inside.stdout.trim() !== "true" || prefix.stdout.trim() !== "") {
    return { kind: "unusable", reason: "git does not treat the Location as the top of its working tree" };
  }
  const gitCommonDir = await realpath(resolve(root, commonDir.stdout.trim())).catch(() => null);
  if (gitCommonDir !== dotGit) return { kind: "unusable", reason: "the Location's git directory is not its own .git" };
  if (!(await commitOfRef(root, "HEAD"))) {
    // An unborn branch is a fresh repository; anything else is a broken HEAD.
    const unborn = await runLocationGit(["symbolic-ref", "--quiet", "HEAD"], root);
    return unborn.code === 0 ? { kind: "no_commit" } : { kind: "unusable", reason: "HEAD names no commit" };
  }
  return { kind: "repository", repo: { root, gitCommonDir } };
}

// ---------------------------------------------------------------------------
// Busy tracking

/** Commands running in a Task worktree right now (verification), by lease key. */
const worktreeUses = new Map<string, number>();
/** Settles, deletes and sweep steps in progress; an update restart waits for them. */
let maintenanceInFlight = 0;

/** Marks a Task worktree as in use by a command until the returned function is called. */
export function useTaskWorktree(key: string): () => void {
  worktreeUses.set(key, (worktreeUses.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (worktreeUses.get(key) ?? 1) - 1;
    if (left > 0) worktreeUses.set(key, left);
    else worktreeUses.delete(key);
  };
}

/** Whether a command (verification) is running in the Task's worktree; a launch waits for it. */
export function isTaskWorktreeInUse(key: string): boolean {
  return (worktreeUses.get(key) ?? 0) > 0;
}

function isTaskBusy(key: string): boolean {
  return isLeaseBusy(key) || (worktreeUses.get(key) ?? 0) > 0;
}

export function hasTaskWorktreeMaintenance(): boolean {
  return maintenanceInFlight > 0;
}

/** Runs `work` holding the Task's lease without waiting; null when a Run (or anything else) has it. */
export async function withTaskHeld<T>(key: string, work: () => Promise<T>): Promise<T | null> {
  if (isTaskBusy(key)) return null;
  const holder = `maintenance:${randomUUID()}`;
  if (!tryAcquireLease(key, holder)) return null;
  maintenanceInFlight += 1;
  try {
    return await work();
  } finally {
    maintenanceInFlight -= 1;
    releaseLocationLeases([key], holder);
  }
}

// ---------------------------------------------------------------------------
// Paths and records

/**
 * `<config>/<top>/<location_id>`, canonical, each component a real directory;
 * created (0700) when `create`. Null when it does not exist or something other
 * than a directory is in the way.
 */
async function daemonDir(top: string, locationId: string, create: boolean): Promise<string | null> {
  const root = await realpath(configDir()).catch(() => null);
  if (!root) return null;
  let current = root;
  for (const segment of [top, locationId]) {
    current = join(current, segment);
    if (create) {
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    if (!(await isRealDirectory(current))) return null;
  }
  return current;
}

export function worktreesBase(locationId: string, create: boolean): Promise<string | null> {
  return daemonDir("task-worktrees", locationId, create);
}

interface TaskRecord {
  run_id: string;
  start_commit: string;
  /** The Location's canonical path, for the sweep on a host whose Locations are not registered (the built-in host). */
  location_root: string;
  updated_at: string;
}

interface RunRecord {
  location_id: string;
  task_id: string;
  branch: string | null;
  commit: string | null;
  /** What the settle counted from; a retry of the same Run continues from here. */
  start_commit: string;
  /** `settle`: answered a `task_run_settle`; `leftovers`: a later Run of the Task found this Run's work unsettled and committed it. */
  settled_by: "settle" | "leftovers";
  at: string;
}

function taskRecordPath(locationId: string, taskId: string): string {
  return join(configDir(), "task-records", locationId, `${taskId}.json`);
}

/** Present from just before `git worktree add` until it succeeded: a worktree found with it is an interrupted add. */
function creatingMarkerPath(locationId: string, taskId: string): string {
  // A Task id has no `.`, so this never collides with another Task's record.
  return join(configDir(), "task-records", locationId, `${taskId}.creating`);
}

/**
 * A merge of the Task in progress (`taskMerge.ts`): while it exists the merge
 * holds the worktree — no ordinary launch, settle or sweep touches it.
 */
export function mergeRecordPath(locationId: string, taskId: string): string {
  return join(configDir(), "task-records", locationId, `${taskId}.merge.json`);
}

export async function mergeHoldsWorktree(locationId: string, taskId: string): Promise<boolean> {
  return lstat(mergeRecordPath(locationId, taskId)).then(() => true, () => false);
}

function runRecordPath(runId: string): string {
  return join(configDir(), "task-runs", `${runId}.json`);
}

export async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Written whole or not at all: a crash mid-write must not leave half a record. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function readTaskRecord(locationId: string, taskId: string): Promise<TaskRecord | null> {
  const value = await readJson(taskRecordPath(locationId, taskId));
  if (!value) return null;
  const { run_id, start_commit, location_root, updated_at } = value;
  if (typeof run_id !== "string" || !ID_SEGMENT.test(run_id) || typeof start_commit !== "string" || !COMMIT_ID.test(start_commit)
    || typeof location_root !== "string" || typeof updated_at !== "string") return null;
  return { run_id, start_commit, location_root, updated_at };
}

async function readRunRecord(runId: string): Promise<RunRecord | null> {
  if (!ID_SEGMENT.test(runId)) return null;
  const value = await readJson(runRecordPath(runId));
  if (!value) return null;
  const { location_id, task_id, branch, commit, start_commit, settled_by, at } = value;
  if (typeof location_id !== "string" || typeof task_id !== "string"
    || (branch !== null && typeof branch !== "string") || (commit !== null && (typeof commit !== "string" || !COMMIT_ID.test(commit)))
    || typeof start_commit !== "string" || !COMMIT_ID.test(start_commit)
    || (settled_by !== "settle" && settled_by !== "leftovers") || typeof at !== "string") return null;
  return { location_id, task_id, branch, commit, start_commit, settled_by, at };
}

async function removeTaskRecord(locationId: string, taskId: string): Promise<void> {
  await rm(taskRecordPath(locationId, taskId), { force: true });
}

/** A Run that ran in the Task worktree has finished: the sweep counts a day from here. */
export async function touchTaskRecord(worktree: TaskWorktree, runId: string): Promise<void> {
  const record = await readTaskRecord(worktree.locationId, worktree.taskId);
  if (!record || record.run_id !== runId) return;
  await writeJson(taskRecordPath(worktree.locationId, worktree.taskId), { ...record, updated_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Files an Agent can write

/**
 * The first 4 KiB of a regular file, or null. Never follows a final symlink,
 * never blocks on a FIFO, never reads a device: this is what an Agent can
 * plant as a worktree's `.git` or an entry's `gitdir`.
 */
export async function readSmallRegularFile(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(POINTER_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, POINTER_READ_LIMIT, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A directory that is not a symlink. */
async function isRealDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

/** `<common>/worktrees`, when it is a real directory. */
async function worktreeEntriesDir(repo: LocationRepository): Promise<string | null> {
  const dir = join(repo.gitCommonDir, "worktrees");
  return await isRealDirectory(dir) && (await realpath(dir).catch(() => null)) === dir ? dir : null;
}

/** Whether a worktree entry's `gitdir` backlink names `<path>/.git` (relative backlinks resolved against the entry). */
async function entryPointsAt(entry: string, path: string): Promise<boolean> {
  const backlink = (await readSmallRegularFile(join(entry, "gitdir")))?.trim();
  return Boolean(backlink && resolve(entry, backlink) === join(path, ".git"));
}

/**
 * The repository's entry for the worktree at `path` — a real directory
 * directly under `<common>/worktrees/` — when the worktree's `.git` points at
 * it (relative pointers resolved against the worktree) and its backlink
 * points back. Read from the filesystem only.
 */
export async function ownEntry(repo: LocationRepository, path: string): Promise<string | null> {
  const entries = await worktreeEntriesDir(repo);
  if (!entries) return null;
  const pointer = (await readSmallRegularFile(join(path, ".git")))?.match(/^gitdir: (.+)$/m)?.[1]?.trim();
  if (!pointer) return null;
  const entry = resolve(path, pointer);
  if (dirname(entry) !== entries || !(await isRealDirectory(entry))) return null;
  if (!(await entryPointsAt(entry, path))) return null;
  // Git takes the repository from the entry's `commondir`; one pointing at
  // another repository would have capture write there and read its config.
  const commondirFile = join(entry, "commondir");
  const commondirInfo = await lstat(commondirFile).catch(() => null);
  if (commondirInfo) {
    const commondir = commondirInfo.isFile() ? (await readSmallRegularFile(commondirFile))?.trim() : null;
    if (!commondir || resolve(entry, commondir) !== repo.gitCommonDir) return null;
  }
  return entry;
}

/**
 * Removes the repository's entries whose backlink names `<path>/.git` — what
 * `git worktree prune` would do for this one path, without touching any other
 * entry or following anything planted in their place. Each is a real
 * directory, checked again right before it goes.
 */
async function removeOwnEntries(repo: LocationRepository, path: string, place: TaskPlace, target?: string): Promise<void> {
  for (const entry of await entriesPointingAt(repo, path)) {
    if ((await realpath(entry).catch(() => null)) !== entry) continue;
    await preserveModules(entry, place, target);
    await rm(entry, { recursive: true, force: true });
  }
}

/** Which Task a take-down is for: where its quarantine goes. */
interface TaskPlace {
  locationId: string;
  taskId: string;
}

/**
 * A new place in quarantine for one take-down:
 * `<config>/task-worktrees-quarantine/<location_id>/<task_id>-<time>-<rand>`
 * for a worktree kept `whole` (never deleted), suffixed `-retired` for the
 * parts kept of a worktree whose work is on the branch (the sweep deletes
 * those after `RETIRED_QUARANTINE_RETENTION_MS`). Only its parent is
 * created; whatever is moved there creates the rest.
 */
async function newQuarantineTarget(place: TaskPlace, kept: "whole" | "retired"): Promise<string> {
  const dir = await daemonDir("task-worktrees-quarantine", place.locationId, true);
  if (!dir) throw new Error("the daemon's quarantine directory is not a directory");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${place.taskId}-${stamp}-${randomUUID().slice(0, 8)}${kept === "retired" ? "-retired" : ""}`);
}

/** Moves a directory, copying across filesystems (symlinks copied as links, never followed). */
async function moveDirectory(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * A submodule initialised inside the worktree keeps its git directory under
 * the worktree's entry (`<entry>/modules`), not in the worktree: before the
 * entry goes, that directory is moved to `<target>.git-modules` so the
 * submodule's history survives beside whatever was kept of the worktree.
 * Throws if it cannot be moved, which leaves the entry in place.
 */
async function preserveModules(entry: string, place: TaskPlace, target?: string): Promise<boolean> {
  const modules = join(entry, "modules");
  if (!(await isRealDirectory(modules))) return false;
  await moveDirectory(modules, `${target ?? await newQuarantineTarget(place, "whole")}.git-modules`);
  return true;
}

/** The real directories under `<common>/worktrees` whose backlink names `<path>/.git`. */
async function entriesPointingAt(repo: LocationRepository, path: string): Promise<string[]> {
  const entries = await worktreeEntriesDir(repo);
  if (!entries) return [];
  const found: string[] = [];
  for (const name of await readdir(entries).catch(() => [] as string[])) {
    const entry = join(entries, name);
    if (await isRealDirectory(entry) && await entryPointsAt(entry, path)) found.push(entry);
  }
  return found;
}

/**
 * Points the worktree's `.git` back at its entry — what `git worktree repair`
 * would do for this one worktree — when exactly one entry claims it. Only a
 * regular file (or no file) is written, never through a link, never a FIFO.
 */
async function relinkWorktree(repo: LocationRepository, path: string): Promise<boolean> {
  const claims = await entriesPointingAt(repo, path);
  if (claims.length !== 1) return false;
  const dotGit = join(path, ".git");
  const existing = await lstat(dotGit).catch(() => null);
  if (existing && !existing.isFile()) return false;
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (existing ? constants.O_TRUNC : constants.O_CREAT | constants.O_EXCL);
  const handle = await open(dotGit, flags, 0o644).catch(() => null);
  if (!handle) return false;
  try {
    if (!(await handle.stat()).isFile()) return false;
    await handle.writeFile(`gitdir: ${claims[0]}\n`, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The directories in the worktree that hold a nested repository (a `.git`
 * below the worktree's own), relative to it. Their history is not in the
 * Location's repository — a commit records only a nested repository's commit
 * id — so each is moved aside rather than deleted. Symlinks are not followed;
 * a directory that cannot be read is listed too (it could hold one, and it
 * could not be deleted anyway). Nothing below a listed directory is visited.
 */
async function nestedRepositoryDirs(path: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [path];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries || (dir !== path && entries.some((entry) => entry.name === ".git"))) {
      if (dir === path) throw new Error("the Task worktree cannot be read");
      found.push(relative(path, dir));
      continue;
    }
    for (const entry of entries) {
      if (entry.name !== ".git" && entry.isDirectory()) pending.push(join(dir, entry.name));
    }
  }
  return found;
}

/**
 * Clears a lock a killed git left behind — only the exact file, only a
 * regular file older than ten minutes (or dated in the future), only under real directories — with the
 * Task's lease held and none of its Runs live.
 */
async function clearStaleLock(dirs: readonly string[], lockName: string): Promise<void> {
  for (const dir of dirs) if (!(await isRealDirectory(dir))) return;
  const lock = join(dirs[dirs.length - 1]!, lockName);
  const info = await lstat(lock).catch(() => null);
  const age = info ? Date.now() - info.mtimeMs : 0;
  // A lock dated in the future is no running git's either.
  if (info?.isFile() && (age > STALE_LOCK_MS || age < -60_000)) await unlink(lock).catch(() => undefined);
}

/** The Task branch's loose-ref lock, `refs/heads/rainver/task-<id>.lock`. */
export function clearStaleRefLock(repo: LocationRepository, taskId: string): Promise<void> {
  const refs = join(repo.gitCommonDir, "refs");
  const heads = join(refs, "heads");
  return clearStaleLock([refs, heads, join(heads, "rainver")], `task-${taskId}.lock`);
}

// ---------------------------------------------------------------------------
// Git plumbing

export async function gitOrThrow(args: readonly string[], cwd: string, timeoutMs = 30_000, env?: Record<string, string>): Promise<string> {
  const result = await runLocationGit(args, cwd, timeoutMs, env ? { env } : {});
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 400) || `exit ${result.code}`}`);
  return result.stdout.trim();
}

export async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runLocationGit(["merge-base", "--is-ancestor", ancestor, descendant], repoRoot);
  return result.code === 0;
}

export interface ListedWorktree {
  path: string;
  /** `refs/heads/…`, or null when detached. */
  branch: string | null;
}

/**
 * `git worktree list --porcelain -z`: NUL-separated, so a path an Agent
 * planted in an entry's `gitdir` cannot inject lines. Git before 2.36 has no
 * `-z`; there the newline form is read, which such a path can still confuse.
 */
export async function listWorktrees(repoRoot: string): Promise<ListedWorktree[]> {
  const nul = await runLocationGit(["worktree", "list", "--porcelain", "-z"], repoRoot);
  const fields = nul.code === 0
    ? nul.stdout.split("\0")
    : (await gitOrThrow(["worktree", "list", "--porcelain"], repoRoot)).split("\n");
  const listed: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of fields) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      listed.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return listed;
}

/**
 * Refuses to move a branch someone else has checked out — the person's own
 * checkout above all: moving it would change what their HEAD is under them.
 */
async function assertBranchFree(repo: LocationRepository, ref: string, ownPath: string): Promise<void> {
  const elsewhere = (await listWorktrees(repo.root)).some((entry) => entry.branch === ref && entry.path !== ownPath);
  if (elsewhere) throw new Error(`${ref.slice("refs/heads/".length)} is checked out in the Location's checkout or another worktree; Rainver does not move it there.`);
}

/**
 * Writes one commit — unsigned, whatever the repository configures, author and
 * committer both `identity`, message verbatim — and never runs a hook
 * (`runLocationGit` disables them; `commit-tree` has none anyway).
 */
export async function writeCommit(repoRoot: string, tree: string, parent: string, identity: GitIdentity, message: string): Promise<string> {
  return gitOrThrow(["commit-tree", "--no-gpg-sign", tree, "-p", parent, "-m", message], repoRoot, 30_000, {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  });
}

/** Compare-and-swap: moves the branch only if it still stands where it was read. */
export async function moveBranch(repoRoot: string, ref: string, next: string, expected: string, reason: string): Promise<void> {
  const result = await runLocationGit(["update-ref", "-m", reason, ref, next, expected], repoRoot);
  if (result.code !== 0) throw new Error(`the Task branch moved while Rainver was updating it: ${result.stderr.trim().slice(0, 400)}`);
}

/**
 * What is at the Task worktree's path:
 * - `absent` — nothing.
 * - `junk` — something that is not a directory (a symlink, a file, a FIFO):
 *   no Run's work is in it, and it is removed without being followed.
 * - `worktree` — a real directory that is this repository's worktree: its
 *   `.git` and the entry's backlink agree, and git lists it there.
 * - `unrecognised` — a real directory that is not, or no longer, one (the
 *   repository moved, an Agent rewrote `.git`, git forgot it). Its contents
 *   cannot be captured through git and are never deleted: a launch moves it
 *   aside, a settle refuses, the sweep leaves it.
 *
 * With `relink`, a directory exactly one entry still claims by its backlink,
 * but whose own `.git` no longer points there (rewritten, or relative from a
 * moved repository), has its `.git` pointed back first (`relinkWorktree`).
 */
export type WorktreeState =
  | { kind: "absent" }
  | { kind: "junk" }
  | { kind: "worktree"; entry: string; onBranch: boolean }
  | { kind: "unrecognised" };

export async function worktreeState(repo: LocationRepository, path: string, ref: string, relink: boolean): Promise<WorktreeState> {
  const info = await lstat(path).catch(() => null);
  if (!info) return { kind: "absent" };
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path).catch(() => null)) !== path) return { kind: "junk" };
  const recognise = async (): Promise<WorktreeState | null> => {
    const entry = await ownEntry(repo, path);
    const listed = (await listWorktrees(repo.root)).find((worktree) => worktree.path === path);
    return entry && listed ? { kind: "worktree", entry, onBranch: listed.branch === ref } : null;
  };
  const first = await recognise();
  if (first) return first;
  if (relink && await relinkWorktree(repo, path)) {
    const relinked = await recognise();
    if (relinked) return relinked;
  }
  return { kind: "unrecognised" };
}

/**
 * Removes a recognised worktree whose work has been captured (or is being
 * discarded with its Task) and its entry: `git worktree remove` (`--force`
 * twice: it is locked, and a Run leaves it dirty). If git refuses, the
 * directory itself — only a real directory that resolves to itself — and
 * then this worktree's own entry.
 */
async function removeWorktree(repo: LocationRepository, path: string, place: TaskPlace, target?: string): Promise<void> {
  // Git deletes the entry, and a submodule's history in it, with the worktree.
  for (const entry of await entriesPointingAt(repo, path)) await preserveModules(entry, place, target);
  const removed = await runLocationGit(["worktree", "remove", "--force", "--force", path], repo.root, WORKTREE_TIMEOUT_MS);
  if (removed.code === 0) return;
  if (await isRealDirectory(path) && (await realpath(path).catch(() => null)) === path) {
    await rm(path, { recursive: true, force: true });
  }
  await removeOwnEntries(repo, path, place, target);
}

/** A symlink, file or FIFO at the worktree's path: unlinked, never followed. */
export async function removeJunk(repo: LocationRepository, place: TaskPlace, path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
  await removeOwnEntries(repo, path, place);
}

/**
 * Moves an unrecognised directory out of the way, whole, to
 * `<config>/task-worktrees-quarantine/<location_id>/<task_id>-<time>`, for its
 * owner to look at; nothing in it is deleted. Returns where it went.
 */
export async function quarantine(repo: LocationRepository, locationId: string, taskId: string, path: string): Promise<string> {
  const place = { locationId, taskId };
  const target = await newQuarantineTarget(place, "whole");
  await rename(path, target);
  await removeOwnEntries(repo, path, place, target);
  return target;
}

/**
 * Takes a recognised worktree down once its work is on the branch (or its Task
 * is gone): removed, keeping aside in a `-retired` target only its nested
 * repositories and submodule histories, which the branch does not have — or
 * moved aside whole when removing it failed (a read-only directory a build
 * left). Returns which.
 */
export async function retireWorktree(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  path: string,
): Promise<"removed" | "quarantined"> {
  const place = { locationId, taskId };
  const target = await newQuarantineTarget(place, "retired");
  const exists = (candidate: string) => lstat(candidate).then(() => true, () => false);
  try {
    // Only the nested repositories are kept, at their relative paths under
    // one target; the rest of the worktree is on the branch and is removed.
    for (const dir of await nestedRepositoryDirs(path)) await moveDirectory(join(path, dir), join(target, dir));
    await removeWorktree(repo, path, place, target);
  } catch {
    // Whatever git, `rm` or a move left: moved aside whole rather than left
    // half-deleted in the way.
    if (await exists(path)) {
      await quarantine(repo, locationId, taskId, path);
      return "quarantined";
    }
    await removeOwnEntries(repo, path, place, target);
  }
  return await exists(target) || await exists(`${target}.git-modules`) ? "quarantined" : "removed";
}

/**
 * A `git worktree add` that never finished (killed at its timeout, a daemon
 * crash) leaves a checkout that looks whole but is not: committing it would
 * record every file it never wrote as deleted. It holds no Run's work — a Run
 * starts only after the add succeeded and the marker went — so it is removed,
 * not captured. Called with the Task's lease held.
 */
async function discardInterruptedAdd(repo: LocationRepository, locationId: string, taskId: string, path: string): Promise<void> {
  const marker = creatingMarkerPath(locationId, taskId);
  if (!(await lstat(marker).catch(() => null))) return;
  const info = await lstat(path).catch(() => null);
  if (info?.isDirectory() && !info.isSymbolicLink() && (await realpath(path).catch(() => null)) === path) {
    await rm(path, { recursive: true, force: true });
  } else if (info) {
    await unlink(path).catch(() => undefined);
  }
  await removeOwnEntries(repo, path, { locationId, taskId });
  await rm(marker, { force: true });
}

/**
 * Leftovers of a Run that was never settled, found in a worktree the next
 * Run (or the sweep) is about to take over: the whole working tree —
 * untracked-but-not-ignored files included, the worktree's own index
 * untouched — committed on top of the branch as one system commit, so no
 * tracked or untracked work is lost when the worktree goes (ignored files
 * are not kept). The Agent's own commits stay as they are; nothing but a
 * commit is added, and nothing when the tree is the branch tip's. Returns the
 * branch tip afterwards, or null when git could not capture the worktree (a
 * nested repository with no commit makes `add --all` fatal) — the caller then
 * moves it aside instead.
 */
async function commitLeftovers(
  repo: LocationRepository,
  path: string,
  ref: string,
  tip: string,
  earlierRunId: string | null,
): Promise<string | null> {
  const tree = await captureWorkspaceTree(path, CAPTURE_TIMEOUT_MS);
  if (!tree) return null;
  const tipTree = await gitOrThrow(["rev-parse", `${tip}^{tree}`], repo.root);
  if (tree === tipTree) return tip;
  await assertBranchFree(repo, ref, path);
  const message = earlierRunId
    ? `Rainver: unsettled work of run ${earlierRunId}\n\nRun ${earlierRunId} left these changes in its Task worktree without being settled.\n`
    : "Rainver: unsettled work of an earlier Run\n\nAn earlier Run left these changes in the Task worktree without being settled.\n";
  const commit = await writeCommit(repo.root, tree, tip, SYSTEM_GIT_IDENTITY, message);
  await moveBranch(repo.root, ref, commit, tip, "rainver: commit an unsettled Run's work");
  return commit;
}

// ---------------------------------------------------------------------------
// Launch

export interface TaskWorktree {
  /** The worktree's root, which is also where the Run executes. */
  root: string;
  gitCommonDir: string;
  locationRoot: string;
  locationId: string;
  taskId: string;
  /** `rainver/task-<task_id>`. */
  branch: string;
  /** Where the Run first started; what its diff and settle count from. */
  startCommit: string;
}

/**
 * Makes the Task's worktree ready for one launch attempt and records its start
 * commit. Called with the Task's lease held (`taskLeaseKey`). Throws when the
 * worktree cannot be made; the launch then fails rather than running a Task
 * in the person's checkout.
 *
 * - Creates `rainver/task-<task_id>` at the main branch's tip when absent.
 * - Junk at the path is removed; an unrecognised directory is moved aside
 *   (`quarantine`).
 * - The same Run launched again with its worktree still there (a retry, or a
 *   parked Run resuming) finds its work as it left it and keeps its original
 *   start commit.
 * - The same Run launched again after it was settled (a supervisor retry of a
 *   failed Run) continues from its settled commit while nothing else has
 *   landed on the branch since: it reports and keeps its original start
 *   commit, so its next settle replaces the earlier attempt's commit with one
 *   for the whole Run. If something else landed, it starts from the tip.
 * - Anything else left in the worktree — another Run's unsettled work, work
 *   nobody recorded, a worktree an Agent switched off the branch — is
 *   committed onto the branch first (`commitLeftovers`) and the worktree is
 *   recreated, so the Run starts clean; the earlier Run's settle then answers
 *   with where its work went.
 */
export async function prepareTaskWorktree(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  runId: string,
): Promise<TaskWorktree> {
  if (!validTaskWorktreeIds(locationId, taskId) || !ID_SEGMENT.test(runId)) {
    throw new Error("the Location, Task or Run id cannot name a Task worktree");
  }
  // The control plane runs nothing but a merge's own resolution Run while a
  // merge is preparing or waits on a conflict; this is the daemon's own guard.
  // A merge left `rebased` (its verification failed, or it was abandoned)
  // no longer holds the worktree: the branch stays its rebased commit.
  const merge = await readJson(mergeRecordPath(locationId, taskId));
  if (merge) {
    if (merge.state !== "rebased") throw new Error("a merge of this Task holds its worktree");
    await rm(mergeRecordPath(locationId, taskId), { force: true });
  }
  const branch = taskBranchName(taskId);
  const ref = taskBranchRef(taskId);
  const base = await worktreesBase(locationId, true);
  if (!base) throw new Error("the daemon's task-worktrees directory is not a directory");
  const path = join(base, taskId);
  await discardInterruptedAdd(repo, locationId, taskId, path);
  await clearStaleRefLock(repo, taskId);

  let tip = await commitOfRef(repo.root, ref);
  if (!tip) {
    const main = await resolveMainBranch(repo.root);
    if (!main) throw new Error("the repository has no commit to start the Task branch from");
    // Empty expected value: created only if it still does not exist.
    await gitOrThrow(["update-ref", "-m", "rainver: start the Task branch", ref, main.commit, ""], repo.root);
    tip = main.commit;
  }

  const record = await readTaskRecord(locationId, taskId);
  const sameRun = Boolean(record && record.run_id === runId && await isAncestor(repo.root, record.start_commit, tip));
  let state = await worktreeState(repo, path, ref, true);
  if (state.kind === "junk") {
    await removeJunk(repo, { locationId, taskId }, path);
    state = { kind: "absent" };
  } else if (state.kind === "unrecognised") {
    await quarantine(repo, locationId, taskId, path);
    state = { kind: "absent" };
  }
  if (state.kind === "worktree") {
    await clearStaleLock([state.entry], "index.lock");
    if (!(sameRun && state.onBranch)) {
      const earlier = record && record.run_id !== runId ? record.run_id : null;
      const committed = await commitLeftovers(repo, path, ref, tip, sameRun ? runId : earlier);
      // Not capturable: kept whole, aside, and the Run starts fresh at the tip.
      if (committed === null) await quarantine(repo, locationId, taskId, path);
      else {
        tip = committed;
        await retireWorktree(repo, locationId, taskId, path);
      }
      state = { kind: "absent" };
    }
  }
  if (record && record.run_id !== runId) await answerForUnsettledRun(repo, locationId, taskId, record, tip);

  let startCommit: string | null = sameRun && record ? record.start_commit : null;
  let continuesSettled = false;
  if (!startCommit) {
    const settled = await readRunRecord(runId);
    if (settled && settled.location_id === locationId && settled.task_id === taskId
      && tip === (settled.commit ?? settled.start_commit) && await isAncestor(repo.root, settled.start_commit, tip)) {
      startCommit = settled.start_commit;
      continuesSettled = true;
    }
  }

  if (state.kind === "absent") await addTaskWorktree(repo, locationId, taskId, path);
  const head = await gitOrThrow(["rev-parse", "--verify", "HEAD^{commit}"], path);
  startCommit ??= head;
  await writeJson(taskRecordPath(locationId, taskId), {
    run_id: runId,
    start_commit: startCommit,
    location_root: repo.root,
    updated_at: new Date().toISOString(),
  } satisfies TaskRecord);
  // The Task record names this Run again, which is what makes its next settle
  // settle anew; the stale answer goes too.
  if (continuesSettled) await rm(runRecordPath(runId), { force: true });
  return { root: path, gitCommonDir: repo.gitCommonDir, locationRoot: repo.root, locationId, taskId, branch, startCommit };
}

/**
 * `git worktree add --lock <path> rainver/task-<id>`, with the marker that
 * tells a later look an interrupted add from a real worktree.
 */
export async function addTaskWorktree(repo: LocationRepository, locationId: string, taskId: string, path: string): Promise<void> {
  // An entry git kept for a directory that is gone (locked, so never
  // pruned) would stop `worktree add`.
  await removeOwnEntries(repo, path, { locationId, taskId });
  await assertBranchFree(repo, taskBranchRef(taskId), path);
  const marker = creatingMarkerPath(locationId, taskId);
  await writeJson(marker, { at: new Date().toISOString() });
  await gitOrThrow(["worktree", "add", "--lock", path, taskBranchName(taskId)], repo.root, WORKTREE_TIMEOUT_MS);
  if ((await realpath(path).catch(() => null)) !== path || !(await ownEntry(repo, path))) {
    throw new Error("the Task worktree did not end up where it was made");
  }
  await rm(marker, { force: true });
}

/**
 * A Run the Task record names, found unsettled by something taking the
 * worktree over: its work is on the branch now, and its settle, when it
 * comes, answers with where.
 */
async function answerForUnsettledRun(repo: LocationRepository, locationId: string, taskId: string, record: TaskRecord, tip: string): Promise<void> {
  if (await readRunRecord(record.run_id)) return;
  const holdsWork = tip !== record.start_commit && await isAncestor(repo.root, record.start_commit, tip);
  await writeJson(runRecordPath(record.run_id), {
    location_id: locationId,
    task_id: taskId,
    branch: holdsWork ? taskBranchName(taskId) : null,
    commit: holdsWork ? tip : null,
    start_commit: record.start_commit,
    settled_by: "leftovers",
    at: new Date().toISOString(),
  } satisfies RunRecord);
}

/**
 * The Task's worktree on its branch, clean, for a merge to start in
 * (`taskMerge.ts`). Called with the Task's lease held. Whatever is left there
 * — a Run nobody settled, work nobody recorded — is committed onto the branch
 * first, exactly as a launch does, unless `discard`: after an earlier merge
 * step what is left is that merge's own (conflicted files, what verification
 * built), never the Task's work, and it is thrown away (`reset --hard`,
 * `clean -fdx`). A worktree that is not on the branch is recreated. Null when
 * the Task branch does not exist.
 */
export async function readyWorktreeForMerge(
  repo: LocationRepository,
  locationId: string,
  taskId: string,
  discard: boolean,
): Promise<{ path: string; entry: string; tip: string } | null> {
  const ref = taskBranchRef(taskId);
  const base = await worktreesBase(locationId, true);
  if (!base) throw new Error("the daemon's task-worktrees directory is not a directory");
  const path = join(base, taskId);
  await discardInterruptedAdd(repo, locationId, taskId, path);
  await clearStaleRefLock(repo, taskId);
  let tip = await commitOfRef(repo.root, ref);
  if (!tip) return null;
  const record = await readTaskRecord(locationId, taskId);
  let state = await worktreeState(repo, path, ref, true);
  if (state.kind === "junk") {
    await removeJunk(repo, { locationId, taskId }, path);
    state = { kind: "absent" };
  } else if (state.kind === "unrecognised") {
    await quarantine(repo, locationId, taskId, path);
    state = { kind: "absent" };
  }
  if (state.kind === "worktree" && discard) {
    await clearStaleLock([state.entry], "index.lock");
    if (state.onBranch) {
      await gitOrThrow(["reset", "-q", "--hard", "HEAD"], path, WORKTREE_TIMEOUT_MS);
      await gitOrThrow(["clean", "-q", "-f", "-d", "-x"], path, WORKTREE_TIMEOUT_MS);
    } else {
      await retireWorktree(repo, locationId, taskId, path);
      state = { kind: "absent" };
    }
  } else if (state.kind === "worktree") {
    await clearStaleLock([state.entry], "index.lock");
    const committed = await commitLeftovers(repo, path, ref, tip, record?.run_id ?? null);
    if (committed === null) {
      await quarantine(repo, locationId, taskId, path);
      state = { kind: "absent" };
    } else if (committed !== tip || !state.onBranch) {
      tip = committed;
      await retireWorktree(repo, locationId, taskId, path);
      state = { kind: "absent" };
    } else {
      // Kept (an aborted merge left it): its index and files match the tip again.
      await gitOrThrow(["reset", "-q", "--hard", "HEAD"], path, WORKTREE_TIMEOUT_MS);
    }
  }
  if (record) {
    await answerForUnsettledRun(repo, locationId, taskId, record, tip);
    await removeTaskRecord(locationId, taskId);
  }
  if (state.kind === "absent") await addTaskWorktree(repo, locationId, taskId, path);
  const entry = await ownEntry(repo, path);
  if (!entry) throw new Error("the Task worktree is not a git worktree Rainver recognises");
  return { path, entry, tip };
}

/**
 * The Task's worktree, when one exists for this Location — where a
 * verification command about the Task's Run is asked. Null when there is none
 * (the Run ran in place, and the Location is the same question). Throws when
 * a directory is there that is not a recognisable worktree, rather than
 * answering about the checkout. Read-only: it changes nothing, since it runs
 * without the Task's lease.
 */
export async function existingTaskWorktree(
  locationRoot: string,
  locationId: string,
  taskId: string,
): Promise<{ root: string; gitCommonDir: string } | null> {
  if (!validTaskWorktreeIds(locationId, taskId)) return null;
  const check = await checkLocationRepository(locationRoot);
  if (check.kind === "unusable") throw new Error(`the Location's repository cannot be used: ${check.reason}`);
  if (check.kind !== "repository") return null;
  const base = await worktreesBase(locationId, false);
  if (!base) return null;
  const path = join(base, taskId);
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (await lstat(creatingMarkerPath(locationId, taskId)).catch(() => null)) {
    throw new Error("the Task worktree was never finished being made");
  }
  if (!(await isRealDirectory(path)) || (await realpath(path).catch(() => null)) !== path || !(await ownEntry(check.repo, path))) {
    throw new Error("the Task worktree is there but is not a git worktree Rainver recognises");
  }
  return { root: path, gitCommonDir: check.repo.gitCommonDir };
}

// ---------------------------------------------------------------------------
// Settle and delete

export interface TaskRunSettleResult {
  ok: boolean;
  branch: string | null;
  commit: string | null;
  error: string | null;
}

/**
 * `task_run_settle`: everything the Run did since its start commit — its own
 * commits, uncommitted edits and untracked files; not ignored files — as one
 * commit on the Task branch whose parent is the start commit, written with
 * `author` as author and committer and `message` verbatim; then the worktree
 * is removed.
 *
 * The working tree is captured through a private index (`captureWorkspaceTree`),
 * so the worktree's own index is never read or written. Nothing is committed
 * when that tree is the start commit's (`commit: null`). The branch is moved by
 * compare-and-swap from the tip read just before, which drops the Agent's
 * intermediate commits — and an earlier attempt's settled commit — from it.
 *
 * A stored answer is replayed only while the Task record does not name the
 * Run again; a later attempt of the same Run renames it, and its settle then
 * settles anew. A Run that never ran in this Task's worktree answers `ok` with
 * neither branch nor commit. `task_busy` while a launch, a command, or other
 * maintenance holds the Task.
 */
export async function settleTaskRun(input: {
  locationRoot: string | null;
  locationId: string;
  taskId: string;
  runId: string;
  author: GitIdentity;
  message: string;
  log?: (line: string) => void;
}): Promise<TaskRunSettleResult> {
  const { locationId, taskId, runId } = input;
  const log = input.log ?? (() => {});
  if (!validTaskWorktreeIds(locationId, taskId) || !ID_SEGMENT.test(runId)) {
    return { ok: false, branch: null, commit: null, error: "The Location, Task or Run id cannot name a Task worktree." };
  }
  const replay = async (): Promise<TaskRunSettleResult | null> => {
    const record = await readTaskRecord(locationId, taskId);
    if (record?.run_id === runId) return null;
    const prior = await readRunRecord(runId);
    return prior ? answerFromRunRecord(prior, locationId, taskId) : null;
  };
  // A repeat is answered even while the Task's next Run is running: it
  // changes nothing.
  const early = await replay();
  if (early) return early;
  const outcome = await withTaskHeld(taskLeaseKey(locationId, taskId), async (): Promise<TaskRunSettleResult> => {
    // Again with the lease held: a settle of the same Run may have finished meanwhile.
    const replayed = await replay();
    if (replayed) return replayed;
    if (await mergeHoldsWorktree(locationId, taskId)) return { ok: false, branch: null, commit: null, error: TASK_BUSY };
    const record = await readTaskRecord(locationId, taskId);
    if (!record || record.run_id !== runId) return { ok: true, branch: null, commit: null, error: null };
    if (!input.locationRoot) {
      return { ok: false, branch: null, commit: null, error: "This daemon has no local path registered for that workspace." };
    }
    const check = await checkLocationRepository(input.locationRoot);
    if (check.kind !== "repository") {
      return { ok: false, branch: null, commit: null, error: `The Location's repository cannot be used: ${check.kind === "unusable" ? check.reason : check.kind}` };
    }
    const repo = check.repo;
    const branch = taskBranchName(taskId);
    const ref = taskBranchRef(taskId);
    const base = await worktreesBase(locationId, false);
    const path = base ? join(base, taskId) : null;
    if (path) await discardInterruptedAdd(repo, locationId, taskId, path);
    await clearStaleRefLock(repo, taskId);
    const tip = await commitOfRef(repo.root, ref);
    if (!tip) return { ok: false, branch: null, commit: null, error: `The Task branch ${branch} no longer exists.` };
    const start = record.start_commit;
    if (!(await isAncestor(repo.root, start, tip))) {
      return { ok: false, branch: null, commit: null, error: `The Task branch ${branch} no longer contains the Run's start commit.` };
    }
    let state: WorktreeState = path ? await worktreeState(repo, path, ref, true) : { kind: "absent" };
    if (state.kind === "unrecognised") {
      return { ok: false, branch: null, commit: null, error: "The Task worktree is there but is no longer a git worktree Rainver recognises; its contents were left in place." };
    }
    if (state.kind === "junk") {
      await removeJunk(repo, { locationId, taskId }, path!);
      state = { kind: "absent" };
    }
    let tree: string | null;
    if (state.kind === "worktree") {
      await clearStaleLock([state.entry], "index.lock");
      tree = await captureWorkspaceTree(path!, CAPTURE_TIMEOUT_MS);
      if (!tree) {
        // Kept whole, aside, so the Task is not stuck on it: the next Run
        // starts fresh at the tip, and the work that could not be captured
        // stays in quarantine for the person.
        const moved = await quarantine(repo, locationId, taskId, path!);
        log(`task ${taskId}: git could not capture the worktree of run ${runId}; moved it to ${moved}`);
        return {
          ok: false,
          branch: null,
          commit: null,
          error: "Git could not capture the Task worktree (a nested repository with no commit, for example); its uncommitted work is not on the branch. The worktree was moved aside on the host with its contents intact.",
        };
      }
    } else {
      // No worktree (the sweep took it): the Run's work is what the branch holds.
      tree = await gitOrThrow(["rev-parse", `${tip}^{tree}`], repo.root);
    }
    const startTree = await gitOrThrow(["rev-parse", `${start}^{tree}`], repo.root);
    const next = tree === startTree ? start : await writeCommit(repo.root, tree, start, input.author, input.message);
    if (next !== tip) {
      await assertBranchFree(repo, ref, path ?? "");
      await moveBranch(repo.root, ref, next, tip, `rainver: settle run ${runId}`);
    }
    const commit = next === start ? null : next;
    // Recorded before the worktree goes: a repeated settle must not commit again.
    await writeJson(runRecordPath(runId), {
      location_id: locationId, task_id: taskId, branch, commit, start_commit: start, settled_by: "settle", at: new Date().toISOString(),
    } satisfies RunRecord);
    await removeTaskRecord(locationId, taskId);
    // The Run is settled whatever happens to the directory now.
    if (path && state.kind === "worktree") {
      await retireWorktree(repo, locationId, taskId, path)
        .then((outcome) => {
          if (outcome === "quarantined") log(`task ${taskId}: its worktree held what the branch cannot (or would not be removed); moved aside`);
        })
        .catch((error: unknown) => log(`task ${taskId}: its settled worktree could not be removed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return { ok: true, branch, commit, error: null };
  }).catch((error: unknown): TaskRunSettleResult => ({
    ok: false, branch: null, commit: null, error: error instanceof Error ? error.message : String(error),
  }));
  return outcome ?? { ok: false, branch: null, commit: null, error: TASK_BUSY };
}

function answerFromRunRecord(record: RunRecord, locationId: string, taskId: string): TaskRunSettleResult {
  if (record.location_id !== locationId || record.task_id !== taskId) {
    return { ok: false, branch: null, commit: null, error: "That Run was settled for another Task." };
  }
  return { ok: true, branch: record.branch, commit: record.commit, error: null };
}

export interface TaskBranchDeleteResult {
  ok: boolean;
  deleted: boolean;
  error: string | null;
}

/**
 * `task_branch_delete`: the Task is gone. Removes its worktree, if one is left
 * (an unrecognised directory is moved aside, not deleted), and deletes exactly
 * `refs/heads/rainver/task-<task_id>`. `deleted` says whether either existed;
 * a repeat answers `deleted: false`. `task_busy` while the Task is in use.
 * A merge that holds the worktree between its steps (waiting on a conflict
 * resolution or on the person's local changes) is dropped with it: the Task
 * it would merge is gone, and removing the worktree ends its rebase.
 */
export async function deleteTaskBranch(input: { locationRoot: string | null; locationId: string; taskId: string }): Promise<TaskBranchDeleteResult> {
  const { locationId, taskId } = input;
  if (!validTaskWorktreeIds(locationId, taskId)) {
    return { ok: false, deleted: false, error: "The Location or Task id cannot name a Task worktree." };
  }
  const outcome = await withTaskHeld(taskLeaseKey(locationId, taskId), async (): Promise<TaskBranchDeleteResult> => {
    if (!input.locationRoot) return { ok: false, deleted: false, error: "This daemon has no local path registered for that workspace." };
    const check = await checkLocationRepository(input.locationRoot);
    if (check.kind === "unusable") return { ok: false, deleted: false, error: `The Location's repository cannot be used: ${check.reason}` };
    if (check.kind !== "repository") {
      await removeTaskRecord(locationId, taskId);
      await rm(mergeRecordPath(locationId, taskId), { force: true });
      return { ok: true, deleted: false, error: null };
    }
    const repo = check.repo;
    const ref = taskBranchRef(taskId);
    await clearStaleRefLock(repo, taskId);
    const base = await worktreesBase(locationId, false);
    const path = base ? join(base, taskId) : "";
    if (base) await discardInterruptedAdd(repo, locationId, taskId, path);
    const tip = await commitOfRef(repo.root, ref);
    if (tip) await assertBranchFree(repo, ref, path);
    let deleted = false;
    if (base) {
      const state = await worktreeState(repo, path, ref, false);
      if (state.kind === "worktree") await retireWorktree(repo, locationId, taskId, path);
      else if (state.kind === "junk") await removeJunk(repo, { locationId, taskId }, path);
      else if (state.kind === "unrecognised") await quarantine(repo, locationId, taskId, path);
      deleted = state.kind !== "absent";
    }
    if (tip) {
      await gitOrThrow(["update-ref", "-m", "rainver: the Task is gone", "-d", ref, tip], repo.root);
      deleted = true;
    }
    await removeTaskRecord(locationId, taskId);
    // A merge of a Task that is gone is over: its rebase went with the worktree.
    await rm(mergeRecordPath(locationId, taskId), { force: true });
    return { ok: true, deleted, error: null };
  }).catch((error: unknown): TaskBranchDeleteResult => ({
    ok: false, deleted: false, error: error instanceof Error ? error.message : String(error),
  }));
  return outcome ?? { ok: false, deleted: false, error: TASK_BUSY };
}

// ---------------------------------------------------------------------------
// Sweep

/**
 * Task worktrees nobody settled — a control plane that went away, a Task
 * abandoned without being cancelled — are taken down a day after their last
 * Run: whatever is left in one is committed onto the branch
 * (`commitLeftovers`), then the worktree and its entry are removed. The branch
 * stays (it is the Task's), and so does the Task's record, so a later settle
 * or resume of that Run still counts from its start commit. Skipped: a
 * worktree a Run holds or awaits, a command is running in, or a merge holds; one whose
 * Location this daemon cannot find (a paired host's Location that is no
 * longer registered, or a built-in-host Location no longer under the
 * workspace root); and a directory that is not a recognisable worktree, whose
 * contents could not be committed first — each left for its owner. Settled
 * Runs' records older than 30 days go too. Returns how many worktrees were
 * removed.
 */
export async function sweepTaskWorktrees(input: {
  workspaces: Record<string, string>;
  workspacesRoot: string | null;
  log?: (line: string) => void;
  now?: number;
}): Promise<number> {
  const log = input.log ?? (() => {});
  const now = input.now ?? Date.now();
  let removed = 0;
  const root = await realpath(configDir()).catch(() => null);
  const worktreesRoot = root ? join(root, "task-worktrees") : null;
  if (worktreesRoot && await isRealDirectory(worktreesRoot)) {
    for (const locationId of await readdir(worktreesRoot).catch(() => [] as string[])) {
      if (!ID_SEGMENT.test(locationId)) continue;
      const base = await worktreesBase(locationId, false);
      if (!base) continue;
      for (const taskId of await readdir(base).catch(() => [] as string[])) {
        if (!TASK_ID.test(taskId)) continue;
        try {
          if (await sweepOne(input, locationId, taskId, join(base, taskId), now, log)) removed += 1;
        } catch (error) {
          log(`task worktree sweep of ${locationId}/${taskId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  await pruneRunRecords(now);
  await pruneRetiredQuarantine(now, log);
  return removed;
}

/** Whether the worktree was last used more than a day ago (its record, else the directory's mtime). */
async function isStale(locationId: string, taskId: string, path: string, now: number): Promise<{ stale: boolean; record: TaskRecord | null }> {
  const record = await readTaskRecord(locationId, taskId);
  const info = await lstat(path).catch(() => null);
  if (!info) return { stale: false, record };
  const lastUsed = record ? Date.parse(record.updated_at) : info.mtimeMs;
  return { stale: !Number.isFinite(lastUsed) || now - lastUsed >= DAY_MS, record };
}

async function sweepOne(
  input: { workspaces: Record<string, string>; workspacesRoot: string | null },
  locationId: string,
  taskId: string,
  path: string,
  now: number,
  log: (line: string) => void,
): Promise<boolean> {
  const key = taskLeaseKey(locationId, taskId);
  if (isTaskBusy(key) || await mergeHoldsWorktree(locationId, taskId)) return false;
  const first = await isStale(locationId, taskId, path, now);
  if (!first.stale) return false;
  const locationRoot = await sweepLocationRoot(input, locationId, first.record);
  if (!locationRoot) {
    log(`task worktree ${locationId}/${taskId}: its Location is not registered here; leaving it`);
    return false;
  }
  const check = await checkLocationRepository(locationRoot);
  if (check.kind !== "repository") {
    log(`task worktree ${locationId}/${taskId}: its Location is no longer a git checkout Rainver can use; leaving it`);
    return false;
  }
  const repo = check.repo;
  const done = await withTaskHeld(key, async () => {
    // With the lease held, a marker left by `worktree add` means it never finished.
    await discardInterruptedAdd(repo, locationId, taskId, path);
    // Again with the lease held: a Run may have used it since the first look.
    const { stale, record } = await isStale(locationId, taskId, path, now);
    if (!stale || await mergeHoldsWorktree(locationId, taskId)) return false;
    const ref = taskBranchRef(taskId);
    await clearStaleRefLock(repo, taskId);
    const state = await worktreeState(repo, path, ref, true);
    if (state.kind === "absent") return false;
    if (state.kind === "unrecognised") {
      log(`task worktree ${locationId}/${taskId}: not a git worktree Rainver recognises, so its contents cannot be committed; leaving it`);
      return false;
    }
    if (state.kind === "junk") {
      await removeJunk(repo, { locationId, taskId }, path);
      return true;
    }
    const tip = await commitOfRef(repo.root, ref);
    if (!tip) throw new Error("the Task branch is gone; leaving its worktree");
    await clearStaleLock([state.entry], "index.lock");
    const committed = await commitLeftovers(repo, path, ref, tip, record?.run_id ?? null);
    if (committed === null) {
      log(`task worktree ${locationId}/${taskId}: git could not capture it; moved aside with its contents intact`);
      await quarantine(repo, locationId, taskId, path);
    } else if ((await retireWorktree(repo, locationId, taskId, path)) === "quarantined") {
      log(`task worktree ${locationId}/${taskId}: it held a nested repository or could not be removed; moved aside`);
    }
    return true;
  });
  if (done) log(`removed the unsettled Task worktree ${locationId}/${taskId}`);
  return done === true;
}

/**
 * Where a swept worktree's Location is: its registered path on a paired host
 * (a Location no longer registered is left alone), or on the built-in host,
 * whose Locations are not registered, the path recorded at launch — only while
 * it is still under the instance's workspace root.
 */
async function sweepLocationRoot(
  input: { workspaces: Record<string, string>; workspacesRoot: string | null },
  locationId: string,
  record: TaskRecord | null,
): Promise<string | null> {
  const registered = input.workspaces[locationId];
  if (registered) return registered;
  if (!record || !input.workspacesRoot) return null;
  const sharedRoot = await realpath(input.workspacesRoot).catch(() => null);
  const recorded = await realpath(record.location_root).catch(() => null);
  if (!sharedRoot || !recorded || !recorded.startsWith(`${sharedRoot}${sep}`)) return null;
  return recorded;
}

/**
 * `-retired` quarantine targets past `RETIRED_QUARANTINE_RETENTION_MS`, by the
 * time in their name (a moved directory keeps its own mtime). Only real
 * directories; whole worktrees quarantined for their owner are never touched.
 */
async function pruneRetiredQuarantine(now: number, log: (line: string) => void): Promise<void> {
  const root = await realpath(configDir()).catch(() => null);
  const base = root ? join(root, "task-worktrees-quarantine") : null;
  if (!base || !(await isRealDirectory(base))) return;
  for (const locationId of await readdir(base).catch(() => [] as string[])) {
    const dir = join(base, locationId);
    if (!ID_SEGMENT.test(locationId) || !(await isRealDirectory(dir))) continue;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const match = RETIRED_TARGET.exec(name);
      if (!match) continue;
      const madeAt = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
      if (!Number.isFinite(madeAt) || now - madeAt < RETIRED_QUARANTINE_RETENTION_MS) continue;
      const path = join(dir, name);
      if (!(await isRealDirectory(path))) continue;
      await rm(path, { recursive: true, force: true })
        .catch((error: unknown) => log(`quarantined ${locationId}/${name} could not be deleted: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

/** Settled Runs' and finished merges' stored answers, after 30 days. */
async function pruneRunRecords(now: number): Promise<void> {
  for (const directory of [join(configDir(), "task-runs"), join(configDir(), "task-merges")]) {
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const path = join(directory, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs > RUN_RECORD_RETENTION_MS) await rm(path, { force: true });
    }
  }
}
