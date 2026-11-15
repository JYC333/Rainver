import {reportReleasePlans as plans} from "./reportReleasePlan.js";
import type {RetrievalObjectType} from '@rainver/protocol';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {proposalReportDependencies} from './proposalReportDependencies.js';
import {lockRetrievalReleaseBatch,type ReleaseGroup} from './releaseClosure.js';
import {canonical} from '../systemActions/operations/repository.js';

type Ref={type:string;id:string};
const key=(r:Ref)=>r.type+':'+r.id;
/** Discover report and packet graphs in full before the first owner lock.
 * This is a bounded read plan, never an access grant. The existing owner gates
 * still decide every dependency under the resulting global lock set. */
async function discover(db:Queryable,i:SpaceUserIdentity,values:unknown[]){
 const {contextReportReferences}=await import("./contextReports.js");
 const refs=new Map<string,Ref>(),queue:Ref[]=[],fingerprints:unknown[]=[];
 const add=(r:Ref)=>{if(!refs.has(key(r))){refs.set(key(r),r);queue.push(r);}};
 for(const r of contextReportReferences(values))add(r);
 // Selected rows have `id`, while report/packet references use artifact_id/proposal_id.
 for(const value of values){const row=value as {id?:string;artifact_type?:string;proposal_type?:string};if(row?.id&&row.artifact_type)add({type:'artifact',id:row.id});if(row?.id&&row.proposal_type)add({type:'proposal',id:row.id});}
 for(let n=0;n<queue.length;n++){
  if(queue.length>2000)throw new HttpError(409,'Report dependency closure is too large');
  const r=queue[n]!;
  if(r.type==='artifact'){
   const row=(await db.query<{id:string;artifact_type:string;metadata_json:unknown;run_id:string|null}>('SELECT id,artifact_type,metadata_json,run_id FROM artifacts WHERE space_id=$1 AND id=$2',[i.spaceId,r.id])).rows[0]??null;
   fingerprints.push([key(r),row]);
   if(row){if(row.run_id)add({type:'run',id:row.run_id});for(const child of contextReportReferences(row.metadata_json))add(child);}
  }else if(r.type==='proposal'){
   const row=(await db.query<{proposal_type:string;payload_json:unknown;created_by_run_id:string|null}>('SELECT proposal_type,payload_json,created_by_run_id FROM proposals WHERE space_id=$1 AND id=$2',[i.spaceId,r.id])).rows[0]??null;
   fingerprints.push([key(r),row]);
   if(row){if(row.created_by_run_id)add({type:'run',id:row.created_by_run_id});for(const child of contextReportReferences(row.payload_json))add(child);for(const id of proposalReportDependencies(row.proposal_type,row.payload_json)?.artifactIds??[])add({type:'artifact',id});}
  }
 }
 const registries=await Promise.all([import('../knowledge/retrievalAdapter.js').then(m=>m.knowledgeRetrievalRegistry),import('../memory/retrievalAdapter.js').then(m=>m.memoryRetrievalRegistry),import('../sources/retrievalAdapter.js').then(m=>m.sourceRetrievalRegistry),import('../projects/retrievalAdapter.js').then(m=>m.projectRetrievalRegistry),import('../inquiry/retrievalAdapter.js').then(m=>m.inquiryRetrievalRegistry)]);
 const groups:ReleaseGroup[]=[],additional=[];
 for(const r of refs.values()){
  let type=r.type==='memory'?'memory_entry':r.type;
  if(type==='space_object')type=(await db.query<{object_type:string}>('SELECT object_type FROM space_objects WHERE space_id=$1 AND id=$2',[i.spaceId,r.id])).rows[0]?.object_type??type;
  const registry=registries.find(reg=>reg.objectTypes().includes(type as RetrievalObjectType));
  if(registry)groups.push({registry,refs:[{object_type:type as RetrievalObjectType,object_id:r.id}]});
  if(r.type!=='project_public_summary')additional.push({object_type:(r.type==='inquiry_thread'?'space_object':r.type) as never,object_id:r.id});
 }
 return {refs:[...refs.values()],groups,additional,fingerprints,artifacts:[...refs.values()].filter(r=>r.type==='artifact').map(r=>r.id)};
}
/** Once a command pins its complete input plan, later recursively discovered
 * refs may only be part of it or rows this transaction itself just wrote.
 * A concurrent new input is drift, never permission to take a lower lock. */
export async function pinReportReleaseBatch(db:Queryable,i:SpaceUserIdentity,values:unknown[],seal=false):Promise<void>{
 const held=plans.get(db);
 if(held){
  // The complete existing graph is already pinned. Each recursive owner gate
  // checks its direct refs without rediscovering or acquiring another closure.
  const {contextReportReferences}=await import('./contextReports.js');
  const refs=contextReportReferences(values);
  for(const value of values){const row=value as {id?:string;artifact_type?:string;proposal_type?:string};if(row?.id&&row.artifact_type)refs.push({type:'artifact',id:row.id});if(row?.id&&row.proposal_type)refs.push({type:'proposal',id:row.id});}
  if(refs.some(r=>!held.has(key(r))))throw new HttpError(409,'Report inputs changed; run again');
  return;
 }
 const before=await discover(db,i,values);
 await lockRetrievalReleaseBatch(db,[{space:i.spaceId,user:i.userId,groups:before.groups,additional:before.additional,artifactRoots:before.artifacts,artifactBatch:true}]);
 if(canonical(before.fingerprints)!==canonical((await discover(db,i,values)).fingerprints))throw new HttpError(409,'Report dependencies changed; run again');
 if(seal)plans.set(db,new Set(before.refs.map(key)));
}
