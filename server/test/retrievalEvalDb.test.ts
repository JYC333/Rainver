import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { RetrievalProjectionService, RetrievalSearchService } from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import { memoryRetrievalRegistry } from "../src/modules/memory/retrievalAdapter";
import { runRecallCases, type RecallCase } from "./support/retrievalEval";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// Golden recall@k eval over the deterministic recall arms (exact alias / lexical
// / graph). This is the Phase-2 gate: a future ranking change (vector arm,
// source-tier boost, reranker) must keep these golden results in the top-k.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const K = 5;

interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  slug: string;
  aliases: string[];
}
interface MemoryDoc {
  id: string;
  title: string;
  content: string;
}
interface Fixture<Doc> {
  docs: Doc[];
  cases: RecallCase[];
}

const knowledgeFixture = loadFixture<KnowledgeDoc>("knowledge.json");
const memoryFixture = loadFixture<MemoryDoc>("memory.json");

function loadFixture<Doc>(name: string): Fixture<Doc> {
  return JSON.parse(
    readFileSync(join(process.cwd(), "test/fixtures/retrieval_eval", name), "utf8"),
  ) as Fixture<Doc>;
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
      `[retrieval-eval-db] skipped — Docker/Postgres unavailable: ${
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
     VALUES ($1, 'Eval', 'personal', now(), now())`,
    [SPACE],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now())`,
    [OWNER],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('eval-owner', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, OWNER],
  );
});

async function seedKnowledge(doc: KnowledgeDoc): Promise<void> {
  await insertKnowledgeItem(pool!, {
    id: doc.id,
    spaceId: SPACE,
    title: doc.title,
    content: doc.content,
    slug: doc.slug,
    aliases: doc.aliases ?? [],
  });
}

async function seedMemory(doc: MemoryDoc): Promise<void> {
  await pool!.query(
    `INSERT INTO memory_entries (
       id, space_id, scope_type, memory_type, status, visibility, sensitivity_level,
       confidence, importance, version, access_count, title, content, owner_user_id,
       created_at, updated_at
     ) VALUES (
       $1, $2, 'user', 'fact', 'active', 'space_shared', 'normal',
       1, 0.5, 1, 0, $3, $4, $5, now(), now()
     )`,
    [doc.id, SPACE, doc.title, doc.content, OWNER],
  );
}

describe("Retrieval recall@k eval (real Postgres)", () => {
  it(`knowledge recall@${K} hits every golden expected id`, async () => {
    if (!available || !pool) return;
    for (const doc of knowledgeFixture.docs) await seedKnowledge(doc);
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const report = await runRecallCases(
      new RetrievalSearchService(pool, knowledgeRetrievalRegistry),
      { spaceId: SPACE, viewerUserId: OWNER, objectTypes: ["knowledge_item"] },
      knowledgeFixture.cases,
      K,
    );

    expect(report.perCase.filter((c) => c.recall < 1)).toEqual([]);
    expect(report.recall).toBe(1);
  });

  it(`memory recall@${K} hits every golden expected id`, async () => {
    if (!available || !pool) return;
    for (const doc of memoryFixture.docs) await seedMemory(doc);
    await new RetrievalProjectionService(pool, memoryRetrievalRegistry).reindexAll(SPACE);

    const report = await runRecallCases(
      new RetrievalSearchService(pool, memoryRetrievalRegistry),
      { spaceId: SPACE, viewerUserId: OWNER, objectTypes: ["memory_entry"] },
      memoryFixture.cases,
      K,
    );

    expect(report.perCase.filter((c) => c.recall < 1)).toEqual([]);
    expect(report.recall).toBe(1);
  });
});
