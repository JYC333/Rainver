import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService, type RetrievalCandidateScope } from "../src/modules/retrieval/searchService.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";
import { RetrievalEmbeddingBackfillService, type RetrievalEmbedder } from "../src/modules/retrieval/embedding/service.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

// A caller's candidate scope is applied inside each arm's SQL candidate query
// and before each graph hop's limit, so stronger out-of-scope matches cannot
// fill a limit and starve the in-scope ones; in-scope results keep their
// normal ranking order. Real Postgres: the scope's refs are SQL predicates.

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** More strong out-of-scope matches than any arm's (or hop's) fetch limit. */
const OUTSIDE = 60;
const outsideIds = Array.from({ length: OUTSIDE }, (_, index) => `out-${String(index).padStart(2, "0")}`);
// In-scope pages, strongest first: the expected normal order.
const INSIDE = ["in-strong", "in-middle", "in-weak"] as const;
const key = (id: string) => `knowledge_item:${id}`;

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Scope', 'personal', now(), now())`, [SPACE]);
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'U', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [VIEWER],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('scope-viewer', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
});

async function seedLexical(): Promise<void> {
  // Out-of-scope pages match the query densely and are newer, so SQL orders
  // every one of them ahead of the in-scope pages.
  for (const id of outsideIds) {
    await insertKnowledgeItem(db.pool, { id, spaceId: SPACE, title: `Page ${id}`, content: "quasar quasar quasar quasar quasar", slug: id });
  }
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const inside: [string, string, string][] = [
    ["in-strong", "quasar quasar quasar notes", daysAgo(30)],
    ["in-middle", "quasar quasar notes and more words here", daysAgo(31)],
    ["in-weak", "quasar notes with many more unrelated words in the body text", daysAgo(32)],
  ];
  for (const [id, content, updatedAt] of inside) {
    await insertKnowledgeItem(db.pool, { id, spaceId: SPACE, title: `Page ${id}`, content, slug: id, updatedAt });
  }
  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
}

function search(query: string, candidateScope?: RetrievalCandidateScope, maxResults = 3) {
  return new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry).search({
    spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"], query, maxResults, mode: "lexical",
    ...(candidateScope ? { candidateScope } : {}),
  });
}

const admitsOnly = (ids: readonly string[]): RetrievalCandidateScope["admits"] => async (candidates) =>
  new Set(candidates.map((c) => `${c.objectType}:${c.objectId}`).filter((k) => ids.map(key).includes(k)));

