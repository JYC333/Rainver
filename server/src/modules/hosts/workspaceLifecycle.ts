import {settleLegacyCleanupPublication} from '../projectFolders/workspacePublicationState.js';
import type {Queryable} from '../routeUtils/common.js';

/** Publication and resource release are separate durable facts. The integration
 * owns both; cleanup Jobs and Host journals retain their own replay identities.
 * No cleanup retry is allowed to turn a landed publication back into a merge.
 */
export async function recordWorkspaceLanding(db:Queryable,integrationId:string){
 await db.query(`UPDATE task_merges m SET detail_json=m.detail_json||jsonb_build_object('lifecycle',
  jsonb_build_object('operation_id',m.id,'phase',CASE WHEN COALESCE(m.merged_commit,m.onto_commit) IS NULL THEN 'blocked' ELSE 'awaiting_release' END,'workspace_id',m.workspace_id,
   'slot_use_id',COALESCE(m.detail_json->'slot_use_id',(SELECT c.verification_json->'slot_use_id' FROM workspace_change_sets c WHERE c.id=m.change_set_id)),'generation',m.generation,'base_commit',m.base_commit,'source_commit',m.source_commit,
   'target_ref',m.target_ref,'landed_commit',COALESCE(m.merged_commit,m.onto_commit),
   'publication_status',m.status,'cleanup_key','source-g'||m.generation::text))
  WHERE m.id=$1 AND m.status IN ('merged','no_changes') AND m.base_commit IS NOT NULL AND m.source_commit IS NOT NULL
   AND NOT(m.detail_json ? 'lifecycle')`,[integrationId]);
}

/** Called beside cleanup persistence, never sends Git commands. A completed
 * physical-only cleanup retains unique work and is not a successful release.
 * Root conversations are intentionally retained; they never await their own cwd.
 */
export async function refreshWorkspaceLifecycle(db:Queryable,workspaceId:string){
 await db.query(`UPDATE task_merges m SET detail_json=jsonb_set(m.detail_json,'{lifecycle}',
   (m.detail_json->'lifecycle')||jsonb_build_object('phase',CASE
    WHEN m.detail_json->'lifecycle'->>'landed_commit' IS NULL THEN 'blocked'
    WHEN w.parent_workspace_id IS NULL AND w.owner_kind='conversation' AND w.state='ready' AND NOT EXISTS(SELECT 1 FROM execution_workspaces n WHERE n.space_id=w.space_id AND n.session_id=w.session_id AND n.workspace_location_id=w.workspace_location_id AND n.owner_kind='conversation' AND n.generation>w.generation) AND NOT EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) res WHERE res.key NOT LIKE 'source-g%' AND COALESCE(res.value->>'kind','') NOT IN ('local_preimages','run_history','ref_pages') AND res.value->>'state'<>'cleaned') THEN 'complete'
    WHEN (w.retention_json->>'state'='reclaimed' OR w.retention_json->>'preserved_commit'=w.head_commit) AND w.cleanup_state='cleaned'
     AND NOT EXISTS(SELECT 1 FROM jsonb_each(w.cleanup_json) res WHERE (res.value->>'state'<>'cleaned' AND NOT(COALESCE(res.value->>'kind','') IN ('local_preimages','run_history') AND res.value->>'state'='pending')) OR res.value ? 'inflight')
     AND w.inventory_json->>'worktree'='false' AND w.inventory_json->>'registration'='false' AND w.inventory_json->>'branch'='false' THEN 'complete'
    WHEN w.cleanup_state='blocked' THEN 'blocked'
    WHEN EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
      WHERE b.workspace_id=w.id AND (b.checkpoint_state<>'saved' OR r.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review')))
      OR EXISTS(SELECT 1 FROM execution_workspace_reviews v JOIN runs r ON r.id=v.run_id AND r.space_id=v.space_id
       WHERE v.workspace_id=w.id AND r.status IN ('queued','running','cancelling','waiting_for_dependency','waiting_for_review')) THEN 'awaiting_release'
    ELSE 'cleanup' END,'source_retained',w.parent_workspace_id IS NULL AND w.owner_kind='conversation' AND w.state='ready' AND NOT EXISTS(SELECT 1 FROM execution_workspaces n WHERE n.space_id=w.space_id AND n.session_id=w.session_id AND n.workspace_location_id=w.workspace_location_id AND n.owner_kind='conversation' AND n.generation>w.generation),
    'cleanup_state',w.cleanup_state,'retention_state',w.retention_json->>'state'))
   FROM execution_workspaces w WHERE w.id=$1 AND m.workspace_id=w.id AND m.generation=w.generation
    AND (m.detail_json->'lifecycle'->>'slot_use_id') IS NOT DISTINCT FROM (w.retention_json->>'slot_use_id') AND m.status IN ('merged','no_changes') AND m.detail_json ? 'lifecycle' AND m.detail_json->'lifecycle'->>'phase'<>'complete'`,[workspaceId]);
}

/** Older publication facts can acquire responsibility, never a fresh merge.
 * Partial/uncertain rows are not proof. In-flight legacy Host requests retain
 * their original identity and payload; only an unsent resource may be linked.
 */
export async function backfillWorkspaceLifecycle(db:Queryable,workspaceId:string){
 const rows=(await db.query<{id:string;change_set_id:string;status:string}>(`SELECT m.id,m.change_set_id,m.status FROM task_merges m JOIN workspace_change_sets c ON c.id=m.change_set_id AND c.space_id=m.space_id
  WHERE m.workspace_id=$1 AND m.status IN ('merged','no_changes','verifying') AND c.state IN ('integrated','no_changes')
   AND m.base_commit IS NOT NULL AND m.source_commit IS NOT NULL
   AND m.generation=c.generation AND m.base_commit=c.base_commit
   AND (m.source_commit=c.source_commit OR m.task_commit=c.source_commit AND m.task_commit=m.merged_commit) AND NOT(m.detail_json ? 'lifecycle') ORDER BY m.completed_at,m.id LIMIT 32`,[workspaceId])).rows;
 let recorded=0;
 for(const row of rows){
  if(row.status==='verifying'&&!(await settleLegacyCleanupPublication(db,row.change_set_id)).settleLegacy)continue;
  await recordWorkspaceLanding(db,row.id);recorded++;
 }
 await db.query(`UPDATE execution_workspaces w SET cleanup_json=jsonb_set(w.cleanup_json,ARRAY[res.key],res.value||jsonb_build_object('owner_integration_id',m.id))
  FROM task_merges m,LATERAL (SELECT key,value FROM execution_workspaces x CROSS JOIN LATERAL jsonb_each(x.cleanup_json) WHERE x.id=$1 AND key='source-g'||x.generation::text) res
  WHERE w.id=$1 AND m.workspace_id=w.id AND m.generation=w.generation AND m.detail_json ? 'lifecycle'
   AND (m.detail_json->'lifecycle'->>'slot_use_id') IS NOT DISTINCT FROM (w.retention_json->>'slot_use_id') AND m.source_commit=res.value->>'expected_commit' AND NOT(res.value ? 'owner_integration_id') AND NOT COALESCE((res.value->>'cleanup_sent')::boolean,false)
   AND res.value->>'state'='pending'
   AND NOT EXISTS(SELECT 1 FROM task_merges newer WHERE newer.workspace_id=m.workspace_id AND newer.id<>m.id AND newer.detail_json ? 'lifecycle' AND newer.source_commit=m.source_commit)`,[workspaceId]);
 await refreshWorkspaceLifecycle(db,workspaceId);
 return recorded;
}
