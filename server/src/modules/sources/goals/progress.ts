import type {SourceGoalExecutionProgress} from '@rainver/protocol';
import type {Queryable} from '../../routeUtils/common.js';
import type {GoalRow} from './access.js';
/** Read-only projection of canonical Runs/events/proposals, never a second job state. */
export async function goalExecutionProgress(db:Queryable,g:GoalRow):Promise<SourceGoalExecutionProgress|null>{
 const result=await db.query<{id:string;status:string;time_limit:boolean;created_at:string;ended_at:string|null}>(`SELECT id,status,created_at,ended_at,COALESCE(error_message LIKE 'The Run reached its time limit%',false) AS time_limit FROM runs WHERE space_id=$1 AND owner_user_id=$4 AND agent_id=$5 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$2 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='explore' AND COALESCE((contract_snapshot_json->'workflow_input_json'->'source_goal'->>'adjustment_cycle')::int,0)=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,[g.space_id,g.id,g.adjustment_cycle??0,g.owner_user_id,g.agent_id]);
 const run=result.rows[0];if(!run)return null;
 const events=await db.query<{action_id:string|null;created_at:string}>(`SELECT metadata_json->>'action_id' AS action_id,created_at FROM run_events WHERE space_id=$1 AND run_id=$2 AND event_type='action_invoked' ORDER BY event_index DESC LIMIT 1`,[g.space_id,run.id]);
 const completion=(await db.query<{status:string;error_message:string|null}>(`SELECT status,error_message FROM run_events WHERE space_id=$1 AND run_id=$2 AND event_type='action_completed' ORDER BY event_index DESC LIMIT 1`,[g.space_id,run.id])).rows[0];
 const failure=completion?.status==='failed'?completion.error_message:null;
 const blockReason=failure?(/Source connection not found|Source channel not found/.test(failure)?'plan_source_unavailable':/endpoint_url/.test(failure)?'source_setup_incomplete':'tool_failed'):null;
 const proposals=await db.query<{n:number}>(`SELECT count(*)::int n FROM proposals WHERE space_id=$1 AND created_by_run_id=$2 AND status='pending'`,[g.space_id,run.id]);
 const hasPlan=Boolean((await db.query('SELECT 1 FROM source_goal_versions WHERE goal_id=$1 AND space_id=$2 AND created_by_run_id=$3 LIMIT 1',[g.id,g.space_id,run.id])).rows[0]);
 const phase=run.status==='queued'?'queued':['running','waiting_for_dependency','cancelling'].includes(run.status)?'working':run.status==='waiting_for_review'?'waiting_for_approval':run.status==='cancelled'?'cancelled':['failed','orphaned'].includes(run.status)?'failed':hasPlan?'plan_ready':proposals.rows[0].n?'waiting_for_approval':'needs_information';
 const lastAction=events.rows[0]?.action_id;
 return {run_id:run.id,status:run.status,phase,last_action:lastAction&&lastAction.startsWith('source.')?lastAction:null,pending_approvals:proposals.rows[0].n,block_reason:blockReason,failure_reason:run.time_limit?'time_limit':phase==='failed'?'run_failed':null,updated_at:new Date(run.ended_at??events.rows[0]?.created_at??run.created_at).toISOString()};
}
export function goalWithProgress(g:GoalRow,execution:SourceGoalExecutionProgress|null){return {...g,status:g.status==='exploring'&&execution&&['failed','cancelled','needs_information','waiting_for_approval'].includes(execution.phase)?'needs_information':g.status,execution};}
