import type {Queryable} from '../routeUtils/common.js';

/** Root Runs of the Plans whose live checkpoint node is awaiting exactly these Proposals. Read-only; the
 * Proposal decision owner sorts, locks and rechecks them (proposalTransitions). */
export async function planCheckpointRootRunIds(db: Queryable, spaceId: string, proposalIds: readonly string[]): Promise<string[]> {
  return (await db.query<{id: string}>(`SELECT DISTINCT pl.root_run_id AS id FROM proposals p
    JOIN plans pl ON pl.space_id=p.space_id AND pl.id=p.payload_json->>'plan_id'
   WHERE p.space_id=$1 AND p.id=ANY($2::varchar[]) AND p.proposal_type='plan_checkpoint' AND pl.root_run_id IS NOT NULL
     AND EXISTS(SELECT 1 FROM plan_nodes n WHERE n.id=p.payload_json->>'node_id' AND n.plan_version_id=p.payload_json->>'plan_version_id' AND n.space_id=p.space_id AND n.approval_proposal_id=p.id)`,
  [spaceId, [...proposalIds]])).rows.map(row => row.id);
}
