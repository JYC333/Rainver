/**
 * A runtime's own, explicit report that a response of this Run came from another model than the one its session
 * was set to — a refusal retried on a fallback model, a reroute (ADR 0037).
 *
 * Only what the runtime's ACP adapter states counts: a main-session `notice` whose title matches what its adapter
 * catalog entry declares (`model.model_fallback_notice`). Nothing is inferred. A configuration echo, a response
 * whose model id is spelled otherwise (an alias, a dated id), a usage row without a model, or no model at all is
 * never a fallback: a runtime that says nothing has not fallen back as far as Rainver knows.
 *
 * The report is kept on the Run (`model_override_json.runtime_model_fallback`, the first one), merged like the
 * other launch observations (`recordDroppedSessionConfig`), so it outlives a relaunch of the same attempt: the
 * round is the Run. Nothing waits for it; a caller that must stop on a fallback reads it when it acts
 * (`runModelFallback`), and one that arrives after something was already handed out is still seen by every
 * later step.
 *
 * It stops the round from the moment this server process receives it, not from its commit: a Gmail release holds
 * the Run row `FOR UPDATE` and a fact or flag holds it `FOR SHARE`, so the Run-row write can wait behind exactly the
 * step it must stop, and the display observation's writes (one per model-tagged update) must never delay it. The
 * report is therefore noted in process synchronously on receipt (`recordRuntimeModelFallback`, before its first
 * await), written on its own chain rather than behind those observations (`launchModelWrites`), and read from that
 * note first (`runModelFallback`) until the row has committed. A write that fails keeps the note for the life of the
 * process, so settlement there still stops the round. Another server process sees it once the row commits.
 *
 * Where a step that hands something out stops (ADR 0037 §11). A Gmail release, a fact and a review flag each read the
 * report while holding the Run row (`FOR UPDATE` or `FOR SHARE`) and keep it until their commit, and each registers a
 * commit guard (`stopAtCommitOnModelFallback`) that reads this process's note synchronously immediately before its
 * `COMMIT` is issued. So a report received while such a step waits on SQL or between its statements — after its check —
 * rolls it back at that boundary; one received in another process commits either before the step's row lock (and the
 * step's read sees it) or after the step's commit (its Run-row write waits for that lock). A step whose `COMMIT` was
 * already issued has handed out its result (the mail reaches the Agent only from the release's commit): it stays,
 * counted in the owner's notice, and nothing withdraws it.
 */
import { isOperationTransaction, operationTransactionHost } from "../../db/operationTransaction.js";
import { guardTransactionCommit } from "../../db/tx.js";
import type { Queryable } from "../routeUtils/common.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

export interface RuntimeModelFallback {
  /** The notice's own text, as the runtime wrote it (bounded). */
  title: string;
  description: string | null;
  /** The launch that reported it, when known. */
  launch_id: string | null;
  reported_at: string;
}

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/**
 * The fallback a `session/update` of the main session reports, by its runtime's declared notice, or null. Both
 * placements of a notice's fields are read: at the update's top level (as the adapters send them) and under
 * `notice`.
 */
export function runtimeModelFallbackNotice(runtimeKey: string | null | undefined, update: Record<string, unknown>): Pick<RuntimeModelFallback, "title" | "description"> | null {
  const declared = getRuntimeAdapterSpec(runtimeKey)?.model.model_fallback_notice;
  if (!declared || update.sessionUpdate !== "notice") return null;
  const nested = update.notice && typeof update.notice === "object" && !Array.isArray(update.notice) ? update.notice as Record<string, unknown> : {};
  const title = text(update.title, 1_000) ?? text(nested.title, 1_000);
  if (!title || !new RegExp(declared.notice_title).test(title)) return null;
  return { title, description: text(update.description, 4_000) ?? text(nested.description, 4_000) };
}

/** Reports this process received whose Run-row write has not committed yet (or failed), by Run; bounded. */
const received = new Map<string, RuntimeModelFallback>();
const RECEIVED_LIMIT = 1_000;
const receivedKey = (spaceId: string, runId: string) => `${spaceId}:${runId}`;

/**
 * Records the Run's first reported fallback; a later one keeps the first. Merged, never replacing the blob. Noted in
 * process before anything is awaited, so every check from this call on sees it (`runModelFallback`); the note is
 * dropped once the row has committed.
 */
