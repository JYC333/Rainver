import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { knowledgeRetrievalRegistry } from "../src/modules/knowledge/retrievalAdapter.js";
import { memoryRetrievalRegistry } from "../src/modules/memory/retrievalAdapter.js";
import { buildRetrievalEvalReportArtifactSpec, persistRetrievalEvalReportArtifact, RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE } from "../src/modules/retrieval/artifacts/eval.js";
import { buildRetrievalEvalDiagnosticsReportFromArtifactMetadata, buildRetrievalEvalDiagnosticsReportFromMetadata } from "../src/modules/retrieval/evalDiagnostics.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";
import { resetTables } from "./support/resetTables.js";
import { type RecallCase, runRecallCases } from "./support/retrievalEval.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("retrievalEvalDb", () => {
  // Golden recall@k eval over the deterministic recall arms (exact alias / lexical
  // / graph). This is the Phase-2 gate: a future ranking change (vector arm,
  // source-tier boost, reranker) must keep these golden results in the top-k.

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


  const db = useTestDatabase(`${import.meta.filename}#retrievalEvalDb`);

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "knowledge_items", "space_objects", "memory_entries", "users", "spaces"],
      { cascade: true },
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at)
       VALUES ($1, 'Eval', 'personal', now(), now())`,
      [SPACE],
    );
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Owner', 'active', now(), now())`,
      [OWNER],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ('eval-owner', $1, $2, 'owner', 'active', now(), now())`,
      [SPACE, OWNER],
    );
  });

  async function seedKnowledge(doc: KnowledgeDoc): Promise<void> {
    await insertKnowledgeItem(db.pool, {
      id: doc.id,
      spaceId: SPACE,
      title: doc.title,
      content: doc.content,
      slug: doc.slug,
      aliases: doc.aliases ?? [],
    });
  }

  async function seedMemory(doc: MemoryDoc): Promise<void> {
    await db.pool.query(
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
      if (!db.available) return;
      for (const doc of knowledgeFixture.docs) await seedKnowledge(doc);
      await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(SPACE);

      const report = await runRecallCases(
        new RetrievalSearchService(db.pool, knowledgeRetrievalRegistry),
        { spaceId: SPACE, viewerUserId: OWNER, objectTypes: ["knowledge_item"] },
        knowledgeFixture.cases,
        K,
      );

      expect(report.perCase.filter((c) => c.recall < 1)).toEqual([]);
      expect(report.recall).toBe(1);
    });

    it(`memory recall@${K} hits every golden expected id`, async () => {
      if (!db.available) return;
      for (const doc of memoryFixture.docs) await seedMemory(doc);
      await new RetrievalProjectionService(db.pool, memoryRetrievalRegistry).reindexAll(SPACE);

      const report = await runRecallCases(
        new RetrievalSearchService(db.pool, memoryRetrievalRegistry),
        { spaceId: SPACE, viewerUserId: OWNER, objectTypes: ["memory_entry"] },
        memoryFixture.cases,
        K,
      );

      expect(report.perCase.filter((c) => c.recall < 1)).toEqual([]);
      expect(report.recall).toBe(1);
    });
  });
});

describe("retrievalEvalDiagnostics", () => {
  describe("retrieval eval diagnostics", () => {
    it("turns brief gap metadata into aggregate-only eval diagnostics", () => {
      const report = buildRetrievalEvalDiagnosticsReportFromMetadata(
        [
          {
            kind: "retrieval_brief",
            surface: "knowledge_brief",
            synthesized: true,
            source_count: 1,
            gap_analysis: {
              low_coverage: true,
              stale: [{ object_id: "secret-k1", title: "Secret Source" }],
              thin: [],
              uncited_claims: ["private uncited claim"],
              contradictions: ["private contradiction"],
              missing_topics: ["private topic"],
            },
            item_refs: [
              {
                object_type: "knowledge_item",
                object_id: "secret-k1",
                title: "Secret Source",
                score: 0.8,
                matched_fields: ["title"],
              },
            ],
          },
        ],
        {
          spaceId: "space-1",
          ownerUserId: "user-1",
          windowDays: 30,
          limit: 200,
        },
      );

      expect(report).toMatchObject({
        source: "product_diagnostic",
        suite: "retrieval_quality_feedback_loop",
        counts: {
          briefs_total: 1,
          low_coverage_briefs: 1,
          uncited_claims_total: 1,
          contradictions_total: 1,
          missing_topics_total: 1,
          stale_refs_total: 1,
          "object_type.knowledge_item": 1,
        },
        diagnostic_codes: [
          "low_coverage",
          "uncited_claims",
          "contradictions",
          "missing_topics",
          "stale_sources",
        ],
      });
      expect(report.rank_attribution.matched_field_counts).toEqual({ title: 1 });
      expect(JSON.stringify(report)).not.toContain("secret-k1");
      expect(JSON.stringify(report)).not.toContain("Secret Source");
      expect(JSON.stringify(report)).not.toContain("private uncited claim");
    });

    it("merges maintenance reports and previous-window trends without object details", () => {
      const report = buildRetrievalEvalDiagnosticsReportFromArtifactMetadata(
        [
          {
            artifactType: "retrieval_brief",
            metadata: {
              kind: "retrieval_brief",
              synthesized: true,
              source_count: 1,
              gap_analysis: { low_coverage: true, stale: [], thin: [], uncited_claims: [], contradictions: [], missing_topics: [] },
              item_refs: [],
            },
          },
          {
            artifactType: "retrieval_brief",
            metadata: {
              kind: "retrieval_brief",
              synthesized: true,
              source_count: 1,
              gap_analysis: { low_coverage: false, stale: [], thin: [], uncited_claims: [], contradictions: [], missing_topics: [] },
              item_refs: [],
            },
          },
          {
            artifactType: "retrieval_maintenance_report",
            metadata: {
              kind: "retrieval_maintenance_report",
              counts: { duplicate: 1, thin: 2 },
              findings: [
                { objects: [{ object_id: "secret-item", title: "Secret Item" }] },
              ],
            },
          },
          {
            artifactType: "retrieval_maintenance_report",
            metadata: {
              kind: "retrieval_maintenance_report",
              counts: { stale: 1 },
            },
          },
        ],
        {
          spaceId: "space-1",
          ownerUserId: "user-1",
          windowDays: 7,
          limit: 50,
        },
        [
          {
            artifactType: "retrieval_brief",
            metadata: {
              kind: "retrieval_brief",
              synthesized: true,
              source_count: 1,
              gap_analysis: { low_coverage: false, stale: [], thin: [], uncited_claims: [], contradictions: [], missing_topics: [] },
              item_refs: [],
            },
          },
          {
            artifactType: "retrieval_brief",
            metadata: {
              kind: "retrieval_brief",
              synthesized: true,
              source_count: 1,
              gap_analysis: { low_coverage: false, stale: [], thin: [], uncited_claims: [], contradictions: [], missing_topics: [] },
              item_refs: [],
            },
          },
          {
            artifactType: "retrieval_maintenance_report",
            metadata: {
              kind: "retrieval_maintenance_report",
              counts: { duplicate: 1 },
            },
          },
          {
            artifactType: "retrieval_maintenance_report",
            metadata: {
              kind: "retrieval_maintenance_report",
              counts: { thin: 1 },
            },
          },
        ],
      );

      expect(report.counts).toMatchObject({
        briefs_total: 2,
        maintenance_reports_total: 2,
        maintenance_findings_total: 4,
        "maintenance.duplicate": 1,
        "maintenance.thin": 2,
        previous_briefs_total: 2,
        previous_maintenance_reports_total: 2,
        "trend.brief_sample_sufficient": 1,
        "trend.maintenance_sample_sufficient": 1,
        "trend.maintenance_findings_delta": 2,
      });
      expect(report.metrics).toMatchObject({
        "trend.low_coverage_rate_delta": 0.5,
        "trend.maintenance_findings_per_report_delta": 1,
      });
      expect(report.diagnostic_codes).toEqual(expect.arrayContaining([
        "low_coverage",
        "maintenance_findings_present",
        "trend_low_coverage_worse",
        "trend_maintenance_findings_worse",
      ]));
      expect(JSON.stringify(report)).not.toContain("secret-item");
      expect(JSON.stringify(report)).not.toContain("Secret Item");
    });

    it("excludes prior product diagnostics reports from eval aggregation", () => {
      const report = buildRetrievalEvalDiagnosticsReportFromArtifactMetadata(
        [
          {
            artifactType: "retrieval_eval_report",
            metadata: {
              source: "product_diagnostic",
              suite: "retrieval_quality_feedback_loop",
              metrics: { low_coverage_rate: 1 },
              diagnostic_codes: ["low_coverage"],
            },
          },
          {
            artifactType: "retrieval_eval_report",
            metadata: {
              source: "retrieval_bench",
              suite: "golden",
              metrics: { recall: 0.75 },
              diagnostic_codes: ["top_ranked"],
            },
          },
        ],
        {
          spaceId: "space-1",
          ownerUserId: "user-1",
          windowDays: 30,
          limit: 200,
        },
      );

      expect(report.counts).toMatchObject({
        eval_reports_total: 1,
        "eval_code.top_ranked": 1,
      });
      expect(report.counts).not.toHaveProperty("eval_code.low_coverage");
      expect(report.metrics).toMatchObject({
        "eval_avg.recall": 0.75,
      });
      expect(report.metrics).not.toHaveProperty("eval_avg.low_coverage_rate");
    });

    it("marks trend samples insufficient instead of emitting worse trend codes", () => {
      const report = buildRetrievalEvalDiagnosticsReportFromArtifactMetadata(
        [
          {
            artifactType: "retrieval_brief",
            metadata: {
              kind: "retrieval_brief",
              synthesized: true,
              source_count: 1,
              gap_analysis: { low_coverage: true, stale: [], thin: [], uncited_claims: [], contradictions: [], missing_topics: [] },
              item_refs: [],
            },
          },
        ],
        {
          spaceId: "space-1",
          ownerUserId: "user-1",
          windowDays: 7,
          limit: 50,
        },
        [
          {
            artifactType: "retrieval_brief",
            metadata: {
              kind: "retrieval_brief",
              synthesized: true,
              source_count: 1,
              gap_analysis: { low_coverage: false, stale: [], thin: [], uncited_claims: [], contradictions: [], missing_topics: [] },
              item_refs: [],
            },
          },
        ],
      );

      expect(report.counts).toMatchObject({
        "trend.brief_sample_sufficient": 0,
        "trend.min_briefs": 2,
      });
      expect(report.diagnostic_codes).toContain("insufficient_trend_sample");
      expect(report.diagnostic_codes).not.toContain("trend_low_coverage_worse");
      expect(report.metrics).not.toHaveProperty("trend.low_coverage_rate_delta");
    });
  });
});

describe("retrievalEvalReportArtifacts", () => {
  interface CapturedQuery {
    sql: string;
    params: readonly unknown[];
  }

  function fakeDb(): Queryable & { calls: CapturedQuery[] } {
    const calls: CapturedQuery[] = [];
    return {
      calls,
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
  }

  const report = {
    source: "retrieval_bench",
    suite: "golden-recall",
    report_label: "Nightly retrieval eval",
    k: 5,
    metrics: { recall: 1, mrr: 0.95, ndcg: 0.98 },
    counts: { cases: 3, misses: 0 },
    cases: [
      {
        case_label: "named-entity",
        object_type: "knowledge_item" as const,
        mode: "lexical" as const,
        k: 5,
        metrics: { recall: 1, rr: 1 },
        expected_count: 1,
        returned_count: 5,
        hit_count: 1,
        first_relevant_rank: 1,
        diagnostic_codes: [],
      },
    ],
    rank_attribution: {
      evidence_kind_counts: { lexical_match: 2, graph_neighbor: 1 },
      matched_field_counts: { title: 2, content: 1 },
      score_buckets: { top_1: 1, top_5: 3 },
    },
    diagnostic_codes: ["all_cases_passed"],
  };

  describe("retrieval eval report artifacts", () => {
    it("builds an aggregate-only owner-private eval report artifact", () => {
      const spec = buildRetrievalEvalReportArtifactSpec({
        spaceId: "space-1",
        ownerUserId: "user-1",
        report,
        settingsSnapshot: { default_search_mode: "hybrid" },
      });

      expect(spec).toMatchObject({
        artifact_type: RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE,
        visibility: "private",
        title: "Retrieval Eval Report: Nightly retrieval eval",
        mime_type: "application/json; charset=utf-8",
      });
      expect(spec.metadata_json).toMatchObject({
        kind: RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE,
        visibility: "private",
        owner_user_id: "user-1",
        metrics: { recall: 1, mrr: 0.95, ndcg: 0.98 },
        access_safety: {
          aggregate_only: true,
          candidate_ids_included: false,
          content_included: false,
        },
      });
      expect(JSON.stringify(spec.metadata_json)).not.toContain("object_id");
      expect(JSON.stringify(spec.metadata_json)).not.toContain("snippet");
    });

    it("persists eval reports as private artifacts", async () => {
      const db = fakeDb();
      const artifactId = await persistRetrievalEvalReportArtifact(db, {
        spaceId: "space-1",
        ownerUserId: "user-1",
        report,
      });

      expect(artifactId).toMatch(/[0-9a-f-]{36}/);
      expect(db.calls).toHaveLength(1);
      const params = db.calls[0]!.params;
      expect(params[1]).toBe("space-1");
      expect(params[4]).toBe(RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE);
      expect(params[14]).toBe("private");
      expect(params[15]).toBe("user-1");
      const metadata = JSON.parse(String(params[13]));
      expect(metadata).toMatchObject({
        kind: RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE,
        source: "retrieval_bench",
        suite: "golden-recall",
      });
    });
  });
});
