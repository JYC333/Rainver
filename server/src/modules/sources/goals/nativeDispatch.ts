import type {SourceGoalBindingSpec,RuntimeSessionConfigSelection} from '@rainver/protocol';
import {requireNativeCollector} from './nativeSafety.js';
import {isDeepStrictEqual} from 'node:util';
import {PgConversationBackendRepository} from '../../sessions/conversationBackendRepository.js';
import {resolveSessionConfig} from '../../sessions/sessionConfig.js';
import type {ServerConfig} from '../../../config.js';
import {getDbPool} from '../../../db/pool.js';
import type {Queryable} from '../../routeUtils/common.js';
import type {RunRecord} from '../../runs/repository.js';
import {HttpError} from '../../routeUtils/common.js';
import {requireGoal,goalSourceFingerprint} from './access.js';
import {preflightGoalSource} from './preflight.js';
import {nativeProfileFingerprint} from './nativeRoute.js';
/** Called at canonical dispatch, not merely described in a model prompt. */
export async function assertNativeCollectionDispatch(config:ServerConfig,run:RunRecord,connection?:Queryable){
 const ctx=(run.contract_snapshot_json as {workflow_input_json?:{source_goal?:{purpose?:string;goal_id:string;collection_id:string;version_id:string;source_connection_id:string}}})?.workflow_input_json?.source_goal;if(ctx?.purpose!=='collect')return;
 const grants=(run.permission_snapshot_json as {tool_grants?:{action_id:string}[]}|null)?.tool_grants??[];if(!grants.some(g=>g.action_id==='source.material.submit'))throw new HttpError(403,'source_native_context_refused');
 if(!config.databaseUrl||!run.instructed_by_user_id)throw new HttpError(403,'source_native_context_refused');const db=connection??getDbPool(config.databaseUrl);
 const audit=(await db.query<{version_id:string;binding_id:string;result_json:{preview_id?:string;route:{session_config:RuntimeSessionConfigSelection[];profile_sha256:string};spec:SourceGoalBindingSpec;authority_sha256:string;binding_revision:number}}>(`SELECT * FROM source_goal_runs WHERE id=$1 AND goal_id=$2 AND space_id=$3 AND status='queued' AND result_json->>'native_run_id'=$4`,[ctx.collection_id,ctx.goal_id,run.space_id,run.id])).rows[0];if(!audit)throw new HttpError(403,'source_native_context_refused');
 const p=audit.result_json;if(ctx.version_id!==audit.version_id||ctx.source_connection_id!==p.spec.source_connection_id)throw new HttpError(403,'source_native_context_refused');await requireNativeCollector(db,run.requested_runtime_profile_id!);const identity={spaceId:run.space_id,userId:run.instructed_by_user_id};const g=await requireGoal(db,identity,ctx.goal_id,true);if((g.status==='deleted'||g.status==='paused'&&!(p.preview_id&&g.compatibility_json?.execution_mode==='manual'))||run.agent_id!==g.agent_id||run.requested_runtime_profile_id!==g.runtime_profile_id||run.project_id!==g.project_id)throw new HttpError(403,'source_authority_revoked');
 const option=(await new PgConversationBackendRepository(db).listOptions(g.space_id,g.owner_user_id,g.agent_id)).find(o=>o.runtime_profile_id===g.runtime_profile_id);if(!option||option.usable===false)throw new HttpError(403,'source_native_route_changed');await resolveSessionConfig(p.route.session_config,async()=>[],option.session_config_options??[]);
 const plan=(await db.query<{plan_json:{search_path_snapshot?:'agent'|'api'}}>('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2',[audit.version_id,g.id])).rows[0];if(!plan)throw new HttpError(403,'source_native_context_refused');
 const c=await preflightGoalSource(db,config,identity,{...g,execution_search_path:plan.plan_json.search_path_snapshot??'agent'},p.spec);if(goalSourceFingerprint(c)!==p.authority_sha256||p.route.profile_sha256!==await nativeProfileFingerprint(db,g.runtime_profile_id)||!isDeepStrictEqual((run.model_override_json as {acp_session_config?:unknown}|null)?.acp_session_config??[],p.route.session_config))throw new HttpError(403,'source_native_route_changed');
 if(p.preview_id){if(g.current_version_id!==audit.version_id||!(await db.query(`SELECT 1 FROM source_goal_previews WHERE id=$1 AND version_id=$2 AND status='running' AND expires_at>now()`,[p.preview_id,audit.version_id])).rows.length)throw new HttpError(409,'source_native_stale_result');}
 else{const b=(await db.query<{revision:number;status:string}>(`SELECT revision,status FROM source_goal_bindings WHERE id=$1 AND goal_id=$2`,[audit.binding_id,g.id])).rows[0];if(g.active_version_id!==audit.version_id||g.status!=='running'||!b||b.status!=='collecting'||b.revision!==p.binding_revision)throw new HttpError(409,'source_native_stale_result');}
 return c;
}
