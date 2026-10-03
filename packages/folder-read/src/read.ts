import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
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
  MAX_DIFF_OUTPUT_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  SHOW_HIDDEN,
} from "./limits.js";
import { isGitRepo, parsePorcelain, runLocationGit } from "./git.js";
import type { FileContent, FileNode, GitDiff, GitStatus } from "./types.js";

export type FolderReadErrorCode = "not_found" | "is_directory" | "too_large" | "path_forbidden";

export class FolderReadError extends Error {
  constructor(readonly code: FolderReadErrorCode, message: string) {
    super(message);
    this.name = "FolderReadError";
  }
}

export async function buildTree(root: string, signal?: AbortSignal): Promise<FileNode> {
  throwIfAborted(signal);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new FolderReadError("not_found", "Project Folder directory not found on disk");
  return buildTreeNode(root, root, 0, { count: 0 }, signal);
}

export async function readFolderFile(
  root: string,
  relPath: string,
  opts: { protectedFolder?: boolean; signal?: AbortSignal; includeUtf16Preview?: boolean } = {},
): Promise<FileContent> {
  throwIfAborted(opts.signal);
  const resolved = resolveRelativePath(root, relPath, opts);
  await assertContainedPath(root, resolved.absolute, opts);
  const info = await stat(resolved.absolute).catch(() => null);
  if (!info) throw new FolderReadError("not_found", "File not found");
  if (!info.isFile()) throw new FolderReadError("is_directory", "Path is a directory");
  if (info.size > MAX_FILE_BYTES) {
    throw new FolderReadError("too_large", "File too large to display (max 1 MiB)");
  }
  const bytes = await readFile(resolved.absolute);
  throwIfAborted(opts.signal);
  const decoded = decodeFileBytes(bytes, { includeUtf16Preview: opts.includeUtf16Preview === true });
  return {
    path: resolved.relative,
    content: decoded.content,
    size: bytes.byteLength,
    line_count: decoded.line_count,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    encoding: decoded.encoding,
    has_bom: decoded.has_bom,
    line_ending_mode: decoded.line_ending_mode,
    writable: decoded.writable,
    conversion_available: decoded.conversion_available,
  };
}

/**
 * Decode a bounded file without ever replacing malformed bytes. UTF-16 is
 * recognised only with a BOM; its body is returned only when the caller has
 * explicitly requested a conversion preview. Binary/unknown input has an
 * empty body and is therefore safe to render as read-only metadata.
 */
export function decodeFileBytes(
  bytes: Uint8Array,
  options: { includeUtf16Preview?: boolean } = {},
): Pick<FileContent, "content" | "line_count" | "encoding" | "has_bom" | "line_ending_mode" | "writable" | "conversion_available"> {
  const input = Buffer.from(bytes);
  const utf8Bom = input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf;
  const utf16LeBom = input.length >= 2 && input[0] === 0xff && input[1] === 0xfe;
  const utf16BeBom = input.length >= 2 && input[0] === 0xfe && input[1] === 0xff;

  if (utf16LeBom || utf16BeBom) {
    const body = input.subarray(2);
    const decoded = decodeUtf16(body, utf16BeBom);
    if (decoded !== null && !decoded.includes("\0")) {
      const metadata = textMetadata(decoded, utf16BeBom ? "utf16be" : "utf16le", true, false, true);
      return {
        ...metadata,
        content: options.includeUtf16Preview === true ? decoded : "",
        writable: false,
        conversion_available: true,
      };
    }
    return unknownMetadata(decoded === null ? "unknown" : "binary", true, false);
  }

  const body = utf8Bom ? input.subarray(3) : input;
  if (hasNul(body)) return unknownMetadata("binary", utf8Bom, false);
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return textMetadata(content, "utf8", utf8Bom, true, false);
  } catch {
    return unknownMetadata(hasNul(input) ? "binary" : "unknown", utf8Bom, false);
  }
}

