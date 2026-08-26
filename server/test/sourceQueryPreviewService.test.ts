import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Queryable, SpaceUserIdentity } from '../src/modules/routeUtils/common.js'
import type { SourceFetchResult } from '../src/modules/sources/sourceFetch.js'
import { SourceQueryPreviewService } from '../src/modules/sources/sourceQueryPreviewService.js'
import { __setArxivThrottleForTests } from '../src/modules/sources/connectors/arxivThrottle.js'

const identity = { spaceId: 'space-1', userId: 'user-1' } as SpaceUserIdentity

function fakeDb(statements: string[]): Queryable {
  return {
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(sql)
      if (sql.includes('FROM source_providers p')) return { rows: [{
        provider_id: 'provider-1', provider_key: 'arxiv', provider_display_name: 'arXiv', provider_kind: 'academic', provider_category: 'research', provider_status: 'active',
        provider_capabilities_json: {}, provider_config_schema_json: {}, mapping_id: 'mapping-1', mapping_status: 'active', mapping_priority: 0,
        mapping_capabilities_json: {}, mapping_config_schema_json: {}, connector_id: 'connector-1', connector_key: 'arxiv_api', connector_display_name: 'arXiv API',
        connector_type: 'search', ingestion_mode: 'poll', connector_status: 'active', connector_capabilities_json: {}, connector_config_schema_json: {},
      }] as T[], rowCount: 1 }
      if (sql.includes('FROM source_connections')) return { rows: [{ id: 'connection-1' }] as T[], rowCount: 1 }
      if (sql.startsWith('UPDATE source_quota_buckets SET used_count')) return { rows: [{ reset_at: '2026-07-18T10:01:00Z' }] as T[], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
  }
}

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>42</opensearch:totalResults>
  <entry><id>http://arxiv.org/abs/2607.00001v1</id><updated>2026-07-18T00:00:00Z</updated><published>2026-07-17T00:00:00Z</published><title>Agent memory systems</title><summary>A paper.</summary><author><name>A. Researcher</name></author><link href="http://arxiv.org/abs/2607.00001v1" rel="alternate" type="text/html" /></entry>
</feed>`

function okResponse(): SourceFetchResult {
  return { status: 200, ok: true, notModified: false, headers: new Headers(), contentType: 'application/atom+xml', isText: true, isPdf: false, text: feed, bytes: null }
}

function errorResponse(status: number): SourceFetchResult {
  return { status, ok: false, notModified: false, headers: new Headers(), contentType: null, isText: false, isPdf: false, text: null, bytes: null }
}

describe('SourceQueryPreviewService', () => {
  beforeEach(() => __setArxivThrottleForTests({ minIntervalMs: 0 }))
  afterEach(() => __setArxivThrottleForTests(null))
  it('compiles and executes a bounded arXiv preview through the shared connection quota', async () => {
    const statements: string[] = []
    const service = new SourceQueryPreviewService(fakeDb(statements), async url => {
      expect(url).toContain('max_results=3')
      expect(new URL(url).searchParams.get('search_query')).toBe('all:"agent memory"')
      return { status: 200, ok: true, notModified: false, headers: new Headers(), contentType: 'application/atom+xml', isText: true, isPdf: false, text: feed, bytes: null }
    })

    const result = await service.preview(identity, { provider_key: 'arxiv', query: { mode: 'search', search_query: 'agent memory' } })

    expect(result).toMatchObject({ compiled_query: 'all:"agent memory"', approximate_hit_count: 42 })
    expect(result.samples[0]?.title).toBe('Agent memory systems')
    expect(statements.some(sql => sql.startsWith('INSERT INTO source_quota_buckets'))).toBe(true)
    expect(statements.some(sql => sql.startsWith('UPDATE source_quota_buckets SET used_count'))).toBe(true)
    expect(statements.some(sql => /INSERT INTO source_channels|INSERT INTO source_items/.test(sql))).toBe(false)
  })

  it('retries once when arXiv returns a transient 5xx and succeeds', async () => {
    let calls = 0
    const service = new SourceQueryPreviewService(fakeDb([]), async () => {
      calls += 1
      return calls === 1 ? errorResponse(503) : okResponse()
    })
    const result = await service.preview(identity, { provider_key: 'arxiv', query: { mode: 'search', search_query: 'agent memory' } })
    expect(calls).toBe(2)
    expect(result.approximate_hit_count).toBe(42)
  })

  it('maps a persistent arXiv 503 to a plain-language unavailable error, not a query problem', async () => {
    let calls = 0
    const service = new SourceQueryPreviewService(fakeDb([]), async () => {
      calls += 1
      return errorResponse(503)
    })
    await expect(service.preview(identity, { provider_key: 'arxiv', query: { mode: 'search', search_query: 'agent memory' } }))
      .rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('not a problem with your query') })
    expect(calls).toBe(2)
  })

  it('bounds each attempt and treats a timeout like a transient failure', async () => {
    let calls = 0
    const service = new SourceQueryPreviewService(fakeDb([]), async (_url, options) => {
      calls += 1
      expect(options.timeoutMs).toBeGreaterThan(0)
      if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { name: 'TimeoutError' } })
      return okResponse()
    })
    const result = await service.preview(identity, { provider_key: 'arxiv', query: { mode: 'search', search_query: 'agent memory' } })
    expect(calls).toBe(2)
    expect(result.approximate_hit_count).toBe(42)
  })

  it('treats a network-level fetch failure (no recognizable timeout cause) as transient too', async () => {
    let calls = 0
    const service = new SourceQueryPreviewService(fakeDb([]), async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
      return okResponse()
    })
    const result = await service.preview(identity, { provider_key: 'arxiv', query: { mode: 'search', search_query: 'agent memory' } })
    expect(calls).toBe(2)
    expect(result.approximate_hit_count).toBe(42)
  })

  it('does not retry a non-transient client error', async () => {
    let calls = 0
    const service = new SourceQueryPreviewService(fakeDb([]), async () => {
      calls += 1
      return errorResponse(400)
    })
    await expect(service.preview(identity, { provider_key: 'arxiv', query: { mode: 'search', search_query: 'agent memory' } }))
      .rejects.toMatchObject({ statusCode: 502 })
    expect(calls).toBe(1)
  })
})
