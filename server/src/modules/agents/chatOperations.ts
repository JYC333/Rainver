import {AGENT_CHAT_OPERATION_SCHEMAS,type MessageOut,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationError,hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {PgSessionRepository} from '../sessions/repository.js';
import {ConversationBackendError,PgConversationBackendRepository,type ResolvedConversationBackend} from '../sessions/conversationBackendRepository.js';
import {ConversationTurnInProgressError,PgConversationRuntimeSessionRepository} from '../sessions/conversationRuntimeSessionRepository.js';
import {ConversationSessionConfigError,reconcileSavedSessionConfig,resolveSessionConfig,sessionConfigRunOverride,type ResolvedSessionConfig} from '../sessions/sessionConfig.js';
import {ConversationInputCapabilityError,assertConversationInputCapabilities,assertConversationInputResourceTools} from '../sessions/conversationInputCapabilities.js';
import {ConversationInputError,ConversationInputService} from '../sessions/conversationInputService.js';
import {PgConversationExecutionContextRepository} from '../sessions/executionContextRepository.js';
import {assertSelectedSkillBindings,assertSelectedSkillsForRecipients} from '../skills/selectedSkills.js';
import {PgRunRepository,RunCreateValidationError} from '../runs/repository.js';
import type {RunGitSnapshot} from '../runs/contractSnapshot.js';
import {PgHostThreadRepository} from '../hosts/threadRepository.js';
import {directRestoreIdentity,newDirectRestoreIdentity,type DirectRestoreIdentity} from '../hosts/managedWorkspaceOperations.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {isLocalCliRuntimeAdapter} from '../runtimeAdapters/index.js';
import {prepareHostConversationDispatch} from '../agentGroups/service.js';
import {AgentGroupRefusal,HostDispatchRefusal} from '../agentGroups/hostDispatchErrors.js';
import {conversationToolGrantInput} from '../systemActions/scenarioToolAllowance.js';
import {PgAgentChatRepository} from './repository.js';

type Id=keyof typeof AGENT_CHAT_OPERATION_SCHEMAS;
type PreparedHostConversationDispatch=NonNullable<Awaited<ReturnType<typeof prepareHostConversationDispatch>>>;
type SendInput={agent_id:string;message:string;input_parts:never[];session_id?:string|null;project_id?:string|null;restore_workspace:boolean;backend?:{runtime_profile_id:string};session_config?:never[]};
type RetryInput={agent_id:string;run_id:string};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});

/** A deterministic refusal of this turn; status decides conflict versus invalid input. */
export class ChatTurnError extends Error {
 constructor(readonly statusCode:400|404|409|422|500,message:string){super(message);this.name='ChatTurnError';}
}

/**
 * The Run of one direct chat turn. Turn admission persists only canonical
 * user input and routing metadata; Runtime Context acquisition happens once
 * later in Run orchestration. A requested managed-workspace restore is frozen
 * here and performed by the Host dispatch before launch, never in this
 * transaction.
 */
