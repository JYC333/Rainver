import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MAX_WRITE_FILE_BYTES } from "./limits.js";
import { isInside, PathPolicyError, validatePath } from "./pathPolicy.js";
import { decodeFileBytes } from "./read.js";

export type FolderWriteErrorCode = "not_found" | "is_directory" | "too_large" | "path_forbidden" | "not_text" | "stale" | "write_failed";

export class FolderWriteError extends Error {
  constructor(readonly code: FolderWriteErrorCode, message: string) {
    super(message);
    this.name = "FolderWriteError";
  }
}

export interface FileWriteState {
  path: string;
  exists: boolean;
  content: string | null;
  sha256: string | null;
}

export interface FileWriteResult {
  path: string;
  exists: boolean;
  content: string | null;
  size: number;
  line_count: number;
  sha256: string | null;
  before: FileWriteState;
}

export interface FileWriteOptions {
  protectedFolder?: boolean;
  expectedExists?: boolean;
  expectedSha256?: string | null;
  /** Only the explicit File-page conversion flow may replace a valid BOM-marked UTF-16 preimage. */
  allowEncodingConversion?: boolean;
}

export interface FileRestoreOptions extends FileWriteOptions {
  /** Recreate the rollback preimage in its original encoding. */
  restoreEncoding?: "utf8" | "utf16le" | "utf16be";
}

const writeLocks = new Map<string, Promise<void>>();
const WRITE_LOCK_STALE_MS = 5 * 60 * 1000;
const WRITE_LOCK_WAIT_MS = 25;

/**
 * Replace one UTF-8 text file atomically and return the exact preimage. The
 * caller supplies an optional preimage hash so a stale editor cannot silently
 * overwrite a newer change. Secret-like paths remain forbidden even for a
 * person using the File page.
 */
export async function writeFolderFile(
  root: string,
  requestedPath: string,
  content: string,
  options: FileWriteOptions = {},
): Promise<FileWriteResult> {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > MAX_WRITE_FILE_BYTES) {
    throw new FolderWriteError("too_large", `File is too large to write (max ${MAX_WRITE_FILE_BYTES} bytes)`);
  }
  const resolved = await resolveWriteTarget(root, requestedPath, options);
  return withWriteLock(resolved.lockKey, () => writeResolvedFile(resolved, content, bytes, options));
}

/** Restore or remove one file, again refusing to overwrite a later change. */
export async function restoreFolderFile(
  root: string,
  requestedPath: string,
  content: string | null,
  options: FileRestoreOptions = {},
): Promise<FileWriteResult> {
  const resolved = await resolveWriteTarget(root, requestedPath, options);
  return withWriteLock(resolved.lockKey, async () => {
    const before = await readState(resolved.absolute, resolved.relative, options, resolved.canonicalRoot);
    assertExpected(before, options);
    if (content !== null) {
      const bytes = encodeRestoredContent(content, options.restoreEncoding ?? "utf8");
      if (bytes.byteLength > MAX_WRITE_FILE_BYTES) {
        throw new FolderWriteError("too_large", `File is too large to write (max ${MAX_WRITE_FILE_BYTES} bytes)`);
      }
      return writeResolvedFile(resolved, content, bytes, {
        protectedFolder: options.protectedFolder,
        expectedExists: before.exists,
        expectedSha256: before.sha256,
      });
    }
    try {
      const current = await readState(resolved.absolute, resolved.relative, options, resolved.canonicalRoot);
      assertExpected(current, options);
      if (current.exists) await unlink(resolved.absolute);
    } catch (error) {
      throw new FolderWriteError("write_failed", error instanceof Error ? error.message : "File removal failed");
    }
    return {
      path: resolved.relative,
      exists: false,
      content: null,
      size: 0,
      line_count: 0,
      sha256: null,
      before,
    };
  });
}

