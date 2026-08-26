import type { ResearchCompiledQuery } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { readSpaceRetrievalSettings } from "../../retrieval/settings.js";
import { HttpError, optionalString, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common.js";
import { SourceProviderCatalogService } from "../../sources/catalog/sourceProviderCatalogService.js";
import { CustomSourceCredentialService } from "../../sources/customSources/customSourceCredentialService.js";
import { SearchExecutionAdapter } from "../../sources/search/searchExecutionAdapter.js";
import { fetchSource, type SourceFetchResult } from "../../sources/sourceFetch.js";
import { consumeConnectionQuota } from "../../sources/sourceQuotaBucket.js";
import type { ResearchPreviewBatch, ResearchPreviewCandidate } from "./previewRelevanceAssessor.js";

type PreviewFetcher = (
  url: string,
  options: { headers?: Record<string, string>; maxDownloadBytes: number; timeoutMs?: number },
) => Promise<SourceFetchResult>;

const PREVIEW_ATTEMPT_TIMEOUT_MS = 10_000;
const PREVIEW_UNAVAILABLE_MESSAGE = "The source provider is temporarily unavailable or rate limiting; try again shortly.";

export interface ProviderPreviewInput {
  compiledQuery: ResearchCompiledQuery;
  accessibleResultCap: number;
  credentialId?: string | null;
}

export class ProviderPreviewGateway {
  private readonly executor = new SearchExecutionAdapter();

  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
    private readonly fetcher: PreviewFetcher = fetchSource,
  ) {}

  async preview(identity: SpaceUserIdentity, input: ProviderPreviewInput): Promise<ResearchPreviewBatch> {
    const provider = await new SourceProviderCatalogService(this.db).resolve(input.compiledQuery.provider_key);
    if (input.compiledQuery.provider_key === "web_search") {
      const settings = await readSpaceRetrievalSettings(this.db, identity.spaceId);
      if (!settings.externalEgressEnabled) throw new HttpError(403, "Web search is disabled by this space's external egress policy");
    }
    const quotaKey = await this.quotaKey(identity, provider.mapping_id);
    const quota = await consumeConnectionQuota(this.db, identity.spaceId, quotaKey, { window: "minute", limit_count: 12 });
    if (!quota.allowed) throw new HttpError(429, `Source preview quota reached; retry after ${quota.resetAt ?? "the current quota window"}`);

    const credential = input.credentialId
      ? await this.resolveCredential(identity, input.credentialId)
      : null;
    const request = this.executor.buildScanRequest({ compiledQuery: input.compiledQuery });
    const headers = { ...(request.headers ?? {}), ...(credential ? { [credential.header_name]: credential.header_value } : {}) };
    let response = await this.attemptFetch(input.compiledQuery.provider_key, request.url, headers);
    // 429 is rate limiting, not a malformed request — it deserves the same
    // one retry as a timeout or a real upstream 5xx (prepareRequest's
    // per-provider throttle, e.g. arXiv's 3s floor, already runs before this
    // retry too). A genuine 4xx (400/404/...) is not retried: retrying an
    // identically malformed request only burns budget for the same result.
    if (response === "timeout" || response.status >= 500 || response.status === 429) {
      response = await this.attemptFetch(input.compiledQuery.provider_key, request.url, headers);
    }
    if (response === "timeout" || response.status >= 500 || response.status === 429) {
      // The retry itself failed too — surface what actually happened on that
      // second attempt (timeout vs. a real upstream status) instead of
      // collapsing it into an undifferentiated 503, the same masking bug
      // already fixed for the single-attempt non-retryable-4xx path below.
      throw new HttpError(503, PREVIEW_UNAVAILABLE_MESSAGE, {
        upstream_status: response === "timeout" ? "timeout" : response.status,
      });
    }
    if (!response.ok) {
      // The outward status stays a generic 502/422 (this call has exactly one
      // consumer — the adaptive query orchestrator's catch block — so it
      // never reaches a client response), but the real upstream status is
      // preserved in responseBody instead of being collapsed away, so
      // errorClass() can report what actually happened instead of a
      // one-size-fits-all "http_502".
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 422 : 502,
        `${provider.provider_display_name} preview request failed (${response.status})`,
        { upstream_status: response.status },
      );
    }
    if (!response.isText || response.text === null) throw new HttpError(415, `${provider.provider_display_name} preview returned an unsupported response`);

    const items = this.executor.parseResponse(input.compiledQuery.provider_key, response.text).slice(0, 20);
    const providerHitCount = providerTotalResults(input.compiledQuery.provider_key, response.text) ?? items.length;
    return {
      providerHitCount,
      accessibleHitCount: Math.min(providerHitCount, Math.max(0, Math.trunc(input.accessibleResultCap))),
      candidates: items.map(toPreviewCandidate),
    };
  }

  private async attemptFetch(
    providerKey: ResearchCompiledQuery["provider_key"],
    url: string,
    headers: Record<string, string>,
  ): Promise<SourceFetchResult | "timeout"> {
    await this.executor.prepareRequest(providerKey);
    try {
      return await this.fetcher(url, { headers, maxDownloadBytes: 1024 * 1024, timeoutMs: PREVIEW_ATTEMPT_TIMEOUT_MS });
    } catch (error) {
      if (isTimeoutError(error)) return "timeout";
      throw error;
    }
  }

  private async resolveCredential(identity: SpaceUserIdentity, credentialId: string) {
    const credentials = new CustomSourceCredentialService(this.db, this.config);
    await credentials.requireOwnCredential(identity, credentialId);
    return credentials.resolveCredentialHeader(identity.spaceId, credentialId);
  }

  private async quotaKey(identity: SpaceUserIdentity, mappingId: string): Promise<string> {
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM source_connections
        WHERE space_id=$1 AND owner_user_id=$2 AND provider_connector_id=$3
          AND deleted_at IS NULL AND status <> 'archived'
        ORDER BY updated_at DESC LIMIT 1`,
      [identity.spaceId, identity.userId, mappingId],
    );
    return existing.rows[0]?.id ?? `preview:${identity.userId}:${mappingId}`;
  }
}

function toPreviewCandidate(item: {
  externalId: string;
  title: string;
  sourceUri: string | null;
  occurredAt: string | null;
  excerpt: string | null;
}): ResearchPreviewCandidate {
  return {
    sampleId: item.externalId,
    title: item.title,
    sourceUri: item.sourceUri,
    occurredAt: item.occurredAt,
    excerpt: item.excerpt,
  };
}

function providerTotalResults(providerKey: ResearchCompiledQuery["provider_key"], raw: string): number | null {
  if (providerKey === "arxiv") {
    const match = raw.match(/<(?:opensearch:)?totalResults\b[^>]*>\s*(\d+)\s*<\//i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (providerKey === "openalex") return safeInteger(recordValue(parsed.meta).count);
    if (providerKey === "web_search") {
      const results = recordValue(parsed.web).results;
      return Array.isArray(results) ? results.length : null;
    }
    return safeInteger(parsed.total);
  } catch {
    return null;
  }
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = optionalString((error as { name?: unknown }).name);
  if (name === "TimeoutError" || name === "AbortError") return true;
  // fetch() throws a bare TypeError (not an HTTP error response) for
  // network-level failures — DNS, connection reset/refused, TLS. Those are
  // exactly as transient as a timeout and deserve the same retry instead of
  // leaking as an opaque "TypeError" attempt error class.
  if (name === "TypeError" && optionalString((error as { message?: unknown }).message)?.includes("fetch failed")) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isTimeoutError(cause);
}