async function prepareChatRun(db:Queryable,config:ServerConfig,input:{
 agentId:string;agentVersionId:string;spaceId:string;userId:string;sessionId:string;message:string;currentMessage:MessageOut;
 hasInputResources:boolean;projectId?:string|null;visibility:'private'|'space_shared';backend:ResolvedConversationBackend;
 sessionConfig:ResolvedSessionConfig;hostDispatch?:PreparedHostConversationDispatch|null;retryOfRunId?:string|null;
 restoreManagedWorkspace?:{include_workspace:boolean}|null;
 /** A retry's: the original turn's restore operation, repeated rather than asked again. */
 restoreIdentity?:DirectRestoreIdentity|null;
}):Promise<string>{
 // The restore is one Host operation from this turn on, ordered after every archive intent already committed.
 const restore=input.restoreManagedWorkspace?{...input.restoreManagedWorkspace,...(input.restoreIdentity??await newDirectRestoreIdentity(db))}:null;
 const lightweight=isLocalCliRuntimeAdapter(input.backend.runtime_key)&&!input.projectId;
 const created=await new PgRunRepository(db,config).createQueuedRun({
  execution_kind:'agent',agent_id:input.agentId,space_id:input.spaceId,user_id:input.userId,mode:'live',run_type:'agent',trigger_origin:'manual',
  runtime_profile_id:input.backend.runtime_profile_id,runtime_profile_selection_source:'explicit',session_id:input.sessionId,
  project_folder_id:input.hostDispatch?.project_folder_id??null,workspace_location_id:input.hostDispatch?.host_thread.workspace_location_id??null,
  host_task_thread_id:input.hostDispatch?.host_thread.id??null,project_id:input.projectId??null,visibility:input.visibility,
  contract_snapshot:{
   ...(input.projectId&&input.hostDispatch?.host_thread.workspace_location_id?{execution_workspace_version:1 as const}:{}),
   source:{kind:'direct',id:input.sessionId},project_id:input.projectId??null,git_snapshot:input.hostDispatch?.git_snapshot??unavailableGitSnapshot(),
  },
  // The same allowance a Room message or a delegation gets in this Project.
  ...conversationToolGrantInput({project_id:input.projectId??null,has_input_resources:input.hasInputResources}),
  prompt:input.message,
  model_override_json:{
   conversation_backend:{schema_version:'conversation_backend.v1',...publicConversationBackend(input.backend)},
   ...(lightweight?{execution_mode:'conversation_lightweight.v1'}:{}),
   ...sessionConfigRunOverride(input.sessionConfig),
   chat_turn:{
    schema_version:'chat_turn.v1',
    // What this turn was asked, apart from the assembled prompt that also carries this Agent's persona.
    assigned_task:input.message,session_id:input.sessionId,user_id:input.userId,user_message_id:input.currentMessage.id,
    agent_id:input.agentId,agent_version_id:input.agentVersionId,project_id:input.projectId??null,
    ...(input.retryOfRunId?{retry_of_run_id:input.retryOfRunId}:{}),
    ...(restore?{restore_managed_workspace:restore}:{}),
   },
   ...(input.hostDispatch?{
    workspace:input.hostDispatch.workspace,
    host_thread:{schema_version:'host_thread.v1',thread_id:input.hostDispatch.host_thread.id,
     runtime_session_id:input.hostDispatch.host_resume_attempted?input.hostDispatch.host_thread.vendor_session_id:null,fresh:input.hostDispatch.host_prompt_fresh},
   }:{}),
  },
 });
 return created.id;
}

function unavailableGitSnapshot():RunGitSnapshot{
 return {source:'unavailable',workspace_location_id:null,branch:null,commit_sha:null,dirty:null,execution_ready:false,observed_at:new Date().toISOString()};
}
export function publicConversationBackend(backend:ResolvedConversationBackend):{runtime_profile_id:string;runtime_key:string}{
 return {runtime_profile_id:backend.runtime_profile_id,runtime_key:backend.runtime_key};
}

async function ensureDirectHostGitContext(db:Queryable,input:{spaceId:string;userId:string;session:{id:string;space_id:string;project_id:string|null;room_id:string|null;project_folder_id:string|null};backend:ResolvedConversationBackend;hostDispatch:PreparedHostConversationDispatch}){
 const repository=new PgConversationExecutionContextRepository(db as never);
 const context=await repository.lockDraft(input.session);
 const primaryMode=input.backend.workspace_mode==='location'?'location':'managed';
 const locationId=input.hostDispatch.host_thread.workspace_location_id;
 const projectFolderId=input.hostDispatch.project_folder_id;
 if(context.state==='initialized'){
  if(context.execution_host_id!==input.hostDispatch.host_thread.execution_host_id||context.primary_workspace_mode!==primaryMode
   ||context.primary_project_folder_id!==projectFolderId||context.primary_workspace_location_id!==locationId)
   throw new ChatTurnError(409,'The direct conversation execution context is pinned to a different Host workspace');
  return;
 }
 await repository.initialize({spaceId:input.spaceId,sessionId:input.session.id,hostId:input.hostDispatch.host_thread.execution_host_id!,primaryMode,projectFolderId,locationId,userId:input.userId,
  git:{branch:input.hostDispatch.git_snapshot.branch,commitSha:input.hostDispatch.git_snapshot.commit_sha,dirty:input.hostDispatch.git_snapshot.dirty,executionReady:input.hostDispatch.git_snapshot.execution_ready,observedAt:input.hostDispatch.git_snapshot.observed_at}});
}

