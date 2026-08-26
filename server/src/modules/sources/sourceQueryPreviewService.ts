import type { Queryable, SpaceUserIdentity } from '../routeUtils/common.js'
import type { ServerConfig } from '../../config.js'
import { HttpError, objectValue, optionalString, requiredString } from '../routeUtils/common.js'
import { sourceConnectorRegistry, type SourceConnectorHandler } from './catalog/sourceConnectorRegistry.js'
import { SourceProviderCatalogService } from './catalog/sourceProviderCatalogService.js'
import { consumeConnectionQuota } from './sourceQuotaBucket.js'
import { fetchSource, type SourceFetchResult } from './sourceFetch.js'
import { CustomSourceCredentialService } from './customSources/customSourceCredentialService.js'
import { ResearchProviderCompiler } from '../research/queryPlanning/providerCompiler.js'
import type { ResearchProviderKey } from '@agent-space/protocol'

type PreviewFetcher = (url: string, options: { headers?: Record<string, string>; maxDownloadBytes: number; timeoutMs?: number }) => Promise<SourceFetchResult>

// The preview is interactive: bound each attempt, and retry a transient
// arXiv failure once — export.arxiv.org intermittently hangs and then
// returns 503 regardless of the query.
const PREVIEW_ATTEMPT_TIMEOUT_MS = 8_000
const PREVIEW_UNAVAILABLE_MESSAGE =
  'The source provider is temporarily unavailable or rate limiting; this is not a problem with your query. Try again in a minute.'

export class SourceQueryPreviewService {
  private readonly compiler = new ResearchProviderCompiler()
  private readonly config: ServerConfig | null
  private readonly fetcher: PreviewFetcher

  constructor(private readonly db: Queryable, configOrFetcher: ServerConfig | PreviewFetcher, fetcher: PreviewFetcher = fetchSource) {
    this.config = typeof configOrFetcher === 'function' ? null : configOrFetcher
    this.fetcher = typeof configOrFetcher === 'function' ? configOrFetcher : fetcher
  }

