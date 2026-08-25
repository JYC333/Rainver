import { join } from "node:path";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import {
  RetrievalProjectionService,
  RetrievalSearchService,
  type RerankCandidate,
  type RerankScore,
  type Reranker,
} from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import type { RetrievalObjectType } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { runRecallCases, type RecallCase } from "./support/retrievalEval";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// The reranker is a post-fusion, post-revalidate LLM stage. These tests use a
// deterministic in-process fake reranker (no provider) to prove three things on
// real Postgres:
//   1. it reorders the visible results,
//   2. it ONLY ever sees already-revalidated candidates (a private object that
//      matched the projection is never sent to the reranker), and
//   3. it degrades to the fused order when it returns null,
// plus that a sensible reranker does not regress the golden recall@k eval.

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

/** Reranker that scores by a fixed objectId preference (drives a known order). */
function preferenceReranker(preference: Record<string, number>): Reranker {
  return {
    async rerank(_spaceId, _viewerUserId, _query, candidates) {
      return candidates.map((c) => ({
        objectType: c.objectType,
        objectId: c.objectId,
        score: preference[c.objectId] ?? 0,
      }));
    },
  };
}

/** Reranker that records every candidate it is asked to score, then no-ops. */
function capturingReranker(sink: RerankCandidate[]): Reranker {
  return {
    async rerank(_spaceId, _viewerUserId, _query, candidates) {
      sink.push(...candidates);
      return null; // keep the fused order; we only care about what was sent.
    },
  };
}

/** A "good" reranker: scores by query-token overlap, like a real relevance judge. */
function lexicalOverlapReranker(): Reranker {
  return {
    async rerank(_spaceId, _viewerUserId, query, candidates): Promise<RerankScore[]> {
      const queryTokens = tokenize(query);
      return candidates.map((c) => {
        const haystack = tokenize(`${c.title} ${c.text ?? ""}`);
        const hits = queryTokens.filter((t) => haystack.includes(t)).length;
        return {
          objectType: c.objectType,
          objectId: c.objectId,
          score: queryTokens.length ? hits / queryTokens.length : 0,
        };
      });
    },
  };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Rerank', 'team', now(), now())`,
    [SPACE],
  );
  for (const id of [VIEWER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'U', 'active', now(), now())`,
      [id],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [id, SPACE, id],
    );
  }
});

async function seedKnowledge(doc: {
  id: string;
  title: string;
  content: string;
  slug?: string;
  aliases?: string[];
  visibility?: string;
  owner?: string | null;
}): Promise<void> {
  await insertKnowledgeItem(db.pool, {
    id: doc.id,
    spaceId: SPACE,
    title: doc.title,
    content: doc.content,
    slug: doc.slug ?? doc.id,
    aliases: doc.aliases ?? [],
    visibility: doc.visibility ?? "space_shared",
    ownerUserId: doc.owner ?? null,
    createdByUserId: doc.owner ?? null,
  });
}

describe("Retrieval reranker (real Postgres)", () => {
  it("reorders the visible results by the reranker's scores", async () => {
    if (!db.available) return;
    await seedKnowledge({ id: "alpha", title: "Alpha report", content: "quarterly report data" });
    await seedKnowledge({ id: "beta", title: "Beta report", content: "quarterly report data" });
    await seedKnowledge({ id: "gamma", title: "Gamma report", content: "quarterly report data" });
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const search = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      reranker: preferenceReranker({ gamma: 1, beta: 0.5, alpha: 0.1 }),
    });
    const result = await search.search({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "report",
      maxResults: 10,
      mode: "hybrid_rerank",
    });

    expect(result.items.map((i) => i.object_id)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("never sends a non-readable candidate to the reranker (revalidate-before-rerank)", async () => {
    if (!db.available) return;
    // 'secret' matches the query lexically but is private to OTHER, so revalidate
    // must drop it BEFORE the reranker stage sees any of its content.
    await seedKnowledge({ id: "public", title: "Public report", content: "shared report data" });
    await seedKnowledge({
      id: "secret",
      title: "Secret report",
      content: "secret report data",
      visibility: "private",
      owner: OTHER,
    });
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const sent: RerankCandidate[] = [];
    const search = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      reranker: capturingReranker(sent),
    });
    const result = await search.search({
      spaceId: SPACE,
      viewerUserId: VIEWER, // not the owner of 'secret'
      objectTypes: ["knowledge_item"],
      query: "report",
      maxResults: 10,
      mode: "hybrid_rerank",
    });

    const sentIds = sent.map((c) => c.objectId);
    expect(sentIds).toContain("public");
    expect(sentIds).not.toContain("secret");
    expect(sent.some((c) => (c.text ?? "").includes("secret"))).toBe(false);
    expect(result.items.map((i) => i.object_id)).not.toContain("secret");
  });

  it("degrades to the fused order when the reranker returns null", async () => {
    if (!db.available) return;
    await seedKnowledge({ id: "alpha", title: "Alpha report", content: "quarterly report data" });
    await seedKnowledge({ id: "beta", title: "Beta report", content: "quarterly report data" });
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const params = {
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"] as RetrievalObjectType[],
      query: "report",
      maxResults: 10,
      mode: "hybrid_rerank" as const,
    };
    const baseline = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry).search({ ...params });
    const withNullReranker = await new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
      reranker: capturingReranker([]), // returns null
    }).search({ ...params });

    expect(withNullReranker.items.map((i) => i.object_id)).toEqual(
      baseline.items.map((i) => i.object_id),
    );
  });

  it(`keeps golden recall@${K} under a sensible reranker (eval gate)`, async () => {
    if (!db.available) return;
    for (const doc of knowledgeFixture.docs) await seedKnowledge(doc);
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

    const report = await runRecallCases(
      new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
        reranker: lexicalOverlapReranker(),
      }),
      { spaceId: SPACE, viewerUserId: VIEWER, objectTypes: ["knowledge_item"], mode: "hybrid_rerank" },
      knowledgeFixture.cases,
      K,
    );

    expect(report.perCase.filter((c) => c.recall < 1)).toEqual([]);
    expect(report.recall).toBe(1);
  });
});