async function enqueueTurn(db:Queryable,input:{run_id:string;space_id:string;user_id:string;agent_id:string}){
 await new PgJobQueueRepository(db).enqueue({job_type:'agent_run',space_id:input.space_id,user_id:input.user_id,agent_id:input.agent_id,payload:{run_id:input.run_id,agent_id:input.agent_id}});
}
function capabilityRefusal(error:unknown,prefix:string):never{
 if(error instanceof ConversationInputCapabilityError)throw new ChatTurnError(error.statusCode===409?409:422,`${prefix}${error.message}`);
 throw error;
}
async function lockPlacement(db:Queryable,a:OperationActor,projectId:string|null|undefined){
 if(!projectId)return;
 await assertProjectWriter(db,a.space_id,projectId,a.on_behalf_of_user_id!,{allowArchived:true});
 try{await lockActiveProjectForMutation(db,a.space_id,projectId);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'agents');throw e;}
 await assertProjectWriterForMutation(db,a.space_id,projectId,a.on_behalf_of_user_id!);
}
async function chatAgent(db:Queryable,a:OperationActor,agentId:string){
 const agent=await new PgAgentChatRepository(db).getAgentForChat(a.space_id,a.on_behalf_of_user_id!,agentId);
 if(!agent)throw hidden();
 return agent;
}

async function sendTurn(db:Queryable,config:ServerConfig,a:OperationActor,req:SendInput){
 const p=person(a),agent=await chatAgent(db,a,req.agent_id);
 if(!agent.current_version_id)throw new ChatTurnError(400,`Agent '${req.agent_id}' has no current version`);
 const sessions=new PgSessionRepository(db as never),backends=new PgConversationBackendRepository(db as never);
 const session=req.session_id
  ?await sessions.getSession(a.space_id,p.userId,req.session_id)
  :await sessions.createSession(a.space_id,p.userId,{title:`${agent.name||'Assistant'} chat`,projectId:req.project_id});
 if(!session)throw hidden();
 if((session.project_id??null)!==(req.project_id??null))throw new ChatTurnError(409,'session belongs to a different Project context');
 const backend=await backends.resolveBinding({space_id:a.space_id,user_id:p.userId,session_id:session.id,agent_id:agent.id,requested:req.backend??null});
 // A selection sent with this turn is strict; a saved or inherited one the runtime withdrew falls back with a notice.
 const sessionConfig=await resolveSessionConfig(req.session_config,async()=>backends.sessionConfig(a.space_id,session.id,agent.id),backend.session_config_options??[]);
 if(!req.session_id&&req.session_config)await backends.saveSessionConfig(a.space_id,session.id,agent.id,sessionConfig.selections);
 try{assertConversationInputCapabilities(req.input_parts,backend.prompt_capabilities);assertConversationInputResourceTools(req.input_parts,backend.runtime_key);}
 catch(error){capabilityRefusal(error,`Agent '${agent.name}' cannot accept this conversation input: `);}
 const hostDispatch=backend.execution_host_id?await prepareHostConversationDispatch({db,backend,container:{kind:'direct',user_id:p.userId},sessionId:session.id,spaceId:a.space_id,projectId:req.project_id??null,agentId:agent.id,userId:p.userId}):null;
 if(hostDispatch)await ensureDirectHostGitContext(db,{spaceId:a.space_id,userId:p.userId,session:{id:session.id,space_id:session.space_id,project_id:session.project_id??null,room_id:session.room_id??null,project_folder_id:session.project_folder_id??null},backend,hostDispatch});
 await new PgConversationRuntimeSessionRepository(db as never).claimTurn({space_id:a.space_id,session_id:session.id,user_id:p.userId});
 const inputs=new ConversationInputService(db as never,config);
 let prepared;
 if(req.input_parts.length>0){
  // Admission verifies each selected package once; preparation reuses that result.
  const verifiedSkills=await assertSelectedSkillsForRecipients(db as never,{space_id:a.space_id,project_id:session.project_id??null,user_id:p.userId,session_id:session.id},[agent.id],req.input_parts);
  prepared=await inputs.prepareMessageParts({spaceId:a.space_id,userId:p.userId,sessionId:session.id,parts:req.input_parts,verifiedSkills});
 }
 const userMessage=await sessions.addMessage(a.space_id,p.userId,session.id,{role:'user',content:req.message});
 if(!userMessage)throw hidden();
 if(prepared)await inputs.attachMessageParts({spaceId:a.space_id,userId:p.userId,sessionId:session.id,messageId:userMessage.id,parts:prepared});
 const runId=await prepareChatRun(db,config,{agentId:agent.id,agentVersionId:agent.current_version_id,spaceId:a.space_id,userId:p.userId,sessionId:session.id,message:req.message,currentMessage:userMessage,
  hasInputResources:prepared?.some(part=>part.kind==='input_resource')===true,projectId:req.project_id,visibility:req.project_id?'space_shared':'private',backend,sessionConfig,hostDispatch,
  // Only a managed container had a cwd to archive, which is the same condition its archive used.
  restoreManagedWorkspace:req.restore_workspace&&hostDispatch?{include_workspace:hostDispatch.workspace.kind==='managed'}:null});
 if(!await sessions.attachRunToUserMessage({space_id:a.space_id,user_id:p.userId,session_id:session.id,message_id:userMessage.id,run_id:runId}))throw new ChatTurnError(500,'The chat turn could not retain its Run recovery reference');
 if(hostDispatch)await new PgHostThreadRepository(db).recordDirectDispatch(hostDispatch.host_thread.id,{lastRunId:runId,sessionId:session.id,dispatchLockId:hostDispatch.dispatch_lock_id});
 await enqueueTurn(db,{run_id:runId,space_id:a.space_id,user_id:p.userId,agent_id:agent.id});
 return {schema_version:'chat_turn_accepted.v1' as const,space_id:a.space_id,session_id:session.id,run_id:runId,user_message_id:userMessage.id,status:'queued' as const,
  event_stream_url:`/api/v1/runs/${encodeURIComponent(runId)}/turn/stream`,backend:publicConversationBackend(backend)};
}

