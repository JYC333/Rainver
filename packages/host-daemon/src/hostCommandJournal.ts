import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { HostCommandFrame, HostCommandInnerFrame, HostDaemonFrame, HostDaemonFrameOf } from "@rainver/protocol";
import { configDir } from "./config.js";
import { syncExistingDurable, writeJsonDurable } from "./durableFile.js";

/**
 * Journaled Host commands (`host_command`, capability `host_command_receipts`).
 *
 * The control plane commits a command intent before it sends anything and
 * repeats the same `command_id` until it holds this daemon's answer. Here a
 * command is recorded `in_progress` durably (`writeJsonDurable`) before its
 * effect starts and `done`, with its own result frame, before that answer is
 * sent; a repeat replays the receipt instead of running the effect again. A
 * receipt left `in_progress` by an earlier process is `interrupted` — the
 * effect may be half done and nobody can say what it changed — except for an
 * effect that is safe to finish by running it again (archiving an Agent's
 * profiles moves only what is still there). A repeat whose fingerprint
 * differs is `mismatch` and runs nothing; a command that cannot be recorded
 * is `refused` and runs nothing.
 *
 * Only a receipt that is durably `done` is answered `completed` — the control
 * plane reads that answer as proof (it lifts a reset's launch fence). A replayed
 * `done` receipt is fsynced again first (`syncExistingDurable`: an earlier write
 * may have renamed it into place and failed before its directory sync). When
 * the final write still fails after its retries, this process keeps the
 * outcome in memory and answers `unrecorded`: nothing more runs, and a repeat
 * of the same command retries the write before it may answer `completed`. A
 * restarted process that never managed it finds the receipt `in_progress`.
 */

/** Effects a later process may complete by running them again. */
const REPEATABLE = new Set<HostCommandInnerFrame["type"]>(["agent_profiles_reset"]);
const RESULT_TYPES = new Set<HostDaemonFrame["type"]>(["tool_result", "ordinary_tool_result", "ordinary_account_result", "managed_workspace_result", "workspace_register_result"]);
/** Settled receipts are kept this long; the control plane stops repeating a command well before. */
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Attempts at the final `done` write before the outcome is answered `unrecorded`. */
const DONE_WRITE_ATTEMPTS = 3;
const DONE_WRITE_BACKOFF_MS = 25;

interface Receipt {
  version: 1;
  command_id: string;
  fingerprint: string;
  type: HostCommandInnerFrame["type"];
  status: "in_progress" | "done" | "interrupted";
  attempts: number;
  result: Record<string, unknown> | null;
  updated_at: string;
}
export interface FrameSinkLike {
  send(frame: HostDaemonFrame): void;
}
type Execute = (inner: HostCommandInnerFrame, sink: FrameSinkLike) => void;
type ResultFrame = HostDaemonFrameOf<"host_command_result">;

const running = new Map<string, Promise<ResultFrame>>();
/** Commands this process finished whose `done` receipt is not yet durable, by command id. */
const unrecorded = new Map<string, Receipt>();
/** Inner frames this journal is running: their handlers know they carry an identity. */
export const journaledFrames = new WeakSet<object>();

export const hostCommandsDir = () => join(configDir(), "host-commands");
const receiptPath = (commandId: string) => join(hostCommandsDir(), `${createHash("sha256").update(commandId).digest("hex")}.json`);

async function readReceipt(commandId: string): Promise<Receipt | null> {
  const text = await readFile(receiptPath(commandId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return null;
  const parsed = JSON.parse(text) as Receipt;
  if (parsed.version !== 1 || parsed.command_id !== commandId) throw new Error("host_command_receipt_corrupt");
  return parsed;
}
const writeReceipt = (receipt: Receipt) => writeJsonDurable(receiptPath(receipt.command_id), { ...receipt, updated_at: new Date().toISOString() });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Writes the settled receipt durably, retrying a failed write; the last error when it never succeeded. */
async function recordDone(receipt: Receipt): Promise<string | null> {
  let last = "";
  for (let attempt = 1; attempt <= DONE_WRITE_ATTEMPTS; attempt += 1) {
    try { await writeReceipt(receipt); return null; }
    catch (error) { last = errorText(error); }
    if (attempt < DONE_WRITE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, DONE_WRITE_BACKOFF_MS * attempt));
  }
  return last;
}
/** A visible `done` receipt is answered only once it is durable (file, directory and chain). */
async function durablyVisible(commandId: string): Promise<string | null> {
  try { return await syncExistingDurable(receiptPath(commandId)) ? null : "receipt disappeared"; }
  catch (error) { return errorText(error); }
}

/** Runs the inner command through the ordinary handler and captures its own answer. */
function capture(inner: HostCommandInnerFrame, execute: Execute, outer: FrameSinkLike): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    journaledFrames.add(inner);
    execute(inner, {
      send(frame) {
        if (RESULT_TYPES.has(frame.type) && (frame as { request_id?: string }).request_id === inner.request_id) resolve(frame as unknown as Record<string, unknown>);
        else outer.send(frame);
      },
    });
  });
}

