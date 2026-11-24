// Measurement harness for ④ search under sparse visibility (not in the canonical suite).
// Copy to server/test/zzSearchSparse.tmp.test.ts and run from server/ (delete the copy afterwards):
//   SEARCH_DOCS=2000 SEARCH_VISIBLE_PER_TOPIC=8 node node_modules/vitest/vitest.mjs run test/zzSearchSparse.tmp.test.ts
// Real PostgreSQL + pgvector. Synthetic zh/en corpus in one Space: per topic,
// `SEARCH_VISIBLE_PER_TOPIC` documents the viewer can read (space_shared, the
// term once in the body) and the rest private to another member, written as
// stronger matches (term in title and repeated) so they rank first. Truth is
// deterministic: the relevant set for a topic query is exactly the viewer-
// readable documents containing that topic's term. Vectors (hybrid) come from a
// deterministic topic embedder shared by zh/en synonyms; no provider is called.
// SEARCH_VECTORS=onehot (default): every document of a topic has the topic's
// one-hot vector (identical vectors). SEARCH_VECTORS=lattice: each document has
// its own vector at exactly the same distance from the topic's query (integer
// points a²+b²=5525 in planes of their own), which the HNSW graph can navigate.
// Each repetition's recall, returned count and hidden documents are recorded;
// with SEARCH_PLANS=1 the vector arm's window statements of one query per mode
// are EXPLAIN ANALYZEd under the arm's own scan settings. SEARCH_PLAN=hnsw runs
// the searches on a pool with sequential scans, bitmap scans and sorts disabled, so the
// vector windows use the HNSW index at any corpus size (default: the planner's choice).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { beforeAll, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import type { QueryEmbedder } from "../src/modules/retrieval/types.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { RetrievalEmbeddingBackfillService, type RetrievalEmbedder } from "../src/modules/retrieval/embedding/service.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

const SPACE = "11111111-1111-4111-8111-1111111111c1", VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac1", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbc1";
const DOCS = Number(process.env.SEARCH_DOCS ?? 2000), VISIBLE = Number(process.env.SEARCH_VISIBLE_PER_TOPIC ?? 8), K = 10, REPEAT = Number(process.env.SEARCH_REPEAT ?? 5);
const TOPICS = [
  { slot: 0, en: "quantum error correction", zh: "量子纠错" }, { slot: 1, en: "ledger reconciliation", zh: "账本对账" },
  { slot: 2, en: "glacier hydrology", zh: "冰川水文" }, { slot: 3, en: "protein folding", zh: "蛋白质折叠" },
  { slot: 4, en: "tidal energy", zh: "潮汐能" },
];
const slotOf = (text: string) => { for (const t of TOPICS) if (text.includes(t.en) || text.includes(t.zh)) return t.slot; return 9 };
const oneHot = (slot: number) => { const v = new Array<number>(EMBED_DIMENSIONS).fill(0); v[slot] = 1; return v };
const VECTORS = process.env.SEARCH_VECTORS ?? "onehot";
const LATTICE: Array<[number, number]> = [];
for (let a = -74; a <= 74; a++) { const b = Math.sqrt(5525 - a * a); if (Number.isInteger(b)) LATTICE.push([a, b], ...(b ? [[a, -b] as [number, number]] : [])) }
const PLANES_PER_TOPIC = 12; // 12 × 48 = 576 distinct points per topic
const latticeVector = (slot: number, index: number) => {
  const v = new Array<number>(EMBED_DIMENSIONS).fill(0); v[slot] = 100;
  const [a, b] = LATTICE[index % LATTICE.length]!; const plane = 16 + (slot * PLANES_PER_TOPIC + Math.floor(index / LATTICE.length)) * 2;
  v[plane] = a; v[plane + 1] = b; return v;
};
const docVector = (text: string) => {
  const slot = slotOf(text);
  if (VECTORS !== "lattice" || slot === 9) return oneHot(slot);
  return latticeVector(slot, Number(/(\d+)\D*$/.exec(text)?.[1] ?? 0));
};
const embedder: RetrievalEmbedder = { async embed(_s, texts) { return { model: "topic-embed", vectors: texts.map(docVector) } } };
const queryEmbedder: QueryEmbedder = { async embedQuery(_s, text) { return oneHot(slotOf(text)) } };
const PLAN = process.env.SEARCH_PLAN ?? "auto";
const db = useTestDatabase(import.meta.filename, { max: 6 });
let searchPool: pg.Pool | undefined;
const truth = new Map<string, string[]>();

