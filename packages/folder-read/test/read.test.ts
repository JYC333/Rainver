import { createHash } from "node:crypto";
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
  restoreFolderFile,
  runGit,
  writeFolderFile,
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
      sha256: createHash("sha256").update("one\ntwo\n").digest("hex"),
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

  it("writes atomically, captures the preimage, and restores an empty file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "README.md"), "before", "utf8");
    const written = await writeFolderFile(root, "README.md", "after", {
      expectedExists: true,
      expectedSha256: createHash("sha256").update("before").digest("hex"),
    });
    expect(written.before).toMatchObject({ exists: true, content: "before" });
    expect(written.content).toBe("after");
    await restoreFolderFile(root, "README.md", "", {
      expectedExists: true,
      expectedSha256: createHash("sha256").update("after").digest("hex"),
    });
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe("");
  });

  it("rejects stale writes, permits user script writes, and keeps secrets blocked", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "run.sh"), "old", "utf8");
    await expect(writeFolderFile(root, "run.sh", "new", {
      expectedExists: true,
      expectedSha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "stale" });
    await expect(writeFolderFile(root, "run.sh", "new", {
      expectedExists: true,
      expectedSha256: createHash("sha256").update("old").digest("hex"),
    })).resolves.toMatchObject({ content: "new" });
    await expect(writeFolderFile(root, ".env.local", "secret", {
      expectedExists: false,
      expectedSha256: null,
    })).rejects.toMatchObject({ code: "path_forbidden" });
  });

  it("serializes concurrent writes that share the same preimage", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "README.md"), "before", "utf8");
    const expectedSha256 = createHash("sha256").update("before").digest("hex");
    const results = await Promise.allSettled([
      writeFolderFile(root, "README.md", "first", { expectedExists: true, expectedSha256 }),
      writeFolderFile(root, "README.md", "second", { expectedExists: true, expectedSha256 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "stale" });
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toMatch(/^(first|second)$/);
  });

  it("refuses to rewrite a non-UTF-8 file as text", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "binary.dat"), Buffer.from([0xff, 0xfe, 0x00]));
    await expect(writeFolderFile(root, "binary.dat", "text", {
      expectedExists: true,
      expectedSha256: createHash("sha256").update(Buffer.from([0xff, 0xfe, 0x00])).digest("hex"),
    })).rejects.toMatchObject({ code: "not_text" });
  });
});
