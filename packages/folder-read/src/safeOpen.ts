import { constants } from "node:fs";
import { lstat, mkdtemp, open, mkdir, realpath, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Opening a file inside a registered root without a path race.
 *
 * `validatePath` decides, lexically, that `root/a/b/c.txt` may be read. Between
 * that decision and a path-based `open`, any component may be replaced by a
 * symbolic link, which `open` would follow out of the root. A final-component
 * `O_NOFOLLOW` protects only `c.txt`; `a` and `b` are the usual target. The
 * only defence is to make the kernel resolve each untrusted component without
 * following links, and then to do every later check — type, size, content —
 * on the handle that resolution produced, never on the name again.
 *
 * Node has no `openat`, so the mechanism is per platform:
 *
 * - **Linux**: open the (trusted, canonicalised) root as a directory handle,
 *   then each component relative to the previous handle through
 *   `/proc/self/fd/<fd>/<name>` with `O_NOFOLLOW`. The same mechanism as the
 *   server's `code_patch` target.
 * - **macOS**: `O_NOFOLLOW_ANY` (macOS 11+, which is every macOS Node 24
 *   runs on) makes one `open` fail with `ELOOP` if *any* component of the path
 *   is a link. The whole resolution is one syscall, so there is no window.
 * - **Anything else**: refused as unsupported. There is no unsafe fallback.
 *
 * Both mechanisms are proved once per process before first use: a temporary
 * directory with a linked component must be refused, and a plain path must be
 * accepted. A platform where the probe does not hold is treated as unsupported
 * rather than trusted on the strength of its name.
 */
export type SafeOpenCapability =
  | { kind: "linux_fd_paths" }
  | { kind: "darwin_nofollow_any" }
  | { kind: "unsupported"; reason: string };

export type SafeOpenFailureCode = "symlink" | "not_found" | "not_directory" | "unsupported_platform";

export class SafeOpenError extends Error {
  constructor(readonly code: SafeOpenFailureCode, message: string) {
    super(message);
    this.name = "SafeOpenError";
  }
}

/** macOS `fcntl.h`: refuse the open when any path component is a symbolic link. */
const O_NOFOLLOW_ANY = 0x20000000;

const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

let capabilityProbe: Promise<SafeOpenCapability> | null = null;

/** The mechanism this process can use, proved once and then remembered. */
export function safeOpenCapability(): Promise<SafeOpenCapability> {
  capabilityProbe ??= probeCapability().catch((error: unknown) => {
    capabilityProbe = null;
    throw error;
  });
  return capabilityProbe;
}

async function probeCapability(): Promise<SafeOpenCapability> {
  if (process.platform === "linux") {
    const held = await probeWith((root, relative) => openLinuxFdPath(root, relative));
    return held ? { kind: "linux_fd_paths" } : { kind: "unsupported", reason: "Linux /proc/self/fd path resolution is unavailable in this process" };
  }
  if (process.platform === "darwin") {
    const held = await probeWith((root, relative) => openDarwinNoFollowAny(root, relative));
    return held ? { kind: "darwin_nofollow_any" } : { kind: "unsupported", reason: "O_NOFOLLOW_ANY is not honoured by this macOS kernel" };
  }
  return { kind: "unsupported", reason: `Race-free Folder file reads are not implemented for ${process.platform}` };
}

/**
 * The proof: `real/file.txt` opens, `linked/file.txt` (where `linked` is a
 * link to `real`) is refused as a symlink, and so is a final-component link.
 * A mechanism that follows either link is not a boundary.
 */
async function probeWith(opener: (root: string, relative: readonly string[]) => Promise<FileHandle>): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "rainver-safe-open-"));
  try {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "file.txt"), "probe");
    await symlink(join(root, "real"), join(root, "linked"));
    await symlink(join(root, "real", "file.txt"), join(root, "real", "link.txt"));
    const canonicalRoot = await realpath(root);
    const plain = await opener(canonicalRoot, ["real", "file.txt"]);
    await plain.close();
    for (const linked of [["linked", "file.txt"], ["real", "link.txt"]] as const) {
      let handle: FileHandle | null = null;
      try {
        handle = await opener(canonicalRoot, linked);
      } catch (error) {
        if (error instanceof SafeOpenError && error.code === "symlink") continue;
        throw error;
      } finally {
        await handle?.close();
      }
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Opens `relative` (already validated, no `.`/`..`/empty components) under
 * `root` without following any symbolic link below the root. The root itself
 * is trusted — it is the registered directory — and is canonicalised first so
 * that a root reached through a link (`/tmp` on macOS) still opens.
 *
 * The caller owns the returned handle and every later check runs on it.
 */
export async function openFileBeneathRoot(root: string, relative: readonly string[]): Promise<FileHandle> {
  if (relative.length === 0) throw new SafeOpenError("not_found", "A file path is required");
  const capability = await safeOpenCapability();
  if (capability.kind === "unsupported") throw new SafeOpenError("unsupported_platform", capability.reason);
  const canonicalRoot = await realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new SafeOpenError("not_found", "Project Folder directory not found on disk");
    throw error;
  });
  return capability.kind === "linux_fd_paths"
    ? openLinuxFdPath(canonicalRoot, relative)
    : openDarwinNoFollowAny(canonicalRoot, relative);
}

async function openLinuxFdPath(canonicalRoot: string, relative: readonly string[]): Promise<FileHandle> {
  const directories: FileHandle[] = [];
  try {
    directories.push(await open(canonicalRoot, DIRECTORY_FLAGS).catch(rethrowAsSafeOpen));
    for (const component of relative.slice(0, -1)) {
      const parent = directories[directories.length - 1]!;
      directories.push(await openDirectoryComponent(join(`/proc/self/fd/${parent.fd}`, component)));
    }
    const parent = directories[directories.length - 1]!;
    return await open(join(`/proc/self/fd/${parent.fd}`, relative[relative.length - 1]!), FILE_FLAGS).catch(rethrowAsSafeOpen);
  } finally {
    for (const directory of directories.reverse()) await directory.close();
  }
}

/**
 * `O_DIRECTORY | O_NOFOLLOW` on a link to a directory answers `ENOTDIR` on
 * Linux, the same errno as a regular file in the middle of the path. The two
 * are told apart with `lstat` through the still-open parent handle: the parent
 * is pinned, so the answer is about this component and nothing an attacker
 * swapped above it. Both outcomes refuse the read; only the reason differs.
 */
async function openDirectoryComponent(path: string): Promise<FileHandle> {
  try {
    return await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOTDIR") {
      const entry = await lstat(path).catch(() => null);
      if (entry?.isSymbolicLink()) throw new SafeOpenError("symlink", "Path contains a symbolic link");
    }
    return rethrowAsSafeOpen(failure);
  }
}

async function openDarwinNoFollowAny(canonicalRoot: string, relative: readonly string[]): Promise<FileHandle> {
  return open(join(canonicalRoot, ...relative), FILE_FLAGS | O_NOFOLLOW_ANY).catch(rethrowAsSafeOpen);
}

function rethrowAsSafeOpen(error: NodeJS.ErrnoException): never {
  switch (error.code) {
    case "ELOOP":
      throw new SafeOpenError("symlink", "Path contains a symbolic link");
    case "ENOENT":
      throw new SafeOpenError("not_found", "File not found");
    case "ENOTDIR":
      throw new SafeOpenError("not_directory", "File not found");
    default:
      throw error;
  }
}
