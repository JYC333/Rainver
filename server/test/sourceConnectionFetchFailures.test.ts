import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  backfillFetchTimeoutMs,
  fetchSourceConnection,
  isNarrowableFailure,
  SourceFetchFailure,
  BACKFILL_FETCH_MAX_TIMEOUT_MS,
} from "../src/modules/sources/sourceConnectionFetch";
import { fetchBackfillPageWithNarrowing, pageSizeLadder, PAGE_SIZE_FLOOR } from "../src/modules/sources/sourceBackfillPageFetch";
import type { SourceConnectorHandler } from "../src/modules/sources/catalog/sourceConnectorRegistry";

const handler = { prepareRequest: undefined } as unknown as SourceConnectorHandler;
const provider = { providerKey: "arxiv", providerDisplayName: "arXiv", connectorKey: "arxiv_api" };

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/slow")) return; // never answers; the deadline must fire
    if (req.url?.startsWith("/500")) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream exploded");
      return;
    }
    res.writeHead(200, { "content-type": "application/xml" });
    res.end("<feed/>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
});

const fetchOnce = (path: string, timeoutMs?: number) => fetchSourceConnection({
  handler,
  url: `${base}${path}`,
  headers: {},
  maxDownloadBytes: 1_000_000,
  backfill: true,
  provider,
  ...(timeoutMs ? { timeoutMs } : {}),
});

/**
 * A provider that answers slowly and a provider that cannot be reached were
 * both recorded as `network` with a null status, which is what sent a real
 * investigation looking at connectivity while the actual cause was a deadline.
 */
