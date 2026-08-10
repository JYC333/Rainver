import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { RetrievalProjectionService } from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
} from "../src/modules/retrieval/embedding/service";
import { EMBED_DIMENSIONS, EMBED_MAX_ATTEMPTS } from "../src/modules/retrieval/embedding/config";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// Exercises the Phase-2 embedding pipeline AND the vector schema end-to-end on a
// pgvector Postgres: the `vector` extension, the retrieval_chunks.embedding
// column, async backfill, staleness, and the dim-mismatch guard.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";

/** Deterministic embedder: a distinct unit-ish vector per input text. */
function fakeEmbedder(dim: number, model = "fake-embed-v1"): RetrievalEmbedder {
  return {
    async embed(_spaceId, texts) {
      const vectors = texts.map((_text, i) => {
        const v = new Array<number>(dim).fill(0);
        v[i % dim] = i + 1;
        return v;
      });
      return { vectors, model };
    },
  };
}

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[retrieval-embedding-db] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE retrieval_objects, retrieval_aliases, retrieval_chunks, retrieval_edges,
              knowledge_items, space_objects, spaces CASCADE`,
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Embed', 'personal', now(), now())`,
    [SPACE],
  );
  for (const [id, title, content] of [
    ["embed-1", "Vector search", "Approximate nearest neighbor search over embeddings."],
    ["embed-2", "Keyword search", "Lexical matching with tsvector and ranking."],
  ] as const) {
    await insertKnowledgeItem(pool, { id, spaceId: SPACE, title, content, slug: id });
  }
  await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
});

async function pendingCount(): Promise<number> {
  const r = await pool!.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM retrieval_chunks WHERE embedding IS NULL",
  );
  return r.rows[0].n;
}

describe("Retrieval embedding backfill (real Postgres + pgvector)", () => {
  it("embeds pending chunks, records the model, and is idempotent", async () => {
    if (!available || !pool) return;
    expect(await pendingCount()).toBeGreaterThan(0);

    const service = new RetrievalEmbeddingBackfillService(pool, fakeEmbedder(EMBED_DIMENSIONS));
    const first = await service.backfillSpace(SPACE, { batchLimit: 100 });
    expect(first.embedded).toBeGreaterThan(0);
    expect(first.embedded).toBe(first.scanned);
    expect(await pendingCount()).toBe(0);

    const row = await pool.query(
      "SELECT embedding_model, (embedding IS NOT NULL) AS has_vec FROM retrieval_chunks LIMIT 1",
    );
    expect(row.rows[0]).toMatchObject({ embedding_model: "fake-embed-v1", has_vec: true });

    // Second run finds nothing pending.
    const second = await service.backfillSpace(SPACE, { batchLimit: 100 });
    expect(second.embedded).toBe(0);
  });

  it("supports a vector distance query through the pgvector column/index", async () => {
    if (!available || !pool) return;
    await new RetrievalEmbeddingBackfillService(pool, fakeEmbedder(EMBED_DIMENSIONS)).backfillSpace(SPACE);

    const probe = new Array<number>(EMBED_DIMENSIONS).fill(0);
    probe[0] = 1;
    const nearest = await pool.query<{ id: string }>(
      `SELECT id FROM retrieval_chunks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 1`,
      [`[${probe.join(",")}]`],
    );
    expect(nearest.rows).toHaveLength(1);
  });

  it("leaves chunks pending when the embedder returns a wrong-dimension vector", async () => {
    if (!available || !pool) return;
    const stderrWrites: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const before = await pendingCount();
    try {
      const result = await new RetrievalEmbeddingBackfillService(pool, fakeEmbedder(8)).backfillSpace(SPACE);
      expect(result.embedded).toBe(0);
      expect(await pendingCount()).toBe(before);
      expect(stderrWrites.join("")).toContain(
        "model 'fake-embed-v1' returned 8-dim vectors but the space expects 2560-dim vectors",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("stops retrying a chunk after the attempt cap (poison-chunk guard)", async () => {
    if (!available || !pool) return;
    const stderrWrites: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    // Repeatedly fail with a wrong-dimension embedder until the cap is reached.
    try {
      for (let attempt = 0; attempt < EMBED_MAX_ATTEMPTS; attempt += 1) {
        const failed = await new RetrievalEmbeddingBackfillService(pool, fakeEmbedder(8)).backfillSpace(SPACE);
        expect(failed.embedded).toBe(0);
        expect(failed.scanned).toBeGreaterThan(0);
      }
      expect(stderrWrites.join("")).toContain(
        "model 'fake-embed-v1' returned 8-dim vectors but the space expects 2560-dim vectors",
      );
      // At the cap, even a correctly-sized embedder claims nothing: poison chunks
      // are excluded from future claims (no more provider egress for them).
      const after = await new RetrievalEmbeddingBackfillService(pool, fakeEmbedder(EMBED_DIMENSIONS)).backfillSpace(SPACE);
      expect(after.scanned).toBe(0);
      expect(after.embedded).toBe(0);

      const capped = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM retrieval_chunks
          WHERE embedding IS NULL AND embedding_attempts >= $1`,
        [EMBED_MAX_ATTEMPTS],
      );
      expect(capped.rows[0].n).toBeGreaterThan(0);
    } finally {
      stderr.mockRestore();
    }
  });
});
