import {createHash,randomUUID} from 'node:crypto';
import {SourceGoalEditSchema,SourceGoalPlanSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {requireGoal,requireGoalSource} from './access.js';
import {bindNativeSource} from './nativeSearch.js';
import {assertSafeGoalMessage} from './messageSafety.js';

/** Human-authored immutable draft. No model, scheduler or active binding write. */
export async function editSourceGoal(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,id:string,raw:unknown){
 const input=SourceGoalEditSchema.parse(raw);assertSafeGoalMessage(JSON.stringify(input));
 const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 return withDbTransaction(db,async tx=>{
  await tx.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[id]);
  const g=await requireGoal(tx,identity,id,true);
  const prior=g.compatibility_json?.manual_edit as {key:string;hash:string;version_id:string}|undefined;
  if(prior?.key===input.idempotency_key){if(prior.hash!==hash)throw new HttpError(409,'Edit request key changed');return {id:prior.version_id,revision:g.revision};}
  if(g.revision!==input.expected_revision)throw new HttpError(409,'Goal revision changed; reload before editing');
  const active=(await tx.query(`SELECT 1 FROM runs WHERE space_id=$1 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$2 AND COALESCE(contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose','')<>'collect' AND status IN ('queued','running','waiting_for_review','waiting_for_dependency','cancelling') UNION ALL SELECT 1 FROM messages WHERE session_id=$3 AND metadata_json->>'source_goal_dispatch_pending'='true'`,[g.space_id,id,g.session_id??null])).rows;
  if(active.length)throw new HttpError(409,'A topic adjustment is still running');
  const base=(await tx.query('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2 AND space_id=$3',[g.current_version_id??g.active_version_id,id,g.space_id])).rows[0];
  if(!base)throw new HttpError(422,'Prepare a topic plan before manual editing');
  const plan=SourceGoalPlanSchema.parse(base.plan_json);
  if(new Set(input.queries.map(q=>q.source_connection_id)).size!==input.queries.length||input.queries.some(q=>!plan.sources.some(s=>s.source_connection_id===q.source_connection_id&&s.implementation.kind==='agent_search')))throw new HttpError(422,'Only existing Agent-search queries can be edited here');
  const sources=[];
  for(const spec of plan.sources){
   await requireGoalSource(tx,config,identity,g,spec,false);
   const query=input.queries.find(q=>q.source_connection_id===spec.source_connection_id)?.query;
   sources.push(query&&spec.implementation.kind==='agent_search'&&query!==spec.implementation.query?await bindNativeSource(tx,config,identity,g,{reason:spec.reason,supports_history:false,implementation:{kind:'agent_search',query}}):spec);
  }
  const intent={intent:input.intent,includes:input.includes,excludes:input.excludes};
  const candidate=SourceGoalPlanSchema.parse({...plan,title:input.title,summary:input.summary,analysis_brief:input.analysis_brief,intent_snapshot:intent,filters:{...plan.filters,includes:input.includes,excludes:input.excludes},sources});
  const version=randomUUID();
  await tx.query(`INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_user_id,adjustment_cycle) VALUES($1,$2,$3,$4,$5,$6,$7)`,[version,g.space_id,id,g.revision+1,candidate,identity.userId,g.adjustment_cycle??0]);
  // Freeze old legacy intent before the editable intent advances. The active
  // version keeps collecting until the person applies this exact candidate.
  const legacy=g.active_version_id?(await tx.query('SELECT plan_json FROM source_goal_versions WHERE id=$1',[g.active_version_id])).rows[0]:null;
  const provenance=legacy&&!legacy.plan_json.intent_snapshot&&(g.compatibility_json?.active_intent_snapshot as {version_id?:string}|undefined)?.version_id!==g.active_version_id?{active_intent_snapshot:{version_id:g.active_version_id,intent_json:g.intent_json}}:{};
  await tx.query(`UPDATE source_goals SET current_version_id=$2,revision=revision+1,intent_json=$3,compatibility_json=COALESCE(compatibility_json,'{}'::jsonb)||$4::jsonb,updated_at=now() WHERE id=$1`,[id,version,intent,{...provenance,display_title:input.title,conversation_base_intent:input.intent,manual_edit:{key:input.idempotency_key,hash,version_id:version}}]);
  return {id:version,revision:g.revision+1};
 });
}
