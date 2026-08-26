import { afterEach, describe, expect, it } from "vitest";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import {
  DEFAULT_EMBED_BATCH,
  EMBED_DIMENSIONS,
  RETRIEVAL_EMBEDDING_JOB,
} from "../src/modules/retrieval/embedding/config.js";
import { enqueueRetrievalEmbeddingBackfillWithQueue } from "../src/modules/retrieval/embedding/job.js";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
  type RetrievalEmbeddingAuditEvent,
} from "../src/modules/retrieval/embedding/service.js";
import { QueryEmbeddingCache } from "../src/modules/retrieval/embedding/queryEmbeddingCache.js";
import { ProviderQueryEmbedder } from "../src/modules/retrieval/embedding/queryEmbedder.js";
import { __setProviderHttpClientForTests } from "../src/modules/providers/invocation/invocation.js";
import type { ProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { resolveTestUsageAttribution } from "./support/usageAttribution.js";

class FakeEmbeddingDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
    if (sql.includes("WITH candidate AS")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: "chunk-1",
            object_type: "knowledge_item",
            object_id: "item-1",
            plain_text: "embed me",
            embedding_claim_id: params[2],
          } as Row,
        ],
      };
    }
    if (sql.startsWith("UPDATE retrieval_chunks")) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }
}

function fakeEmbedder(): RetrievalEmbedder & { texts: string[] } {
  return {
    texts: [],
    async embed(_spaceId, texts) {
      this.texts = [...texts];
      return {
        model: "embed-model",
        vectors: [new Array<number>(EMBED_DIMENSIONS).fill(0)],
      };
    },
  };
}