describe("source fetch failure classification", () => {
  it("reports a deadline as a timeout, with the budget that produced it", async () => {
    const error = await fetchOnce("/slow", 250).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceFetchFailure);
    const { diagnostics } = error as SourceFetchFailure;
    expect(diagnostics.failure_kind).toBe("timeout");
    expect(diagnostics.timeout_ms).toBe(250);
    expect(diagnostics.error_name).toBe("TimeoutError");
    expect(diagnostics.elapsed_ms).toBeGreaterThan(0);
  });

  it("keeps an unreachable host distinct from a slow one, and names the cause", async () => {
    const error = await fetchSourceConnection({
      handler,
      // `.invalid` is reserved by RFC 2606, so this cannot resolve anywhere.
      url: "http://source-fetch-test.invalid/history",
      headers: {},
      maxDownloadBytes: 1_000_000,
      backfill: true,
      provider,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    const { diagnostics } = error as SourceFetchFailure;
    expect(diagnostics.failure_kind).toBe("network");
    expect(diagnostics.error_code).toBe("ENOTFOUND");
    expect(diagnostics.upstream_status).toBeNull();
  });

  it("records an upstream status when the provider answered at all", async () => {
    const error = await fetchOnce("/500", 5_000).catch((e: unknown) => e);
    const { diagnostics } = error as SourceFetchFailure;
    expect(diagnostics.failure_kind).toBe("upstream_http");
    expect(diagnostics.upstream_status).toBe(500);
  });
});

describe("narrowing eligibility", () => {
  it("treats timeouts and 5xx as worth a smaller ask, and 4xx as not", () => {
    const make = (kind: "timeout" | "network" | "upstream_http", status: number | null) =>
      new SourceFetchFailure(503, "x", {
        provider_key: "arxiv", provider_display_name: "arXiv", connector_key: "arxiv_api",
        upstream_status: status, attempts: 1, retryable: true, failure_kind: kind,
        error_name: null, error_code: null, elapsed_ms: 1, timeout_ms: null,
      });
    expect(isNarrowableFailure(make("timeout", null))).toBe(true);
    expect(isNarrowableFailure(make("upstream_http", 500))).toBe(true);
    expect(isNarrowableFailure(make("upstream_http", 429))).toBe(false);
    expect(isNarrowableFailure(make("upstream_http", 404))).toBe(false);
    // Reaching nothing at all is not fixed by asking for less of it.
    expect(isNarrowableFailure(make("network", null))).toBe(false);
    expect(isNarrowableFailure(new Error("plain"))).toBe(false);
  });
});

describe("page size ladder and deadline", () => {
  it("quarters down to a floor so a segment fails after a bounded number of tries", () => {
    expect(pageSizeLadder(100)).toEqual([100, 25, 10]);
    expect(pageSizeLadder(25)).toEqual([25, 10]);
    expect(pageSizeLadder(PAGE_SIZE_FLOOR)).toEqual([PAGE_SIZE_FLOOR]);
    expect(pageSizeLadder(1)).toEqual([1]);
  });

  it("scales the deadline with the size of the answer requested", () => {
    expect(backfillFetchTimeoutMs(10)).toBeLessThan(backfillFetchTimeoutMs(100));
    // The 12s flat budget could not cover a 100-row page that legitimately
    // needed ~30s, which is how a provider 500 was recorded as unreachable.
    expect(backfillFetchTimeoutMs(100)).toBeGreaterThanOrEqual(30_000);
    expect(backfillFetchTimeoutMs(10_000)).toBe(BACKFILL_FETCH_MAX_TIMEOUT_MS);
  });
});

/**
 * The failure this exists for: a broad boolean query at 100 rows made arXiv
 * answer 5xx after ~30s, the segment failed outright, and Research went on to
 * report "no relevant sources" over a corpus missing that provider entirely.
 */
describe("history page narrowing", () => {
  const okResponse = { status: 200, ok: true, notModified: false, headers: new Headers(), contentType: "application/xml", isText: true, isPdf: false, text: "<feed/>", bytes: null };
  const upstream = (status: number) => new SourceFetchFailure(503, `HTTP ${status}`, {
    provider_key: "arxiv", provider_display_name: "arXiv", connector_key: "arxiv_api",
    upstream_status: status, attempts: 2, retryable: true, failure_kind: "upstream_http" as const,
    error_name: null, error_code: null, elapsed_ms: 30_000, timeout_ms: 35_000,
  });

  const run = (opts: {
    narrowingAllowed?: boolean;
    fails: (pageSize: number) => SourceFetchFailure | null;
  }) => {
    const asked: Array<{ pageSize: number; timeoutMs: number }> = [];
    return fetchBackfillPageWithNarrowing({
      window: { from: "a", to: "b", consumed_items: 60 },
      requestedPageSize: 100,
      narrowingAllowed: opts.narrowingAllowed ?? true,
      buildRequest: (window) => ({ url: `https://provider.test/?n=${window.page_size}`, headers: {} }),
      fetchPage: async ({ url, timeoutMs }) => {
        const pageSize = Number(new URL(url).searchParams.get("n"));
        asked.push({ pageSize, timeoutMs });
        const failure = opts.fails(pageSize);
        if (failure) throw failure;
        return okResponse;
      },
    }).then(result => ({ result, asked }), error => ({ error, asked }));
  };

  it("recovers the page at a smaller width instead of losing the whole source", async () => {
    const outcome = await run({ fails: (n) => (n > 25 ? upstream(500) : null) });
    if (!("result" in outcome)) throw outcome.error;
    const { result, asked } = outcome;
    expect(asked.map(a => a.pageSize)).toEqual([100, 25]);
    expect(result.pageSize).toBe(25);
    expect(result.response.ok).toBe(true);
    // The deadline shrinks with the ask, so a narrow retry is not also a long one.
    expect(asked[1]!.timeoutMs).toBeLessThan(asked[0]!.timeoutMs);
  });

  it("keeps the resume position fixed while narrowing", async () => {
    const seen: string[] = [];
    await fetchBackfillPageWithNarrowing({
      window: { consumed_items: 60 },
      requestedPageSize: 100,
      narrowingAllowed: true,
      buildRequest: (window) => {
        seen.push(`offset=${window.consumed_items} size=${window.page_size}`);
        return { url: "https://provider.test/", headers: {} };
      },
      fetchPage: async () => { if (seen.length < 2) throw upstream(503); return okResponse; },
    });
    expect(seen).toEqual(["offset=60 size=100", "offset=60 size=25"]);
  });

  it("does not narrow a connector whose paging cannot express it", async () => {
    const outcome = await run({ narrowingAllowed: false, fails: () => upstream(500) });
    if (!("error" in outcome)) throw new Error("Expected the upstream fetch to fail");
    const { error, asked } = outcome;
    expect(asked.map(a => a.pageSize)).toEqual([100]);
    expect(error).toBeInstanceOf(SourceFetchFailure);
  });

  it("stops immediately on a failure that a smaller page cannot fix", async () => {
    const { asked } = await run({ fails: () => upstream(404) });
    expect(asked.map(a => a.pageSize)).toEqual([100]);
  });

  it("records every width tried when the whole ladder fails", async () => {
    const { error } = await run({ fails: () => upstream(500) }) as never;
    expect((error as SourceFetchFailure).diagnostics).toMatchObject({ page_sizes_attempted: [100, 25, 10] });
  });
});
