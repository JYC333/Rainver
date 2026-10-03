import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectWorkspaceStatus } from "../src/workspaceStatus.js";

let dir: string;

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} exited ${code}`))));
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rainver-host-workspace-status-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectWorkspaceStatus", () => {
  it("reports a checkout's branch, head and clean or dirty work tree", async () => {
    await git(["init", "-q", "-b", "main"], dir);
    await git(["config", "user.email", "test@example.com"], dir);
    await git(["config", "user.name", "Test"], dir);
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(["add", "a.txt"], dir);
    await git(["commit", "-q", "-m", "initial"], dir);

    const [clean] = await collectWorkspaceStatus({ loc: dir });
    expect(clean).toMatchObject({ location_id: "loc", branch: "main", dirty: false, execution_ready: true });
    expect(clean?.git_head).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(dir, "a.txt"), "two\n");
    const [dirty] = await collectWorkspaceStatus({ loc: dir });
    expect(dirty?.dirty).toBe(true);
  });

  it("says the work tree's state is unknown, not clean, when git status itself fails", async () => {
    await git(["init", "-q", "-b", "main"], dir);
    await git(["config", "user.email", "test@example.com"], dir);
    await git(["config", "user.name", "Test"], dir);
    await writeFile(join(dir, "a.txt"), "one\n");
    await git(["add", "a.txt"], dir);
    await git(["commit", "-q", "-m", "initial"], dir);
    await writeFile(join(dir, "a.txt"), "two\n");
    // `git status` cannot open an index that is a directory; rev-parse (the
    // repository check, the branch, the head) does not need the index and
    // still answers. `null` is the report's word for "could not tell".
    await rm(join(dir, ".git", "index"));
    await mkdir(join(dir, ".git", "index"));

    const [report] = await collectWorkspaceStatus({ loc: dir });
    expect(report).toMatchObject({ branch: "main", dirty: null, execution_ready: true });
  });
});
