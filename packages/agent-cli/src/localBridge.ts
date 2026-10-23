import { constants, watch } from "node:fs";
import { lstat, mkdtemp, open, readdir, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseToolRequest, TOOL_REQUEST_LIMIT, TOOL_RESPONSE_LIMIT, type ToolRequest, type ToolResponse } from "./toolHttp.ts";

const REQUEST_NAME = /^[a-f0-9-]{36}\.request$/;
const NOFOLLOW = constants.O_NOFOLLOW;

/** Bounded regular files only: neither symlinks nor hardlinks may cross the bridge. */
async function readJson(path: string, limit: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error("Invalid or oversized bridge file");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new Error("Bridge file changed while reading");
    return JSON.parse(buffer.toString("utf8", 0, length));
  } finally { await file.close(); }
}

async function publish(pinned: PinnedDirectory, name: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  // JSON escaping can expand the HTTP body, so bound the envelope separately.
  if (Buffer.byteLength(text) > TOOL_RESPONSE_LIMIT * 6 + 1024) throw new Error("Oversized bridge response");
  // O_EXCL refuses a planted file or symlink at the temporary name.
  await writeFile(await pinned.at(`${name}.tmp`), text, { flag: "wx", mode: 0o600 });
  await rename(await pinned.at(`${name}.tmp`), await pinned.at(name));
}

/** Host platforms whose bridge directory can be pinned; others are offered no file channel. */
export function localToolBridgeSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}

/**
 * The bridge directory as opened once. Every operation names a child through
 * `at()`, so a sandbox that renames the directory or puts a symlink in its
 * place cannot redirect Host I/O elsewhere.
 */
interface PinnedDirectory {
  file: FileHandle;
  /** Change hints only; never used for I/O. */
  watchPath: string;
  /** A child path (or the directory itself) resolved through the pin, verified first where needed. */
  at(name?: string): Promise<string>;
  /** Fails unless the original path still names the pinned directory itself. */
  verifyPath(): Promise<void>;
}

/**
 * Linux resolves children through `/proc/self/fd/<fd>`, which follows the open
 * descriptor rather than the path. macOS has no such path and Node exposes no
 * `openat`, so the descriptor is held open (its inode cannot be recycled) and
 * the path is re-checked against that device/inode with `lstat` before every
 * child operation: a replaced directory or a symlink fails closed.
 */
