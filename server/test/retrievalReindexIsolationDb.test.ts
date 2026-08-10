import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { RetrievalProjectionService } from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import { memoryRetrievalRegistry } from "../src/modules/memory/retrievalAdapter";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// The retrieval projection tables (retrieval_objects/_aliases/_chunks/_edges)
// are shared by every domain registry. A full-space rebuild of ONE domain must
// only clear+rebuild that domain's object types and must never wipe another
// domain's projection. The per-domain fake tests cannot catch this because each
// holds only one domain's rows; this real-Postgres test seeds both Knowledge and
// Memory in one space and asserts cross-domain isolation in both directions.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KNOW = "77777777-7777-4777-8777-777777777777";
const MEM = "33333333-3333-4333-8333-333333333333";

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
      `[retrieval-reindex-isolation-db] skipped — Docker/Postgres unavailable: ${
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
              knowledge_items, space_objects, memory_entries, users, spaces CASCADE`,
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Test Space', 'personal', now(), now())`,
    [SPACE],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'User', 'active', now(), now())`,
    [OWNER],
  );
  await insertKnowledgeItem(pool, {
    id: KNOW,
    spaceId: SPACE,
    title: "Knowledge title",
    content: "Knowledge body text",
    slug: "knowledge-title",
  });
  await pool.query(
    `INSERT INTO memory_entries (
       id, space_id, scope_type, memory_type, status, visibility, sensitivity_level,
       confidence, importance, version, access_count, title, content, owner_user_id,
       created_at, updated_at
     ) VALUES (
       $1, $2, 'user', 'fact', 'active', 'space_shared', 'normal',
       1, 0.5, 1, 0, 'Memory title', 'Memory body text', $3,
       now(), now()
     )`,
    [MEM, SPACE, OWNER],
  );
});

function knowledgeProjection(): RetrievalProjectionService {
  return new RetrievalProjectionService(pool!, knowledgeRetrievalRegistry);
}

function memoryProjection(): RetrievalProjectionService {
  return new RetrievalProjectionService(pool!, memoryRetrievalRegistry);
}

async function projectionCounts(objectType: string): Promise<{ objects: number; aliases: number; chunks: number }> {
  const one = async (table: string) =>
    (
      await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE object_type = $1`,
        [objectType],
      )
    ).rows[0].n;
  return {
    objects: await one("retrieval_objects"),
    aliases: await one("retrieval_aliases"),
    chunks: await one("retrieval_chunks"),
  };
}

describe("Retrieval reindex domain isolation (real Postgres)", () => {
  it("memory full reindex does not wipe the knowledge projection", async () => {
    if (!available || !pool) return;
    await knowledgeProjection().reindexAll(SPACE);
    await memoryProjection().reindexAll(SPACE);

    // Both domains are projected after their own rebuilds.
    expect((await projectionCounts("knowledge_item")).objects).toBe(1);
    expect((await projectionCounts("memory_entry")).objects).toBe(1);

    // Re-running the memory rebuild must leave the knowledge projection intact —
    // objects AND the cascade-managed aliases/chunks.
    await memoryProjection().reindexAll(SPACE);

    const knowledge = await projectionCounts("knowledge_item");
    expect(knowledge.objects).toBe(1);
    expect(knowledge.aliases).toBeGreaterThan(0);
    expect(knowledge.chunks).toBeGreaterThan(0);
    expect((await projectionCounts("memory_entry")).objects).toBe(1);
  });

  it("knowledge full reindex does not wipe the memory projection", async () => {
    if (!available || !pool) return;
    await knowledgeProjection().reindexAll(SPACE);
    await memoryProjection().reindexAll(SPACE);

    await knowledgeProjection().reindexAll(SPACE);

    const memory = await projectionCounts("memory_entry");
    expect(memory.objects).toBe(1);
    expect(memory.aliases).toBeGreaterThan(0);
    expect(memory.chunks).toBeGreaterThan(0);
    expect((await projectionCounts("knowledge_item")).objects).toBe(1);
  });
});