beforeAll(async () => {
  if (!db.available) return;
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Bench','team',now(),now())`, [SPACE]);
  for (const id of [VIEWER, OTHER]) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source) VALUES ($1,'U','active',now(),now(), lower(gen_random_uuid()::text || '@test.invalid'),'system')`, [id]);
    await db.pool.query(`INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), SPACE, id]);
  }
  for (const t of TOPICS) { truth.set(`${t.slot}:en`, []); truth.set(`${t.slot}:zh`, []) }
  const perTopic = Math.floor(DOCS / TOPICS.length);
  for (const t of TOPICS) for (let i = 0; i < perTopic; i++) {
    const visible = i < VISIBLE; const zh = i % 2 === 1; const id = `t${t.slot}-${visible ? "v" : "h"}-${i}`;
    const term = zh ? t.zh : t.en;
    const title = visible ? (zh ? `第${i}号笔记` : `Note ${i}`) : `${term} ${term} 记录 ${i}`;
    const content = visible
      ? (zh ? `这份笔记顺带提到${t.zh}，其余内容是日常记录与会议安排。编号${i}。` : `This note mentions ${t.en} once among routine meeting details. Number ${i}.`)
      : `${term}. ${term} ${term}. ${zh ? `${t.zh}的详细讨论` : `Detailed ${t.en} discussion`} ${i}.`;
    await insertKnowledgeItem(db.pool, { id, spaceId: SPACE, title, content, slug: id, aliases: [], visibility: visible ? "space_shared" : "private",
      ownerUserId: visible ? null : OTHER, createdByUserId: visible ? null : OTHER, updatedAt: new Date().toISOString() });
    if (visible) truth.get(`${t.slot}:${zh ? "zh" : "en"}`)!.push(id);
  }
  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
  // One backfill call embeds a bounded batch: repeat until every chunk has a vector.
  const backfill = new RetrievalEmbeddingBackfillService(db.pool, embedder);
  while ((await backfill.backfillSpace(SPACE, { embeddingDimensions: EMBED_DIMENSIONS })).embedded > 0);
  const missing = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM retrieval_chunks WHERE space_id = $1 AND embedding IS NULL`, [SPACE]);
  if (missing.rows[0]!.n > 0) throw new Error(`${missing.rows[0]!.n} chunks without an embedding`);
  await db.pool.query(`ANALYZE`);
});

/** EXPLAIN ANALYZE each window statement under the arm's iterative-scan settings. */
async function explainWindows(statements: Array<{ text: string; values: unknown[] }>): Promise<unknown[]> {
  const client = await (searchPool ?? db.pool).connect();
  const out: unknown[] = [];
  try {
    for (const statement of statements) {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.max_scan_tuples', '20000', true)`);
      const plan = await client.query(`EXPLAIN (ANALYZE, SUMMARY, FORMAT JSON) ${statement.text}`, statement.values);
      await client.query("ROLLBACK");
      const top = (plan.rows[0] as { "QUERY PLAN": Array<{ "Planning Time": number; "Execution Time": number }> })["QUERY PLAN"][0]!;
      const text = JSON.stringify(top);
      out.push({ window: statement.values[4], offset: statement.values[7] ?? null, usesHnsw: text.includes("ix_retrieval_chunks_embedding_hnsw_2560"),
        planningMs: top["Planning Time"], executionMs: top["Execution Time"] });
    }
  } finally { client.release() }
  return out;
}

