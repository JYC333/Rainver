import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkspaceDiff } from "../src/gitDiff.js";

let dir: string;

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} exited ${code}`))));
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-space-host-gitdiff-"));
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
