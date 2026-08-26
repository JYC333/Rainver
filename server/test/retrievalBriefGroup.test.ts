import { beforeEach, describe, expect, it } from "vitest";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { type BriefCandidate, type SynthesisResult, type Synthesizer } from "../src/modules/retrieval/synthesis.js";
import { buildRetrievalBriefArtifactSpec, persistRetrievalBriefArtifact } from "../src/modules/retrieval/artifacts/brief.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("retrievalBriefArtifacts", () => {
  describe("retrieval brief artifacts", () => {
    it("builds structured retrieval_brief artifact content and metadata", () => {
      const spec = buildRetrievalBriefArtifactSpec({
        spaceId: "space-1",
        ownerUserId: "user-1",
        runId: "run-1",
        projectId: "project-1",
        query: "widget plan",
        objectTypes: ["knowledge_item"],
        maxResults: 5,
        mode: "lexical",
        includeTrace: true,
        surface: "knowledge_brief",
        egressPolicySnapshot: { external_egress_enabled: false },
        settingsSnapshot: { embedding_dimensions: 2560 },
        response: {
          brief: {
            answer: "Use the staged widget plan.",
            synthesized: true,
            citations: [{ object_type: "knowledge_item", object_id: "k1", title: "Widget Plan" }],
            gap_analysis: {
              stale: [],
              thin: [],
              low_coverage: false,
              uncited_claims: [],
              contradictions: [],
              missing_topics: ["budget"],
            },
          },
          items: [
            {
              object_type: "knowledge_item",
              object_id: "k1",
              title: "Widget Plan",
              snippet: "staged rollout",
              score: 0.9,
              evidence: { kind: "lexical_match" },
              matched_fields: ["title"],
            },
          ],
          total: 1,
          trace: { arms: { lexical: 1 } },
        },
      });

      expect(spec.artifact_type).toBe("retrieval_brief");
      expect(spec.visibility).toBe("private");
      expect(spec.title).toBe("Context Brief: widget plan");
      expect(spec.mime_type).toBe("application/json; charset=utf-8");
      expect(spec.metadata_json).toMatchObject({
        query: "widget plan",
        visibility: "private",
        run_id: "run-1",
        owner_user_id: "user-1",
        egress_policy_snapshot: { external_egress_enabled: false },
        item_refs: [{ object_type: "knowledge_item", object_id: "k1", title: "Widget Plan" }],
        gap_analysis: { missing_topics: ["budget"] },
      });
      expect(JSON.parse(spec.content)).toMatchObject(spec.metadata_json);
    });

    it("aggregates the distinct source connection ids from item source_refs (G3)", () => {
      const spec = buildRetrievalBriefArtifactSpec({
        spaceId: "space-1",
        ownerUserId: "user-1",
        runId: null,
        projectId: null,
        query: "widget plan",
        maxResults: 5,
        mode: "hybrid",
        includeTrace: false,
        surface: "knowledge_brief",
        egressPolicySnapshot: { external_egress_enabled: false },
        response: {
          brief: {
            answer: "From the connected sources.",
            synthesized: true,
            citations: [],
            gap_analysis: {
              stale: [], thin: [], low_coverage: false,
              uncited_claims: [], contradictions: [], missing_topics: [],
            },
          },
          items: [
            {
              object_type: "knowledge_item", object_id: "k1", title: "A", snippet: null,
              score: 0.9, evidence: { kind: "lexical_match" }, matched_fields: ["title"],
              source_refs: [{ source_connection_id: "src-1" }],
            },
            {
              object_type: "knowledge_item", object_id: "k2", title: "B", snippet: null,
              score: 0.8, evidence: { kind: "lexical_match" }, matched_fields: ["title"],
              source_refs: [{ source_connection_id: "src-1" }, { source_connection_id: "src-2" }],
            },
            {
              object_type: "knowledge_item", object_id: "k3", title: "C", snippet: null,
              score: 0.7, evidence: { kind: "lexical_match" }, matched_fields: ["title"],
            },
          ],
          total: 3,
        },
      });

      expect((spec.metadata_json as { source_connection_ids: string[] }).source_connection_ids.sort())
        .toEqual(["src-1", "src-2"]);
    });

    it("persists retrieval_brief artifacts into the existing artifacts table shape", async () => {
      const calls: unknown[][] = [];
      const db = {
        async query(_sql: string, params?: readonly unknown[]) {
          calls.push([_sql, params]);
          return { rows: [], rowCount: 1 };
        },
      };

      const id = await persistRetrievalBriefArtifact(db, {
        spaceId: "space-1",
        ownerUserId: "user-1",
        runId: null,
        projectId: null,
        query: "alpha",
        maxResults: 3,
        mode: "hybrid",
        includeTrace: false,
        surface: "knowledge_brief",
        egressPolicySnapshot: { external_egress_enabled: true },
        response: {
          brief: {
            answer: null,
            synthesized: false,
            citations: [],
            gap_analysis: {
              stale: [],
              thin: [],
              low_coverage: true,
              uncited_claims: [],
              contradictions: [],
              missing_topics: [],
            },
          },
          items: [],
          total: 0,
        },
      });

      expect(id).toEqual(expect.any(String));
      const params = calls[0]?.[1] as unknown[];
      expect(params[1]).toBe("space-1");
      expect(params[2]).toBeNull();
      expect(params[4]).toBe("retrieval_brief");
      expect(params[5]).toBe("Context Brief: alpha");
      expect(params[14]).toBe("private");
      expect(params[15]).toBe("user-1");
      expect(JSON.parse(String(params[13]))).toMatchObject({
        query: "alpha",
        visibility: "private",
        egress_policy_snapshot: { external_egress_enabled: true },
      });
    });

    it("keeps Memory and Project brief artifacts private without copying snippets or traces", () => {
      const memorySpec = buildRetrievalBriefArtifactSpec({
        spaceId: "space-1",
        ownerUserId: "user-1",
        runId: null,
        projectId: null,
        query: "alpha",
        objectTypes: ["memory_entry"],
        maxResults: 3,
        mode: "hybrid",
        includeTrace: true,
        surface: "memory_retrieval_brief",
        persistTrace: false,
        egressPolicySnapshot: { external_egress_enabled: false },
        response: {
          brief: {
            answer: null,
            synthesized: false,
            citations: [{ object_type: "memory_entry", object_id: "m1", title: "Visible title" }],
            gap_analysis: {
              stale: [],
              thin: [],
              low_coverage: false,
              uncited_claims: [],
              contradictions: [],
              missing_topics: [],
            },
          },
          items: [
            {
              object_type: "memory_entry",
              object_id: "m1",
              title: "Visible title",
              snippet: "private detail that must not persist",
              score: 0.7,
              evidence: { kind: "lexical_match" },
              matched_fields: ["title"],
              source_refs: [{ source_type: "memory_entry", source_id: "m1" }],
            },
          ],
          total: 1,
          trace: { raw: "trace detail that should not persist" },
        },
      });
      const memoryPayload = JSON.parse(memorySpec.content);

      expect(memoryPayload).toMatchObject({
        visibility: "private",
        owner_user_id: "user-1",
        surface: "memory_retrieval_brief",
        object_types: ["memory_entry"],
        trace: null,
        item_refs: [
          {
            object_type: "memory_entry",
            object_id: "m1",
            title: "Visible title",
          },
        ],
      });
      expect(memoryPayload.item_refs[0]).not.toHaveProperty("snippet");
      expect(JSON.stringify(memoryPayload)).not.toContain("private detail that must not persist");
      expect(JSON.stringify(memoryPayload)).not.toContain("trace detail that should not persist");

      const projectSpec = buildRetrievalBriefArtifactSpec({
        spaceId: "space-1",
        ownerUserId: "user-1",
        runId: null,
        projectId: null,
        query: "roadmap",
        objectTypes: ["project_public_summary"],
        maxResults: 3,
        mode: "hybrid",
        includeTrace: true,
        surface: "project_public_summary_brief",
        persistTrace: false,
        egressPolicySnapshot: { external_egress_enabled: true },
        response: {
          brief: {
            answer: null,
            synthesized: false,
            citations: [],
            gap_analysis: {
              stale: [],
              thin: [],
              low_coverage: true,
              uncited_claims: [],
              contradictions: [],
              missing_topics: [],
            },
          },
          items: [],
          total: 0,
          trace: { raw: "project trace" },
        },
      });
      const projectPayload = JSON.parse(projectSpec.content);

      expect(projectPayload).toMatchObject({
        visibility: "private",
        surface: "project_public_summary_brief",
        object_types: ["project_public_summary"],
        trace: null,
      });
    });

    it("requires an owner for owner-private retrieval_brief artifacts", () => {
      expect(() =>
        buildRetrievalBriefArtifactSpec({
          spaceId: "space-1",
          ownerUserId: "",
          runId: null,
          projectId: null,
          query: "alpha",
          maxResults: 3,
          mode: "hybrid",
          includeTrace: false,
          surface: "knowledge_brief",
          egressPolicySnapshot: { external_egress_enabled: true },
          response: {
            brief: {
              answer: null,
              synthesized: false,
              citations: [],
              gap_analysis: {
                stale: [],
                thin: [],
                low_coverage: true,
                uncited_claims: [],
                contradictions: [],
                missing_topics: [],
              },
            },
            items: [],
            total: 0,
          },
        }),
      ).toThrow("owner_user_id");
    });
  });
});

