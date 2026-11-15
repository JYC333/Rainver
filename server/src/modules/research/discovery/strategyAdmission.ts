import type {OperationActor} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {type Queryable,objectValue} from '../../routeUtils/common.js';
import {assertProjectWriterForMutation,assertProjectReadable} from '../../projects/access.js';
import {assertThreadReadable} from '../../inquiry/threadAccess.js';
import {contentDecisionFromDb} from '../../access/contentAccessQuery.js';
import {assertSourceConnectionManageable} from '../../sources/sourceConnectionAccess.js';
import {lockSourceRetrievalRelease} from '../../sources/retrievalReleaseLocks.js';
import {lockMonitorCreation} from '../../sources/sourceMonitorParent.js';
import {enforce} from '../../policy/service.js';
import {loadActionRegistry} from '../../policy/actionRegistry.js';
import {canonical} from '../../systemActions/operations/repository.js';
import {loadSourcePolicySnapshots,loadViewerSpaceRole,sourcePolicyAllowsRead} from '../../retrieval/sourcePolicy.js';
import {hidden,OperationError} from '../../systemActions/operations/errors.js';

const conflict=()=>new OperationError('operation_conflict',409,false,'research');
export const strategyPerson=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Context={id:string;project_id:string;provenance_json:unknown};
/** Discover without locks, including superseded selections and inherited context
 * lineage. No ids from JSON establish authority; each is resolved in this Space. */
