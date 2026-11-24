import type {Queryable} from '../routeUtils/common.js';

/** Publication facts survive a later request to release their source. */
export function publishedWorkspaceState(state:string){return state==='integrated'||state==='no_changes';}
export function closedWorkspaceState(state:string){return state==='abandoned'||publishedWorkspaceState(state);}

export interface CleanupPublication {status:string|null;settleLegacy:boolean;landingMissing:boolean}

/** A legacy private checkpoint could leave an already completed no-change merge
 * in verifying. A label alone is never evidence: require the matching durable
 * native receipt, completed merge, exact generation/source and no outstanding
 * worker or native Host request. Other active integration states never qualify.
 * Used read-only by projections and again under the mutation's workspace lock.
 */
export async function cleanupPublicationStatuses(db:Queryable,changeIds:string[]):Promise<Map<string,CleanupPublication>>{
 const rows=(await db.query<{id:string;status:string|null;settled:boolean;landing_missing:boolean}>(`SELECT c.id, m.id IS NOT NULL AND m.status IN ('merged','no_changes','verifying') AND COALESCE(m.merged_commit,m.onto_commit) IS NULL AND NOT ${emptyWorkspacePublicationSql('m')} AS landing_missing, CASE WHEN c.verification_json->'native_progress'->>'status'='pending' THEN 'verifying' ELSE m.status END AS status,COALESCE(
  c.state='no_changes' AND m.status='verifying' AND m.completed_at IS NOT NULL
  AND m.generation=c.generation AND m.source_commit=c.source_commit
  AND c.verification_json->'native_progress'->>'status'='no_changes'
  AND m.detail_json->'native_progress'->>'status'='no_changes'
  AND c.verification_json->'native_progress'->>'commit'=c.source_commit
  AND m.detail_json->'native_progress'->>'commit'=c.source_commit
  AND c.verification_json->'native_progress'->>'request_id'=m.detail_json->'native_progress'->>'request_id'
  AND COALESCE(c.verification_json->'native_request'->>'id',c.verification_json->'native_progress'->>'request_id')=c.verification_json->'native_progress'->>'request_id'
  AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.space_id=c.space_id AND j.status IN ('pending','claimed','running')
   AND ((j.job_type='task_merge' AND j.payload_json->>'merge_id'=m.id)
    OR (j.job_type='execution_workspace_native_integrate' AND j.payload_json->>'change_set_id'=c.id)))
  AND NOT ${nativeWorkspaceBusySql('c')}
 ,false) AS settled FROM workspace_change_sets c LEFT JOIN task_merges m ON m.change_set_id=c.id AND m.space_id=c.space_id WHERE c.id=ANY($1::varchar[])`,[changeIds])).rows;
 return new Map(rows.map(row=>[row.id,{status:row.settled?'no_changes':row.status,settleLegacy:row.settled,landingMissing:row.landing_missing}]));
}

/** Same durable native request lock used by processNativeWorkspaceRequest. */
export function nativeWorkspaceBusySql(alias:string){
 return `EXISTS(SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND l.classid=((hashtextextended('workspace-native:'||${alias}.id,0)>>32)&4294967295)::oid
   AND l.objid=(hashtextextended('workspace-native:'||${alias}.id,0)&4294967295)::oid AND l.objsubid=1 AND l.granted)`;
}

export async function cleanupPublicationStatus(db:Queryable,changeId:string){
 return (await cleanupPublicationStatuses(db,[changeId])).get(changeId)??{status:null,settleLegacy:false,landingMissing:false};
}

/** Record the narrowly proven legacy settlement without changing its completion time. */
export async function settleLegacyCleanupPublication(db:Queryable,changeId:string){
 const publication=await cleanupPublicationStatus(db,changeId);
 if(publication.settleLegacy)await db.query(`UPDATE task_merges SET status='no_changes',revision=revision+1,
  detail_json=detail_json||jsonb_build_object('cleanup_settlement',jsonb_build_object('source','matching_native_no_changes_receipt','request_id',detail_json->'native_progress'->>'request_id')),
  updated_at=now() WHERE change_set_id=$1 AND status='verifying'`,[changeId]);
 return publication;
}

/** An exact zero-delta completed batch needs no target landing. A status label,
 * a rewritten nonempty source or an outstanding native request is not proof. */
export function emptyWorkspacePublicationSql(merge:string){
 return `(${merge}.status='no_changes' AND ${merge}.completed_at IS NOT NULL
  AND ${merge}.base_commit IS NOT NULL AND ${merge}.source_commit=${merge}.base_commit
  AND COALESCE(${merge}.detail_json->'native_progress'->>'status','')<>'pending'
  AND EXISTS(SELECT 1 FROM workspace_change_sets empty_change
   WHERE empty_change.id=${merge}.change_set_id AND empty_change.space_id=${merge}.space_id
    AND empty_change.workspace_id=${merge}.workspace_id AND empty_change.generation=${merge}.generation
    AND empty_change.state='no_changes' AND empty_change.base_commit=${merge}.base_commit AND empty_change.source_commit=${merge}.source_commit
    AND COALESCE(empty_change.verification_json->'native_progress'->>'status','')<>'pending'
    AND NOT ${nativeWorkspaceBusySql('empty_change')})
  AND NOT EXISTS(SELECT 1 FROM jobs empty_job WHERE empty_job.space_id=${merge}.space_id AND empty_job.status IN ('pending','claimed','running')
   AND (empty_job.job_type='task_merge' AND empty_job.payload_json->>'merge_id'=${merge}.id
    OR empty_job.job_type='execution_workspace_native_integrate' AND empty_job.payload_json->>'change_set_id'=${merge}.change_set_id)))`;
}
