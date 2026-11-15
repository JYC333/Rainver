import {AskSpaceResponseSchema,AskSpaceRequestResultSchema,CONTENT_RETRIEVAL_JOB,type RetrievalObjectType} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {dbPool,params,resolveIdentity,sendRouteError,HttpError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {lockActivePerson} from '../access/activePerson.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {ContentAccessAuditService} from '../contentAccess/audit.js';
import {contextReportReferences} from '../retrieval/contextReports.js';
import {retrievalContributingRefs} from '../retrieval/artifactRelease.js';
import {lockRetrievalReleaseClosure,withheldPinnedReleaseRefs,type ReleaseGroup} from '../retrieval/releaseClosure.js';
import {knowledgeRetrievalRegistry} from '../knowledge/retrievalAdapter.js';
import {memoryRetrievalRegistry} from '../memory/retrievalAdapter.js';
import {projectRetrievalRegistry} from '../projects/retrievalAdapter.js';
import {sourceRetrievalRegistry} from '../sources/retrievalAdapter.js';
import {inquiryRetrievalRegistry} from '../inquiry/retrievalAdapter.js';

/** One closure over every domain, trajectory, persisted Brief and follow-up.
 * No fragment, aggregate or combined answer survives a refused dependency. */
export async function releaseAskResult(tx:Queryable,identity:SpaceUserIdentity,raw:unknown){
 const value=AskSpaceResponseSchema.parse(raw);
 if(value.space_id!==identity.spaceId)throw new HttpError(404,'Think result unavailable');
 const registries={knowledge:knowledgeRetrievalRegistry,memory:memoryRetrievalRegistry,project:projectRetrievalRegistry,source:sourceRetrievalRegistry,inquiry:inquiryRetrievalRegistry};
 const groups:ReleaseGroup[]=[];
 for(const section of value.domains){
  const {refs,malformed}=retrievalContributingRefs({item_refs:section.items,citations:section.brief?.citations,gap_analysis:section.brief?.gap_analysis});
  if(malformed||refs.some(ref=>!registries[section.domain].objectTypes().includes(ref.object_type)))return {result:null,withheld:1};
  groups.push({registry:registries[section.domain],refs});
 }
 for(const p of value.provenance){
  if(!registries[p.domain].objectTypes().includes(p.object_type))return {result:null,withheld:1};
  groups.push({registry:registries[p.domain],refs:[p]});
 }
 const extra=contextReportReferences(value).filter(r=>r.type!=='project_public_summary').map(r=>r.type==='inquiry_thread'?{type:'space_object',id:r.id}:r);
 if(value.session_artifact_id)extra.push({type:'artifact',id:value.session_artifact_id});
 // Trajectory siblings/subjects are not necessarily cited search hits. Resolve
 // their canonical subtype before acquiring the one global release closure.
 for(const ref of extra){
  if(ref.type!=='space_object')continue;
  const row=(await tx.query<{object_type:RetrievalObjectType}>('SELECT object_type FROM space_objects WHERE space_id=$1 AND id=$2',[identity.spaceId,ref.id])).rows[0];
  const registry=Object.values(registries).find(r=>row&&r.objectTypes().includes(row.object_type));
  if(registry&&row)groups.push({registry,refs:[{object_type:row.object_type,object_id:ref.id}]});
 }
 await lockRetrievalReleaseClosure(tx,identity.spaceId,identity.userId,groups,extra.map(r=>({object_type:r.type as never,object_id:r.id})));
 await lockActivePerson(tx,identity.spaceId,identity.userId);
 for(const ref of extra)if(!contentResourceDefinition(ref.type)||await contentDecisionFromDb(tx,identity,ref.type,ref.id,{includeOversight:false})!=='full')return {result:null,withheld:1};
 const withheld=await withheldPinnedReleaseRefs(tx,identity,groups,null,{canonical:true});
 if(withheld)return {result:null,withheld};
 for(const type of new Set(extra.map(r=>r.type)))await new ContentAccessAuditService(tx).recordReads({spaceId:identity.spaceId,viewerUserId:identity.userId,resourceType:type,resourceIds:extra.filter(r=>r.type===type).map(r=>r.id),accessType:'read',reason:'Think result read'});
 return {result:value,withheld:0};
}

export function registerAskResultRoute(app:FastifyInstance,context:ModuleContext){
 app.get('/api/v1/ask-space/requests/:jobId',async(request,reply)=>{
  const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
  try{
   const result=await withQueryableTransaction(dbPool(context.config),async tx=>{
    const job=(await tx.query<{id:string;status:string;payload_json:{operation:string};result_json:{value?:unknown}|null}>('SELECT id,status,payload_json,result_json FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[params(request).jobId,identity.spaceId,identity.userId,CONTENT_RETRIEVAL_JOB])).rows[0];
    if(!job||job.payload_json.operation!=='ask_space.think')throw new HttpError(404,'Think request unavailable');
    const settled=job.status==='completed'&&job.result_json&&Object.hasOwn(job.result_json,'value')?await releaseAskResult(tx,identity,job.result_json.value):{result:null,withheld:0};
    await lockActivePerson(tx,identity.spaceId,identity.userId);
    return AskSpaceRequestResultSchema.parse({job_id:job.id,status:job.status==='claimed'?'running':job.status,...settled});
   });
   reply.header('cache-control','private, no-store');return reply.send(result);
  }catch(error){return sendRouteError(reply,error);}
 });
}
