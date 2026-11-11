import {AGENT_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {isSpaceOwnerOrAdmin} from '../access/roles.js';
import {PgRunRepository,RunCreateValidationError} from '../runs/repository.js';
import {RunBudgetExceededError,RunBudgetSourceReferenceError} from '../runs/budgetEnforcement.js';
import {assertPersonStartedRunRequest,PERSON_STARTED_TRIGGER_ORIGIN} from '../runs/runRepositoryHelpers.js';
import {PgSessionRepository} from '../sessions/repository.js';
import {PgConversationBackendRepository,ConversationBackendError} from '../sessions/conversationBackendRepository.js';
import {PgConversationRuntimeSessionRepository} from '../sessions/conversationRuntimeSessionRepository.js';
import {ConversationSessionConfigError,validateSessionConfig} from '../sessions/sessionConfig.js';
import {saveConversationModelSwitch} from '../sessions/conversationQuotaPolicy.js';
import {PgHostThreadRepository} from '../hosts/threadRepository.js';
import {PgAgentChatRepository,PgAgentRepository} from './repository.js';
import {AgentMutationError} from './agentMutationError.js';
import {canChangeAgent} from './agentAccess.js';
import {applyAgentIdentityPatch,configPatch,hasConfigPatch,optionalArrayBody,optionalRecordBody,parseExecutionConstraints} from './agentRouteInputs.js';
import {instantiateAgentTemplate} from '../agentTemplates/instantiate.js';

type Id=keyof typeof AGENT_OPERATION_SCHEMAS;
type Input=Record<string,unknown>&{agent_id?:string;project_id?:string|null;profile_id?:string;version_id?:string;session_id?:string;template_id?:string};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const CREATED=new Set<Id>(['agent.create','agent.template.instantiate','agent.runtime_profile.create','agent.run.create']);
/** Personal/Project placement is the access owner's, as for the retained REST adapters. */
const PLACEMENT=new Set<Id>(['agent.create','agent.template.instantiate','agent.run.create']);
const DEFINITION_FIELDS=['name','description','role_instruction','status'];

class ResetContextConflict extends OperationBusinessError {constructor(){super('operation_conflict',409,'agents');}}

async function lockProjectPlacement(db:Queryable,a:OperationActor,projectId:string|null|undefined){
 if(!projectId)return;
 await assertProjectWriter(db,a.space_id,projectId,a.on_behalf_of_user_id!,{allowArchived:true});
 try{await lockActiveProjectForMutation(db,a.space_id,projectId);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'agents');throw e;}
 await assertProjectWriterForMutation(db,a.space_id,projectId,a.on_behalf_of_user_id!);
}
/** Agent row first, then the caller's change authority under that lock. */
async function lockAgent(db:Queryable,a:OperationActor,agentId:string){
 const row=(await db.query<{id:string;agent_kind:string;project_id:string|null;status:string}>('SELECT id,agent_kind,project_id,status FROM agents WHERE space_id=$1 AND id=$2 FOR UPDATE',[a.space_id,agentId])).rows[0];
 if(!row)throw hidden();
 return row;
}
async function assertVisibleAgent(db:Queryable,a:OperationActor,agentId:string){
 if(!await new PgAgentRepository(db).getVisible(a.space_id,a.on_behalf_of_user_id!,agentId))throw hidden();
}