it("measures recall and latency under sparse visibility", async () => {
  if (!db.available) throw new Error("PostgreSQL unavailable");
  const out: Record<string, unknown> = { docs: DOCS, topics: TOPICS.length, visiblePerTopic: VISIBLE, k: K, repeat: REPEAT, vectors: VECTORS, plan: PLAN };
  if (PLAN === "hnsw") searchPool = new pg.Pool({ connectionString: db.connectionUri, max: 4, options: "-c enable_seqscan=off -c enable_bitmapscan=off -c enable_sort=off" });
  // Vector window statements, captured at the client (the arm runs them in its own short transaction).
  const originalQuery = pg.Client.prototype.query;
  let capture: Array<{ text: string; values: unknown[] }> | null = null;
  (pg.Client.prototype as unknown as { query: unknown }).query = function (this: unknown, ...args: unknown[]) {
    const text = typeof args[0] === "string" ? args[0] : "";
    if (capture && text.includes("WITH nearest AS")) capture.push({ text, values: [...((args[1] as unknown[]) ?? [])] });
    return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
  };
  try {
    for (const mode of ["lexical", "hybrid"] as const) {
      const service = new RetrievalSearchService(searchPool ?? db.pool, knowledgeRetrievalRegistry, mode === "hybrid" ? { queryEmbedder } : {});
      const rows: Array<Record<string, unknown> & { recallByRep: number[]; leakedByRep: number[]; ms: number }> = [];
      const recallOf = (ids: string[], relevant: string[]) => Number((ids.slice(0, K).filter((id) => relevant.includes(id)).length / Math.min(K, relevant.length)).toFixed(3));
      for (const t of TOPICS) for (const lang of ["en", "zh"] as const) {
        const query = lang === "en" ? t.en : t.zh; const expected = truth.get(`${t.slot}:${lang}`)!;
        // Synonyms: the other language's visible docs are relevant for hybrid (same topic slot).
        const relevant = mode === "hybrid" ? [...expected, ...truth.get(`${t.slot}:${lang === "en" ? "zh" : "en"}`)!] : expected;
        const times: number[] = []; const reps: string[][] = []; let windows: string[] = [];
        for (let r = 0; r < REPEAT; r++) {
          capture = [];
          const t0 = performance.now();
          const result = await service.search({ spaceId: SPACE, viewerUserId: VIEWER, query, objectTypes: ["knowledge_item"], mode, maxResults: K, useCache: false });
          times.push(performance.now() - t0); reps.push(result.items.map((item) => item.object_id));
          const statements = capture; capture = null;
          windows = statements.map((statement) => statement.values.length > 7 ? `${statement.values[4]}@offset ${statement.values[7]}` : `${statement.values[4]}`);
          if (process.env.SEARCH_PLANS && r === 0 && t.slot === 0 && lang === "en" && statements.length) out.vectorPlans ??= await explainWindows(statements);
        }
        times.sort((a, b) => a - b);
        // Recall@K against what K results can hold: hits / min(K, |relevant|), per repetition.
        rows.push({ query, relevant: relevant.length, recallByRep: reps.map((ids) => recallOf(ids, relevant)), returnedByRep: reps.map((ids) => ids.length),
          leakedByRep: reps.map((ids) => ids.filter((id) => id.includes("-h-")).length), identicalAcrossReps: reps.every((ids) => JSON.stringify(ids) === JSON.stringify(reps[0])),
          vectorWindowChunks: windows, ids: process.env.SEARCH_IDS ? reps[0] : undefined, ms: Number(times[Math.floor(times.length / 2)]!.toFixed(1)) });
      }
      const all = rows.flatMap((r) => r.recallByRep);
      out[mode] = { meanRecall: Number((all.reduce((a, r) => a + r, 0) / all.length).toFixed(3)), minRecall: Math.min(...all), maxRecall: Math.max(...all),
        leakedTotal: rows.reduce((a, r) => a + r.leakedByRep.reduce((x, y) => x + y, 0), 0), searches: all.length,
        medianMs: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)], rows };
    }
  } finally { (pg.Client.prototype as unknown as { query: unknown }).query = originalQuery; await searchPool?.end() }
  console.log("SEARCH_SPARSE", JSON.stringify(out));
  if (process.env.SEARCH_OUT) writeFileSync(process.env.SEARCH_OUT, JSON.stringify(out, null, 2));
});