export function runJournaledHostCommand(frame: HostCommandFrame, execute: Execute, outer: FrameSinkLike): Promise<ResultFrame> {
  const answer = (outcome: ResultFrame["outcome"], replayed: boolean, result: Record<string, unknown> | null, error: string | null): ResultFrame =>
    ({ type: "host_command_result", request_id: frame.request_id, command_id: frame.command_id, outcome, replayed, result, error });
  const live = running.get(frame.command_id);
  // The same command, repeated while this process still runs it (a lost answer, a reconnect).
  if (live) return live.then((done) => ({ ...done, request_id: frame.request_id, replayed: true }));
  const notRecorded = (error: string) => answer("unrecorded", true, null, `host_command_outcome_not_recorded: ${error}`);
  const work = (async (): Promise<ResultFrame> => {
    // Finished by this process, its outcome not yet durable: record it now, never run it again.
    const held = unrecorded.get(frame.command_id);
    if (held) {
      if (held.fingerprint !== frame.fingerprint) return answer("mismatch", false, null, null);
      const failure = await recordDone(held);
      if (failure !== null) return notRecorded(failure);
      unrecorded.delete(frame.command_id);
      return answer("completed", true, held.result, null);
    }
    let receipt: Receipt | null;
    try { receipt = await readReceipt(frame.command_id); }
    catch (error) { return answer("refused", false, null, `host_command_journal_unreadable: ${errorText(error)}`); }
    if (receipt && receipt.fingerprint !== frame.fingerprint) return answer("mismatch", false, null, null);
    if (receipt?.status === "done") {
      const failure = await durablyVisible(frame.command_id);
      return failure === null ? answer("completed", true, receipt.result, null) : notRecorded(failure);
    }
    if (receipt?.status === "interrupted") return answer("interrupted", true, null, null);
    if (receipt?.status === "in_progress" && !REPEATABLE.has(frame.command.type)) {
      // An earlier process started this and stopped before its outcome: what it changed is unknown.
      await writeReceipt({ ...receipt, status: "interrupted" }).catch(() => undefined);
      return answer("interrupted", true, null, null);
    }
    const next: Receipt = {
      version: 1, command_id: frame.command_id, fingerprint: frame.fingerprint, type: frame.command.type,
      status: "in_progress", attempts: (receipt?.attempts ?? 0) + 1, result: null, updated_at: new Date().toISOString(),
    };
    // Recorded before the effect starts, or the effect does not start.
    try { await writeReceipt(next); }
    catch (error) { return answer("refused", false, null, `host_command_not_recorded: ${errorText(error)}`); }
    const result = await capture(frame.command, execute, outer);
    // Recorded before the answer, or the answer is not `completed`: the control plane repeats the
    // command, and the repeat records the outcome this process holds instead of running it again.
    const done: Receipt = { ...next, status: "done", result };
    const failure = await recordDone(done);
    if (failure !== null) {
      unrecorded.set(frame.command_id, done);
      return answer("unrecorded", receipt !== null, null, `host_command_outcome_not_recorded: ${failure}`);
    }
    void pruneSettledReceipts().catch(() => undefined);
    return answer("completed", receipt !== null, result, null);
  })();
  running.set(frame.command_id, work);
  void work.finally(() => { if (running.get(frame.command_id) === work) running.delete(frame.command_id); });
  return work;
}

let lastPrune = 0;
/** Removes settled receipts past retention, at most once an hour. Never an in-progress one. */
export async function pruneSettledReceipts(now = Date.now()): Promise<number> {
  if (now - lastPrune < 60 * 60 * 1000) return 0;
  lastPrune = now;
  let removed = 0;
  for (const name of await readdir(hostCommandsDir()).catch(() => [] as string[])) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const path = join(hostCommandsDir(), name);
    const info = await stat(path).catch(() => null);
    if (!info || now - info.mtimeMs < RECEIPT_RETENTION_MS) continue;
    const receipt = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Partial<Receipt>;
    if (receipt.status === "in_progress") continue;
    await rm(path, { force: true });
    removed += 1;
  }
  return removed;
}

/** Tests only. */
export function resetHostCommandJournalForTest(): void { running.clear(); unrecorded.clear(); lastPrune = 0; }
