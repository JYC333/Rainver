import {CustomSourceHandlerOutputSchema,type SourceGoalBindingSpec} from '@rainver/protocol';
import type {Queryable,SpaceUserIdentity} from '../../routeUtils/common.js';
import type {GoalRow} from './access.js';
import type {GoalExecutionPort,GoalExecutionResult} from './service.js';
import {validateGoalSample} from './validation.js';
import {ephemeralResponses,syntheticRepairFixture,validateEphemeralAnchors,repairImplementationHash} from './ephemeralRepair.js';

/** Source response bytes live only in this call and the existing isolated
 * execution channel. No Run tool result, item or business cursor is committed. */
export async function validateTransientRepair(db:Queryable,executor:GoalExecutionPort,identity:SpaceUserIdentity,g:GoalRow,spec:SourceGoalBindingSpec,authoritySha256:string){
 const deadline=AbortSignal.timeout(120000);g={...g,execution_authority:authoritySha256};
 const checks:Array<{ok:boolean;count:number;kind:string}>=[];
 let sourceKind='unknown';
 const check=async(result:GoalExecutionResult,fixture:unknown,kind:string)=>{
   const validation=validateGoalSample(result.output,{budget:g.budget_json,...g.intent_json,...(kind==='synthetic'?{includes:[],excludes:[]}:{} )});
   if(!validation.ok||!validateEphemeralAnchors(validation.output,kind==='live'?result.fixture:fixture))throw new Error('source_repair_validation_insufficient');
   const output=CustomSourceHandlerOutputSchema.parse(validation.output);
   if(kind==='live'){
    const known=await db.query<{source_external_id:string;source_uri:string}>(`SELECT source_external_id,source_uri FROM source_items WHERE space_id=$1 AND connection_id=$2 AND source_uri=ANY($3::text[])`,[g.space_id,spec.source_connection_id,output.items.map(i=>i.source_uri)]);
    const historical=new Map(known.rows.map(row=>[row.source_uri,row.source_external_id]));
    if(output.items.some(i=>historical.has(i.source_uri)&&historical.get(i.source_uri)!==i.external_id))throw new Error('source_repair_stable_identity_drift');
   }
   checks.push({ok:true,count:validation.count,kind});
 };
 // Each independent candidate execution captures its complete request sequence.
 // Reuse that sequence offline; never spend an extra connector request per round.
 for(let round=0;round<2;round++){
  const live=await executor.execute(identity,g,spec,{},deadline);
  try{
   ephemeralResponses(live.fixture);sourceKind=live.source_kind;
   await check(live,live.fixture,'live');
   const fixture=syntheticRepairFixture(live.fixture);
   const synthetic=await executor.execute(identity,g,spec,{},deadline,fixture);
   try{await check(synthetic,fixture,'synthetic');}finally{await synthetic.cleanup();}
  }finally{await live.cleanup();}
 }
 return {checks,live_sample:{authority_sha256:authoritySha256,source_kind:sourceKind,
  validation:{ok:true,count:checks.at(-1)!.count},
  transient_validation:{mode:'ephemeral_v1',implementation_sha256:repairImplementationHash(spec.implementation),authority_sha256:authoritySha256,
   active_version_id:g.active_version_id,synthetic_checks:2,live_checks:2,expires_at:new Date(Date.now()+300000).toISOString()}}};
}
