import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import { type QueryEmbedder } from "../src/modules/retrieval/types.js";
import { type QueryRewriter } from "../src/modules/retrieval/queryRewrite.js";
import { type RerankCandidate, type Reranker } from "../src/modules/retrieval/reranker.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
} from "../src/modules/retrieval/embedding/service.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

// The search-mode tier (exact / lexical / hybrid / hybrid_rerank) selects which
// arms and LLM stages run. These assertions read the diagnostic trace to prove
// the gating: each tier only runs the arms it should, the LLM rerank stage runs
// only in hybrid_rerank, and query rewriting is ignored in exact mode.

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function oneHot(slot: number): number[] {
  const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
  v[slot] = 1;
  return v;
}

/** Embeds a chunk into a one-hot direction chosen by a marker in its text. */
function markerEmbedder(): RetrievalEmbedder {
  return {
    async embed(_spaceId, texts) {
      return { model: "marker", vectors: texts.map((t) => oneHot(t.includes("aaa") ? 0 : 1)) };
    },
  };
}

function querySlot(slot: number): QueryEmbedder {
  return { async embedQuery() { return oneHot(slot); } };
}

function capturingReranker(sink: RerankCandidate[]): Reranker {
  return {
    async rerank(_spaceId, _viewerUserId, _query, candidates) {
      sink.push(...candidates);
      return null; // keep fused order; we only assert that it was (not) invoked.
    },
  };
}

function movingReranker(sink: RerankCandidate[]): Reranker {
  return {
    async rerank(_spaceId, _viewerUserId, _query, candidates) {
      sink.push(...candidates);
      return candidates.map((candidate) => ({
        objectType: candidate.objectType,
        objectId: candidate.objectId,
        score: candidate.objectId === "beta" ? 1 : 0,
      }));
    },
  };
}

function fixedRewriter(variants: string[], sink: string[]): QueryRewriter {
  return {
    async rewrite(_spaceId, _viewerUserId, query) {
      sink.push(query);
      return variants;
    },
  };
}

interface SearchTrace {
  arms: Record<string, number>;
  mode: string;
  rerank?: { sent: number; applied: boolean; moved?: number };
  rewrite?: { variants: number; applied: boolean };
}


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Modes', 'personal', now(), now())`,
    [SPACE],
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'U', 'active', now(), now())`,
    [VIEWER],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('modes-viewer', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
});

async function seed(): Promise<void> {
  for (const [id, content] of [
    ["alpha", "alpha report aaa"],
    ["beta", "beta report bbb"],
  ]) {
    await insertKnowledgeItem(db.pool, {
      id,
      spaceId: SPACE,
      title: `${id} report`,
      content,
      slug: id,
    });
  }
  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
  await new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder()).backfillSpace(SPACE);
}

function service(
  rerankSink: RerankCandidate[],
  rewriteSink: string[],
  reranker: Reranker = capturingReranker(rerankSink),
): RetrievalSearchService {
  return new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
    queryEmbedder: querySlot(0), // matches "alpha" direction
    reranker,
    queryRewriter: fixedRewriter(["alpha summary"], rewriteSink),
  });
}

async function searchTrace(
  mode: "exact" | "lexical" | "hybrid" | "hybrid_rerank",
  opts: { rewrite?: boolean } = {},
): Promise<{ trace: SearchTrace; reranked: RerankCandidate[]; rewritten: string[] }> {
  const reranked: RerankCandidate[] = [];
  const rewritten: string[] = [];
  const response = await service(reranked, rewritten).search({
    spaceId: SPACE,
    viewerUserId: VIEWER,
    objectTypes: ["knowledge_item"],
    query: "report",
    maxResults: 10,
    includeTrace: true,
    mode,
    rewrite: opts.rewrite,
  });
  return { trace: response.trace as unknown as SearchTrace, reranked, rewritten };
}

describe("Retrieval search modes (real Postgres + pgvector)", () => {
  it("exact mode runs only the exact arm — no lexical/vector/graph, no rerank", async () => {
    if (!db.available) return;
    await seed();
    const { trace, reranked } = await searchTrace("exact");
    expect(trace.mode).toBe("exact");
    expect(trace.arms.lexical).toBe(0);
    expect(trace.arms.vector).toBe(0);
    expect(trace.arms.graph).toBe(0);
    expect(reranked).toHaveLength(0);
  });

  it("lexical mode runs the lexical arm but not the vector arm or rerank", async () => {
    if (!db.available) return;
    await seed();
    const { trace, reranked } = await searchTrace("lexical");
    expect(trace.mode).toBe("lexical");
    expect(trace.arms.lexical).toBeGreaterThan(0);
    expect(trace.arms.vector).toBe(0);
    expect(reranked).toHaveLength(0);
  });

  it("hybrid mode adds the vector arm but still does not rerank", async () => {
    if (!db.available) return;
    await seed();
    const { trace, reranked } = await searchTrace("hybrid");
    expect(trace.mode).toBe("hybrid");
    expect(trace.arms.lexical).toBeGreaterThan(0);
    expect(trace.arms.vector).toBeGreaterThan(0);
    expect(reranked).toHaveLength(0);
  });

  it("hybrid_rerank mode invokes the reranker over the visible candidates", async () => {
    if (!db.available) return;
    await seed();
    const { trace, reranked } = await searchTrace("hybrid_rerank");
    expect(trace.mode).toBe("hybrid_rerank");
    expect(trace.arms.vector).toBeGreaterThan(0);
    expect(reranked.length).toBeGreaterThan(0);
    expect(trace.rerank?.applied).toBe(false); // fake returns null → degrades, but it WAS invoked
    expect(trace.rerank?.sent).toBeGreaterThan(0);
  });

  it("records how many visible candidates moved when rerank applies", async () => {
    if (!db.available) return;
    await seed();
    const reranked: RerankCandidate[] = [];
    const response = await service(reranked, [], movingReranker(reranked)).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "report",
      maxResults: 10,
      includeTrace: true,
      mode: "hybrid_rerank",
    });

    const trace = response.trace as unknown as SearchTrace;
    expect(trace.rerank?.applied).toBe(true);
    expect(trace.rerank?.sent).toBeGreaterThan(1);
    expect(trace.rerank?.moved).toBeGreaterThan(0);
  });

  it("query rewriting is opt-in and ignored in exact mode", async () => {
    if (!db.available) return;
    await seed();
    // hybrid + rewrite:true → rewriter invoked, free-text arms search the variant too.
    const hybrid = await searchTrace("hybrid", { rewrite: true });
    expect(hybrid.rewritten).toEqual(["report"]);
    expect(hybrid.trace.rewrite?.applied).toBe(true);

    // exact + rewrite:true → rewrite is ignored (no free-text arms run).
    const exact = await searchTrace("exact", { rewrite: true });
    expect(exact.rewritten).toHaveLength(0);
    expect(exact.trace.rewrite).toBeUndefined();
  });
});
