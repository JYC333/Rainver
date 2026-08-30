/**
 * Validation of a daemon's `folder_read_result` frame before it reaches the
 * caller waiting in `HostConnectionRegistry`. The daemon is trusted-tier, but
 * the frame is still external input: every name, path, size and byte count
 * is re-checked against the same `@rainver/folder-read` limits the daemon
 * applied, so a misbehaving or stale daemon cannot push an unbounded or
 * path-escaping payload into Files & Code.
 */
import {
  MAX_DIFF_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_DEPTH,
  isWireRelativePath,
  redactLocalPaths,
  type FileContent,
  type FileNode,
  type GitChangedFile,
  type GitDiff,
  type GitStatus,
} from "@rainver/folder-read";
import type { FolderReadFailureCode, FolderReadResult } from "./connectionRegistry.js";

export function parseFolderReadResultFrame(frame: Record<string, unknown>): FolderReadResult | null {
  if (frame.ok !== true && frame.ok !== false) return null;
  if (frame.ok === false) {
    const code = frame.error;
    const allowed: readonly FolderReadFailureCode[] = ["host_offline", "host_timeout", "location_unknown", "path_forbidden", "not_found", "is_directory", "too_large", "read_failed"];
    if (typeof code !== "string" || !allowed.includes(code as FolderReadFailureCode)) return null;
    return {
      ok: false,
      error: code as FolderReadFailureCode,
      ...(typeof frame.message === "string" ? { message: sanitizeRemoteFailure(frame.message) } : {}),
    };
  }
  const kind = frame.kind;
  if (kind !== "tree" && kind !== "file" && kind !== "git_status" && kind !== "git_diff") return null;
  const result = frame.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (kind === "tree") {
    const node = validateRemoteTreeNode(record, 0, { count: 0 }, true);
    return node ? { ok: true, kind: "tree", result: node } : null;
  }
  if (kind === "file") {
    const file = validateRemoteFile(record);
    return file ? { ok: true, kind: "file", result: file } : null;
  }
  if (kind === "git_status") {
    const status = validateRemoteGitStatus(record);
    return status ? { ok: true, kind: "git_status", result: status } : null;
  }
  const diff = validateRemoteGitDiff(record);
  return diff ? { ok: true, kind: "git_diff", result: diff } : null;
}

function isSafeRemoteRelativePath(value: unknown, allowRoot = false): value is string {
  if (typeof value !== "string") return false;
  if (allowRoot && (value === "" || value === ".")) return true;
  if (!isWireRelativePath(value) || value === ".") return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isSafeRemoteName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.includes("\0")
    && !value.includes("/")
    && !value.includes("\\")
    && value !== "."
    && value !== "..";
}

function boundedInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function validateRemoteTreeNode(
  value: Record<string, unknown>,
  depth: number,
  counter: { count: number },
  root = false,
): FileNode | null {
  if (depth > MAX_DEPTH || (!root && counter.count >= MAX_FILES)) return null;
  if (!isSafeRemoteName(value.name) || !isSafeRemoteRelativePath(value.path, true)) return null;
  if (value.type !== "dir" && value.type !== "file") return null;
  if (!root) counter.count += 1;
  const node: FileNode = { name: value.name, path: value.path, type: value.type };
  if (value.size !== undefined && !boundedInteger(value.size, Number.MAX_SAFE_INTEGER)) return null;
  if (value.type === "file") {
    if (value.children !== undefined) return null;
    if (value.size !== undefined) node.size = value.size;
    return node;
  }
  if (value.size !== undefined) return null;
  if (value.children === undefined) return node;
  if (!Array.isArray(value.children)) return null;
  const children: FileNode[] = [];
  for (const child of value.children) {
    if (!child || typeof child !== "object" || Array.isArray(child)) return null;
    const validated = validateRemoteTreeNode(child as Record<string, unknown>, depth + 1, counter);
    if (!validated) return null;
    children.push(validated);
  }
  node.children = children;
  return node;
}

function validateRemoteFile(value: Record<string, unknown>): FileContent | null {
  if (!isSafeRemoteRelativePath(value.path)) return null;
  if (typeof value.content !== "string" || Buffer.byteLength(value.content, "utf8") > MAX_FILE_BYTES) return null;
  if (!boundedInteger(value.size, MAX_FILE_BYTES) || !boundedInteger(value.line_count, MAX_FILE_BYTES + 1)) return null;
  return { path: value.path, content: value.content, size: value.size, line_count: value.line_count };
}

function validateRemoteGitStatus(value: Record<string, unknown>): GitStatus | null {
  if (typeof value.is_repo !== "boolean" || (value.branch !== null && typeof value.branch !== "string") || !Array.isArray(value.files) || value.files.length > MAX_FILES) return null;
  const files: GitChangedFile[] = [];
  for (const file of value.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return null;
    const record = file as Record<string, unknown>;
    // `git status --porcelain` reports an untracked directory with a trailing
    // slash; keep the entry as git wrote it and validate the path proper.
    if (typeof record.path !== "string" || !isSafeRemoteRelativePath(record.path.replace(/\/$/, ""))) return null;
    if (typeof record.status !== "string" || record.status.length > 64) return null;
    files.push({ path: record.path, status: record.status });
  }
  return { is_repo: value.is_repo, branch: value.branch as string | null, files };
}

function validateRemoteGitDiff(value: Record<string, unknown>): GitDiff | null {
  if (typeof value.diff !== "string" || Buffer.byteLength(value.diff, "utf8") > MAX_DIFF_BYTES) return null;
  if (value.path !== null && !isSafeRemoteRelativePath(value.path, true)) return null;
  if (typeof value.truncated !== "boolean" || typeof value.redacted !== "boolean") return null;
  return {
    diff: value.diff,
    path: value.path === "" ? "." : value.path as string | null,
    truncated: value.truncated,
    redacted: value.redacted,
  };
}

function sanitizeRemoteFailure(value: string): string {
  return redactLocalPaths(value).slice(0, 512);
}
