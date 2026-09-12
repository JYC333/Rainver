import type { Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";

/**
 * Who set this Run going, and under what origin — one hop up when it was
 * delegated.
 *
 * Both answers come off the same row, because every gate that asks one asks
 * the other about the same Run. A child created by `agent.delegate` carries
 * `trigger_origin = 'delegation'`, but the question every origin gate is
 * asking is whether a *person* asked for this in a conversation, and for a
 * delegated Run the answer lives on its root. Reading the raw columns instead
 * would make one hop of delegation a way around both
 * `ruleUnattendedProjectWrite` (an unattended root looking attended) and
 * ADR 0003 §5's persona rule (someone else's turn looking like the owner's
 * unattended work).
 */
export interface EffectiveRunTrigger {
  /** The root's `trigger_origin` for a delegated Run, this Run's otherwise. */
  origin: string;
  /**
   * The person responsible for this Run: who asked in the turn, or who set the
   * unattended work up (an Automation's owner, an autonomy tick's owner). Null
   * when no person stands behind it, which ADR 0003 §5 reads as "not the
   * Agent's owner".
   */
  instructedByUserId: string | null;
}

/**
 * Its own file rather than the dispatcher's, so the memory module can ask the
 * same question without importing the dispatcher that imports it.
 */
export async function effectiveRunTrigger(db: Queryable, run: RunRecord): Promise<EffectiveRunTrigger> {
  const own: EffectiveRunTrigger = {
    origin: run.trigger_origin,
    instructedByUserId: run.instructed_by_user_id ?? null,
  };
  if (run.trigger_origin !== "delegation" || !run.root_run_id || run.root_run_id === run.id) {
    return own;
  }
  const root = await db.query<{ trigger_origin: string; instructed_by_user_id: string | null }>(
    `SELECT trigger_origin, instructed_by_user_id FROM runs WHERE space_id = $1 AND id = $2`,
    [run.space_id, run.root_run_id],
  );
  const row = root.rows[0];
  return row ? { origin: row.trigger_origin, instructedByUserId: row.instructed_by_user_id ?? null } : own;
}
