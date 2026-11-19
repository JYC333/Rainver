import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rmdir, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { MAX_WRITE_FILE_BYTES } from "./limits.js";
import { isInside, PathPolicyError, validatePath } from "./pathPolicy.js";
import { decodeFileBytes } from "./read.js";
import { safeOpenCapability } from "./safeOpen.js";

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
const WRITE_LOCK_WAIT_MS = 25;
/** A save waits this long for another process's write before giving up, never forever. */
const WRITE_LOCK_MAX_WAIT_MS = 30_000;

/**
 * Refuses a write whose target, or else the nearest part of its path that
 * exists, resolves outside the Folder root. `validatePath` is lexical, so on
 * its own a write follows any directory link the checkout contains; a new file
 * may also sit under directories the write is about to create.
 */
export async function assertWriteStaysInsideRoot(root: string, absoluteTarget: string): Promise<void> {
  const canonicalRoot = await realpath(resolve(root)).catch(() => null);
  if (!canonicalRoot) throw new FolderWriteError("not_found", "Project Folder directory not found on disk");
  for (let probe = resolve(absoluteTarget); ; probe = dirname(probe)) {
    const canonical = await realpath(probe).catch(() => null);
    if (canonical) {
      if (!isInside(canonical, canonicalRoot)) {
        throw new FolderWriteError("path_forbidden", "File path escapes the registered Folder root");
      }
      return;
    }
    if (dirname(probe) === probe) {
      throw new FolderWriteError("path_forbidden", "File path escapes the registered Folder root");
    }
  }
}

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
  if (bytes.includes(0)) {
    throw new FolderWriteError("not_text", "Files containing NUL bytes cannot be edited");
  }
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
    if (content !== null) {
      const bytes = encodeRestoredContent(content, options.restoreEncoding ?? "utf8");
      if (bytes.byteLength > MAX_WRITE_FILE_BYTES) {
        throw new FolderWriteError("too_large", `File is too large to write (max ${MAX_WRITE_FILE_BYTES} bytes)`);
      }
      return writeResolvedFile(resolved, content, bytes, options);
    }
    // Removing a file creates nothing: a missing parent means there is nothing to remove.
    const parent = await pinParent(resolved, false);
    let before: FileWriteState;
    try {
      before = parent ? await readState(parent, resolved, options) : missingState(resolved);
      assertExpected(before, options);
      if (parent && before.exists) await removePinned(parent, resolved.name, before as PinnedState);
    } finally {
      await parent?.close();
    }
    return {
      path: resolved.relative,
      exists: false,
      content: null,
      size: 0,
      line_count: 0,
      sha256: null,
      before: { path: before.path, exists: before.exists, content: before.content, sha256: before.sha256 },
    };
  });
}

/**
 * Every mutation runs through a pinned parent directory, never the path again.
 *
 * `resolveWriteTarget` checks names once; a process writing the same checkout
 * (an Agent in its workspace) can then swap a checked directory for a link to
 * anywhere and let this person's save follow it. So the parent is reached the
 * way `safeOpen` reads are — component by component without following links,
 * creating missing directories through the already-pinned parent — and the
 * preimage read, temporary write, recheck and rename are all relative to that
 * pinned directory. A link anywhere below the root refuses the save, as it
 * refuses a read.
 *
 * A pinned handle follows its directory if that directory (or one above it)
 * is renamed out of the root, so before and after the rename the whole chain
 * is proved to still hang from the root. Node has no `renameat`, so the
 * window between the first proof and the rename is narrowed, not closed: the
 * second proof catches a move inside it and refuses, so a save never
 * reports success for a file that is not in the Folder. The undo there
 * touches only this save's own file (by inode) and puts back the preimage —
 * the same inode, kept as a hard link during the save — with a no-clobber
 * `link`; when another writer got there first it leaves their file alone,
 * keeps the preimage link and says so (`undoMovedSave`).
 */
