import {RUNTIME_CONTEXT_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition,type RuntimeContextOperationId,type RuntimeContextOperationInput} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {Pool} from '../../db/pool.js';
import type {ServerConfig} from '../../config.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationRefusal,hidden} from '../systemActions/operations/errors.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {PgSessionRepository} from '../sessions/repository.js';
import {roomConversationAudienceSql} from '../access/contentAccessSql.js';
import {WorkContextService,assertActiveWorkContextReadable} from './workContextService.js';
import {RuntimeContextContinuityService} from './continuity/service.js';

type Id=Exclude<RuntimeContextOperationId,'runtime_context.policy.write'>;
const IDS=(Object.keys(RUNTIME_CONTEXT_OPERATION_SCHEMAS) as RuntimeContextOperationId[]).filter((id):id is Id=>id!=='runtime_context.policy.write');
const who=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});

/**
 * Deterministic refusals the Runtime Context owners write for the person: stale
 * bases, scope mismatches and governing-policy limits. They name only fields or
 * reference types the caller sent; any other domain error stays internal.
 */
const REFUSALS:readonly RegExp[]=[
 /^(Runtime Context Policy|Work Context Setup) base version is stale$/,/^Active Runtime Context Policy version is missing$/,
 /^Work Context scope bindings changed during setup creation$/,/^Lower-scope Runtime Context Policy cannot widen '[a-z_.]+'$/,
 /^Semantic checkpoint is not active$/,/^Correction requires a canonical message from the correcting user$/,
 /^Context (Checkpoint correction|Event canonical (Message|Policy Decision|Run Event|ref)) does not exist in scope$/,
 /^Unsupported Context Event canonical ref type '[a-z_]+'$/,/^Unsupported explicit reference type: [a-z_]+$/,
 /^(Agent Project|Project Folder) scope mismatch$/,/^User Runtime Context Policy may contain preferences only$/,
 /^Work Context (project_id|project_folder_id|agent_id) must match the (project_id|project_folder_id|agent_id) owned by its scope$/,
 /^Work Context runtime_ref must identify a runtime profile for the selected Agent$/,/^Work Context exclusions cannot suppress approved Project Instructions$/,
 /^Project Instruction reference must belong to the Work Context Project$/,/^Too many explicit references$/,
 /^Work Context (pinned|explicit) references exceed governing policy$/,/^Work Context (pinned|explicit) reference type is prohibited by governing policy$/,
 /^(Continuity strategy|Stateful CLI continuity|Project Brief context|Project Instruction context|Retrieval domain) is prohibited by governing policy$/,
 /^Retrieval (is disabled by governing policy|candidate limit exceeds governing policy)$/,
];
export function runtimeContextRefusal(error:unknown,domain:string):OperationRefusal|undefined{
 if(!(error instanceof HttpError)||(error.statusCode!==409&&error.statusCode!==422))return undefined;
 return REFUSALS.some(pattern=>pattern.test(error.message))?new OperationRefusal(error.statusCode,domain,error.message):undefined;
}

/** Active in the Conversation's Room, that Room and the Conversation active, and its Project readable. */
async function assertRoomConversation(db:Queryable,a:OperationActor,sessionId:string):Promise<void>{
 if(!await new PgSessionRepository(db).getRoomConversation(a.space_id,a.on_behalf_of_user_id!,sessionId))throw hidden();
}
/**
 * Room before its member row before the session, as Room writers (the Agent
 * context reset, quota continue) take them: the switch then writes the session.
 */
async function lockRoomConversation(db:Queryable,a:OperationActor,sessionId:string):Promise<void>{
 const room=(await db.query<{room_id:string}>('SELECT room_id FROM sessions WHERE id=$1 AND space_id=$2 AND room_id IS NOT NULL',[sessionId,a.space_id])).rows[0];
 if(!room)throw hidden();
 const held=await db.query(`SELECT room.id FROM rooms room JOIN room_user_members member ON member.room_id=room.id AND member.space_id=room.space_id AND member.user_id=$3 AND member.status='active'
   WHERE room.id=$1 AND room.space_id=$2 AND room.status='active' AND ${roomConversationAudienceSql("room.space_id","$4::varchar","$3")} FOR SHARE OF room,member`,[room.room_id,a.space_id,a.on_behalf_of_user_id,sessionId]);
 if(!held.rows.length)throw hidden();
 await assertRoomConversation(db,a,sessionId);
}

