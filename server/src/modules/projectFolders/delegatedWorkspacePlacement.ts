import type {Queryable} from '../routeUtils/common.js';
import type {RunRecord} from '../runs/runRepositoryTypes.js';
import type {ExecutionWorkspaceRow} from './executionWorkspaces.js';
import {workspaceCheckpointRunSettledSql} from './workspacePolicy.js';

/**
 * Where a delegated child of a version-1 (isolated) conversation runs
 * (ADR 0029, "Delegated workspace placement").
 *
 * - `shared`: a serial writer continues in its coordinator's conversation
 *   workspace and current batch. Mutual exclusion is the Host's exclusive
 *   worktree lease plus the server checks below; the coordinator alone
 *   publishes that batch.
 * - `review`: a read-only child reads that same worktree at the coordinator's
 *   saved checkpoint, mounted read-only under a shared Host lease, with no new
 *   workspace, batch or checkpoint. Only on a personal Host that advertises
 *   `shared_review` and verified read-only namespaces.
 * - `null`: an independent fork from the parent checkpoint, as before —
 *   parallel writers, readers beside a writer, attachments, other Hosts and
 *   any workspace that is not provably idle and healthy.
 *
 * The workspace is always the coordinator's own conversation workspace for the
 * same conversation, Location, Project and Host: a child never joins another
 * conversation's work, and keeps its own vendor session and profile container.
 */
export type DelegatedPlacement=
 |{mode:'shared';workspace:ExecutionWorkspaceRow}
 |{mode:'review';workspace:ExecutionWorkspaceRow;commit:string};

const TERMINAL=`('succeeded','failed','degraded','cancelled','orphaned')`;

export async function delegatedWorkspacePlacement(tx:Queryable,run:RunRecord,input:{locationId:string;hostId:string;
 host:{kind:string;capabilities_json:{execution_workspaces?:{shared_review?:number};workspace_read_only?:{supported?:boolean}}}}):Promise<DelegatedPlacement|null>{
 if(!run.delegation_id||!run.parent_run_id||!run.session_id||!run.project_id)return null;
 const read=(run.contract_snapshot_json as {workspace_access?:string}|null)?.workspace_access==='read';
 const parent=(await tx.query<ExecutionWorkspaceRow&{checkpoint_commit:string|null;checkpoint_state:string}>(`SELECT w.*,b.checkpoint_commit,b.checkpoint_state
   FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id AND w.space_id=b.space_id
   WHERE b.run_id=$1 AND b.space_id=$2 AND b.access_mode='write' AND w.owner_kind='conversation' AND w.session_id=$3
    AND w.workspace_location_id=$4 AND w.project_id=$5 AND w.execution_host_id=$6
   ORDER BY b.created_at DESC LIMIT 1`,[run.parent_run_id,run.space_id,run.session_id,input.locationId,run.project_id,input.hostId])).rows[0];
 if(!parent||parent.checkpoint_state!=='saved'||!parent.checkpoint_commit)return null;
 // Serialize with every other binding decision on this conversation workspace
 // (root turns take the same lock in ensureExecutionWorkspace).
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`execution-workspace:conversation:${run.session_id}:${input.locationId}`]);
 const w=(await tx.query<ExecutionWorkspaceRow&{cleanup_state:string;retention_state:string;worktree:string|null;newer:boolean}>(`SELECT w.*,COALESCE(w.retention_json->>'state','') AS retention_state,w.inventory_json->>'worktree' AS worktree,
   EXISTS(SELECT 1 FROM execution_workspaces n WHERE n.space_id=w.space_id AND n.owner_kind='conversation' AND n.session_id=w.session_id AND n.workspace_location_id=w.workspace_location_id AND n.generation>w.generation) AS newer
   FROM execution_workspaces w WHERE w.id=$1 AND w.space_id=$2 FOR UPDATE`,[parent.id,run.space_id])).rows[0];
 if(!w||w.state!=='ready'||w.newer||w.generation!==parent.generation)return null;
 // A released, reclaiming, blocked or missing tree is not reused: the child forks.
 if(['reclaimed','reclaiming','blocked','missing'].includes(w.retention_state)||w.worktree==='false'||w.cleanup_state==='running')return null;
 // Nothing moved the workspace since the coordinator saved it.
 if(w.head_commit!==parent.checkpoint_commit)return null;
 // Idle: every other bound Run settled (a parked coordinator counts) with its
 // checkpoint saved, and no batch is publishing, blocked or left mid-integration.
 const busy=(await tx.query(`SELECT 1 FROM execution_workspace_runs ob JOIN runs r ON r.id=ob.run_id AND r.space_id=ob.space_id
   WHERE ob.workspace_id=$1 AND ob.run_id<>$2 AND (NOT ${workspaceCheckpointRunSettledSql('r')} OR ob.checkpoint_state='blocked' OR (ob.checkpoint_state='pending' AND ob.start_commit IS NOT NULL))
  UNION ALL SELECT 1 FROM workspace_change_sets c WHERE c.workspace_id=$1 AND (c.state IN ('ready','integrating','blocked') OR (c.state='open' AND c.verification_json->'native_progress'->>'status' IN ('pending','prepared','conflict','target_moved')))
  UNION ALL SELECT 1 FROM task_merges m WHERE m.workspace_id=$1 AND m.status IN ('queued','rebasing','resolving','verifying','waiting_local_changes')
  LIMIT 1`,[w.id,run.id])).rowCount;
 if(busy)return null;
 // Parallel independent writers keep their own forks: any unfinished writing
 // sibling of the same coordinator Run means this child is not serial.
 const writerSibling=(await tx.query(`SELECT 1 FROM run_delegations d JOIN runs cr ON cr.id=d.child_run_id AND cr.space_id=d.space_id
   WHERE d.space_id=$1 AND d.parent_run_id=$2 AND cr.id<>$3 AND cr.status NOT IN ${TERMINAL}
    AND COALESCE(cr.contract_snapshot_json->>'workspace_access','write')<>'read' LIMIT 1`,[run.space_id,run.parent_run_id,run.id])).rowCount;
 if(writerSibling)return null;
 if(!read)return {mode:'shared',workspace:w};
 const capable=input.host.kind==='remote'&&input.host.capabilities_json?.execution_workspaces?.shared_review===1&&input.host.capabilities_json?.workspace_read_only?.supported===true;
 return capable?{mode:'review',workspace:w,commit:parent.checkpoint_commit}:null;
}

/** A delegated Run bound to its coordinator's conversation workspace: it saves
 * (checkpoint) but never prepares or publishes that shared batch. */
export async function sharedDelegatedBinding(db:Queryable,runId:string,spaceId:string,workspaceId:string):Promise<boolean>{
 return Boolean((await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id AND w.space_id=b.space_id
   JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
   WHERE b.run_id=$1 AND b.space_id=$2 AND b.workspace_id=$3 AND w.owner_kind='conversation' AND r.delegation_id IS NOT NULL LIMIT 1`,[runId,spaceId,workspaceId])).rowCount);
}

/** Whether a Run is a delegated child bound to any conversation workspace (a shared child). */
export async function sharedDelegatedRun(db:Queryable,runId:string,spaceId:string):Promise<boolean>{
 return Boolean((await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id AND w.space_id=b.space_id
   JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
   WHERE b.run_id=$1 AND b.space_id=$2 AND w.owner_kind='conversation' AND r.delegation_id IS NOT NULL LIMIT 1`,[runId,spaceId])).rowCount);
}
