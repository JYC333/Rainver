import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkspaceDiff, captureWorkspaceTree } from "../src/gitDiff.js";

let dir: string;

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} exited ${code}`))));
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rainver-host-gitdiff-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("captureWorkspaceDiff", () => {
  it("returns null outside a git repository", async () => {
    expect(await captureWorkspaceDiff(dir)).toBeNull();
  });

  it("captures a modification to a tracked file", async () => {
    await git(["init", "-q"], dir);
    await git(["config", "user.email", "test@example.com"], dir);
    await git(["config", "user.name", "Test"], dir);
    await writeFile(join(dir, "a.txt"), "original\n");
    await git(["add", "a.txt"], dir);
    await git(["commit", "-q", "-m", "initial"], dir);

    await writeFile(join(dir, "a.txt"), "changed\n");
    const diff = await captureWorkspaceDiff(dir);
    expect(diff).toContain("-original");
    expect(diff).toContain("+changed");
  });

  it("includes a new untracked file's content via intent-to-add, and leaves it untracked afterward", async () => {
    await git(["init", "-q"], dir);
    await git(["config", "user.email", "test@example.com"], dir);
    await git(["config", "user.name", "Test"], dir);
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await git(["add", "seed.txt"], dir);
    await git(["commit", "-q", "-m", "initial"], dir);

    await writeFile(join(dir, "new.txt"), "brand new content\n");
    const diff = await captureWorkspaceDiff(dir);
    expect(diff).toContain("new.txt");
    expect(diff).toContain("+brand new content");

    const status = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["status", "--porcelain"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", () => resolve(stdout));
    });
    expect(status.trim()).toBe("?? new.txt");
    expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("brand new content\n");
  });

  it("does not fail on a repository with no commits yet", async () => {
    await git(["init", "-q"], dir);
    await git(["config", "user.email", "test@example.com"], dir);
    await git(["config", "user.name", "Test"], dir);
    await writeFile(join(dir, "only.txt"), "hello\n");
    const diff = await captureWorkspaceDiff(dir);
    expect(diff).toContain("only.txt");
  });
});

function gitStdout(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
}

async function committedRepo(): Promise<void> {
  await git(["init", "-q"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  await git(["config", "user.name", "Test"], dir);
  await writeFile(join(dir, "a.txt"), "original\n");
  await git(["add", "a.txt"], dir);
  await git(["commit", "-q", "-m", "initial"], dir);
}

describe("captureWorkspaceDiff against a Run baseline", () => {
  it("reports only what changed after the baseline, not every uncommitted edit in the directory", async () => {
    await committedRepo();
    // An earlier Agent's (or the person's) uncommitted edit, present before this Run.
    await writeFile(join(dir, "a.txt"), "changed before the run\n");
    await writeFile(join(dir, "earlier.txt"), "left by an earlier run\n");
    const baseline = await captureWorkspaceTree(dir);
    expect(baseline).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(dir, "mine.txt"), "written by this run\n");
    await writeFile(join(dir, "earlier.txt"), "left by an earlier run\nand touched by this one\n");
    const diff = await captureWorkspaceDiff(dir, baseline);
    expect(diff).toContain("mine.txt");
    expect(diff).toContain("+written by this run");
    expect(diff).toContain("+and touched by this one");
    expect(diff).not.toContain("changed before the run");
    expect(diff).not.toContain("a.txt");
    expect(diff).not.toContain("+left by an earlier run");
  });

  it("returns an empty diff when the Run changed nothing, whatever the directory already held", async () => {
    await committedRepo();
    await writeFile(join(dir, "a.txt"), "dirty before\n");
    const baseline = await captureWorkspaceTree(dir);
    expect(await captureWorkspaceDiff(dir, baseline)).toBe("");
    // Without a baseline the old shape — every uncommitted change — is all it can report.
    expect(await captureWorkspaceDiff(dir, null)).toContain("+dirty before");
  });

  it("leaves the repository's own index alone: what the person staged stays staged", async () => {
    await committedRepo();
    await writeFile(join(dir, "staged.txt"), "the person staged this\n");
    await git(["add", "staged.txt"], dir);
    await writeFile(join(dir, "a.txt"), "staged edit\n");
    await git(["add", "a.txt"], dir);
    const stagedBefore = await gitStdout(["diff", "--cached", "--name-only"], dir);

    const baseline = await captureWorkspaceTree(dir);
    await writeFile(join(dir, "unstaged.txt"), "run output\n");
    const diff = await captureWorkspaceDiff(dir, baseline);
    expect(diff).toContain("unstaged.txt");

    expect(await gitStdout(["diff", "--cached", "--name-only"], dir)).toBe(stagedBefore);
    expect(stagedBefore.trim().split("\n").sort()).toEqual(["a.txt", "staged.txt"]);
    expect((await gitStdout(["status", "--porcelain"], dir)).trim().split("\n").sort()).toEqual([
      "?? unstaged.txt",
      "A  staged.txt",
      "M  a.txt",
    ]);
  });

  it("captures a tree for a repository with no commits yet", async () => {
    await git(["init", "-q"], dir);
    await writeFile(join(dir, "only.txt"), "hello\n");
    const baseline = await captureWorkspaceTree(dir);
    expect(baseline).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(dir, "second.txt"), "later\n");
    const diff = await captureWorkspaceDiff(dir, baseline);
    expect(diff).toContain("second.txt");
    expect(diff).not.toContain("only.txt");
  });
});
