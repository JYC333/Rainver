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

// Vector recall arm end-to-end on pgvector: a query that matches NOTHING
// lexically still surfaces a semantically-near object via the embedding arm, and
// the arm's hits go through the SAME revalidate gate (an embedded-but-unreadable
// object is never returned).

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Embeds a chunk into a one-hot direction chosen by a marker in its text. */
function markerEmbedder(dim = EMBED_DIMENSIONS): RetrievalEmbedder {
  const slotFor = (t: string): number =>
    t.includes("aaa") ? 0 : t.includes("bbb") ? 1 : t.includes("ccc") ? 2 : 3;
  return {
    async embed(_spaceId, texts) {
      return {
        model: "marker-embed",
        vectors: texts.map((t) => oneHot(slotFor(t), dim)),
      };
    },
  };
}

/** Query embedder fixed to one direction (graceful-degrade returns are not used here). */
function querySlot(slot: number, dim = EMBED_DIMENSIONS): QueryEmbedder {
  return { async embedQuery() { return oneHot(slot, dim); } };
}

function oneHot(slot: number, dim = EMBED_DIMENSIONS): number[] {
  const v = new Array<number>(dim).fill(0);
  v[slot] = 1;
  return v;
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
     VALUES ($1, 'Vec', 'personal', now(), now())`,
    [SPACE],
  );
  for (const id of [VIEWER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1, 'U', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
      [id],
    );
  }
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('vector-viewer', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
});

async function seedKnowledge(doc: {
  id: string;
  title: string;
  content: string;
  visibility?: string;
  owner?: string | null;
}): Promise<void> {
  await insertKnowledgeItem(db.pool, {
    id: doc.id,
    spaceId: SPACE,
    title: doc.title,
    content: doc.content,
    slug: doc.id,
    visibility: doc.visibility ?? "space_shared",
    ownerUserId: doc.owner ?? null,
    createdByUserId: doc.owner ?? null,
  });
}

async function reindexAndEmbed(dim = EMBED_DIMENSIONS): Promise<void> {
  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
  await new RetrievalEmbeddingBackfillService(db.pool, markerEmbedder(dim)).backfillSpace(SPACE, {
    embeddingDimensions: dim,
  });
}

describe("Vector recall arm (real Postgres + pgvector)", () => {
  it("surfaces a semantically-near object that the deterministic arms miss", async () => {
    if (!db.available) return;
    await seedKnowledge({ id: "alpha", title: "Alpha doc", content: "alpha marker aaa" });
    await seedKnowledge({ id: "beta", title: "Beta doc", content: "beta marker bbb" });
    await reindexAndEmbed();

    // A query that matches no alias/title/lexical content at all.
    const query = "qqqzzz no lexical overlap";

    // Without an embedder, the deterministic arms return nothing.
    const deterministic = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query,
      maxResults: 10,
    });
    expect(deterministic.items).toHaveLength(0);

    // With the vector arm (query in the "alpha" direction), alpha is recalled.
    const hybrid = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      queryEmbedder: querySlot(0),
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query,
      maxResults: 10,
    });

    expect(hybrid.items[0]).toMatchObject({
      object_id: "alpha",
      evidence: { kind: "vector_match" },
    });
  });

  it("still drops a vector hit the viewer may not read (revalidate gate holds)", async () => {
    if (!db.available) return;
    // A private knowledge item owned by OTHER, embedded in the "ccc" direction.
    await seedKnowledge({
      id: "secret",
      title: "Secret doc",
      content: "secret marker ccc",
      visibility: "private",
      owner: OTHER,
    });
    await reindexAndEmbed();

    const result = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      queryEmbedder: querySlot(2),
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER, // not the owner
      objectTypes: ["knowledge_item"],
      query: "qqqzzz no lexical overlap",
      maxResults: 10,
    });

    // The vector arm matched it in the projection, but revalidate gates it out.
    expect(result.items.map((i) => i.object_id)).not.toContain("secret");
  });

  it("supports a non-default embedding dimension for model experiments", async () => {
    if (!db.available) return;
    const dim = 384;
    await seedKnowledge({ id: "alpha", title: "Alpha doc", content: "alpha marker aaa" });
    await seedKnowledge({ id: "beta", title: "Beta doc", content: "beta marker bbb" });
    await reindexAndEmbed(dim);

    const row = await db.pool.query<{ dims: number }>(
      `SELECT embedding_dimensions AS dims FROM retrieval_chunks
        WHERE embedding IS NOT NULL
        LIMIT 1`,
    );
    expect(row.rows[0]?.dims).toBe(dim);

    const result = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      queryEmbedder: querySlot(1, dim),
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "qqqzzz no lexical overlap",
      maxResults: 10,
    });

    expect(result.items[0]).toMatchObject({
      object_id: "beta",
      evidence: { kind: "vector_match" },
    });
  });
});

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
      for (let i = 0; i < 40; i++) {
        await seedKnowledge({ id: `noise-${i}`, title: `Noise ${i}`, content: `noise chunk ${i}` });
      }
      await seedKnowledge({ id: "target", title: "Target doc", content: "target marker bbb" });
      await reindexAndEmbed();

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
  );

  it("reaches an in-Space match past more than ef_search nearer chunks of another Space", async () => {
    if (!db.available) return;
    const NEIGHBOUR = "22222222-2222-4222-8222-222222222222";
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Neighbour', 'personal', now(), now())`,
      [NEIGHBOUR],
    );
    // 120 chunks nearer the query than the target, all outside the searched
    // Space: more than the default hnsw.ef_search (40) the index returns
    // before the Space filter, without an iterative scan.
    for (let i = 0; i < 120; i++) {
      await insertKnowledgeItem(db.pool, {
        id: `neighbour-${i}`, spaceId: NEIGHBOUR, title: `Neighbour ${i}`, content: `neighbour bbb ${i}`,
        slug: `neighbour-${i}`, visibility: "space_shared", ownerUserId: null, createdByUserId: null,
      });
    }
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(NEIGHBOUR);
    // Each neighbour gets its own direction close to the query's: pgvector
    // folds identical vectors into one graph element, which would hide them
    // from ef_search.
    const nearQuery: RetrievalEmbedder = {
      async embed(_spaceId, texts) {
        return {
          model: "marker-embed",
          vectors: texts.map((t) => {
            // The in-Space target sits farther away than every neighbour.
            if (t.includes("aaa")) return oneHot(0).map((x, i) => (i === 1 ? 0.5 : x));
            // Deterministic scatter around the query direction: equidistant
            // points would be pruned into a disconnected graph.
            let seed = Number(/bbb (\d+)/.exec(t)?.[1] ?? 0) * 7919 + 17;
            const v = oneHot(1).map((x) => x * 2);
            for (let d = 2; d < 18; d++) {
              seed = (seed * 1103515245 + 12345) % 2147483648;
              v[d] = seed / 2147483648 - 0.5;
            }
            return v;
          }),
        };
      },
    };
    await new RetrievalEmbeddingBackfillService(db.pool, nearQuery).backfillSpace(NEIGHBOUR, {
      embeddingDimensions: EMBED_DIMENSIONS,
    });
    await seedKnowledge({ id: "target", title: "Target doc", content: "target marker aaa" });
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    await new RetrievalEmbeddingBackfillService(db.pool, nearQuery).backfillSpace(SPACE, {
      embeddingDimensions: EMBED_DIMENSIONS,
    });
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      // Force the index, as a large table would; the setting stays in this transaction.
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_sort = off");
      const result = await new RetrievalSearchService(client, knowledgeRetrievalRegistry, {
        queryEmbedder: querySlot(1),
      }).search({
        spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"],
        query: "qqqzzz no lexical overlap", maxResults: 10,
      });
      expect(result.items.map((item) => item.object_id)).toContain("target");
      // The page's iterative scan does not outlive it in the caller's transaction.
      expect((await client.query("SELECT current_setting('hnsw.iterative_scan') AS scan")).rows[0].scan).toBe("off");
      await client.query("ROLLBACK");
      // An idle client in autocommit still gets the scan for the page, and no
      // transaction is left open on it.
      await client.query("SET enable_seqscan = off");
      await client.query("SET enable_bitmapscan = off");
      await client.query("SET enable_sort = off");
      const idle = await new RetrievalSearchService(client, knowledgeRetrievalRegistry, {
        queryEmbedder: querySlot(1),
      }).search({
        spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"],
        query: "qqqzzz no lexical overlap", maxResults: 10,
      });
      expect(idle.items.map((item) => item.object_id)).toContain("target");
      expect((await client.query("SELECT now() = statement_timestamp() AS idle")).rows[0].idle).toBe(true);
      await client.query("RESET ALL");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("runs rewrite variants' ANN pages one after another on a shared client", async () => {
    if (!db.available) return;
    await seedKnowledge({ id: "target", title: "Target doc", content: "target marker aaa" });
    await reindexAndEmbed();
    const client = await db.pool.connect();
    const statements: string[] = [];
    // The caller's client, recording what reaches its connection.
    const recorded = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (text: unknown, ...rest: unknown[]) => {
          statements.push(typeof text === "string" ? text : String((text as { text?: string }).text));
          return (target.query as (...args: unknown[]) => unknown).call(target, text, ...rest);
        };
      },
    });
    const service = new RetrievalSearchService(recorded, knowledgeRetrievalRegistry, {
      queryEmbedder: querySlot(0),
      queryRewriter: { async rewrite() { return ["variant one", "variant two", "variant three"]; } },
    });
    const search = () => service.search({
      spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"],
      query: "qqqzzz no lexical overlap", maxResults: 10, rewrite: true,
    });
    // Each ANN page's window closes before the next one opens.
    const expectWindowsDoNotNest = (opens: string, closes: string) => {
      let open = 0;
      let windows = 0;
      for (const sql of statements) {
        if (sql === opens) { open += 1; windows += 1; }
        if (sql === closes) open -= 1;
        expect(open).toBeLessThanOrEqual(1);
      }
      expect(windows).toBeGreaterThan(1);
      statements.length = 0;
    };
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE spaces SET name = 'Inside caller' WHERE id = $1`, [SPACE]);
      const inTransaction = await search();
      expect(inTransaction.items.map((item) => item.object_id)).toContain("target");
      expectWindowsDoNotNest("SAVEPOINT retrieval_ann_scan", "RELEASE SAVEPOINT retrieval_ann_scan");
      // The caller's transaction is still usable, with its own write, and no
      // page's setting outlives the page.
      expect((await client.query(`SELECT name FROM spaces WHERE id = $1`, [SPACE])).rows[0].name).toBe("Inside caller");
      expect((await client.query("SELECT current_setting('hnsw.iterative_scan') AS scan")).rows[0].scan).toBe("off");
      await client.query("COMMIT");
      expect((await db.pool.query(`SELECT name FROM spaces WHERE id = $1`, [SPACE])).rows[0].name).toBe("Inside caller");

      // An idle client: each page opens and commits its own transaction in turn.
      statements.length = 0;
      const idle = await search();
      expect(idle.items.map((item) => item.object_id)).toContain("target");
      expectWindowsDoNotNest("BEGIN", "COMMIT");
      expect((await client.query("SELECT now() = statement_timestamp() AS idle")).rows[0].idle).toBe(true);
      expect((await client.query("SELECT current_setting('hnsw.iterative_scan') AS scan")).rows[0].scan).toBe("off");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
