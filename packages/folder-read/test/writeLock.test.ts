import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFolderWriteLock, folderWriteLockPath } from "../src/write.js";

/**
 * The cross-process Folder write lock, exercised by real separate Node
 * processes running this package's source (no mocks): several processes race
 * to take over a dead holder's lock at the same instant, a live holder is
 * never removed, and a release removes only the releaser's own lock.
 */
const source = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "write.ts")).href;

/**
 * Runs `body` in a child process with `acquireFolderWriteLock` imported from
 * the TypeScript source. With `slowTakeover`, the first removal the lock code
 * makes of a lock (or of a holder entry in it) — the takeover of a dead
 * holder — first says "pausing" and waits 300 ms, so another process can judge
 * the same holder dead and take the lock inside that window.
 */
function child(body: string, args: string[] = [], slowTakeover = false): ChildProcess {
  const script = `
    import { registerHooks } from "node:module";
    const wrapper = "data:text/javascript," + encodeURIComponent(\`
      import * as real from "node:fs/promises";
      export * from "node:fs/promises";
      let paused = false;
      const pause = async (path) => {
        const parts = String(path).split("/");
        const lockOrHolder = parts.at(-1).endsWith(".lock") || (parts.at(-2).endsWith(".lock") && parts.at(-1).startsWith("holder"));
        if (paused || !lockOrHolder) return;
        paused = true;
        console.log("pausing");
        await new Promise((resolve) => setTimeout(resolve, 300));
      };
      export async function rm(path, options) { await pause(path); return real.rm(path, options); }
      export async function unlink(path) { await pause(path); return real.unlink(path); }
    \`);
    registerHooks({ resolve(spec, context, next) {
      if (${slowTakeover} && spec === "node:fs/promises" && context.parentURL?.endsWith("/write.ts")) return { url: wrapper, shortCircuit: true };
      if (spec.startsWith(".") && spec.endsWith(".js") && context.parentURL?.endsWith(".ts")) spec = spec.slice(0, -3) + ".ts";
      return next(spec, context);
    } });
    const { acquireFolderWriteLock } = await import(${JSON.stringify(source)});
    const [key, log] = process.argv.slice(1);
    ${body}
  `;
  return spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const said = (process: ChildProcess, word: string) => new Promise<void>((resolve, reject) => {
  let errors = "";
  process.stderr!.on("data", (chunk) => { errors += chunk; });
  process.stdout!.on("data", (chunk) => { if (String(chunk).includes(word)) resolve(); });
  process.once("exit", () => reject(new Error(`child exited before "${word}": ${errors}`)));
});

const exited = (process: ChildProcess) => new Promise<number | null>((resolve) => {
  if (process.exitCode !== null || process.signalCode !== null) resolve(process.exitCode);
  else process.once("exit", (code) => resolve(code));
});

/** A child that takes the lock, says so, and holds it until killed. */
async function holder(key: string): Promise<ChildProcess> {
  const process = child(`await acquireFolderWriteLock(key); console.log("held"); setInterval(() => {}, 1000);`, [key]);
  await said(process, "held");
  return process;
}

/** Takes the lock, logs entering, holds it `ms`, logs leaving, releases. */
const critical = (ms: number) => `
  const { appendFileSync } = await import("node:fs");
  const release = await acquireFolderWriteLock(key);
  appendFileSync(log, process.pid + " enter\\n");
  await new Promise((resolve) => setTimeout(resolve, ${ms}));
  appendFileSync(log, process.pid + " exit\\n");
  await release();
`;

let key: string;
let work: string;
const running: ChildProcess[] = [];

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "rainver-write-lock-"));
  key = `${work}:${randomUUID()}`;
});

afterEach(async () => {
  for (const process of running.splice(0)) process.kill("SIGKILL");
  for (const lock of [key, `${key}-other`]) await rm(folderWriteLockPath(lock), { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("Folder write lock across processes", () => {
  it("lets two processes that both judged the same dead holder gone in one at a time", async () => {
    const dead = await holder(key);
    dead.kill("SIGKILL");
    await exited(dead);
    const log = join(work, "log");
    await writeFile(log, "");
    // Slow judges the holder dead and pauses before removing it; fast then judges
    // it dead too, removes it, and is inside its critical section when slow resumes.
    const slow = child(critical(50), [key, log], true);
    running.push(slow);
    await said(slow, "pausing");
    const fast = child(critical(700), [key, log]);
    running.push(fast);
    expect(await Promise.all([exited(slow), exited(fast)])).toEqual([0, 0]);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines).toEqual([`${fast.pid} enter`, `${fast.pid} exit`, `${slow.pid} enter`, `${slow.pid} exit`]);
    await expect(stat(folderWriteLockPath(key))).rejects.toMatchObject({ code: "ENOENT" });
    const name = folderWriteLockPath(key).split("/").pop()!;
    expect((await readdir(dirname(folderWriteLockPath(key)))).filter((entry) => entry.startsWith(name))).toEqual([]);
  }, 30_000);

  it("never removes a live holder's lock however old it is, and the waiter gives up at the 30 s bound", async () => {
    const live = await holder(key);
    running.push(live);
    const lock = folderWriteLockPath(key);
    const held = await readdir(lock);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lock, old, old);
    const started = Date.now();
    await expect(acquireFolderWriteLock(key)).rejects.toMatchObject({ code: "write_failed", message: expect.stringMatching(/still in progress/) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
    expect(Date.now() - started).toBeLessThan(35_000);
    expect(await readdir(lock)).toEqual(held);
    expect(live.exitCode).toBeNull();
  }, 45_000);

  it("takes over a lock whose pid now belongs to a different, later process", async () => {
    const reused = await holder(`${key}-other`);
    running.push(reused);
    const lock = folderWriteLockPath(key);
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    await mkdir(lock);
    // The pid is alive, but the start time is not that process's: the pid was reused.
    await writeFile(join(lock, `holder-${reused.pid}-1-${randomUUID()}`), "");
    const release = await acquireFolderWriteLock(key);
    await release();
  });

  it("a release removes only its own lock, never a successor's", async () => {
    const releaseFirst = await acquireFolderWriteLock(key);
    const lock = folderWriteLockPath(key);
    // The first holder's lock was wrongly taken over and another process now holds it.
    await rm(lock, { recursive: true, force: true });
    const successor = await holder(key);
    running.push(successor);
    const successorEntries = await readdir(lock);
    await releaseFirst();
    expect(await readdir(lock)).toEqual(successorEntries);
  });
});
