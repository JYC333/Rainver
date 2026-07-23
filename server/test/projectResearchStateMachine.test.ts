import { describe, expect, it } from "vitest";
import {
  RESEARCH_STAGE_TRANSITIONS,
  RESEARCH_STAGES,
  applyResearchStatePatch,
  deriveStepStates,
  isLegalResearchTransition,
  researchStageIndex,
  researchState,
  type ResearchOperationState,
  type ResearchStage,
} from "../src/modules/projectResearch/stateMachine";

function state(current_stage: ResearchStage, stage_state: ResearchOperationState["stage_state"] = "running"): ResearchOperationState {
  return {
    schema_version: "project_research_operation.v1",
    run_kind: "baseline",
    workflow_id: "workflow-1",
    research_question: "Question",
    research_question_version: 1,
    report_depth: "full",
    question_refine_skipped: false,
    research_scope: { in: [], out: [], sub_questions: [], must_have: [], nice_to_have: [] },
    channel_ids: [],
    project_source_binding_ids: [],
    source_post_processing_rule_ids: [],
    project_source_binding_id: null,
    source_post_processing_rule_id: null,
    source_backfill_plan_id: null,
    source_backfill_plan_ids: [],
    query: { source_channel_ids: [], fingerprint: "", sort_by: "submittedDate", history_mode: null, from: null, to: null },
    history: { mode: null, from: null, to: null, max_items: null },
    watermark: { before: null, after: null, overlap_hours: 48 },
    source_item_ids: [],
    current_stage,
    stage_state,
    agent_id: "agent-1",
    runtime_profile_id: "profile-1",
    checkpoint_ids: [],
    synthesis_run_id: null,
    artifact_ids: [],
    partial: false,
    monitoring_active: false,
    idempotency: { key: "key", fingerprint: "fingerprint" },
  };
}

describe("project research transition authority", () => {
  it("exhaustively treats the transition table as the legal stage contract", () => {
    for (const from of RESEARCH_STAGES) {
      for (const to of RESEARCH_STAGES) {
        expect(isLegalResearchTransition(from, to)).toBe(
          from === to || RESEARCH_STAGE_TRANSITIONS[from].includes(to),
        );
      }
    }
    expect(isLegalResearchTransition("synthesis", "complete")).toBe(true);
    expect(isLegalResearchTransition("failed", "complete")).toBe(true);
  });

  it("derives step progress from the stage and blocks the review stage", () => {
    expect(researchStageIndex("synthesis")).toBe(3);
    expect(deriveStepStates(state("synthesis"))).toEqual([
      { seq: 0, status: "done" },
      { seq: 1, status: "done" },
      { seq: 2, status: "done" },
      { seq: 3, status: "active" },
      { seq: 4, status: "pending" },
    ]);
    expect(deriveStepStates(state("idea_review", "waiting_review")).at(-1)).toEqual({ seq: 4, status: "blocked" });
  });

  it("keeps a failed operation anchored to its failed stage", () => {
    expect(deriveStepStates({ ...state("failed", "failed"), failed_stage: "screening" })).toEqual([
      { seq: 0, status: "done" },
      { seq: 1, status: "done" },
      { seq: 2, status: "blocked" },
      { seq: 3, status: "pending" },
      { seq: 4, status: "pending" },
    ]);
  });

  it("normalizes persisted states from before the watermark field existed", () => {
    const restored = researchState({ current_stage: "backfill", source_item_ids: [], checkpoint_ids: [] });
    expect(restored.current_stage).toBe("backfill");
    expect(restored.watermark).toEqual({ before: null, after: null, overlap_hours: 48 });
  });

  it("does not infer the authoritative synthesis run id from progress telemetry", () => {
    const restored = researchState({
      current_stage: "synthesis",
      synthesis_progress: { run_id: "run-from-progress", run_status: "succeeded" },
    });
    expect(restored.synthesis_run_id).toBeNull();
  });

  it("unions append-only source items while applying a stale snapshot", () => {
    const base = state("screening");
    const current = { ...base, source_item_ids: ["current-item"] };
    const proposed = { ...base, source_item_ids: ["observed-item"] };
    applyResearchStatePatch(current, base, proposed);
    expect(current.source_item_ids).toEqual(["current-item", "observed-item"]);
  });
});
