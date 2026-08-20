import { describe, expect, it } from "vitest";
import { ConversationContinuationRegistry } from "../src/modules/proposals/continuationRegistry";
import { registerResearchAcquisitionContinuation } from "../src/modules/projectResearch/researchAcquisitionContinuation";

// Pure-unit coverage for the continuation handlers behind
// `research.start_acquisition` (room-advancement-reliability-plan Phase 4).
// The real-Postgres pipeline test (researchAcquisitionPipelineDb.test.ts)
// exercises the pipeline calling into this registry; full end-to-end message
// posting additionally requires a working conversation backend (an
// unrelated Room-module prerequisite), so this file verifies the handler
// logic itself — event payload in, directive/instruction out — directly.

function registry(): ConversationContinuationRegistry {
  const registry = new ConversationContinuationRegistry();
  registerResearchAcquisitionContinuation(registry);
  return registry;
}

const baseEvent = { space_id: "space-1", project_id: "project-1" };

describe("registerResearchAcquisitionContinuation", () => {
  it("research_pipeline_outcome: started", async () => {
    const result = await registry().resolveEvent({} as never, {
      ...baseEvent,
      kind: "research_pipeline_outcome",
      key: "thread-1",
      payload: { status: "started", operation_id: "op-1" },
    });
    expect(result.directive).toBe("advance_started_acquisition");
    expect(result.context).toMatchObject({ operation_id: "op-1" });
  });

  it("research_pipeline_outcome: assessment_not_passed relays the reason and asks the Manager to help refine the question", async () => {
    const result = await registry().resolveEvent({} as never, {
      ...baseEvent,
      kind: "research_pipeline_outcome",
      key: "thread-1",
      payload: { status: "assessment_not_passed", reason: "Research context has not passed question assessment" },
    });
    expect(result.directive).toBe("refine_question_with_user");
    expect(result.instruction).toContain("Research context has not passed question assessment");
    expect(result.context).toMatchObject({ reason: "Research context has not passed question assessment" });
  });

  it("research_pipeline_outcome: stage_failed reports the failing stage and reason", async () => {
    const result = await registry().resolveEvent({} as never, {
      ...baseEvent,
      kind: "research_pipeline_outcome",
      key: "thread-1",
      payload: { status: "stage_failed", stage: "evaluate", reason: "No provider returned usable results" },
    });
    expect(result.directive).toBe("report_research_start_failed");
    expect(result.instruction).toContain("evaluate");
    expect(result.instruction).toContain("No provider returned usable results");
    expect(result.context).toMatchObject({ stage: "evaluate", reason: "No provider returned usable results" });
  });

  it("research_workflow_terminal: failed reports the operation failure", async () => {
    const result = await registry().resolveEvent({} as never, {
      ...baseEvent,
      kind: "research_workflow_terminal",
      key: "op-1",
      payload: { status: "failed", operation_id: "op-1", reason: "Checkpoint rejected by user" },
    });
    expect(result.directive).toBe("report_research_operation_failed");
    expect(result.instruction).toContain("Checkpoint rejected by user");
    expect(result.context).toMatchObject({ operation_id: "op-1", reason: "Checkpoint rejected by user" });
  });

  it("research_workflow_terminal: an unrecognized status falls back to a generic status-changed continuation rather than throwing", async () => {
    const result = await registry().resolveEvent({} as never, {
      ...baseEvent,
      kind: "research_workflow_terminal",
      key: "op-1",
      payload: { status: "completed", operation_id: "op-1" },
    });
    expect(result.directive).toBeNull();
    expect(result.context).toMatchObject({ operation_id: "op-1", status: "completed" });
  });

  it("throws for an unregistered event kind, matching the registry's own fail-loud contract", async () => {
    await expect(
      registry().resolveEvent({} as never, { ...baseEvent, kind: "not_a_real_event", key: "x", payload: {} }),
    ).rejects.toThrow(/no continuation handler is registered/);
  });
});
