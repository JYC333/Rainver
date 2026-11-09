import {randomUUID} from 'node:crypto';
import {WorkspaceRetentionUpdateInputSchema,WorkspaceRetentionSchema,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {authorizedWorkspaceChange} from './workspaceOperations.js';
import type {ExecutionWorkspaceRow} from './executionWorkspaces.js';
import {enqueueWorkspaceCleanup,refreshCleanupSummary,replaceableSourceCleanup,type WorkspaceCleanupResource} from '../hosts/workspaceCleanup.js';
import {assessWorkspaceRetention,hostReleasesRefs,recordRetention} from '../hosts/workspaceRetention.js';

const conflict=()=>new OperationBusinessError('operation_conflict',409,'workspaces');
type Row=ExecutionWorkspaceRow&{cleanup_json:Record<string,WorkspaceCleanupResource>;retention_json:Record<string,unknown>;inventory_json:Record<string,unknown>|null;host_reclaim:number|null};

/**
 * People manage source retention through the existing Run/conversation card.
 * The command only records intent and a durable cleanup Job in the core
 * transaction; Host Git work happens in that Job, which re-proves everything.
 * It can never release unmerged, blocked or kept-without-merging work.
 */
export function workspaceRetentionRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 async function subject(db:Queryable,raw:unknown,actor:Parameters<OperationRegistration['execute']>[2],lock=false){
  if(actor.run_id||actor.principal.kind!=='user')throw hidden();
  const input=WorkspaceRetentionUpdateInputSchema.parse(raw);
  return {input,c:await authorizedWorkspaceChange(db,input.change_set_id,actor,lock,false)};
 }
 return {
  definition:definitions.get('workspace.retention.update')!,
  async resolve(db,raw,actor){const {c}=await subject(db,raw,actor);return {authority:`workspace:${c.workspace_id}`,targets:{workspace_id:c.workspace_id,change_set_id:c.id},resourceType:'project',resourceId:c.project_id};},
  async authorize(db,raw,actor){await subject(db,raw,actor,true);},
  async authorizeResult(db,raw,actor){
   const workspaceId=(raw as {workspace_id?:string}).workspace_id;
   const change=(await db.query<{id:string}>('SELECT id FROM workspace_change_sets WHERE workspace_id=$1 AND space_id=$2 ORDER BY sequence DESC LIMIT 1',[workspaceId,actor.space_id])).rows[0];
   if(!change)throw hidden();
   await authorizedWorkspaceChange(db,change.id,actor,false,false,true);
  },
  async execute(db,raw,actor){
   const {input,c}=await subject(db,raw,actor,true);
   const w=(await db.query<Row>(`SELECT w.*,(h.capabilities_json->'execution_workspaces'->>'reclaim')::int AS host_reclaim FROM execution_workspaces w JOIN hosts h ON h.id=w.execution_host_id WHERE w.id=$1 FOR UPDATE OF w`,[c.workspace_id])).rows[0];
   if(!w)throw hidden();
   const state=typeof w.retention_json.state==='string'?w.retention_json.state:null;
   const source=w.cleanup_json[`source-g${w.generation}`];
   const user=actor.on_behalf_of_user_id!;
   if(input.action==='hold'){
    if(state==='reclaimed'||state==='reclaiming')throw conflict();
    const until=new Date(Date.now()+input.hold_days!*24*60*60_000).toISOString();
    await recordRetention(db,w.id,{hold_until:until,reclaim_requested_at:null});
    // The hold only postpones an otherwise eligible release. Active or retained
    // work keeps showing its own (stronger) reason; the hold applies later.
    const assessment=await assessWorkspaceRetention(db,w.id);
    await recordRetention(db,w.id,{state:assessment.state,reason:assessment.reason,reclaim_after:assessment.reclaim_after});
   }else if(input.action==='release_hold'){
    if(typeof w.retention_json.hold_until!=='string')throw conflict();
    await recordRetention(db,w.id,{hold_until:null});
    await offer(db,w,source,user);
   }else if(input.action==='reclaim_now'){
    if(!hostReleasesRefs(w.host_reclaim)||source?.state==='running'||source?.release_epoch!==undefined&&source.state!=='cleaned')throw conflict();
    // Skips only the short grace, a hold the person lifts by asking, and a
    // remembered proof refusal (the Host proves the tip again against Git).
    await recordRetention(db,w.id,{hold_until:null,reclaim_requested_at:new Date().toISOString(),proof_refused_tip:null,proof_refused_reason:null,proof_refused_at:null});
    const assessment=await assessWorkspaceRetention(db,w.id);
    if(assessment.state!=='reclaimable')throw conflict();
    await recordRetention(db,w.id,{state:'reclaimable',reason:assessment.reason,reclaim_after:null});
    const tip=w.head_commit??w.base_commit;
    if(!tip)throw conflict();
    // Immediately: replacing the resource fences any Job still waiting on the old grace/idle timer.
    await enqueueWorkspaceCleanup(db,w,{id:w.id,generation:w.generation},tip,true,user,undefined,undefined,'now');
   }else{
    // Retry re-delivers blocked cleanup with a fresh operation identity and
    // budget; the Job still re-checks tip, generation, leases and proof.
    const blocked=Object.entries(w.cleanup_json).filter(([,r])=>r.state==='blocked');
    if(!blocked.length&&!w.inventory_json?.reconciliation_error)throw conflict();
    for(const [key,r] of blocked){
     // A release keeps its epoch and plan: the Host resumes that exact release
     // (journal keyed by identity and epoch) instead of losing its remaining work.
     const restored={...r,state:'pending' as const,attempts:0,error:null,next_retry_at:null,operation_id:randomUUID()};
     await db.query("UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],$3::jsonb,true) WHERE id=$1 AND cleanup_json->$2->>'operation_id'=$4",[w.id,key,JSON.stringify(restored),r.operation_id]);
     await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_cleanup',space_id:w.space_id,user_id:user,payload:{workspace_id:w.id,resource_key:key,operation_id:restored.operation_id}});
    }
    await db.query("UPDATE execution_workspaces SET inventory_json=inventory_json-'reconciliation_error'-'reconciliation_failed_at' WHERE id=$1",[w.id]);
    await refreshCleanupSummary(db,w.id);
   }
   return {workspace_id:w.id,retention:await currentRetention(db,w.id)};
  },
 };
}

