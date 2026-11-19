import type {Queryable} from '../routeUtils/common.js';

/**
 * Research-owned read-only discovery of the Run graph a Research decision
 * touches. The Proposal decision / Run terminal owners (proposalTransitions)
 * sort, try-lock and recheck what these return; nothing here locks.
 */
export interface ResearchRunRef {id: string; space_id: string}
const LIVE_OR_STAGED = `(r.status NOT IN ('succeeded','degraded','failed','cancelled','orphaned') OR EXISTS(SELECT 1 FROM proposals staged WHERE staged.space_id=r.space_id AND staged.created_by_run_id=r.id AND staged.status='staged'))`;

/** Research aggregate snapshot before its Project/operation/graph locks: every live (or staged-output) root Run of the Project's Research graph. */
export async function researchGraphRunRefs(db: Queryable, spaceId: string, projectId: string): Promise<ResearchRunRef[]> {
  return (await db.query<ResearchRunRef>(`SELECT DISTINCT e.root_run_id AS id,e.space_id FROM workflow_executions e
 JOIN project_operations o ON o.id=e.research_operation_id AND o.space_id=e.space_id
 JOIN runs r ON r.id=e.root_run_id AND r.space_id=e.space_id
 WHERE ${LIVE_OR_STAGED} AND e.space_id=$1 AND o.project_id=$2 AND e.root_run_id IS NOT NULL ORDER BY e.root_run_id`, [spaceId, projectId])).rows;
}

/** Projects of the Research history extensions among these Proposals (their decider must write the Project). */
export async function researchHistoryProjectIds(db: Queryable, spaceId: string, proposalIds: readonly string[]): Promise<string[]> {
  return (await db.query<{project_id: string | null}>(`SELECT COALESCE(project_id,payload_json->>'project_id') AS project_id FROM proposals WHERE space_id=$1 AND id=ANY($2::varchar[]) AND proposal_type='research_history_extend'`,
    [spaceId, [...proposalIds]])).rows.flatMap(row => row.project_id ? [row.project_id] : []);
}

/**
 * The live Research graph Runs these Proposals reach: a history extension's
 * Project graph, and the Project graph of a Workflow checkpoint anchored on a
 * Research operation.
 */
export async function researchDecisionRunIds(db: Queryable, spaceId: string, proposalIds: readonly string[]): Promise<string[]> {
  return (await db.query<{id: string}>(`SELECT DISTINCT e.root_run_id AS id FROM proposals p
    JOIN project_operations o ON o.space_id=p.space_id
    JOIN workflow_executions e ON e.research_operation_id=o.id AND e.space_id=o.space_id
    JOIN runs r ON r.id=e.root_run_id AND r.space_id=e.space_id
   WHERE p.space_id=$1 AND p.id=ANY($2::varchar[]) AND ${LIVE_OR_STAGED} AND (
     p.proposal_type='research_history_extend' AND o.project_id=COALESCE(p.project_id,p.payload_json->>'project_id')
     OR p.proposal_type='workflow_execution_checkpoint' AND o.project_id IN (
       SELECT owner.project_id FROM workflow_executions anchor
         JOIN project_operations owner ON owner.id=anchor.research_operation_id AND owner.space_id=anchor.space_id
        WHERE anchor.space_id=p.space_id AND anchor.id=p.payload_json->>'workflow_execution_id'
          AND EXISTS(SELECT 1 FROM workflow_execution_nodes n WHERE n.id=p.payload_json->>'node_id' AND n.execution_id=anchor.id AND n.space_id=p.space_id AND n.approval_proposal_id=p.id)))`,
  [spaceId, [...proposalIds]])).rows.map(row => row.id);
}
