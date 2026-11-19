/**
 * One deadline for one Gmail mail-read page, and the bounded transaction every
 * database step of that page runs in: selection routing, admission, each
 * per-send authority check, token refresh, quota admission/cooldown and the
 * final release.
 *
 * - The page signal is the client's abort combined with `pageDeadlineMs`, set
 *   once when the page starts; per-send 15 s broker deadlines sit inside it.
 * - Pool acquisition follows the signal: an abort returns at once, and a client
 *   the pool hands over later is released unused.
 * - From acquisition on, every client-side wait (BEGIN, the marker query, the
 *   work, COMMIT) follows the signal, and the cleanup after an abort (cancel
 *   answer, work settling, ROLLBACK) has one `cleanupMs` budget, so an
 *   unresponsive database or network ends the call at most `cleanupMs` after
 *   the abort. A wait a bound ends destroys the client instead of pooling it.
 * - Each transaction keeps `lock_timeout` 3 s / `statement_timeout` 5 s, cut
 *   to the time left before the page deadline.
 * - On abort, `pg_cancel_backend` goes through the separate Gmail read control
 *   pool (so it is sendable when the main pool is exhausted), identified by
 *   pid + `backend_start` while this transaction still holds the client. The
 *   client is returned to the pool only after that request has answered and a
 *   ROLLBACK afterwards succeeded (a cancel that arrived while idle is ignored by
 *   PostgreSQL; one arriving later cannot exist). A failed or timed-out cancel
 *   request destroys the client at once instead, so a late cancel can never
 *   reach a transaction that reused it.
 */
import type { ServerConfig } from "../../../config.js";
import { getGmailReadControlPool, type Pool, type PoolClient } from "../../../db/pool.js";
import type { TransactionRunner } from "../../../db/tx.js";
import { GMAIL_READ_LIMITS } from "./gmailReadContract.js";
import { GmailReadError } from "./gmailReadErrors.js";

/** Bounds for every Gmail read-authority transaction (admission, per-send check, final release). */
export const GMAIL_READ_TX_LIMITS = { lockTimeoutMs: 3000, statementTimeoutMs: 5000, cancelRequestMs: 2000, cleanupMs: 2000 } as const;

export interface GmailPageScope {
  pool: Pool;
  control: Pool;
  /** Client abort + the page deadline. */
  signal: AbortSignal;
  deadlineAt: number;
}

let controlOverride: Pool | undefined;
let pageDeadlineOverride: number | undefined;
/** Tests inject a control pool (slow or failing) and a short page deadline. */
/** `null` resets both overrides; a field left `undefined` keeps its current override. */
export function __setGmailReadControlForTests(input: { control?: Pool | null; pageDeadlineMs?: number | null } | null): void {
  if (input === null) { controlOverride = undefined; pageDeadlineOverride = undefined; return; }
  if (input.control !== undefined) controlOverride = input.control ?? undefined;
  if (input.pageDeadlineMs !== undefined) pageDeadlineOverride = input.pageDeadlineMs ?? undefined;
}

export function gmailPageScope(config: ServerConfig, pool: Pool, clientSignal: AbortSignal): GmailPageScope {
  const ms = pageDeadlineOverride ?? GMAIL_READ_LIMITS.pageDeadlineMs;
  return {
    pool,
    control: controlOverride ?? getGmailReadControlPool(config.databaseUrl!),
    signal: AbortSignal.any([clientSignal, AbortSignal.timeout(ms)]),
    deadlineAt: Date.now() + ms,
  };
}

/** The fixed code for an aborted page: its deadline is 504, the client's abort 499. */
export function gmailAbortError(signal: AbortSignal): GmailReadError {
  const reason = signal.reason as { name?: unknown } | undefined;
  return reason?.name === "TimeoutError" ? new GmailReadError(504, "gmail_upstream_timeout") : new GmailReadError(499, "gmail_cancelled");
}

/** `pool.connect()` that gives up on abort; a client that arrives afterwards goes straight back unused. */
async function acquire(pool: Pool, signal: AbortSignal): Promise<PoolClient> {
  if (signal.aborted) throw gmailAbortError(signal);
  const pending = pool.connect();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(gmailAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    pending.then((late) => late.release(), () => {});
    if (error instanceof GmailReadError) throw error;
    // The pool's own connection timeout: no capacity now.
    throw new GmailReadError(503, "gmail_authority_busy");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Sends the cancel through the control pool; true only once PostgreSQL has signalled that exact backend. */
async function cancelBackend(control: Pool, pid: number, backendStart: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), GMAIL_READ_TX_LIMITS.cancelRequestMs); });
  const request = control.query<{ sent: boolean }>(
    `SELECT pg_cancel_backend(pid) AS sent FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz`, [pid, backendStart],
  ).then((result) => result.rows[0]?.sent === true, () => false);
  try { return await Promise.race([request, timeout]); } finally { clearTimeout(timer); }
}