async function writeResolvedFile(
  resolved: ResolvedWriteTarget,
  content: string,
  bytes: Buffer,
  options: FileWriteOptions,
): Promise<FileWriteResult> {
  const preview = await pinParent(resolved, false);
  let before: FileWriteState;
  try {
    before = preview ? await readState(preview, resolved, options) : missingState(resolved);
  } finally {
    await preview?.close();
  }
  assertExpected(before, options);
  let parent: PinnedParent | null = null;
  try {
    parent = await pinParent(resolved, true);
    const pinned = parent!;
    const current = await readState(pinned, resolved, options);
    assertExpected(current, options);
    const mode = current.mode;
    const temporary = `${resolved.name}.rainver-write-${cryptoRandomId()}`;
    let preimage: string | null = null;
    try {
      const written = await createExclusive(pinned, temporary, bytes, mode);
      const latest = await readState(pinned, resolved, options);
      assertExpected(latest, options);
      if (latest.exists) preimage = await keepPreimage(pinned, resolved.name, latest);
      await pinned.assertStillInRoot();
      await rename(pinned.entry(temporary), pinned.entry(resolved.name));
      try {
        await pinned.assertStillInRoot();
      } catch (moved) {
        // The save landed in a directory moved out of the Folder: undo it there, or say what is left.
        const left = await undoMovedSave(pinned, resolved.name, written, preimage);
        preimage = null; // put back by the undo, or kept as recovery material: never removed below
        throw left ?? moved;
      }
    } finally {
      await unlink(pinned.entry(temporary)).catch(() => undefined);
      if (preimage) await unlink(pinned.entry(preimage)).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof FolderWriteError) throw error;
    throw new FolderWriteError("write_failed", error instanceof Error ? error.message : "File write failed");
  } finally {
    await parent?.close();
  }
  const sha256 = hash(bytes);
  return {
    path: resolved.relative,
    exists: true,
    content,
    size: bytes.byteLength,
    line_count: content.split(/\n/).length,
    sha256,
    before: { path: before.path, exists: before.exists, content: before.content, sha256: before.sha256 },
  };
}

/** A directory every later name is resolved in; `entry(name)` is a path that cannot leave it. */
interface PinnedParent {
  entry(name: string): string;
  noFollowFlags: number;
  /** Refuses unless every pinned directory is still the entry it was pinned as, under the root. */
  assertStillInRoot(): Promise<void>;
  /** Where the pinned directory is now, for an error that leaves recovery material in it. */
  location(): Promise<string>;
  close(): Promise<void>;
}

const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

/**
 * Pins the target's parent directory: a directory handle per component,
 * opened through `/proc/self/fd/<parent>/<name>` with `O_NOFOLLOW`, missing
 * components made with `mkdir` through the same pinned parent. Every handle in
 * the chain stays open so `assertStillInRoot` can prove each one is still the
 * named entry of the one above it, and the first is still the root.
 *
 * Linux only. macOS can refuse a link in one `open` (`O_NOFOLLOW_ANY`, as
 * Folder reads do) but Node has no `renameat`/`unlinkat` there, so a rename or
 * removal by pathname would follow a link swapped in after the check — a
 * person's restore could delete a same-named file outside the Folder. With no
 * safe equivalent, macOS and every other platform refuse Folder writes; reads
 * are unaffected. Returns null when a parent is missing and `create` is false.
 */
