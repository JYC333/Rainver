import type { ConversationContinuationRegistry, ProposalContinuation } from "../proposals/continuationRegistry.js";

/**
 * Room continuations for the `research.start_acquisition` pipeline
 * (room-advancement-reliability-plan Phase 4). Two event kinds:
 *
 * - `research_pipeline_outcome` (key = thread id): the pre-Operation half of
 *   the pipeline — acquisition started, the question failed its FINER
 *   assessment (a first-class outcome, not an error), or an earlier stage
 *   failed. Posted by `ResearchAcquisitionPipelineRunner`.
 * - `research_workflow_terminal` (key = `<operation id>:<status>`): the
 *   Operation's own later lifecycle. All three variants are wired, all
 *   through `ProjectResearchOrchestrator.notifyRoomOfOperationStatus` —
 *   `failed` from `failOperation`, `completed` when the idea-review advance
 *   finishes the operation, and `waiting_review` when the screening corpus
 *   exceeds the auto-continue budget. The status is part of the event key
 *   because one Operation can legitimately report twice (pause, then finish).
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
    if (status === "completed") {
      const reason = typeof event.payload.reason === "string" ? event.payload.reason : "The research operation finished.";
      return {
        directive: "report_research_operation_completed",
        instruction: `The research operation you started for this Thread has finished: ${reason} Summarize what it produced for the user and say what it means for the Thread's question — do not simply announce that a job completed.`,
        context: { operation_id: event.payload.operation_id ?? null, reason },
      };
    }
    if (status === "waiting_review") {
      const reason = typeof event.payload.reason === "string" ? event.payload.reason : "The research operation is waiting for a decision.";
      return {
        directive: "report_research_operation_waiting",
        instruction: `The research operation you started for this Thread has paused and needs the user: ${reason} Relay this in plain language and tell them their options — approving the checkpoint to continue happens on the Project's Operations page in the web UI (you cannot approve it from here); cancelling the operation is available from this conversation via research.cancel_acquisition.`,
        context: { operation_id: event.payload.operation_id ?? null, reason },
      };
    }
    // A status this handler does not know is still its own event kind, so it
    // reports rather than throws.
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
