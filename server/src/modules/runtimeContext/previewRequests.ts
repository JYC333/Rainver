import {RUNTIME_CONTEXT_PREVIEW_JOB,RuntimeContextEnvelopeSchema,TurnContextRequestSchema,type OperationActor,type RegisteredSystemActionDefinition,type RetrievalObjectType,type RuntimeContextEnvelope} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {HttpError,dbPool,params,resolveIdentity,sendRouteError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {executeSourceDispatch} from '../sources/sourceDispatchExecution.js';
import {withheldRetrievalRefs} from '../retrieval/artifactRelease.js';
import {assertActiveWorkContextReadable,workContextEffectiveProject} from './workContextService.js';
import {PgInvocationDeliveryAuthorizer} from './gateway.js';
import {createProductionRuntimeContextPlanningService,runtimeContextRetrievalRegistry} from './productionAcquisition.js';

const ID='runtime_context.preview.request';
const who=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});

/**
 * A turn's Runtime Context preview as a durable request. The command checks
 * the Work Context is readable under its lock and commits a single-attempt
 * Job; planning (which may embed the retrieval intent and records
 * context-injection reads) runs in that Job outside any request
 * transaction. The Job's start fence means a lost claim or unknown outcome is
 * never repeated.
 */
export function runtimeContextPreviewRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get(ID)!,successStatus:202,
  async resolve(_db,raw,a){const scope=(raw as {work_context_scope_id:string}).work_context_scope_id;return {authority:`work_context:${a.space_id}:${scope}`,targets:{work_context_scope_id:scope},resourceType:'work_context_setup',resourceId:scope};},
  async authorize(db,raw,a){
   try{await assertActiveWorkContextReadable(db,who(a),(raw as {work_context_scope_id:string}).work_context_scope_id);}
   catch(error){if(error instanceof HttpError&&[403,404].includes(error.statusCode))throw hidden();throw error;}
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;job_id:string};
   if(out.space_id!==a.space_id||!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[out.job_id,a.space_id,a.on_behalf_of_user_id,RUNTIME_CONTEXT_PREVIEW_JOB])).rows.length)throw hidden();
  },
  async execute(db,raw,a){
   const job=await new PgJobQueueRepository(db).enqueue({job_type:RUNTIME_CONTEXT_PREVIEW_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,max_attempts:1,payload:{user_id:a.on_behalf_of_user_id,turn:raw}});
   return {space_id:a.space_id,job_id:job.id,status:'pending' as const};
  },
 };
}

export function registerRuntimeContextPreviewJob(registry:JobHandlerRegistry,config:ServerConfig){
 if(!config.databaseUrl)return;
 registry.register(RUNTIME_CONTEXT_PREVIEW_JOB,async job=>{
  const user=String(job.payload.user_id),turn=TurnContextRequestSchema.safeParse(job.payload.turn);
  if(user!==job.user_id||!turn.success)throw new Error('Invalid Runtime Context preview request');
  const db=dbPool(config),identity={spaceId:job.space_id,userId:user};
  return executeSourceDispatch(db,job,async()=>{
   // Authority is rechecked when the Job runs, not assumed from admission.
   await withQueryableTransaction(db,tx=>assertActiveWorkContextReadable(tx,identity,turn.data.work_context_scope_id));
   const envelope=RuntimeContextEnvelopeSchema.parse(await createProductionRuntimeContextPlanningService(db,config).preview({identity,turn:turn.data}));
   // Stored only if the reader's release gate would release it now.
   if(!(await releaseRuntimeContextPreview(db,identity,envelope)).result)throw new Error('Runtime Context preview sources changed while it was planned');
   return {value:envelope};
  });
 });
}

/**
 * Releases a stored envelope only while every part of it is still current for
 * this person, re-checked by its owner in one transaction: the Work Context
 * and its active Setup version, the Run, Agent, Project and egress authority,
 * and each item's own source through the Delivery gate
 * (`PgInvocationDeliveryAuthorizer.authorizePreviewRelease`: Message,
 * continuity, Skill binding, Evidence Matrix Artifact, Brief/Instruction,
 * AgentVersion, retrieval and its Source policy), plus the retrieval release
 * closure. Any item that is no longer current, or whose type no owner
 * re-checks, withholds the whole envelope — body, structure and provenance —
 * and a fresh preview may be requested.
 */
export async function releaseRuntimeContextPreview(db:Queryable,identity:SpaceUserIdentity,value:unknown):Promise<{result:RuntimeContextEnvelope|null;withheld:number}>{
 const parsed=RuntimeContextEnvelopeSchema.safeParse(value);
 if(!parsed.success)return {result:null,withheld:1};
 const envelope=parsed.data;
 return withQueryableTransaction(db,async(tx:Queryable)=>{
  const types=new Set<string>(runtimeContextRetrievalRegistry.objectTypes());
  const refs=envelope.items.filter(item=>types.has(item.source_ref.type)).map(item=>({object_type:item.source_ref.type as RetrievalObjectType,object_id:item.source_ref.id}));
  const scope=envelope.turn_request.work_context_scope_id;
  try{
   const workContextProject=await workContextEffectiveProject(tx,identity,scope).catch((error:unknown)=>{if(error instanceof HttpError&&error.statusCode===404)return null;throw error;});
   // Every Project these checks lock — the gate's, the Work Context's and the
   // retrieval release closure's — is taken before the Run; the Work Context
   // check and the release closure run after the gate under that held set.
   return await new PgInvocationDeliveryAuthorizer().authorizePreviewRelease(tx,identity,envelope,{
    retrievalGroups:[{registry:runtimeContextRetrievalRegistry,refs}],
    workContextProject,
    afterGate:async()=>{
     // The Work Context lock and its locked Setup read, as Setup writers take them.
     const active=await assertActiveWorkContextReadable(tx,identity,scope);
     if(String(active.version)!==String(envelope.setup_ref?.version??''))return {result:null,withheld:1};
     const withheld=await withheldRetrievalRefs(tx,identity,runtimeContextRetrievalRegistry,refs,'runtime context preview result read');
     return withheld?{result:null,withheld}:{result:envelope,withheld:0};
    },
   });
  }
  catch(error){if(error instanceof HttpError&&error.statusCode>=400&&error.statusCode<500)return {result:null,withheld:1};throw error;}
 });
}

export function registerRuntimeContextPreviewRoutes(app:FastifyInstance,context:ModuleContext):void{
 registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/runtime-context/preview',operation:ID}]);
 app.get('/api/v1/runtime-context/preview-requests/:jobId',async(request,reply)=>{
  const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
  try{
   const db=dbPool(context.config),job=(await db.query<{id:string;status:string;result_json:{value?:unknown}|null}>('SELECT id,status,result_json FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[params(request).jobId,identity.spaceId,identity.userId,RUNTIME_CONTEXT_PREVIEW_JOB])).rows[0];
   if(!job)throw new HttpError(404,'Preview request not found');
   const settled=job.status==='completed'&&job.result_json&&Object.hasOwn(job.result_json,'value')?await releaseRuntimeContextPreview(db,identity,job.result_json.value):{result:null,withheld:0};
   reply.header('cache-control','private, no-store');
   return reply.send({job_id:job.id,status:job.status==='claimed'?'running':job.status,...settled});
  }catch(error){return sendRouteError(reply,error);}
 });
}
