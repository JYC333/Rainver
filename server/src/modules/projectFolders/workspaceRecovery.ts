import type {Queryable} from '../routeUtils/common.js';
import type {RunRecord} from '../runs/runRepositoryTypes.js';
import {readVisibleWorkspaceChanges,workspaceChangesForConversation,type VisibleWorkspaceChangePage} from './workspaceReadModel.js';

/** Metadata only, through the same visibility/ownership reader as the UI. */
export async function workspaceIntegrationRecoveryHints(db:Queryable,run:Pick<RunRecord,'id'|'space_id'>,userId:string,workspaceId:string){
 try{
 if(!(await db.query("SELECT 1 FROM execution_workspace_runs WHERE run_id=$1 AND space_id=$2 AND workspace_id=$3 AND access_mode='write'",[run.id,run.space_id,workspaceId])).rowCount)return [];
 // Candidate scope and visibility in the same query, then page: hidden or
 // unmanageable batches never use up the hint cap, and later visible
 // failures are still reached. Newest first, at most five hints.
 const hints=[];let cursor:string|null=null;
 do{
  const page:VisibleWorkspaceChangePage=await readVisibleWorkspaceChanges(db,run.space_id,userId,{cursor,limit:100,
   where:`c.workspace_id=$2 AND w.owner_kind='conversation' AND w.state NOT IN ('blocked','retired') AND c.state='blocked'
    AND m.space_id=c.space_id AND m.status IN ('failed','conflict','verification_failed')
    AND EXISTS(SELECT 1 FROM runs current WHERE current.id=$3 AND current.space_id=c.space_id AND current.session_id=w.session_id AND current.project_id=w.project_id)`,
   params:[workspaceId,run.id]});
  cursor=page.next_cursor;
  for(const c of page.entries.map(entry=>entry.change)){
   if(!(c.workspace_id===workspaceId&&c.can_manage&&c.state==='blocked'&&c.workspace_state!=='blocked'
    &&c.integration_id&&c.integration_revision&&['failed','conflict','verification_failed'].includes(c.integration_status??'')))continue;
   hints.push({integration_id:c.integration_id,expected_revision:c.integration_revision,change_set_id:c.change_set_id,
    base_commit:c.base_commit,source_commit:c.source_commit,target_ref:c.target_ref,change_revision:c.revision,can_request_repair:c.integration_status==='conflict'&&Array.isArray(c.integration_detail?.conflicted_files)&&c.integration_detail.conflicted_files.length>0});
   if(hints.length===5)return hints;
  }
 }while(cursor);
 return hints;
 }catch{
  // Advisory recovery metadata must not prevent an otherwise authorized turn.
  // Withhold all hints on read/visibility failures; never fall back to raw rows.
  console.warn(`[workspaces] integration recovery hints unavailable for Run ${run.id}`);
  return [];
 }
}

/** Retained generations can be withdrawn without granting publication reach.
 * Carry only authorized identities/status, never old instructions or summaries. */
export async function workspaceClosureRecoveryHints(db:Queryable,run:Pick<RunRecord,'id'|'space_id'>,userId:string,workspaceId:string){
 try{
  const current=(await db.query<{workspace_location_id:string;change_set_id:string;session_id:string;project_id:string}>(`SELECT w.workspace_location_id,b.change_set_id,w.session_id,w.project_id
   FROM execution_workspace_runs b JOIN execution_workspaces w ON w.id=b.workspace_id AND w.space_id=b.space_id
   JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id AND r.session_id=w.session_id AND r.project_id=w.project_id
   WHERE b.run_id=$1 AND b.space_id=$2 AND w.id=$3 AND b.access_mode='write' AND w.owner_kind='conversation'`,[run.id,run.space_id,workspaceId])).rows[0];
  if(!current)return [];
  // Retained batches of this conversation's earlier turns and generations,
  // never delegated children: withdrawal reach stays with the conversation.
  // Page through the narrowed scope: hidden rows never use up the window, and
  // a long history of other retained batches cannot hide the eligible ones.
  const hints=[];let cursor:string|null=null;
  do{
   const page=await workspaceChangesForConversation(db,{spaceId:run.space_id,sessionId:current.session_id,projectId:current.project_id},userId,{cursor,limit:100,
    scope:{where:"w.parent_workspace_id IS NULL AND c.state='blocked' AND w.workspace_location_id=$4 AND c.id<>$5",params:[current.workspace_location_id,current.change_set_id]}});
   cursor=page.next_cursor;
  for(const c of page.entries.map(entry=>entry.change)){
   if(c.parent_workspace_id!==null||c.change_set_id===current.change_set_id||c.workspace_location_id!==current.workspace_location_id||!c.can_manage||c.state!=='blocked')continue;
   const recovery=c.integration_detail?.checkpoint_recovery as {state?:string}|undefined;
   const active=(await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
    WHERE b.change_set_id=$1 AND (r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency')
     OR (b.checkpoint_state NOT IN ('saved','blocked') AND $2::boolean=false)) LIMIT 1`,[c.change_set_id,recovery?.state==='exhausted'])).rowCount;
   if(active)continue;
   hints.push({change_set_id:c.change_set_id,expected_revision:c.revision,has_saved_result:c.source_commit!==null,checkpoint_recovery_exhausted:recovery?.state==='exhausted'});
   if(hints.length===5)return hints;
  }
  }while(cursor);
  return hints;
 }catch{console.warn(`[workspaces] retained closure hints unavailable for Run ${run.id}`);return [];}
}
