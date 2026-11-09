import {canWriteProject} from '../projects/access.js';
import {WorkspaceChangeViewSchema,WorkspaceRetentionSchema,type WorkspaceChangeView,type WorkspaceRetention} from '@rainver/protocol';
import {projectAttentionRegistry,type ProjectAttentionAdapter,type ProjectAttentionItem} from '../projects/attentionRegistry.js';
import type {RunRecord} from '../runs/repository.js';
import {runBodyReadableSql} from '../runs/runBodyReadSql.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {attentionSessionReadSql} from '../sessions/attentionRead.js';

type ChangeFilter={where:string;params:unknown[];limit?:number;cursor?:string|null};
export type VisibleWorkspaceChange={change:WorkspaceChangeView;run:{id:string;status:string;agent_id:string|null}};
export type VisibleWorkspaceChangePage={entries:VisibleWorkspaceChange[];next_cursor:string|null};

/** Opaque keyset cursor. It only ever names a row the reader was shown. */
export function encodeKeyset(values:readonly string[]){return Buffer.from(JSON.stringify(values)).toString('base64url');}
export function decodeKeyset(cursor:string,size:number):string[]{
 try{
  const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
  if(Array.isArray(value)&&value.length===size&&value.every(v=>typeof v==='string'&&v.length>0&&v.length<=64))return value as string[];
 }catch{/* fall through */}
 throw new HttpError(422,'Invalid cursor');
}

/** Host ownership and the origin Run's unwithheld body, as SQL, so hidden
 * rows are dropped before LIMIT and never use up a reader's page. */
function visibleChangeSql(userExpr:string){
 return `(h.kind<>'remote' OR h.owner_user_id=${userExpr}) AND ${runBodyReadableSql('origin',userExpr)}`;
}

/** The one reader behind every workspace progress surface: exact SQL scope from
 * the caller, then Host ownership, origin Run visibility and content
 * withholding in the same query, then keyset paging. No command or writable
 * checkout path. `$1` is the Space; the caller's params follow it. */
