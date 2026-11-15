import {releaseAskResult} from '../askSpace/requestResult.js';
import {JobEffectLeaseLost,lockCurrentJobClaim} from '../jobs/effectAuthority.js';
import {authorizeContextReport,runContextReport,releaseContextReport,isContextReport} from './contextReports.js';
import {CONTENT_RETRIEVAL_JOB,CONTENT_RETRIEVAL_OPERATION_SCHEMAS,type RegisteredSystemActionDefinition,type RetrievalObjectType} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {dbPool,params,resolveIdentity,sendRouteError,HttpError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import {lockActivePerson} from '../access/activePerson.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,OperationRefusal} from '../systemActions/operations/errors.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {executeSourceDispatch} from '../sources/sourceDispatchExecution.js';
import {knowledgeRetrievalRegistry} from '../knowledge/retrievalAdapter.js';
import {memoryRetrievalRegistry} from '../memory/retrievalAdapter.js';
import {PgMemoryReadRepository} from '../memory/repository.js';
import {runContentRequest} from './contentRequestWork.js';
import {withheldRetrievalRefs} from './artifactRelease.js';
export function contentRetrievalRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{return Object.keys(CONTENT_RETRIEVAL_OPERATION_SCHEMAS).map(id=>({
 definition:defs.get(id)!,successStatus:202,
 async resolve(_db,_raw,a){return {authority:`content_retrieval:${a.space_id}`,targets:{},resourceType:'space',resourceId:a.space_id};},
 async authorize(db,raw,a){
  if(isContextReport(id)){await authorizeContextReport(db,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},id,raw);return;}
  await lockActivePerson(db,a.space_id,a.on_behalf_of_user_id!);
  if(id.includes('.explain.')&&!await isSpaceOwnerOrAdminIn(db,a.space_id,a.on_behalf_of_user_id!))throw hidden();
  const i=raw as {object_types?:RetrievalObjectType[];object_type?:RetrievalObjectType};
  const registry=id.startsWith('memory.')?memoryRetrievalRegistry:knowledgeRetrievalRegistry;
  if([...(i.object_types??[]),...(i.object_type?[i.object_type]:[])].some(t=>!registry.objectTypes().includes(t)))throw new OperationRefusal(422,'retrieval','Object type is not supported by this retrieval surface');
 },
 async authorizeResult(db,raw,a){const out=raw as {space_id:string;job_id:string};if(out.space_id!==a.space_id||!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[out.job_id,a.space_id,a.on_behalf_of_user_id,CONTENT_RETRIEVAL_JOB])).rows.length)throw hidden();},
 async execute(db,raw,a){const job=await new PgJobQueueRepository(db).enqueue({job_type:CONTENT_RETRIEVAL_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,max_attempts:1,payload:{operation:id,user_id:a.on_behalf_of_user_id,request:raw}});return {id:job.id,space_id:a.space_id,job_id:job.id,status:'pending'};},
}));}
export function registerContentRetrievalJob(registry:JobHandlerRegistry,config:ServerConfig){
 if(!config.databaseUrl)return;
 registry.register(CONTENT_RETRIEVAL_JOB,async job=>{
  const operation=String(job.payload.operation),user=String(job.payload.user_id);
  if(user!==job.user_id||!Object.hasOwn(CONTENT_RETRIEVAL_OPERATION_SCHEMAS,operation))throw new Error('Invalid content request identity');
  const db=dbPool(config),identity={spaceId:job.space_id,userId:user};
  const result=await executeSourceDispatch(db,job,async()=>{
   if(isContextReport(operation))return {value:await runContextReport(db,identity,operation,job.payload.request)};
   await lockActivePerson(db,identity.spaceId,user);
   if(operation.includes('.explain.')&&!await isSpaceOwnerOrAdminIn(db,identity.spaceId,user))throw new Error('Request authority withdrawn');
   return {value:await runContentRequest(config,identity,operation,job.payload.request)};
  });
  if(operation!=='ask_space.think')return result;
  // External work is already fenced. Release, B11 evidence and the exact
  // terminal receipt share this short transaction; worker ack only confirms it.
  return withQueryableTransaction(db,async tx=>{
   const released=await releaseAskResult(tx,identity,(result as {value:unknown}).value);
   if(!released.result)throw hidden();
   await lockCurrentJobClaim(tx,job);
   const receipt={value:released.result};
   if(!await new PgJobQueueRepository(tx).completeJob(job.job_id,receipt,job.worker_id))throw new JobEffectLeaseLost();
   return receipt;
  });
 });
}
type Ref={object_type:RetrievalObjectType;object_id:string};
/** Never release a stale synthesis, provenance or aggregate diagnostic after
 * any contributing source is demoted. This result is indivisible; the caller
 * can request a fresh search to obtain a new result over its current audience. */
