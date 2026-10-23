import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
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
  MAX_STATUS_OUTPUT_BYTES,
} from "./limits.js";
import { isGitRepo, parsePorcelain, runLocationGit } from "./git.js";
import { openFileBeneathRoot, SafeOpenError } from "./safeOpen.js";
import type { FileContent, FileNode, GitDiff, GitStatus } from "./types.js";

export type FolderReadErrorCode = "not_found" | "is_directory" | "too_large" | "path_forbidden" | "unsupported_platform";

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

/** One directory at a time; nested directories have no children until opened. */
export async function listFolderDirectory(
  root: string,
  path = ".",
  opts: { offset?: number; protectedFolder?: boolean; signal?: AbortSignal } = {},
): Promise<FileNode> {
  throwIfAborted(opts.signal);
  const offset = opts.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new PathPolicyError("Invalid directory offset");
  const resolved = resolveRelativePath(root, path, opts);
  if (resolved.relative.split("/").some((name) => IGNORE_DIRS.has(name))) {
    throw new PathPolicyError("Directory is excluded from file browsing");
  }
  // Hold the directory throughout readdir/lstat, including when an ancestor
  // is renamed. Never enumerate through a caller-controlled symlink.
  const directory = await openFileBeneathRoot(root, resolved.relative ? resolved.relative.split("/") : [])
    .catch((error: unknown) => {
      if (error instanceof SafeOpenError) throw folderReadErrorFromSafeOpen(error);
      throw error;
    });
  try {
    if (!(await directory.stat()).isDirectory()) throw new FolderReadError("not_found", "Directory not found");
    const heldPath = `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${directory.fd}`;
    const entries = (await readdir(heldPath, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink() && treePathAllowed(root, join(resolved.absolute, entry.name), entry.isDirectory(), opts))
      .sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name));
    const children: FileNode[] = [];
    let index = offset;
    for (; index < entries.length && children.length < MAX_FILES; index += 1) {
      throwIfAborted(opts.signal);
      const entry = entries[index]!;
      const info = await lstat(join(heldPath, entry.name)).catch((error: NodeJS.ErrnoException) => {
        if (["ENOENT", "EACCES", "EPERM"].includes(error.code ?? "")) return null;
        throw error;
      });
      if (!info || (!info.isFile() && !info.isDirectory())) continue;
      const childPath = resolved.relative ? `${resolved.relative}/${entry.name}` : entry.name;
      children.push({ name: entry.name, path: childPath, type: info.isDirectory() ? "dir" : "file", ...(info.isFile() ? { size: info.size } : {}) });
    }
    return {
      name: resolved.relative ? resolved.relative.split("/").pop()! : root.split(/[\\/]/).pop() || root,
      path: resolved.relative || ".",
      type: "dir",
      children,
      ...(index < entries.length ? { next_offset: index } : {}),
    };
  } finally {
    await directory.close();
  }
}

function treePathAllowed(root: string, path: string, directory: boolean, opts: Pick<PathPolicyInput, "protectedFolder"> = {}): boolean {
  if (directory && IGNORE_DIRS.has(path.split(/[\\/]/).pop()!)) return false;
  try {
    validatePath({ path, allowedRoot: root, mode: "read", ...opts });
    return true;
  } catch (error) {
    if (error instanceof PathPolicyError) return false;
    throw error;
  }
}

export async function readFolderFile(
  root: string,
  relPath: string,
  opts: { protectedFolder?: boolean; signal?: AbortSignal; includeUtf16Preview?: boolean; includeOriginalBytes?: boolean } = {},
): Promise<FileContent> {
  throwIfAborted(opts.signal);
  const resolved = resolveRelativePath(root, relPath, opts);
  if (resolved.relative === "") throw new FolderReadError("is_directory", "Path is a directory");
  // The lexical policy decision above is the last time the name is used. From
  // here on the kernel resolves each component without following links and
  // every check — type, size, bytes — runs on the handle it produced.
  const file = await openFileBeneathRoot(root, resolved.relative.split("/")).catch((error: unknown) => {
    if (error instanceof SafeOpenError) throw folderReadErrorFromSafeOpen(error);
    throw error;
  });
  try {
    throwIfAborted(opts.signal);
    const info = await file.stat();
    if (info.isDirectory()) throw new FolderReadError("is_directory", "Path is a directory");
    if (!info.isFile()) throw new FolderReadError("path_forbidden", "Path is not a regular file");
    if (info.size > MAX_FILE_BYTES) throw new FolderReadError("too_large", "File too large to display (max 1 MiB)");
    const bytes = await readBounded(file, opts.signal);
    const decoded = decodeFileBytes(bytes, { includeUtf16Preview: opts.includeUtf16Preview === true });
    return {
      path: resolved.relative,
      ...(opts.includeOriginalBytes ? { content_base64: bytes.toString("base64") } : {}),
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
  } finally {
    await file.close();
  }
}

/**
 * Reads at most `MAX_FILE_BYTES + 1` bytes from an open handle. The stat size
 * is a hint: a file that grows while it is read is still caught, because the
 * extra byte proves it is now over the limit.
 */
async function readBounded(file: FileHandle, signal: AbortSignal | undefined): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    throwIfAborted(signal);
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > MAX_FILE_BYTES) throw new FolderReadError("too_large", "File too large to display (max 1 MiB)");
  return buffer.subarray(0, length);
}

function folderReadErrorFromSafeOpen(error: SafeOpenError): FolderReadError {
  switch (error.code) {
    case "symlink":
      return new FolderReadError("path_forbidden", "Path contains a symbolic link");
    case "not_found":
    case "not_directory":
      return new FolderReadError("not_found", "File not found");
    case "unsupported_platform":
      return new FolderReadError("unsupported_platform", error.message);
  }
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
  if (!await isGitRepo(root)) return { is_repo: false, branch: null, files: [], truncated: false };
  const branch = (await runLocationGit(["rev-parse", "--abbrev-ref", "HEAD"], root, 10_000)).stdout.trim() || null;
  // Bounded while it is read, and bounded again in entries: a status git did
  // not finish, or one with more changes than the list holds, is shown as the
  // prefix it is, never as the whole tree.
  const raw = await runLocationGit(["status", "--porcelain=v1", "-z"], root, 10_000, { maxOutputBytes: MAX_STATUS_OUTPUT_BYTES });
  const parsed = parsePorcelain(raw.incomplete ? raw.stdout.slice(0, raw.stdout.lastIndexOf("\0") + 1) : raw.stdout);
  const files = parsed.slice(0, MAX_FILES);
  return { is_repo: true, branch, files, truncated: raw.incomplete === true || parsed.length > MAX_FILES };
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
    const childPath = join(nodePath, entry.name);
    if (!treePathAllowed(root, childPath, entry.isDirectory())) continue;
    // Listed a moment ago, gone or unreadable now: an editor's or a Run's
    // temporary file that was removed between readdir and stat, or an entry
    // the process may not look at. The walk leaves it out; it does not fail
    // the whole tree over it.
    // `lstat`, not `stat`: an entry that became a link after `readdir` listed
    // it must not be described by what it now points at.
    const childInfo = await lstat(childPath).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") return null;
      throw error;
    });
    if (!childInfo || childInfo.isSymbolicLink()) continue;
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