export async function readVisibleWorkspaceChanges(db:Queryable,spaceId:string,userId:string,filter:ChangeFilter):Promise<VisibleWorkspaceChangePage>{
 const limit=Math.min(Math.max(filter.limit??50,1),100);
 const params:unknown[]=[spaceId,...filter.params,userId];
 const user=`$${params.length}`;
 let keyset='';
 if(filter.cursor){
  const [created,workspaceId,sequence,changeId]=decodeKeyset(filter.cursor,4);
  if(!/^\d{1,9}$/.test(sequence!))throw new HttpError(422,'Invalid cursor');
  params.push(created,workspaceId,Number(sequence),changeId);
  const n=params.length;
  keyset=` AND (w.created_at,w.id,c.sequence,c.id)<($${n-3}::timestamptz,$${n-2}::varchar,$${n-1}::int,$${n}::varchar)`;
 }
 const rows=(await db.query<{run_status:string;run_agent_id:string|null;page_created:string;sequence:number;[key:string]:unknown}>(`SELECT c.id AS change_set_id,c.originating_run_id,c.revision,c.state,c.summary,c.sequence,w.created_at::text AS page_created,
  origin.status AS run_status,origin.agent_id AS run_agent_id,
  w.id AS workspace_id,w.generation,w.workspace_location_id,w.parent_workspace_id,w.target_ref,c.base_commit,c.source_commit,
  w.inventory_json AS inventory,w.state AS workspace_state,w.baseline_mode,w.cleanup_state,w.cleanup_json,w.retention_json,w.project_id,m.id AS integration_id,m.revision AS integration_revision,m.status AS integration_status,m.attempt_id,
  m.onto_commit,m.task_commit AS candidate_commit,m.merged_commit,
  CASE WHEN m.resolution_run_id IS NOT NULL AND EXISTS(SELECT 1 FROM runs repair WHERE repair.id=m.resolution_run_id AND repair.space_id=c.space_id AND ${runBodyReadableSql('repair',user)})
   THEN m.resolution_run_id ELSE NULL END AS resolution_run_id,
  CASE WHEN EXISTS(SELECT 1 FROM execution_workspace_runs blocked WHERE blocked.change_set_id=c.id AND blocked.checkpoint_state='blocked')
   THEN COALESCE(m.detail_json,'{}'::jsonb)||c.verification_json||'{"checkpoint_blocked":true}'::jsonb ELSE COALESCE(m.detail_json,c.verification_json) END AS integration_detail,
  CASE WHEN c.state<>'integrated' THEN NULL WHEN w.parent_workspace_id IS NULL THEN 'target'
   WHEN EXISTS(SELECT 1 FROM workspace_change_sets adopter WHERE adopter.workspace_id=w.parent_workspace_id AND adopter.space_id=c.space_id
    AND jsonb_typeof(adopter.verification_json->'adopted_child_change_ids')='array' AND (adopter.verification_json->'adopted_child_change_ids') ? c.id) THEN 'parent'
   ELSE 'parent_unverified' END AS landing,
  COALESCE((h.capabilities_json->>'native_workspace_integration')::boolean,false) AS native_integration
  FROM workspace_change_sets c
  JOIN execution_workspaces w ON w.id=c.workspace_id AND w.space_id=c.space_id JOIN hosts h ON h.id=w.execution_host_id
  JOIN runs origin ON origin.id=c.originating_run_id AND origin.space_id=c.space_id
  LEFT JOIN task_merges m ON m.change_set_id=c.id
  WHERE c.space_id=$1 AND (${filter.where}) AND ${visibleChangeSql(user)}${keyset}
  ORDER BY w.created_at DESC,w.id DESC,c.sequence DESC,c.id DESC LIMIT ${limit+1}`,params)).rows;
 const writable=new Map<string,boolean>();
 const entries:VisibleWorkspaceChange[]=[];
 for(const row of rows.slice(0,limit)){
  const {run_status,run_agent_id,page_created:_,sequence:__,originating_run_id,cleanup_json,project_id,retention_json,...publicView}=row;
  // Attempt instructions and their history can originate in a more private Run
  // than the frozen source. Keep them in durable evidence, not shared progress.
  if(publicView.integration_detail&&typeof publicView.integration_detail==='object'){
   const {agent_repair:_,human_resolution:__,previous_detail:___,submitted_commit:____,abandon_reason:_____,verification_request:______,agent_verification_basic:_______,verification_setup_runs:________,completed_repair_runs:_________,reply_owner_run_id:__________,inline_phase_state:___________,verification_diagnostics:____________,native_request:_____________,native_submission:______________,...progress}=publicView.integration_detail as Record<string,unknown>;
   publicView.integration_detail=progress;
  }
  const project=String(project_id);
  if(!writable.has(project))writable.set(project,await canWriteProject(db,spaceId,project,userId));
  const cleanup_errors=Object.values((cleanup_json??{}) as Record<string,{error?:string}>).map(r=>r.error).filter((e):e is string=>typeof e==='string').slice(0,5);
  entries.push({change:WorkspaceChangeViewSchema.parse({...publicView,cleanup_errors,...retentionView(retention_json),can_manage:writable.get(project)}),run:{id:String(originating_run_id),status:run_status,agent_id:run_agent_id}});
 }
 const last=rows.length>limit?rows[limit-1]:undefined;
 return {entries,next_cursor:last?encodeKeyset([last.page_created,String(last.workspace_id),String(last.sequence),String(last.change_set_id)]):null};
}

/** Every page, for callers that need the complete visible set of a narrow
 * scope (one Run's bindings, explicit ids). Bounded; never silently partial. */
export async function readAllVisibleWorkspaceChanges(db:Queryable,spaceId:string,userId:string,filter:Omit<ChangeFilter,'cursor'|'limit'>):Promise<VisibleWorkspaceChange[]>{
 const all:VisibleWorkspaceChange[]=[];let cursor:string|null=null;
 for(let page=0;page<20;page+=1){
  const result:VisibleWorkspaceChangePage=await readVisibleWorkspaceChanges(db,spaceId,userId,{...filter,limit:100,cursor});
  all.push(...result.entries);cursor=result.next_cursor;
  if(!cursor)return all;
 }
 throw new Error('Workspace change scope exceeds the complete-read bound');
}

/** Exactly the batches this Run is bound to. Retained or pending work of other
 * turns in the same conversation is read through the conversation reader, so
 * one batch is not repeated under every later Run of the session. */
export async function workspaceChangesForRun(db:Queryable,run:Pick<RunRecord,'id'|'space_id'>,userId:string){
 return (await readAllVisibleWorkspaceChanges(db,run.space_id,userId,{where:'EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.run_id=$2 AND b.space_id=$1)',params:[run.id]})).map(entry=>entry.change);
}

