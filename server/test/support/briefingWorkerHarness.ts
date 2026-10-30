import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { WorkerCommand, WorkerReport } from "./briefingWorkerProtocol.js";

const SCRIPT = fileURLToPath(new URL("./briefingWorkerProcess.mjs", import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Builds the server (`tsc -p tsconfig.json` → `dist`, what `node dist/index.js`
 * runs) from the current sources, so the worker process runs this code.
 */
export function buildServerDist(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.json"], { cwd: SERVER_ROOT, stdio: "pipe" });
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
