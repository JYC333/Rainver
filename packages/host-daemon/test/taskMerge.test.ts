import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { handleLaunch, type LaunchFrame } from "../src/execution.js";
import { abortTaskMerge, continueTaskMerge, finishTaskMerge, prepareTaskMerge } from "../src/taskMerge.js";
import { deleteTaskBranch, settleTaskRun, sweepTaskWorktrees, TASK_BUSY } from "../src/taskWorktree.js";

let configDir: string;
let workspaceDir: string;
let server: Server;

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTHOR = { name: "Agent Smith", email: "agent@example.com" };
const MESSAGE = "Add the feature\n\nRequested-by: Person <person@example.com>";

beforeEach(async () => {
  configDir = await realpath(await mkdtemp(join(tmpdir(), "rainver-merge-config-")));
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "rainver-merge-location-")));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  server = createServer((_request, response) => {
    _request.resume();
    _request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  await saveConfig({
    server_url: `http://127.0.0.1:${address.port}`,
    host_id: "host-1",
    trust: "trusted",
    token: "secret-token",
    workspaces: { "folder-1": workspaceDir },
  });
});

afterEach(async () => {
  server.close();
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

function git(args: string[], cwd: string = workspaceDir): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initRepository(): Promise<string> {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "person@example.com"]);
  git(["config", "user.name", "Person"]);
  await writeFile(join(workspaceDir, "README.md"), "one\ntwo\nthree\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  return git(["rev-parse", "HEAD"]);
}

async function personCommits(file: string, content: string, message = `person edits ${file}`): Promise<string> {
  await writeFile(join(workspaceDir, file), content);
  git(["add", file]);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

function worktreePath(taskId: string): string {
  return join(configDir, "task-worktrees", "folder-1", taskId);
}

function collect() {
  const frames: Record<string, unknown>[] = [];
  const send = (frame: Record<string, unknown>) => { frames.push(frame); };
  const complete = () => new Promise<Record<string, unknown>>((resolve) => {
    const check = () => {
      const found = frames.find((frame) => frame.type === "complete");
      if (found) resolve(found);
      else setTimeout(check, 10);
    };
    check();
  });
  const output = () => frames.filter((frame) => frame.type === "output").map((frame) => String(frame.chunk)).join("");
  return { frames, send, complete, output };
}

function taskLaunch(runId: string, taskId: string, script: string, mergeId?: string): LaunchFrame {
  return {
    run_id: runId,
    launch_id: `${runId}-launch`,
    workspace: { kind: "location", workspace_location_id: "folder-1", worktree: { task_id: taskId, ...(mergeId ? { merge_id: mergeId } : {}) } },
    argv: ["sh", "-c", script],
  };
}

async function runTask(runId: string, taskId: string, script: string, mergeId?: string) {
  const run = collect();
  await handleLaunch(taskLaunch(runId, taskId, script, mergeId), run.send as never, () => {});
  return { ...run, completeFrame: await run.complete() };
}

/** A Task Run that does `script` in its worktree, settled. */
async function taskWork(taskId: string, script: string, runId = `run-${taskId}`): Promise<void> {
  const run = await runTask(runId, taskId, script);
  expect(run.completeFrame).toMatchObject({ exit_code: 0 });
  const settled = await settleTaskRun({
    locationRoot: workspaceDir, locationId: "folder-1", taskId, runId, author: AUTHOR, message: `run ${runId}`,
  });
  expect(settled.ok).toBe(true);
}

function target(taskId: string, mergeId: string) {
  return { locationRoot: workspaceDir, locationId: "folder-1", taskId, mergeId };
}

function prepare(taskId: string, mergeId: string) {
  return prepareTaskMerge({ ...target(taskId, mergeId), author: AUTHOR, message: MESSAGE });
}

function finish(taskId: string, mergeId: string, result: { main_branch: string | null; onto_commit: string | null; task_commit: string | null }) {
  return finishTaskMerge({
    ...target(taskId, mergeId),
    mainBranch: result.main_branch!,
    ontoCommit: result.onto_commit!,
    taskCommit: result.task_commit!,
  });
}

describe("task_merge_prepare", () => {
  it("squashes the branch into one unsigned commit rebased onto the main branch's tip", async () => {
    await initRepository();
    await taskWork("t1", [
      "echo a > a.txt && git add a.txt && git -c commit.gpgsign=false commit -q -m 'agent 1'",
      "echo b > b.txt",
    ].join(" && "), "run-t1-a");
    await taskWork("t1", "echo c > c.txt", "run-t1-b");
    const mainTip = await personCommits("main.txt", "main\n");
    // Signing configured to fail loudly if anything tried.
    git(["config", "commit.gpgsign", "true"]);
    git(["config", "gpg.program", "/bin/false"]);

    const result = await prepare("t1", "merge-1");
    expect(result).toMatchObject({ ok: true, outcome: "rebased", main_branch: "main", onto_commit: mainTip, conflicted_files: [], error: null });
    const commit = result.task_commit!;
    expect(git(["rev-parse", "rainver/task-t1"])).toBe(commit);
    expect(git(["log", "-1", "--format=%P", commit])).toBe(mainTip);
    expect(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>", commit])).toBe("Agent Smith <agent@example.com>|Agent Smith <agent@example.com>");
    expect(git(["log", "-1", "--format=%B", commit])).toBe(MESSAGE);
    expect(git(["cat-file", "-p", commit])).not.toContain("gpgsig");
    expect(git(["ls-tree", "--name-only", commit]).split("\n").sort()).toEqual(["README.md", "a.txt", "b.txt", "c.txt", "main.txt"]);
    // The person's checkout has not moved.
    expect(git(["rev-parse", "HEAD"])).toBe(mainTip);

    // Idempotent while nothing moved.
    expect(await prepare("t1", "merge-1")).toEqual(result);
    // The main branch moved since: squashed and rebased again.
    const newTip = await personCommits("more.txt", "more\n");
    const again = await prepare("t1", "merge-1");
    expect(again).toMatchObject({ ok: true, outcome: "rebased", onto_commit: newTip });
    expect(git(["log", "-1", "--format=%P", again.task_commit!])).toBe(newTip);
    expect(git(["rev-list", "--count", `${newTip}..rainver/task-t1`])).toBe("1");
  });

  it("answers no_changes for a branch with nothing the main branch lacks, or no branch", async () => {
    const initial = await initRepository();
    await taskWork("t-empty", "true");
    expect(await prepare("t-empty", "merge-e")).toEqual({
      ok: true, outcome: "no_changes", main_branch: "main", onto_commit: initial, task_commit: null, conflicted_files: [], error: null,
    });
    expect(await prepare("t-never", "merge-n")).toMatchObject({ ok: true, outcome: "no_changes" });
  });

  it("answers no_changes for a Location the Task's Runs worked in place: not a git checkout, or one with no commit", async () => {
    expect(await prepare("t-plain", "merge-p")).toMatchObject({ ok: true, outcome: "no_changes" });
    git(["init", "-q", "-b", "main"]);
    expect(await prepare("t-unborn", "merge-u")).toMatchObject({ ok: true, outcome: "no_changes" });
  });

  it("never takes a Task branch checked out in the Location for the main branch", async () => {
    await initRepository();
    git(["branch", "-m", "main", "trunk-less"]);
    git(["checkout", "-q", "-b", "rainver/task-other"]);
    await writeFile(join(workspaceDir, "x.txt"), "x\n");
    git(["add", "x.txt"]);
    git(["commit", "-q", "-m", "other task"]);
    expect(await prepare("t-main", "merge-m")).toMatchObject({ ok: false, error: "no_main_branch" });
  });

  it("writes a conflict into the worktree without sequencer state, refuses to continue while markers remain, and commits the resolution", async () => {
    await initRepository();
    await taskWork("t-c", "printf 'one\\nTASK\\nthree\\n' > README.md && echo extra > extra.txt");
    const mainTip = await personCommits("README.md", "one\nMAIN\nthree\n");
    const first = await prepare("t-c", "merge-c");
    expect(first).toMatchObject({ ok: true, outcome: "conflict", main_branch: "main", onto_commit: mainTip, conflicted_files: ["README.md"] });
    const squash = git(["rev-parse", "rainver/task-t-c"]);
    expect(git(["log", "-1", "--format=%s", squash])).toBe("Add the feature");
    expect(git(["symbolic-ref", "HEAD"], worktreePath("t-c"))).toBe("refs/heads/rainver/task-t-c");
    expect(await readFile(join(worktreePath("t-c"), "README.md"), "utf8")).toContain("<<<<<<<");
    const entry = join(workspaceDir, ".git", "worktrees", "t-c");
    for (const state of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "MERGE_HEAD"]) expect(existsSync(join(entry, state))).toBe(false);
    // Repeated: the same conflict.
    expect(await prepare("t-c", "merge-c")).toEqual(first);
    expect(await continueTaskMerge(target("t-c", "merge-c"))).toMatchObject({ ok: true, outcome: "unresolved", conflicted_files: ["README.md"] });
    // Resolved; nothing needs staging.
    await writeFile(join(worktreePath("t-c"), "README.md"), "one\nMAIN and TASK\nthree\n");
    const done = await continueTaskMerge(target("t-c", "merge-c"));
    expect(done).toMatchObject({ ok: true, outcome: "rebased", onto_commit: mainTip });
    expect(git(["log", "-1", "--format=%P|%an|%cn|%s", done.task_commit!])).toBe(`${mainTip}|Agent Smith|Agent Smith|Add the feature`);
    expect(git(["show", `${done.task_commit!}:README.md`])).toBe("one\nMAIN and TASK\nthree");
    expect(git(["show", `${done.task_commit!}:extra.txt`])).toBe("extra");
    expect(git(["status", "--porcelain"], worktreePath("t-c"))).toBe("");
    // Idempotent.
    expect(await continueTaskMerge(target("t-c", "merge-c"))).toEqual(done);
  });

  it("resolves a modify/delete conflict by the file's deletion", async () => {
    await initRepository();
    await taskWork("t-md", "rm README.md && echo other > other.txt");
    const mainTip = await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-md", "merge-md")).toMatchObject({ outcome: "conflict", conflicted_files: ["README.md"] });
    await rm(join(worktreePath("t-md"), "README.md"), { force: true });
    const done = await continueTaskMerge(target("t-md", "merge-md"));
    expect(done).toMatchObject({ outcome: "rebased", onto_commit: mainTip });
    expect(git(["ls-tree", "--name-only", done.task_commit!])).toBe("other.txt");
  });

  it("runs a resolution Run in the conflicted worktree as it is, and nothing else while the merge holds it", async () => {
    await initRepository();
    await taskWork("t-r", "printf 'one\\nTASK\\nthree\\n' > README.md");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-r", "merge-r")).toMatchObject({ outcome: "conflict" });
    const squash = git(["rev-parse", "rainver/task-t-r"]);
    // An ordinary Run, a settle and the sweep keep out.
    expect((await runTask("run-other", "t-r", "true")).completeFrame).toMatchObject({ exit_code: 1, error: expect.stringMatching(/merge of this Task holds/) });
    expect(await settleTaskRun({ locationRoot: workspaceDir, locationId: "folder-1", taskId: "t-r", runId: "run-other", author: AUTHOR, message: "x" }))
      .toMatchObject({ ok: false, error: TASK_BUSY });
    expect(await sweepTaskWorktrees({ workspaces: { "folder-1": workspaceDir }, workspacesRoot: null, now: Date.now() + 2 * DAY_MS })).toBe(0);
    expect(existsSync(worktreePath("t-r"))).toBe(true);
    // A resolution Run for another merge is refused.
    expect((await runTask("run-wrong", "t-r", "true", "merge-other")).completeFrame).toMatchObject({ exit_code: 1, error: expect.stringMatching(/no conflict of that merge/) });
    const resolution = await runTask("run-resolve", "t-r", "grep -c '<<<<<<<' README.md; printf 'one\\nBOTH\\nthree\\n' > README.md", "merge-r");
    expect(resolution.completeFrame).toMatchObject({ exit_code: 0 });
    expect(resolution.completeFrame.task_worktree).toBeUndefined();
    expect(resolution.output().trim()).toBe("1");
    expect(git(["rev-parse", "rainver/task-t-r"])).toBe(squash);
    const done = await continueTaskMerge(target("t-r", "merge-r"));
    expect(done).toMatchObject({ outcome: "rebased" });
    expect(git(["show", `${done.task_commit!}:README.md`])).toBe("one\nBOTH\nthree");
  });

  it("ignores a resolution Run's own commits and planted sequencer state, and puts back a branch it moved elsewhere", async () => {
    await initRepository();
    const marker = join(configDir, "exec-ran");
    await taskWork("t-s", "printf 'one\\nTASK\\nthree\\n' > README.md");
    const mainTip = await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-s", "merge-s")).toMatchObject({ outcome: "conflict" });
    const entry = join(workspaceDir, ".git", "worktrees", "t-s");
    await runTask("run-self", "t-s", [
      "printf 'one\\nSELF\\nthree\\n' > README.md && echo more > more.txt",
      "git add -A && git -c commit.gpgsign=false commit -q -m 'agent commit'",
      `mkdir -p ${entry}/rebase-merge && printf 'exec touch ${marker}\\n' > ${entry}/rebase-merge/git-rebase-todo`,
      `printf 'refs/heads/main\\n' > ${entry}/rebase-merge/head-name && printf -- '-Sx\\n' > ${entry}/rebase-merge/gpg_sign_opt`,
    ].join(" && "), "merge-s");
    const done = await continueTaskMerge(target("t-s", "merge-s"));
    expect(done).toMatchObject({ ok: true, outcome: "rebased", onto_commit: mainTip });
    expect(git(["log", "-1", "--format=%P|%an|%s", done.task_commit!])).toBe(`${mainTip}|Agent Smith|Add the feature`);
    // Only the conflicted file is taken from the resolution; more.txt is not.
    expect(git(["ls-tree", "--name-only", done.task_commit!]).split("\n").sort()).toEqual(["README.md"]);
    expect(git(["show", `${done.task_commit!}:README.md`])).toBe("one\nSELF\nthree");
    expect(existsSync(marker)).toBe(false);
    expect(git(["rev-parse", "main"])).toBe(mainTip);

    await taskWork("t-s2", "printf 'one\\nTASK2\\nthree\\n' > README.md");
    await personCommits("README.md", "one\nMAIN2\nthree\n");
    expect(await prepare("t-s2", "merge-s2")).toMatchObject({ outcome: "conflict" });
    const squash = git(["rev-parse", "rainver/task-t-s2"]);
    await runTask("run-reset", "t-s2", "git reset -q --hard main", "merge-s2");
    expect(await continueTaskMerge(target("t-s2", "merge-s2"))).toMatchObject({ ok: true, outcome: "unresolved", conflicted_files: ["README.md"] });
    expect(git(["rev-parse", "rainver/task-t-s2"])).toBe(squash);
  });

  it("drops the record and puts the squashed commit back when a step fails", async () => {
    await initRepository();
    await taskWork("t-err", "printf 'one\\nTASK\\nthree\\n' > README.md");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    git(["config", "merge.a=b.driver", "false"]);
    expect(await prepare("t-err", "merge-err")).toMatchObject({ ok: false, error: expect.stringMatching(/cannot neutralise/) });
    expect(existsSync(join(configDir, "task-records", "folder-1", "t-err.merge.json"))).toBe(false);
    expect(git(["log", "-1", "--format=%s", "rainver/task-t-err"])).toBe("Add the feature");
    expect(git(["status", "--porcelain"], worktreePath("t-err"))).toBe("");
  });

  it("merges again without what verification left in the worktree", async () => {
    await initRepository();
    await taskWork("t-v", "echo feature > feature.txt");
    const first = await prepare("t-v", "merge-v");
    expect(first).toMatchObject({ outcome: "rebased" });
    await writeFile(join(worktreePath("t-v"), "build-output.txt"), "built\n");
    await writeFile(join(worktreePath("t-v"), "feature.txt"), "changed by a test\n");
    const newTip = await personCommits("more.txt", "more\n");
    const again = await prepare("t-v", "merge-v");
    expect(again).toMatchObject({ outcome: "rebased", onto_commit: newTip });
    expect(git(["ls-tree", "--name-only", again.task_commit!]).split("\n").sort()).toEqual(["README.md", "feature.txt", "more.txt"]);
    expect(git(["show", `${again.task_commit!}:feature.txt`])).toBe("feature");
  });

  it("lets an ordinary Run drop a merge left rebased", async () => {
    await initRepository();
    await taskWork("t-l", "echo feature > feature.txt");
    const rebased = await prepare("t-l", "merge-l");
    expect(rebased).toMatchObject({ outcome: "rebased" });
    const run = await runTask("run-later", "t-l", "cat feature.txt");
    expect(run.completeFrame).toMatchObject({ exit_code: 0, task_worktree: { start_commit: rebased.task_commit } });
    expect(existsSync(join(configDir, "task-records", "folder-1", "t-l.merge.json"))).toBe(false);
  });

  it("keeps what the merge wrote that the worktree cannot show: main's submodule commit and a force-added ignored file", async () => {
    const initial = await initRepository();
    await personCommits(".gitignore", "*.log\n");
    git(["update-index", "--add", "--cacheinfo", `160000,${initial},sub`]);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "submodule"]);
    await taskWork("t-sub", "printf 'one\\nTASK\\nthree\\n' > README.md");
    // Main bumps the submodule, force-adds an ignored file, and conflicts on README.
    const bumped = git(["rev-parse", "HEAD"]);
    git(["update-index", "--cacheinfo", `160000,${bumped},sub`]);
    await writeFile(join(workspaceDir, "keep.log"), "kept\n");
    git(["add", "-f", "keep.log"]);
    const mainTip = await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-sub", "merge-sub")).toMatchObject({ outcome: "conflict", conflicted_files: ["README.md"] });
    await writeFile(join(worktreePath("t-sub"), "README.md"), "one\nBOTH\nthree\n");
    const done = await continueTaskMerge(target("t-sub", "merge-sub"));
    expect(done).toMatchObject({ outcome: "rebased", onto_commit: mainTip });
    expect(git(["rev-parse", `${done.task_commit!}:sub`])).toBe(bumped);
    expect(git(["show", `${done.task_commit!}:keep.log`])).toBe("kept");
    expect(git(["show", `${done.task_commit!}:README.md`])).toBe("one\nBOTH\nthree");
  });

  it("recognises longer conflict markers, and marker-less conflicts nobody decided", async () => {
    await initRepository();
    await personCommits(".gitattributes", "README.md conflict-marker-size=10\n");
    await personCommits("bin.dat", "base\0binary\n");
    await taskWork("t-mk", "printf 'one\\nTASK\\nthree\\n' > README.md && printf 'task\\0binary\\n' > bin.dat");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    await personCommits("bin.dat", "main\0binary\n");
    expect(await prepare("t-mk", "merge-mk")).toMatchObject({ outcome: "conflict", conflicted_files: ["README.md", "bin.dat"] });
    expect(await readFile(join(worktreePath("t-mk"), "README.md"), "utf8")).toContain("<<<<<<<<<< ");
    expect(await continueTaskMerge(target("t-mk", "merge-mk"))).toMatchObject({ outcome: "unresolved", conflicted_files: ["README.md", "bin.dat"] });
    await writeFile(join(worktreePath("t-mk"), "README.md"), "one\nBOTH\nthree\n");
    // The binary file untouched: still nobody's decision.
    expect(await continueTaskMerge(target("t-mk", "merge-mk"))).toMatchObject({ outcome: "unresolved", conflicted_files: ["bin.dat"] });
    await writeFile(join(worktreePath("t-mk"), "bin.dat"), "decided\0binary\n");
    expect(await continueTaskMerge(target("t-mk", "merge-mk"))).toMatchObject({ outcome: "rebased" });
  });

  it("does not take an untouched modify/delete conflict as resolved", async () => {
    await initRepository();
    await taskWork("t-mdu", "rm README.md && echo other > other.txt");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-mdu", "merge-mdu")).toMatchObject({ outcome: "conflict", conflicted_files: ["README.md"] });
    expect(await continueTaskMerge(target("t-mdu", "merge-mdu"))).toMatchObject({ outcome: "unresolved", conflicted_files: ["README.md"] });
  });

  it("hands a conflict with more paths than the wire carries to the person", async () => {
    await initRepository();
    const count = 501;
    const names = Array.from({ length: count }, (_, index) => `f${String(index).padStart(3, "0")}.txt`);
    for (const name of names) await writeFile(join(workspaceDir, name), "base\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "many"]);
    await taskWork("t-many", `for f in f*.txt; do echo task > "$f"; done`);
    for (const name of names) await writeFile(join(workspaceDir, name), "main\n");
    git(["commit", "-q", "-am", "main many"]);
    const conflict = await prepare("t-many", "merge-many");
    expect(conflict).toMatchObject({ outcome: "conflict" });
    expect(conflict.conflicted_files).toHaveLength(500);
    for (const name of names) await writeFile(join(worktreePath("t-many"), name), "both\n");
    expect(await continueTaskMerge(target("t-many", "merge-many"))).toMatchObject({ outcome: "unresolved" });
  }, 60_000);

  it("takes only the conflicted paths from the worktree, so a reset worktree cannot revert main", async () => {
    await initRepository();
    await taskWork("t-rs", "printf 'one\\nTASK\\nthree\\n' > README.md");
    await personCommits("other.txt", "main's other change\n");
    const mainTip = await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-rs", "merge-rs")).toMatchObject({ outcome: "conflict", conflicted_files: ["README.md"] });
    // Throws the merged files away: the worktree is the Task's side again.
    await runTask("run-rs", "t-rs", "git reset -q --hard && git stash -q -u || true", "merge-rs");
    const done = await continueTaskMerge(target("t-rs", "merge-rs"));
    expect(done).toMatchObject({ outcome: "rebased", onto_commit: mainTip });
    expect(git(["show", `${done.task_commit!}:other.txt`])).toBe("main's other change");
    expect(git(["show", `${done.task_commit!}:README.md`])).toBe("one\nTASK\nthree");
  });

  it("writes the conflict out again when a resolution Run checks something else out, and never answers no_changes", async () => {
    await initRepository();
    await taskWork("t-hd", "printf 'one\\nTASK\\nthree\\n' > README.md");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-hd", "merge-hd")).toMatchObject({ outcome: "conflict" });
    const squash = git(["rev-parse", "rainver/task-t-hd"]);
    await runTask("run-hd", "t-hd", "git checkout -q -f --detach main", "merge-hd");
    expect(await continueTaskMerge(target("t-hd", "merge-hd"))).toMatchObject({ ok: true, outcome: "unresolved", conflicted_files: ["README.md"] });
    expect(git(["rev-parse", "rainver/task-t-hd"])).toBe(squash);
    expect(git(["symbolic-ref", "HEAD"], worktreePath("t-hd"))).toBe("refs/heads/rainver/task-t-hd");
    expect(await readFile(join(worktreePath("t-hd"), "README.md"), "utf8")).toContain("<<<<<<<");
    // A resolution that keeps nothing of the Task is the person's call.
    await writeFile(join(worktreePath("t-hd"), "README.md"), "one\nMAIN\nthree\n");
    expect(await continueTaskMerge(target("t-hd", "merge-hd"))).toMatchObject({ ok: true, outcome: "unresolved" });
    expect(git(["rev-parse", "rainver/task-t-hd"])).toBe(squash);
  });

  it("makes the Task branch again when a resolution Run deleted it", async () => {
    await initRepository();
    await taskWork("t-gone", "printf 'one\\nTASK\\nthree\\n' > README.md");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-gone", "merge-gone")).toMatchObject({ outcome: "conflict" });
    const squash = git(["rev-parse", "rainver/task-t-gone"]);
    await runTask("run-delete", "t-gone", "git checkout -q --detach && git branch -D rainver/task-t-gone", "merge-gone");
    expect(await continueTaskMerge(target("t-gone", "merge-gone"))).toMatchObject({ ok: true, outcome: "unresolved", conflicted_files: ["README.md"] });
    expect(git(["rev-parse", "rainver/task-t-gone"])).toBe(squash);
    // The conflict is back as the merge left it, and can still be resolved.
    expect(await readFile(join(worktreePath("t-gone"), "README.md"), "utf8")).toContain("<<<<<<<");
    await writeFile(join(worktreePath("t-gone"), "README.md"), "one\nBOTH\nthree\n");
    expect(await continueTaskMerge(target("t-gone", "merge-gone"))).toMatchObject({ outcome: "rebased" });
    await abortTaskMerge(target("t-gone", "merge-gone"));

    expect(await prepare("t-gone", "merge-gone-2")).toMatchObject({ outcome: "conflict" });
    const squash2 = git(["rev-parse", "rainver/task-t-gone"]);
    await runTask("run-delete-2", "t-gone", "git checkout -q --detach && git branch -D rainver/task-t-gone", "merge-gone-2");
    expect(await abortTaskMerge(target("t-gone", "merge-gone-2"))).toEqual({ ok: true, error: null });
    expect(git(["rev-parse", "rainver/task-t-gone"])).toBe(squash2);
    expect(git(["symbolic-ref", "HEAD"], worktreePath("t-gone"))).toBe("refs/heads/rainver/task-t-gone");
  });

  it("finishes a continue cut short after it moved the branch", async () => {
    await initRepository();
    await taskWork("t-cut", "printf 'one\\nTASK\\nthree\\n' > README.md");
    const mainTip = await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-cut", "merge-cut")).toMatchObject({ outcome: "conflict" });
    // As if a continue wrote its commit, moved the branch, and stopped.
    const tree = git(["rev-parse", `${mainTip}^{tree}`]);
    const commit = git(["commit-tree", tree, "-p", mainTip, "-m", "Add the feature"]);
    const recordPath = join(configDir, "task-records", "folder-1", "t-cut.merge.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({ ...record, pending_task_commit: commit }));
    git(["update-ref", "refs/heads/rainver/task-t-cut", commit]);
    expect(await continueTaskMerge(target("t-cut", "merge-cut"))).toMatchObject({ ok: true, outcome: "rebased", task_commit: commit });
    expect(git(["status", "--porcelain"], worktreePath("t-cut"))).toBe("");
  });

  it("never runs a merge driver the repository's own configuration defines", async () => {
    await initRepository();
    const marker = join(configDir, "driver-ran");
    git(["config", "merge.evil.driver", `touch ${marker}`]);
    await writeFile(join(workspaceDir, ".gitattributes"), "README.md merge=evil\n");
    git(["add", ".gitattributes"]);
    git(["commit", "-q", "-m", "attributes"]);
    await taskWork("t-d", "printf 'one\\nTASK\\nthree\\n' > README.md");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-d", "merge-d")).toMatchObject({ outcome: "conflict", conflicted_files: ["README.md"] });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("task_merge_abort", () => {
  it("puts the branch back on the squashed commit and the worktree clean, idempotently", async () => {
    const initial = await initRepository();
    await taskWork("t-a", "printf 'one\\nTASK\\nthree\\n' > README.md && echo x > x.txt");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-a", "merge-a")).toMatchObject({ outcome: "conflict" });
    await writeFile(join(worktreePath("t-a"), "stray.txt"), "stray\n");
    expect(await abortTaskMerge(target("t-a", "merge-a"))).toEqual({ ok: true, error: null });
    const tip = git(["rev-parse", "rainver/task-t-a"]);
    expect(git(["log", "-1", "--format=%P|%s", tip])).toBe(`${initial}|Add the feature`);
    expect(git(["symbolic-ref", "HEAD"], worktreePath("t-a"))).toBe("refs/heads/rainver/task-t-a");
    expect(git(["status", "--porcelain"], worktreePath("t-a"))).toBe("");
    expect(await readFile(join(worktreePath("t-a"), "README.md"), "utf8")).toBe("one\nTASK\nthree\n");
    expect(await abortTaskMerge(target("t-a", "merge-a"))).toEqual({ ok: true, error: null });
    // Released: an ordinary Run may use the worktree again.
    expect((await runTask("run-after", "t-a", "cat x.txt")).completeFrame).toMatchObject({ exit_code: 0 });
  });

  it("drops a merge held between steps when the Task's branch is deleted", async () => {
    await initRepository();
    await taskWork("t-del", "printf 'one\\nTASK\\nthree\\n' > README.md");
    await personCommits("README.md", "one\nMAIN\nthree\n");
    expect(await prepare("t-del", "merge-del")).toMatchObject({ outcome: "conflict" });
    expect(await deleteTaskBranch({ locationRoot: workspaceDir, locationId: "folder-1", taskId: "t-del" })).toEqual({ ok: true, deleted: true, error: null });
    expect(existsSync(worktreePath("t-del"))).toBe(false);
    expect(existsSync(join(configDir, "task-records", "folder-1", "t-del.merge.json"))).toBe(false);
  });
});

describe("task_merge_finish", () => {
  async function rebasedTask(taskId: string, mergeId: string) {
    await initRepository();
    await taskWork(taskId, "echo feature > feature.txt && printf 'one\\ntwo\\nTHREE\\n' > README.md");
    const result = await prepare(taskId, mergeId);
    expect(result).toMatchObject({ outcome: "rebased" });
    return result;
  }

  it("fast-forwards the checkout on main, keeps the person's other edits, removes the worktree and branch, idempotently", async () => {
    const result = await rebasedTask("t-f", "merge-f");
    await writeFile(join(workspaceDir, "notes.txt"), "mine\n");
    const done = await finish("t-f", "merge-f", result);
    expect(done).toEqual({ ok: true, outcome: "merged", merged_commit: result.task_commit, overlapping_files: [], error: null });
    expect(git(["rev-parse", "main"])).toBe(result.task_commit);
    expect(git(["rev-parse", "HEAD"])).toBe(result.task_commit);
    expect(await readFile(join(workspaceDir, "feature.txt"), "utf8")).toBe("feature\n");
    expect(await readFile(join(workspaceDir, "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(worktreePath("t-f"))).toBe(false);
    expect(git(["branch", "--list", "rainver/task-t-f"])).toBe("");
    expect(await finish("t-f", "merge-f", result)).toEqual(done);
  });

  it("waits while the person's uncommitted or ignored files overlap the Task's", async () => {
    const result = await rebasedTask("t-o", "merge-o");
    await writeFile(join(workspaceDir, "README.md"), "person's edit\n");
    await writeFile(join(workspaceDir, "feature.txt"), "untracked clash\n");
    expect(await finish("t-o", "merge-o", result)).toEqual({
      ok: true, outcome: "waiting_local_changes", merged_commit: null, overlapping_files: ["README.md", "feature.txt"], error: null,
    });
    expect(git(["rev-parse", "main"])).toBe(result.onto_commit);
    expect(await readFile(join(workspaceDir, "README.md"), "utf8")).toBe("person's edit\n");
  });

  it("waits when a file of the person's sits where the Task needs a directory", async () => {
    await initRepository();
    await taskWork("t-dir", "mkdir -p lib && echo code > lib/code.txt");
    const result = await prepare("t-dir", "merge-dir");
    expect(result).toMatchObject({ outcome: "rebased" });
    await writeFile(join(workspaceDir, "lib"), "the person's file\n");
    expect(await finish("t-dir", "merge-dir", result)).toMatchObject({ ok: true, outcome: "waiting_local_changes", overlapping_files: ["lib"] });
  });

  it("merges a Task that turns a directory into a file and a file into a directory", async () => {
    await initRepository();
    await mkdir(join(workspaceDir, "d"));
    await personCommits("d/f.txt", "in a directory\n");
    await personCommits("e", "a file\n");
    await taskWork("t-df", "rm -r d e && echo file > d && mkdir e && echo inside > e/x.txt");
    const result = await prepare("t-df", "merge-df");
    expect(result).toMatchObject({ outcome: "rebased" });
    expect(await finish("t-df", "merge-df", result)).toMatchObject({ ok: true, outcome: "merged" });
    expect(await readFile(join(workspaceDir, "d"), "utf8")).toBe("file\n");
    expect(await readFile(join(workspaceDir, "e", "x.txt"), "utf8")).toBe("inside\n");
  });

  it("never overwrites a file the person's checkout ignores", async () => {
    await initRepository();
    await personCommits(".gitignore", "gen.txt\n");
    await taskWork("t-i", "printf '' > .gitignore && echo generated-by-task > gen.txt");
    const result = await prepare("t-i", "merge-i");
    expect(result).toMatchObject({ outcome: "rebased" });
    await writeFile(join(workspaceDir, "gen.txt"), "the person's own\n");
    expect(await finish("t-i", "merge-i", result)).toMatchObject({ ok: true, outcome: "waiting_local_changes", overlapping_files: ["gen.txt"] });
    expect(await readFile(join(workspaceDir, "gen.txt"), "utf8")).toBe("the person's own\n");
  });

  it("waits while the person is rebasing main (HEAD detached)", async () => {
    const result = await rebasedTask("t-p", "merge-p");
    // Stops part-way: HEAD detached, main named only in rebase-merge/head-name.
    try {
      execFileSync("git", ["rebase", "-x", "false", "--root"], { cwd: workspaceDir, env: { ...process.env, GIT_SEQUENCE_EDITOR: ":", GIT_EDITOR: ":" }, stdio: "ignore" });
    } catch { /* expected to stop */ }
    expect(existsSync(join(workspaceDir, ".git", "rebase-merge", "head-name"))).toBe(true);
    expect(await finish("t-p", "merge-p", result)).toEqual({
      ok: true, outcome: "waiting_local_changes", merged_commit: null, overlapping_files: [], error: null,
    });
    expect(git(["rev-parse", "main"])).toBe(result.onto_commit);
    git(["rebase", "--abort"]);
    expect(await finish("t-p", "merge-p", result)).toMatchObject({ outcome: "merged" });
  });

  it("counts a fast-forward that happened before a crash as merged, and a replay finishes the cleanup", async () => {
    const result = await rebasedTask("t-k", "merge-k");
    const recordPath = join(configDir, "task-records", "folder-1", "t-k.merge.json");
    const record = await readFile(recordPath, "utf8");
    // As if the daemon died right after the fast-forward.
    git(["merge", "-q", "--ff-only", result.task_commit!]);
    expect(await finish("t-k", "merge-k", result)).toMatchObject({ ok: true, outcome: "merged", merged_commit: result.task_commit });
    expect(existsSync(worktreePath("t-k"))).toBe(false);
    expect(git(["branch", "--list", "rainver/task-t-k"])).toBe("");
    // A record left behind by a crash in the cleanup goes with the next repeat.
    await writeFile(recordPath, record);
    expect(await finish("t-k", "merge-k", result)).toMatchObject({ ok: true, outcome: "merged" });
    expect(existsSync(recordPath)).toBe(false);
  });

  it("answers main_moved when the person committed on main", async () => {
    const result = await rebasedTask("t-m", "merge-m");
    await personCommits("later.txt", "later\n");
    expect(await finish("t-m", "merge-m", result)).toMatchObject({ ok: true, outcome: "main_moved", merged_commit: null });
    expect(existsSync(worktreePath("t-m"))).toBe(true);
  });

  it("answers location_busy while a writer holds the Location", async () => {
    const result = await rebasedTask("t-b", "merge-b");
    const writer = collect();
    await handleLaunch({ run_id: "writer", launch_id: "writer-1", workspace_location_id: "folder-1", argv: ["sh", "-c", "sleep 0.5"] }, writer.send as never, () => {});
    expect(await finish("t-b", "merge-b", result)).toMatchObject({ ok: false, error: "location_busy" });
    await writer.complete();
    expect(await finish("t-b", "merge-b", result)).toMatchObject({ ok: true, outcome: "merged" });
  });

  it("moves main by compare-and-swap when the checkout is on another branch", async () => {
    const result = await rebasedTask("t-x", "merge-x");
    git(["checkout", "-q", "-b", "person-work"]);
    await writeFile(join(workspaceDir, "README.md"), "dirty but irrelevant\n");
    expect(await finish("t-x", "merge-x", result)).toMatchObject({ ok: true, outcome: "merged" });
    expect(git(["rev-parse", "main"])).toBe(result.task_commit);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("person-work");
    expect(await readFile(join(workspaceDir, "README.md"), "utf8")).toBe("dirty but irrelevant\n");
  });

  it("refuses when main is checked out in another worktree, and a mismatched commit", async () => {
    const result = await rebasedTask("t-e", "merge-e");
    git(["checkout", "-q", "-b", "person-work"]);
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "rainver-merge-elsewhere-")));
    await rm(elsewhere, { recursive: true, force: true });
    try {
      git(["worktree", "add", "-q", elsewhere, "main"]);
      expect(await finish("t-e", "merge-e", result)).toMatchObject({ ok: false, error: "main_checked_out_elsewhere" });
      expect(await finish("t-e", "merge-e", { ...result, task_commit: result.onto_commit })).toMatchObject({ ok: false, error: "merge_mismatch" });
    } finally {
      git(["worktree", "remove", "--force", elsewhere]);
    }
  });
});
