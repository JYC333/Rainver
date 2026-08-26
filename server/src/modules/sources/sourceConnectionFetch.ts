import { HttpError } from "../routeUtils/common.js";
import type { SourceConnectorHandler } from "./catalog/sourceConnectorRegistry.js";
import { fetchSource, type SourceFetchResult } from "./sourceFetch.js";

export interface SourceProviderIdentity {
  providerKey: string;
  providerDisplayName: string;
  connectorKey: string;
}

/**
 * How the request failed, as three genuinely different operator actions.
 *
 * `network` used to absorb timeouts too, and that cost real diagnosis time: a
 * provider that answered slowly and a provider that could not be reached at all
 * were recorded identically, with `upstream_status: null` in both cases. They
 * are not the same problem — one is fixed by asking for less or waiting longer,
 * the other by looking at connectivity.
 */
export type SourceFetchFailureKind = "upstream_http" | "timeout" | "network";

export interface SourceFetchFailureDiagnostics {
  provider_key: string;
  provider_display_name: string;
  connector_key: string;
  upstream_status: number | null;
  attempts: number;
  retryable: boolean;
  failure_kind: SourceFetchFailureKind;
  /** The thrown error's name, kept because a timeout and a DNS failure are both `TypeError`-adjacent at a glance. */
  error_name: string | null;
  /** `cause.code` when the runtime supplies one (ECONNRESET, ENOTFOUND, …). */
  error_code: string | null;
  /** Wall-clock time of the final attempt: a slow answer and an instant refusal look alike without it. */
  elapsed_ms: number | null;
  /** The deadline that produced a timeout, so a too-tight budget is visible in the record. */
  timeout_ms: number | null;
}

export class SourceFetchFailure extends HttpError {
  constructor(
    statusCode: number,
    message: string,
    readonly diagnostics: SourceFetchFailureDiagnostics,
  ) {
    super(statusCode, message);
  }
}

const BACKFILL_FETCH_ATTEMPTS = 2;

/**
 * A history page's deadline scales with what was asked for. A flat budget is
 * wrong in both directions: generous for a 10-row page, and too tight for a
 * 100-row page of a broad boolean query, where the provider legitimately needs
 * tens of seconds before it answers at all.
 */
export const BACKFILL_FETCH_BASE_TIMEOUT_MS = 15_000;
export const BACKFILL_FETCH_TIMEOUT_PER_ITEM_MS = 200;
export const BACKFILL_FETCH_MAX_TIMEOUT_MS = 45_000;

export function backfillFetchTimeoutMs(pageSize: number): number {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 1;
  return Math.min(
    BACKFILL_FETCH_MAX_TIMEOUT_MS,
    BACKFILL_FETCH_BASE_TIMEOUT_MS + size * BACKFILL_FETCH_TIMEOUT_PER_ITEM_MS,
  );
}

/**
 * Whether asking the provider for *less* is a plausible remedy.
 *
 * A provider that times out or answers 5xx on a large page frequently serves
 * the same query happily at a smaller one — the failure is in the size of the
 * answer, not the request's validity. A 4xx says the request itself is wrong,
 * and repeating it smaller only wastes the provider's quota.
 */
export function isNarrowableFailure(error: unknown): boolean {
  if (!(error instanceof SourceFetchFailure)) return false;
  if (error.diagnostics.failure_kind === "timeout") return true;
  const status = error.diagnostics.upstream_status;
  return status !== null && status >= 500;
}

