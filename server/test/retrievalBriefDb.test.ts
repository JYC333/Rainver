import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import {
  RetrievalProjectionService,
  RetrievalSearchService,
  type BriefCandidate,
  type SynthesisResult,
  type Synthesizer,
} from "../src/modules/retrieval";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter";
import { insertKnowledgeItem } from "./support/knowledgeFixtures";

// Context Brief (W6) end-to-end on real Postgres. A deterministic in-process fake
// synthesizer (no provider) proves: the brief is built only from revalidated
// sources (a private object never reaches the synthesizer — invariant 1/2),
// citations resolve to surfaced sources only (an invented index is dropped), and
// with no synthesizer the brief still returns the deterministic gap analysis.

const SPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Synthesizer that records the candidates it received, then cites the given indices. */
function capturingSynthesizer(sink: BriefCandidate[], citations: number[]): Synthesizer {
  return {
    async synthesize(_spaceId, _viewerUserId, _query, candidates): Promise<SynthesisResult> {
      sink.push(...candidates);
      return {
        answer: `Synthesized answer citing ${citations.map((i) => `[${i}]`).join(" ")}.`,
        citations,
        uncitedClaims: [],
        contradictions: ["a stated contradiction"],
        missingTopics: ["an uncovered topic"],
      };
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
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[retrieval-brief-db] skipped — Docker/Postgres unavailable: ${
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
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Brief', 'personal', now(), now())`, [SPACE]);
  for (const id of [VIEWER, OTHER]) {
    await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'U', 'active', now(), now())`, [id]);
  }
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('brief-viewer', $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
});

async function seed(doc: {
  id: string;
  title: string;
  content: string;
  visibility?: string;
  owner?: string | null;
}): Promise<void> {
  await insertKnowledgeItem(pool!, {
    id: doc.id,
    spaceId: SPACE,
    title: doc.title,
    content: doc.content,
    slug: doc.id,
    visibility: doc.visibility ?? "space_shared",
    ownerUserId: doc.owner ?? null,
    createdByUserId: doc.owner ?? null,
  });
}

async function reindex(): Promise<void> {
  await new RetrievalProjectionService(pool!, knowledgeRetrievalRegistry).reindexAll(SPACE);
}

describe("Retrieval Context Brief (real Postgres)", () => {
  it("synthesizes a cited answer from the revalidated sources", async () => {
    if (!available || !pool) return;
    await seed({ id: "doc-a", title: "Backups", content: "Nightly backups run at 02:00 to cold storage." });
    await seed({ id: "doc-b", title: "Restore", content: "Restores are tested quarterly from backups." });
    await reindex();

    const captured: BriefCandidate[] = [];
    const search = new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
      synthesizer: capturingSynthesizer(captured, [0]),
    });
    const result = await search.buildBrief({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "backups",
      mode: "lexical",
      maxResults: 5,
    });

    expect(result.brief.synthesized).toBe(true);
    expect(result.brief.answer).toContain("[0]");
    expect(result.brief.citations.length).toBe(1);
    // The cited source is one of the surfaced items.
    const itemIds = result.items.map((i) => i.object_id);
    expect(itemIds).toContain(result.brief.citations[0]!.object_id);
    // LLM gap signals flow through.
    expect(result.brief.gap_analysis.contradictions).toEqual(["a stated contradiction"]);
    expect(result.brief.gap_analysis.missing_topics).toEqual(["an uncovered topic"]);
  });

  it("never sends a non-readable object to the synthesizer (invariant 1/2)", async () => {
    if (!available || !pool) return;
    // Both match "ledger" lexically, but `secret` is private and owned by OTHER.
    await seed({ id: "public-ledger", title: "Ledger basics", content: "The ledger records every transaction." });
    await seed({
      id: "secret-ledger",
      title: "Secret ledger",
      content: "The ledger hides the off-book transaction.",
      visibility: "private",
      owner: OTHER,
    });
    await reindex();

    const captured: BriefCandidate[] = [];
    const search = new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
      synthesizer: capturingSynthesizer(captured, [0]),
    });
    const result = await search.buildBrief({
      spaceId: SPACE,
      viewerUserId: VIEWER, // not the owner of secret-ledger
      objectTypes: ["knowledge_item"],
      query: "ledger transaction",
      mode: "lexical",
      maxResults: 5,
    });

    const capturedIds = captured.map((c) => c.objectId);
    expect(capturedIds).toContain("public-ledger");
    expect(capturedIds).not.toContain("secret-ledger"); // never handed to synthesis
    expect(result.items.map((i) => i.object_id)).not.toContain("secret-ledger");
    // No captured content is the private object's text.
    expect(captured.every((c) => !(c.text ?? "").includes("off-book"))).toBe(true);
  });

  it("drops a citation index the synthesizer invented beyond the surfaced sources", async () => {
    if (!available || !pool) return;
    await seed({ id: "only-doc", title: "Solo", content: "The one and only matching page about quokkas." });
    await reindex();

    const search = new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
      synthesizer: capturingSynthesizer([], [0, 99]), // 99 is out of range
    });
    const result = await search.buildBrief({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "quokkas",
      mode: "lexical",
      maxResults: 5,
    });
    expect(result.brief.citations.map((c) => c.object_id)).toEqual(["only-doc"]); // 99 dropped
  });

  it("does not cite sources outside the returned max_results window", async () => {
    if (!available || !pool) return;
    await seed({ id: "doc-a", title: "A", content: "Phoenix launch checklist." });
    await seed({ id: "doc-b", title: "B", content: "Phoenix launch dependencies." });
    await seed({ id: "doc-c", title: "C", content: "Phoenix launch archive." });
    await reindex();

    const captured: BriefCandidate[] = [];
    const search = new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
      synthesizer: capturingSynthesizer(captured, [2]),
    });
    const result = await search.buildBrief({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "phoenix launch",
      mode: "lexical",
      maxResults: 2,
    });

    expect(result.items).toHaveLength(2);
    expect(captured).toHaveLength(2);
    expect(result.brief.citations).toEqual([]);
  });

  it("returns a deterministic-only brief when no synthesizer is configured", async () => {
    if (!available || !pool) return;
    await seed({ id: "lonely", title: "Lonely page", content: "x" }); // thin + low coverage
    await reindex();

    const search = new RetrievalSearchService(pool, knowledgeRetrievalRegistry);
    const result = await search.buildBrief({
      spaceId: SPACE,
      viewerUserId: VIEWER,
      objectTypes: ["knowledge_item"],
      query: "lonely page",
      mode: "lexical",
      maxResults: 5,
    });
    expect(result.brief.synthesized).toBe(false);
    expect(result.brief.answer).toBeNull();
    expect(result.brief.citations).toEqual([]);
    expect(result.brief.gap_analysis.low_coverage).toBe(true); // only one source
    expect(result.brief.gap_analysis.thin.map((g) => g.object_id)).toContain("lonely");
    expect(result.items.map((i) => i.object_id)).toContain("lonely");
  });
});
