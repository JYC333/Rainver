import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { handleLaunch, type LaunchFrame } from "../src/execution.js";
import { runHostCommand } from "../src/commandRun.js";
import { resolveMainBranch } from "../src/mainBranch.js";
import { checkLocationRepository, deleteTaskBranch, settleTaskRun, sweepTaskWorktrees, TASK_BUSY } from "../src/taskWorktree.js";

let configDir: string;
let workspaceDir: string;
let server: Server;
let diffs: Map<string, Record<string, unknown>>;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  configDir = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-config-")));
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-location-")));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  diffs = new Map();
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const match = /\/runs\/([^/]+)\/diff$/.exec(request.url ?? "");
      if (match) diffs.set(decodeURIComponent(match[1]!), JSON.parse(body) as Record<string, unknown>);
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
  // A test leaves a read-only directory behind on purpose.
  execFileSync("chmod", ["-R", "u+w", configDir]);
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initRepository(dir: string): Promise<string> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "person@example.com"], dir);
  git(["config", "user.name", "Person"], dir);
  await writeFile(join(dir, "README.md"), "hello\n");
  await writeFile(join(dir, ".gitignore"), "*.log\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "initial"], dir);
  return git(["rev-parse", "HEAD"], dir);
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

function taskLaunch(runId: string, launchId: string, taskId: string, script: string): LaunchFrame {
  return {
    run_id: runId,
    launch_id: launchId,
    workspace: { kind: "location", workspace_location_id: "folder-1", worktree: { task_id: taskId } },
    argv: ["sh", "-c", script],
  };
}

/** Launches and waits for `complete`. */
async function runTask(runId: string, launchId: string, taskId: string, script: string) {
  const run = collect();
  await handleLaunch(taskLaunch(runId, launchId, taskId, script), run.send as never, () => {});
  const complete = await run.complete();
  return { ...run, completeFrame: complete };
}

function settle(runId: string, taskId: string, overrides: Partial<Parameters<typeof settleTaskRun>[0]> = {}) {
  return settleTaskRun({
    locationRoot: workspaceDir,
    locationId: "folder-1",
    taskId,
    runId,
    author: { name: "Agent Smith", email: "agent@example.com" },
    message: "Fix the thing\n\nRequested-by: Person <person@example.com>",
    ...overrides,
  });
}

function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (condition() ? resolve() : setTimeout(check, 5));
    check();
  });
}

describe("resolveMainBranch", () => {
  it("prefers origin/HEAD's branch, then main, then master, then the checkout's own", async () => {
    const initial = await initRepository(workspaceDir);
    git(["branch", "trunk"], workspaceDir);
    git(["checkout", "-q", "-b", "feature"], workspaceDir);
    git(["commit", "-q", "--allow-empty", "-m", "feature work"], workspaceDir);
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], workspaceDir);
    expect(await resolveMainBranch(workspaceDir)).toEqual({ branch: "trunk", commit: initial });
    git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], workspaceDir);
    expect(await resolveMainBranch(workspaceDir)).toEqual({ branch: "main", commit: initial });
    git(["branch", "-m", "main", "master"], workspaceDir);
    expect(await resolveMainBranch(workspaceDir)).toEqual({ branch: "master", commit: initial });
    git(["branch", "-D", "master"], workspaceDir);
    const feature = git(["rev-parse", "HEAD"], workspaceDir);
    expect(await resolveMainBranch(workspaceDir)).toEqual({ branch: "feature", commit: feature });
    git(["checkout", "-q", "--detach"], workspaceDir);
    expect(await resolveMainBranch(workspaceDir)).toEqual({ branch: null, commit: feature });
  });
});