function decodeUtf16(body: Uint8Array, bigEndian: boolean): string | null {
  if (body.byteLength % 2 !== 0) return null;
  const bytes = Buffer.from(body);
  if (bigEndian) {
    for (let index = 0; index < bytes.length; index += 2) {
      const first = bytes[index]!;
      bytes[index] = bytes[index + 1]!;
      bytes[index + 1] = first;
    }
  }
  try {
    return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function textMetadata(
  content: string,
  encoding: "utf8" | "utf16le" | "utf16be",
  hasBom: boolean,
  writable: boolean,
  conversionAvailable: boolean,
): Pick<FileContent, "content" | "line_count" | "encoding" | "has_bom" | "line_ending_mode" | "writable" | "conversion_available"> {
  return {
    content,
    line_count: content.split(/\n/).length,
    encoding,
    has_bom: hasBom,
    line_ending_mode: lineEndingMode(content),
    writable,
    conversion_available: conversionAvailable,
  };
}

function unknownMetadata(
  encoding: "binary" | "unknown",
  hasBom: boolean,
  conversionAvailable: boolean,
): Pick<FileContent, "content" | "line_count" | "encoding" | "has_bom" | "line_ending_mode" | "writable" | "conversion_available"> {
  return {
    content: "",
    line_count: 0,
    encoding,
    has_bom: hasBom,
    line_ending_mode: "none",
    writable: false,
    conversion_available: conversionAvailable,
  };
}

function lineEndingMode(content: string): "lf" | "crlf" | "mixed" | "none" {
  const crlf = /\r\n/u.test(content);
  const loneLf = /(^|[^\r])\n/u.test(content);
  const loneCr = /\r(?!\n)/u.test(content);
  if (!crlf && !loneLf && !loneCr) return "none";
  if ((crlf ? 1 : 0) + (loneLf || loneCr ? 1 : 0) > 1 || loneCr) return "mixed";
  return crlf ? "crlf" : "lf";
}

function hasNul(bytes: Uint8Array): boolean {
  return bytes.some((byte) => byte === 0);
}

export async function folderGitStatus(root: string): Promise<GitStatus> {
  if (!await isGitRepo(root)) return { is_repo: false, branch: null, files: [] };
  const branch = (await runLocationGit(["rev-parse", "--abbrev-ref", "HEAD"], root, 10_000)).stdout.trim() || null;
  const raw = await runLocationGit(["status", "--porcelain=v1", "-z"], root, 10_000);
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
  // Literal, not git's default glob: `*` is a file name here, not every file.
  // A literal directory still covers its subtree, so the per-file check below
  // runs for a path as well as for the whole Folder.
  const pathspec = safePath ? ["--", `:(literal)${safePath}`] : safePath === "" ? ["--", ""] : ["--"];
  let base = ["HEAD", ...pathspec];
  // Bounded while it is read: the whole diff of a large change would
  // otherwise sit in memory before the cap below could apply to it.
  const gitOptions = { maxOutputBytes: MAX_DIFF_OUTPUT_BYTES };
  let result = await runLocationGit(["diff", "--no-ext-diff", "--no-textconv", ...base], root, 15_000, gitOptions);
  // No HEAD yet: diff the work tree against the index instead. A HEAD diff
  // that was cut short is not that case, even when nothing had arrived yet.
  if (!result.stdout && !result.incomplete) {
    base = pathspec;
    result = await runLocationGit(["diff", "--no-ext-diff", "--no-textconv", ...base], root, 15_000, gitOptions);
  }
  let diff = result.stdout;
  // A diff git did not finish — stopped at the timeout or the output limit,
  // or failed after writing part of it — is at most a prefix of the real one,
  // and is shown as such rather than as the whole change.
  const partial = result.incomplete === true || (result.code !== 0 && diff.length > 0);
  if (diff) await assertDiffPathsReadable(root, base, opts);
  if (diffTouchesSecretLikePath(diff)) {
    throw new PathPolicyError("Diff includes blocked path");
  }
  const redacted = redactSecretLikeDiff(diff);
  diff = redacted.diff;
  const encoded = Buffer.from(diff, "utf8");
  const truncated = partial || encoded.length > MAX_DIFF_BYTES;
  if (encoded.length > MAX_DIFF_BYTES) diff = encoded.subarray(0, MAX_DIFF_BYTES).toString("utf8");
  return { diff, path: safePath, truncated, redacted: redacted.redacted };
}

/**
 * A diff shows the content of every changed file it covers (the whole Folder,
 * or a directory's subtree), so each of those files must pass the policy a
 * single-file read of it would. Paths come from
 * git as NUL-separated raw names, without the quoting a diff header applies to
 * unusual names, and without rename pairing, so a file renamed away from a
 * forbidden path is still checked under its old name.
 */
async function assertDiffPathsReadable(
  root: string,
  base: readonly string[],
  opts: Pick<PathPolicyInput, "protectedFolder">,
): Promise<void> {
  const names = (await runLocationGit(["diff", "--name-only", "-z", "--no-renames", ...base], root, 15_000)).stdout;
  for (const name of names.split("\0")) {
    if (!name) continue;
    try {
      resolveRelativePath(root, name, opts);
    } catch (error) {
      if (error instanceof PathPolicyError) throw new PathPolicyError("Diff includes blocked path");
      throw error;
    }
  }
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

async function buildTreeNode(root: string, nodePath: string, depth: number, counter: { count: number }, signal?: AbortSignal): Promise<FileNode> {
  throwIfAborted(signal);
  const info = await stat(nodePath);
  return buildTreeNodeFrom(info, root, nodePath, depth, counter, signal);
}

async function buildTreeNodeFrom(info: Stats, root: string, nodePath: string, depth: number, counter: { count: number }, signal?: AbortSignal): Promise<FileNode> {
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
    throwIfAborted(signal);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && !SHOW_HIDDEN.has(entry.name)) continue;
    const childPath = join(nodePath, entry.name);
    // Listed a moment ago, gone or unreadable now: an editor's or a Run's
    // temporary file that was removed between readdir and stat, or an entry
    // the process may not look at. The walk leaves it out; it does not fail
    // the whole tree over it.
    const childInfo = await stat(childPath).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") return null;
      throw error;
    });
    if (!childInfo) continue;
    counter.count += 1;
    if (counter.count > MAX_FILES) break;
    children.push(await buildTreeNodeFrom(childInfo, root, childPath, depth + 1, counter, signal));
  }
  node.children = children;
  return node;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("folder read cancelled");
  error.name = "AbortError";
  throw error;
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
