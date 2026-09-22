import type { Queryable } from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";

/**
 * The domain reconcilers that ride on a terminal Run.
 *
 * Run and Materialization remain the authority; these enqueues are a latency
 * optimization, so the owning domain observes the committed Run now rather
 * than on its next scheduled tick. Shared by `agent_run` and
 * `provider_task_run`: a Project Research stage that moves from an Agent Run
 * to a bounded ProviderTask Run must not lose the nudge that advances its
 * operation, and two copies of this list is how it would.
 */
export async function enqueueRunTerminalReconcilers(
  db: Queryable,
  input: {
    space_id: string;
    user_id: string;
    run_id: string;
    /** The Run's `contract_snapshot_json -> workflow_input_json`. */
    workflow_input_json: Record<string, unknown>;
  },
): Promise<void> {
  const kind = typeof input.workflow_input_json.kind === "string"
    ? input.workflow_input_json.kind
    : null;
  const queue = new PgJobQueueRepository(db);
  if (kind === "knowledge_candidate_extraction") {
    await queue.enqueue({
      job_type: "knowledge_candidate_extraction_reconcile",
      space_id: input.space_id,
      user_id: input.user_id,
      payload: { run_id: input.run_id },
    });
    return;
  }
  if (kind === "managed_experiment") {
    await queue.enqueue({
      job_type: "managed_experiment_reconcile",
      space_id: input.space_id,
      user_id: input.user_id,
      payload: { run_id: input.run_id },
    });
    return;
  }
  if (input.workflow_input_json.project_research_standing !== undefined) {
    await queue.enqueue({
      job_type: "project_research_standing_reconcile",
      space_id: input.space_id,
      user_id: input.user_id,
      payload: { run_id: input.run_id },
    });
    return;
  }
  if (
    input.workflow_input_json.project_research !== undefined
    // The ad-hoc notebook analysis reconciler. The bounded task applies its
    // own block ops before going terminal, so this is the safety net for a
    // Run that reached terminal without them — it is idempotent on the Run
    // and does nothing when the edit already landed.
    || input.workflow_input_json.research_adhoc !== undefined
  ) {
    await queue.enqueue({
      job_type: "project_research_execution_nudge",
      space_id: input.space_id,
      user_id: input.user_id,
      payload: { run_id: input.run_id, reason: "run_terminal" },
    });
  }
}