/**
 * Work Context Setup, conversation retrieval and checkpoint-correction commands.
 * Each owner keeps its own scope locks, version base and governing-policy
 * checks; the receipt carries identity only and a replay is released only
 * while the person can still read that Work Context or Room Conversation.
 */
export function runtimeContextOperationRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return IDS.map(id=>({
  definition:defs.get(id)!,
  successStatus:id==='runtime_context.work_context.create'||id==='runtime_context.checkpoint.correct'?201:200,
  async resolve(_db,raw,a){
   const i=raw as {work_context_scope_id?:string;session_id?:string};
   if(id==='runtime_context.room_conversation.retrieval.set')return {authority:`room_conversation:${i.session_id}`,targets:{session_id:i.session_id},resourceType:'session',resourceId:i.session_id!};
   return {authority:`work_context:${a.space_id}:${i.work_context_scope_id}`,targets:{work_context_scope_id:i.work_context_scope_id},resourceType:'work_context_setup',resourceId:i.work_context_scope_id!};
  },
  async authorize(db,raw,a){
   if(id==='runtime_context.room_conversation.retrieval.set')await lockRoomConversation(db,a,(raw as {session_id:string}).session_id);
   // Setup and correction owners check scope ownership, readability, references and policy under their own locks.
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;session_id?:string;work_context_scope_id?:string};
   if(out.space_id!==a.space_id)throw hidden();
   if(out.session_id){await assertRoomConversation(db,a,out.session_id);return;}
   try{await assertActiveWorkContextReadable(db,who(a),out.work_context_scope_id!);}catch{throw hidden();}
  },
  classifyError:error=>runtimeContextRefusal(error,'runtime_context'),
  async execute(db,raw,a){
   const service=new WorkContextService(db as Pool),person=who(a);
   switch(id){
    case 'runtime_context.work_context.create':{
     const setup=await service.create(person,raw);
     return {space_id:a.space_id,work_context_scope_id:String(setup.work_context_scope_id),setup_id:String(setup.id),version:Number(setup.version)};
    }
    case 'runtime_context.work_context.retrieval.set':{
     const {work_context_scope_id:scope,...body}=raw as RuntimeContextOperationInput<'runtime_context.work_context.retrieval.set'>;
     await service.setRetrievalSwitch(person,scope,body);
     const active=await service.getActive(person,scope);
     if(!active)throw hidden();
     return {space_id:a.space_id,work_context_scope_id:scope,setup_id:String(active.id),version:Number(active.version)};
    }
    case 'runtime_context.room_conversation.retrieval.set':{
     const {session_id,...body}=raw as RuntimeContextOperationInput<'runtime_context.room_conversation.retrieval.set'>;
     await service.setRoomConversationRetrievalSwitch(person,session_id,body);
     return {space_id:a.space_id,session_id};
    }
    case 'runtime_context.checkpoint.correct':{
     const i=raw as RuntimeContextOperationInput<'runtime_context.checkpoint.correct'>;
     // The continuity owner locks its scope, then checks the readable Work Context, in that order.
     const correction_id=await new RuntimeContextContinuityService(db as Pool).correctSemanticCheckpoint({
      spaceId:a.space_id,workContextScopeId:i.work_context_scope_id,checkpointId:i.checkpoint_id,identity:person,canonicalRef:i.canonical_ref,correction:i.correction as Record<string,unknown>,
     });
     return {space_id:a.space_id,work_context_scope_id:i.work_context_scope_id,correction_id};
    }
    default:throw hidden();
   }
  },
 }));
}

/** Retained Runtime Context URLs; path parameters name the scope or Conversation. */
export function registerRuntimeContextOperationRoutes(app:FastifyInstance,config:ServerConfig):void{
 registerOperationAdapters(app,config,[
  {method:'POST',url:'/api/v1/runtime-context/work-contexts',operation:'runtime_context.work_context.create'},
  {method:'PUT',url:'/api/v1/runtime-context/work-contexts/:scopeId/retrieval',operation:'runtime_context.work_context.retrieval.set',params:{scopeId:'work_context_scope_id'}},
  {method:'PUT',url:'/api/v1/runtime-context/room-conversations/:sessionId/retrieval',operation:'runtime_context.room_conversation.retrieval.set',params:{sessionId:'session_id'}},
  {method:'POST',url:'/api/v1/runtime-context/work-contexts/:scopeId/checkpoint-corrections',operation:'runtime_context.checkpoint.correct',params:{scopeId:'work_context_scope_id'}},
 ]);
}