export async function recordRuntimeModelFallback(db: Queryable, input: {
  spaceId: string; runId: string; launchId: string | null; title: string; description: string | null;
}): Promise<void> {
  const key = receivedKey(input.spaceId, input.runId);
  if (!received.has(key)) {
    if (received.size >= RECEIVED_LIMIT) received.delete(received.keys().next().value!);
    received.set(key, { title: input.title.trim().slice(0, 1_000), description: input.description?.trim().slice(0, 4_000) || null,
      launch_id: input.launchId, reported_at: new Date().toISOString() });
  }
  await db.query(
    `UPDATE runs SET model_override_json = COALESCE(model_override_json, '{}'::jsonb)
        || jsonb_build_object('runtime_model_fallback', jsonb_build_object('title', $3::text, 'description', $4::text,
             'launch_id', $5::text, 'reported_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
        updated_at = now()
      WHERE id = $1 AND space_id = $2 AND NOT (COALESCE(model_override_json, '{}'::jsonb) ? 'runtime_model_fallback')`,
    [input.runId, input.spaceId, input.title.slice(0, 1_000), input.description?.slice(0, 4_000) ?? null, input.launchId],
  );
  // Committed (every caller passes an autocommitting pool, never an open transaction): the row is the authority now.
  received.delete(key);
}

/** The fallback a Run's `model_override_json` carries, or null. */
export function modelFallbackOf(modelOverride: unknown): RuntimeModelFallback | null {
  const value = modelOverride && typeof modelOverride === "object" ? (modelOverride as Record<string, unknown>).runtime_model_fallback : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = text(record.title, 1_000);
  return title ? {
    title, description: text(record.description, 4_000), launch_id: text(record.launch_id, 128),
    reported_at: text(record.reported_at, 64) ?? "",
  } : null;
}

/**
 * Whether, and how, the runtime reported a fallback for this Run so far: a report this process received (read first,
 * so one whose row has not committed yet — or is waiting behind the caller's own lock — is never missed), else the Run's row.
 */
export async function runModelFallback(db: Queryable, input: { spaceId: string; runId: string; lock?: boolean }): Promise<RuntimeModelFallback | null> {
  const noted = received.get(receivedKey(input.spaceId, input.runId));
  if (noted) return noted;
  // `lock`: the Run row is held `FOR SHARE` from this read to the caller's commit, so a report another process writes
  // either committed before (and is read here) or waits for that commit (its write needs the row).
  const row = (await db.query<{ model_override_json: unknown }>(`SELECT model_override_json FROM runs WHERE id=$1 AND space_id=$2${input.lock ? " FOR SHARE" : ""}`,
    [input.runId, input.spaceId])).rows[0];
  return modelFallbackOf(row?.model_override_json) ?? received.get(receivedKey(input.spaceId, input.runId)) ?? null;
}

/**
 * The caller's transaction does not commit once this process has received a fallback report for the Run: a
 * synchronous check at its commit boundary (`guardTransactionCommit`), immediately before `COMMIT` is issued, throwing
 * `refusal()`. `db` is the transaction's client or an operation transaction's port over it. Registered after the
 * step's own check has passed; the step must hold the Run row until commit (`runModelFallback` with `lock`).
 */
export function stopAtCommitOnModelFallback(db: Queryable, input: { spaceId: string; runId: string }, refusal: () => Error): void {
  const client = isOperationTransaction(db) ? operationTransactionHost(db) : db;
  const key = receivedKey(input.spaceId, input.runId);
  guardTransactionCommit(client, () => { if (received.has(key)) throw refusal(); });
}

/**
 * The launch's Run-row model writes: the display observations (`runtime_reported_model`, in the order they arrived)
 * and explicit fallback reports, on two chains. A fallback is never queued behind an observation: its first write
 * starts on receipt, so the in-process note it takes before awaiting (`recordRuntimeModelFallback`) is in place before
 * the next frame is handled. Both merge into the row (`||`), so neither order loses the other. `settled` waits for
 * both chains and rethrows the first write error.
 */
export function launchModelWrites(write: {
  observe?: (model: string | null) => Promise<void> | void;
  fallback?: (report: Pick<RuntimeModelFallback, "title" | "description">) => Promise<void> | void;
}): { selected(model: string | null): void; fellBack(report: Pick<RuntimeModelFallback, "title" | "description">): void; settled(): Promise<void> } {
  let observations = Promise.resolve();
  let fallbacks = Promise.resolve();
  let error: unknown;
  const failed = (cause: unknown) => { error ??= cause; };
  const now = (run: () => Promise<void> | void) => { try { return Promise.resolve(run()); } catch (cause) { return Promise.reject(cause); } };
  return {
    selected(model) { observations = observations.then(() => write.observe?.(model)).catch(failed); },
    // Started now, not chained: only a later report waits for an earlier one (which it keeps, `recordRuntimeModelFallback`).
    fellBack(report) { const started = now(() => write.fallback?.(report)); fallbacks = Promise.all([fallbacks, started]).then(() => undefined).catch(failed); },
    async settled() {
      await Promise.all([observations, fallbacks]);
      if (error) throw error;
    },
  };
}
