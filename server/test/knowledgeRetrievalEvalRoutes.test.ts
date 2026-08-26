import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeAuthRepository } from "./support/routeFakes.js";
import type { FastifyInstance } from "fastify";
import { getDbPool } from "../src/db/pool.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { knowledgeModule } from "../src/modules/knowledge/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthRepositoryForTests } from "../src/modules/auth/identity.js";
import { RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE } from "../src/modules/retrieval/artifacts/calibration.js";
import { RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE } from "../src/modules/retrieval/artifacts/eval.js";

vi.mock("../src/db/pool.js", () => ({
  getDbPool: vi.fn(),
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthRepositoryForTests(null);
  vi.mocked(getDbPool).mockReset();
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

function settingsRow(
  contextOpsReviewMode: "private_only" | "admins" | "members" = "private_only",
  contextOpsScanMode: "admins" | "members" = "admins",
) {
  return {
    settings_json: {
      default_search_mode: "hybrid",
      rerank_enabled: false,
      query_rewrite_enabled: false,
      query_rewrite_default: false,
      use_query_cache: true,
      include_trace: false,
      external_egress_enabled: true,
      retrieval_tool_mode: "off",
      context_ops_review_mode: contextOpsReviewMode,
      context_ops_scan_mode: contextOpsScanMode,
      embedding_dimensions: 2560,
      max_results_default: 10,
    },
    created_at: "2026-06-12T10:00:00.000Z",
    updated_at: "2026-06-12T10:00:00.000Z",
  };
}

describe("Knowledge retrieval eval report route", () => {
  it("persists an aggregate eval report as a private artifact", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository());
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow()], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/report",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        source: "retrieval_bench",
        suite: "golden",
        metrics: { recall: 1 },
        cases: [
          {
            case_label: "named-entity",
            metrics: { recall: 1 },
            diagnostic_codes: ["top_ranked"],
          },
        ],
        rank_attribution: {
          evidence_kind_counts: { lexical_match: 1 },
        },
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().artifact_id).toMatch(/[0-9a-f-]{36}/);
    const insert = calls.find((call) => /INSERT INTO artifacts/.test(call.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[4]).toBe(RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE);
    expect(insert!.params[14]).toBe("private");
    expect(insert!.params[15]).toBe("user-1");
    const metadata = JSON.parse(String(insert!.params[13]));
    expect(metadata).toMatchObject({
      source: "retrieval_bench",
      suite: "golden",
      access_safety: {
        aggregate_only: true,
        candidate_ids_included: false,
        content_included: false,
      },
      retention_policy: {
        class: "aggregate_private_artifact",
        owner_scoped: true,
        raw_private_content_included: false,
      },
    });
  });

  it("persists retrieval calibration decisions as evidence-ref-only private artifacts", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository());
    const evidenceArtifactId = "11111111-1111-4111-8111-111111111111";
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow()], rowCount: 1 };
        if (/SELECT a\.id, a\.artifact_type, a\.visibility\s+FROM artifacts a/.test(sql)) {
          expect(sql).toContain("a.visibility IN ('private', 'space_shared')");
          return {
            rows: [{
              id: evidenceArtifactId,
              artifact_type: "retrieval_eval_report",
              visibility: "private",
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/calibration-decisions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        report_label: "Backlink pass",
        suite: "calibration_stage_2",
        decisions: [{
          mechanic: "visible_edge_backlink",
          decision: "defer",
          access_safety_proof: "Backlink counts are derived from already-visible candidates only.",
          eval_delta: { recall_10: 0.03 },
          evidence_artifact_ids: [evidenceArtifactId],
          guardrails: ["no hidden ids"],
        }],
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      artifact_id: expect.stringMatching(/[0-9a-f-]{36}/),
      decision_count: 1,
    });
    const insert = calls.find((call) => /INSERT INTO artifacts/.test(call.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[4]).toBe(RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE);
    expect(insert!.params[14]).toBe("private");
    expect(insert!.params[15]).toBe("user-1");
    const metadata = JSON.parse(String(insert!.params[13]));
    expect(metadata).toMatchObject({
      kind: RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE,
      decision_summary: { defer: 1 },
      evidence_artifacts: [{
        artifact_id: evidenceArtifactId,
        artifact_type: "retrieval_eval_report",
        visibility: "private",
      }],
      access_safety: {
        aggregate_only: true,
        evidence_refs_only: true,
        content_included: false,
        hidden_ids_included: false,
        ranking_behavior_changed: false,
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("Secret Source");
    expect(JSON.stringify(metadata)).not.toContain("secret object");
  });

  it("does not allow space_ops calibration decisions to reference private evidence artifacts", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository());
    const privateEvidenceArtifactId = "11111111-1111-4111-8111-111111111111";
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow("admins")], rowCount: 1 };
        if (/SELECT\s+role\s+FROM space_memberships/.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        if (/SELECT a\.id, a\.artifact_type, a\.visibility\s+FROM artifacts a/.test(sql)) {
          expect(sql).toContain("a.visibility = 'space_shared'");
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/calibration-decisions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        review_scope: "space_ops",
        decisions: [{
          mechanic: "visible_edge_backlink",
          decision: "defer",
          access_safety_proof: "Shared review must not expose private evidence refs.",
          evidence_artifact_ids: [privateEvidenceArtifactId],
        }],
      }),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toContain("evidence artifact not found or not visible");
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(false);
  });

  it("rejects calibration adoption of cross-viewer semantic result caching", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository());
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow()], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/calibration-decisions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        decisions: [{
          mechanic: "semantic_results_cache",
          decision: "adopt",
          access_safety_proof: "cache result ids across viewers",
          eval_delta: { recall_10: 0.01 },
          evidence_artifact_ids: ["11111111-1111-4111-8111-111111111111"],
        }],
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("semantic results cache");
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(false);
  });

  it("rejects calibration adoption without evidence and eval delta", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository());
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow()], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/calibration-decisions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        decisions: [{
          mechanic: "visible_edge_backlink",
          decision: "adopt",
          access_safety_proof: "Visible-edge counts are computed only after viewer revalidation.",
        }],
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("eval_delta");
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(false);

    const missingEvidenceRes = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/calibration-decisions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        decisions: [{
          mechanic: "visible_edge_backlink",
          decision: "adopt",
          access_safety_proof: "Visible-edge counts are computed only after viewer revalidation.",
          eval_delta: { recall_10: 0.01 },
        }],
      }),
    });

    expect(missingEvidenceRes.statusCode).toBe(422);
    expect(missingEvidenceRes.json().detail).toContain("evidence_artifact_ids");
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(false);
  });

  it("generates an aggregate diagnostics report from private brief artifacts", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository());
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow()], rowCount: 1 };
        if (/FROM artifacts/.test(sql)) {
          if (/created_at </.test(sql)) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                artifact_type: "retrieval_brief",
                metadata_json: {
                  kind: "retrieval_brief",
                  surface: "knowledge_brief",
                  query: "private roadmap query",
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
                      score: 0.82,
                      matched_fields: ["title"],
                    },
                  ],
                },
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/diagnostics/report",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ window_days: 14, limit: 50 }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      counts: {
        window_days: 14,
        artifact_limit: 50,
        briefs_total: 1,
        low_coverage_briefs: 1,
        uncited_claims_total: 1,
        contradictions_total: 1,
        missing_topics_total: 1,
      },
      diagnostic_codes: [
        "low_coverage",
        "uncited_claims",
        "contradictions",
        "missing_topics",
        "stale_sources",
      ],
    });
    const select = calls.find((call) => /FROM artifacts/.test(call.sql));
    expect(select?.sql).toContain("metadata_json->>'suite' = 'retrieval_quality_feedback_loop'");
    expect(select?.params).toEqual([
      "space-1",
      "user-1",
      14,
      50,
      ["retrieval_brief", "retrieval_maintenance_report", "retrieval_eval_report"],
    ]);
    const insert = calls.find((call) => /INSERT INTO artifacts/.test(call.sql));
    expect(insert).toBeDefined();
    const metadata = JSON.parse(String(insert!.params[13]));
    expect(metadata).toMatchObject({
      source: "product_diagnostic",
      suite: "retrieval_quality_feedback_loop",
      access_safety: {
        aggregate_only: true,
        candidate_ids_included: false,
        content_included: false,
      },
      counts: {
        briefs_total: 1,
        stale_refs_total: 1,
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("private roadmap query");
    expect(JSON.stringify(metadata)).not.toContain("secret-k1");
    expect(JSON.stringify(metadata)).not.toContain("Secret Source");
    expect(JSON.stringify(metadata)).not.toContain("private uncited claim");
  });

  it("can create a private diagnostics review packet from aggregate diagnostics", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository());
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        // Every INSERT this fake handles puts the generated id first; echo
        // it back so callers relying on `RETURNING id` get a usable row.
        if (/^\s*INSERT/i.test(sql)) return { rows: [{ id: params[0] }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow()], rowCount: 1 };
        if (/FROM artifacts/.test(sql)) {
          if (/created_at </.test(sql)) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                artifact_type: "retrieval_maintenance_report",
                metadata_json: {
                  kind: "retrieval_maintenance_report",
                  counts: { thin: 2 },
                },
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      async connect() {
        return client;
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/diagnostics/report",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ window_days: 7, limit: 20, create_packet: true }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      artifact_id: expect.stringMatching(/[0-9a-f-]{36}/),
      proposal_id: expect.stringMatching(/[0-9a-f-]{36}/),
      diagnostic_codes: expect.arrayContaining(["maintenance_findings_present"]),
    });
    expect(calls.some((call) => call.sql === "BEGIN")).toBe(true);
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(true);
    const proposalInsert = calls.find((call) => /INSERT INTO proposals/.test(call.sql));
    expect(proposalInsert).toBeDefined();
    expect(proposalInsert!.params[3]).toBe("retrieval_diagnostics_packet");
    const payload = JSON.parse(String(proposalInsert!.params[10]));
    expect(payload).toMatchObject({
      operation: "retrieval_diagnostics_packet",
      canonical_write_performed: false,
      diagnostic_codes: expect.arrayContaining(["maintenance_findings_present"]),
    });
  });

  it("rejects member diagnostics scans unless member scan initiation is enabled", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository("member"));
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow("private_only", "admins")], rowCount: 1 };
        if (/FROM space_memberships/.test(sql)) return { rows: [{ role: "member" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/diagnostics/report",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ window_days: 7, limit: 20 }),
    });

    expect(res.statusCode).toBe(403);
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(false);
  });

  it("allows member private diagnostics scans when member scan initiation is enabled", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository("member"));
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow("private_only", "members")], rowCount: 1 };
        if (/FROM space_memberships/.test(sql)) return { rows: [{ role: "member" }], rowCount: 1 };
        if (/FROM artifacts/.test(sql)) {
          if (/created_at </.test(sql)) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                artifact_type: "retrieval_brief",
                metadata_json: {
                  kind: "retrieval_brief",
                  gap_analysis: { low_coverage: true },
                },
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/diagnostics/report",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ window_days: 7, limit: 20 }),
    });

    expect(res.statusCode).toBe(201);
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(true);
  });

  it("rejects space_ops diagnostics packets when space-wide review is disabled", async () => {
    __setAuthRepositoryForTests(fakeAuthRepository());
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    vi.mocked(getDbPool).mockReturnValue({
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) return { rows: [settingsRow("private_only")], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as never);
    app = buildModuleServer(config(), [knowledgeModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/retrieval/eval/diagnostics/report",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        window_days: 7,
        limit: 20,
        create_packet: true,
        review_scope: "space_ops",
      }),
    });

    expect(res.statusCode).toBe(403);
    expect(calls.some((call) => /INSERT INTO artifacts/.test(call.sql))).toBe(false);
    expect(calls.some((call) => /INSERT INTO proposals/.test(call.sql))).toBe(false);
  });
});
