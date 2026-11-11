import {SESSION_OPERATION_SCHEMAS,SESSION_QUERY_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal,OperationError} from '../systemActions/operations/errors.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {sendPendingManagedWorkspaceArchive} from '../hosts/managedWorkspaceOperations.js';
import {HostDispatchRefusal} from '../agentGroups/hostDispatchErrors.js';
import {PgSessionRepository} from './repository.js';
import {ConversationInputError,ConversationInputService} from './conversationInputService.js';
import {ConversationExecutionContextError,ConversationExecutionContextService} from './executionContextService.js';
import {archiveDirectSession} from './deleteSession.js';
import {PgConversationExecutionContextRepository} from './executionContextRepository.js';

type Id=keyof typeof SESSION_OPERATION_SCHEMAS|keyof typeof SESSION_QUERY_SCHEMAS;
type Input=Record<string,unknown>&{session_id?:string;project_id?:string|null};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const str=(v:unknown)=>typeof v==='string'&&v.length>0?v:null;

async function lockPlacement(db:Queryable,a:OperationActor,projectId:string|null|undefined){
 if(!projectId)return;
 await assertProjectWriter(db,a.space_id,projectId,a.on_behalf_of_user_id!,{allowArchived:true});
 try{await lockActiveProjectForMutation(db,a.space_id,projectId);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'sessions');throw e;}
 await assertProjectWriterForMutation(db,a.space_id,projectId,a.on_behalf_of_user_id!);
}

/** Direct conversation sessions and their execution context, over the existing session services. */
export function sessionOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return ([...Object.keys(SESSION_OPERATION_SCHEMAS),...Object.keys(SESSION_QUERY_SCHEMAS)] as Id[]).map(id=>({
  definition:definitions.get(id)!,
  ...(id==='conversation.execution.preflight'?{readKind:'metadata' as const}:{}),
  ...(id==='session.create'?{userContentCreation:true as const}:{}),
  successStatus:id==='session.create'||id==='session.message.add'?201:200,
  async resolve(_db,raw,a){const i=raw as Input;
   if(id==='session.create')return {authority:`space:${a.space_id}`,targets:{project_id:i.project_id??null},resourceType:'session',resourceId:null};
   return {authority:`session:${i.session_id}`,targets:{session_id:i.session_id},resourceType:'session',resourceId:i.session_id!};
  },
  async authorize(db,raw,a){const i=raw as Input,p=person(a);
   if(id==='session.create'){await lockPlacement(db,a,i.project_id);return;}
   if(id==='conversation.execution.initialize'||id==='conversation.execution.attachment.mutate'||id==='conversation.execution.preflight'){
    // Room conversations are reached through their Room audience; direct ones are the person's own.
    if(!await new PgConversationExecutionContextRepository(db as never).getVisibleSession(p,i.session_id!))throw hidden();return;
   }
   if(!await new PgSessionRepository(db as never).getSession(a.space_id,p.userId,i.session_id!))throw hidden();
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id?:string;session_id?:string};
   if(id==='conversation.execution.preflight'||id==='session.delete')return;
   if(out.space_id!==a.space_id)throw hidden();
   if(id==='session.create'||id==='session.message.add'||id==='session.reflect'){if(!await new PgSessionRepository(db as never).getSession(a.space_id,a.on_behalf_of_user_id!,out.session_id!))throw hidden();}
  },
  async execute(db,raw,a){
   const i=raw as Input,p=person(a),sessions=new PgSessionRepository(db as never),base={space_id:a.space_id,session_id:i.session_id!};
   switch(id){
    case 'session.create':{
     const created=await sessions.createSession(a.space_id,p.userId,{projectFolderId:i.project_id?str(i.project_folder_id):null,projectId:i.project_id??null,title:str(i.title),metadata:i.metadata&&typeof i.metadata==='object'?i.metadata as Record<string,unknown>:null});
     return {id:created.id,space_id:a.space_id,session_id:created.id};
    }
    case 'session.delete':{
     const closing=await archiveDirectSession(db,p,i.session_id!);
     if(!closing)throw hidden();
     return {...base,id:i.session_id!};
    }
    case 'session.message.add':{
     const b=raw as {content:string;input_parts:never[]};
     let message;
     if(b.input_parts.length>0){
      const inputs=new ConversationInputService(db as never,config);
      const prepared=await inputs.prepareMessageParts({spaceId:a.space_id,userId:p.userId,sessionId:i.session_id!,parts:b.input_parts});
      message=await sessions.addMessage(a.space_id,p.userId,i.session_id!,{role:'user',content:b.content});
      if(message)await inputs.attachMessageParts({spaceId:a.space_id,userId:p.userId,sessionId:i.session_id!,messageId:message.id,parts:prepared});
     }else message=await sessions.addMessage(a.space_id,p.userId,i.session_id!,{role:'user',content:b.content});
     if(!message)throw hidden();
     return {...base,id:message.id,message_id:message.id};
    }
    case 'session.reflect':{
     const out=await sessions.reflectSession(a.space_id,p.userId,i.session_id!);
     if(!out)throw hidden();
     return {...base,id:i.session_id!,proposals_created:out.proposals_created};
    }
    case 'conversation.execution.initialize':{
     const {session_id:_session,...request}=raw as Record<string,unknown>;
     await new ConversationExecutionContextService(db).initialize(p,i.session_id!,request as never);
     return {...base,id:i.session_id!};
    }
    case 'conversation.execution.attachment.mutate':{
     const {session_id:_session,...mutation}=raw as Record<string,unknown>;
     const out=await new ConversationExecutionContextService(db).mutateAttachment(p,i.session_id!,mutation as never);
     return {...base,id:out.attachment.id,attachment_id:out.attachment.id,effective_after_run_id:out.effective_after_run_id};
    }
    case 'conversation.execution.preflight':{
     const {session_id:_session,...request}=raw as Record<string,unknown>;
     return new ConversationExecutionContextService(db).preview(p,i.session_id!,request as never);
    }
   }
  },
  ...(id==='session.delete'?{async afterCommit(_raw:unknown,a:OperationActor){
   // Host archive after commit; each thread's durable intent is retried on Host reconnect and by the recovery pass.
   const pool=getDbPool(config.databaseUrl!);
   const pending=await pool.query<{id:string;agent_id:string;execution_host_id:string}>(
    `SELECT id,agent_id,execution_host_id FROM host_threads
      WHERE container_kind='direct' AND container_user_id=$1 AND status='closed' AND pending_archive_at IS NOT NULL AND execution_host_id IS NOT NULL
        AND (space_id IS NULL OR space_id=$2)`,[a.on_behalf_of_user_id,a.space_id]);
   for(const thread of pending.rows){
    await sendPendingManagedWorkspaceArchive(pool,thread.id,{hostId:thread.execution_host_id,agentId:thread.agent_id,containerKind:'direct',containerId:a.on_behalf_of_user_id!}).catch(()=>undefined);
   }
  }}:{}),
  classifyError(e){
   if(e instanceof ConversationInputError||e instanceof HostDispatchRefusal||(e instanceof ConversationExecutionContextError&&[409,422].includes(e.statusCode)))return markedRefusal(e,'sessions');
   return undefined;
  },
 }));
}
