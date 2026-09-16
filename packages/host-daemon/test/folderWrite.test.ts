import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performFolderWrite, resolveFolderWriteRequest } from "../src/folderWrite.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-host-folder-write-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("folder_write frame validation", () => {
  it("only resolves registered locations and plain relative paths", () => {
    expect(() => resolveFolderWriteRequest({
      request_id: "write-1",
      workspace_location_id: "missing",
      path: "notes.txt",
      content: "hello",
      expected_exists: false,
      expected_sha256: null,
      protected: false,
    }, {})).toThrow(/no registered directory/);

    expect(() => resolveFolderWriteRequest({
      request_id: "write-2",
      workspace_location_id: "loc",
      path: "../outside.txt",
      content: "hello",
      expected_exists: false,
      expected_sha256: null,
      protected: false,
    }, { loc: root })).toThrow(/plain relative paths/);
  });
});

describe("folder_write operations", () => {
  it("creates, updates, and removes a file with optimistic concurrency", async () => {
    const workspaces = { loc: root };
    const created = await performFolderWrite(resolveFolderWriteRequest({
      request_id: "create",
      workspace_location_id: "loc",
      path: "notes.txt",
      content: "first\n",
      expected_exists: false,
      expected_sha256: null,
      protected: false,
    }, workspaces));
    expect(created).toMatchObject({ ok: true, exists: true, path: "notes.txt" });

    if (!created.ok) throw new Error("expected create to succeed");
    const updated = await performFolderWrite(resolveFolderWriteRequest({
      request_id: "update",
      workspace_location_id: "loc",
      path: "notes.txt",
      content: "second\n",
      expected_exists: true,
      expected_sha256: created.sha256,
      protected: false,
    }, workspaces));
    expect(updated).toMatchObject({ ok: true, sha256: expect.any(String) });
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("second\n");

    const stale = await performFolderWrite(resolveFolderWriteRequest({
      request_id: "stale",
      workspace_location_id: "loc",
      path: "notes.txt",
      content: "clobber\n",
      expected_exists: true,
      expected_sha256: created.sha256,
      protected: false,
    }, workspaces));
    expect(stale).toMatchObject({ ok: false, error: "stale" });

    if (!updated.ok) throw new Error("expected update to succeed");
    const removed = await performFolderWrite(resolveFolderWriteRequest({
      request_id: "remove",
      workspace_location_id: "loc",
      path: "notes.txt",
      content: null,
      expected_exists: true,
      expected_sha256: updated.sha256,
      protected: false,
    }, workspaces));
    expect(removed).toMatchObject({ ok: true, exists: false, sha256: null });
  });
});