async function anchor(root: string): Promise<PinnedDirectory> {
  const platform = process.platform;
  if (!localToolBridgeSupported(platform)) throw new Error("The Rainver local tool bridge requires a Linux or macOS Host");
  const file = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  try {
    const pinned = await file.stat();
    if (!pinned.isDirectory()) throw new Error("The Rainver tool bridge is not a directory");
    const verifyPath = async () => {
      const current = await lstat(root);
      if (!current.isDirectory() || current.dev !== pinned.dev || current.ino !== pinned.ino) {
        throw new Error("This Run's Rainver tool bridge directory was replaced");
      }
    };
    if (platform === "linux") {
      const procfs = `/proc/self/fd/${file.fd}`;
      return { file, verifyPath, watchPath: procfs, at: async (name = "") => join(procfs, name) };
    }
    await verifyPath();
    return { file, verifyPath, watchPath: root, at: async (name = "") => { await verifyPath(); return join(root, name); } };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export interface LocalToolBridge { directory: string; close(): Promise<void> }

/**
 * File IPC deliberately survives a shell sandbox that prohibits every socket.
 * No domain code, credential, URL, or Run identity is accepted from the caller.
 * The Host supplies a handler bound to this launch's existing REST identity.
 */
export async function startLocalToolBridge(
  parent: string,
  invoke: (request: ToolRequest, signal: AbortSignal) => Promise<ToolResponse>,
): Promise<LocalToolBridge> {
  const directory = await mkdtemp(join(parent, "tools-"));
  const pinned = await anchor(directory);
  const abort = new AbortController();
  const pending = new Set<Promise<void>>();
  const processing = new Set<string>();
  let scanning = false;
  let closed = false;
  await writeFile(await pinned.at("active"), "1", { flag: "wx", mode: 0o600 });
  async function execute(name: string): Promise<void> {
    processing.add(name);
    const claimed = `${name}.working`;
    const responseName = name.replace(/\.request$/, ".response");
    try {
      await rename(await pinned.at(name), await pinned.at(claimed));
      const request = parseToolRequest(await readJson(await pinned.at(claimed), TOOL_REQUEST_LIMIT));
      if (`${request.id}.request` !== name) throw new Error("Bridge request id mismatch");
      if (closed) throw new Error("This Run's tool bridge has stopped");
      const response = await invoke(request, abort.signal);
      await publish(pinned, responseName, response);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await publish(pinned, responseName, { error: error instanceof Error ? error.message : "Tool bridge failed" }).catch(() => {});
      }
    } finally {
      await pinned.at(claimed).then(unlink).catch(() => {});
      processing.delete(name);
    }
  }
  async function scan(): Promise<void> {
    if (closed || scanning || pending.size >= 8) return;
    scanning = true;
    try {
      const names = await readdir(await pinned.at());
      for (const name of names) {
        if (closed || pending.size >= 8) break;
        if (!REQUEST_NAME.test(name) || processing.has(name)) continue;
        // A completed request is never automatically dispatched again.
        if (names.includes(name.replace(/\.request$/, ".response"))) continue;
        const promise = execute(name);
        pending.add(promise);
        void promise.finally(() => { pending.delete(promise); }).catch(() => {});
      }
    } catch { /* A removed directory is handled by launch cleanup/client timeout. */ }
    finally { scanning = false; }
  }
  // Notifications are hints. The fallback also drains requests left after concurrency limits.
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(pinned.watchPath, () => { void scan(); });
    watcher.on("error", () => {});
  } catch { /* The polling fallback also works when inotify watchers are exhausted. */ }
  const timer = setInterval(() => { void scan(); }, 250);
  timer.unref();
  return {
    directory,
    async close() {
      if (closed) return;
      closed = true;
      watcher?.close();
      clearInterval(timer);
      await pinned.at("active").then(unlink).catch(() => {});
      abort.abort();
      await Promise.allSettled([...pending]);
      // A path that no longer names this directory is left alone, never removed recursively.
      const removable = await pinned.verifyPath().then(() => true, () => false);
      await pinned.file.close();
      if (removable) await rm(directory, { recursive: true, force: true });
    },
  };
}

/** One invocation, no automatic retries or fallback to unrestricted networking. */
export async function localToolRequest(directory: string, input: ToolRequest, timeoutMs = 35_000): Promise<ToolResponse> {
  const request = parseToolRequest(input);
  const text = JSON.stringify(request);
  if (Buffer.byteLength(text) > TOOL_REQUEST_LIMIT) throw new Error("Rainver tool request is too large");
  const pinned = await anchor(directory);
  const responseName = `${request.id}.response`;
  const requestName = `${request.id}.request`;
  const started = Date.now();
  try {
    await readJson(await pinned.at("active"), 16);
    await publish(pinned, requestName, request);
    while (Date.now() - started < timeoutMs) {
      try {
        const response = await readJson(await pinned.at(responseName), TOOL_RESPONSE_LIMIT * 6 + 1024) as Partial<ToolResponse> & { error?: string };
        if (typeof response.error === "string") throw new Error(response.error);
        if (!Number.isInteger(response.status) || typeof response.text !== "string") throw new Error("Invalid Rainver bridge response");
        return response as ToolResponse;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await readJson(await pinned.at("active"), 16);
      await delay(25);
    }
    throw new Error("Rainver tool response timed out; the action outcome is unknown. Do not blindly repeat a write.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("This Run's Rainver tool bridge is no longer available");
    throw error;
  } finally {
    await pinned.at(requestName).then(unlink).catch(() => {});
    await pinned.at(responseName).then(unlink).catch(() => {});
    await pinned.file.close();
  }
}
