import type { RunAdapterResultEnvelope } from "@rainver/protocol";

import { isVendorCliAdapter } from "../runtimeAdapters/specs.js";

/**
 * A Run's explicitly set time limit.
 *
 * There is no default: a long-running Agent keeps working until it finishes,
 * is stopped, or its runtime fails. A limit exists only when someone set one —
 * the Run contract's `max_duration_seconds` (Space budget, Task, Plan node,
 * automation, workflow, experiment `timeout_seconds`) or a dispatch's own
 * `timeout_ms`. When both are set the shorter one applies.
 */
export interface RunTimeLimit {
  ms: number;
  seconds: number;
  source: "run_contract" | "dispatch";
}

/** The code a Run stopped at its explicit time limit fails with. Not retried. */
export const RUN_TIMED_OUT_ERROR_CODE = "run_timed_out";

/**
 * How long, after the stop was requested, a timed-out adapter may take to
 * unwind (revoke credentials, flush thread events) before orchestration
 * settles the Run without it. The remote Host executor abandons its own
 * dispatch sooner (`REMOTE_TIME_LIMIT_ABANDON_MS`), so this only bounds an
 * adapter that ignores its deadline signal.
 */
const TIME_LIMIT_SETTLE_MS = 15_000;

export function explicitRunTimeLimit(
  contractSnapshot: unknown,
  dispatchTimeoutMs: number | null | undefined,
): RunTimeLimit | null {
  const contract = contractSnapshot && typeof contractSnapshot === "object" && !Array.isArray(contractSnapshot)
    ? contractSnapshot as Record<string, unknown>
    : {};
  const contractSeconds = positiveFinite(contract.max_duration_seconds);
  const dispatchMs = positiveFinite(dispatchTimeoutMs);
  const contractMs = contractSeconds === null ? null : contractSeconds * 1000;
  if (contractMs === null && dispatchMs === null) return null;
  const fromDispatch = contractMs === null || (dispatchMs !== null && dispatchMs < contractMs);
  const ms = fromDispatch ? dispatchMs! : contractMs!;
  return {
    ms,
    seconds: Math.max(1, Math.ceil(ms / 1000)),
    source: fromDispatch ? "dispatch" : "run_contract",
  };
}

export interface RuntimeStopOutcome {
  process_terminated: boolean;
  confirmed_exit: boolean;
  force_kill_escalated: boolean;
}

/**
 * Run one adapter invocation under an explicit time limit.
 *
 * At the limit the deadline signal is aborted first, so the adapter knows why
 * it is being stopped, and then `stop` stops the runtime through the same
 * path an explicit stop uses. The adapter is given a bounded grace to unwind;
 * either way the result is a `run_timed_out` failure, and the caller's normal
 * terminal path settles the Run, its Job and its leases.
 */
export async function invokeWithinTimeLimit(input: {
  run: { runtime_key: string | null };
  limit: RunTimeLimit;
  invoke: (deadline: AbortSignal) => Promise<RunAdapterResultEnvelope>;
  stop: () => Promise<RuntimeStopOutcome>;
  settleMs?: number;
}): Promise<RunAdapterResultEnvelope> {
  const startedAt = new Date().toISOString();
  const deadline = new AbortController();
  const invocation = input.invoke(deadline.signal);
  // Abandoned after the grace below; its late rejection must not crash the process.
  invocation.catch(() => undefined);
  const expiry = waitUntilElapsed(input.limit.ms);
  const first = await Promise.race([invocation, expiry.elapsed]).finally(expiry.cancel);
  if (first !== null) return first;

  deadline.abort();
  const stop = await input.stop().catch((): RuntimeStopOutcome => ({
    process_terminated: false,
    confirmed_exit: false,
    force_kill_escalated: false,
  }));
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    invocation.then((value) => value, () => null),
    new Promise<null>((resolve) => {
      settleTimer = setTimeout(() => resolve(null), input.settleMs ?? TIME_LIMIT_SETTLE_MS);
      settleTimer.unref?.();
    }),
  ]).finally(() => clearTimeout(settleTimer));
  return timedOutEnvelope(input.run, input.limit, stop, settled, startedAt);
}

/**
 * The longest delay `setTimeout` honours. A larger one (about 24.86 days) is
 * not clamped but overflows to 1 ms, so a 30-day limit would fire at once.
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Resolves once `ms` has elapsed, for any finite `ms`: a delay beyond what one
 * timer can hold is re-armed in chunks against the wall-clock deadline.
 */
function waitUntilElapsed(ms: number): { elapsed: Promise<null>; cancel: () => void } {
  const deadlineAt = Date.now() + ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<null>((resolve) => {
    const arm = () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        resolve(null);
        return;
      }
      timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      timer.unref?.();
    };
    arm();
  });
  return { elapsed, cancel: () => clearTimeout(timer) };
}

function timedOutEnvelope(
  run: { runtime_key: string | null },
  limit: RunTimeLimit,
  stop: RuntimeStopOutcome,
  settled: RunAdapterResultEnvelope | null,
  startedAt: string,
): RunAdapterResultEnvelope {
  const runtimeKey = run.runtime_key ?? "unknown";
  const completedAt = new Date().toISOString();
  return {
    ...(settled ?? {
      runtime_key: runtimeKey,
      adapter_kind: isVendorCliAdapter(run.runtime_key) ? "local_cli" : "managed_api",
      output_text: "",
      output_json: { runtime_key: runtimeKey },
      started_at: startedAt,
      usage: null,
    }),
    success: false,
    exit_code: 1,
    error_code: RUN_TIMED_OUT_ERROR_CODE,
    error_message: `The Run reached its time limit of ${limit.seconds}s and was stopped.`,
    completed_at: settled?.completed_at ?? completedAt,
    metadata_json: {
      ...(settled?.metadata_json && typeof settled.metadata_json === "object" ? settled.metadata_json : {}),
      runtime_key: runtimeKey,
      time_limit: {
        seconds: limit.seconds,
        source: limit.source,
        ...stop,
        adapter_settled: settled !== null,
      },
    },
  };
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