describe("retrievalBriefDb", () => {
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


  const db = useTestDatabase(`${import.meta.filename}#retrievalBriefDb`);

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "users", "spaces"],
      { cascade: true },
    );
    await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Brief', 'personal', now(), now())`, [SPACE]);
    for (const id of [VIEWER, OTHER]) {
      await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'U', 'active', now(), now())`, [id]);
    }
    await db.pool.query(
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
    await insertKnowledgeItem(db.pool, {
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
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);
  }

  describe("Retrieval Context Brief (real Postgres)", () => {
    it("synthesizes a cited answer from the revalidated sources", async () => {
      if (!db.available) return;
      await seed({ id: "doc-a", title: "Backups", content: "Nightly backups run at 02:00 to cold storage." });
      await seed({ id: "doc-b", title: "Restore", content: "Restores are tested quarterly from backups." });
      await reindex();

      const captured: BriefCandidate[] = [];
      const search = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
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
      if (!db.available) return;
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
      const search = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
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
      if (!db.available) return;
      await seed({ id: "only-doc", title: "Solo", content: "The one and only matching page about quokkas." });
      await reindex();

      const search = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
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
      if (!db.available) return;
      await seed({ id: "doc-a", title: "A", content: "Phoenix launch checklist." });
      await seed({ id: "doc-b", title: "B", content: "Phoenix launch dependencies." });
      await seed({ id: "doc-c", title: "C", content: "Phoenix launch archive." });
      await reindex();

      const captured: BriefCandidate[] = [];
      const search = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry, {
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
      if (!db.available) return;
      await seed({ id: "lonely", title: "Lonely page", content: "x" }); // thin + low coverage
      await reindex();

      const search = new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry);
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
});
