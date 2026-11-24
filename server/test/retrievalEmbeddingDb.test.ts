import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { JobWorker } from "../src/modules/jobs/worker.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
  type RetrievalEmbeddingAuditEvent,
} from "../src/modules/retrieval/embedding/service.js";
import { EMBED_DIMENSIONS, EMBED_MAX_ATTEMPTS, RETRIEVAL_EMBEDDING_JOB } from "../src/modules/retrieval/embedding/config.js";
import { enqueueRetrievalEmbeddingBackfillWithQueue, registerRetrievalEmbeddingHandler } from "../src/modules/retrieval/embedding/job.js";
import { ProviderEmbedder } from "../src/modules/retrieval/embedding/providerEmbedder.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";

// Exercises embedding backfill and the vector schema end-to-end on a
// pgvector Postgres: the `vector` extension, the retrieval_chunks.embedding
// column, async backfill, staleness, and the dim-mismatch guard.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";

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


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Embed', 'personal', now(), now())`,
    [SPACE],
  );
  for (const [id, title, content] of [
    ["embed-1", "Vector search", "Approximate nearest neighbor search over embeddings."],
    ["embed-2", "Keyword search", "Lexical matching with tsvector and ranking."],
  ] as const) {
    await insertKnowledgeItem(db.pool, { id, spaceId: SPACE, title, content, slug: id });
  }
  await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
});

async function pendingCount(spaceId?: string): Promise<number> {
  const r = await db.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM retrieval_chunks WHERE embedding IS NULL AND ($1::text IS NULL OR space_id = $1)",
    [spaceId ?? null],
  );
  return r.rows[0].n;
}