describe("Retrieval candidate scope (real Postgres)", () => {
  it("returns in-scope matches in normal ranking order when stronger out-of-scope matches exceed the arm limit", async () => {
    if (!db.available) return;
    await seedLexical();

    // Unscoped, the out-of-scope pages fill every slot.
    const open = await search("quasar");
    expect(open.items.map((item) => item.object_id).every((id) => id.startsWith("out-"))).toBe(true);

    const scopes: [string, RetrievalCandidateScope][] = [
      ["allowed refs", { refs: { allowed: INSIDE.map(key) }, admits: admitsOnly(INSIDE) }],
      ["excluded refs", { refs: { excluded: outsideIds.map(key) }, admits: admitsOnly(INSIDE) }],
      // No SQL refs: the opaque decision reads further pages before the limit.
      ["opaque admits", { admits: admitsOnly(INSIDE) }],
    ];
    for (const [name, scope] of scopes) {
      const scoped = await search("quasar", scope);
      expect(scoped.items.map((item) => item.object_id), name).toEqual([...INSIDE]);
    }

    // A narrower scope keeps the same relative order and never leaks.
    const two = await search("quasar", { refs: { allowed: [key("in-weak"), key("in-strong")] }, admits: admitsOnly(["in-weak", "in-strong"]) });
    expect(two.items.map((item) => item.object_id)).toEqual(["in-strong", "in-weak"]);
  });

  it("reaches an in-scope graph neighbor that out-of-scope neighbors would push past the hop limit", async () => {
    if (!db.available) return;
    await insertKnowledgeItem(db.pool, { id: "hub", spaceId: SPACE, title: "Hub page", content: "nebula hub", slug: "hub" });
    await insertKnowledgeItem(db.pool, { id: "in-neighbor", spaceId: SPACE, title: "Inside neighbor", content: "far related material", slug: "in-neighbor" });
    for (const id of outsideIds) {
      await insertKnowledgeItem(db.pool, { id, spaceId: SPACE, title: `Neighbor ${id}`, content: "other related material", slug: id });
    }
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    await db.pool.query(`DELETE FROM retrieval_edges WHERE space_id = $1`, [SPACE]);
    const neighbors: [string, number][] = [...outsideIds.map((id) => [id, 0.9] as [string, number]), ["in-neighbor", 0.1]];
    for (const [to, confidence] of neighbors) {
      await db.pool.query(
        `INSERT INTO retrieval_edges (id, space_id, from_object_type, from_object_id, to_object_type, to_object_id, link_type, edge_origin, edge_status, confidence, evidence_json, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, 'knowledge_item', 'hub', 'knowledge_item', $2, 'supports', 'object_relation_projection', 'derived', $3, '{}'::jsonb, now(), now())`,
        [SPACE, to, confidence],
      );
    }
    const inside = ["hub", "in-neighbor"];
    for (const scope of [
      { refs: { allowed: inside.map(key) }, admits: admitsOnly(inside) },
      { admits: admitsOnly(inside) },
    ] satisfies RetrievalCandidateScope[]) {
      const scoped = await search("nebula", scope, 5);
      expect(scoped.items.map((item) => item.object_id).sort()).toEqual(["hub", "in-neighbor"]);
    }
  });

  it("pages the vector arm by its chunk window, so multi-chunk documents do not end the scoped scan early", async () => {
    if (!db.available) return;
    // Ordinary long pages: each spans several 2200-character chunks, and every
    // chunk of an out-of-scope page is nearer the query than any in-scope one.
    // One chunk window (50) then holds fewer distinct pages than its limit
    // without being the last window.
    const paragraph = (topic: string) =>
      `Field notes on ${topic}. The survey team logged weather, soil and route conditions for each stop along the trail. `;
    // Mid-way through the last chunk, so title or markup cannot shift the count.
    const page = (topic: string, chunks: number) => paragraph(topic).repeat(chunks * 30).slice(0, (chunks - 1) * 2200 + 1100);
    const outside = outsideIds.slice(0, 20);
    for (const id of outside) {
      await insertKnowledgeItem(db.pool, { id, spaceId: SPACE, title: `Page ${id}`, content: page("the northern ridge", 3), slug: id });
    }
    const inside: [string, string, number][] = [
      ["in-strong", "the lower valley", 0.9],
      ["in-middle", "the eastern marsh", 0.8],
      ["in-weak", "the western dunes", 0.7],
    ];
    for (const [id, topic] of inside) {
      await insertKnowledgeItem(db.pool, { id, spaceId: SPACE, title: `Page ${id}`, content: page(topic, 2), slug: id });
    }
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
    const direction = (similarity: number) => {
      const vector = new Array<number>(EMBED_DIMENSIONS).fill(0);
      vector[0] = similarity;
      vector[1] = Math.sqrt(1 - similarity * similarity);
      return vector;
    };
    const embedder: RetrievalEmbedder = {
      async embed(_spaceId, texts) {
        return {
          model: "topic-embed",
          vectors: texts.map((text) => direction(inside.find(([, topic]) => text.includes(topic))?.[2] ?? 1)),
        };
      },
    };
    await new RetrievalEmbeddingBackfillService(db.pool, embedder).backfillSpace(SPACE, { embeddingDimensions: EMBED_DIMENSIONS, batchLimit: 1000 });
    const chunkCounts = await db.pool.query<{ object_id: string; chunks: number }>(
      `SELECT object_id, count(*)::int AS chunks FROM retrieval_chunks WHERE space_id = $1 AND embedding IS NOT NULL GROUP BY object_id`,
      [SPACE],
    );
    // Every chunk is embedded, and every page spans several of them.
    expect(chunkCounts.rows).toHaveLength(outside.length + inside.length);
    expect(chunkCounts.rows.every((row) => row.chunks >= 2)).toBe(true);
    expect((await db.pool.query(`SELECT 1 FROM retrieval_chunks WHERE space_id = $1 AND embedding IS NULL`, [SPACE])).rowCount).toBe(0);

    const vectorSql: { sql: string; params: readonly unknown[] }[] = [];
    const recording = {
      query: (sql, params) => {
        if (sql.includes("WITH nearest")) vectorSql.push({ sql, params: params ?? [] });
        return db.pool.query(sql, params as unknown[]);
      },
    } as Queryable;
    const vectorSearch = (candidateScope?: RetrievalCandidateScope) =>
      new RetrievalSearchService(recording, knowledgeRetrievalRegistry, { queryEmbedder: { async embedQuery() { return direction(1); } } }).search({
        spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"], query: "qqqzzz no lexical overlap", maxResults: 3,
        ...(candidateScope ? { candidateScope } : {}),
      });

    // Unscoped: one window, and the out-of-scope pages fill every slot.
    const open = await vectorSearch();
    expect(vectorSql).toHaveLength(1);
    expect(open.items.map((item) => item.object_id).every((id) => id.startsWith("out-"))).toBe(true);

    for (const [name, scope] of [
      ["allowed refs", { refs: { allowed: INSIDE.map(key) }, admits: admitsOnly(INSIDE) }],
      ["opaque admits", { admits: admitsOnly(INSIDE) }],
    ] satisfies [string, RetrievalCandidateScope][]) {
      const scoped = await vectorSearch(scope);
      expect(scoped.items.map((item) => item.object_id), name).toEqual([...INSIDE]);
      expect(scoped.items.every((item) => item.evidence.kind === "vector_match"), name).toBe(true);
    }
    // A narrower opaque scope keeps relative order and never leaks.
    const two = await vectorSearch({ admits: admitsOnly(["in-weak", "in-strong"]) });
    expect(two.items.map((item) => item.object_id)).toEqual(["in-strong", "in-weak"]);

    // The paged window is still an ANN query on the partial HNSW index.
    const { sql, params } = vectorSql.at(-1)!;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ANALYZE retrieval_chunks, retrieval_objects");
      // Forbid the plans a tiny table prefers (scan + sort) so only the index can order the window.
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_sort = off");
      const plan = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params as unknown[]);
      expect(JSON.stringify(plan.rows)).toContain(`ix_retrieval_chunks_embedding_hnsw_${EMBED_DIMENSIONS}`);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
