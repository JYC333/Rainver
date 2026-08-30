import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  diffTouchesSecretLikePath,
  isInside,
  redactSecretLikeDiff,
  validatePath,
  type PathPolicyInput,
  PathPolicyError,
} from "./pathPolicy.js";
import {
  IGNORE_DIRS,
  MAX_DEPTH,
  MAX_DIFF_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  SHOW_HIDDEN,
} from "./limits.js";
import { isGitRepo, parsePorcelain, runGit } from "./git.js";
import type { FileContent, FileNode, GitDiff, GitStatus } from "./types.js";

export type FolderReadErrorCode = "not_found" | "is_directory" | "too_large" | "path_forbidden";

export class FolderReadError extends Error {
  constructor(readonly code: FolderReadErrorCode, message: string) {
    super(message);
    this.name = "FolderReadError";
  }
}

export async function buildTree(root: string): Promise<FileNode> {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new FolderReadError("not_found", "Project Folder directory not found on disk");
  return buildTreeNode(root, root, 0, { count: 0 });
}

export async function readFolderFile(
  root: string,
  relPath: string,
  opts: { protectedFolder?: boolean } = {},
): Promise<FileContent> {
  const resolved = resolveRelativePath(root, relPath, opts);
  await assertContainedPath(root, resolved.absolute, opts);
  const info = await stat(resolved.absolute).catch(() => null);
  if (!info) throw new FolderReadError("not_found", "File not found");
  if (!info.isFile()) throw new FolderReadError("is_directory", "Path is a directory");
  if (info.size > MAX_FILE_BYTES) {
    throw new FolderReadError("too_large", "File too large to display (max 1 MiB)");
  }
  const content = await readFile(resolved.absolute, "utf8");
  return {
    path: resolved.relative,
    content,
    size: info.size,
    line_count: content.split(/\n/).length,
  };
}

export async function folderGitStatus(root: string): Promise<GitStatus> {
  if (!await isGitRepo(root)) return { is_repo: false, branch: null, files: [] };
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], root, 10_000)).stdout.trim() || null;
  const raw = await runGit(["status", "--porcelain"], root, 10_000);
  return { is_repo: true, branch, files: parsePorcelain(raw.stdout) };
}

export async function folderGitDiff(
  root: string,
  relPath: string | null,
  opts: { protectedFolder?: boolean } = {},
): Promise<GitDiff> {
  let safePath: string | null = null;
  if (relPath !== null) {
    const resolved = resolveRelativePath(root, relPath, opts);
    await assertContainedPath(root, resolved.absolute, opts);
    safePath = resolved.relative;
  }
  const args = safePath !== null ? ["diff", "HEAD", "--", safePath] : ["diff", "HEAD", "--"];
  let diff = (await runGit(args, root, 15_000)).stdout;
  if (!diff) {
    diff = (await runGit(safePath !== null ? ["diff", "--", safePath] : ["diff", "--"], root, 15_000)).stdout;
  }
  if (diffTouchesSecretLikePath(diff)) {
    throw new PathPolicyError("Diff includes blocked path");
  }
  const redacted = redactSecretLikeDiff(diff);
  diff = redacted.diff;
  const encoded = Buffer.from(diff, "utf8");
  const truncated = encoded.length > MAX_DIFF_BYTES;
  if (truncated) diff = encoded.subarray(0, MAX_DIFF_BYTES).toString("utf8");
  return { diff, path: safePath, truncated, redacted: redacted.redacted };
}

export function resolveRelativePath(
  root: string,
  requested: string,
  opts: Pick<PathPolicyInput, "protectedFolder"> = {},
): { absolute: string; relative: string } {
  const absolute = validatePath({
    path: resolve(root, requested),
    allowedRoot: root,
    mode: "read",
    protectedFolder: opts.protectedFolder,
  });
  return {
    absolute,
    relative: relative(resolve(root), absolute).split("\\").join("/"),
  };
}

async function buildTreeNode(root: string, nodePath: string, depth: number, counter: { count: number }): Promise<FileNode> {
  const info = await stat(nodePath);
  const rel = nodePath === root ? "." : relative(root, nodePath).split("\\").join("/");
  const node: FileNode = {
    name: nodePath === root ? root.split(/[\\/]/).pop() || root : nodePath.split(/[\\/]/).pop() || nodePath,
    path: rel,
    type: info.isDirectory() ? "dir" : "file",
  };
  if (info.isFile()) {
    node.size = info.size;
    return node;
  }
  if (!info.isDirectory() || depth >= MAX_DEPTH || counter.count >= MAX_FILES) {
    return node;
  }
  const entries = await readdir(nodePath, { withFileTypes: true }).catch(() => []);
  const children: FileNode[] = [];
  for (const entry of entries.sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && !SHOW_HIDDEN.has(entry.name)) continue;
    counter.count += 1;
    if (counter.count > MAX_FILES) break;
    children.push(await buildTreeNode(root, join(nodePath, entry.name), depth + 1, counter));
  }
  node.children = children;
  return node;
}

async function assertContainedPath(
  root: string,
  candidate: string,
  opts: { protectedFolder?: boolean } = {},
): Promise<void> {
  const canonicalRoot = await realpath(root).catch(() => null);
  const canonicalCandidate = await realpath(candidate).catch(() => null);
  if (!canonicalCandidate) return;
  if (!canonicalRoot || !isInside(canonicalCandidate, canonicalRoot)) {
    throw new PathPolicyError(`Path escapes the registered Folder root: '${candidate}'`);
  }
  // Apply the policy again to the canonical target. A harmless-looking link
  // such as `public.txt -> .env` must not become an alias for a forbidden path.
  validatePath({
    path: canonicalCandidate,
    allowedRoot: canonicalRoot,
    mode: "read",
    protectedFolder: opts.protectedFolder,
  });
}
