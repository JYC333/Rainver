import { beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import { toVectorLiteral } from "../src/modules/retrieval/embeddingStore.js";
import type { QueryEmbedder } from "../src/modules/retrieval/types.js";
import type { Queryable } from "../src/modules/proposals/repository.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

// The vector arm under sparse visibility reads larger windows from the nearest
// chunk (never OFFSET pages over a distance-only order), so equal distances
// neither repeat nor skip objects, an object with several chunks is offered
// once at its best chunk, and the read stays within four windows.

const SPACE = "11111111-1111-4111-8111-1111111111e1";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae1";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbe1";
const QUERY = "qqqzzz no lexical overlap";

const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "users", "spaces"], { cascade: true });
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Vec', 'team', now(), now())`, [SPACE]);
  for (const id of [VIEWER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1, 'U', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [id]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', 'active', now(), now())`, [SPACE, id]);
  }
});

function unit(slot: number): number[] {
  const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
  v[slot] = 1;
  return v;
}

const queryEmbedder: QueryEmbedder = { async embedQuery() { return unit(0); } };

/** Chunk `position` of a strictly ordered arc: distance to the query grows with it. */
function onArc(position: number): number[] {
  const v = unit(0);
  const angle = 0.3 + position * 0.004;
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

// Integer points with a² + b² = 5525 (48 of them): exact in halfvec and in
// float sums, so `(100, a, b)` in any plane has one and the same distance to
// the query, and the points of a plane form a ring HNSW can navigate.
// (Mutually orthogonal ties, by contrast, leave most of pgvector's graph unreachable.)
const LATTICE: Array<[number, number]> = [];
for (let a = -74; a <= 74; a += 1) {
  const b = Math.sqrt(5525 - a * a);
  if (Number.isInteger(b)) LATTICE.push([a, b], ...(b ? [[a, -b] as [number, number]] : []));
}

/** Every vector at exactly the same distance from the query, each in its own direction. */
function equidistant(index: number): number[] {
  const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
  const [a, b] = LATTICE[index % LATTICE.length]!;
  const plane = Math.floor(index / LATTICE.length);
  v[0] = 100;
  v[1 + plane * 2] = a;
  v[2 + plane * 2] = b;
  return v;
}

/** The objects the HNSW index itself returns for one window, under the arm's scan settings. */
async function indexReach(size: number): Promise<Set<string>> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    await client.query("SET LOCAL enable_bitmapscan = off");
    await client.query("SET LOCAL enable_sort = off");
    await client.query(`SELECT set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.max_scan_tuples', '20000', true)`);
    const rows = await client.query<{ object_id: string }>(
      `SELECT object_id FROM retrieval_chunks
        WHERE space_id = $1 AND embedding IS NOT NULL AND embedding_dimensions = 2560
        ORDER BY embedding::halfvec(2560) <=> $2::halfvec(2560) LIMIT $3`, [SPACE, toVectorLiteral(unit(0)), size]);
    return new Set(rows.rows.map((row) => row.object_id));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function seedObjects(objects: Array<{ id: string; readable: boolean; chunks: number[][] }>): Promise<void> {
  for (const object of objects) {
    await insertKnowledgeItem(db.pool, {
      id: object.id, spaceId: SPACE, title: `Note ${object.id}`, content: `Routine note ${object.id}.`, slug: object.id,
      visibility: object.readable ? "space_shared" : "private", ownerUserId: object.readable ? null : OTHER, createdByUserId: object.readable ? null : OTHER,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
  for (const object of objects) {
    const first = await db.pool.query<{ id: string }>(
      `SELECT id FROM retrieval_chunks WHERE space_id = $1 AND object_id = $2 ORDER BY chunk_index LIMIT 1`, [SPACE, object.id]);
    await db.pool.query(`DELETE FROM retrieval_chunks WHERE space_id = $1 AND object_id = $2 AND id <> $3`, [SPACE, object.id, first.rows[0]!.id]);
    for (const [index, vector] of object.chunks.entries()) {
      const values = [toVectorLiteral(vector), EMBED_DIMENSIONS];
      if (index === 0) {
        await db.pool.query(
          `UPDATE retrieval_chunks SET embedding = $1::vector, embedding_dimensions = $2, embedding_model = 'fixture', embedding_generated_at = now()
            WHERE id = $3`, [...values, first.rows[0]!.id]);
      } else {
        await db.pool.query(
          `INSERT INTO retrieval_chunks (id, retrieval_object_id, space_id, object_type, object_id, chunk_index, plain_text, content_hash,
                                         embedding, embedding_model, embedding_dimensions, embedding_generated_at, created_at, updated_at)
           SELECT gen_random_uuid()::text, retrieval_object_id, space_id, object_type, object_id, $4, plain_text, content_hash,
                  $1::vector, 'fixture', $2, now(), now(), now()
             FROM retrieval_chunks WHERE id = $3`, [...values, first.rows[0]!.id, index]);
      }
    }
  }
  await db.pool.query(`ANALYZE retrieval_chunks`);
}

type Plan = "exact" | "hnsw";

/** Searches on one client in a rolled-back transaction that pins the plan. */
async function search(plan: Plan, maxResults: number, capture?: Array<{ sql: string; params: unknown[] }>): Promise<string[]> {
  const client: PoolClient = await db.pool.connect();
  try {
    await client.query("BEGIN");
    if (plan === "exact") {
      await client.query("SET LOCAL enable_indexscan = off");
    } else {
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_sort = off");
    }
    const recording: Queryable = {
      query(sql, params) {
        if (capture && sql.includes("WITH nearest AS")) capture.push({ sql, params: [...(params ?? [])] });
        return client.query(sql, params as unknown[]) as never;
      },
    };
    const result = await new RetrievalSearchService(recording, knowledgeRetrievalRegistry, { queryEmbedder }).search({
      spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"], query: QUERY, maxResults, useCache: false,
    });
    return result.items.map((item) => item.object_id);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

describe("Vector arm windows under sparse visibility (real Postgres + pgvector)", () => {
  it("offers each object once at its best chunk, in distance order, across windows and within the four-window bound", async () => {
    if (!db.available) return;
    // Chunk positions on the arc: a window at maxResults 5 holds 50 chunks; the
    // fourth and last holds the nearest 200. Hidden objects own the rest.
    const readable = [
      { id: "r-a", readable: true, positions: [10, 150] },   // windows 1 and 3: once, at 10
      { id: "r-b", readable: true, positions: [120, 130] },  // window 3, two chunks
      { id: "r-c", readable: true, positions: [190] },       // window 4
      { id: "r-d", readable: true, positions: [260] },       // beyond the bound
    ];
    const taken = new Set(readable.flatMap((object) => object.positions));
    const free = Array.from({ length: 270 }, (_, position) => position).filter((position) => !taken.has(position));
    const hidden = Array.from({ length: 53 }, (_, index) => ({ id: `h-${String(index).padStart(2, "0")}`, readable: false, positions: free.slice(index * 5, index * 5 + 5) }));
    await seedObjects([...readable, ...hidden].map((object) => ({ ...object, chunks: object.positions.map(onArc) })));
    for (const plan of ["exact", "hnsw"] as const) {
      const capture: Array<{ sql: string; params: unknown[] }> = [];
      expect(await search(plan, 5, capture), plan).toEqual(["r-a", "r-b", "r-c"]);
      // Windows of 50, 100, 150, 200 chunks, each from the nearest chunk.
      expect(capture.map((statement) => statement.params[4]), plan).toEqual([50, 100, 150, 200]);
      expect(capture.every((statement) => !/\bOFFSET\b/i.test(statement.sql)), plan).toBe(true);
    }
  });

  it("covers every equidistant object the windows reach, the same way on every read", async () => {
    if (!db.available) return;
    // 150 objects at exactly one distance; 10 readable spread through the id order.
    const objects = Array.from({ length: 150 }, (_, index) => ({
      id: `tie-${String(index).padStart(3, "0")}`, readable: index % 15 === 7, chunks: [equidistant(index)],
    }));
    await seedObjects(objects);
    const readable = objects.filter((object) => object.readable).map((object) => object.id);
    expect(readable).toHaveLength(10);
    const distances = await db.pool.query<{ n: number }>(
      `SELECT count(DISTINCT embedding::halfvec(2560) <=> $1::halfvec(2560))::int AS n FROM retrieval_chunks WHERE space_id = $2`,
      [toVectorLiteral(unit(0)), SPACE]);
    expect(distances.rows[0]!.n).toBe(1);
    // An exact scan reaches all 150; the approximate index may miss an element
    // of its own graph, and the windows must lose nothing it does return.
    const reach = { exact: new Set(objects.map((object) => object.id)), hnsw: await indexReach(150) };
    for (const plan of ["exact", "hnsw"] as const) {
      const expected = readable.filter((id) => reach[plan].has(id));
      expect(expected.length, plan).toBeGreaterThanOrEqual(8);
      const reads = [await search(plan, 10), await search(plan, 10), await search(plan, 10)];
      for (const ids of reads) {
        expect(new Set(ids).size, plan).toBe(ids.length);
        expect([...ids].sort(), plan).toEqual(expected);
      }
      expect(reads[1], plan).toEqual(reads[0]);
      expect(reads[2], plan).toEqual(reads[0]);
      // Fewer readable than requested stops at the target: five of them, no hidden one.
      const five = await search(plan, 5);
      expect(five, plan).toHaveLength(5);
      expect(five.every((id) => readable.includes(id)), plan).toBe(true);
    }
  });

  it("returns exactly the readable objects of its last window when ties outnumber the bound", async () => {
    if (!db.available) return;
    // 400 objects at one distance: more than the 200-chunk bound, where OFFSET
    // pages over an exact scan's tie order were seen to repeat and skip rows.
    const objects = Array.from({ length: 400 }, (_, index) => ({
      id: `tie-${String(index).padStart(3, "0")}`, readable: index % 8 === 3, chunks: [equidistant(index)],
    }));
    await seedObjects(objects);
    const readable = new Set(objects.filter((object) => object.readable).map((object) => object.id));
    const capture: Array<{ sql: string; params: unknown[] }> = [];
    const ids = await search("exact", 10, capture);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    // The last window, read again: the result is drawn from exactly its readable objects.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_indexscan = off");
      const last = capture.at(-1)!;
      const window = await client.query<{ object_id: string }>(last.sql, last.params);
      expect(window.rows).toHaveLength(last.params[4] as number);
      // Ties rank by id, and the search returns its ten best.
      const offered = window.rows.map((row) => row.object_id).filter((id) => readable.has(id)).sort();
      expect(offered.length).toBeGreaterThanOrEqual(10);
      expect(ids).toEqual(offered.slice(0, 10));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("keeps the window statement on the HNSW index", async () => {
    if (!db.available) return;
    await seedObjects(Array.from({ length: 60 }, (_, index) => ({ id: `p-${index}`, readable: index === 59, chunks: [onArc(index)] })));
    const capture: Array<{ sql: string; params: unknown[] }> = [];
    expect(await search("hnsw", 5, capture)).toEqual(["p-59"]);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_sort = off");
      await client.query(`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`);
      const last = capture.at(-1)!;
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (FORMAT TEXT) ${last.sql}`, last.params);
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(/Index Scan using ix_retrieval_chunks_embedding_hnsw_2560/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