async function pinParent(resolved: ResolvedWriteTarget, create: boolean): Promise<PinnedParent | null> {
  const capability = await safeOpenCapability();
  if (capability.kind !== "linux_fd_paths") {
    throw new FolderWriteError(
      "write_failed",
      capability.kind === "darwin_nofollow_any"
        ? "Saving to a Folder is not supported on macOS: it has no directory-relative rename or removal, so a concurrent link swap could redirect the save. Edit the file locally."
        : `Race-free Folder writes are not supported here: ${capability.reason}`,
    );
  }
  const chain: Array<{ handle: FileHandle; name: string }> = [];
  const closeAll = async () => {
    for (const link of chain.reverse()) await link.handle.close().catch(() => undefined);
  };
  try {
    chain.push({ handle: await open(resolved.canonicalRoot, DIRECTORY_FLAGS), name: "" });
    for (const part of resolved.parentParts) {
      const next = `/proc/self/fd/${chain[chain.length - 1]!.handle.fd}/${part}`;
      let child: FileHandle | null = await openPinnedDirectory(next);
      if (!child) {
        if (!create) {
          await closeAll();
          return null;
        }
        await mkdir(next).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        child = await openPinnedDirectory(next);
        if (!child) throw new FolderWriteError("write_failed", "Folder directory disappeared while it was being created");
      }
      chain.push({ handle: child, name: part });
    }
  } catch (error) {
    await closeAll();
    throw error;
  }
  const handle = chain[chain.length - 1]!.handle;
  return {
    entry: (name) => `/proc/self/fd/${handle.fd}/${name}`,
    noFollowFlags: fsConstants.O_NOFOLLOW,
    assertStillInRoot: async () => {
      // The root is trusted by its canonical path, as `safeOpen` reads trust it.
      if (!sameInode(await stat(resolved.canonicalRoot).catch(() => null), await chain[0]!.handle.stat())) throw movedOutOfRoot();
      for (let index = 1; index < chain.length; index += 1) {
        const entry = await lstat(`/proc/self/fd/${chain[index - 1]!.handle.fd}/${chain[index]!.name}`).catch(() => null);
        if (!entry?.isDirectory() || !sameInode(entry, await chain[index]!.handle.stat())) throw movedOutOfRoot();
      }
    },
    location: () => readlink(`/proc/self/fd/${handle.fd}`).catch(() => "an unknown directory"),
    close: closeAll,
  };
}

function sameInode(a: { dev: number; ino: number } | null, b: { dev: number; ino: number }): boolean {
  return a !== null && a.dev === b.dev && a.ino === b.ino;
}

function movedOutOfRoot(): FolderWriteError {
  return new FolderWriteError("path_forbidden", "A directory on this path was moved or replaced during the save; nothing was saved to the Folder");
}

