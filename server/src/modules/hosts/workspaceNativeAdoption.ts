import type {Queryable} from '../routeUtils/common.js';

/** Record the exact landing already acknowledged by the controlled publisher.
 * This nominates a parent-owned checkpoint for the existing reclaim:6 Host
 * proof and durable pin; it never grants deletion from database facts alone.
 * Called in the publication transaction, and by historical reconciliation.
 */
export async function recordNativeChildAdoption(tx:Queryable,workspaceId:string):Promise<boolean>{
 const result=await tx.query(`UPDATE workspace_change_sets c SET
  verification_json=c.verification_json||jsonb_build_object(
   'adoption_proof','native_parent_landing',
   'adoption_base',c.base_commit,'adoption_source',c.source_commit,'adoption_generation',c.generation,
   'adoption_integration_id',m.id,'adoption_attempt_id',m.attempt_id,
   'adoption_published_source',m.source_commit,
   'adoption_target_ref',m.target_ref,
   'adoption_checkpoint',jsonb_build_object('workspace_id',p.id,'generation',p.generation,
    'commit',COALESCE(m.merged_commit,m.onto_commit),'base_commit',c.base_commit,'source_commit',c.source_commit,'child_generation',c.generation)),
  revision=c.revision+1,updated_at=now()
 FROM task_merges m,execution_workspaces w,execution_workspaces p
 WHERE w.id=$1 AND c.workspace_id=w.id AND c.space_id=w.space_id AND c.generation=w.generation
  AND c.state IN ('integrated','no_changes')
  AND m.change_set_id=c.id AND m.space_id=c.space_id AND m.workspace_id=w.id AND m.generation=w.generation
  AND m.status IN ('merged','no_changes') AND (m.detail_json->>'native_integration'='true' OR m.detail_json ? 'native_parent')
  AND m.base_commit=c.base_commit AND COALESCE(m.merged_commit,m.onto_commit) IS NOT NULL
  AND (m.source_commit=c.source_commit OR c.source_commit=m.task_commit AND m.task_commit=COALESCE(m.merged_commit,m.onto_commit))
  AND p.id=w.parent_workspace_id AND p.space_id=w.space_id AND p.project_id=w.project_id
  AND p.execution_host_id=w.execution_host_id AND p.workspace_location_id=w.workspace_location_id
  AND m.target_ref='refs/heads/rainver/workspace-'||p.id||'-g'||p.generation::text
  AND (p.head_commit=COALESCE(m.merged_commit,m.onto_commit) OR m.detail_json->'native_parent'=jsonb_build_object('id',p.id,'generation',p.generation))
  AND p.state='ready'
  AND COALESCE(p.retention_json->>'state','') NOT IN ('reclaimed','reclaiming')
  AND NOT (c.verification_json ? 'adoption_source')
 RETURNING c.id`,[workspaceId]);
 return Boolean(result.rowCount);
}