/** A client-side wait that `limit` ends early (rejecting with `Stalled`); `work` keeps its own handlers. */
class Stalled extends Error {}
function within<R>(work: Promise<R>, limit: AbortSignal): Promise<R> {
  if (limit.aborted) { work.catch(() => {}); return Promise.reject(new Stalled()); }
  return new Promise<R>((resolve, reject) => {
    const onAbort = () => reject(new Stalled());
    limit.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { limit.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { limit.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * One bounded transaction of the page. Abort → 499/504 (`gmailAbortError`);
 * lock/statement timeout or no pool capacity → 503 `gmail_authority_busy`.
 * `signal` may narrow the page signal (the broker's per-send signal).
 *
 * Every client-side wait from acquisition on is bounded: BEGIN, the marker
 * query, `work`, COMMIT by `signal`; the cleanup after it (cancel answer,
 * `work` settling, ROLLBACK) by `signal` while it is live and, once aborted,
 * by one `cleanupMs` budget. A wait that a bound ends destroys the client
 * (the connection closes, so PostgreSQL ends its transaction); only a client
 * whose cancel was answered, whose `work` settled and whose ROLLBACK succeeded
 * goes back to the pool.
 */
export async function withGmailReadTransaction<T>(scope: GmailPageScope, work: (db: PoolClient) => Promise<T>, signal: AbortSignal = scope.signal): Promise<T> {
  const client = await acquire(scope.pool, signal);
  let destroyed = false;
  let open = false;
  let cancellation: Promise<boolean> | undefined;
  let running: Promise<unknown> | undefined;
  const destroy = () => { if (!destroyed) { destroyed = true; client.release(true); } };
  let onAbort: (() => void) | undefined;
  let lockMs: number = GMAIL_READ_TX_LIMITS.lockTimeoutMs, statementMs: number = GMAIL_READ_TX_LIMITS.statementTimeoutMs;
  try {
    // Before the marker is known no cancel can target this backend: a stalled BEGIN/marker is destroyed in `finally`.
    open = true;
    await within(client.query("BEGIN"), signal);
    const left = scope.deadlineAt - Date.now();
    if (signal.aborted || left <= 0) throw signal.aborted ? gmailAbortError(signal) : new GmailReadError(504, "gmail_upstream_timeout");
    lockMs = Math.max(1, Math.min(lockMs, left));
    statementMs = Math.max(1, Math.min(statementMs, left));
    const marker = (await within(client.query<{ pid: number; started: string }>(
      `SELECT a.pid, a.backend_start::text AS started, set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)
         FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`,
      [`${lockMs}ms`, `${statementMs}ms`],
    ), signal)).rows[0]!;
    onAbort = () => {
      cancellation ??= cancelBackend(scope.control, marker.pid, marker.started).then((sent) => {
        if (!sent) destroy();
        return sent;
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); throw gmailAbortError(signal); }
    const pending = work(client);
    running = pending;
    const result = await within(pending, signal);
    running = undefined;
    if (signal.aborted) throw gmailAbortError(signal);
    await within(client.query("COMMIT"), signal);
    open = false;
    return result;
  } catch (error) {
    if (signal.aborted) throw gmailAbortError(signal);
    if (error instanceof GmailReadError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    // A timeout the page deadline cut short is that deadline (504); a full-length one is contention (503).
    if (code === "55P03") throw lockMs < GMAIL_READ_TX_LIMITS.lockTimeoutMs ? new GmailReadError(504, "gmail_upstream_timeout") : new GmailReadError(503, "gmail_authority_busy");
    if (code === "57014") throw statementMs < GMAIL_READ_TX_LIMITS.statementTimeoutMs ? new GmailReadError(504, "gmail_upstream_timeout") : new GmailReadError(503, "gmail_authority_busy");
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // Aborted with no cancel possible (BEGIN/marker stalled): nothing proves the backend idle.
    if (signal.aborted && !cancellation) destroy();
    const limit = signal.aborted ? AbortSignal.timeout(GMAIL_READ_TX_LIMITS.cleanupMs) : AbortSignal.any([signal, AbortSignal.timeout(GMAIL_READ_TX_LIMITS.cleanupMs)]);
    try {
      // Never back to the pool while a cancel request for this backend is unanswered, or `work` still holds the client.
      if (!destroyed && cancellation) await within(cancellation, limit);
      if (!destroyed && running) await within(running.catch(() => {}), limit);
      if (!destroyed && open) await within(client.query("ROLLBACK"), limit);
    } catch { destroy(); }
    if (!destroyed) client.release();
  }
}

/** The page's transactions as a generic runner (quota admission/cooldown, token refresh). */
export function gmailPageRunner(scope: GmailPageScope): TransactionRunner {
  return (work) => withGmailReadTransaction(scope, work);
}