async function writeResolvedFile(
  resolved: ResolvedWriteTarget,
  content: string,
  bytes: Buffer,
  options: FileWriteOptions,
): Promise<FileWriteResult> {
  const before = await readState(resolved.absolute, resolved.relative, options, resolved.canonicalRoot);
  assertExpected(before, options);
  const mode = await fileMode(resolved.absolute);
  try {
    await mkdir(dirname(resolved.absolute), { recursive: true });
    const temporary = `${resolved.absolute}.rainver-write-${cryptoRandomId()}`;
    try {
      await writeFile(temporary, bytes, { mode: mode ?? 0o644 });
      if (mode !== null) await chmod(temporary, mode);
      const current = await readState(resolved.absolute, resolved.relative, options, resolved.canonicalRoot);
      assertExpected(current, options);
      await rename(temporary, resolved.absolute);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  } catch (error) {
    throw new FolderWriteError("write_failed", error instanceof Error ? error.message : "File write failed");
  }
  const sha256 = hash(bytes);
  return {
    path: resolved.relative,
    exists: true,
    content,
    size: bytes.byteLength,
    line_count: content.split(/\n/).length,
    sha256,
    before,
  };
}

async function resolveWriteTarget(
  root: string,
  requestedPath: string,
  options: Pick<FileWriteOptions, "protectedFolder">,
): Promise<ResolvedWriteTarget> {
  if (!requestedPath || requestedPath.includes("\0") || requestedPath.includes("\\") || requestedPath.startsWith("/")) {
    throw new FolderWriteError("path_forbidden", "File paths must be relative to the registered Folder");
  }
  const absoluteRoot = resolve(root);
  let absolute: string;
  try {
    absolute = validatePath({
      path: resolve(absoluteRoot, requestedPath),
      allowedRoot: absoluteRoot,
      mode: "write",
      protectedFolder: options.protectedFolder,
      // This is a person-authorized File-page write, not an Agent patch.
      allowUserWrite: true,
    });
  } catch (error) {
    if (error instanceof PathPolicyError) throw new FolderWriteError("path_forbidden", error.message);
    throw error;
  }
  const canonicalRoot = await realpath(absoluteRoot).catch(() => null);
  if (!canonicalRoot) throw new FolderWriteError("not_found", "Project Folder directory not found on disk");
  const canonicalParent = await realpath(dirname(absolute)).catch(() => null);
  const canonicalTarget = await realpath(absolute).catch(() => null);
  const containmentTarget = canonicalTarget ?? canonicalParent;
  if (!containmentTarget || !isInside(containmentTarget, canonicalRoot)) {
    throw new FolderWriteError("path_forbidden", "File path escapes the registered Folder root");
  }
  try {
    validatePath({
      path: canonicalTarget ?? absolute,
      allowedRoot: canonicalRoot,
      mode: "write",
      protectedFolder: options.protectedFolder,
      allowUserWrite: true,
    });
  } catch (error) {
    if (error instanceof PathPolicyError) throw new FolderWriteError("path_forbidden", error.message);
    throw error;
  }
  return {
    absolute,
    relative: relative(absoluteRoot, absolute).split("\\").join("/"),
    canonicalRoot,
    lockKey: `${canonicalRoot}\u0000${absolute}`,
  };
}

interface ResolvedWriteTarget {
  absolute: string;
  relative: string;
  canonicalRoot: string;
  lockKey: string;
}

async function withWriteLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  writeLocks.set(key, current);
  await previous;
  let releaseFileLock: (() => Promise<void>) | null = null;
  try {
    releaseFileLock = await acquireFileLock(key);
    return await work();
  } finally {
    await releaseFileLock?.();
    release();
    if (writeLocks.get(key) === current) writeLocks.delete(key);
  }
}

/** Serialize writes across separate server/daemon processes on one machine. */
async function acquireFileLock(key: string): Promise<() => Promise<void>> {
  const lockPath = join(tmpdir(), `.rainver-folder-write-${hash(Buffer.from(key, "utf8"))}.lock`);
  for (;;) {
    try {
      await mkdir(lockPath);
      return async () => { await rmdir(lockPath).catch(() => undefined); };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new FolderWriteError("write_failed", error instanceof Error ? error.message : "Could not acquire file write lock");
      }
      const lockInfo = await stat(lockPath).catch(() => null);
      if (lockInfo && Date.now() - lockInfo.mtimeMs > WRITE_LOCK_STALE_MS) {
        await rmdir(lockPath).catch(() => undefined);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, WRITE_LOCK_WAIT_MS));
    }
  }
}

async function readState(
  absolute: string,
  relativePath: string,
  options: Pick<FileWriteOptions, "protectedFolder" | "allowEncodingConversion">,
  canonicalRoot: string,
): Promise<FileWriteState> {
  const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new FolderWriteError("write_failed", error.message);
  });
  if (!info) return { path: relativePath, exists: false, content: null, sha256: null };
  if (!info.isFile()) throw new FolderWriteError("is_directory", "Path is a directory");
  if (info.size > MAX_WRITE_FILE_BYTES) throw new FolderWriteError("too_large", `File is too large to edit (max ${MAX_WRITE_FILE_BYTES} bytes)`);
  const bytes = await readFile(absolute);
  // Re-run the policy after following a symlink; the target must not alias a
  // forbidden path such as .env or .git/config.
  const canonical = await realpath(absolute).catch(() => null);
  if (canonical) {
    try {
      validatePath({ path: canonical, allowedRoot: canonicalRoot, mode: "write", protectedFolder: options.protectedFolder, allowUserWrite: true });
    } catch (error) {
      if (error instanceof PathPolicyError) throw new FolderWriteError("path_forbidden", error.message);
      throw error;
    }
  }
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    if (options.allowEncodingConversion) {
      const decoded = decodeFileBytes(bytes, { includeUtf16Preview: true });
      if ((decoded.encoding === "utf16le" || decoded.encoding === "utf16be") && decoded.conversion_available) {
        return { path: relativePath, exists: true, content: decoded.content, sha256: hash(bytes) };
      }
    }
    throw new FolderWriteError("not_text", "Only UTF-8 text files can be edited");
  }
  return { path: relativePath, exists: true, content, sha256: hash(bytes) };
}

function encodeRestoredContent(content: string, encoding: "utf8" | "utf16le" | "utf16be"): Buffer {
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  const body = Buffer.from(content.startsWith("\uFEFF") ? content.slice(1) : content, "utf16le");
  if (encoding === "utf16be") {
    for (let index = 0; index < body.length; index += 2) {
      const first = body[index]!;
      body[index] = body[index + 1]!;
      body[index + 1] = first;
    }
    return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
  }
  return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
}

function assertExpected(before: FileWriteState, options: FileWriteOptions): void {
  if (options.expectedExists !== undefined && before.exists !== options.expectedExists) {
    throw new FolderWriteError("stale", before.exists ? "File was created after it was opened" : "File was removed after it was opened");
  }
  if (options.expectedExists === true && options.expectedSha256 !== before.sha256) {
    throw new FolderWriteError("stale", "File changed after it was opened");
  }
  if (options.expectedExists === false && options.expectedSha256 !== null && options.expectedSha256 !== undefined) {
    throw new FolderWriteError("stale", "A new file target already has an unexpected version");
  }
}

async function fileMode(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? info.mode & 0o777 : null;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cryptoRandomId(): string {
  return randomUUID();
}
