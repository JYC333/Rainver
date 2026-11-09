import {isolatedWorkspaceContract} from '../projectFolders/executionWorkspaces.js';
import {getDbPool} from '../../db/pool.js';
import {objectValue,type Queryable} from '../routeUtils/common.js';
import type {ThreadEventDraft} from '../hosts/threadEventNormalization.js';
import type {RunAdapterResultEnvelope} from '@rainver/protocol';
import type {RemoteHostCliAdapterInput,RemoteHostCliAdapterDeps} from './remoteHostCliAdapter.js';

type WorkspaceFact={change_set_id:string;state:string;target_ref:string|null;progress:{status:string;action:string;error:string|null;commit:string|null}|null};
/** Native Git work that has no final answer yet: a request still in flight, or a
 * prepared, conflicted or moved batch the Agent left without a publish result. */
const OPEN_NATIVE_STATUSES=new Set(['pending','prepared','conflict','target_moved']);
const SETTLED_STATES=new Set(['integrated','no_changes','abandoned']);

/** Every change set this Run completed, retried or requested an operation on. */
async function workspaceFacts(db:Queryable,run:{id:string;space_id:string}):Promise<WorkspaceFact[]>{
 return (await db.query<WorkspaceFact>(`SELECT c.id AS change_set_id,c.state,w.target_ref,c.verification_json->'native_progress' AS progress FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id WHERE c.space_id=$2 AND (c.completion_basis=$1 OR c.verification_json->'native_request'->>'run_id'=$1) ORDER BY c.created_at`,[run.id,run.space_id])).rows;
}
/** Merged, no_changes, a private checkpoint and a reported failure are facts the
 * Agent already read through workspace.change.get; its own answer stands and
 * carries them. Legacy records publish after the Run through their own Job. */
export function unfinishedWorkspaceFacts(facts:WorkspaceFact[]):WorkspaceFact[]{
 return facts.filter(f=>!SETTLED_STATES.has(f.state)&&OPEN_NATIVE_STATUSES.has(f.progress?.status??''));
}

/** One native invocation. Integration tools return to that same Agent while it
 * is running; this final guard reads facts and never launches another process. */
export async function executeWorkspaceRunReply(input:RemoteHostCliAdapterInput,hostId:string,workspaceLocationId:string|null,deps:RemoteHostCliAdapterDeps,execute:(input:RemoteHostCliAdapterInput,hostId:string,workspaceLocationId:string|null,deps:RemoteHostCliAdapterDeps)=>Promise<RunAdapterResultEnvelope>):Promise<RunAdapterResultEnvelope>{
 if(!isolatedWorkspaceContract(input.run.contract_snapshot_json)||objectValue(input.run.contract_snapshot_json).workspace_integration_id||!deps.config?.databaseUrl)return execute(input,hostId,workspaceLocationId,deps);
 const held:ThreadEventDraft[]=[],sink=input.thread_event_sink;
 const result=await execute({...input,
  runtime_event_sink:event=>event.type==='assistant_message_completed'?undefined:input.runtime_event_sink?.(event),
  thread_event_sink:async drafts=>{
   const visible:ThreadEventDraft[]=[];
   for(const draft of drafts){
    if(draft.event_type==='assistant_text')held.push(draft);
    else if(!(draft.event_type==='status'&&['run_succeeded','run_failed'].includes(draft.status??''))){
     // New work makes the preceding prose progress, not a candidate final reply.
     // Late output/status updates alone do not establish that boundary.
     if(draft.event_type==='tool_activity_started'||draft.event_type==='plan_updated')visible.push(...held.splice(0));
     visible.push(draft);
    }
   }
   if(visible.length)await sink?.(visible);
  },
 },hostId,workspaceLocationId,deps);
 if(!result.success||objectValue(result.output_json).asked_user){await sink?.(held);await sink?.([{event_type:'status',status:result.success?'run_succeeded':'run_failed'}]);return result;}
 const db=deps.db??getDbPool(deps.config.databaseUrl);
 async function finish(gate:{allowed:boolean;reason?:string}):Promise<RunAdapterResultEnvelope>{
  const facts=await workspaceFacts(db,input.run),open=unfinishedWorkspaceFacts(facts)[0];
  const error=open?'integration_not_finished_in_current_session':null;
  const success=result.success&&gate.allowed&&!error;
  const chinese=/[\u3400-\u9fff]/.test(input.prompt??'');
  const answer=open?(chinese?`尚未合入 ${open.target_ref??'目标分支'}：Agent 在整合完成前结束了本轮。修改已保留，当前状态：${open.progress?.status}。`:`${open.target_ref??'Integration'}: the Agent ended before integration finished. Changes are preserved; state: ${open.progress?.status}.`):result.output_text;
  const withheld=!error&&result.success&&!gate.allowed?gate.reason??'workspace_reply_withheld':null;
  const final={...result,success,output_text:answer,error_code:error?'workspace_integration_failed':withheld??result.error_code,error_message:error??(withheld?`Workspace reply withheld: ${withheld}`:result.error_message),
   metadata_json:{...objectValue(result.metadata_json),workspace_publication_pending:false,workspace_integrations:facts},output_json:{...objectValue(result.output_json),workspace_integrations:facts}} as RunAdapterResultEnvelope;
  await input.runtime_event_sink?.({schema_version:'runtime_event.v1',type:'assistant_message_completed',occurred_at:new Date().toISOString(),call_id:null,summary:answer.slice(0,8000),metadata_json:{workspace_reply:true}});
  if(error)await sink?.([{event_type:'assistant_text',text:answer}]);else await sink?.(held);
  await sink?.([{event_type:'status',status:success?'run_succeeded':'run_failed'}]);
  return final;
 }
 if(input.workspace_reply_sink){
  const facts=await workspaceFacts(db,input.run),requested=facts.length>0;
  input.workspace_reply_sink(finish);return {...result,metadata_json:{...objectValue(result.metadata_json),workspace_publication_pending:requested,workspace_native_settled:requested&&unfinishedWorkspaceFacts(facts).length===0}};
 }
 return finish({allowed:true});
}
