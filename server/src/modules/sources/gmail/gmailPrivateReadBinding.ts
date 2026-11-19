import type { Queryable } from "../../routeUtils/common.js";

/**
 * A Run that a withdrawn `gmail_private_read` card started (ADR 0033 §6)
 * carries `model_override_json.gmail_private_read`, which bound its read to
 * one mailbox. That hand-off has no compatible execution any more: such a Run
 * (one still queued or waiting at the upgrade) is refused every Gmail read
 * instead of falling back to another choice of mailbox. Later turns of the
 * conversation it created carry no binding and read as ordinary turns there.
 */
export async function runCarriesWithdrawnPrivateReadBinding(db: Queryable, actor: { space_id: string; run_id?: string | null }): Promise<boolean> {
  if (!actor.run_id) return false;
  return (await db.query(`SELECT 1 FROM runs WHERE id=$1 AND space_id=$2 AND model_override_json ? 'gmail_private_read'`,
    [actor.run_id, actor.space_id])).rows.length > 0;
}