/** Human Agent definition, Runtime Profile and direct-conversation commands over the existing Agent writers. */
export function agentOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (Object.keys(AGENT_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  successStatus:CREATED.has(id)?201:200,
  ...(PLACEMENT.has(id)?{userContentCreation:true as const}:{}),
  async resolve(_db,raw,a){const i=raw as Input;
   switch(id){
    case 'agent.create':case 'agent.template.instantiate':return {authority:`space:${a.space_id}`,targets:{project_id:i.project_id??null,template_id:i.template_id??null},resourceType:'agent',resourceId:null};
    case 'agent.runtime_default.set':return {authority:`space:${a.space_id}`,targets:{space_id:a.space_id},resourceType:'space',resourceId:a.space_id};
    case 'agent.assistant_settings.update':return {authority:`space:${a.space_id}`,targets:{project_id:i.project_id??null},resourceType:i.project_id?'project':'space',resourceId:i.project_id??a.space_id};
    default:return {authority:`agent:${i.agent_id}`,targets:{agent_id:i.agent_id,profile_id:i.profile_id??null,version_id:i.version_id??null,session_id:i.session_id??null,...(id==='agent.run.create'?{project_id:i.project_id??null}:{})},resourceType:'agent',resourceId:i.agent_id!};
   }
  },
  async authorize(db,raw,a){const i=raw as Input,p=person(a),repo=new PgAgentRepository(db);
   switch(id){
    case 'agent.create':case 'agent.template.instantiate':await lockProjectPlacement(db,a,i.project_id);return;
    case 'agent.runtime_default.set':{
     const role=(await db.query<{role:string}>("SELECT role FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[a.space_id,p.userId])).rows[0]?.role;
     if(!isSpaceOwnerOrAdmin(role))throw hidden();return;
    }
    case 'agent.assistant_settings.update':{
     const target={spaceId:a.space_id,projectId:i.project_id??null};
     if(target.projectId)await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[target.projectId,a.space_id]);
     await repo.assertAssistantSettingsReadable(p,target);
     if(!await repo.canConfigureAssistantSettings(p,target))throw hidden();return;
    }
    case 'agent.runtime_profile.create':case 'agent.runtime_profile.update':case 'agent.runtime_profile.ensure_host':
     await lockAgent(db,a,i.agent_id!);if(!await repo.canWriteRuntimeProfiles(a.space_id,p.userId,i.agent_id!))throw hidden();return;
    case 'agent.update':
     await lockAgent(db,a,i.agent_id!);await assertVisibleAgent(db,a,i.agent_id!);
     if((DEFINITION_FIELDS.some(k=>Object.hasOwn(i,k))||hasConfigPatch(i))&&!await canChangeAgent(db,p,i.agent_id!))throw hidden();return;
    case 'agent.config.update':case 'agent.version.restore':
     await lockAgent(db,a,i.agent_id!);if(!await canChangeAgent(db,p,i.agent_id!))throw hidden();return;
    case 'agent.run.create':
     await lockProjectPlacement(db,a,i.project_id);await assertVisibleAgent(db,a,i.agent_id!);return;
    case 'agent.chat.reset_context':
     if(!await new PgAgentChatRepository(db).getAgentForChat(a.space_id,p.userId,i.agent_id!))throw hidden();return;
    case 'conversation.session_config.save':{
     const session=await new PgSessionRepository(db).getConversationForBackendSelection(a.space_id,p.userId,String(i.session_id));
     if(!session)throw hidden();
     if(session.room_id){
      if(!session.project_id)throw hidden();
      await assertProjectWriterForMutation(db,a.space_id,session.project_id,p.userId);
      if(!(await db.query("SELECT 1 FROM room_agent_members WHERE space_id=$1 AND room_id=$2 AND agent_id=$3 AND status='active' FOR SHARE",[a.space_id,session.room_id,i.agent_id])).rows[0])throw hidden();
     }else if(session.agent_id&&session.agent_id!==i.agent_id)throw hidden();
     await new PgConversationRuntimeSessionRepository(db).lockConversation(a.space_id,session.id);return;
    }
   }
  },
  async authorizeResult(db,raw,a){const out=raw as {space_id:string;agent_id?:string;id:string};
   if(out.space_id!==a.space_id)throw hidden();
   if(id==='agent.runtime_default.set'||id==='agent.assistant_settings.update')return;
   if(id==='agent.runtime_profile.create'||id==='agent.runtime_profile.update'||id==='agent.runtime_profile.ensure_host'){if(!await new PgAgentRepository(db).canReadRuntimeProfiles(a.space_id,a.on_behalf_of_user_id!,out.agent_id!))throw hidden();return;}
   if(id==='agent.run.create'){if(!await new PgRunRepository(db,config).getVisibleRun(a.space_id,a.on_behalf_of_user_id!,out.id))throw hidden();return;}
   if(id==='agent.chat.reset_context'||id==='conversation.session_config.save')return;
   await assertVisibleAgent(db,a,out.agent_id!);
  },
  async execute(db,raw,a){const i={...raw as Input},p=person(a),repo=new PgAgentRepository(db),agentId=i.agent_id!;
   const receipt=(agent:{id:string})=>({id:agent.id,space_id:a.space_id,agent_id:agent.id});
   switch(id){
    case 'agent.create':{
     const constraints=parseExecutionConstraints(i.execution_constraints);
     return receipt(await repo.create({spaceId:a.space_id,projectId:i.project_id??null,userId:p.userId,
      name:requiredText(i.name,'name'),description:nullableText(i.description),visibility:i.project_id?'space_shared':'private',
      roleInstruction:nullableText(i.role_instruction),systemPrompt:nullableText(i.system_prompt),riskLevel:constraints.risk_level,maxRunTimeSeconds:constraints.max_run_time_seconds,
      contextPolicyJson:optionalRecordBody(i,'context_policy_json'),memoryPolicyJson:optionalRecordBody(i,'memory_policy_json'),capabilitiesJson:optionalArrayBody(i,'capabilities_json'),toolPermissionsJson:optionalRecordBody(i,'tool_permissions_json'),
      toolPolicyJson:optionalRecordBody(i,'tool_policy_json'),outputPolicyJson:optionalRecordBody(i,'output_policy_json'),scheduleConfigJson:optionalRecordBody(i,'schedule_config_json'),outputSchemaJson:optionalRecordBody(i,'output_schema_json')}));
    }
    case 'agent.template.instantiate':return receipt(await instantiateAgentTemplate(db,config,{spaceId:a.space_id,userId:p.userId,projectId:i.project_id??null,visibility:i.project_id?'space_shared':'private'},String(i.template_id),i));
    case 'agent.update':{
     const {agent_id:_agent,...body}=i;
     // Parse the whole body before the first write: identity and config land in two statements.
     const parsedConfig=hasConfigPatch(body)?configPatch(body,p.userId):null;
     await applyAgentIdentityPatch(repo,a.space_id,p.userId,agentId,body);
     if(parsedConfig)await repo.updateConfig(a.space_id,agentId,parsedConfig);
     return receipt({id:agentId});
    }
    case 'agent.config.update':{const {agent_id:_agent,...body}=i;await repo.updateConfig(a.space_id,agentId,configPatch(body,p.userId));return receipt({id:agentId});}
    case 'agent.version.restore':await repo.restoreVersion(a.space_id,agentId,i.version_id!,p.userId);return {...receipt({id:agentId}),version_id:i.version_id!};
    case 'agent.runtime_default.set':{
     const b=raw as {runtime_key:string;backend_mode:'runtime_native'|'model_provider';model_provider_id?:string|null;model_name?:string|null;runtime_config_json?:Record<string,unknown>|null};
     await repo.setSpaceAgentRuntimeDefault(a.space_id,{runtimeKey:b.runtime_key,backendMode:b.backend_mode,modelProviderId:b.model_provider_id,modelName:b.model_name,runtimeConfigJson:b.runtime_config_json});
     return {id:a.space_id,space_id:a.space_id};
    }
    case 'agent.assistant_settings.update':{
     const {project_id,...patch}=i,target={spaceId:a.space_id,projectId:project_id??null};
     await repo.updateAssistantSettings(target,patch,{actorUserId:p.userId});
     return {id:target.projectId??a.space_id,space_id:a.space_id,project_id:target.projectId};
    }
    case 'agent.runtime_profile.create':{
     assertNoProfileCredential(i);
     const w=i as Record<string,never>&{name:string;runtime_key:string};
     const profile=await repo.createRuntimeProfile(a.space_id,agentId,{name:w.name,runtimeKey:w.runtime_key,backendMode:i.backend_mode as never,modelProviderId:(i.model_provider_id as string|null|undefined)??null,modelName:(i.model_name as string|null|undefined)??null,
      executionHostId:(i.execution_host_id as string|null|undefined)??null,workspaceLocationId:(i.workspace_location_id as string|null|undefined)??null,workspaceMode:(i.workspace_mode as 'location'|'managed'|null|undefined)??null,runtimeInstallation:(i.runtime_installation as string|null|undefined)??null,
      runtimeConfigJson:i.runtime_config_json as Record<string,unknown>|null|undefined,runtimePolicyJson:i.runtime_policy_json as Record<string,unknown>|null|undefined,enabled:i.enabled as boolean|undefined,isDefault:i.is_default as boolean|undefined,actorUserId:p.userId});
     return {id:profile.id,space_id:a.space_id,agent_id:agentId,profile_id:profile.id};
    }
    case 'agent.runtime_profile.update':{
     assertNoProfileCredential(i);
     const profile=await repo.updateRuntimeProfile(a.space_id,agentId,i.profile_id!,{...runtimeProfilePatchFields(i),actorUserId:p.userId});
     return {id:profile.id,space_id:a.space_id,agent_id:agentId,profile_id:profile.id};
    }
    case 'agent.runtime_profile.ensure_host':{
     const profile=await repo.ensureHostRuntimeProfile({spaceId:a.space_id,agentId,actorUserId:p.userId,executionHostId:String(i.execution_host_id),workspaceLocationId:(i.workspace_location_id as string|null|undefined)??null,workspaceMode:i.workspace_mode as 'location'|'managed',runtimeKey:String(i.runtime_key),runtimeInstallation:String(i.runtime_installation)});
     return {id:profile.id,space_id:a.space_id,agent_id:agentId,profile_id:profile.id};
    }
    case 'conversation.session_config.save':{
     const b=raw as {session_id:string;runtime_profile_id:string;session_config:never[];allow_quota_model_switch?:boolean};
     const backends=new PgConversationBackendRepository(db);
     const backend=await backends.resolveBinding({space_id:a.space_id,user_id:p.userId,session_id:b.session_id,agent_id:agentId,requested:{runtime_profile_id:b.runtime_profile_id}});
     const selections=validateSessionConfig(b.session_config,backend.session_config_options??[]);
     await backends.saveSessionConfig(a.space_id,b.session_id,agentId,selections);
     if(b.allow_quota_model_switch!==undefined){
      if(b.allow_quota_model_switch&&!backend.session_config_options?.some(option=>option.category==='model'&&option.type==='select'&&option.options.length>1))throw new AgentMutationError(422,'This CLI does not advertise alternative models');
      await saveConversationModelSwitch(db,a.space_id,b.session_id,agentId,p.userId,b.runtime_profile_id,backend.runtime_key,b.allow_quota_model_switch);
     }
     return {id:b.session_id,space_id:a.space_id,agent_id:agentId,session_id:b.session_id};
    }
    case 'agent.run.create':{
     const {agent_id:_agent,...body}=i;
     assertPersonStartedRunRequest(body);
     const str=(v:unknown)=>typeof v==='string'?v:null;
     const run=await new PgRunRepository(db,config).createQueuedRunWithBudgetAdmission({execution_kind:'agent',agent_id:agentId,space_id:a.space_id,user_id:p.userId,
      mode:str(body.mode)??'live',run_type:str(body.run_type)??'agent',trigger_origin:PERSON_STARTED_TRIGGER_ORIGIN,session_id:str(body.session_id),
      project_folder_id:i.project_id?str(body.project_folder_id):null,project_id:i.project_id??null,prompt:str(body.prompt),instruction:str(body.instruction),scheduled_at:str(body.scheduled_at),
      parent_run_id:str(body.parent_run_id),runtime_profile_id:str(body.runtime_profile_id),capability_id:str(body.capability_id),capabilities_json:optionalArrayBody(body,'capabilities_json'),
      workflow_version_id:null,visibility:i.project_id?'space_shared':'private'});
     return {id:run.id,space_id:a.space_id,agent_id:agentId,run_id:run.id};
    }
    case 'agent.chat.reset_context':{
     const thread=(await db.query<{id:string;dispatch_lock_id:string|null;host_owner_user_id:string|null}>(
      `SELECT thread.id,thread.dispatch_lock_id,host.owner_user_id AS host_owner_user_id FROM host_threads thread LEFT JOIN hosts host ON host.id=thread.execution_host_id
        WHERE thread.agent_id=$1 AND thread.container_kind='direct' AND thread.container_user_id=$2 AND thread.status IN ('active','session_reset') LIMIT 1 FOR UPDATE OF thread`,[agentId,p.userId])).rows[0];
     if(!thread)throw hidden();
     if(thread.host_owner_user_id&&thread.host_owner_user_id!==p.userId)throw hidden();
     // A dispatch in flight owns the thread; the person retries once it finishes.
     if(thread.dispatch_lock_id)throw new ResetContextConflict();
     const updated=await new PgHostThreadRepository(db).resetDirectAgent(agentId,p.userId);
     if(!updated)throw hidden();
     return {id:updated.id,space_id:a.space_id,agent_id:agentId,session_reset:true as const,thread_id:updated.id,workspace_mode:updated.workspace_mode};
    }
   }
  },
  classifyError(e){
   if(e instanceof AgentMutationError||e instanceof ConversationSessionConfigError||e instanceof RunCreateValidationError||e instanceof ConversationBackendError||e instanceof RunBudgetExceededError||e instanceof RunBudgetSourceReferenceError)
    return markedRefusal(e as Error&{statusCode:number},'agents');
   return undefined;
  },
 }));
}

