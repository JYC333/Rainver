import type { RunRecord } from "./runRepositoryTypes.js";

/**
 * What this Run was asked to do, as opposed to everything it was told.
 *
 * A Room turn's `runs.prompt` is the whole assembled prompt: the Project's
 * state, the conversation's recent messages, the execution rules, and that
 * Agent's own persona and the notes it learned in this Room. Handing that
 * whole prompt to a different Agent carries one Agent's memory of itself
 * into another's vendor session and its CLI's auto-memory. Do not hand one Agent's identity block to a sibling. The
 * Agent is the memory boundary
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §4,
 * B68), and a sibling needs the task, not the identity.
 *
 * Every Run whose prompt can carry an identity block records its assigned task
 * on the Run (`model_override_json.chat_turn.assigned_task`): a Room turn, a
 * direct chat, and a delegated child in a Room, whose prompt opens with its
 * own block. The fallback is for the rest — an Automation, an evolution run, a
 * delegation outside a Room — which is asked one thing and whose prompt is
 * that thing. A Room turn with no resolved backend also falls back, and its
 * prompt carries Project state and execution rules but no identity: verbose
 * for a sibling to read, not a boundary crossing.
 */
export function runAssignedTask(run: Pick<RunRecord, "prompt" | "model_override_json">): string | null {
  const assigned = record(record(run.model_override_json).chat_turn).assigned_task;
  if (typeof assigned === "string" && assigned.trim()) return assigned;
  return run.prompt ?? null;
}

const HANDED_BACK_TASK_CHARS = 2_000;

/**
 * The assigned task as it is handed back to the Agent that delegated it, next
 * to the result. Only enough to tell the results apart: that Agent wrote the
 * task, and its own delegating call keeps all of it. Repeating the whole task
 * resent everything it had attached on every resume — one Room's review
 * tasks carried hundreds of thousands of characters each and pushed a
 * resume past the runtime's input limit.
 */
export function runAssignedTaskExcerpt(run: Pick<RunRecord, "prompt" | "model_override_json">): string | null {
  const task = runAssignedTask(run);
  if (!task || task.length <= HANDED_BACK_TASK_CHARS) return task;
  return `${task.slice(0, HANDED_BACK_TASK_CHARS)}… [${task.length - HANDED_BACK_TASK_CHARS} more characters of the task not repeated]`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
