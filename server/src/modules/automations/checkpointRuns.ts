import type {Queryable} from '../routeUtils/common.js';

/** Root Runs of the Workflow Executions whose checkpoint node is awaiting exactly these Proposals.
 * Read-only; the Proposal decision owner sorts, locks and rechecks them (proposalTransitions). */
export async function workflowCheckpointRootRunIds(db: Queryable, spaceId: string, proposalIds: readonly string[]): Promise<string[]> {
  return (await db.query<{id: string}>(`SELECT DISTINCT e.root_run_id AS id FROM proposals p
    JOIN workflow_executions e ON e.space_id=p.space_id AND e.id=p.payload_json->>'workflow_execution_id'
   WHERE p.space_id=$1 AND p.id=ANY($2::varchar[]) AND p.proposal_type='workflow_execution_checkpoint' AND e.root_run_id IS NOT NULL
     AND EXISTS(SELECT 1 FROM workflow_execution_nodes n WHERE n.id=p.payload_json->>'node_id' AND n.execution_id=e.id AND n.space_id=p.space_id AND n.approval_proposal_id=p.id)`,
  [spaceId, [...proposalIds]])).rows.map(row => row.id);
}
