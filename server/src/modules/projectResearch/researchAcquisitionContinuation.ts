import type { ConversationContinuationRegistry, ProposalContinuation } from "../proposals/continuationRegistry";

/**
 * Room continuations for the `research.start_acquisition` pipeline
 * (room-advancement-reliability-plan Phase 4). Two event kinds:
 *
 * - `research_pipeline_outcome` (key = thread id): the pre-Operation half of
 *   the pipeline — acquisition started, the question failed its FINER
 *   assessment (a first-class outcome, not an error), or an earlier stage
 *   failed. Posted by `ResearchAcquisitionPipelineRunner`.
 * - `research_workflow_terminal` (key = operation id): the Operation's own
 *   later lifecycle. Only the `failed` variant is wired in this phase, from
 *   `ProjectResearchOrchestrator.failOperation` — the `completed` and
 *   `waiting_review` (checkpoint pause) variants are not yet reachable (see
 *   the room-advancement-reliability-plan Phase 4 follow-up note) and are
 *   deliberately not registered as unreachable/untestable handlers.
 */
export function registerResearchAcquisitionContinuation(registry: ConversationContinuationRegistry): void {
  registry.registerEvent("research_pipeline_outcome", ({ event }) => {
    const status = typeof event.payload.status === "string" ? event.payload.status : "";
    if (status === "started") {
      return {
        directive: "advance_started_acquisition",
        instruction:
          "A tracked research acquisition just started for this Thread's question. Tell the user acquisition is underway and that you'll relay results as they arrive.",
        context: { operation_id: event.payload.operation_id ?? null },
      };
    }
    if (status === "assessment_not_passed") {
      const reason = typeof event.payload.reason === "string" ? event.payload.reason : "The question did not pass its FINER assessment.";
      return {
        directive: "refine_question_with_user",
        instruction: `Starting research acquisition for this Thread did not proceed: ${reason} Relay this to the user in plain language and help them refine the question so it can pass assessment.`,
        context: { reason },
      };
    }
    const stage = typeof event.payload.stage === "string" ? event.payload.stage : "unknown";
    const reason = typeof event.payload.reason === "string" ? event.payload.reason : "An earlier stage failed.";
    return failedContinuation(stage, reason);
  });

  registry.registerEvent("research_workflow_terminal", ({ event }) => {
    const status = typeof event.payload.status === "string" ? event.payload.status : "";
    if (status === "failed") {
      const reason = typeof event.payload.reason === "string" ? event.payload.reason : "The research operation failed.";
      return {
        directive: "report_research_operation_failed",
        instruction: `The research operation you started for this Thread has failed: ${reason} Relay this to the user in plain language.`,
        context: { operation_id: event.payload.operation_id ?? null, reason },
      };
    }
    // completed / waiting_review are not yet emitted (see module doc); a
    // generic fallback keeps this future-proof rather than throwing on an
    // event kind this handler already owns.
    return {
      directive: null,
      instruction: "A research operation you started for this Thread changed status. Check the operation for details.",
      context: { operation_id: event.payload.operation_id ?? null, status },
    };
  });
}

function failedContinuation(stage: string, reason: string): ProposalContinuation {
  return {
    directive: "report_research_start_failed",
    instruction: `Starting research acquisition for this Thread failed at the ${stage} stage: ${reason} Relay this to the user in plain language; they may want to retry or adjust the question.`,
    context: { stage, reason },
  };
}
