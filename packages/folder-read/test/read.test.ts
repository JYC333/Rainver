import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTree,
  listFolderDirectory,
  MAX_FILES,
  FolderReadError,
  folderGitDiff,
  MAX_FILE_BYTES,
  openFileBeneathRoot,
  readFolderFile,
  resolveRelativePath,
  restoreFolderFile,
  runGit,
  writeFolderFile,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
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
  it("returns exact binary and BOM bytes only when original-byte acquisition is requested", async () => {
    const root = await tempRoot();
    for (const [name, bytes] of [["SKILL.md", Buffer.from("\ufeff# Skill\r\n")], ["asset.bin", Buffer.from([0, 255, 128])]] as const) {
      await writeFile(join(root, name), bytes);
      const preview = await readFolderFile(root, name);
      expect(preview.content_base64).toBeUndefined();
      const original = await readFolderFile(root, name, { includeOriginalBytes: true });
      expect(Buffer.from(original.content_base64!, "base64")).toEqual(bytes);
      expect(original.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
  it("lists dot directories and root files without consuming a nested tree's budget", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".agent", "deep"), { recursive: true });
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".editorconfig"), "root = true");
    await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=secret");
    await writeFile(join(root, ".env"), "secret");
    await writeFile(join(root, "private.key"), "secret");
    await writeFile(join(root, "README.md"), "readme");
    await Promise.all(Array.from({ length: MAX_FILES + 1 }, (_, i) => writeFile(join(root, ".agent", `file-${i}.md`), "x")));
    const tree = await listFolderDirectory(root);
    expect(tree.children?.map(child => child.name)).toEqual([".agent", ".editorconfig", "README.md"]);
    expect(tree.children?.[0]?.children).toBeUndefined();
    expect(tree.next_offset).toBeUndefined();
    const first = await listFolderDirectory(root, ".agent");
    expect(first.children).toHaveLength(MAX_FILES);
    const second = await listFolderDirectory(root, ".agent", { offset: first.next_offset });
    expect(second.children).toHaveLength(2);
    expect(second.next_offset).toBeUndefined();
    expect(new Set([...first.children!, ...second.children!].map(child => child.path)).size).toBe(MAX_FILES + 2);
  });

  it("refuses directory traversal, sensitive directories and linked ancestors", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "docs", "deep"), { recursive: true });
    await symlink(join(root, "docs"), join(root, "alias"));
    await expect(listFolderDirectory(root, "../outside")).rejects.toThrow(/traversal/i);
    await expect(listFolderDirectory(root, ".ssh")).rejects.toThrow(/forbidden/i);
    await expect(listFolderDirectory(root, "alias/deep")).rejects.toMatchObject({ code: "path_forbidden" });
    await expect(listFolderDirectory(root, ".git")).rejects.toThrow(/excluded/);
  });

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

  // Root may stat anything, so a permission the test relies on does not apply to it.
  it.skipIf(process.getuid?.() === 0)("leaves out an entry it cannot stat instead of failing the whole tree", async () => {
    // readdir lists a directory's names with read permission alone; stat of a
    // name inside it needs search permission. An entry that vanishes between
    // the two calls (an editor's or a Run's temporary file) looks the same to
    // the walk as this one does. Leave it out. Do not fail the whole tree.
    const root = await tempRoot();
    await mkdir(join(root, "ok"));
    await writeFile(join(root, "ok", "kept.txt"), "kept", "utf8");
    await mkdir(join(root, "locked"));
    await writeFile(join(root, "locked", "unreachable.txt"), "x", "utf8");
    await chmod(join(root, "locked"), 0o400);
    try {
      const tree = await buildTree(root);
      expect(tree.children?.map((child) => child.path)).toEqual(["locked", "ok"]);
      expect(tree.children?.find((child) => child.path === "locked")?.children).toEqual([]);
      expect(tree.children?.find((child) => child.path === "ok")?.children?.map((child) => child.path)).toEqual(["ok/kept.txt"]);
    } finally {
      await chmod(join(root, "locked"), 0o700);
    }
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

  it("refuses any symbolic link below the root, final or ancestor, inside or outside", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "secret.txt"), "outside-secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
    await expect(readFolderFile(root, "linked.txt")).rejects.toMatchObject({ code: "path_forbidden" });
    await writeFile(join(root, ".env"), "inside-secret", "utf8");
    await symlink(join(root, ".env"), join(root, "public.txt"));
    await expect(readFolderFile(root, "public.txt")).rejects.toMatchObject({ code: "path_forbidden" });
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "ok.md"), "fine", "utf8");
    await symlink(join(root, "docs"), join(root, "inside-dir"));
    await expect(readFolderFile(root, "inside-dir/ok.md")).rejects.toMatchObject({ code: "path_forbidden" });
    await symlink(outside, join(root, "outside-dir"));
    await expect(readFolderFile(root, "outside-dir/secret.txt")).rejects.toMatchObject({ code: "path_forbidden" });
    await expect(readFolderFile(root, "docs/ok.md")).resolves.toMatchObject({ content: "fine" });
    const tree = await buildTree(root);
    expect(tree.children?.map((child) => child.path)).toEqual(["docs"]);
  });

  it("opens through a root that is itself reached through a link", async () => {
    const real = await tempRoot();
    const holder = await tempRoot();
    await writeFile(join(real, "a.txt"), "via-link", "utf8");
    await symlink(real, join(holder, "root-link"));
    await expect(readFolderFile(join(holder, "root-link"), "a.txt")).resolves.toMatchObject({ content: "via-link" });
  });

  it("reads from the handle it opened, whatever the path becomes afterwards", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "f.txt"), "original", "utf8");
    await writeFile(join(outside, "f.txt"), "outside", "utf8");
    const handle = await openFileBeneathRoot(root, ["a", "f.txt"]);
    try {
      // Ancestor replaced by a link to the outside, and the final name too.
      await rename(join(root, "a"), join(root, "a.moved"));
      await symlink(outside, join(root, "a"));
      const bytes = await handle.readFile();
      expect(bytes.toString("utf8")).toBe("original");
    } finally {
      await handle.close();
    }
    await expect(readFolderFile(root, "a/f.txt")).rejects.toMatchObject({ code: "path_forbidden" });
    await expect(readFolderFile(root, "a.moved/f.txt")).resolves.toMatchObject({ content: "original" });
  });

  it.skipIf(process.platform !== "linux")("refuses FIFOs and device nodes without blocking, and leaks no descriptors", async () => {
    const root = await tempRoot();
    await execFileAsync("mkfifo", [join(root, "pipe")]);
    await symlink("/dev/null", join(root, "null-link"));
    const before = (await readdir("/proc/self/fd")).length;
    await expect(readFolderFile(root, "pipe")).rejects.toMatchObject({ code: "path_forbidden" });
    await expect(readFolderFile(root, "null-link")).rejects.toMatchObject({ code: "path_forbidden" });
    await expect(readFolderFile(root, "missing/deeper.txt")).rejects.toMatchObject({ code: "not_found" });
    await writeFile(join(root, "plain.txt"), "x", "utf8");
    await expect(readFolderFile(root, "plain.txt/child")).rejects.toMatchObject({ code: "not_found" });
    for (let index = 0; index < 20; index += 1) await readFolderFile(root, "plain.txt");
    const after = (await readdir("/proc/self/fd")).length;
    expect(after).toBe(before);
  });

  it("accepts exactly the limit and refuses one byte over it", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "edge.txt"), "x".repeat(MAX_FILE_BYTES), "utf8");
    await expect(readFolderFile(root, "edge.txt")).resolves.toMatchObject({ size: MAX_FILE_BYTES });
    await writeFile(join(root, "over.txt"), "x".repeat(MAX_FILE_BYTES + 1), "utf8");
    await expect(readFolderFile(root, "over.txt")).rejects.toMatchObject({ code: "too_large" });
  });

  it("stops a read that is cancelled", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "a.txt"), "x", "utf8");
    const controller = new AbortController();
    controller.abort();
    await expect(readFolderFile(root, "a.txt", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
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

  it("refuses a whole-Folder diff that shows a file a direct read would refuse", async () => {
    for (const blocked of ["credentials/service-account.json", ".gcp/key.json", "instance/secrets/app.yaml", "目录/.env"]) {
      const root = await tempRoot();
      await runGit(["init"], root);
      await runGit(["config", "user.email", "test@example.invalid"], root);
      await runGit(["config", "user.name", "Test"], root);
      await mkdir(join(root, dirname(blocked)), { recursive: true });
      await writeFile(join(root, blocked), "old\n", "utf8");
      await writeFile(join(root, "README.md"), "before\n", "utf8");
      await runGit(["add", "."], root);
      await runGit(["commit", "-m", "initial"], root);
      await writeFile(join(root, blocked), "private_key_id: 123\n", "utf8");
      await writeFile(join(root, "README.md"), "after\n", "utf8");

      await expect(folderGitDiff(root, null), blocked).rejects.toThrow(/blocked path/);
      await expect(folderGitDiff(root, "README.md")).resolves.toMatchObject({ diff: expect.stringContaining("+after") });
    }
  });

  it("does not let a single-path diff widen into files a direct read would refuse", async () => {
    const root = await tempRoot();
    await runGit(["init"], root);
    await runGit(["config", "user.email", "test@example.invalid"], root);
    await runGit(["config", "user.name", "Test"], root);
    await mkdir(join(root, "instance", "secrets"), { recursive: true });
    await writeFile(join(root, "instance", "secrets", "app.yaml"), "old\n", "utf8");
    await writeFile(join(root, "instance", "notes.md"), "before\n", "utf8");
    await runGit(["add", "."], root);
    await runGit(["commit", "-m", "initial"], root);
    await writeFile(join(root, "instance", "secrets", "app.yaml"), "private_key_id: 123\n", "utf8");
    await writeFile(join(root, "instance", "notes.md"), "after\n", "utf8");

    // A glob is a name, not a pattern: no file is called `*`.
    const globbed = await folderGitDiff(root, "*").then((result) => result.diff, (error: unknown) => String(error));
    expect(globbed).not.toContain("private_key_id");
    // A directory covers its subtree, so every file in it is checked.
    await expect(folderGitDiff(root, "instance")).rejects.toThrow(/blocked path/);
    await expect(folderGitDiff(root, "instance/notes.md")).resolves.toMatchObject({ diff: expect.stringContaining("+after") });
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

  it("creates a new file in directories that do not exist yet, and nowhere outside the root", async () => {
    const root = await tempRoot();
    await expect(writeFolderFile(root, "docs/notes/todo.md", "first", { expectedExists: false, expectedSha256: null }))
      .resolves.toMatchObject({ path: "docs/notes/todo.md", content: "first" });
    await expect(readFile(join(root, "docs", "notes", "todo.md"), "utf8")).resolves.toBe("first");

    // A link out of the root still refuses, however deep the new part goes.
    const outside = await tempRoot();
    await symlink(outside, join(root, "linked"));
    await expect(writeFolderFile(root, "linked/new/file.md", "x", { expectedExists: false, expectedSha256: null }))
      .rejects.toMatchObject({ code: "path_forbidden" });
    await expect(writeFolderFile(root, "new/.env", "x", { expectedExists: false, expectedSha256: null }))
      .rejects.toMatchObject({ code: "path_forbidden" });
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
