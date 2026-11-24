import type { RunRecord } from "../runs/repository.js";
import { AUTOMATIC_HANDOFF_WAIT_SCOPE } from "./autoHandoff.js";
import { handoffTurnOf } from "./sessionHandoff.js";
import { CONVERSATION_SERIALIZATION_WAIT_SCOPE } from "./waitScopes.js";

/**
 * Whether a person's additional input can wait for this parked Run's resume:
 * only an Agent's own `agent.wait_for_results` pause, whose resume
 * (`waitingContinuationPrompt`) hands the waited results to the same turn.
 * A recipient serialized behind earlier ones never ran, and a handoff wait or
 * handoff turn writes for the next session; neither resumes this turn.
 */
export function waitAcceptsPersonInput(run: Pick<RunRecord, "status" | "output_json" | "model_override_json">): boolean {
  if (run.status !== "waiting_for_dependency" || handoffTurnOf(run)) return false;
  const output = run.output_json && typeof run.output_json === "object" ? run.output_json as Record<string, unknown> : {};
  const wait = output.waiting_for_results && typeof output.waiting_for_results === "object"
    ? output.waiting_for_results as Record<string, unknown> : {};
  if (wait.status !== "waiting") return false;
  if (wait.scope === CONVERSATION_SERIALIZATION_WAIT_SCOPE || wait.scope === AUTOMATIC_HANDOFF_WAIT_SCOPE) return false;
  return Array.isArray(wait.depends_on_run_ids) && wait.depends_on_run_ids.some(id => typeof id === "string" && id.trim().length > 0);
}
