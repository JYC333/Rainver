import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readlink, realpath, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

/**
 * Extracts a zip archive with no help from the machine.
 *
 * A managed runtime's archive is what the ACP registry publishes, and the
 * registry publishes zips for every platform (Antigravity, for one). A
 * daemon that shelled out to `unzip` installed nothing on a host without
 * it — a stock Ubuntu or WSL image — and the failure was "unzip could not
 * be started", which told the person to go find a package rather than that
 * the daemon had a gap. The tarball path keeps `tar`, which every supported
 * OS ships; zip is the one format that needs this.
 *
 * What `unzip` did that matters here and is kept: Unix modes from the
 * central directory (the executable bit on the agent binary), directory
 * entries, and symlink entries as symlinks. What it did not do and this
 * does: refuse an entry whose name escapes the destination, because the
 * archive is content fetched from a URL a registry named.
 *
 * Names alone are not enough once links exist: `a -> ../outside` followed by
 * `a/f` names a contained path that writes outside. So, as GNU tar does,
 * links are created only after every file and directory is written, no entry
 * may sit below a link entry, every parent directory is walked with `lstat`
 * and must be a real directory (a link already in the destination is
 * refused), files open with `O_EXCL | O_NOFOLLOW` (never overwrite, never
 * through a final link), and each link target must be relative and resolve
 * inside the destination — checked when it is made and again once all links
 * exist, because a later link can redirect an earlier one. The destination is
 * the daemon's own tool directory with no concurrent writer, which is what
 * makes these checks sufficient here. Setuid, setgid and sticky bits are
 * dropped; the executable bit is kept. On failure, what was created is removed
 * — files and links it made, and directories it made only once empty, never
 * recursively, so content that was already in the destination stays.
 */
export async function extractZip(archive: string, destination: string): Promise<void> {
  await mkdir(resolve(destination), { recursive: true });
  // Containment is judged on the real path: a destination under a linked
  // directory (macOS /var -> /private/var) is the caller's choice, not the archive's.
  const root = await realpath(resolve(destination));
  const state: ExtractState = { root, links: [], linkNames: new Set(), created: [] };
  const zip = await new Promise<yauzl.ZipFile>((resolvePromise, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (error, file) => (error ? reject(error) : resolvePromise(file)));
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      zip.on("error", reject);
      zip.on("end", resolvePromise);
      zip.on("entry", (entry: yauzl.Entry) => {
        extractEntry(zip, entry, state).then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
    for (const link of state.links) {
      await assertLinkContained(root, link.path, link.target);
      await symlink(link.target, link.path);
      state.created.push({ path: link.path, directory: false });
    }
    // A later link can redirect an earlier one (`x -> d/../y`, then `d -> .`);
    // with every link in place and nothing written after, this is final.
    for (const link of state.links) await assertLinkContained(root, link.path, link.target);
  } catch (error) {
    for (const { path, directory } of state.created.reverse()) {
      await (directory ? rmdir(path) : rm(path, { force: true })).catch(() => undefined);
    }
    throw error;
  } finally {
    zip.close();
  }
}

interface ExtractState {
  root: string;
  links: Array<{ path: string; target: string }>;
  linkNames: Set<string>;
  /** Paths this extraction created, in creation order, for cleanup on failure. */
  created: Array<{ path: string; directory: boolean }>;
}

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

async function extractEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, state: ExtractState): Promise<void> {
  const { root } = state;
  const target = resolve(root, entry.fileName);
  if (target === root ? !entry.fileName.endsWith("/") : !target.startsWith(root + sep)) {
    throw new Error(`Archive entry escapes the tool directory: ${entry.fileName}`);
  }
  const parts = relative(root, target).split(sep).filter(Boolean);
  for (let index = 1; index <= parts.length; index += 1) {
    const prefix = parts.slice(0, index).join(sep);
    if (state.linkNames.has(prefix)) throw new Error(`Archive entry lies below a link entry: ${entry.fileName}`);
  }
  // The high 16 bits are the Unix mode when the archive was made on one
  // (PKZIP APPNOTE 4.4.2.2, "version made by" 3); otherwise they are zero and
  // a file gets a plain default. yauzl exposes the raw attribute word.
  const mode = (entry.externalFileAttributes >>> 16) & 0o777;
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (entry.fileName.endsWith("/") || type === 0o040000) {
    await ensureRealDirectory(state, parts);
    return;
  }
  if (type !== 0 && type !== 0o100000 && type !== 0o120000) {
    throw new Error(`Archive entry has an unsupported file type: ${entry.fileName}`);
  }
  await ensureRealDirectory(state, parts.slice(0, -1));
  if (type === 0o120000) {
    const linkTarget = (await readEntry(zip, entry)).toString("utf8");
    await assertLinkContained(root, target, linkTarget);
    state.linkNames.add(parts.join(sep));
    state.links.push({ path: target, target: linkTarget });
    return;
  }
  // O_EXCL: never replace an existing file or follow an existing link at the
  // final component; a duplicate entry is an error, not an overwrite.
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;
  const handle = await open(target, flags, mode || 0o644).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error(`Archive entry already exists in the tool directory: ${entry.fileName}`);
    throw error;
  });
  state.created.push({ path: target, directory: false });
  await pipeline(await openEntry(zip, entry), handle.createWriteStream());
  // `createWriteStream`'s mode is masked by the umask; the executable bit
  // the archive carried is what makes the agent launchable, so set it plainly.
  if (mode) await chmod(target, mode);
}

/** Creates `root/parts...` one component at a time; every existing one must be a real directory. */
async function ensureRealDirectory(state: ExtractState, parts: string[]): Promise<void> {
  let current = state.root;
  for (const part of parts) {
    current = join(current, part);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isDirectory()) continue;
    if (existing?.isSymbolicLink()) throw new Error(`Archive entry would pass through a link in the tool directory: ${relative(state.root, current)}`);
    if (existing) throw new Error(`Archive directory already exists as a file: ${relative(state.root, current)}`);
    await mkdir(current);
    state.created.push({ path: current, directory: true });
  }
}

/**
 * A link target must be relative and, resolved from the link's directory
 * through whatever exists on disk now, stay inside the destination.
 */
async function assertLinkContained(root: string, linkPath: string, linkTarget: string): Promise<void> {
  if (!linkTarget || linkTarget.includes("\0") || isAbsolute(linkTarget) || win32.isAbsolute(linkTarget) || /^[a-zA-Z]:/.test(linkTarget)) {
    throw new Error(`Archive link target is not a contained relative path: ${relative(root, linkPath)} -> ${linkTarget}`);
  }
  const resolved = await resolveThroughDisk(await realpath(dirname(linkPath)), linkTarget, 0);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Archive link target escapes the tool directory: ${relative(root, linkPath)} -> ${linkTarget}`);
  }
}

/**
 * Resolves `target` from the real directory `base` one component at a time
 * the way the kernel would: `..` after a followed link climbs from where the
 * link led, not from its name. Missing components are taken literally.
 */
async function resolveThroughDisk(base: string, target: string, depth: number): Promise<string> {
  if (depth > 40) throw new Error("Archive link chain is too deep");
  let current = isAbsolute(target) ? sep : base;
  for (const part of target.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    const info = await lstat(next).catch(() => null);
    current = info?.isSymbolicLink() ? await resolveThroughDisk(current, await readlink(next), depth + 1) : next;
  }
  return current;
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolvePromise(stream)));
  });
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await openEntry(zip, entry)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
