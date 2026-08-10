import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import {
  RetrievalProjectionService,
  RetrievalSearchService,
  type QueryRewriter,
} from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import type { RetrievalObjectType } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { runRecallCases, type RecallCase } from "./support/retrievalEval";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// Pre-recall query rewriting on real Postgres. The rewriter is an in-process fake
// (no provider). It proves that:
//   1. searching the rewrite variants ALONGSIDE the original recalls a document
//      the original query misses lexically,
//   2. the original query is always searched (a null rewrite == baseline), and
//   3. a sensible rewriter does not regress the golden recall@k eval.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const K = 5;

interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  slug: string;
  aliases: string[];
}

const knowledgeFixture = JSON.parse(
  readFileSync(join(process.cwd(), "test/fixtures/retrieval_eval/knowledge.json"), "utf8"),
) as { docs: KnowledgeDoc[]; cases: RecallCase[] };

/** Rewriter that maps a query to a fixed set of variants (no provider). */
function fixedRewriter(byQuery: Record<string, string[]>): QueryRewriter {
  return {
    async rewrite(_spaceId, _viewerUserId, query) {
      return byQuery[query] ?? null;
    },
  };
}

/** Rewriter that always adds a harmless extra variant (used for the recall gate). */
function constantRewriter(variant: string): QueryRewriter {
  return { async rewrite() { return [variant]; } };
}

/** Rewriter that returns null (the skip / degrade signal). */
const nullRewriter: QueryRewriter = { async rewrite() { return null; } };

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
      `[retrieval-query-rewrite-db] skipped — Docker/Postgres unavailable: ${
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
              knowledge_items, space_objects, users, spaces CASCADE`,
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Rewrite', 'personal', now(), now())`,
    [SPACE],
  );
  for (const id of [VIEWER, OTHER]) {
    await pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'U', 'active', now(), now())`,
      [id],
    );
  }
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('rewrite-viewer', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
});

async function seedPrivate(doc: { id: string; title: string; content: string; owner: string }): Promise<void> {
  await insertKnowledgeItem(pool!, {
    id: doc.id,
    spaceId: SPACE,
    title: doc.title,
    content: doc.content,
    slug: doc.id,
    visibility: "private",
    ownerUserId: doc.owner,
    createdByUserId: doc.owner,
  });
}

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

describe("Retrieval query rewriting (real Postgres)", () => {
  it("recalls a document the original query misses lexically via a rewrite variant", async () => {
    if (!available || !pool) return;
    await seedKnowledge({
      id: "rrf",
      title: "Fusion notes",
      content: "Reciprocal rank fusion blends results from multiple recall arms.",
      slug: "fusion-notes",
      aliases: [],
    });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const params = {
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"] as RetrievalObjectType[],
      query: "RRF",
      maxResults: 10,
      rewrite: true, // opt in to the LLM rewrite stage
    };

    // The acronym "RRF" has no lexical/alias overlap with the document.
    const baseline = await new RetrievalSearchService(pool, knowledgeRetrievalRegistry).search(params);
    expect(baseline.items.map((i) => i.object_id)).not.toContain("rrf");

    // With a rewriter expanding "RRF" → "reciprocal rank fusion", the doc surfaces
    // in the SEPARATE rewrite_items section — never blended into the primary items.
    const expanded = await new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
      queryRewriter: fixedRewriter({ RRF: ["reciprocal rank fusion"] }),
    }).search(params);
    expect(expanded.items.map((i) => i.object_id)).not.toContain("rrf");
    expect((expanded.rewrite_items ?? []).map((i) => i.object_id)).toContain("rrf");
    expect(expanded.rewrite_total).toBe(expanded.rewrite_items?.length);
  });

  it("keeps a primary hit out of the rewrite section (no duplicate across the two lists)", async () => {
    if (!available || !pool) return;
    await seedKnowledge({
      id: "shared",
      title: "Alpha overview",
      content: "alpha overview and summary of the topic",
      slug: "alpha-overview",
      aliases: [],
    });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    // Both the original "alpha" and the variant "alpha summary" match the doc.
    const out = await new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
      queryRewriter: fixedRewriter({ alpha: ["alpha summary"] }),
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "alpha",
      maxResults: 10,
      rewrite: true,
    });

    expect(out.items.map((i) => i.object_id)).toContain("shared");
    // It is in the primary list, so it must NOT be repeated in the rewrite section.
    expect((out.rewrite_items ?? []).map((i) => i.object_id)).not.toContain("shared");
  });

  it("revalidates the rewrite section — a private variant hit is never surfaced", async () => {
    if (!available || !pool) return;
    // 'secret' is private to OTHER and only a rewrite variant would match it.
    await seedPrivate({
      id: "secret",
      title: "Confidential fusion memo",
      content: "Reciprocal rank fusion internal notes.",
      owner: OTHER,
    });
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const out = await new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
      queryRewriter: fixedRewriter({ RRF: ["reciprocal rank fusion"] }),
    }).search({
      spaceId: SPACE,
      viewerUserId: VIEWER, // not the owner
      objectTypes: ["knowledge_item"],
      query: "RRF",
      maxResults: 10,
      rewrite: true,
    });

    expect(out.items.map((i) => i.object_id)).not.toContain("secret");
    expect((out.rewrite_items ?? []).map((i) => i.object_id)).not.toContain("secret");
  });

  it("still searches the original query when the rewriter returns null (degrades to baseline)", async () => {
    if (!available || !pool) return;
    for (const doc of knowledgeFixture.docs) await seedKnowledge(doc);
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const params = {
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"] as RetrievalObjectType[],
      query: "Postgres indexing strategies",
      maxResults: 10,
      rewrite: true, // opt in; the rewriter returns null, so it must degrade to baseline
    };
    const baseline = await new RetrievalSearchService(pool, knowledgeRetrievalRegistry).search(params);
    const withNullRewriter = await new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
      queryRewriter: nullRewriter,
    }).search(params);

    expect(withNullRewriter.items.map((i) => i.object_id)).toEqual(
      baseline.items.map((i) => i.object_id),
    );
  });

  it(`keeps golden recall@${K} under a query rewriter (eval gate)`, async () => {
    if (!available || !pool) return;
    for (const doc of knowledgeFixture.docs) await seedKnowledge(doc);
    await new RetrievalProjectionService(pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const report = await runRecallCases(
      new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
        queryRewriter: constantRewriter("database index tuning"),
      }),
      { spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"], rewrite: true },
      knowledgeFixture.cases,
      K,
    );

    expect(report.perCase.filter((c) => c.recall < 1)).toEqual([]);
    expect(report.recall).toBe(1);
  });
});