/** Unfinished work of one conversation: its own workspace generations and the
 * delegated child workspaces forked from them. The caller authorizes the
 * conversation; each row is still filtered through its origin Run. `$2` is
 * the conversation and `$3` the Project; `scope` may narrow further. */
const CONVERSATION_PENDING=`w.project_id=$3 AND (c.state IN ('open','ready','integrating','blocked') OR w.cleanup_state='blocked') AND (
   (w.owner_kind='conversation' AND w.session_id=$2)
   OR (w.owner_kind='delegation' AND EXISTS(SELECT 1 FROM execution_workspaces parent WHERE parent.id=w.parent_workspace_id AND parent.space_id=w.space_id AND parent.owner_kind='conversation' AND parent.session_id=$2)))`;
export async function workspaceChangesForConversation(db:Queryable,input:{spaceId:string;sessionId:string;projectId:string},userId:string,page:{cursor?:string|null;limit?:number;scope?:{where:string;params:unknown[]}}={}){
 return readVisibleWorkspaceChanges(db,input.spaceId,userId,{where:page.scope?`${CONVERSATION_PENDING} AND (${page.scope.where})`:CONVERSATION_PENDING,
  params:[input.sessionId,input.projectId,...(page.scope?.params??[])],cursor:page.cursor,limit:page.limit});
}

/** Conversation pending work for a reader who can see the conversation itself. */
export async function conversationWorkspaceChangesForViewer(db:Queryable,spaceId:string,sessionId:string,userId:string,page:{cursor?:string|null;limit?:number}={}):Promise<VisibleWorkspaceChangePage|null>{
 const session=(await db.query<{project_id:string|null}>(`SELECT s.project_id FROM sessions s WHERE s.id=$1 AND s.space_id=$2 AND ${attentionSessionReadSql('s','$3')}`,[sessionId,spaceId,userId])).rows[0];
 if(!session)return null;
 if(!session.project_id)return {entries:[],next_cursor:null};
 return workspaceChangesForConversation(db,{spaceId,sessionId,projectId:session.project_id},userId,page);
}
/** Stable reason codes and times only: no ref names, paths or commit lists. */
export function retentionView(raw:unknown):{retention?:WorkspaceRetention}{
 if(!raw||typeof raw!=='object'||!('state' in raw))return {};
 const r=raw as Record<string,unknown>,text=(v:unknown)=>typeof v==='string'?v:null,count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:0;
 const parsed=WorkspaceRetentionSchema.safeParse({state:r.state,reason:typeof r.reason==='string'?r.reason.slice(0,64):'unknown',reclaim_after:text(r.reclaim_after),hold_until:text(r.hold_until),reclaimed_at:text(r.reclaimed_at),assessed_at:text(r.assessed_at),retained_refs:count(r.retained_refs),unclaimed_refs:count(r.unclaimed_refs)});
 return parsed.success?{retention:parsed.data}:{};
}
const workspaceAttentionAdapter:ProjectAttentionAdapter={
 areaKind:'workspaces',
 async listAttentionItems(db,identity,projectId){
  // Visibility is part of the query, so hidden blocked rows never fill the window.
  const rows=(await db.query<{id:string;originating_run_id:string;state:string}>(`SELECT c.id,c.originating_run_id,c.state
   FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id AND w.space_id=c.space_id
   JOIN runs origin ON origin.id=c.originating_run_id AND origin.space_id=c.space_id JOIN hosts h ON h.id=w.execution_host_id
   WHERE c.space_id=$1 AND w.project_id=$2 AND (c.state='blocked' OR w.cleanup_state='blocked') AND ${visibleChangeSql('$3')}
   ORDER BY c.updated_at DESC,c.id DESC LIMIT 100`,[identity.spaceId,projectId,identity.userId])).rows;
  return rows.map((row):ProjectAttentionItem=>{
   const href=`/runs/${row.originating_run_id}`;
   return {id:`workspace:${row.id}`,attention_class:'gate',project_id:projectId,area_kind:'workspaces',source_type:'run',source_id:row.originating_run_id,severity:'normal',title:row.state==='blocked'?'Workspace integration needs a decision':'Workspace cleanup needs attention',summary:null,reason:row.state==='blocked'?'workspace_integration_blocked':'workspace_cleanup_blocked',due_at:null,blocking_refs:[row.id],action_descriptors:[{label:'Open run',href}],href};
  });
 },
};
export function registerWorkspaceAttention(){projectAttentionRegistry.replace(workspaceAttentionAdapter);}
