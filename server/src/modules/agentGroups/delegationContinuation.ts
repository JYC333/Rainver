import {
  isChineseTitle,
  type ConversationContinuationRegistry,
} from "../proposals/continuationRegistry.js";

/**
 * Continuation for a delegated child run's completion, fired only when no
 * run in the Room's group was already waiting on it (plan Phase 3): the
 * fix for "delegate 完成了却没有后续" for a manager that replied and ended
 * its turn without calling `agent.wait_for_results`. The waiting case is
 * unaffected — it already resumes through the existing
 * `queueWaitingDependencyRunsIfReady` path and never reaches this handler.
 */
export function registerAgentDelegationContinuation(registry: ConversationContinuationRegistry): void {
  registry.registerEvent("agent_delegation_result", ({ event }) => {
    const instructionText = typeof event.payload.instruction === "string" ? event.payload.instruction : "";
    const resultSummary = typeof event.payload.result_summary === "string" ? event.payload.result_summary : "";
    const status = typeof event.payload.status === "string" ? event.payload.status : "succeeded";
    const chinese = isChineseTitle(instructionText);
    const instruction = chinese
      ? `你委派的一个 Agent 已经完成（状态：${status}）。用下面的结果给用户一个实质性的回复，不要说委派仍在进行中。\n\n结果：\n${resultSummary}`
      : `A delegated Agent you spawned has finished (status: ${status}). Use its result below to give the user a substantive reply now; do not say the delegation is still in progress.\n\nResult:\n${resultSummary}`;
    return {
      directive: "synthesize_delegation_result",
      instruction,
      context: { status },
    };
  });
}
