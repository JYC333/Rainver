import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inject } from "vitest";
import type { WorkerCommand, WorkerReport } from "./briefingWorkerProtocol.js";

const SCRIPT = fileURLToPath(new URL("./briefingWorkerProcess.mjs", import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSC = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
const BUILD_STATE = join(SERVER_ROOT, "node_modules", ".test-dist-build");
const BUILD_LOCK = join(BUILD_STATE, "lock");
const BUILD_STAMP = join(BUILD_STATE, "built-run");

/**
 * Builds the server (`tsc -p tsconfig.json` → `dist`, what `node dist/index.js`
 * runs) from the current sources, so the worker process runs this code.
 *
 * Once per test run, not once per call: sources do not change during a run,
 * and parallel files rebuilding the same `dist` would overwrite modules a
 * running worker process may still be loading. The run id from global setup
 * keys a stamp; an atomic `mkdir` lock makes concurrent callers wait for the
 * first build. A lock left by an earlier (killed) run names that run's id, or
 * names none and is over two minutes old, and is taken over. Without a run id
 * (no shared Postgres) every call builds.
 */
export async function buildServerDist(): Promise<void> {
  const runId = inject("sharedPostgres").runId;
  if (!runId) return compile();
  await mkdir(BUILD_STATE, { recursive: true });
  const deadline = Date.now() + 300_000;
  for (;;) {
    if ((await readText(BUILD_STAMP)) === runId) return;
    try {
      await mkdir(BUILD_LOCK);
    } catch {
      const owner = await readText(join(BUILD_LOCK, "run"));
      const stale = owner === undefined
        ? Date.now() - ((await stat(BUILD_LOCK).catch(() => undefined))?.mtimeMs ?? Date.now()) > 120_000
        : owner !== runId;
      if (stale) await rm(BUILD_LOCK, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error("timed out waiting for another test file's server build");
      else await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      await writeFile(join(BUILD_LOCK, "run"), runId);
      if ((await readText(BUILD_STAMP)) !== runId) {
        await compile();
        await writeFile(BUILD_STAMP, runId);
      }
      return;
    } finally {
      await rm(BUILD_LOCK, { recursive: true, force: true });
    }
  }
}

async function compile(): Promise<void> {
  await promisify(execFile)(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: SERVER_ROOT });
}

async function readText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

/** One real jobs-worker process (`briefingWorkerProcess.ts`), its reports, and a way to wait for one. */
export interface WorkerProcess {
  child: ChildProcess;
  reports: WorkerReport[];
  send(command: WorkerCommand): void;
  /** Resolves with the first report (already received or to come) matching `match` after index `from`. */
  next<T extends WorkerReport>(match: (report: WorkerReport) => report is T, from?: number): Promise<T>;
  /** Kills the process outright (SIGKILL): no shutdown, no settlement, its claims left as they were. */
  kill(): Promise<void>;
  /** Asks the worker to stop as the server does on shutdown, and waits for the process to exit. */
  stop(): Promise<void>;
  stderr: string[];
}

export function startWorkerProcess(env: { databaseUrl: string; home: string; hostId: string }): Promise<WorkerProcess> {
  const child = fork(SCRIPT, [], {
    env: { ...process.env, BRIEFING_WORKER_DATABASE_URL: env.databaseUrl, BRIEFING_WORKER_HOME: env.home, BRIEFING_WORKER_HOST_ID: env.hostId },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const reports: WorkerReport[] = [];
  const stderr: string[] = [];
  const waiters: Array<{ from: number; match: (report: WorkerReport) => boolean; resolve: (report: WorkerReport) => void }> = [];
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  child.on("message", (message: WorkerReport) => {
    reports.push(message);
    for (const waiter of [...waiters]) {
      if (reports.length - 1 >= waiter.from && waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const worker: WorkerProcess = {
    child, reports, stderr,
    send: (command) => { child.send(command); },
    next: (match, from = 0) => new Promise((resolve, reject) => {
      const found = reports.slice(from).find(match);
      if (found) return resolve(found);
      if (exited) return reject(new Error(`worker exited before the expected report; stderr: ${stderr.join("").slice(-2000)}`));
      waiters.push({ from, match, resolve: resolve as (report: WorkerReport) => void });
      void exit.then(() => reject(new Error(`worker exited before the expected report; stderr: ${stderr.join("").slice(-2000)}`)));
    }),
    kill: async () => { if (!exited) child.kill("SIGKILL"); await exit; },
    stop: async () => { if (!exited) child.send({ cmd: "stop" }); await exit; },
  };
  // Startup is bounded: a worker that never reports ready is killed, and the start fails with its stderr.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void worker.kill(); reject(new Error(`worker not ready within ${STARTUP_MS} ms; stderr: ${stderr.join("").slice(-2000)}`)); }, STARTUP_MS);
  });
  return Promise.race([worker.next((report): report is Extract<WorkerReport, { type: "ready" }> => report.type === "ready"), timeout])
    .then(() => worker, async (error) => { await worker.kill(); throw error; })
    .finally(() => clearTimeout(timer));
}

const STARTUP_MS = 20_000;

export const isFrame = (type: string, runId?: string) =>
  (report: WorkerReport): report is Extract<WorkerReport, { type: "frame" }> =>
    report.type === "frame" && report.frame.type === type && (runId === undefined || report.frame.run_id === runId);
export const isPrompted = (runId: string) =>
  (report: WorkerReport): report is Extract<WorkerReport, { type: "prompted" }> => report.type === "prompted" && report.runId === runId;
let pings = 0;
/** Waits until the worker has handled every command sent to it so far. */
export async function settledCommands(worker: WorkerProcess): Promise<void> {
  const seq = ++pings;
  worker.send({ cmd: "ping", seq });
  await worker.next((report): report is Extract<WorkerReport, { type: "pong" }> => report.type === "pong" && report.seq === seq);
}
export const isCancelled = (report: WorkerReport): report is Extract<WorkerReport, { type: "cancelled" }> => report.type === "cancelled";

/**
 * Re-reads a database condition until it holds, between short pauses — the
 * worker is another process, so its progress is observed, not awaited. Fails
 * loudly with the last observed value when it never holds.
 */
export async function until<T>(read: () => Promise<T>, holds: (value: T) => boolean, what: string, attempts = 600): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await read();
    if (holds(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} did not happen; last observed: ${JSON.stringify(last)}`);
}
