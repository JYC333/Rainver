import {collectionDiscoveryContext} from './collectionDiscovery.js';
import {freezeCollectionContext} from './collectionContext.js';
import {collectionPrompt,COLLECTION_INSTRUCTION} from './collectionPrompt.js';
import {followingReadingContext,withFollowingContext} from '../readingMethods/followingContext.js';
import {closeReadingContext} from '../../prompts/index.js';
import {collectionReadingContext,assertReadingAudience} from '../readingMethods/context.js';
import {requireNativeCollector} from './nativeSafety.js';
import {preflightGoalSource} from './preflight.js';
import {assertSafeGoalMessage} from './messageSafety.js';
import {nativeProfileFingerprint} from './nativeRoute.js';
import {randomUUID,createHash} from 'node:crypto';
import {type SourceGoalBindingSpec} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {PgRunRepository} from '../../runs/repository.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import {PgConversationBackendRepository} from '../../sessions/conversationBackendRepository.js';
import {resolveSessionConfig,sessionConfigRunOverride} from '../../sessions/sessionConfig.js';
import {createManagedExecutionPolicy} from '../../policy/managedExecutionPolicy.js';
import {requireGoal,goalSourceFingerprint,type GoalRow} from './access.js';
import {SourceChannelService} from '../channels/sourceChannelService.js';
export class NativeSearchPending extends Error{constructor(readonly runId:string){super('source_native_search_queued');}}
export async function bindNativeSource(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,g:GoalRow,request:{reason:string;implementation:{kind:'agent_search';query:string};supports_history:false}):Promise<SourceGoalBindingSpec>{
 assertSafeGoalMessage(request.implementation.query);await requireNativeCollector(db,g.runtime_profile_id);
 const backends=new PgConversationBackendRepository(db);const option=(await backends.listOptions(g.space_id,g.owner_user_id,g.agent_id)).find(o=>o.runtime_profile_id===g.runtime_profile_id);if(!option||option.usable===false)throw new HttpError(409,'source_goal_execution_setup_required');
 const saved=g.session_id?await backends.sessionConfig(g.space_id,g.session_id,g.agent_id):[];
 const advertised=option.session_config_options??[];const defaults=advertised.filter(o=>o.type==='select'&&['model','mode'].includes(o.category??'')&&typeof o.current_value==='string'&&!saved.some(x=>x.id===o.id)).map(o=>({id:o.id,type:'select' as const,category:o.category??null,value:o.current_value as string}));
 const selected=await resolveSessionConfig([...saved,...defaults],async()=>[],advertised);
 const scope=createHash('sha256').update(JSON.stringify([g.id,g.runtime_profile_id,request.implementation.query])).digest('hex');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['native-source-metadata:'+g.space_id+':'+g.owner_user_id]);
 const prior=(await db.query(`SELECT id FROM source_connections WHERE space_id=$1 AND owner_user_id=$2 AND project_id IS NOT DISTINCT FROM $3::varchar AND config_json->>'native_scope'=$4 AND deleted_at IS NULL AND status<>'archived'`,[g.space_id,g.owner_user_id,g.project_id,scope])).rows[0];
 const count=Number((await db.query(`SELECT count(*)::int n FROM source_connections WHERE space_id=$1 AND owner_user_id=$2 AND provider_connector_id='00000000-0000-4000-8000-00000000d009'`,[g.space_id,g.owner_user_id])).rows[0].n);
 const source=await new SourceChannelService(db,config).create(identity,{provider_key:'agent_native_search',...(prior?{source_connection_id:prior.id}:{_force_create:true}),query:{native_query:request.implementation.query,goal_id:g.id},project_id:g.project_id,fetch_frequency:'manual',source_name:request.reason.slice(0,100)+' · Agent search '+(count+1),name:request.reason.slice(0,180),capture_policy:'extract_text',policy:{retention_policy:'full_text'},transport_config:{native_scope:scope,native_draft:true}},true);
 return {source_connection_id:source.source_connection_id,source_channel_id:source.id,reason:request.reason,supports_history:false,implementation:{...request.implementation,route:{profile_sha256:await nativeProfileFingerprint(db,g.runtime_profile_id),agent_id:g.agent_id,runtime_profile_id:g.runtime_profile_id,session_config:selected.selections}}};
}
/** Never waits for a model inside HTTP/transaction. Existing canonical job/Run
 * owns execution, permission requests, cancellation, budget and timeout. */
