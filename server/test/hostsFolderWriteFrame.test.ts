import { describe, expect, it } from "vitest";
import { parseFolderWriteResultFrame } from "../src/modules/hosts/folderWriteFrames.js";

describe("folder_write_result host frame validation", () => {
  it("accepts an existing-file acknowledgement and a deletion acknowledgement", () => {
    expect(parseFolderWriteResultFrame({
      ok: true,
      path: "notes/today.md",
      exists: true,
      sha256: "a".repeat(64),
      size: 8,
      line_count: 2,
    }, "notes/today.md")).toMatchObject({ ok: true, exists: true });
    expect(parseFolderWriteResultFrame({
      ok: true,
      path: "notes/today.md",
      exists: false,
      sha256: null,
      size: 0,
      line_count: 0,
    }, "notes/today.md")).toMatchObject({ ok: true, exists: false });
  });

  it("rejects missing hashes, path mismatches, and absolute paths", () => {
    expect(parseFolderWriteResultFrame({
      ok: true, path: "notes.md", exists: true, sha256: undefined, size: 1, line_count: 1,
    })).toBeNull();
    expect(parseFolderWriteResultFrame({
      ok: true, path: "other.md", exists: true, sha256: "a".repeat(64), size: 1, line_count: 1,
    }, "notes.md")).toBeNull();
    expect(parseFolderWriteResultFrame({
      ok: true, path: "/tmp/notes.md", exists: true, sha256: "a".repeat(64), size: 1, line_count: 1,
    })).toBeNull();
  });

  it("sanitizes failure details and keeps the structured error", () => {
    expect(parseFolderWriteResultFrame({
      ok: false,
      error: "path_forbidden",
      message: "Path escapes /Users/alice/private/secret.txt",
    })).toMatchObject({ ok: false, error: "path_forbidden", message: "Path escapes <path>" });
  });
});