describe("Retrieval embedding backfill (real Postgres + pgvector)", () => {
  it("keeps one durable rebuild Job until every batch has been processed", async () => {
    const user = randomUUID();
    await db.pool.query(
      `INSERT INTO users (id,display_name,email,status,registration_source,created_at,updated_at)
       VALUES ($1,'Backfill owner',$2,'active','system',now(),now())`,
      [user, `${user}@test.invalid`],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'owner','active',now(),now())`,
      [randomUUID(), SPACE, user],
    );
    const queue = new PgJobQueueRepository(db.pool);
    const registry = new JobHandlerRegistry();
    registerRetrievalEmbeddingHandler(registry, loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
    const embed = vi.spyOn(ProviderEmbedder.prototype, "embed").mockImplementation(fakeEmbedder(EMBED_DIMENSIONS).embed);
    try {
      const total = await pendingCount(SPACE);
      expect(total).toBeGreaterThan(1);
      const { jobId } = await enqueueRetrievalEmbeddingBackfillWithQueue(queue, {
        spaceId: SPACE, userId: user, batchLimit: 1, maxAttempts: 1, trigger: "retrieval_embedding_policy_update",
      });
      const worker = () => new JobWorker(queue, registry, randomUUID(), [RETRIEVAL_EMBEDDING_JOB]);
      for (let index = 0; index < total; index += 1) {
        expect(await worker().processOne()).toEqual({ status: "deferred", job_id: jobId });
        expect(await queue.getJob(jobId)).toMatchObject({ status: "pending", attempts: 0, user_id: user });
        expect(await pendingCount(SPACE)).toBe(total - index - 1);
        await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1", [jobId]);
      }
      expect(await worker().processOne()).toEqual({ status: "completed", job_id: jobId });
      expect(embed).toHaveBeenCalledTimes(total);
      expect(await queue.getJob(jobId)).toMatchObject({ status: "completed", attempts: 1 });
    } finally {
      embed.mockRestore();
    }
  });

  it("embeds pending chunks, records the model, and is idempotent", async () => {
    if (!db.available) return;
    // Another Space's chunks are never claimed or sent with this Space's batch.
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at)
       VALUES ($1, 'Other', 'personal', now(), now())`,
      [OTHER_SPACE],
    );
    await insertKnowledgeItem(db.pool, { id: "other-1", spaceId: OTHER_SPACE, title: "Other", content: "Belongs elsewhere.", slug: "other-1" });
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(OTHER_SPACE);
    const chunks = await db.pool.query<{ plain_text: string }>(
      "SELECT plain_text FROM retrieval_chunks WHERE space_id = $1 AND embedding IS NULL",
      [SPACE],
    );
    const total = chunks.rows.length;
    expect(total).toBeGreaterThan(0);

    const base = fakeEmbedder(EMBED_DIMENSIONS);
    const sentTexts: string[] = [];
    let claimedAtEgress: number | null = null;
    const embedder: RetrievalEmbedder = {
      async embed(spaceId, texts, opts) {
        sentTexts.push(...texts);
        // The batch is claimed in the database before any text leaves.
        const claimed = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM retrieval_chunks
            WHERE space_id = $1 AND embedding IS NULL AND embedding_claim_id IS NOT NULL`,
          [SPACE],
        );
        claimedAtEgress = claimed.rows[0].n;
        return base.embed(spaceId, texts, opts);
      },
    };
    const auditEvents: RetrievalEmbeddingAuditEvent[] = [];
    const service = new RetrievalEmbeddingBackfillService(db.pool, embedder, async (event) => {
      auditEvents.push(event);
    });
    const first = await service.backfillSpace(SPACE, { batchLimit: 100 });
    expect(first).toEqual({ scanned: total, embedded: total, skipped: 0, model: "fake-embed-v1" });
    expect(claimedAtEgress).toBe(total);
    expect([...sentTexts].sort()).toEqual(chunks.rows.map((row) => row.plain_text).sort());
    // The audit carries aggregate metadata only: no chunk text or ids.
    expect(auditEvents).toEqual([{
      spaceId: SPACE,
      model: "fake-embed-v1",
      dimensions: EMBED_DIMENSIONS,
      scanned: total,
      inputCount: total,
      embedded: total,
      skipped: 0,
    }]);
    expect(await pendingCount(SPACE)).toBe(0);
    const other = await db.pool.query<{ pending: boolean; claimed: boolean }>(
      `SELECT bool_and(embedding IS NULL) AS pending, bool_or(embedding_claim_id IS NOT NULL) AS claimed
         FROM retrieval_chunks WHERE space_id = $1`,
      [OTHER_SPACE],
    );
    expect(other.rows[0]).toEqual({ pending: true, claimed: false });

    const row = await db.pool.query(
      "SELECT embedding_model, (embedding IS NOT NULL) AS has_vec FROM retrieval_chunks WHERE space_id = $1 LIMIT 1",
      [SPACE],
    );
    expect(row.rows[0]).toMatchObject({ embedding_model: "fake-embed-v1", has_vec: true });

    // Second run finds nothing pending, sends nothing, and audits nothing.
    const second = await service.backfillSpace(SPACE, { batchLimit: 100 });
    expect(second.embedded).toBe(0);
    expect(sentTexts).toHaveLength(total);
    expect(auditEvents).toHaveLength(1);
  });

  it("claims at most batchLimit chunks per backfill", async () => {
    if (!db.available) return;
    const before = await pendingCount();
    expect(before).toBeGreaterThan(1);
    const result = await new RetrievalEmbeddingBackfillService(db.pool, fakeEmbedder(EMBED_DIMENSIONS))
      .backfillSpace(SPACE, { batchLimit: 1 });
    expect(result).toMatchObject({ scanned: 1, embedded: 1 });
    expect(await pendingCount()).toBe(before - 1);
  });

  it("releases claimed chunks when provider egress fails, so they stay retryable", async () => {
    if (!db.available) return;
    const before = await pendingCount();
    await expect(new RetrievalEmbeddingBackfillService(db.pool, {
      async embed() {
        throw new Error("provider down");
      },
    }).backfillSpace(SPACE, { batchLimit: 100 })).rejects.toThrow("provider down");
    const released = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM retrieval_chunks
        WHERE space_id = $1 AND embedding IS NULL
          AND embedding_claim_id IS NULL AND embedding_claimed_at IS NULL`,
      [SPACE],
    );
    expect(released.rows[0].n).toBe(before);
    // Released at once, not left to the claim TTL: the next backfill embeds them.
    const retry = await new RetrievalEmbeddingBackfillService(db.pool, fakeEmbedder(EMBED_DIMENSIONS))
      .backfillSpace(SPACE, { batchLimit: 100 });
    expect(retry).toMatchObject({ scanned: before, embedded: before });
    expect(await pendingCount()).toBe(0);
  });

  it("withholds only the chunk whose source may not leave, not the rest of its batch", async () => {
    if (!db.available) return;
    // A source with no policy snapshot fails closed for egress.
    await db.pool.query(
      `UPDATE retrieval_objects SET source_connection_ids_json = '["unknown-source"]'::jsonb
        WHERE space_id = $1 AND object_id = 'embed-1'`,
      [SPACE],
    );

    const result = await new RetrievalEmbeddingBackfillService(db.pool, fakeEmbedder(EMBED_DIMENSIONS))
      .backfillSpace(SPACE, { batchLimit: 100 });

    expect(result.embedded).toBeGreaterThan(0);
    const embedded = await db.pool.query<{ object_id: string; has_vec: boolean }>(
      `SELECT object_id, bool_and(embedding IS NOT NULL) AS has_vec
         FROM retrieval_chunks WHERE space_id = $1 GROUP BY object_id ORDER BY object_id`,
      [SPACE],
    );
    expect(embedded.rows).toEqual([
      { object_id: "embed-1", has_vec: false },
      { object_id: "embed-2", has_vec: true },
    ]);
  });

  it("keeps the previous index when a whole-space rebuild fails part-way", async () => {
    if (!db.available) return;
    await new RetrievalEmbeddingBackfillService(db.pool, fakeEmbedder(EMBED_DIMENSIONS)).backfillSpace(SPACE);
    expect(await pendingCount()).toBe(0);
    await insertKnowledgeItem(db.pool, { id: "embed-3", spaceId: SPACE, title: "Refused", content: "Cannot be projected.", slug: "embed-3" });
    await db.pool.query(`
      CREATE FUNCTION test_refuse_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.object_id = 'embed-3' THEN RAISE EXCEPTION 'projection refused'; END IF;
        RETURN NEW;
      END $$`);
    await db.pool.query(
      `CREATE TRIGGER test_refuse_projection BEFORE INSERT ON retrieval_objects
         FOR EACH ROW EXECUTE FUNCTION test_refuse_projection()`,
    );
    try {
      await expect(new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE))
        .rejects.toThrow("projection refused");
    } finally {
      await db.pool.query(`DROP TRIGGER test_refuse_projection ON retrieval_objects`);
      await db.pool.query(`DROP FUNCTION test_refuse_projection()`);
    }

    const indexed = await db.pool.query<{ object_id: string }>(
      `SELECT object_id FROM retrieval_objects WHERE space_id = $1 ORDER BY object_id`,
      [SPACE],
    );
    expect(indexed.rows.map((row) => row.object_id)).toEqual(["embed-1", "embed-2"]);
    // The paid-for embeddings stay. Do not drop them with the rows a failed
    // rebuild clears.
    expect(await pendingCount()).toBe(0);
  });

  it("supports a vector distance query through the pgvector column/index", async () => {
    if (!db.available) return;
    await new RetrievalEmbeddingBackfillService(db.pool, fakeEmbedder(EMBED_DIMENSIONS)).backfillSpace(SPACE);

    const probe = new Array<number>(EMBED_DIMENSIONS).fill(0);
    probe[0] = 1;
    const nearest = await db.pool.query<{ id: string }>(
      `SELECT id FROM retrieval_chunks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 1`,
      [`[${probe.join(",")}]`],
    );
    expect(nearest.rows).toHaveLength(1);
  });

  it("leaves chunks pending when the embedder returns a wrong-dimension vector", async () => {
    if (!db.available) return;
    const stderrWrites: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const before = await pendingCount();
    try {
      const result = await new RetrievalEmbeddingBackfillService(db.pool, fakeEmbedder(8)).backfillSpace(SPACE);
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
    if (!db.available) return;
    const stderrWrites: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    // Repeatedly fail with a wrong-dimension embedder until the cap is reached.
    try {
      for (let attempt = 0; attempt < EMBED_MAX_ATTEMPTS; attempt += 1) {
        const failed = await new RetrievalEmbeddingBackfillService(db.pool, fakeEmbedder(8)).backfillSpace(SPACE);
        expect(failed.embedded).toBe(0);
        expect(failed.scanned).toBeGreaterThan(0);
      }
      expect(stderrWrites.join("")).toContain(
        "model 'fake-embed-v1' returned 8-dim vectors but the space expects 2560-dim vectors",
      );
      // At the cap, even a correctly-sized embedder claims nothing: poison chunks
      // are excluded from future claims (no more provider egress for them).
      const after = await new RetrievalEmbeddingBackfillService(db.pool, fakeEmbedder(EMBED_DIMENSIONS)).backfillSpace(SPACE);
      expect(after.scanned).toBe(0);
      expect(after.embedded).toBe(0);

      const capped = await db.pool.query<{ n: number }>(
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
