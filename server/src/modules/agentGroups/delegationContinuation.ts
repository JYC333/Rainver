import {
  isChineseTitle,
  type ConversationContinuationRegistry,
} from "../proposals/continuationRegistry.js";

/**
 * Continuation for a delegated child run's completion, fired only when no
 * run in the Room's group was already waiting on it. A manager that replied
 * and ended its turn without calling `agent.wait_for_results` still gets
 * the child's result. The waiting case is
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
      ? `你委派的一个 Agent 已经完成（状态：${status}）。根据下面的结果继续完成原先获准的工作。核验结果，安排必要的修复或复审并等待结果；遇到失败先诊断并尝试获准的恢复，同时推进不受影响的工作。全部完成后再向用户汇报；若确实没有可继续的获准步骤，就说明具体阻塞。遵守现有协作和权限限制。\n\n结果：\n${resultSummary}`
      : `A delegated Agent you spawned has finished (status: ${status}). Use the result below to continue the original authorized work. Verify the result, arrange any necessary repair or review, and wait for those results. Diagnose failures, use authorized recovery, and continue unaffected work. Give the final report when the work is complete or no authorized next step remains. Preserve existing collaboration and permission limits.\n\nResult:\n${resultSummary}`;
    return {
      directive: "synthesize_delegation_result",
      instruction,
      context: { status },
    };
  });
}