export async function releaseContentRequest(db:Queryable,identity:SpaceUserIdentity,operation:string,value:unknown){
 const memory=operation.startsWith('memory.'),registry=memory?memoryRetrievalRegistry:knowledgeRetrievalRegistry;
 const refs=new Map<string,Ref>();
 function visit(v:unknown){
  if(!v||typeof v!=='object')return;
  if(Array.isArray(v)){for(const child of v)visit(child);return;}
  const r=v as Record<string,unknown>;
  if(typeof r.object_type==='string'&&typeof r.object_id==='string'&&registry.objectTypes().includes(r.object_type as RetrievalObjectType)){const ref={object_type:r.object_type as RetrievalObjectType,object_id:r.object_id};refs.set(ref.object_type+':'+ref.object_id,ref);}
  for(const child of Object.values(r))visit(child);
 }
 visit(value);
 const rawMemory=operation==='memory.search.request';
 if(rawMemory&&Array.isArray(value))for(const row of value){if(row&&typeof row.id==='string')refs.set('memory_entry:'+row.id,{object_type:'memory_entry',object_id:row.id});}
 return withQueryableTransaction(db,async tx=>{
  const withheld=await withheldRetrievalRefs(tx,identity,registry,[...refs.values()],'content request result read',{rawMemory});
  if(withheld)return {result:null,withheld};
  if(rawMemory){
   const result=[];
   for(const r of refs.values()){const row=await new PgMemoryReadRepository(tx).get(identity.spaceId,identity.userId,r.object_id);if(!row||row.status!=='active'||row.content===null)return {result:null,withheld:1};result.push(row);}
   return {result,withheld:0};
  }
  return {result:value,withheld:0};
 });
}
const routes=[
 ['/api/v1/knowledge/search','knowledge.retrieval.search.request'],['/api/v1/knowledge/retrieval/brief','knowledge.retrieval.brief.request'],['/api/v1/knowledge/retrieval/explain','knowledge.retrieval.explain.request'],['/api/v1/knowledge/create-safety','knowledge.create_safety.request'],
 ['/api/v1/memory/search','memory.search.request'],['/api/v1/memory/retrieval/search','memory.retrieval.search.request'],['/api/v1/memory/retrieval/brief','memory.retrieval.brief.request'],['/api/v1/memory/create-safety','memory.create_safety.request'],
] as const;
export function registerContentRetrievalRoutes(app:FastifyInstance,context:ModuleContext,domain:'knowledge'|'memory'){
 registerOperationAdapters(app,context.config,[{"method": "POST" as const, "url": "/api/v1/knowledge/retrieval/maintenance/scan", "operation": "knowledge.maintenance.scan"}, {"method": "POST" as const, "url": "/api/v1/knowledge/retrieval/eval/report", "operation": "knowledge.eval.report"}, {"method": "POST" as const, "url": "/api/v1/knowledge/retrieval/eval/calibration-decisions", "operation": "knowledge.eval.calibration.record"}, {"method": "POST" as const, "url": "/api/v1/knowledge/retrieval/eval/diagnostics/report", "operation": "knowledge.eval.diagnostics.report"}, {"method": "POST" as const, "url": "/api/v1/knowledge/claims/candidate-packets", "operation": "knowledge.claim.candidate_packet.create"}, {"method": "POST" as const, "url": "/api/v1/knowledge/claims/contradiction-scan", "operation": "knowledge.claim.contradictions.scan"}, {"method": "POST" as const, "url": "/api/v1/knowledge/relations/discovery-scan", "operation": "knowledge.relation.discovery.scan"}, {"method": "POST" as const, "url": "/api/v1/knowledge/object-schema/suggestions/scan", "operation": "knowledge.object_schema.suggestions.scan"}].filter(()=>domain==='knowledge'));
 registerOperationAdapters(app,context.config,[{"method": "POST" as const, "url": "/api/v1/memory/maintenance/scan", "operation": "memory.maintenance.scan"}, {"method": "POST" as const, "url": "/api/v1/memory/maintenance/jobs", "operation": "memory.maintenance.job.create"}, {"method": "POST" as const, "url": "/api/v1/memory/maintenance/jobs/:jobId/run", "operation": "memory.maintenance.job.run", "params": {"jobId": "job_id"}}, {"method": "POST" as const, "url": "/api/v1/memory/consolidation/run", "operation": "memory.consolidation.run"}].filter(()=>domain==='memory'));
 registerOperationAdapters(app,context.config,routes.filter(([,operation])=>operation.startsWith(domain+'.')).map(([url,operation])=>({method:'POST',url,operation})));
 app.get(`/api/v1/${domain}/retrieval/requests/:jobId`,async(request,reply)=>{
  const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
  try{
   const db=dbPool(context.config),job=(await db.query<{id:string;status:string;payload_json:{operation:string;request:unknown};result_json:{value?:unknown}|null}>('SELECT id,status,payload_json,result_json FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[params(request).jobId,identity.spaceId,identity.userId,CONTENT_RETRIEVAL_JOB])).rows[0];
   if(!job||!job.payload_json.operation.startsWith(domain+'.'))throw new HttpError(404,'Retrieval request not found');
   if(job.payload_json.operation.includes('.explain.')&&!await isSpaceOwnerOrAdminIn(db,identity.spaceId,identity.userId))throw new HttpError(404,'Retrieval request not found');
   const settled=job.status==='completed'&&job.result_json&&Object.hasOwn(job.result_json,'value')?await (isContextReport(job.payload_json.operation)?releaseContextReport(db,identity,job.payload_json.operation,job.payload_json.request,job.result_json.value):releaseContentRequest(db,identity,job.payload_json.operation,job.result_json.value)):{result:null,withheld:0};
   reply.header('cache-control','private, no-store');return reply.send({job_id:job.id,status:job.status==='claimed'?'running':job.status,...settled});
  }catch(error){return sendRouteError(reply,error);}
 });
}