function requiredText(value:unknown,key:string):string{const text=nullableText(value);if(!text)throw new AgentMutationError(422,`${key} is required`);return text;}
function nullableText(value:unknown):string|null{if(value===null||value===undefined)return null;if(typeof value!=='string')throw new AgentMutationError(422,'Expected a string or null');const t=value.trim();return t||null;}
/** Package-install egress and CLI credentials are never Runtime Profile authority. */
function assertNoProfileCredential(body:Record<string,unknown>){
 const config=(body.runtime_config_json&&typeof body.runtime_config_json==='object'?body.runtime_config_json:{}) as Record<string,unknown>;
 if(Object.hasOwn(config,'egress_install'))throw new AgentMutationError(422,'Package-install egress is granted per Run by the dispatcher, not on an Agent runtime profile');
 if(Object.hasOwn(config,'credential_profile_id'))throw new AgentMutationError(422,'Rainver brokers no CLI credential: a CLI Agent names an execution host and an installation on it');
}
const PATCH_FIELDS={name:'name',runtime_key:'runtimeKey',backend_mode:'backendMode',model_provider_id:'modelProviderId',model_name:'modelName',execution_host_id:'executionHostId',workspace_location_id:'workspaceLocationId',workspace_mode:'workspaceMode',runtime_installation:'runtimeInstallation',runtime_config_json:'runtimeConfigJson',runtime_policy_json:'runtimePolicyJson',enabled:'enabled',is_default:'isDefault'} as const;
/** Only the keys the body actually carries: an absent key is not a cleared one. */
function runtimeProfilePatchFields(body:Record<string,unknown>){
 const fields:Record<string,unknown>={};
 for(const [key,field] of Object.entries(PATCH_FIELDS))if(Object.hasOwn(body,key))fields[field]=body[key];
 return fields as Partial<Parameters<PgAgentRepository['updateRuntimeProfile']>[3]>;
}
