import type { ConversationContinuationRegistry, ProposalContinuation } from "../proposals/continuationRegistry.js";
import type { Queryable } from "../routeUtils/common.js";

/**
 * Room continuations for the `research.start_acquisition` pipeline
 * (room-advancement-reliability-plan Phase 4). Two event kinds:
 *
 * - `research_pipeline_outcome` (key = `<thread id>:<pipeline job id>`, so a
 *   retry reports its own outcome instead of being answered with the previous
 *   attempt's message): the pre-Operation half of
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
      const cap = typeof event.payload.screening_cap === "number" ? event.payload.screening_cap : null;
      const matched = typeof event.payload.matched_estimate === "number" ? event.payload.matched_estimate : null;
      // Size first. "Acquisition is underway" was the whole of what the user
      // was told while nine hundred documents went through a model, and the
      // only number they ever saw was in the failure four hours later.
      // Cap first, match size second, and the match size labelled as the
      // loose upper bound it is. Leading with the larger number read as the
      // scope having grown when it had in fact just been bounded.
      const size = cap === null
        ? ""
        : matched === null
          ? ` It reads the ${cap} most recent matching items.`
          : ` It reads the ${cap} most recent matching items — the sources report on the order of ${matched.toLocaleString("en-US")} hits before de-duplication, so ${cap} is the bound, not a shortfall against a promise. Earlier history stays available to extend once this pass finishes.`;
      return {
        directive: "advance_started_acquisition",
        instruction:
          `A tracked research acquisition just started for this Thread's question.${size} Tell the user acquisition is underway and how much this pass covers, leading with what it will read rather than with how much exists, and say you'll relay results as they arrive.`,
        context: {
          operation_id: event.payload.operation_id ?? null,
          screening_cap: cap,
          matched_estimate: matched,
        },
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

  registry.registerEvent("research_workflow_terminal", async ({ db, event }) => {
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
      // The system works out a next step the moment a search finishes and
      // writes it to inquiry_thread_advice. Without it here the Agent ends a
      // four-hour search by inventing a question of its own, which is both
      // worse than the recorded advice and disagrees with what the Project's
      // attention list is simultaneously telling the user.
      const advice = await nextStepAdvice(db, event.payload.operation_id);
      const next = advice
        ? ` The system's recorded next step for this Thread is ${advice.recommended_focus_kind.replace(/_/g, " ")}, because: ${advice.rationale} Put that to the user as the suggested next step — it is the same one the Project's attention list is showing them — and offer to adopt it with inquiry.adopt_next_step if they agree. Do not substitute a next step of your own invention; if you disagree with it, say why and let them choose.`
        : "";
      return {
        directive: "report_research_operation_completed",
        instruction: `The research operation you started for this Thread has finished: ${reason} Summarize what it produced for the user and say what it means for the Thread's question — do not simply announce that a job completed.${next}`,
        context: {
          operation_id: event.payload.operation_id ?? null,
          reason,
          ...(advice ? { next_step: advice.recommended_focus_kind, thread_id: advice.thread_id } : {}),
        },
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

/**
 * The open, current next-step advice for the Thread an Operation was run for.
 *
 * Reached through the Operation because that is all a terminal event carries;
 * `progress_json.thread_scope` is where the Operation records whose question
 * it was. Stale advice is skipped for the same reason the attention list
 * skips it: a recommendation about a question that has since been reworded is
 * not a next step.
 */
async function nextStepAdvice(
  db: Queryable,
  operationId: unknown,
): Promise<{ thread_id: string; recommended_focus_kind: string; rationale: string } | null> {
  if (typeof operationId !== "string" || !operationId) return null;
  const rows = await db.query<{ thread_id: string; recommended_focus_kind: string; rationale: string }>(
    `SELECT advice.thread_id, advice.recommended_focus_kind, advice.rationale
       FROM project_operations operation
       JOIN inquiry_thread_advice advice
         ON advice.space_id = operation.space_id
        AND advice.project_id = operation.project_id
        AND advice.thread_id = operation.progress_json->'thread_scope'->0->>'thread_id'
       JOIN inquiry_threads thread
         ON thread.object_id = advice.thread_id AND thread.space_id = advice.space_id
      WHERE operation.id = $1
        AND advice.status = 'open'
        AND advice.thread_version >= thread.version
      LIMIT 1`,
    [operationId],
  );
  return rows.rows[0] ?? null;
}