async function offer(db:Queryable,w:Row,source:WorkspaceCleanupResource|undefined,user:string){
 const assessment=await assessWorkspaceRetention(db,w.id);
 await recordRetention(db,w.id,{state:assessment.state,reason:assessment.reason,reclaim_after:assessment.reclaim_after});
 if(!hostReleasesRefs(w.host_reclaim)||!replaceableSourceCleanup(source))return;
 const tip=w.head_commit??w.base_commit;
 // A Job parked on the hold (or the 24-hour idle timer) is replaced and so
 // fenced by operation id; the new one looks when the release is due.
 if(tip&&(assessment.state==='reclaimable'||assessment.state==='grace'))
  await enqueueWorkspaceCleanup(db,w,{id:w.id,generation:w.generation},tip,true,user,undefined,undefined,assessment.state==='grace'&&assessment.reclaim_after?new Date(assessment.reclaim_after):'now');
}
async function currentRetention(db:Queryable,workspaceId:string){
 const r=(await db.query<{retention_json:Record<string,unknown>}>('SELECT retention_json FROM execution_workspaces WHERE id=$1',[workspaceId])).rows[0]?.retention_json??{};
 const text=(v:unknown)=>typeof v==='string'?v:null,count=(v:unknown)=>typeof v==='number'&&v>=0?v:0;
 return WorkspaceRetentionSchema.parse({state:typeof r.state==='string'?r.state:'active',reason:typeof r.reason==='string'?r.reason:'unknown',reclaim_after:text(r.reclaim_after),hold_until:text(r.hold_until),reclaimed_at:text(r.reclaimed_at),assessed_at:text(r.assessed_at),retained_refs:count(r.retained_refs),unclaimed_refs:count(r.unclaimed_refs)});
}