describe("Task worktrees", () => {
  it("runs in the Task's worktree under the daemon's directory, on a branch started from main, and keeps it after complete", async () => {
    const initial = await initRepository(workspaceDir);
    // The person is on another branch: the Task still starts from main.
    git(["checkout", "-q", "-b", "person-feature"], workspaceDir);
    git(["commit", "-q", "--allow-empty", "-m", "person's work"], workspaceDir);
    const run = await runTask("run-1", "launch-1", "task-1", "pwd; git rev-parse --abbrev-ref HEAD; echo edit > a.txt");
    expect(run.completeFrame).toMatchObject({
      exit_code: 0,
      task_worktree: { branch: "rainver/task-task-1", start_commit: initial },
    });
    expect(run.output().trim().split("\n")).toEqual([worktreePath("task-1"), "rainver/task-task-1"]);
    expect(git(["rev-parse", "rainver/task-task-1"], workspaceDir)).toBe(initial);
    // Kept for verification, until settle.
    expect(existsSync(join(worktreePath("task-1"), "a.txt"))).toBe(true);
    // Nothing in the person's checkout.
    expect(existsSync(join(workspaceDir, ".rainver"))).toBe(false);
    expect(existsSync(join(workspaceDir, "a.txt"))).toBe(false);
    expect(git(["status", "--porcelain"], workspaceDir)).toBe("");
    expect(await readFile(join(workspaceDir, ".git", "info", "exclude"), "utf8")).not.toContain("rainver");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], workspaceDir)).toBe("person-feature");
    // The diff is the Run's; no HEAD report for a Task worktree.
    await waitFor(() => diffs.has("run-1"));
    expect(String(diffs.get("run-1")?.diff)).toContain("a.txt");
    expect(diffs.get("run-1")?.git_after).toBeUndefined();
    expect(diffs.get("run-1")?.git_before).toBeUndefined();
  });

  it("settles everything since the start commit — Agent commits, edits, untracked files — as one unsigned commit", async () => {
    const initial = await initRepository(workspaceDir);
    // A signing configuration that would fail loudly if anything tried to sign.
    git(["config", "commit.gpgsign", "true"], workspaceDir);
    git(["config", "gpg.program", "/bin/false"], workspaceDir);
    const script = [
      "echo one > one.txt && git add one.txt && git -c commit.gpgsign=false commit -q -m 'agent 1'",
      "echo two > two.txt && git add two.txt && git -c commit.gpgsign=false commit -q -m 'agent 2'",
      "echo changed >> README.md",
      "echo staged > staged.txt && git add staged.txt",
      "echo untracked > untracked.txt",
      "echo noise > debug.log",
    ].join(" && ");
    const run = await runTask("run-squash", "launch-squash", "task-squash", script);
    expect(run.completeFrame).toMatchObject({ exit_code: 0, task_worktree: { start_commit: initial } });
    await waitFor(() => diffs.has("run-squash"));
    // The uploaded diff counts from the start commit, so the Agent's commits are in it.
    const diff = String(diffs.get("run-squash")?.diff);
    for (const file of ["one.txt", "two.txt", "README.md", "staged.txt", "untracked.txt"]) expect(diff).toContain(file);

    const message = "Fix the thing\n\nRequested-by: Person <person@example.com>";
    const result = await settle("run-squash", "task-squash");
    expect(result).toMatchObject({ ok: true, branch: "rainver/task-task-squash", error: null });
    const commit = result.commit!;
    expect(git(["rev-parse", "rainver/task-task-squash"], workspaceDir)).toBe(commit);
    expect(git(["log", "-1", "--format=%P", commit], workspaceDir)).toBe(initial);
    expect(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>", commit], workspaceDir))
      .toBe("Agent Smith <agent@example.com>|Agent Smith <agent@example.com>");
    expect(git(["log", "-1", "--format=%B", commit], workspaceDir)).toBe(message);
    expect(git(["cat-file", "-p", commit], workspaceDir)).not.toContain("gpgsig");
    expect(git(["ls-tree", "--name-only", commit], workspaceDir).split("\n").sort())
      .toEqual([".gitignore", "README.md", "one.txt", "staged.txt", "two.txt", "untracked.txt"]);
    expect(git(["show", `${commit}:README.md`], workspaceDir)).toBe("hello\nchanged");
    // The worktree is gone, and git no longer lists it.
    expect(existsSync(worktreePath("task-squash"))).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], workspaceDir)).not.toContain("task-squash");
    // The person's checkout never moved.
    expect(git(["rev-parse", "HEAD"], workspaceDir)).toBe(initial);
    // Idempotent.
    expect(await settle("run-squash", "task-squash", { message: "something else" })).toEqual(result);
  });

  it("settles a Run that changed nothing without a commit and removes the worktree", async () => {
    const initial = await initRepository(workspaceDir);
    await runTask("run-idle", "launch-idle", "task-idle", "true");
    expect(existsSync(worktreePath("task-idle"))).toBe(true);
    expect(await settle("run-idle", "task-idle")).toEqual({ ok: true, branch: "rainver/task-task-idle", commit: null, error: null });
    expect(existsSync(worktreePath("task-idle"))).toBe(false);
    expect(git(["rev-parse", "rainver/task-task-idle"], workspaceDir)).toBe(initial);
  });

  it("starts a Task's next Run from the previous Run's settled commit", async () => {
    await initRepository(workspaceDir);
    await runTask("run-a", "launch-a", "task-seq", "echo first > first.txt");
    const first = await settle("run-a", "task-seq");
    expect(first.commit).toBeTruthy();
    const second = await runTask("run-b", "launch-b", "task-seq", "cat first.txt; git status --porcelain");
    expect(second.completeFrame).toMatchObject({ exit_code: 0, task_worktree: { start_commit: first.commit } });
    expect(second.output().trim()).toBe("first");
  });

  it("commits an unsettled Run's leftovers before the next Run, which starts clean", async () => {
    await initRepository(workspaceDir);
    const earlier = await runTask("run-left", "launch-left", "task-left", "echo leftover > left.txt; echo more >> README.md");
    const earlierStart = (earlier.completeFrame.task_worktree as { start_commit: string }).start_commit;
    const next = await runTask("run-next", "launch-next", "task-left", "git status --porcelain; cat left.txt");
    const start = (next.completeFrame.task_worktree as { start_commit: string }).start_commit;
    expect(next.output().trim()).toBe("leftover");
    expect(start).not.toBe(earlierStart);
    expect(git(["log", "-1", "--format=%P", start], workspaceDir)).toBe(earlierStart);
    expect(git(["log", "-1", "--format=%an <%ae>", start], workspaceDir)).toBe("Rainver <rainver@localhost>");
    expect(git(["log", "-1", "--format=%s", start], workspaceDir)).toContain("run-left");
    // The earlier Run's settle answers where its work went.
    expect(await settle("run-left", "task-left")).toEqual({ ok: true, branch: "rainver/task-task-left", commit: start, error: null });
  });

  it("keeps a relaunched Run's own work and start commit instead of treating it as leftovers", async () => {
    const initial = await initRepository(workspaceDir);
    await runTask("run-resume", "launch-r1", "task-resume", "echo one > one.txt && git add one.txt && git commit -q -m 'agent 1' && echo wip > wip.txt");
    const agentCommit = git(["rev-parse", "rainver/task-task-resume"], workspaceDir);
    const second = await runTask("run-resume", "launch-r2", "task-resume", "git status --porcelain; echo two > two.txt");
    expect(second.completeFrame).toMatchObject({ task_worktree: { start_commit: initial } });
    expect(second.output().trim()).toBe("?? wip.txt");
    // Nothing was committed on the Run's behalf.
    expect(git(["rev-parse", "rainver/task-task-resume"], workspaceDir)).toBe(agentCommit);
    const result = await settle("run-resume", "task-resume");
    expect(git(["log", "-1", "--format=%P", result.commit!], workspaceDir)).toBe(initial);
    expect(git(["ls-tree", "--name-only", result.commit!], workspaceDir).split("\n").sort())
      .toEqual([".gitignore", "README.md", "one.txt", "two.txt", "wip.txt"]);
  });

  it("queues a second launch of the same Task, refuses to settle meanwhile, and does not wait for the Location's writer", async () => {
    await initRepository(workspaceDir);
    const first = collect();
    await handleLaunch(taskLaunch("run-q1", "launch-q1", "task-q", "sleep 0.5; echo done > q1.txt"), first.send as never, () => {});
    const second = collect();
    // Reads what the first Run wrote at its very end: only there once it has exited.
    const secondLaunch = handleLaunch(taskLaunch("run-q2", "launch-q2", "task-q", "cat q1.txt"), second.send as never, () => {});
    await waitFor(() => second.frames.some((frame) => frame.type === "waiting_for_workspace"));
    expect(second.frames[0]).toMatchObject({ type: "waiting_for_workspace", run_id: "run-q2", launch_id: "launch-q2" });
    expect(await settle("run-q1", "task-q")).toEqual({ ok: false, branch: null, commit: null, error: TASK_BUSY });
    expect(await deleteTaskBranch({ locationRoot: workspaceDir, locationId: "folder-1", taskId: "task-q" }))
      .toEqual({ ok: false, deleted: false, error: TASK_BUSY });
    // The Location's own writer does not wait for the Task.
    const writer = collect();
    await handleLaunch({ run_id: "run-writer", launch_id: "launch-writer", workspace_location_id: "folder-1", argv: ["true"] }, writer.send as never, () => {});
    expect(writer.frames.some((frame) => frame.type === "waiting_for_workspace")).toBe(false);
    await writer.complete();
    expect(await second.complete()).toMatchObject({ exit_code: 0 });
    await secondLaunch;
    expect(second.output().trim()).toBe("done");
    await first.complete();
  });

  it("deletes the Task's worktree and exactly its branch, idempotently", async () => {
    await initRepository(workspaceDir);
    git(["branch", "rainver/task-task-del-other"], workspaceDir);
    await runTask("run-del", "launch-del", "task-del", "echo x > x.txt");
    expect(await deleteTaskBranch({ locationRoot: workspaceDir, locationId: "folder-1", taskId: "task-del" }))
      .toEqual({ ok: true, deleted: true, error: null });
    expect(existsSync(worktreePath("task-del"))).toBe(false);
    expect(git(["branch", "--list", "rainver/task-task-del"], workspaceDir)).toBe("");
    expect(git(["branch", "--list", "rainver/task-task-del-other"], workspaceDir)).toContain("rainver/task-task-del-other");
    expect(git(["worktree", "list", "--porcelain"], workspaceDir)).not.toContain("task-del\n");
    expect(await deleteTaskBranch({ locationRoot: workspaceDir, locationId: "folder-1", taskId: "task-del" }))
      .toEqual({ ok: true, deleted: false, error: null });
  });

  it("sweeps an old unsettled worktree — leftovers committed, worktree removed and pruned, branch kept — but not a live one", async () => {
    await initRepository(workspaceDir);
    const old = await runTask("run-old", "launch-old", "task-old", "echo stale > stale.txt");
    const oldStart = (old.completeFrame.task_worktree as { start_commit: string }).start_commit;
    // Recent: nothing to sweep yet.
    expect(await sweepTaskWorktrees({ workspaces: { "folder-1": workspaceDir }, workspacesRoot: null })).toBe(0);
    const live = collect();
    await handleLaunch(taskLaunch("run-live", "launch-live", "task-live", "sleep 0.5"), live.send as never, () => {});
    const removed = await sweepTaskWorktrees({ workspaces: { "folder-1": workspaceDir }, workspacesRoot: null, now: Date.now() + 2 * DAY_MS });
    expect(removed).toBe(1);
    expect(existsSync(worktreePath("task-old"))).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], workspaceDir)).not.toContain("task-old");
    const tip = git(["rev-parse", "rainver/task-task-old"], workspaceDir);
    expect(git(["log", "-1", "--format=%an|%P", tip], workspaceDir)).toBe(`Rainver|${oldStart}`);
    expect(git(["show", `${tip}:stale.txt`], workspaceDir)).toBe("stale");
    // The live Task's worktree was left alone.
    expect(existsSync(worktreePath("task-live"))).toBe(true);
    await live.complete();
    // A settle that comes later still squashes from the Run's start, with its own author.
    const settled = await settle("run-old", "task-old");
    expect(git(["log", "-1", "--format=%an|%P", settled.commit!], workspaceDir)).toBe(`Agent Smith|${oldStart}`);
    expect(git(["rev-parse", "rainver/task-task-old"], workspaceDir)).toBe(settled.commit);
  });

  it("leaves a worktree whose Location is no longer registered", async () => {
    await initRepository(workspaceDir);
    await runTask("run-gone", "launch-gone", "task-gone", "echo x > x.txt");
    expect(await sweepTaskWorktrees({ workspaces: {}, workspacesRoot: null, now: Date.now() + 2 * DAY_MS })).toBe(0);
    expect(existsSync(worktreePath("task-gone"))).toBe(true);
  });

  it("gives a launch without a Task worktree none", async () => {
    await initRepository(workspaceDir);
    const run = collect();
    await handleLaunch({
      run_id: "run-ro",
      launch_id: "launch-ro",
      workspace: { kind: "location", workspace_location_id: "folder-1" },
      isolation: { sandbox_mode: "read_only", egress_profile: "none" },
      argv: ["pwd"],
    }, run.send as never, () => {});
    const complete = await run.complete();
    expect(complete.task_worktree).toBeUndefined();
    expect(run.output().trim()).toBe(workspaceDir);
    expect(existsSync(join(configDir, "task-worktrees"))).toBe(false);
  });

  it("runs in place, under the Location's lease, when the Location is not a git checkout", async () => {
    const writer = collect();
    await handleLaunch({ run_id: "plain-writer", launch_id: "plain-writer-1", workspace_location_id: "folder-1", argv: ["sh", "-c", "sleep 0.3"] }, writer.send as never, () => {});
    const task = collect();
    const launch = handleLaunch(taskLaunch("plain-task", "plain-task-1", "task-plain", "pwd"), task.send as never, () => {});
    const complete = await task.complete();
    await launch;
    expect(complete).toMatchObject({ exit_code: 0 });
    expect(complete.task_worktree).toBeUndefined();
    expect(task.frames[0]).toMatchObject({ type: "waiting_for_workspace" });
    expect(task.output().trim()).toBe(workspaceDir);
    await writer.complete();
  });

  it("runs in place when the Location is a subdirectory of its repository, does not own its repository, or has no commit", async () => {
    await initRepository(workspaceDir);
    const sub = join(workspaceDir, "sub");
    await mkdir(sub);
    expect(await checkLocationRepository(sub)).toEqual({ kind: "not_git" });
    const foreign = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-foreign-")));
    try {
      // A `.git` file pointing at another repository.
      await writeFile(join(foreign, ".git"), `gitdir: ${join(workspaceDir, ".git")}\n`);
      expect(await checkLocationRepository(foreign)).toEqual({ kind: "not_git" });
      await rm(join(foreign, ".git"));
      git(["init", "-q"], foreign);
      expect(await checkLocationRepository(foreign)).toEqual({ kind: "no_commit" });
    } finally {
      await rm(foreign, { recursive: true, force: true });
    }
    expect(await checkLocationRepository(workspaceDir)).toEqual({ kind: "repository", repo: { root: workspaceDir, gitCommonDir: join(workspaceDir, ".git") } });
  });

  it("fails the launch, rather than run in the checkout, when git refuses a real checkout", async () => {
    await initRepository(workspaceDir);
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-elsewhere-")));
    try {
      git(["config", "core.worktree", elsewhere], workspaceDir);
      const run = await runTask("run-refused", "launch-refused", "task-refused", "echo ran > ran.txt");
      expect(run.completeFrame).toMatchObject({ exit_code: 1, error: expect.stringMatching(/cannot make a Task worktree/) });
      expect(run.frames.some((frame) => frame.type === "launched")).toBe(false);
      expect(existsSync(join(workspaceDir, "ran.txt"))).toBe(false);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("never runs the repository's hooks while making, reusing or settling the worktree", async () => {
    await initRepository(workspaceDir);
    const marker = join(configDir, "hook-ran");
    for (const hook of ["post-checkout", "pre-commit", "post-commit", "reference-transaction"]) {
      await writeFile(join(workspaceDir, ".git", "hooks", hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    }
    await runTask("run-hook-1", "launch-hook-1", "task-hook", "echo x > x.txt");
    await runTask("run-hook-2", "launch-hook-2", "task-hook", "echo y > y.txt");
    expect((await settle("run-hook-2", "task-hook")).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails the launch rather than run in the checkout when the worktree cannot be made", async () => {
    await initRepository(workspaceDir);
    // The person has the Task branch checked out: git will not check it out twice.
    git(["checkout", "-q", "-b", "rainver/task-task-busy"], workspaceDir);
    const run = await runTask("run-busy", "launch-busy", "task-busy", "echo ran > ran.txt");
    expect(run.completeFrame).toMatchObject({ exit_code: 1, error: expect.stringMatching(/Task's worktree/) });
    expect(run.frames.some((frame) => frame.type === "launched")).toBe(false);
    expect(existsSync(join(workspaceDir, "ran.txt"))).toBe(false);
  });

  it("moves aside, never deletes, a directory at the worktree path that is not a worktree", async () => {
    await initRepository(workspaceDir);
    await mkdir(worktreePath("task-junk"), { recursive: true });
    await writeFile(join(worktreePath("task-junk"), "junk.txt"), "junk\n");
    const run = await runTask("run-junk", "launch-junk", "task-junk", "ls");
    expect(run.completeFrame).toMatchObject({ exit_code: 0 });
    expect(run.output()).not.toContain("junk.txt");
    expect(run.output()).toContain("README.md");
    const quarantine = join(configDir, "task-worktrees-quarantine", "folder-1");
    const [moved] = await readdir(quarantine);
    expect(moved).toMatch(/^task-junk-/);
    expect(await readFile(join(quarantine, moved!, "junk.txt"), "utf8")).toBe("junk\n");
  });

  it("refuses to settle a worktree it no longer recognises instead of settling the branch tip", async () => {
    await initRepository(workspaceDir);
    await runTask("run-broken", "launch-broken", "task-broken", "echo work > work.txt");
    const tip = git(["rev-parse", "rainver/task-task-broken"], workspaceDir);
    // Neither git nor the daemon can tie this directory to its entry any more.
    await writeFile(join(worktreePath("task-broken"), ".git"), "gitdir: /nonexistent/elsewhere\n");
    await rm(join(workspaceDir, ".git", "worktrees", "task-broken"), { recursive: true, force: true });
    const result = await settle("run-broken", "task-broken");
    expect(result).toMatchObject({ ok: false, commit: null, error: expect.stringMatching(/recognises/) });
    expect(git(["rev-parse", "rainver/task-task-broken"], workspaceDir)).toBe(tip);
    expect(await readFile(join(worktreePath("task-broken"), "work.txt"), "utf8")).toBe("work\n");
    // Nor does the sweep remove what it could not commit.
    expect(await sweepTaskWorktrees({ workspaces: { "folder-1": workspaceDir }, workspacesRoot: null, now: Date.now() + 2 * DAY_MS })).toBe(0);
    expect(existsSync(join(worktreePath("task-broken"), "work.txt"))).toBe(true);
  });

  it("recognises a worktree whose .git points at its entry by a relative path", async () => {
    await initRepository(workspaceDir);
    await runTask("run-rel", "launch-rel", "task-rel", "echo rel > rel.txt");
    const entry = join(workspaceDir, ".git", "worktrees", "task-rel");
    await writeFile(join(worktreePath("task-rel"), ".git"), `gitdir: ${relative(worktreePath("task-rel"), entry)}\n`);
    const result = await settle("run-rel", "task-rel");
    expect(result.ok).toBe(true);
    expect(git(["show", `${result.commit!}:rel.txt`], workspaceDir)).toBe("rel");
  });

  it("does not hang on a FIFO planted as the worktree's .git", async () => {
    await initRepository(workspaceDir);
    await runTask("run-fifo", "launch-fifo", "task-fifo", "rm .git && mkfifo .git");
    const result = await settle("run-fifo", "task-fifo");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/recognises/) });
  }, 20_000);

  it("never prunes: planted entries and the person's own stale worktree entries are left alone", async () => {
    await initRepository(workspaceDir);
    // The person's own worktree whose directory is gone: prune would drop its entry.
    const personal = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-personal-")));
    await rm(personal, { recursive: true, force: true });
    git(["worktree", "add", "-q", "--detach", personal], workspaceDir);
    await rm(personal, { recursive: true, force: true });
    const personalEntry = join(workspaceDir, ".git", "worktrees", personal.split("/").pop()!);
    // An entry an Agent planted as a symlink to a directory it wants emptied.
    const target = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-target-")));
    try {
      await writeFile(join(target, "precious.txt"), "keep\n");
      await writeFile(join(target, "gitdir"), "/nonexistent/.git\n");
      await symlink(target, join(workspaceDir, ".git", "worktrees", "planted"));
      await runTask("run-prune", "launch-prune", "task-prune", "echo x > x.txt");
      await runHostCommand({
        request_id: "cmd-prune",
        workspace: { kind: "location", workspace_location_id: "folder-1", worktree: { task_id: "task-prune" } },
        command: ["true"],
        timeout_seconds: 10,
      });
      await runTask("run-prune-2", "launch-prune-2", "task-prune", "true");
      expect((await settle("run-prune-2", "task-prune")).ok).toBe(true);
      await runTask("run-prune-3", "launch-prune-3", "task-prune", "echo y > y.txt");
      await sweepTaskWorktrees({ workspaces: { "folder-1": workspaceDir }, workspacesRoot: null, now: Date.now() + 2 * DAY_MS });
      expect((await deleteTaskBranch({ locationRoot: workspaceDir, locationId: "folder-1", taskId: "task-prune" })).ok).toBe(true);
      expect(await readFile(join(target, "precious.txt"), "utf8")).toBe("keep\n");
      expect(existsSync(personalEntry)).toBe(true);
      expect(existsSync(join(workspaceDir, ".git", "worktrees", "task-prune"))).toBe(false);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("clears a stale index lock and a stale branch lock a killed git left behind, but not a fresh one", async () => {
    await initRepository(workspaceDir);
    await runTask("run-lock", "launch-lock-1", "task-lock", "echo one > one.txt");
    const indexLock = join(workspaceDir, ".git", "worktrees", "task-lock", "index.lock");
    const refLock = join(workspaceDir, ".git", "refs", "heads", "rainver", "task-task-lock.lock");
    const old = new Date(Date.now() - 20 * 60 * 1000);
    // Fresh: may belong to a git still running, so left alone.
    await writeFile(refLock, "");
    expect((await settle("run-lock", "task-lock")).ok).toBe(false);
    expect(existsSync(refLock)).toBe(true);
    await utimes(refLock, old, old);
    await writeFile(indexLock, "");
    await utimes(indexLock, old, old);
    // The same Run again: its Agent's own git works.
    const second = await runTask("run-lock", "launch-lock-2", "task-lock", "git add one.txt && echo staged");
    expect(second.output().trim()).toBe("staged");
    // Dated in the future: no running git's either.
    const future = new Date("2099-01-01T00:00:00Z");
    await writeFile(refLock, "");
    await utimes(refLock, future, future);
    const result = await settle("run-lock", "task-lock");
    expect(result.ok).toBe(true);
    expect(git(["rev-parse", "rainver/task-task-lock"], workspaceDir)).toBe(result.commit);
  });

  it("relinks a worktree whose .git an Agent rewrote, when exactly one entry claims it, and never runs git's repair", async () => {
    await initRepository(workspaceDir);
    // An entry an Agent planted, naming a directory it wants a `.git` written into.
    const victim = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-victim-")));
    try {
      const planted = join(workspaceDir, ".git", "worktrees", "evil");
      await mkdir(planted, { recursive: true });
      await writeFile(join(planted, "gitdir"), `${join(victim, ".git")}\n`);
      await runTask("run-relink", "launch-relink", "task-relink", "echo kept > kept.txt && printf 'gitdir: /elsewhere\\n' > .git");
      const result = await settle("run-relink", "task-relink");
      expect(result.ok).toBe(true);
      expect(git(["show", `${result.commit!}:kept.txt`], workspaceDir)).toBe("kept");
      expect(existsSync(join(victim, ".git"))).toBe(false);
    } finally {
      await rm(victim, { recursive: true, force: true });
    }
  });

  it("treats a worktree two entries claim as unrecognised", async () => {
    await initRepository(workspaceDir);
    await runTask("run-twice", "launch-twice", "task-twice", "echo w > w.txt && printf 'gitdir: /elsewhere\\n' > .git");
    const copy = join(workspaceDir, ".git", "worktrees", "copy");
    await mkdir(copy);
    await writeFile(join(copy, "gitdir"), `${join(worktreePath("task-twice"), ".git")}\n`);
    expect(await settle("run-twice", "task-twice")).toMatchObject({ ok: false, error: expect.stringMatching(/recognises/) });
    expect(existsSync(join(worktreePath("task-twice"), "w.txt"))).toBe(true);
  });

  it("discards an interrupted worktree add instead of committing its missing files as deletions", async () => {
    const initial = await initRepository(workspaceDir);
    await runTask("run-cut", "launch-cut", "task-cut", "true");
    // As if `worktree add` had been killed part-way: the marker is still there
    // and files are missing from the checkout.
    await writeFile(join(configDir, "task-records", "folder-1", "task-cut.creating"), "{}");
    await rm(join(worktreePath("task-cut"), "README.md"));
    await expect(runHostCommand({
      request_id: "cmd-cut",
      workspace: { kind: "location", workspace_location_id: "folder-1", worktree: { task_id: "task-cut" } },
      command: ["true"],
      timeout_seconds: 10,
    })).resolves.toMatchObject({ exit_code: 1, error: expect.stringMatching(/never finished/) });
    const next = await runTask("run-cut-2", "launch-cut-2", "task-cut", "cat README.md");
    expect(next.output().trim()).toBe("hello");
    expect(git(["rev-parse", "rainver/task-task-cut"], workspaceDir)).toBe(initial);
    expect(existsSync(join(configDir, "task-records", "folder-1", "task-cut.creating"))).toBe(false);
  });

  it("fails a verification command in a broken worktree instead of running it in the checkout", async () => {
    await initRepository(workspaceDir);
    await runTask("run-vbroken", "launch-vbroken", "task-vbroken", "printf 'gitdir: /elsewhere\\n' > .git");
    await rm(join(workspaceDir, ".git", "worktrees", "task-vbroken"), { recursive: true, force: true });
    const result = await runHostCommand({
      request_id: "cmd-vbroken",
      workspace: { kind: "location", workspace_location_id: "folder-1", worktree: { task_id: "task-vbroken" } },
      command: ["pwd"],
      timeout_seconds: 10,
    });
    expect(result).toMatchObject({ exit_code: 1, stdout: "", error: expect.stringMatching(/recognises/) });
  });

  it("moves a settled worktree holding a nested repository aside instead of deleting it", async () => {
    await initRepository(workspaceDir);
    await runTask("run-nested", "launch-nested", "task-nested",
      "mkdir nested && cd nested && git init -q && echo inner > inner.txt && git add . && git -c user.name=A -c user.email=a@x -c commit.gpgsign=false commit -q -m n && cd .. && echo top > top.txt");
    const result = await settle("run-nested", "task-nested");
    expect(result.ok).toBe(true);
    expect(git(["show", `${result.commit!}:top.txt`], workspaceDir)).toBe("top");
    expect(existsSync(worktreePath("task-nested"))).toBe(false);
    const quarantine = join(configDir, "task-worktrees-quarantine", "folder-1");
    const [moved] = await readdir(quarantine);
    expect(await readFile(join(quarantine, moved!, "nested", "inner.txt"), "utf8")).toBe("inner\n");
    // Only the nested repository is kept; the rest is on the branch.
    expect(await readdir(join(quarantine, moved!))).toEqual(["nested"]);
  });

  it("deletes a settled worktree's kept nested repositories after 30 days, and never a worktree kept whole", async () => {
    await initRepository(workspaceDir);
    await runTask("run-keep", "launch-keep", "task-keep", "mkdir nested && cd nested && git init -q && echo inner > inner.txt && git add . && git -c user.name=A -c user.email=a@x -c commit.gpgsign=false commit -q -m n && cd .. && echo top > top.txt");
    expect((await settle("run-keep", "task-keep")).ok).toBe(true);
    await runTask("run-whole", "launch-whole", "task-whole", "mkdir empty && git -C empty init -q && echo top > top.txt");
    expect(await settle("run-whole", "task-whole")).toMatchObject({ ok: false });
    const quarantine = join(configDir, "task-worktrees-quarantine", "folder-1");
    const names = await readdir(quarantine);
    const retired = names.filter((name) => name.endsWith("-retired"));
    const whole = names.filter((name) => !name.endsWith("-retired"));
    expect(retired).toHaveLength(1);
    expect(whole).toHaveLength(1);

    const sweep = (days: number) => sweepTaskWorktrees({ workspaces: { "folder-1": workspaceDir }, workspacesRoot: null, now: Date.now() + days * DAY_MS });
    await sweep(29);
    expect((await readdir(quarantine)).sort()).toEqual(names.sort());
    await sweep(31);
    expect(await readdir(quarantine)).toEqual(whole);
  });

  it("keeps only a nested repository in an ignored directory, not the whole worktree", async () => {
    await initRepository(workspaceDir);
    await runTask("run-fetch", "launch-fetch", "task-fetch",
      "echo 'build/' >> .gitignore && mkdir -p build/_deps/dep && git -C build/_deps/dep init -q && echo d > build/_deps/dep/d.txt && echo out > build/out.o && echo top > top.txt");
    const result = await settle("run-fetch", "task-fetch");
    expect(result.ok).toBe(true);
    expect(git(["show", `${result.commit!}:top.txt`], workspaceDir)).toBe("top");
    expect(existsSync(worktreePath("task-fetch"))).toBe(false);
    const quarantine = join(configDir, "task-worktrees-quarantine", "folder-1");
    const [moved] = await readdir(quarantine);
    expect(await readFile(join(quarantine, moved!, "build", "_deps", "dep", "d.txt"), "utf8")).toBe("d\n");
    expect(await readdir(join(quarantine, moved!))).toEqual(["build"]);
    expect(await readdir(join(quarantine, moved!, "build"))).toEqual(["_deps"]);
  });

  it("keeps a submodule's history from the worktree's entry beside the kept submodule", async () => {
    await initRepository(workspaceDir);
    const source = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-sub-")));
    try {
      await initRepository(source);
      const run = await runTask("run-sub", "launch-sub", "task-sub", [
        `git -c protocol.file.allow=always submodule add -q ${source} sub`,
        "cd sub && echo x > x.txt && git add x.txt && git -c user.name=A -c user.email=a@x -c commit.gpgsign=false commit -q -m sub && git rev-parse HEAD",
      ].join(" && "));
      const subCommit = run.output().trim();
      expect(subCommit).toMatch(/^[0-9a-f]{40}$/);
      expect((await settle("run-sub", "task-sub")).ok).toBe(true);
      const quarantine = join(configDir, "task-worktrees-quarantine", "folder-1");
      const names = await readdir(quarantine);
      const modules = names.find((name) => name.endsWith(".git-modules"));
      expect(modules).toBeTruthy();
      expect(names).toContain(modules!.slice(0, -".git-modules".length));
      // Its own config still names the old checkout (`core.worktree`), hence `--work-tree`.
      expect(git(["--git-dir", join(quarantine, modules!, "sub"), "--work-tree", tmpdir(), "cat-file", "-t", subCommit], workspaceDir)).toBe("commit");
      expect(existsSync(join(workspaceDir, ".git", "worktrees", "task-sub"))).toBe(false);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("does not recognise a worktree whose entry names another repository as its common directory", async () => {
    await initRepository(workspaceDir);
    const other = await realpath(await mkdtemp(join(tmpdir(), "rainver-task-wt-otherrepo-")));
    try {
      await initRepository(other);
      await runTask("run-common", "launch-common", "task-common", "echo w > w.txt");
      await writeFile(join(workspaceDir, ".git", "worktrees", "task-common", "commondir"), `${join(other, ".git")}\n`);
      expect(await settle("run-common", "task-common")).toMatchObject({ ok: false, error: expect.stringMatching(/recognises/) });
      // The next Run is not stuck on it: the directory is moved aside.
      const next = await runTask("run-common-2", "launch-common-2", "task-common", "ls");
      expect(next.completeFrame).toMatchObject({ exit_code: 0 });
      expect(next.output()).not.toContain("w.txt");
      expect(git(["rev-list", "--all", "--count"], other)).toBe("1");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("is not misled by a worktree entry whose path carries a newline", async () => {
    await initRepository(workspaceDir);
    const planted = join(workspaceDir, ".git", "worktrees", "inj");
    await mkdir(planted, { recursive: true });
    await writeFile(join(planted, "gitdir"), "/x\nbranch refs/heads/rainver/task-task-inj\n/.git\n");
    const run = await runTask("run-inj", "launch-inj", "task-inj", "true");
    expect(run.completeFrame).toMatchObject({ exit_code: 0, task_worktree: { branch: "rainver/task-task-inj" } });
  });

  it("moves aside a worktree git cannot capture, answers once with the reason, and lets the Task go on", async () => {
    const initial = await initRepository(workspaceDir);
    await runTask("run-uncap", "launch-uncap", "task-uncap", "mkdir empty && git -C empty init -q && echo top > top.txt");
    const first = await settle("run-uncap", "task-uncap");
    expect(first).toMatchObject({ ok: false, error: expect.stringMatching(/could not capture/) });
    expect(existsSync(worktreePath("task-uncap"))).toBe(false);
    const quarantine = join(configDir, "task-worktrees-quarantine", "folder-1");
    const [moved] = await readdir(quarantine);
    expect(await readFile(join(quarantine, moved!, "top.txt"), "utf8")).toBe("top\n");
    // A retry settles what the branch holds.
    expect(await settle("run-uncap", "task-uncap")).toEqual({ ok: true, branch: "rainver/task-task-uncap", commit: null, error: null });
    const next = await runTask("run-uncap-2", "launch-uncap-2", "task-uncap", "ls");
    expect(next.completeFrame).toMatchObject({ exit_code: 0, task_worktree: { start_commit: initial } });
  });

  it("launches past an uncapturable unsettled worktree by moving it aside", async () => {
    await initRepository(workspaceDir);
    await runTask("run-uncap-a", "launch-uncap-a", "task-uncap-b", "mkdir empty && git -C empty init -q");
    const next = await runTask("run-uncap-b", "launch-uncap-b", "task-uncap-b", "ls");
    expect(next.completeFrame).toMatchObject({ exit_code: 0 });
    expect(next.output()).not.toContain("empty");
  });

  it("answers a settle ok even when the settled worktree cannot be deleted", async () => {
    await initRepository(workspaceDir);
    await runTask("run-ro", "launch-ro", "task-ro", "mkdir -p cache/mod && echo m > cache/mod/f && chmod a-w cache/mod && echo done > done.txt");
    const result = await settle("run-ro", "task-ro");
    expect(result.ok).toBe(true);
    expect(git(["show", `${result.commit!}:done.txt`], workspaceDir)).toBe("done");
    expect(existsSync(worktreePath("task-ro"))).toBe(false);
    expect(await readdir(join(configDir, "task-worktrees-quarantine", "folder-1"))).toHaveLength(1);
  });

  it("waits for a verification command running in the Task's worktree before launching into it", async () => {
    await initRepository(workspaceDir);
    await runTask("run-wait", "launch-wait-1", "task-wait", "true");
    const order: string[] = [];
    const command = runHostCommand({
      request_id: "cmd-wait",
      workspace: { kind: "location", workspace_location_id: "folder-1", worktree: { task_id: "task-wait" } },
      command: ["sh", "-c", "sleep 0.5"],
      timeout_seconds: 10,
    }).then((result) => { order.push("command-done"); return result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const run = collect();
    await handleLaunch(taskLaunch("run-wait", "launch-wait-2", "task-wait", "true"), ((frame: Record<string, unknown>) => {
      order.push(String(frame.type));
      run.send(frame);
    }) as never, () => {});
    await run.complete();
    expect((await command).exit_code).toBe(0);
    expect(order.indexOf("waiting_for_workspace")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("launched")).toBeGreaterThan(order.indexOf("command-done"));
  });

  it("settles a retried Run anew, from its original start, replacing the earlier attempt's commit", async () => {
    const initial = await initRepository(workspaceDir);
    await runTask("run-retry", "launch-retry-1", "task-retry", "echo one > one.txt");
    const first = await settle("run-retry", "task-retry");
    expect(first.commit).toBeTruthy();
    // The supervisor retries the same run id.
    const again = await runTask("run-retry", "launch-retry-2", "task-retry", "cat one.txt; echo two > two.txt");
    expect(again.completeFrame).toMatchObject({ task_worktree: { start_commit: initial } });
    expect(again.output().trim()).toBe("one");
    await waitFor(() => String(diffs.get("run-retry")?.diff).includes("two.txt"));
    expect(String(diffs.get("run-retry")?.diff)).toContain("one.txt");
    const second = await settle("run-retry", "task-retry", { message: "second attempt" });
    expect(second.ok).toBe(true);
    expect(second.commit).not.toBe(first.commit);
    expect(git(["log", "-1", "--format=%P|%s", second.commit!], workspaceDir)).toBe(`${initial}|second attempt`);
    expect(git(["ls-tree", "--name-only", second.commit!], workspaceDir).split("\n").sort())
      .toEqual([".gitignore", "README.md", "one.txt", "two.txt"]);
    expect(git(["rev-parse", "rainver/task-task-retry"], workspaceDir)).toBe(second.commit);
    // And that answer is what a repeat gets now.
    expect(await settle("run-retry", "task-retry")).toEqual(second);
  });

  it("starts a retried Run from the tip when something else landed on the branch after its settle", async () => {
    await initRepository(workspaceDir);
    await runTask("run-r1", "launch-r1-1", "task-landed", "echo one > one.txt");
    await settle("run-r1", "task-landed");
    await runTask("run-r2", "launch-r2-1", "task-landed", "echo two > two.txt");
    const second = await settle("run-r2", "task-landed");
    const again = await runTask("run-r1", "launch-r1-2", "task-landed", "true");
    expect(again.completeFrame).toMatchObject({ task_worktree: { start_commit: second.commit } });
  });

  it("runs a verification command in the Task's worktree, or in the Location when the Task has none", async () => {
    await initRepository(workspaceDir);
    await runTask("run-verify", "launch-verify", "task-verify", "echo built > built.txt");
    const inWorktree = await runHostCommand({
      request_id: "cmd-1",
      workspace: { kind: "location", workspace_location_id: "folder-1", worktree: { task_id: "task-verify" } },
      run_id: "run-verify",
      command: ["sh", "-c", "pwd; cat built.txt"],
      timeout_seconds: 10,
    });
    expect(inWorktree).toMatchObject({ exit_code: 0, error: null });
    expect(inWorktree.stdout.trim().split("\n")).toEqual([worktreePath("task-verify"), "built"]);
    const noWorktree = await runHostCommand({
      request_id: "cmd-2",
      workspace: { kind: "location", workspace_location_id: "folder-1", worktree: { task_id: "task-none" } },
      command: ["pwd"],
      timeout_seconds: 10,
    });
    expect(noWorktree.stdout.trim()).toBe(workspaceDir);
  });
});