describe("retrieval embedding backfill", () => {
  it("enqueues a space-scoped backfill job with default batch metadata", async () => {
    const calls: unknown[] = [];
    const result = await enqueueRetrievalEmbeddingBackfillWithQueue(
      {
        async enqueue(input) {
          calls.push(input);
          return { id: "job-1" } as never;
        },
        async listJobs() {
          return [];
        },
      },
      {
        spaceId: "space-1",
        userId: null,
        trigger: "unit",
        proposalId: "proposal-1",
      },
    );

    expect(result).toEqual({ jobId: "job-1" });
    expect(calls).toEqual([
      expect.objectContaining({
        job_type: RETRIEVAL_EMBEDDING_JOB,
        space_id: "space-1",
        user_id: null,
        priority: -10,
        max_attempts: 3,
        payload: {
          space_id: "space-1",
          batch_limit: DEFAULT_EMBED_BATCH,
          trigger: "unit",
          proposal_id: "proposal-1",
        },
      }),
    ]);
  });

  it("reuses an already-queued backfill instead of enqueuing a duplicate", async () => {
    let enqueueCalls = 0;
    const result = await enqueueRetrievalEmbeddingBackfillWithQueue(
      {
        async enqueue() {
          enqueueCalls += 1;
          return { id: "new-job" } as never;
        },
        async listJobs(input) {
          expect(input).toMatchObject({
            space_id: "space-1",
            status: "queued",
            job_type: RETRIEVAL_EMBEDDING_JOB,
          });
          return [{ id: "queued-job" }] as never;
        },
      },
      { spaceId: "space-1" },
    );

    expect(result).toEqual({ jobId: "queued-job", deduped: true });
    expect(enqueueCalls).toBe(0);
  });

  it("claims chunks before provider egress and audits only aggregate metadata", async () => {
    const db = new FakeEmbeddingDb();
    const embedder = fakeEmbedder();
    const auditEvents: RetrievalEmbeddingAuditEvent[] = [];
    const service = new RetrievalEmbeddingBackfillService(db, embedder, async (event) => {
      auditEvents.push(event);
    });

    const result = await service.backfillSpace("space-1", { batchLimit: 4 });

    expect(result).toEqual({
      scanned: 1,
      embedded: 1,
      skipped: 0,
      model: "embed-model",
    });
    expect(embedder.texts).toEqual(["embed me"]);
    expect(db.calls[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(db.calls[0]!.params[0]).toBe("space-1");
    expect(db.calls[0]!.params[1]).toBe(4);
    expect(db.calls[1]!.params[5]).toBe(db.calls[0]!.params[2]);
    expect(auditEvents).toEqual([
      {
        spaceId: "space-1",
        model: "embed-model",
        dimensions: EMBED_DIMENSIONS,
        scanned: 1,
        inputCount: 1,
        embedded: 1,
        skipped: 0,
      },
    ]);
  });

  it("releases claimed chunks when provider egress fails", async () => {
    const db = new FakeEmbeddingDb();
    const service = new RetrievalEmbeddingBackfillService(db, {
      async embed() {
        throw new Error("provider down");
      },
    });

    await expect(service.backfillSpace("space-1", { batchLimit: 4 })).rejects.toThrow(
      "provider down",
    );

    expect(db.calls[0]!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(db.calls[1]!.sql).toContain("SET embedding_claim_id = NULL");
    expect(db.calls[1]!.params[0]).toBe("space-1");
    expect(db.calls[1]!.params[1]).toBe(db.calls[0]!.params[2]);
  });
});

describe("QueryEmbeddingCache", () => {
  it("hits on whitespace/case-normalized key and expires by TTL", () => {
    let now = 1000;
    const cache = new QueryEmbeddingCache(10, 500, () => now);
    cache.set("space-1", "Hello   World", [1, 2, 3]);

    expect(cache.get("space-1", "hello world")).toEqual([1, 2, 3]);
    now = 1499;
    expect(cache.get("space-1", "hello world")).toEqual([1, 2, 3]);
    now = 1500; // TTL boundary (expiresAt <= now)
    expect(cache.get("space-1", "hello world")).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("evicts the least-recently-used entry past capacity", () => {
    const cache = new QueryEmbeddingCache(2, 10_000);
    cache.set("s", "a", [1]);
    cache.set("s", "b", [2]);
    expect(cache.get("s", "a")).toEqual([1]); // touch a → b is now LRU
    cache.set("s", "c", [3]); // evicts b

    expect(cache.get("s", "b")).toBeNull();
    expect(cache.get("s", "a")).toEqual([1]);
    expect(cache.get("s", "c")).toEqual([3]);
    expect(cache.size()).toBe(2);
  });

  it("scopes entries by space", () => {
    const cache = new QueryEmbeddingCache();
    cache.set("s1", "q", [1]);
    expect(cache.get("s2", "q")).toBeNull();
    expect(cache.get("s1", "q")).toEqual([1]);
  });
});

describe("ProviderQueryEmbedder caching", () => {
  afterEach(() => __setProviderHttpClientForTests(null));

  function vec(slot: number): number[] {
    const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
    v[slot] = 1;
    return v;
  }

  function fakeProviderStore(): ProviderCommandStore {
    return {
      async getTaskChain() {
        return null;
      },
      async getInvocationTarget() {
        return {
          provider: {
            id: "p1",
            provider_type: "openai",
            base_url: "https://example.test/v1",
            default_model: "embed-model",
            available_models: [],
          },
          candidates: [{ api_key: "k" }],
          network_profile: null,
          rotation_strategy: "ordered",
          fallback_provider_ids: [],
        };
      },
      resolveUsageAttribution: resolveTestUsageAttribution,
      async recordUsageObservation() {},
    } as unknown as ProviderCommandStore;
  }

  it("serves a cached vector without touching the provider", async () => {
    const cache = new QueryEmbeddingCache();
    cache.set("space-1", "hello", vec(0), EMBED_DIMENSIONS);
    const throwingStore = {
      async getTaskChain() {
        throw new Error("provider must not be called on a cache hit");
      },
      async getInvocationTarget() {
        throw new Error("provider must not be called on a cache hit");
      },
    } as unknown as ProviderCommandStore;

    const embedder = new ProviderQueryEmbedder(throwingStore, null, cache);
    expect(await embedder.embedQuery("space-1", "hello")).toEqual(vec(0));
  });

  it("embeds once on a miss and serves repeats from cache", async () => {
    let fetches = 0;
    __setProviderHttpClientForTests({
      async fetch() {
        fetches += 1;
        return new Response(JSON.stringify({ data: [{ embedding: vec(1), index: 0 }], model: "embed-model" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const embedder = new ProviderQueryEmbedder(fakeProviderStore(), "p1", new QueryEmbeddingCache());

    expect(await embedder.embedQuery("space-1", "alpha query", { subjectUserId: "user-1" })).toEqual(vec(1));
    expect(await embedder.embedQuery("space-1", "alpha query", { subjectUserId: "user-1" })).toEqual(vec(1));
    expect(fetches).toBe(1);
  });

  it("does not cache a degraded (null) result", async () => {
    let fetches = 0;
    __setProviderHttpClientForTests({
      async fetch() {
        fetches += 1;
        // Wrong dimension → embedder returns null, must not be cached.
        return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }], model: "m" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const embedder = new ProviderQueryEmbedder(fakeProviderStore(), "p1", new QueryEmbeddingCache());

    expect(await embedder.embedQuery("space-1", "q", { subjectUserId: "user-1" })).toBeNull();
    expect(await embedder.embedQuery("space-1", "q", { subjectUserId: "user-1" })).toBeNull();
    expect(fetches).toBe(2); // not cached → retried
  });

  it("bypasses the cache on { cache: false } but refreshes it with the fresh vector", async () => {
    const cache = new QueryEmbeddingCache();
    cache.set("space-1", "alpha query", vec(0), EMBED_DIMENSIONS); // stale entry
    let fetches = 0;
    __setProviderHttpClientForTests({
      async fetch() {
        fetches += 1;
        return new Response(JSON.stringify({ data: [{ embedding: vec(1), index: 0 }], model: "m" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const embedder = new ProviderQueryEmbedder(fakeProviderStore(), "p1", cache);

    // cache:false ignores the stale cached vec(0) and forces a fresh embed → vec(1).
    expect(await embedder.embedQuery("space-1", "alpha query", {
      cache: false,
      subjectUserId: "user-1",
    })).toEqual(vec(1));
    expect(fetches).toBe(1);
    // The fresh vector refreshed the cache, so a normal call now serves it without a fetch.
    expect(await embedder.embedQuery("space-1", "alpha query", { subjectUserId: "user-1" })).toEqual(vec(1));
    expect(fetches).toBe(1);
  });
});