async function retryTurn(db:Queryable,config:ServerConfig,a:OperationActor,req:RetryInput){
 const p=person(a),agent=await chatAgent(db,a,req.agent_id),runs=new PgRunRepository(db,config),sessions=new PgSessionRepository(db as never);
 const original=await runs.getVisibleRun(a.space_id,p.userId,req.run_id);
 if(!original||original.agent_id!==agent.id||!original.session_id||original.run_group_id)throw hidden();
 if(original.status!=='failed'&&original.status!=='degraded')throw new ChatTurnError(409,'Only a failed conversation turn can be retried');
 const originalModel=record(original.model_override_json),originalTurn=record(originalModel?.chat_turn);
 const messageId=typeof originalTurn?.user_message_id==='string'?originalTurn.user_message_id:null;
 if(!messageId)throw new ChatTurnError(409,'The failed Run has no persisted user message to retry');
 const message=await sessions.messageById(a.space_id,p.userId,original.session_id,messageId);
 if(!message||message.role!=='user')throw new ChatTurnError(409,'The persisted input for this Run is no longer available');
 const session=await sessions.getSession(a.space_id,p.userId,original.session_id);
 if(!session||(session.project_id??null)!==(original.project_id??null))throw new ChatTurnError(409,'Retry context needs review before this turn can run again');
 const runtimeProfileId=typeof record(originalModel?.conversation_backend)?.runtime_profile_id==='string'?String(record(originalModel?.conversation_backend)!.runtime_profile_id):null;
 if(!runtimeProfileId)throw new ChatTurnError(409,'Retry context needs review: the original backend is missing');
 let backend:ResolvedConversationBackend;
 try{backend=await new PgConversationBackendRepository(db as never).resolveBinding({space_id:a.space_id,user_id:p.userId,session_id:session.id,agent_id:agent.id,requested:{runtime_profile_id:runtimeProfileId}});}
 catch(error){if(error instanceof ConversationBackendError)throw new ChatTurnError(409,`Retry context needs review: ${error.message}`);throw error;}
 // A retry replays the original turn's selections; nobody chose them again, so a withdrawn one falls back.
 const sessionConfig:ResolvedSessionConfig={...reconcileSavedSessionConfig(originalModel?.acp_session_config,backend.session_config_options??[]),source:'saved'};
 try{
  assertConversationInputCapabilities(message.input_parts??[],backend.prompt_capabilities);
  assertConversationInputResourceTools(message.input_parts??[],backend.runtime_key);
  await assertSelectedSkillBindings(db as never,{space_id:a.space_id,project_id:session.project_id??null,agent_id:agent.id,user_id:p.userId,session_id:session.id},message.input_parts??[]);
 }catch(error){capabilityRefusal(error,'Retry context needs review: ');}
 const hostDispatch=backend.execution_host_id?await prepareHostConversationDispatch({db,backend,container:{kind:'direct',user_id:p.userId},sessionId:session.id,spaceId:a.space_id,projectId:session.project_id??null,agentId:agent.id,userId:p.userId}):null;
 if((original.workspace_location_id??null)!==(hostDispatch?.host_thread.workspace_location_id??null)
  ||(original.host_task_thread_id??null)!==(hostDispatch?.host_thread.id??null)
  ||(original.project_folder_id??null)!==(hostDispatch?.project_folder_id??null))
  throw new ChatTurnError(409,'Retry context needs review: the original Host workspace is no longer pinned');
 await new PgConversationRuntimeSessionRepository(db as never).claimTurn({space_id:a.space_id,session_id:session.id,user_id:p.userId});
 const restore=record(originalTurn?.restore_managed_workspace);
 const runId=await prepareChatRun(db,config,{agentId:agent.id,agentVersionId:original.agent_version_id,spaceId:a.space_id,userId:p.userId,sessionId:session.id,message:message.content,currentMessage:message,
  hasInputResources:message.input_parts?.some(part=>part.kind==='input_resource')===true,projectId:session.project_id,visibility:'private',backend,sessionConfig,hostDispatch,retryOfRunId:original.id,
  // A failed turn that asked for its workspace back keeps asking, as the same Host operation.
  restoreManagedWorkspace:restore&&hostDispatch?{include_workspace:restore.include_workspace===true}:null,restoreIdentity:directRestoreIdentity(restore)});
 if(!await sessions.appendRetryRunToUserMessage({space_id:a.space_id,user_id:p.userId,session_id:session.id,message_id:message.id,run_id:runId}))throw new ChatTurnError(500,'The retry could not retain its linked user message');
 if(hostDispatch)await new PgHostThreadRepository(db).recordDirectDispatch(hostDispatch.host_thread.id,{lastRunId:runId,sessionId:session.id,dispatchLockId:hostDispatch.dispatch_lock_id});
 await enqueueTurn(db,{run_id:runId,space_id:a.space_id,user_id:p.userId,agent_id:agent.id});
 return {schema_version:'conversation_retry.v1' as const,space_id:a.space_id,session_id:session.id,run_id:runId,run_ids:[runId],retry_of_run_id:original.id,user_message_id:message.id,status:'queued' as const,
  event_stream_url:`/api/v1/runs/${encodeURIComponent(runId)}/turn/stream`};
}
function record(value:unknown):Record<string,unknown>|null{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}