/** Creates `name` exclusively in the pinned directory with `bytes`; returns its inode. */
async function createExclusive(parent: PinnedParent, name: string, bytes: Buffer, mode: number | null): Promise<{ dev: number; ino: number }> {
  const handle = await open(parent.entry(name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | parent.noFollowFlags, mode ?? 0o644);
  try {
    await handle.writeFile(bytes);
    // The mode an `open` creates with is masked by the umask; keep the preimage's.
    if (mode !== null) await handle.chmod(mode);
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

/**
 * Keeps the preimage reachable during a save: a second name (hard link) for
 * the very file the checks just read, so an undo can put back that file — its
 * inode, mode and bytes — with one no-clobber `link`, never a re-creation.
 */
async function keepPreimage(parent: PinnedParent, name: string, latest: PinnedState): Promise<string> {
  const preimage = `${name}.rainver-preimage-${cryptoRandomId()}`;
  try {
    await link(parent.entry(name), parent.entry(preimage));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FolderWriteError("stale", "File was removed after it was opened");
    // No hard links here means no exact undo: refuse rather than save without one.
    throw new FolderWriteError("write_failed", `This filesystem cannot keep the previous version during a save (${code ?? "link failed"}); nothing was saved`);
  }
  if (!sameInode(await lstat(parent.entry(preimage)).catch(() => null), latest)) {
    await unlink(parent.entry(preimage)).catch(() => undefined); // only our extra name
    throw new FolderWriteError("stale", "File changed after it was opened");
  }
  return preimage;
}

/**
 * Undo a save whose directory left the Folder. Only the file this save wrote
 * (checked by inode after it is moved aside, so a concurrent replacement is
 * never removed) is taken out; the preimage goes back with `link`, which
 * fails rather than overwrite a file another writer created meanwhile.
 * Returns null when fully undone; otherwise an error naming what is left and
 * where — the preimage link is then kept, never deleted.
 */
async function undoMovedSave(
  parent: PinnedParent,
  name: string,
  written: { dev: number; ino: number },
  preimage: string | null,
): Promise<FolderWriteError | null> {
  const left = async (what: string) => new FolderWriteError(
    "write_failed",
    `A directory on this path was moved out of the Folder during the save and the save could not be fully undone there: ${what} (in ${await parent.location()}). Nothing was saved to the Folder.`,
  );
  const keptPreimage = preimage ? `; the previous version is kept as ${preimage}` : "";
  try {
    const aside = `${name}.rainver-undo-${cryptoRandomId()}`;
    if (!sameInode(await lstat(parent.entry(name)).catch(() => null), written)) {
      return await left(`${name} was replaced by another writer and was left as it is${keptPreimage}`);
    }
    await rename(parent.entry(name), parent.entry(aside));
    if (!sameInode(await lstat(parent.entry(aside)).catch(() => null), written)) {
      // Another writer replaced it between the check and the move: put theirs back, never over a newer one.
      const back = await link(parent.entry(aside), parent.entry(name)).then(() => true, () => false);
      if (back) await unlink(parent.entry(aside));
      return await left(`${name} was replaced by another writer${back ? " and was left as it is" : ` and is kept as ${aside}`}${keptPreimage}`);
    }
    await unlink(parent.entry(aside)); // the file this save wrote
    if (!preimage) return null;
    try {
      await link(parent.entry(preimage), parent.entry(name));
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === "EEXIST" ? "another writer created a new" : "could not put back the previous";
      return await left(`${reason} ${name}${keptPreimage}`);
    }
    await unlink(parent.entry(preimage)).catch(() => undefined);
    return null;
  } catch (error) {
    return await left(`${error instanceof Error ? error.message : "undo failed"}${keptPreimage}`);
  }
}

/**
 * Removes the checked file: it is moved aside under a private name (keeping
 * its inode and mode), proved to be the file that was checked, and deleted
 * only once its directory is proved still in the Folder; otherwise it goes
 * back with a no-clobber `link`.
 */
async function removePinned(parent: PinnedParent, name: string, before: PinnedState): Promise<void> {
  await parent.assertStillInRoot();
  const aside = `${name}.rainver-remove-${cryptoRandomId()}`;
  try {
    await rename(parent.entry(name), parent.entry(aside));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FolderWriteError("stale", "File was removed after it was opened");
    throw new FolderWriteError("write_failed", error instanceof Error ? error.message : "File removal failed");
  }
  const putBack = async (why: FolderWriteError): Promise<never> => {
    const back = await link(parent.entry(aside), parent.entry(name)).then(() => true, () => false);
    if (back) {
      await unlink(parent.entry(aside)).catch(() => undefined);
      throw why;
    }
    throw new FolderWriteError(
      "write_failed",
      `${why.message}. The file could not be put back because another file now has its name; it is kept as ${aside} (in ${await parent.location()})`,
    );
  };
  if (!sameInode(await lstat(parent.entry(aside)).catch(() => null), before)) {
    await putBack(new FolderWriteError("stale", "File changed after it was opened"));
  }
  try {
    await parent.assertStillInRoot();
  } catch (error) {
    await putBack(error instanceof FolderWriteError ? error : movedOutOfRoot());
  }
  await unlink(parent.entry(aside));
}

/** Opens one directory component without following a link; null when it does not exist. */
async function openPinnedDirectory(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR" || code === "ELOOP") {
      const entry = await lstat(path).catch(() => null);
      if (entry?.isSymbolicLink()) throw new FolderWriteError("path_forbidden", "File path contains a symbolic link");
      throw new FolderWriteError("path_forbidden", "A parent of this path is not a directory");
    }
    throw error;
  }
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
  // The target, or else the nearest part of its path that exists: a new file
  // may sit under directories the write is about to create. That part decides
  // containment, and the canonical path is it plus the part still to be made.
  let existing = absolute;
  let canonicalExisting = await realpath(existing).catch(() => null);
  while (!canonicalExisting && dirname(existing) !== existing) {
    existing = dirname(existing);
    canonicalExisting = await realpath(existing).catch(() => null);
  }
  if (!canonicalExisting || !isInside(canonicalExisting, canonicalRoot)) {
    throw new FolderWriteError("path_forbidden", "File path escapes the registered Folder root");
  }
  const canonicalPath = join(canonicalExisting, relative(existing, absolute));
  try {
    validatePath({
      path: canonicalPath,
      allowedRoot: canonicalRoot,
      mode: "write",
      protectedFolder: options.protectedFolder,
      allowUserWrite: true,
    });
  } catch (error) {
    if (error instanceof PathPolicyError) throw new FolderWriteError("path_forbidden", error.message);
    throw error;
  }
  const relativePath = relative(absoluteRoot, absolute).split("\\").join("/");
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new FolderWriteError("path_forbidden", "File paths must be relative to the registered Folder");
  }
  return {
    absolute,
    relative: relativePath,
    canonicalRoot,
    name: parts[parts.length - 1]!,
    parentParts: parts.slice(0, -1),
    lockKey: `${canonicalRoot}\u0000${absolute}`,
  };
}

