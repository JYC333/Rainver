import { createWriteStream } from "node:fs";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
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
 */
export async function extractZip(archive: string, destination: string): Promise<void> {
  const root = resolve(destination);
  const zip = await new Promise<yauzl.ZipFile>((resolvePromise, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (error, file) => (error ? reject(error) : resolvePromise(file)));
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      zip.on("error", reject);
      zip.on("end", resolvePromise);
      zip.on("entry", (entry: yauzl.Entry) => {
        extractEntry(zip, entry, root).then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function extractEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, root: string): Promise<void> {
  const target = resolve(root, entry.fileName);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Archive entry escapes the tool directory: ${entry.fileName}`);
  }
  // The high 16 bits are the Unix mode when the archive was made on one
  // (PKZIP APPNOTE 4.4.2.2, "version made by" 3); otherwise they are zero and
  // a file gets a plain default. yauzl exposes the raw attribute word.
  const mode = (entry.externalFileAttributes >>> 16) & 0o7777;
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (entry.fileName.endsWith("/") || type === 0o040000) {
    await mkdir(target, { recursive: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  if (type === 0o120000) {
    const linkTarget = (await readEntry(zip, entry)).toString("utf8");
    await symlink(linkTarget, target);
    return;
  }
  const stream = await openEntry(zip, entry);
  await pipeline(stream, createWriteStream(target, { mode: mode || 0o644 }));
  // `createWriteStream`'s mode is masked by the umask; the executable bit
  // the archive carried is what makes the agent launchable, so set it plainly.
  if (mode) await chmod(target, mode);
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