export type StrategyAdmissionTarget=string|{project_id:string;research_context_version_id:string;providers:readonly string[]};
export async function discoverStrategyAdmission(db:Queryable,space:string,strategyId:StrategyAdmissionTarget,userId:string,extraChannels:readonly string[]=[]){
 const strategy=typeof strategyId==='string'?(await db.query<{id:string;project_id:string;research_context_version_id:string}>(
  'SELECT id,project_id,research_context_version_id FROM research_query_strategies WHERE id=$1 AND space_id=$2',[strategyId,space])).rows[0]:{project_id:strategyId.project_id,research_context_version_id:strategyId.research_context_version_id};
 if(!strategy)throw hidden();
 const contexts:Context[]=[],queue=[strategy.research_context_version_id],seen=new Set<string>();
 for(let n=0;n<queue.length;n++){
  const id=queue[n]!;if(seen.has(id))continue;if(seen.size>=200)throw conflict();seen.add(id);
  const row=(await db.query<Context>('SELECT id,project_id,provenance_json FROM project_research_context_versions WHERE id=$1 AND space_id=$2',[id,space])).rows[0];if(!row)throw hidden();if(id===strategy.research_context_version_id&&row.project_id!==strategy.project_id)throw hidden();contexts.push(row);
  const inherited=objectValue(row.provenance_json).inherited_context_id;if(typeof inherited==='string')queue.push(inherited);
 }
 contexts.sort((a,b)=>a.id.localeCompare(b.id));
 const strategies=(await db.query<{id:string;project_id:string}>(
  'SELECT id,project_id FROM research_query_strategies WHERE research_context_version_id=$1 AND space_id=$2 ORDER BY id',[strategy.research_context_version_id,space])).rows;
 const ids=strategies.map(r=>r.id);
 const plans=(await db.query<{id:string;provider_key:string}>('SELECT id,provider_key FROM research_query_provider_plans WHERE strategy_id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id',[ids,space])).rows;
 const attempts=(await db.query<{id:string}>('SELECT id FROM research_query_attempts WHERE provider_plan_id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id',[plans.map(r=>r.id),space])).rows;
 const selections=(await db.query<{provider_plan_id:string;attempt_id:string}>('SELECT provider_plan_id,attempt_id FROM research_query_provider_selections WHERE provider_plan_id=ANY($1::varchar[]) AND space_id=$2 ORDER BY provider_plan_id',[plans.map(r=>r.id),space])).rows;
 const specs=(await db.query<{id:string;source_channel_id:string}>('SELECT id,source_channel_id FROM source_search_specs WHERE research_query_attempt_id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id',[attempts.map(r=>r.id),space])).rows;
 const channels=(await db.query<{id:string;source_connection_id:string}>(
  'SELECT id,source_connection_id FROM source_channels WHERE id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id',[[...new Set([...specs.map(r=>r.source_channel_id),...extraChannels])].sort(),space])).rows;
 if(extraChannels.some(id=>!channels.some(c=>c.id===id)))throw hidden();
 // Selected-attempt creation reuses an owned, context-free provider connection.
 // Discover every eligible parent, not just whichever is latest before waiting.
 const parents=(await db.query<{id:string}>(`SELECT sc.id FROM source_connections sc JOIN source_provider_connectors pc ON pc.id=sc.provider_connector_id JOIN source_providers p ON p.id=pc.provider_id
  WHERE sc.space_id=$1 AND sc.deleted_at IS NULL AND (sc.id=ANY($2::varchar[]) OR (sc.owner_user_id=$3 AND sc.project_id IS NULL AND sc.status<>'archived' AND p.provider_key=ANY($4::varchar[]))) ORDER BY sc.id`,[space,channels.map(r=>r.source_connection_id),userId,[...new Set([...plans.map(r=>r.provider_key),...(typeof strategyId==='string'?[]:strategyId.providers)])].sort()])).rows;
 if(channels.some(c=>!parents.some(p=>p.id===c.source_connection_id)))throw hidden();
 const bindings=(await db.query<{id:string;project_id:string;source_channel_id:string}>(
  'SELECT id,project_id,source_channel_id FROM project_source_bindings WHERE source_channel_id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id',[channels.map(r=>r.id),space])).rows;
 const workflows=(await db.query<{object_id:string;project_id:string}>(`SELECT object_id,project_id FROM project_research_workflows WHERE space_id=$1 AND status='active' AND state_json->>'query_strategy_id'=ANY($2::text[]) ORDER BY object_id`,[space,ids])).rows;
 const threads=contexts.flatMap(c=>{const id=objectValue(c.provenance_json).thread_id;return typeof id==='string'?[{id,project_id:c.project_id}]:[];}).sort((a,b)=>a.id.localeCompare(b.id));
 return {strategy,contexts,strategies,plans,attempts,selections,specs,channels,parents,bindings,workflows,threads};
}
export async function admitStrategy(db:Queryable,config:ServerConfig,a:OperationActor,strategyId:StrategyAdmissionTarget,extraChannels:readonly string[]=[],credentialIds:readonly string[]=[],access:'write'|'read'='write',additionalStrategies:readonly string[]=[]){
 const person=strategyPerson(a);
 await lockMonitorCreation(db,person); // try only: never wait on a new key after core admission
 const discover=async()=>{
  const first=await discoverStrategyAdmission(db,a.space_id,strategyId,person.userId,extraChannels);
  for(const id of [...new Set(additionalStrategies)].sort()){
   const next=await discoverStrategyAdmission(db,a.space_id,id,person.userId,extraChannels);
   if(next.strategy.project_id!==first.strategy.project_id)throw hidden();
   for(const key of ['contexts','strategies','plans','attempts','selections','specs','channels','parents','bindings','workflows','threads'] as const){
    const merged=[...first[key],...next[key]];
    (first as Record<string,unknown>)[key]=[...new Map(merged.map(row=>[canonical(row),row])).values()].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
   }
  }
  return first;
 };
 const before=await discover();
 const refs=[...before.parents.map(r=>({object_type:'source_connection' as const,object_id:r.id})),...before.workflows.map(r=>({object_type:'space_object' as const,object_id:r.object_id})),...before.threads.map(r=>({object_type:'space_object' as const,object_id:r.id}))];
 const projects=[...new Set([before.strategy.project_id,...before.contexts.map(r=>r.project_id),...before.bindings.map(r=>r.project_id),...before.workflows.map(r=>r.project_id)])].sort();
 await lockSourceRetrievalRelease(db,a.space_id,person.userId,refs,projects,async()=>{
  for(const c of before.contexts)await db.query('SELECT id FROM project_research_context_versions WHERE id=$1 AND space_id=$2 FOR UPDATE',[c.id,a.space_id]);
  await db.query('SELECT id FROM research_query_strategies WHERE id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id FOR UPDATE',[before.strategies.map(r=>r.id),a.space_id]);
  await db.query('SELECT id FROM research_query_provider_plans WHERE id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id FOR UPDATE',[before.plans.map(r=>r.id),a.space_id]);
  await db.query('SELECT id FROM research_query_attempts WHERE id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id FOR SHARE',[before.attempts.map(r=>r.id),a.space_id]);
  await db.query('SELECT provider_plan_id FROM research_query_provider_selections WHERE provider_plan_id=ANY($1::varchar[]) AND space_id=$2 ORDER BY provider_plan_id FOR SHARE',[before.plans.map(r=>r.id),a.space_id]);

 },[],[],refs,access==='write'?[before.strategy.project_id]:[]);
 if(canonical(before)!==canonical(await discover()))throw conflict();
 for(const p of projects){if(p===before.strategy.project_id&&access==='write')await assertProjectWriterForMutation(db,a.space_id,p,person.userId);else await assertProjectReadable(db,a.space_id,p,person.userId);}
 for(const t of before.threads)await assertThreadReadable(db,person,t.project_id,t.id,'read_content');
 for(const w of before.workflows)if(await contentDecisionFromDb(db,person,'space_object',w.object_id,{includeOversight:false})!=='full')throw hidden();
 for(const p of before.parents){if(access==='write')await assertSourceConnectionManageable(db,person,p.id);else if(await contentDecisionFromDb(db,person,'source_connection',p.id,{includeOversight:false})!=='full')throw hidden();}
 await db.query('SELECT id FROM source_channels WHERE id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id FOR UPDATE',[before.channels.map(r=>r.id),a.space_id]);
 await db.query('SELECT id FROM project_source_bindings WHERE id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id FOR UPDATE',[before.bindings.map(r=>r.id),a.space_id]);
 await db.query('SELECT id FROM scheduler_tasks WHERE space_id=$1 AND task_type=\'source_channel_scan\' AND task_key=ANY($2::text[]) ORDER BY id FOR UPDATE',[a.space_id,before.channels.map(r=>r.id)]);
 await db.query('SELECT id FROM credentials WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,[...new Set(credentialIds)].sort()]);
 if(canonical(before)!==canonical(await discover()))throw conflict();
 const sourcePolicies=await loadSourcePolicySnapshots(db,a.space_id,before.parents.map(p=>p.id));
 const role=await loadViewerSpaceRole(db,a.space_id,person.userId);
 for(const parent of before.parents){
  const policy=sourcePolicies.get(parent.id);
  if(!policy||!sourcePolicyAllowsRead(policy,{viewerUserId:person.userId,viewerSpaceRole:role}))throw hidden();
 }
 if(access==='read')return before;
 const gate=await enforce({...config,auditTransaction:db},await loadActionRegistry(config),{action:'project.source.bind',actor_type:'user',actor_id:person.userId,space_id:a.space_id,resource_type:'project_source',resource_id:before.strategy.project_id,force_record:true,context:{trigger_origin:a.effective_origin}});
 if(gate.status==='blocked')throw hidden();if(gate.status!=='allow'||!gate.policy_decision_record_id)throw new OperationError('operation_audit_unavailable',503,true);
 return before;
}
