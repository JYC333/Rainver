import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import {
  RetrievalProjectionService,
  RetrievalSearchService,
} from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// Real-PostgreSQL round-trip for the zero-LLM retrieval substrate. The focused
// knowledgeRetrieval.test.ts uses an in-memory fake, which cannot catch SQL
// bugs (column names, window-alias ORDER BY, to_tsvector / ts_rank_cd, LATERAL
// joins, ON CONFLICT). This test applies the committed baseline to a throwaway
// Postgres and exercises projection writes + every search arm for real. Skips
// gracefully when Docker is unavailable.

const SPACE = "11111111-1111-4111-8111-111111111111";
const ITEM_A = "33333333-3333-4333-8333-333333333333";
const ITEM_B = "44444444-4444-4444-8444-444444444444";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[knowledge-retrieval-db] skipped — Docker/Postgres unavailable: ${
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
  await resetTables(
    pool,
    ["retrieval_objects", "retrieval_edges", "knowledge_items", "space_objects"],
    { cascade: true },
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Test Space', 'personal', now(), now()) ON CONFLICT (id) DO NOTHING`,
    [SPACE],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Viewer', 'active', now(), now()), ($2, 'Other', 'active', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [VIEWER, OTHER],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())
     ON CONFLICT (space_id, user_id) DO NOTHING`,
    [SPACE, VIEWER],
  );
});

async function insertItem(over: {
  id: string;
  title: string;
  content: string;
  slug?: string;
  aliases?: string[];
  status?: string;
  visibility?: string;
}): Promise<void> {
  await insertKnowledgeItem(pool!, {
    id: over.id,
    spaceId: SPACE,
    title: over.title,
    content: over.content,
    slug: over.slug ?? null,
    aliases: over.aliases ?? [],
    status: over.status ?? "active",
    visibility: over.visibility ?? "space_shared",
  });
}

describe("Knowledge zero-LLM retrieval (real Postgres)", () => {
  it("indexes a KnowledgeItem and finds it by title, alias, and lexical content", async () => {
    if (!available || !pool) return;
    await insertItem({
      id: ITEM_A,
      title: "Alpha",
      content: "Alpha is the canonical page about light.",
      slug: "alpha",
      aliases: ["Hall of Light"],
    });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindex(SPACE, "knowledge_item", ITEM_A);
    const service = new RetrievalSearchService(pool, knowledgeRetrievalRegistry);

    const byTitle = await service.search({ spaceId: SPACE, viewerUserId: VIEWER, query: "Alpha" });
    expect(byTitle.items[0]).toMatchObject({ object_id: ITEM_A, evidence: { kind: "exact_title_match" } });

    const byAlias = await service.search({ spaceId: SPACE, viewerUserId: VIEWER, query: "hall of light" });
    expect(byAlias.items[0]).toMatchObject({ object_id: ITEM_A, evidence: { kind: "alias_hit" } });

    const byLexical = await service.search({ spaceId: SPACE, viewerUserId: VIEWER, query: "canonical page" });
    expect(byLexical.items.map((item) => item.object_id)).toContain(ITEM_A);
  });

  it("projects a wikilink into an edge and expands graph neighbors", async () => {
    if (!available || !pool) return;
    await insertItem({ id: ITEM_B, title: "Beta", content: "Beta reference content.", slug: "beta" });
    await insertItem({ id: ITEM_A, title: "Alpha", content: "Alpha links to [[Beta]].", slug: "alpha" });
    const projection = new RetrievalProjectionService(pool, knowledgeRetrievalRegistry);
    await projection.reindex(SPACE, "knowledge_item", ITEM_B);
    await projection.reindex(SPACE, "knowledge_item", ITEM_A);

    const out = await new RetrievalSearchService(pool, knowledgeRetrievalRegistry).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      query: "Alpha",
      maxResults: 5,
    });

    const beta = out.items.find((item) => item.object_id === ITEM_B);
    expect(beta?.evidence.kind).toBe("graph_neighbor");
  });

  it("drops a non-visible item during canonical revalidation", async () => {
    if (!available || !pool) return;
    await insertKnowledgeItem(pool, {
      id: ITEM_A,
      spaceId: SPACE,
      title: "Alpha",
      content: "secret",
      slug: "alpha",
      visibility: "private",
      ownerUserId: OTHER,
      createdByUserId: OTHER,
    });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindex(SPACE, "knowledge_item", ITEM_A);

    const out = await new RetrievalSearchService(pool, knowledgeRetrievalRegistry).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      query: "Alpha",
    });

    expect(out.items).toHaveLength(0);
  });
});