/** Direct-conversation turn and retry commands. Host and provider work stay in the Run's Job. */
export function agentChatRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (Object.keys(AGENT_CHAT_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  successStatus:202,
  ...(id==='agent.chat.send'?{userContentCreation:true as const}:{}),
  async resolve(db,raw,a){
   if(id==='agent.chat.send'){const i=raw as SendInput;
    // The conversation is the audience; a first turn is scoped to the person's direct thread with the Agent.
    return {authority:i.session_id?`session:${i.session_id}`:`agent:${i.agent_id}:direct:${a.on_behalf_of_user_id}`,targets:{agent_id:i.agent_id,session_id:i.session_id??null,project_id:i.project_id??null},resourceType:'agent',resourceId:i.agent_id};
   }
   const i=raw as RetryInput,run=(await db.query<{session_id:string|null}>('SELECT session_id FROM runs WHERE id=$1 AND space_id=$2',[i.run_id,a.space_id])).rows[0];
   if(!run?.session_id)throw hidden();
   return {authority:`session:${run.session_id}`,targets:{agent_id:i.agent_id,run_id:i.run_id,session_id:run.session_id},resourceType:'run',resourceId:i.run_id};
  },
  async authorize(db,raw,a,scope){
   await chatAgent(db,a,(raw as {agent_id:string}).agent_id);
   if(id==='agent.chat.send')await lockPlacement(db,a,(raw as SendInput).project_id);
   const session=(scope.targets as {session_id:string|null}).session_id;
   if(session){
    // Serialize with this conversation's other turns, resets and deletion before checking it is still the person's.
    await new PgConversationRuntimeSessionRepository(db as never).lockConversation(a.space_id,session);
    if(!await new PgSessionRepository(db as never).getSession(a.space_id,a.on_behalf_of_user_id!,session))throw hidden();
   }
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;session_id:string;run_id:string};
   if(out.space_id!==a.space_id)throw hidden();
   if(!await new PgSessionRepository(db as never).getSession(a.space_id,a.on_behalf_of_user_id!,out.session_id))throw hidden();
   if(!await new PgRunRepository(db,config).getVisibleRun(a.space_id,a.on_behalf_of_user_id!,out.run_id))throw hidden();
  },
  execute:(db,raw,a)=>id==='agent.chat.send'?sendTurn(db,config,a,raw as SendInput):retryTurn(db,config,a,raw as RetryInput),
  classifyError(e){
   if(e instanceof ChatTurnError||e instanceof HostDispatchRefusal||e instanceof AgentGroupRefusal||e instanceof ConversationBackendError||e instanceof ConversationTurnInProgressError||e instanceof RunCreateValidationError||e instanceof ConversationInputError||e instanceof ConversationSessionConfigError)
    return markedRefusal(e as Error&{statusCode:number},'agents');
   return undefined;
  },
 }));
}
