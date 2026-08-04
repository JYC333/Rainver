import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceConnectorHandler } from "../src/modules/sources/catalog/sourceConnectorRegistry";
import {
  fetchSourceConnection,
  SourceFetchFailure,
} from "../src/modules/sources/sourceConnectionFetch";

const provider = {
  providerKey: "semantic_scholar",
  providerDisplayName: "Semantic Scholar",
  connectorKey: "semantic_scholar_api",
};

const handler = {
  prepareRequest: vi.fn(async () => undefined),
} as unknown as SourceConnectorHandler;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("fetchSourceConnection", () => {
  it("defers HTTP 429 after one request instead of retrying immediately or marking it permanent", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetch);

    const failure = await fetchSourceConnection({
      handler,
      url: "https://api.semanticscholar.org/graph/v1/paper/search",
      headers: {},
      maxDownloadBytes: 1024,
      backfill: true,
      provider,
    }).catch(error => error);

    expect(failure).toBeInstanceOf(SourceFetchFailure);
    expect(failure).toMatchObject({
      statusCode: 503,
      diagnostics: {
        provider_key: "semantic_scholar",
        upstream_status: 429,
        attempts: 1,
        retryable: true,
        failure_kind: "upstream_http",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a rejected request such as HTTP 400 permanent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 400 })));

    const failure = await fetchSourceConnection({
      handler,
      url: "https://api.semanticscholar.org/graph/v1/paper/search",
      headers: {},
      maxDownloadBytes: 1024,
      backfill: true,
      provider,
    }).catch(error => error);

    expect(failure).toMatchObject({
      statusCode: 502,
      diagnostics: { upstream_status: 400, attempts: 1, retryable: false },
    });
  });
});