interface ResolvedWriteTarget {
  absolute: string;
  relative: string;
  canonicalRoot: string;
  /** The final component and the directories above it, relative to the canonical root. */
  name: string;
  parentParts: string[];
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
    releaseFileLock = await acquireFolderWriteLock(key);
    return await work();
  } finally {
    await releaseFileLock?.();
    release();
    if (writeLocks.get(key) === current) writeLocks.delete(key);
  }
}

/**
 * Serialize writes across separate server/daemon processes of this user on one
 * machine. The lock lives in a directory only this user can use — a shared
 * `/tmp` name another account could pre-create would block every save.
 *
 * The lock is a directory that is never empty while held: it holds exactly one
 * file named by its holder's unique token (pid, process start time, random
 * id). It is taken by renaming a private, already-filled candidate directory
 * onto the lock name, which fails while a holder's directory is there, so
 * there is no moment a half-made lock can be stolen. Taking over from a dead
 * holder and releasing are both "unlink this exact token, then `rmdir`": the
 * unlink succeeds for one process only, and `rmdir` removes only an empty
 * directory, so no process can remove a lock that a live holder has since
 * taken. A holder is dead only when its pid is gone or (Linux) now belongs to
 * a process with a different start time; a live holder is never taken over
 * however long it runs — waiting gives up after `WRITE_LOCK_MAX_WAIT_MS`.
 * Exported for the cross-process tests.
 */
export async function acquireFolderWriteLock(key: string): Promise<() => Promise<void>> {
  const lockPath = folderWriteLockPath(key);
  const lockDirectory = dirname(lockPath);
  await ensurePrivateLockDirectory(lockDirectory);
  const token = `${HOLDER_PREFIX}${process.pid}-${processStartTime(process.pid) ?? "x"}-${cryptoRandomId()}`;
  const candidate = `${lockPath}.candidate-${cryptoRandomId()}`;
  const failed = (error: unknown) =>
    new FolderWriteError("write_failed", error instanceof Error ? error.message : "Could not acquire file write lock");
  try {
    await mkdir(candidate, { mode: 0o700 });
    await writeFile(join(candidate, token), "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    await removeEmptiedDirectory(candidate, token);
    throw failed(error);
  }
  const deadline = Date.now() + WRITE_LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      await rename(candidate, lockPath);
      return () => removeEmptiedDirectory(lockPath, token);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") {
        await removeEmptiedDirectory(candidate, token);
        throw failed(error);
      }
    }
    const holder = await deadHolder(lockPath);
    if (holder) {
      await removeEmptiedDirectory(lockPath, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      await removeEmptiedDirectory(candidate, token);
      throw new FolderWriteError("write_failed", "Another save of this file is still in progress; try again");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, WRITE_LOCK_WAIT_MS));
  }
}

const HOLDER_PREFIX = "holder-";

/** Unlinks `directory/name`, then removes `directory` only if that left it empty. */
async function removeEmptiedDirectory(directory: string, name: string): Promise<void> {
  try {
    await unlink(join(directory, name));
  } catch {
    return; // not (or no longer) ours: leave the directory to whoever holds it
  }
  await rmdir(directory).catch(() => undefined);
}

