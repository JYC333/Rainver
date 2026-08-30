import { describe, expect, it } from "vitest";
import { MAX_FILES } from "@rainver/folder-read";
import { parseFolderReadResultFrame } from "../src/modules/hosts/folderReadFrames.js";

describe("folder_read_result host frame validation", () => {
  it("accepts bounded success shapes for each read kind", () => {
    expect(parseFolderReadResultFrame({ ok: true, kind: "tree", result: { name: "root", path: ".", type: "dir" } }))
      .toMatchObject({ ok: true, kind: "tree" });
    expect(parseFolderReadResultFrame({ ok: true, kind: "file", result: { path: "README.md", content: "hello", size: 5, line_count: 1 } }))
      .toMatchObject({ ok: true, kind: "file" });
    expect(parseFolderReadResultFrame({ ok: true, kind: "git_status", result: { is_repo: false, branch: null, files: [] } }))
      .toMatchObject({ ok: true, kind: "git_status" });
    expect(parseFolderReadResultFrame({ ok: true, kind: "git_diff", result: { diff: "", path: null, truncated: false, redacted: false } }))
      .toMatchObject({ ok: true, kind: "git_diff" });
    expect(parseFolderReadResultFrame({ ok: true, kind: "git_diff", result: { diff: "", path: "", truncated: false, redacted: false } }))
      .toMatchObject({ ok: true, kind: "git_diff", result: { path: "." } });
  });

  it("accepts the producer's exact non-root tree limit and rejects one more node", () => {
    const children = Array.from({ length: MAX_FILES }, (_, index) => ({
      name: `file-${index}`,
      path: `file-${index}`,
      type: "file",
    }));
    expect(parseFolderReadResultFrame({ ok: true, kind: "tree", result: { name: "root", path: ".", type: "dir", children } }))
      .toMatchObject({ ok: true, kind: "tree" });
    children.push({ name: "overflow", path: "overflow", type: "file" });
    expect(parseFolderReadResultFrame({ ok: true, kind: "tree", result: { name: "root", path: ".", type: "dir", children } }))
      .toBeNull();
  });

  it("ignores malformed or mismatched result frames", () => {
    expect(parseFolderReadResultFrame({ ok: true, kind: "tree", result: { content: "wrong" } })).toBeNull();
    expect(parseFolderReadResultFrame({ ok: true, kind: "file", result: { path: "README.md" } })).toBeNull();
    expect(parseFolderReadResultFrame({ ok: true, kind: "unknown", result: {} })).toBeNull();
    expect(parseFolderReadResultFrame({ ok: false, error: "not-a-code", message: "bad" })).toBeNull();
    expect(parseFolderReadResultFrame({ ok: false, error: "path_forbidden", message: "blocked" }))
      .toMatchObject({ ok: false, error: "path_forbidden" });
  });

  it("rejects absolute paths in every success result shape", () => {
    expect(parseFolderReadResultFrame({
      ok: true,
      kind: "tree",
      result: {
        name: "root",
        path: ".",
        type: "dir",
        children: [{ name: "secret", path: "/Users/alice/private", type: "file", size: 1 }],
      },
    })).toBeNull();
    expect(parseFolderReadResultFrame({
      ok: true,
      kind: "file",
      result: { path: "C:\\Users\\alice\\secret.txt", content: "secret", size: 6, line_count: 1 },
    })).toBeNull();
    expect(parseFolderReadResultFrame({
      ok: true,
      kind: "git_status",
      result: { is_repo: true, branch: "main", files: [{ path: "/Users/alice/secret", status: "modified" }] },
    })).toBeNull();
    expect(parseFolderReadResultFrame({
      ok: true,
      kind: "git_diff",
      result: { diff: "", path: "/Users/alice/secret", truncated: false, redacted: false },
    })).toBeNull();
  });

  it("keeps git's trailing slash on an untracked directory entry", () => {
    expect(parseFolderReadResultFrame({
      ok: true,
      kind: "git_status",
      result: { is_repo: true, branch: "main", files: [{ path: "backend/prisma/backups/", status: "untracked" }] },
    })).toMatchObject({ ok: true, result: { files: [{ path: "backend/prisma/backups/" }] } });
  });

  it("sanitizes absolute paths in daemon failure messages", () => {
    const result = parseFolderReadResultFrame({
      ok: false,
      error: "path_forbidden",
      message: "Path escapes '/Users/alice/private folder/secret.txt'",
    });
    expect(result).toMatchObject({ ok: false, error: "path_forbidden", message: "Path escapes <path>" });
    expect(JSON.stringify(result)).not.toContain("/Users/alice");
  });
});