export async function fetchSourceConnection(input: {
  handler: SourceConnectorHandler;
  url: string;
  headers: Record<string, string>;
  maxDownloadBytes: number;
  backfill: boolean;
  provider: SourceProviderIdentity;
  /** Overrides the computed backfill deadline; scan requests stay unbounded. */
  timeoutMs?: number;
}): Promise<SourceFetchResult> {
  const maxAttempts = input.backfill ? BACKFILL_FETCH_ATTEMPTS : 1;
  const timeoutMs = input.backfill ? input.timeoutMs ?? backfillFetchTimeoutMs(1) : undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await input.handler.prepareRequest?.();
    const startedAt = Date.now();
    try {
      const response = await fetchSource(input.url, {
        headers: input.headers,
        maxDownloadBytes: input.maxDownloadBytes,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      if (response.ok || response.notModified) return response;
      const retryable = isTransientUpstreamStatus(response.status);
      // A rate-limit response needs provider-friendly backoff, not another
      // immediate request into the same quota window. The Sources backfill
      // coordinator persists it as a deferred retry instead.
      if (retryable && response.status !== 429 && attempt < maxAttempts) continue;
      throw httpFailure(input.provider, response.status, attempt, retryable, input.backfill, {
        elapsedMs: Date.now() - startedAt,
        timeoutMs: timeoutMs ?? null,
      });
    } catch (error) {
      if (error instanceof SourceFetchFailure || error instanceof HttpError) throw error;
      if (attempt < maxAttempts) continue;
      throw transportFailure(input.provider, error, attempt, input.backfill, {
        elapsedMs: Date.now() - startedAt,
        timeoutMs: timeoutMs ?? null,
      });
    }
  }
  throw new Error("Unreachable source fetch retry state");
}

function isTransientUpstreamStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`; an explicit abort gives `AbortError`. */
function isTimeoutError(error: unknown): boolean {
  const name = errorName(error);
  return name === "TimeoutError" || name === "AbortError";
}

function errorName(error: unknown): string | null {
  return error instanceof Error && error.name ? error.name : null;
}

/**
 * `fetch` reports transport failures as a bare `TypeError`; the actionable part
 * (ENOTFOUND, ECONNREFUSED, …) is on its cause, and when a host resolves to
 * several addresses the cause is an AggregateError whose members carry it.
 */
function errorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && direct) return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return null;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  const nested = (cause as { errors?: unknown }).errors;
  if (Array.isArray(nested)) {
    for (const entry of nested) {
      const nestedCode = entry && typeof entry === "object" ? (entry as { code?: unknown }).code : null;
      if (typeof nestedCode === "string" && nestedCode) return nestedCode;
    }
  }
  return null;
}

function httpFailure(
  provider: SourceProviderIdentity,
  upstreamStatus: number,
  attempts: number,
  retryable: boolean,
  backfill: boolean,
  timing: { elapsedMs: number; timeoutMs: number | null },
): SourceFetchFailure {
  const displayName = providerDisplayName(provider);
  const message = backfill
    ? retryable
      ? `${displayName} history import failed after ${attempts} attempts because the source provider returned HTTP ${upstreamStatus}. Retry the research operation; completed source data was not removed.`
      : `${displayName} history import request was rejected by the source provider (HTTP ${upstreamStatus}).`
    : `Failed to fetch ${displayName} source connection (${upstreamStatus})`;
  return new SourceFetchFailure(
    retryable ? 503 : 502,
    message,
    diagnostics(provider, {
      upstreamStatus,
      attempts,
      retryable,
      failureKind: "upstream_http",
      errorName: null,
      errorCode: null,
      ...timing,
    }),
  );
}

function transportFailure(
  provider: SourceProviderIdentity,
  error: unknown,
  attempts: number,
  backfill: boolean,
  timing: { elapsedMs: number; timeoutMs: number | null },
): SourceFetchFailure {
  const displayName = providerDisplayName(provider);
  const timedOut = isTimeoutError(error);
  const seconds = timing.timeoutMs ? Math.round(timing.timeoutMs / 1000) : null;
  const message = timedOut
    ? backfill
      ? `${displayName} history import timed out after ${attempts} attempts${seconds ? ` (${seconds}s per attempt)` : ""}. The provider accepted the request but did not answer in time; a smaller page is retried automatically.`
      : `${displayName} source connection timed out`
    : backfill
      ? `${displayName} history import could not reach the source provider after ${attempts} attempts. Retry the research operation; completed source data was not removed.`
      : `Failed to reach ${displayName} source connection`;
  return new SourceFetchFailure(
    503,
    message,
    diagnostics(provider, {
      upstreamStatus: null,
      attempts,
      retryable: true,
      failureKind: timedOut ? "timeout" : "network",
      errorName: errorName(error),
      errorCode: errorCode(error),
      ...timing,
    }),
  );
}

function diagnostics(
  provider: SourceProviderIdentity,
  input: {
    upstreamStatus: number | null;
    attempts: number;
    retryable: boolean;
    failureKind: SourceFetchFailureKind;
    errorName: string | null;
    errorCode: string | null;
    elapsedMs: number | null;
    timeoutMs: number | null;
  },
): SourceFetchFailureDiagnostics {
  return {
    provider_key: provider.providerKey,
    provider_display_name: providerDisplayName(provider),
    connector_key: provider.connectorKey,
    upstream_status: input.upstreamStatus,
    attempts: input.attempts,
    retryable: input.retryable,
    failure_kind: input.failureKind,
    error_name: input.errorName,
    error_code: input.errorCode,
    elapsed_ms: input.elapsedMs,
    timeout_ms: input.timeoutMs,
  };
}

function providerDisplayName(provider: SourceProviderIdentity): string {
  return provider.providerDisplayName || provider.providerKey || provider.connectorKey;
}
