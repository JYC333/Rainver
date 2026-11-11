import {ROOM_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {assertProjectWriter} from '../projects/access.js';
import {AgentGroupRefusal,HostDispatchRefusal} from '../agentGroups/hostDispatchErrors.js';
import {ConversationExecutionContextError} from '../sessions/executionContextService.js';
import {ConversationTurnInProgressError} from '../sessions/conversationRuntimeSessionRepository.js';
import {ConversationInputError} from '../sessions/conversationInputService.js';
import {ConversationBackendError} from '../sessions/conversationBackendRepository.js';
import {ConversationSessionConfigError} from '../sessions/sessionConfig.js';
import {RunCreateValidationError} from '../runs/repository.js';
import {PgRoomRepository} from './repository.js';
import {RoomService} from './service.js';
import {RoomRosterService,archiveManagedConversationWorkspaces,hasRoomCommandStanding} from './rosterService.js';
import {RoomDiscussionService,heldClosingRunRefs} from './discussionService.js';
import {RoomMutationError} from './roomMutationError.js';
import {continueHeldRuns} from './quotaGate.js';
import {RoomMessageQueue} from './messageQueue.js';
import {enqueueRoomAgentWorkspaceRestore} from './workspaceRestoreJob.js';

type Id=keyof typeof ROOM_OPERATION_SCHEMAS;
type Input=Record<string,unknown>&{room_id?:string;session_id?:string;agent_id?:string;user_id?:string;invitation_id?:string;queued_id?:string;discussion_id?:string;project_id?:string};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const CREATED=new Set<Id>(['room.create','room.agent.add','room.agent.add_preset','room.invitation.create','room.conversation.create','room.conversation.attach_references','room.message.send','room.message.continue_after_proposal','room.discussion.start']);
const ACCEPTED=new Set<Id>(['room.message.retry']);
/** Discussion steering closes or extends held closing Runs; the host admits that Run set first. */
const RUN_OWNERS=new Set<Id>(['room.discussion.start','room.discussion.stop','room.discussion.extend']);
const strip=(raw:unknown,...keys:string[])=>{const value={...raw as Record<string,unknown>};for(const key of keys)delete value[key];return value;};

/** Visibility before policy; the owning service then takes its own locks in its own order. */
async function visibleRoom(db:Queryable,a:OperationActor,roomId:string){
 const room=await new PgRoomRepository(db).getVisibleRoom(a.space_id,a.on_behalf_of_user_id!,roomId);
 if(!room)throw hidden();
 return room;
}
type Standing=Parameters<typeof hasRoomCommandStanding>[3];
/** Commands whose service grants authority to a non-member; every other Room command needs the roster. */
function specialStanding(id:Id,invitationId:string|undefined):Standing|null{
 if(id==='room.invitation.decide'&&invitationId)return {kind:'invitation_decide',invitationId};
 if(id==='room.owner.claim')return {kind:'owner_claim'};
 return null;
}
async function visibleOrStanding(db:Queryable,a:OperationActor,roomId:string,standing:Standing){
 if(await new PgRoomRepository(db).getVisibleRoom(a.space_id,a.on_behalf_of_user_id!,roomId))return;
 if(!await hasRoomCommandStanding(db,person(a),roomId,standing))throw hidden();
}
async function visibleConversation(db:Queryable,a:OperationActor,roomId:string,sessionId:string){
 const room=await visibleRoom(db,a,roomId);
 if(!await new PgRoomRepository(db).getConversation(a.space_id,room.id,sessionId))throw hidden();
 return room;
}

/** Human Room roster, conversation and turn commands over the existing Room services. */
export function roomOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (Object.keys(ROOM_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  successStatus:CREATED.has(id)?201:ACCEPTED.has(id)?202:200,
  ...(RUN_OWNERS.has(id)?{runTerminalOwner:{discover:(db:Queryable,raw:unknown,a:OperationActor)=>heldClosingRunRefs(db,a.space_id,String((raw as Input).session_id))}}:{}),
  async resolve(db,raw,a){const i=raw as Input;
   if(id==='room.create')return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id},resourceType:'project',resourceId:i.project_id!};
   const room=(await db.query<{project_id:string}>('SELECT project_id FROM rooms WHERE id=$1 AND space_id=$2',[i.room_id,a.space_id])).rows[0];
   if(!room)throw hidden();
   // The Room audience scopes the key; a conversation command is scoped to its conversation within it.
   return {authority:i.session_id?`room:${i.room_id}:session:${i.session_id}`:`room:${i.room_id}`,
    targets:{room_id:i.room_id,session_id:i.session_id??null,agent_id:i.agent_id??null,user_id:i.user_id??null,invitation_id:i.invitation_id??null,queued_id:i.queued_id??null,discussion_id:i.discussion_id??null,project_id:room.project_id},
    resourceType:'room',resourceId:i.room_id!};
  },
  async authorize(db,raw,a){const i=raw as Input;
   if(id==='room.create'){await assertProjectWriter(db,a.space_id,i.project_id!,a.on_behalf_of_user_id!);return;}
   const special=specialStanding(id,i.invitation_id);
   if(special){await visibleOrStanding(db,a,i.room_id!,special);return;}
   if(i.session_id)await visibleConversation(db,a,i.room_id!,i.session_id);else await visibleRoom(db,a,i.room_id!);
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;room_id:string;session_id?:string;invitation_id?:string};
   if(out.space_id!==a.space_id)throw hidden();
   // A replay is re-authorized by the same relation that admitted the command, read now.
   const special=specialStanding(id,out.invitation_id);
   if(special){await visibleOrStanding(db,a,out.room_id,special);return;}
   if(out.session_id)await visibleConversation(db,a,out.room_id,out.session_id);else await visibleRoom(db,a,out.room_id);
  },
  async execute(db,raw,a){
   const i=raw as Input,p=person(a),service=new RoomService(config,db as never),roster=new RoomRosterService(db as never);
   const base={space_id:a.space_id,room_id:i.room_id!};
   switch(id){
    case 'room.create':{const out=await service.createRoom(p,raw as never);return {id:out.room.id,space_id:a.space_id,room_id:out.room.id,project_id:out.room.project_id};}
    case 'room.agent.add':{
     const out=await roster.addExistingAgent(p,i.room_id!,strip(raw,'room_id') as never);
     // The restore commits with the membership as a durable Job of the exact target; the Host call is that Job's.
     if(out.restoreTarget)await enqueueRoomAgentWorkspaceRestore(db,{spaceId:a.space_id,userId:p.userId,roomId:i.room_id!,target:out.restoreTarget});
     return {...base,id:i.room_id!,agent_id:i.agent_id!,restore_requested:Boolean(out.restoreTarget)};
    }
    case 'room.agent.add_preset':await service.addAgentPreset(p,i.room_id!,strip(raw,'room_id') as never);return {...base,id:i.room_id!};
    case 'room.agent.remove':{const out=await roster.removeAgent(p,i.room_id!,i.agent_id!);return {...base,id:i.room_id!,agent_id:i.agent_id!,revoked_grant_count:out.detail.revoked_grant_count};}
    case 'room.agent.reset_context':await service.resetAgentContext(p,i.room_id!,i.agent_id!,i.session_id);return {...base,id:i.room_id!,agent_id:i.agent_id!};
    case 'room.agent.summarize_context':await service.summarizeAgentContext(p,i.room_id!,i.agent_id!);return {...base,id:i.room_id!,agent_id:i.agent_id!};
    case 'room.agent.restart_from_summary':await service.restartFromSummary(p,i.room_id!,i.agent_id!);return {...base,id:i.room_id!,agent_id:i.agent_id!};
    case 'room.invitation.create':{const out=await service.inviteUser(p,i.room_id!,strip(raw,'room_id') as never) as {id:string};return {...base,id:out.id,invitation_id:out.id};}
    case 'room.invitation.decide':{const out=await service.decideInvitation(p,i.room_id!,i.invitation_id!,strip(raw,'room_id','invitation_id') as never) as {id:string};return {...base,id:out.id,invitation_id:out.id};}
    case 'room.member.remove':await service.removeUser(p,i.room_id!,i.user_id!);return {...base,id:i.room_id!,user_id:i.user_id!};
    case 'room.owner.transfer':await service.transferOwner(p,i.room_id!,i.user_id!);return {...base,id:i.room_id!};
    case 'room.owner.claim':await service.claimOwner(p,i.room_id!);return {...base,id:i.room_id!};
    case 'room.conversation.create':{const out=await service.createConversationDraft(p,i.room_id!) as {id:string};return {...base,id:out.id,session_id:out.id};}
    case 'room.conversation.attach_references':{
     const out=await service.attachConversationReferences(p,i.room_id!,i.session_id!,strip(raw,'room_id','session_id') as never);
     return {...base,id:i.session_id!,session_id:i.session_id!,attached:out.attached};
    }
    case 'room.message.send':{
     const {queue,...send}=strip(raw,'room_id','session_id') as {queue?:boolean}&Record<string,unknown>;
     const out=queue?await service.sendOrQueueMessage(p,i.room_id!,i.session_id!,send as never):await service.sendMessage(p,i.room_id!,i.session_id!,send as never);
     if('queued' in out)return {...base,id:out.queued.id,session_id:i.session_id!,status:'queued' as const,queued_id:out.queued.id};
     return {...base,id:out.message.id,session_id:i.session_id!,status:'sent' as const,message_id:out.message.id,task_group_ids:out.task_group_ids,run_ids:out.run_ids};
    }
    case 'room.message.withdraw_queued':{const out=await new RoomMessageQueue(config,db as never).withdraw(p,i.room_id!,i.session_id!,i.queued_id!);return {...base,id:out.id,session_id:i.session_id!,queued_id:out.id};}
    case 'room.message.retry':{const out=await service.retryMessage(p,i.room_id!,i.session_id!,{run_id:String(i.run_id)});return {...out,space_id:a.space_id,room_id:i.room_id!};}
    case 'room.message.continue_after_proposal':{
     const out=await service.continueAfterProposal(p,i.room_id!,i.session_id!,strip(raw,'room_id','session_id') as never) as {message:{id:string};task_group_ids:string[];run_ids:string[]};
     return {...base,id:out.message.id,session_id:i.session_id!,message_id:out.message.id,task_group_ids:out.task_group_ids,run_ids:out.run_ids};
    }
    case 'room.quota.continue':{
     // Continuing past the quota is a decision to spend: Project writer authority, as for adding rounds.
     const room=await new PgRoomRepository(db).getVisibleRoom(a.space_id,p.userId,i.room_id!,true);
     if(!room)throw hidden();
     await assertProjectWriter(db,a.space_id,room.project_id,p.userId);
     if(!await new PgRoomRepository(db).getConversation(a.space_id,room.id,i.session_id!))throw hidden();
     await continueHeldRuns(db,{spaceId:a.space_id,sessionId:i.session_id!,userId:p.userId});
     return {...base,id:i.session_id!,session_id:i.session_id!};
    }
    case 'room.discussion.start':{
     const out=await new RoomDiscussionService(config,db as never).open(p,i.room_id!,i.session_id!,strip(raw,'room_id','session_id') as never) as {discussion:{id:string};message:{id:string};task_group_ids:string[];run_ids:string[]};
     return {...base,id:out.discussion.id,session_id:i.session_id!,discussion_id:out.discussion.id,message_id:out.message.id,task_group_ids:out.task_group_ids,run_ids:out.run_ids};
    }
    case 'room.discussion.stop':await new RoomDiscussionService(config,db as never).stop(p,i.room_id!,i.session_id!,i.discussion_id!);return {...base,id:i.discussion_id!,session_id:i.session_id!,discussion_id:i.discussion_id!};
    case 'room.discussion.extend':await new RoomDiscussionService(config,db as never).extend(p,i.room_id!,i.session_id!,i.discussion_id!,Number((raw as {rounds:number}).rounds));return {...base,id:i.discussion_id!,session_id:i.session_id!,discussion_id:i.discussion_id!};
   }
  },
  ...(id==='room.agent.remove'?{async afterCommit(raw:unknown,a:OperationActor){
   // Host work is never this transaction's. The archive's durable `pending_archive_at`
   // intent committed; this is only its first attempt, and the host-archive recovery retries it.
   const out=raw as {room_id:string;agent_id:string},pool=getDbPool(config.databaseUrl!);
   // Whether the shared cwd goes too was fixed with the intent when the closing transaction committed it.
   const pending=await pool.query<{id:string;execution_host_id:string;session_id:string}>(
    `SELECT thread.id,thread.execution_host_id,thread.session_id
       FROM host_threads thread JOIN sessions conversation ON conversation.id=thread.session_id AND conversation.space_id=thread.space_id
      WHERE thread.space_id=$1 AND thread.agent_id=$2 AND conversation.room_id=$3 AND thread.container_kind='conversation'
        AND thread.status='closed' AND thread.pending_archive_at IS NOT NULL AND thread.execution_host_id IS NOT NULL`,[a.space_id,out.agent_id,out.room_id]);
   await archiveManagedConversationWorkspaces(pool,pending.rows.map(row=>({threadId:row.id,hostId:row.execution_host_id,agentId:out.agent_id,conversationId:row.session_id})));
  }}:{}),
  classifyError(e){
   if(e instanceof RoomMutationError||e instanceof HostDispatchRefusal||e instanceof AgentGroupRefusal||e instanceof ConversationTurnInProgressError||e instanceof ConversationInputError||e instanceof ConversationBackendError||e instanceof ConversationSessionConfigError||e instanceof RunCreateValidationError||e instanceof ConversationExecutionContextError)
    return markedRefusal(e as Error&{statusCode:number;responseBody?:unknown},'rooms');
   return undefined;
  },
 }));
}
