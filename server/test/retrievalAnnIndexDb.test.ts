import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import { toVectorLiteral } from "../src/modules/retrieval/embeddingStore.js";
import { type QueryEmbedder } from "../src/modules/retrieval/types.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
} from "../src/modules/retrieval/embedding/service.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

// W5 ANN path: the default embedding dimension (2560) has a halfvec HNSW partial
// index, and the vector arm emits a matching constant-dimension halfvec cosine
// query so the planner can use it. This asserts the index ships in 0001, that the
// planner uses it for the arm's query shape, and that recall still holds.

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function oneHot(slot: number, dim = EMBED_DIMENSIONS): number[] {
  const v = new Array<number>(dim).fill(0);
  v[slot % dim] = 1;
  return v;
}

// Each chunk embeds to a slot derived from a marker token; the query embeds to
// the same slot, so the nearest neighbour is deterministic.
const markerEmbedder: RetrievalEmbedder = {
  async embed(_spaceId, texts) {
    return {
      model: "marker-embed",
      vectors: texts.map((t) => oneHot(t.includes("target") ? 1 : 7)),
    };
  },
};
const targetQueryEmbedder: QueryEmbedder = {
  async embedQuery() {
    return oneHot(1);
  },
};


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Ann', 'personal', now(), now())`, [SPACE]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'U', 'active', now(), now())`, [VIEWER]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('ann-viewer', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
});

async function seed(id: string, title: string, content: string): Promise<void> {
  await insertKnowledgeItem(db.pool, { id, spaceId: SPACE, title, content, slug: id });
}

describe("Retrieval ANN halfvec index (real Postgres + pgvector)", () => {
  it("ships the default-dimension halfvec HNSW index in the baseline", async () => {
    if (!db.available) return;
    const idx = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_retrieval_chunks_embedding_hnsw_2560'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]!.indexdef).toMatch(/USING hnsw/i);
    expect(idx.rows[0]!.indexdef).toMatch(/halfvec/i);
  });

  it(
    "the planner uses the HNSW index for the arm's constant-dimension halfvec query",
    async () => {
      if (!db.available) return;
      for (let i = 0; i < 40; i++) await seed(`noise-${i}`, `Noise ${i}`, `noise chunk ${i}`);
      await seed("target", "Target doc", "the target chunk");
      const svc = new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry);
      await svc.reindexAll(SPACE);
      await new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder).backfillSpace(SPACE, {
        embeddingDimensions: EMBED_DIMENSIONS,
      });

      // EXPLAIN the exact halfvec query shape the vector arm emits at the default
      // dim. SET + EXPLAIN must run on the SAME connection (a GUC set via the db.pool
      // could otherwise land on a different pooled connection under load), so use a
      // dedicated client.
      const client = await db.pool.connect();
      let planText: string;
      try {
        await client.query("SET enable_seqscan = off");
        const plan = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (FORMAT TEXT)
             SELECT rc.object_id, rc.embedding::halfvec(2560) <=> $1::halfvec(2560) AS distance
               FROM retrieval_chunks rc
              WHERE rc.space_id = $2
                AND rc.embedding IS NOT NULL
                AND rc.embedding_dimensions = 2560
              ORDER BY rc.embedding::halfvec(2560) <=> $1::halfvec(2560)
              LIMIT 10`,
          [toVectorLiteral(oneHot(1)), SPACE],
        );
        planText = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      } finally {
        client.release();
      }
      expect(planText).toMatch(/ix_retrieval_chunks_embedding_hnsw_2560/);
    },
    15_000,
  );

  it("recalls the nearest object at the default dimension through the arm", async () => {
    if (!db.available) return;
    await seed("target", "Target doc", "the target chunk");
    await seed("other", "Other doc", "an unrelated chunk");
    const svc = new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry);
    await svc.reindexAll(SPACE);
    await new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder).backfillSpace(SPACE, {
      embeddingDimensions: EMBED_DIMENSIONS,
    });

    const result = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      queryEmbedder: targetQueryEmbedder,
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "qqq no lexical overlap", // forces the vector arm to decide
      mode: "hybrid",
      maxResults: 10,
    });
    expect(result.items[0]).toMatchObject({ object_id: "target", evidence: { kind: "vector_match" } });
  });
});