/** The lock's holder entry when that holder is gone; null while it lives or cannot be judged. */
async function deadHolder(lockPath: string): Promise<string | null> {
  const entries = await readdir(lockPath).catch(() => null);
  if (!entries || entries.length !== 1) return null;
  const entry = entries[0]!;
  // `holder` is the previous format: a file holding "<pid> <time>".
  const pidText = entry === "holder"
    ? (await readFile(join(lockPath, entry), "utf8").catch(() => "")).split(" ")[0]
    : entry.startsWith(HOLDER_PREFIX) ? entry.slice(HOLDER_PREFIX.length).split("-")[0] : "";
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const started = entry === "holder" ? "x" : entry.slice(HOLDER_PREFIX.length).split("-")[1];
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? entry : null;
  }
  // Alive: still the holder unless the pid was reused by a process started later.
  const now = started && started !== "x" ? processStartTime(pid) : null;
  return now !== null && now !== started ? entry : null;
}

/** The kernel's start time of `pid` (Linux `/proc/<pid>/stat` field 22); null elsewhere. */
function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** The cross-process lock for one target. Exported for the race tests. */
export function folderWriteLockPath(key: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().username;
  return join(tmpdir(), `rainver-folder-write-locks-${uid}`, `${hash(Buffer.from(key, "utf8"))}.lock`);
}

async function ensurePrivateLockDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw new FolderWriteError("write_failed", error.message);
  });
  const info = await lstat(directory);
  const ownerOk = typeof process.getuid !== "function" || info.uid === process.getuid();
  if (!info.isDirectory() || info.isSymbolicLink() || !ownerOk || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new FolderWriteError("write_failed", `The Folder write lock directory ${directory} is not private to this user`);
  }
}

/** The preimage's mode and inode: an undo puts back that very file, and a removal removes only it. */
type PinnedState = FileWriteState & { mode: number | null; dev: number; ino: number };

function missingState(resolved: ResolvedWriteTarget): PinnedState {
  return { path: resolved.relative, exists: false, content: null, sha256: null, mode: null, dev: -1, ino: -1 };
}

/** The target as it is now, read through the pinned parent and never through a link. */
async function readState(
  parent: PinnedParent,
  resolved: ResolvedWriteTarget,
  options: Pick<FileWriteOptions, "allowEncodingConversion">,
): Promise<PinnedState> {
  const relativePath = resolved.relative;
  let handle: FileHandle;
  try {
    handle = await open(parent.entry(resolved.name), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY | parent.noFollowFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return missingState(resolved);
    if (code === "ELOOP") throw new FolderWriteError("path_forbidden", "File path contains a symbolic link");
    throw new FolderWriteError("write_failed", (error as Error).message);
  }
  let bytes: Buffer;
  let mode: number;
  let identity: { dev: number; ino: number };
  try {
    const info = await handle.stat();
    identity = { dev: info.dev, ino: info.ino };
    if (info.isDirectory()) throw new FolderWriteError("is_directory", "Path is a directory");
    if (!info.isFile()) throw new FolderWriteError("path_forbidden", "Only regular files can be edited");
    if (info.size > MAX_WRITE_FILE_BYTES) throw new FolderWriteError("too_large", `File is too large to edit (max ${MAX_WRITE_FILE_BYTES} bytes)`);
    mode = info.mode & 0o777;
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.byteLength > MAX_WRITE_FILE_BYTES) throw new FolderWriteError("too_large", `File is too large to edit (max ${MAX_WRITE_FILE_BYTES} bytes)`);
  // No link was followed to reach this file, so the name `resolveWriteTarget`
  // validated is the file read here: no second policy check on a link target.
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    if (options.allowEncodingConversion) {
      const decoded = decodeFileBytes(bytes, { includeUtf16Preview: true });
      if ((decoded.encoding === "utf16le" || decoded.encoding === "utf16be") && decoded.conversion_available) {
        return { path: relativePath, exists: true, content: decoded.content, sha256: hash(bytes), mode, ...identity };
      }
    }
    throw new FolderWriteError("not_text", "Only UTF-8 text files can be edited");
  }
  if (bytes.includes(0)) {
    throw new FolderWriteError("not_text", "Files containing NUL bytes cannot be edited");
  }
  return { path: relativePath, exists: true, content, sha256: hash(bytes), mode, ...identity };
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

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cryptoRandomId(): string {
  return randomUUID();
}
