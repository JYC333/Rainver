import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  __codePatchTestHooks,
  collectWorktreeChanges,
} from "../src/modules/projectFolders/codePatch.js";

const execFileAsync = promisify(execFile);
const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-patch-"));
  tmpRoots.push(root);
  return root;
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("code patch workspace collection", () => {
  it("reports git command failures as collection errors instead of no changes", async () => {
    const root = await tmpRoot();

    const collected = await collectWorktreeChanges(root, null);

    expect(collected.operations).toEqual([]);
    expect(collected.skipped).toHaveLength(1);
    expect(collected.skipped[0]).toMatchObject({
      path: ".",
      status: expect.any(String),
    });
    expect(collected.skipped[0]!.reason).toContain("git_diff_failed");
  });

  it("collects skipped changes as structured entries", async () => {
    const root = await tmpRoot();
    await git(root, ["init"]);
    await writeFile(join(root, "kept.txt"), "old\n", "utf8");
    await writeFile(join(root, "deleted.txt"), "delete me\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    await rm(join(root, "deleted.txt"));
    await writeFile(join(root, "kept.txt"), "new\n", "utf8");

    const collected = await collectWorktreeChanges(root, null);

    expect(collected.operations).toMatchObject([
      {
        type: "replace_file",
        path: "kept.txt",
        content: "new\n",
        preimage_exists: true,
        preimage_sha256: sha256("old\n"),
      },
    ]);
    expect(collected.skipped).toEqual([
      { path: "deleted.txt", status: "D", reason: "deleted" },
    ]);
  });
});

describe("code patch file transaction", () => {
  it("rolls back already-written files when a later operation fails", async () => {
    const root = await tmpRoot();
    await writeFile(join(root, "a.txt"), "old a\n", "utf8");
    await writeFile(join(root, "b.txt"), "old b\n", "utf8");
    const tx = new __codePatchTestHooks.CodePatchFileTransaction(root, false);

    await expect(tx.apply([
      {
        type: "replace_file",
        path: "a.txt",
        content: "new a\n",
        preimage_exists: true,
        preimage_sha256: sha256("old a\n"),
      },
      {
        type: "replace_file",
        path: "b.txt",
        content: "new b\n",
        preimage_exists: true,
        preimage_sha256: sha256("stale b\n"),
      },
    ])).rejects.toThrow(/preimage mismatch/);

    await tx.rollback();

    await expect(readFile(join(root, "a.txt"), "utf8")).resolves.toBe("old a\n");
    await expect(readFile(join(root, "b.txt"), "utf8")).resolves.toBe("old b\n");
  });
});