  async preview(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const providerKey = requiredString(body.provider_key, 'provider_key')
    const provider = await new SourceProviderCatalogService(this.db).resolve(providerKey)
    if (!['arxiv_api', 'openalex_api', 'semantic_scholar_api', 'brave_web_search_api'].includes(provider.connector_key)) {
      throw new HttpError(422, 'Query preview is available only for searchable providers')
    }
    const query = { ...objectValue(body.query), max_results: 3, per_page: 3, limit: 3, count: 3 }
    const researchProviderKey = researchProviderForConnector(provider.connector_key)
    const compiled = this.compiler.compileNative(researchProviderKey, { ...query, query })
    const handler = sourceConnectorRegistry.get(provider.connector_key)
    const request = handler.buildScanRequest({
      endpoint_url: null,
      compiled_query: compiled.query,
    }, {})
    const quotaKey = await this.quotaKey(identity, optionalString(body.source_channel_id), provider.mapping_id)
    const quota = await consumeConnectionQuota(this.db, identity.spaceId, quotaKey, { window: 'minute', limit_count: 10 })
    if (!quota.allowed) {
      throw new HttpError(429, `Source preview quota reached; retry after ${quota.resetAt ?? 'the current quota window'}`)
    }
    const credentialId = optionalString(body.credential_id)
    if (credentialId && !this.config) throw new HttpError(500, 'Source preview credential resolver is unavailable')
    if (credentialId) await new CustomSourceCredentialService(this.db, this.config!).requireOwnCredential(identity, credentialId)
    const credential = credentialId
      ? await new CustomSourceCredentialService(this.db, this.config!).resolveCredentialHeader(identity.spaceId, credentialId)
      : null
    const headers = { ...(request.headers ?? {}), ...(credential ? { [credential.header_name]: credential.header_value } : {}) }
    let response = await this.attemptFetch(handler, request.url, headers)
    if (response === 'timeout' || (response.status >= 500)) {
      response = await this.attemptFetch(handler, request.url, headers)
    }
    if (response === 'timeout' || response.status >= 500) {
      throw new HttpError(503, PREVIEW_UNAVAILABLE_MESSAGE)
    }
    if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? 422 : 502, `${provider.provider_display_name} preview request failed (${response.status})`)
    if (!response.isText || response.text === null) throw new HttpError(415, `${provider.provider_display_name} preview returned an unsupported response`)
    const items = handler.parseResponse(response.text).slice(0, 3)
    return {
      provider_key: providerKey,
      compiled_query: String(compiled.query.search_query ?? compiled.query.search ?? compiled.query.query ?? compiled.query.q ?? ''),
      approximate_hit_count: providerTotalResults(provider.connector_key, response.text) ?? items.length,
      samples: items.map(item => ({ title: item.title, source_uri: item.sourceUri, occurred_at: item.occurredAt, author: item.author, excerpt: item.excerpt, metadata: item.metadata })),
    }
  }

  /** One bounded request; prepareRequest keeps the arXiv politeness interval, which also spaces a retry. */
  private async attemptFetch(handler: SourceConnectorHandler, url: string, headers: Record<string, string>): Promise<SourceFetchResult | 'timeout'> {
    await handler.prepareRequest?.()
    try {
      return await this.fetcher(url, { headers, maxDownloadBytes: 1024 * 1024, timeoutMs: PREVIEW_ATTEMPT_TIMEOUT_MS })
    } catch (error) {
      if (isTimeoutError(error)) return 'timeout'
      throw error
    }
  }

  private async quotaKey(identity: SpaceUserIdentity, channelId: string | null, mappingId: string): Promise<string> {
    if (channelId) {
      const result = await this.db.query<{ source_connection_id: string }>(
        `SELECT source_connection_id FROM source_channels WHERE space_id=$1 AND id=$2 AND created_by_user_id=$3 LIMIT 1`,
        [identity.spaceId, channelId, identity.userId],
      )
      if (!result.rows[0]) throw new HttpError(404, 'Source channel not found')
      return result.rows[0].source_connection_id
    }
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM source_connections
        WHERE space_id=$1 AND owner_user_id=$2 AND provider_connector_id=$3
          AND deleted_at IS NULL AND status <> 'archived'
        ORDER BY updated_at DESC LIMIT 1`,
      [identity.spaceId, identity.userId, mappingId],
    )
    return existing.rows[0]?.id ?? `preview:${identity.userId}:${mappingId}`
  }
}

function researchProviderForConnector(connectorKey: string): ResearchProviderKey {
  if (connectorKey === 'arxiv_api') return 'arxiv'
  if (connectorKey === 'openalex_api') return 'openalex'
  if (connectorKey === 'semantic_scholar_api') return 'semantic_scholar'
  if (connectorKey === 'brave_web_search_api') return 'web_search'
  throw new HttpError(422, 'Query preview is available only for searchable providers')
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  if (name === 'TimeoutError' || name === 'AbortError') return true
  // fetch() throws a bare TypeError (not an HTTP error response) for
  // network-level failures — DNS, connection reset/refused, TLS. Those are
  // exactly as transient as a timeout and deserve the same retry instead of
  // leaking as an opaque "TypeError" attempt error class.
  if (name === 'TypeError' && optionalString((error as { message?: unknown }).message)?.includes('fetch failed')) return true
  const cause = (error as { cause?: unknown }).cause
  return cause !== undefined && cause !== error && isTimeoutError(cause)
}

function arxivTotalResults(xml: string): number | null {
  const match = xml.match(/<(?:opensearch:)?totalResults\b[^>]*>\s*(\d+)\s*<\//i)
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : null
}

function providerTotalResults(connectorKey: string, raw: string): number | null {
  if (connectorKey === 'arxiv_api') return arxivTotalResults(raw)
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = connectorKey === 'openalex_api'
      ? (parsed.meta as Record<string, unknown> | undefined)?.count
      : parsed.total
    return Number.isSafeInteger(value) ? Number(value) : null
  } catch { return null }
}
