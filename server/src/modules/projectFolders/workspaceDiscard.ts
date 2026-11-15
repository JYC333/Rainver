import {cleanupPublicationStatuses,type CleanupPublication} from './workspacePublicationState.js';
import {workspaceDiscardDependenciesSql} from './workspaceDiscardDependencies.js';
import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {OperationRefusal} from '../systemActions/operations/errors.js';
import {replaceableSourceCleanup,type WorkspaceCleanupResource} from '../hosts/workspaceCleanup.js';

export const discardRecovery:Record<string,string>={
 workspace_discard_already_reclaimed:'This generation is already reclaimed. No new cleanup is needed.',
 workspace_discard_source_unconfirmed:'No saved source is confirmed. Recover the terminal checkpoint through workspace.retention.update (recover); preserve unknown content and read the result before reviewing reclamation.',
 workspace_discard_source_moved:'The workspace generation or saved head changed, or has no saved source. Read and review the current source.',
 workspace_discard_safety_blocked:'Preserve the evidence and resolve this workspace safety block before reclamation.',
 workspace_discard_host_upgrade_required:'Update the execution Host to support reviewed workspace reclamation.',
 workspace_discard_cleanup_pending:'An earlier source cleanup is unconfirmed. Wait for its receipt.',
 workspace_discard_dependencies_active:'Another batch, Run, checkpoint, reader, child, integration or worker still uses this workspace. Wait for it to settle.',
 workspace_discard_landing_missing:'Publication has no recorded landing commit. Preserve its receipt and repair that evidence before reclamation.',
};
export type {CleanupPublication} from './workspacePublicationState.js';
export interface DiscardAssessment {blocker:string|null;workspace_id:string;generation:number;source_commit:string|null}
/** Batch read-only assessment; mutation calls it again under the workspace lock.
 * Consent, revision CAS and policy remain the executing operation's responsibility. */
export async function assessWorkspaceDiscards(db:Queryable,ids:string[],publications:Map<string,CleanupPublication>):Promise<Map<string,DiscardAssessment>>{
 const legacy=ids.filter(id=>publications.get(id)?.settleLegacy);
 const rows=(await db.query<{id:string;workspace_id:string;generation:number;current_generation:number;source_commit:string|null;head_commit:string|null;state:string;retention_state:string|null;cleanup_json:Record<string,WorkspaceCleanupResource>;level:number|null;dependencies:boolean}>(`SELECT c.id,c.workspace_id,c.generation,w.generation AS current_generation,c.source_commit,w.head_commit,w.state,w.retention_json->>'state' AS retention_state,w.cleanup_json,
  (h.capabilities_json->'execution_workspaces'->>'reclaim')::int AS level,
  ${workspaceDiscardDependenciesSql('w.id','c.id','c.id=ANY($2::varchar[])')} AS dependencies
  FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id JOIN hosts h ON h.id=w.execution_host_id WHERE c.id=ANY($1::varchar[])`,[ids,legacy])).rows;
 return new Map(rows.map(w=>[w.id,{workspace_id:w.workspace_id,generation:w.generation,source_commit:w.source_commit,blocker:
  w.retention_state==='reclaimed'?'workspace_discard_already_reclaimed'
  :!w.source_commit?'workspace_discard_source_unconfirmed'
  :w.generation!==w.current_generation||w.head_commit!==w.source_commit?'workspace_discard_source_moved'
  :w.state==='blocked'?'workspace_discard_safety_blocked'
  :(w.level??0)<5?'workspace_discard_host_upgrade_required'
  :!replaceableSourceCleanup(w.cleanup_json[`source-g${w.generation}`])?'workspace_discard_cleanup_pending'
  :publications.get(w.id)?.landingMissing?'workspace_discard_landing_missing'
  :w.dependencies?'workspace_discard_dependencies_active':null}]));
}

/** Caller holds workspace/batch locks and passed the ordinary close authorizer. */
export async function admitWorkspaceDiscard(db:Queryable,c:{id:string;workspace_id:string;generation:number},source:string,actor:OperationActor){
 const publications=await cleanupPublicationStatuses(db,[c.id]);
 const assessment=(await assessWorkspaceDiscards(db,[c.id],publications)).get(c.id);
 const blocker=!assessment||assessment.workspace_id!==c.workspace_id||assessment.generation!==c.generation||assessment.source_commit!==source?(assessment?.source_commit===null?'workspace_discard_source_unconfirmed':'workspace_discard_source_moved'):assessment.blocker;
 if(blocker)throw new OperationRefusal(409,'workspaces',discardRecovery[blocker]!,{code:blocker,recovery_action:'workspace.change.get'});
 return {generation:c.generation,source_commit:source,change_set_id:c.id,user_id:actor.on_behalf_of_user_id,run_id:actor.run_id,requested_at:new Date().toISOString()};
}
