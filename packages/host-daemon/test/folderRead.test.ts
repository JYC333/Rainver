import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFolderReadFrame, performFolderRead } from "../src/folderRead.js";
import { sanitizeFailure } from "../src/ambientRedaction.js";

const run = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-host-folder-read-"));
  await writeFile(join(root, "README.md"), "hello\n");
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  await run("git", ["add", "README.md"], { cwd: root });
  await run("git", ["commit", "-q", "-m", "initial"], { cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("folder_read frame validation", () => {
  it("redacts local paths from failure messages before they go on the wire", () => {
    expect(sanitizeFailure(new Error("failure at /home/alice/secret.txt"))).toBe("failure at <path>");
  });

  it("rejects an unknown location and absolute or missing file paths", () => {
    expect(() => parseFolderReadFrame({ request_id: "r", workspace_location_id: "missing", kind: "tree", protected: false }, {})).toThrow(/no registered directory/);
    expect(() => parseFolderReadFrame({ request_id: "r", workspace_location_id: "loc", kind: "file", path: "/etc/passwd", protected: false }, { loc: root })).toThrow(/relative/);
    expect(() => parseFolderReadFrame({ request_id: "r", workspace_location_id: "loc", kind: "file", protected: false }, { loc: root })).toThrow(/relative path/);
    expect(() => parseFolderReadFrame({ request_id: "r", workspace_location_id: "loc", kind: "tree", path: "/etc/passwd", protected: false }, { loc: root })).toThrow(/do not accept a path/);
  });
});

describe("folder_read operations", () => {
  it("performs each bounded read kind", async () => {
    const workspaces = { loc: root };
    const tree = await performFolderRead(parseFolderReadFrame({ request_id: "tree", workspace_location_id: "loc", kind: "tree", protected: false }, workspaces));
    expect(tree).toMatchObject({ ok: true, kind: "tree" });
    const file = await performFolderRead(parseFolderReadFrame({ request_id: "file", workspace_location_id: "loc", kind: "file", path: "README.md", protected: false }, workspaces));
    expect(file).toMatchObject({ ok: true, kind: "file", result: { content: "hello\n" } });
    const status = await performFolderRead(parseFolderReadFrame({ request_id: "status", workspace_location_id: "loc", kind: "git_status", protected: false }, workspaces));
    expect(status).toMatchObject({ ok: true, kind: "git_status", result: { is_repo: true, files: [] } });
    const diff = await performFolderRead(parseFolderReadFrame({ request_id: "diff", workspace_location_id: "loc", kind: "git_diff", protected: false }, workspaces));
    expect(diff).toMatchObject({ ok: true, kind: "git_diff", result: { diff: "" } });
  });

  it("returns path_forbidden for traversal and protected paths", async () => {
    const workspaces = { loc: root };
    const traversal = await performFolderRead(parseFolderReadFrame({ request_id: "traversal", workspace_location_id: "loc", kind: "file", path: "../secret", protected: false }, workspaces));
    expect(traversal).toMatchObject({ ok: false, error: "path_forbidden" });
    expect(JSON.stringify(traversal)).not.toContain(root);
    const gitConfig = await performFolderRead(parseFolderReadFrame({ request_id: "git", workspace_location_id: "loc", kind: "file", path: ".git/config", protected: true }, workspaces));
    expect(gitConfig).toMatchObject({ ok: false, error: "path_forbidden" });
  });

  it("returns too_large for files over the one MiB display cap", async () => {
    await writeFile(join(root, "large.txt"), "x".repeat(1_048_577));
    const result = await performFolderRead(parseFolderReadFrame({ request_id: "large", workspace_location_id: "loc", kind: "file", path: "large.txt", protected: false }, { loc: root }));
    expect(result).toMatchObject({ ok: false, error: "too_large" });
  });
});
