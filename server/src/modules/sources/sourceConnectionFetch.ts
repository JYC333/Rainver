import { HttpError } from "../routeUtils/common";
import type { SourceConnectorHandler } from "./catalog/sourceConnectorRegistry";
import { fetchSource, type SourceFetchResult } from "./sourceFetch";

export interface SourceProviderIdentity {
  providerKey: string;
  providerDisplayName: string;
  connectorKey: string;
}

export interface SourceFetchFailureDiagnostics {
  provider_key: string;
  provider_display_name: string;
  connector_key: string;
  upstream_status: number | null;
  attempts: number;
  retryable: boolean;
  failure_kind: "upstream_http" | "network";
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
const BACKFILL_FETCH_TIMEOUT_MS = 12_000;

export async function fetchSourceConnection(input: {
  handler: SourceConnectorHandler;
  url: string;
  headers: Record<string, string>;
  maxDownloadBytes: number;
  backfill: boolean;
  provider: SourceProviderIdentity;
}): Promise<SourceFetchResult> {
  const maxAttempts = input.backfill ? BACKFILL_FETCH_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await input.handler.prepareRequest?.();
    try {
      const response = await fetchSource(input.url, {
        headers: input.headers,
        maxDownloadBytes: input.maxDownloadBytes,
        ...(input.backfill ? { timeoutMs: BACKFILL_FETCH_TIMEOUT_MS } : {}),
      });
      if (response.ok || response.notModified) return response;
      const retryable = isTransientUpstreamStatus(response.status);
      // A rate-limit response needs provider-friendly backoff, not another
      // immediate request into the same quota window. The Sources backfill
      // coordinator persists it as a deferred retry instead.
      if (retryable && response.status !== 429 && attempt < maxAttempts) continue;
      throw httpFailure(input.provider, response.status, attempt, retryable, input.backfill);
    } catch (error) {
      if (error instanceof SourceFetchFailure || error instanceof HttpError) throw error;
      if (attempt < maxAttempts) continue;
      const displayName = providerDisplayName(input.provider);
      throw new SourceFetchFailure(
        503,
        input.backfill
          ? `${displayName} history import could not reach the source provider after ${attempt} attempts. Retry the research operation; completed source data was not removed.`
          : `Failed to reach ${displayName} source connection`,
        diagnostics(input.provider, {
          upstreamStatus: null,
          attempts: attempt,
          retryable: true,
          failureKind: "network",
        }),
      );
    }
  }
  throw new Error("Unreachable source fetch retry state");
}

function isTransientUpstreamStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function httpFailure(
  provider: SourceProviderIdentity,
  upstreamStatus: number,
  attempts: number,
  retryable: boolean,
  backfill: boolean,
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
    }),
  );
}

function diagnostics(
  provider: SourceProviderIdentity,
  input: {
    upstreamStatus: number | null;
    attempts: number;
    retryable: boolean;
    failureKind: SourceFetchFailureDiagnostics["failure_kind"];
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
  };
}

function providerDisplayName(provider: SourceProviderIdentity): string {
  return provider.providerDisplayName || provider.providerKey || provider.connectorKey;
}
