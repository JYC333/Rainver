import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { ProviderPreviewGateway } from "../src/modules/research/discovery/providerPreviewGateway.js";
import { ResearchProviderCompiler } from "../src/modules/research/queryPlanning/providerCompiler.js";
import { __setArxivThrottleForTests } from "../src/modules/sources/connectors/arxivThrottle.js";
import type { SourceFetchResult } from "../src/modules/sources/sourceFetch.js";

const identity = { spaceId: "space-1", userId: "user-1" } as SpaceUserIdentity;

describe("ProviderPreviewGateway", () => {
  beforeEach(() => __setArxivThrottleForTests({ minIntervalMs: 0 }));
  afterEach(() => __setArxivThrottleForTests(null));

  it("executes the exact compiled query and returns bounded normalized samples", async () => {
    const statements: string[] = [];
    const compiled = new ResearchProviderCompiler().compile("arxiv", semanticQuery(), { pageSize: 15 });
    const gateway = new ProviderPreviewGateway(fakeDb(statements), {} as ServerConfig, async (url, options) => {
      expect(options.timeoutMs).toBeGreaterThan(0);
      const parsed = new URL(url);
      expect(parsed.searchParams.get("max_results")).toBe("15");
      expect(parsed.searchParams.get("search_query")).toBe(compiled.query.search_query);
      return response(200);
    });

    const result = await gateway.preview(identity, { compiledQuery: compiled, accessibleResultCap: 20 });
    expect(result).toMatchObject({ providerHitCount: 42, accessibleHitCount: 20 });
    expect(result.candidates[0]).toMatchObject({ sampleId: "2607.00001", title: "Agent memory systems" });
    expect(statements.some((sql) => sql.startsWith("INSERT INTO source_quota_buckets"))).toBe(true);
  });

  it("retries a transient provider failure once without rewriting the query", async () => {
    const compiled = new ResearchProviderCompiler().compile("arxiv", semanticQuery(), { pageSize: 15 });
    const urls: string[] = [];
    const gateway = new ProviderPreviewGateway(fakeDb([]), {} as ServerConfig, async (url) => {
      urls.push(url);
      return response(urls.length === 1 ? 503 : 200);
    });
    const result = await gateway.preview(identity, { compiledQuery: compiled, accessibleResultCap: 100 });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    expect(result.providerHitCount).toBe(42);
  });

  it("retries a network-level fetch failure (fetch()'s bare TypeError for connection resets, DNS, etc.) like a timeout", async () => {
    const compiled = new ResearchProviderCompiler().compile("arxiv", semanticQuery(), { pageSize: 15 });
    let calls = 0;
    const gateway = new ProviderPreviewGateway(fakeDb([]), {} as ServerConfig, async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
      return response(200);
    });
    const result = await gateway.preview(identity, { compiledQuery: compiled, accessibleResultCap: 100 });
    expect(calls).toBe(2);
    expect(result.providerHitCount).toBe(42);
  });

  it("retries a 429 rate limit once, the same as a timeout or a real 5xx", async () => {
    const compiled = new ResearchProviderCompiler().compile("arxiv", semanticQuery(), { pageSize: 15 });
    const urls: string[] = [];
    const gateway = new ProviderPreviewGateway(fakeDb([]), {} as ServerConfig, async (url) => {
      urls.push(url);
      return response(urls.length === 1 ? 429 : 200);
    });
    const result = await gateway.preview(identity, { compiledQuery: compiled, accessibleResultCap: 100 });
    expect(urls).toHaveLength(2);
    expect(result.providerHitCount).toBe(42);
  });

  it("gives up as unavailable when a 429 doesn't clear after the retry, preserving that it was a 429 and not a generic 503", async () => {
    const compiled = new ResearchProviderCompiler().compile("arxiv", semanticQuery(), { pageSize: 15 });
    let calls = 0;
    const gateway = new ProviderPreviewGateway(fakeDb([]), {} as ServerConfig, async () => {
      calls += 1;
      return response(429);
    });
    const error = await gateway.preview(identity, { compiledQuery: compiled, accessibleResultCap: 100 }).catch((e) => e);
    expect(calls).toBe(2);
    expect(error).toMatchObject({ statusCode: 503, responseBody: { upstream_status: 429 } });
  });

  it("gives up as unavailable after two consecutive timeouts, preserving that it was a timeout and not a generic 503", async () => {
    const compiled = new ResearchProviderCompiler().compile("arxiv", semanticQuery(), { pageSize: 15 });
    let calls = 0;
    const gateway = new ProviderPreviewGateway(fakeDb([]), {} as ServerConfig, async () => {
      calls += 1;
      throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    });
    const error = await gateway.preview(identity, { compiledQuery: compiled, accessibleResultCap: 100 }).catch((e) => e);
    expect(calls).toBe(2);
    expect(error).toMatchObject({ statusCode: 503, responseBody: { upstream_status: "timeout" } });
  });

  it("does not retry a genuine 4xx failure, and preserves the real upstream status instead of collapsing it into the outward 502", async () => {
    const compiled = new ResearchProviderCompiler().compile("arxiv", semanticQuery(), { pageSize: 15 });
    let calls = 0;
    const gateway = new ProviderPreviewGateway(fakeDb([]), {} as ServerConfig, async () => {
      calls += 1;
      return response(400);
    });
    const error = await gateway.preview(identity, { compiledQuery: compiled, accessibleResultCap: 100 }).catch((e) => e);
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(502);
    expect((error as HttpError).responseBody).toEqual({ upstream_status: 400 });
  });
});

function fakeDb(statements: string[]): Queryable {
  return {
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(sql);
      if (sql.includes("FROM source_providers p")) return { rows: [{
        provider_id: "provider-1", provider_key: "arxiv", provider_display_name: "arXiv", provider_kind: "academic", provider_category: "research", provider_status: "active",
        provider_capabilities_json: {}, provider_config_schema_json: {}, mapping_id: "mapping-1", mapping_status: "active", mapping_priority: 0,
        mapping_capabilities_json: {}, mapping_config_schema_json: {}, connector_id: "connector-1", connector_key: "arxiv_api", connector_display_name: "arXiv API",
        connector_type: "search", ingestion_mode: "poll", connector_status: "active", connector_capabilities_json: {}, connector_config_schema_json: {},
      }] as T[], rowCount: 1 };
      if (sql.includes("FROM source_connections")) return { rows: [{ id: "connection-1" }] as T[], rowCount: 1 };
      if (sql.startsWith("UPDATE source_quota_buckets SET used_count")) return { rows: [{ reset_at: "2026-07-18T10:01:00Z" }] as T[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function semanticQuery() {
  return {
    schema_version: "research_semantic_query.v1" as const,
    core: [{ value: "agent memory", synonyms: [], weight: 1 }],
    expansions: [], qualifiers: [], exclusions: [], time_window: null,
  };
}

function response(status: number): SourceFetchResult {
  return {
    status,
    ok: status >= 200 && status < 300,
    notModified: false,
    headers: new Headers(),
    contentType: "application/atom+xml",
    isText: status === 200,
    isPdf: false,
    text: status === 200 ? FEED : null,
    bytes: null,
  };
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>42</opensearch:totalResults>
  <entry><id>http://arxiv.org/abs/2607.00001v1</id><updated>2026-07-18T00:00:00Z</updated><published>2026-07-17T00:00:00Z</published><title>Agent memory systems</title><summary>A paper.</summary><author><name>A. Researcher</name></author><link href="http://arxiv.org/abs/2607.00001v1" rel="alternate" type="text/html" /></entry>
</feed>`;
