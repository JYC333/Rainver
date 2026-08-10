import { describe, expect, it } from "vitest";
import {
  RetrievalCalibrationDecisionRequestSchema,
  RetrievalEvalDiagnosticsReportRequestSchema,
  RetrievalExplainRequestSchema,
  RetrievalExplainResponseSchema,
  RetrievalBriefRequestSchema,
  RetrievalSearchRequestSchema,
  SpaceRetrievalSettingsSchema,
} from "../src/index";

describe("knowledge retrieval protocol contracts", () => {
  it("parses diagnostics request flags", () => {
    const request = RetrievalEvalDiagnosticsReportRequestSchema.parse({
      window_days: 7,
      limit: 50,
      include_maintenance_reports: false,
      compare_previous_window: false,
      create_packet: true,
      review_scope: "private",
    });

    expect(request).toEqual({
      window_days: 7,
      limit: 50,
      include_maintenance_reports: false,
      compare_previous_window: false,
      create_packet: true,
      review_scope: "private",
    });
  });

  it("parses calibration decisions and keeps cross-viewer semantic cache rejected", () => {
    const request = RetrievalCalibrationDecisionRequestSchema.parse({
      report_label: "Stage 2 calibration",
      suite: "retrieval_quality_feedback_loop",
      decisions: [{
        mechanic: "visible_edge_backlink",
        decision: "defer",
        access_safety_proof: "Backlink signal is computed only after viewer revalidation and stores no hidden ids.",
        eval_delta: { recall_10: 0.03 },
        evidence_artifact_ids: ["artifact-1"],
        guardrails: ["no hidden ids in trace"],
      }],
    });

    expect(request.decisions[0]?.mechanic).toBe("visible_edge_backlink");
    expect(request.decisions[0]?.eval_delta).toEqual({ recall_10: 0.03 });

    expect(
      RetrievalCalibrationDecisionRequestSchema.safeParse({
        decisions: [{
          mechanic: "semantic_results_cache",
          decision: "adopt",
          access_safety_proof: "would reuse cross-viewer result sets",
          eval_delta: { recall_10: 0.01 },
          evidence_artifact_ids: ["artifact-1"],
        }],
      }).success,
    ).toBe(false);
  });

  it("requires evidence and eval delta for calibration adopt decisions", () => {
    expect(
      RetrievalCalibrationDecisionRequestSchema.safeParse({
        decisions: [{
          mechanic: "visible_edge_backlink",
          decision: "adopt",
          access_safety_proof: "Visible-edge counts are computed only after viewer revalidation.",
          eval_delta: { recall_10: 0.02 },
        }],
      }).success,
    ).toBe(false);

    expect(
      RetrievalCalibrationDecisionRequestSchema.safeParse({
        decisions: [{
          mechanic: "visible_edge_backlink",
          decision: "adopt",
          access_safety_proof: "Visible-edge counts are computed only after viewer revalidation.",
          evidence_artifact_ids: ["artifact-1"],
        }],
      }).success,
    ).toBe(false);

    expect(
      RetrievalCalibrationDecisionRequestSchema.safeParse({
        decisions: [{
          mechanic: "visible_edge_backlink",
          decision: "adopt",
          access_safety_proof: "Visible-edge counts are computed only after viewer revalidation.",
          eval_delta: { recall_10: 0.02 },
          evidence_artifact_ids: ["artifact-1"],
        }],
      }).success,
    ).toBe(true);
  });

  it("parses Context Ops review and scan settings", () => {
    const settings = SpaceRetrievalSettingsSchema.parse({
      space_id: "space-1",
      default_search_mode: "hybrid",
      rerank_enabled: false,
      query_rewrite_enabled: false,
      query_rewrite_default: false,
      use_query_cache: true,
      include_trace: false,
      external_egress_enabled: true,
      retrieval_tool_mode: "off",
      context_ops_review_mode: "members",
      context_ops_scan_mode: "members",
      embedding_dimensions: 2560,
      max_results_default: 10,
      ranking_config: {
        version: 1,
        eval_gate: { min_primary_metric_delta: 0, required_evidence_artifacts: 1 },
        mechanics: {
          visible_edge_backlink: { state: "disabled", calibration_artifact_id: null, shipped_at: null, eval_gate: {} },
          candidate_owned_salience: { state: "disabled", calibration_artifact_id: null, shipped_at: null, eval_gate: {} },
          richer_dedup: { state: "disabled", calibration_artifact_id: null, shipped_at: null, eval_gate: {} },
          autocut: { state: "disabled", calibration_artifact_id: null, shipped_at: null, eval_gate: {} },
          semantic_results_cache: { state: "disabled", calibration_artifact_id: null, shipped_at: null, eval_gate: {} },
        },
      },
      created_at: "2026-06-26T00:00:00.000Z",
      updated_at: "2026-06-26T00:00:00.000Z",
    });

    expect(settings.context_ops_review_mode).toBe("members");
    expect(settings.context_ops_scan_mode).toBe("members");
    expect(settings.ranking_config.mechanics.semantic_results_cache.state).toBe("disabled");
  });

  it("parses retrieval explain requests", () => {
    const request = RetrievalExplainRequestSchema.parse({
      query: "alpha",
      object_type: "knowledge_item",
      object_id: "knowledge-item-1",
      object_types: ["knowledge_item"],
      max_results: 5,
      mode: "exact",
      persist_artifact: true,
    });

    expect(request).toMatchObject({
      query: "alpha",
      object_type: "knowledge_item",
      object_id: "knowledge-item-1",
      max_results: 5,
      mode: "exact",
      persist_artifact: true,
    });
  });

  it("parses adaptive return opt-in on retrieval requests", () => {
    expect(RetrievalSearchRequestSchema.parse({
      query: "alpha",
      adaptive_return: true,
    }).adaptive_return).toBe(true);
    expect(RetrievalBriefRequestSchema.parse({
      query: "alpha",
      adaptive_return: true,
    }).adaptive_return).toBe(true);
    expect(RetrievalExplainRequestSchema.parse({
      query: "alpha",
      object_type: "knowledge_item",
      object_id: "knowledge-item-1",
      adaptive_return: true,
    }).adaptive_return).toBe(true);
  });

  it("parses object_profile filters and metadata without widening object_type", () => {
    const request = RetrievalSearchRequestSchema.parse({
      query: "alpha",
      object_types: ["knowledge_item"],
      object_profiles: ["decision"],
    });
    expect(request.object_profiles).toEqual(["decision"]);

    expect(RetrievalSearchRequestSchema.safeParse({
      query: "alpha",
      object_profiles: ["Decision"],
    }).success).toBe(false);

    const brief = RetrievalBriefRequestSchema.parse({
      query: "alpha",
      object_profiles: ["decision"],
    });
    expect(brief.object_profiles).toEqual(["decision"]);
  });

  it("keeps retrieval explain trace summaries aggregate-only", () => {
    expect(
      RetrievalExplainResponseSchema.safeParse({
        target: {
          object_type: "knowledge_item",
          object_id: "knowledge-item-1",
          title: "Alpha",
          visible: true,
          returned: true,
          rank: 1,
          score: 1,
          score_bucket: "ge_0_75",
        },
        match: {
          matched_fields: ["title"],
          evidence_kind: "exact_title_match",
        },
        trace: {
          arms: { exact: 1 },
          dropped: 0,
          dropped_reasons: {},
          candidate_id: "must-not-pass-through",
        },
        diagnostic_codes: ["target_returned"],
      }).success,
    ).toBe(false);
  });
});
