import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTree,
  FolderReadError,
  folderGitDiff,
  readFolderFile,
  resolveRelativePath,
  runGit,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-"));
  roots.push(root);
  return root;
}

describe("folder-read filesystem operations", () => {
  it("builds a bounded tree and reads utf8 files", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "README.md"), "one\ntwo\n", "utf8");
    await writeFile(join(root, "src", "main.ts"), "export {};\n", "utf8");
    await writeFile(join(root, ".env"), "secret", "utf8");

    const tree = await buildTree(root);
    expect(tree.type).toBe("dir");
    expect(tree.children?.map((child) => child.path)).toEqual(["src", "README.md"]);
    await expect(readFolderFile(root, "README.md")).resolves.toMatchObject({
      path: "README.md",
      content: "one\ntwo\n",
      line_count: 3,
    });
  });

  it("maps missing, directory, forbidden, and oversized reads to bounded errors", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "[core]\n", "utf8");
    await writeFile(join(root, "large.txt"), "x".repeat(1_048_577), "utf8");

    await expect(readFolderFile(root, "missing.txt")).rejects.toMatchObject({ code: "not_found" });
    await expect(readFolderFile(root, ".")).rejects.toMatchObject({ code: "is_directory" });
    await expect(readFolderFile(root, ".git/config", { protectedFolder: true }))
      .rejects.toThrow(/forbidden/);
    await expect(readFolderFile(root, "large.txt")).rejects.toMatchObject({ code: "too_large" });
  });

  it("does not follow symlinks outside the registered root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "secret.txt"), "outside-secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
    await expect(readFolderFile(root, "linked.txt")).rejects.toThrow(/escapes/);
    await writeFile(join(root, ".env"), "inside-secret", "utf8");
    await symlink(join(root, ".env"), join(root, "public.txt"));
    await expect(readFolderFile(root, "public.txt")).rejects.toThrow(/forbidden/);
    const tree = await buildTree(root);
    expect(tree.children).toEqual([]);
  });

  it("normalizes a relative path without escaping the root", async () => {
    const root = await tempRoot();
    expect(resolveRelativePath(root, "src/../README.md").relative).toBe("README.md");
    expect(resolveRelativePath(root, ".").relative).toBe("");
    expect(() => resolveRelativePath(root, "../outside.txt")).toThrow(/Path traversal denied/);
  });

  it("redacts and bounds a diff", async () => {
    const root = await tempRoot();
    const gitDir = join(root, ".git");
    await mkdir(gitDir);
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    await runGit(["init"], root);
    await runGit(["config", "user.email", "test@example.invalid"], root);
    await runGit(["config", "user.name", "Test"], root);
    await runGit(["add", "README.md"], root);
    await runGit(["commit", "-m", "initial"], root);
    await writeFile(join(root, "README.md"), "before\napi_key=raw-secret\n", "utf8");

    await expect(folderGitDiff(root, "README.md")).resolves.toMatchObject({
      path: "README.md",
      redacted: true,
      diff: expect.stringContaining("api_key=[REDACTED]"),
    });
    await expect(folderGitDiff(root, ".")).resolves.toMatchObject({ diff: "", path: "" });

    await writeFile(join(root, "large.txt"), "a".repeat(600_000), "utf8");
    await runGit(["add", "large.txt"], root);
    await runGit(["commit", "-m", "large"], root);
    await writeFile(join(root, "large.txt"), "b".repeat(600_000), "utf8");
    await expect(folderGitDiff(root, "large.txt")).resolves.toMatchObject({ truncated: true });

    await writeFile(join(root, ".env.local"), "old", "utf8");
    await runGit(["add", ".env.local"], root);
    await runGit(["commit", "-m", "env"], root);
    await writeFile(join(root, ".env.local"), "new", "utf8");
    await expect(folderGitDiff(root, null)).rejects.toThrow(/blocked path/);
    expect(await readFile(join(root, "README.md"), "utf8")).toContain("raw-secret");
  });

  it("exposes typed folder read errors", () => {
    expect(new FolderReadError("too_large", "too big")).toBeInstanceOf(Error);
  });
});
