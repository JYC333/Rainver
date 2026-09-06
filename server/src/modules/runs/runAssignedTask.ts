import type { RunRecord } from "./runRepositoryTypes.js";

/**
 * What this Run was asked to do, as opposed to everything it was told.
 *
 * A Room turn's `runs.prompt` is the whole assembled prompt: the Project's
 * state, the conversation's recent messages, the execution rules, and — since
 * the Agent identity work — that Agent's own persona and the notes it learned
 * in this Room. Handing that to a *different* Agent, which is what a fan-out
 * handover and `agent.wait_for_results` used to do, carries one Agent's memory
 * of itself into another's vendor session and its CLI's auto-memory. The
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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
