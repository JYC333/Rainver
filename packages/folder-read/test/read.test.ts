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

  it("admits only strict UTF-8 for editing and reports exact text metadata", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\r\n") ]));
    await writeFile(join(root, "mixed.txt"), "one\r\ntwo\nthree\r", "utf8");
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(root, "binary.dat"), Buffer.from([0x00, 0xff, 0x01]));
    await writeFile(join(root, "nul.dat"), Buffer.from([0x61, 0x00, 0x62]));

    await expect(readFolderFile(root, "bom.txt")).resolves.toMatchObject({
      content: "one\r\ntwo\r\n",
      encoding: "utf8",
      has_bom: true,
      line_ending_mode: "crlf",
      writable: true,
      conversion_available: false,
    });
    await expect(readFolderFile(root, "mixed.txt")).resolves.toMatchObject({
      encoding: "utf8",
      line_ending_mode: "mixed",
      writable: true,
    });
    await expect(readFolderFile(root, "invalid.txt")).resolves.toMatchObject({
      content: "",
      encoding: "unknown",
      writable: false,
      conversion_available: false,
    });
    await expect(readFolderFile(root, "binary.dat")).resolves.toMatchObject({
      content: "",
      encoding: "binary",
      writable: false,
    });
    await expect(readFolderFile(root, "nul.dat")).resolves.toMatchObject({
      content: "",
      encoding: "binary",
      writable: false,
      conversion_available: false,
    });
  });

  it("recognises BOM-marked UTF-16 and exposes content only for conversion preview", async () => {
    const root = await tempRoot();
    const text = "one\r\ntwo\n";
    const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const bigEndianBody = Buffer.from(text, "utf16le");
    for (let index = 0; index < bigEndianBody.length; index += 2) {
      const first = bigEndianBody[index]!;
      bigEndianBody[index] = bigEndianBody[index + 1]!;
      bigEndianBody[index + 1] = first;
    }
    await writeFile(join(root, "little.txt"), littleEndian);
    await writeFile(join(root, "big.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBody]));

    await expect(readFolderFile(root, "little.txt")).resolves.toMatchObject({
      content: "",
      encoding: "utf16le",
      has_bom: true,
      writable: false,
      conversion_available: true,
    });
    await expect(readFolderFile(root, "little.txt", { includeUtf16Preview: true })).resolves.toMatchObject({ content: text });
    await expect(readFolderFile(root, "big.txt", { includeUtf16Preview: true })).resolves.toMatchObject({
      content: text,
      encoding: "utf16be",
      writable: false,
    });
  });

  it("keeps malformed and NUL-containing UTF-16 read-only without a conversion option", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "truncated.txt"), Buffer.from([0xff, 0xfe, 0x61]));
    await writeFile(join(root, "nul.txt"), Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x00, 0x00]));

    await expect(readFolderFile(root, "truncated.txt", { includeUtf16Preview: true }))
      .resolves.toMatchObject({ content: "", encoding: "unknown", writable: false, conversion_available: false });
    await expect(readFolderFile(root, "nul.txt", { includeUtf16Preview: true }))
      .resolves.toMatchObject({ content: "", encoding: "binary", writable: false, conversion_available: false });
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

  it("refuses NUL-containing files even when their bytes are valid UTF-8", async () => {
    const root = await tempRoot();
    const bytes = Buffer.from("before\0after", "utf8");
    await writeFile(join(root, "nul.dat"), bytes);
    await expect(writeFolderFile(root, "nul.dat", "replacement", {
      expectedExists: true,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    })).rejects.toMatchObject({ code: "not_text" });
    await expect(readFile(join(root, "nul.dat"))).resolves.toEqual(bytes);
    await expect(writeFolderFile(root, "new.dat", "a\0b", {
      expectedExists: false,
      expectedSha256: null,
    })).rejects.toMatchObject({ code: "not_text" });
    await expect(readFile(join(root, "new.dat"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converts valid BOM-marked UTF-16 only when explicit and restores its original encoding", async () => {
    const root = await tempRoot();
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("before\r\n", "utf16le")]);
    const path = join(root, "utf16.txt");
    await writeFile(path, original);
    const expectedSha256 = createHash("sha256").update(original).digest("hex");

    await expect(writeFolderFile(root, "utf16.txt", "after\n", {
      expectedExists: true,
      expectedSha256,
    })).rejects.toMatchObject({ code: "not_text" });
    const converted = await writeFolderFile(root, "utf16.txt", "after\n", {
      expectedExists: true,
      expectedSha256,
      allowEncodingConversion: true,
    });
    expect(converted.before).toMatchObject({ content: "before\r\n", sha256: expectedSha256 });

    await restoreFolderFile(root, "utf16.txt", "before\r\n", {
      expectedExists: true,
      expectedSha256: converted.sha256,
      restoreEncoding: "utf16le",
    });
    await expect(readFile(path)).resolves.toEqual(original);
  });
});