export async function queueNativeSearch(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,g:GoalRow,spec:SourceGoalBindingSpec,cursor:Record<string,unknown>):Promise<never>{
 const runId=await withDbTransaction(db,async tx=>{
  await tx.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[g.id]);const current=await requireGoal(tx,identity,g.id,true);if(current.status==='deleted'||current.status==='paused'&&current.compatibility_json?.execution_mode!=='manual')throw new HttpError(409,'source_goal_stopped');
  const c=await preflightGoalSource(tx,config,identity,{...current,execution_search_path:g.execution_search_path},spec);if(c.connector_key!=='agent_native_search'||spec.implementation.kind!=='agent_search'||!spec.implementation.route)throw new HttpError(409,'source_native_route_required');
  const route=spec.implementation.route;if(route.profile_sha256!==await nativeProfileFingerprint(tx,route.runtime_profile_id))throw new HttpError(409,'source_native_route_changed');if(route.agent_id!==current.agent_id||route.runtime_profile_id!==current.runtime_profile_id)throw new HttpError(403,'source_native_route_changed');
  const context=(await tx.query(`SELECT id,version_id,binding_id FROM source_goal_runs WHERE id=$1 AND goal_id=$2 AND status='running' UNION ALL SELECT id,version_id,NULL::varchar AS binding_id FROM source_goal_previews WHERE id=$1 AND goal_id=$2 AND status='running'`,[g.execution_scope,g.id])).rows[0];if(!context)throw new HttpError(403,'source_native_collection_context_required');if(!context.binding_id&&context.version_id!==current.current_version_id)throw new HttpError(409,'source_native_stale_result');
  const prior=(await tx.query(`SELECT result_json FROM source_goal_runs WHERE goal_id=$1 AND result_json->>'scope_id'=$2 AND result_json->'spec'->>'source_connection_id'=$3 ORDER BY started_at DESC LIMIT 1`,[g.id,g.execution_scope,c.id])).rows[0];if(prior?.result_json.native_run_id)return String(prior.result_json.native_run_id);
  const backends=new PgConversationBackendRepository(tx);const option=(await backends.listOptions(g.space_id,g.owner_user_id,route.agent_id)).find(o=>o.runtime_profile_id===route.runtime_profile_id);if(!option||option.usable===false)throw new HttpError(409,'source_goal_execution_setup_required');
  const selection=await resolveSessionConfig(route.session_config,async()=>[],option.session_config_options??[]);
  const collectionId=context.binding_id?context.id:randomUUID();const authority=goalSourceFingerprint(c);if(g.execution_authority&&g.execution_authority!==authority)throw new HttpError(403,'source_authority_revoked');
  const {projectId:contextProjectId,context:projectContext}=await collectionReadingContext(tx,identity,g.project_id,c.project_id);await assertReadingAudience(tx,identity,null,null,c.id);
  const candidate={goal_id:g.id,version_id:context.version_id,connection_id:c.id};
  const following=await followingReadingContext(tx,identity,contextProjectId,candidate,c.visibility==='private');
  const analysisContext=withFollowingContext(projectContext,following);
  const discovery=await collectionDiscoveryContext(tx,identity,g.id,context.version_id,c.id);
  const frozenContext=freezeCollectionContext(contextProjectId,analysisContext,discovery);
  const run=await new PgRunRepository(tx).createQueuedRunWithBudgetAdmission({execution_kind:'agent',agent_id:route.agent_id,runtime_profile_id:route.runtime_profile_id,space_id:g.space_id,user_id:g.owner_user_id,project_id:contextProjectId,mode:'live',run_type:'agent',trigger_origin:context.binding_id?'system':'manual',visibility:'private',capabilities_json:['source.material.submit'],scenario_tool_allowance:['source.material.submit'],model_override_json:sessionConfigRunOverride(selection),prompt:(g.project_id&&!contextProjectId?'Project context is not authorized for this Source audience. Collect relevant material without inferring a private Project brief.\n':'')+collectionPrompt({query:spec.implementation.query,context:analysisContext,discovery,watermark:cursor.last_collected_at??cursor.watermark,limit:g.budget_json.items_per_source,preview:!context.binding_id,capture:c.capture_policy,retention:String((c.policy_json as Record<string,unknown>|null)?.retention_policy??'metadata_only'),collectionId}),instruction:COLLECTION_INSTRUCTION,contract_snapshot:{source:{kind:'direct',id:g.id},project_id:contextProjectId,workflow_input_json:{source_collection:frozenContext,...(following?{reading_following:candidate}:{}),source_goal:{goal_id:g.id,project_id:g.project_id,purpose:'collect',collection_id:collectionId,version_id:context.version_id,source_connection_id:c.id,authority_sha256:authority}},...(context.binding_id?{policy_context_json:createManagedExecutionPolicy('source_goal',true)}:{}),max_attempts:1,risk_level:'low'}});
  const bindingRevision=context.binding_id?(await tx.query('SELECT revision FROM source_goal_bindings WHERE id=$1',[context.binding_id])).rows[0].revision:null;
  const payload={submission_attempts:0,binding_revision:bindingRevision,native_run_id:run.id,scope_id:g.execution_scope,spec,authority_sha256:authority,cursor_before:cursor,preview_id:context.binding_id?null:context.id,route};
  if(context.binding_id)await tx.query(`UPDATE source_goal_runs SET status='queued',result_json=$2 WHERE id=$1`,[collectionId,payload]);else await tx.query(`INSERT INTO source_goal_runs(id,space_id,goal_id,version_id,status,result_json) VALUES($1,$2,$3,$4,'queued',$5)`,[collectionId,g.space_id,g.id,context.version_id,payload]);
  if(context.binding_id)await tx.query("UPDATE source_goal_bindings SET status='collecting' WHERE id=$1",[context.binding_id]);
  await closeReadingContext(tx,{spaceId:g.space_id,userId:g.owner_user_id},run.id,route.agent_id,route.runtime_profile_id);
  await new PgJobQueueRepository(tx).enqueue({job_type:'agent_run',space_id:g.space_id,user_id:g.owner_user_id,agent_id:route.agent_id,payload:{run_id:run.id},max_attempts:1});return run.id;
 });throw new NativeSearchPending(runId);
}
