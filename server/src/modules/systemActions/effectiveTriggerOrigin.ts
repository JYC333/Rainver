import type { Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";

/**
 * Who set this Run going, one hop up when it was delegated.
 *
 * A child Run created by `agent.delegate` carries `trigger_origin =
 * 'delegation'`, but the question every origin gate is asking is whether a
 * *person* asked for this in a conversation — and for a delegated Run the
 * answer lives on its root. Reading the raw column instead would make one hop
 * of delegation a way around both `ruleUnattendedProjectWrite` (an unattended
 * root looking attended) and ADR 0003 §5's persona rule (a person's turn
 * looking unattended, so the change applies with nobody deciding it).
 *
 * Its own file rather than the dispatcher's, so the memory module can ask the
 * same question without importing the dispatcher that imports it.
 */
export async function effectiveTriggerOrigin(db: Queryable, run: RunRecord): Promise<string> {
  if (run.trigger_origin !== "delegation" || !run.root_run_id || run.root_run_id === run.id) {
    return run.trigger_origin;
  }
  const root = await db.query<{ trigger_origin: string }>(
    `SELECT trigger_origin FROM runs WHERE space_id = $1 AND id = $2`,
    [run.space_id, run.root_run_id],
  );
  return root.rows[0]?.trigger_origin ?? run.trigger_origin;
}
