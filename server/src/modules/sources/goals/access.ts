import type {ServerConfig} from '../../../config.js';
import {enforce} from '../../policy/index.js';
import {loadActionRegistry} from '../../policy/actionRegistry.js';
import {createHash} from 'node:crypto';
import type {SourceConnectionRow} from '../sourceRepositoryRows.js';
import type {SourceGoalBudget,SourceGoalBindingSpec} from '@rainver/protocol';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {contentDecisionFromDb} from '../../access/contentAccessQuery.js';
import {canReadProject,canWriteProject} from '../../projects/access.js';
import {assertSourceConnectionManageable,assertSourceConnectionReadable} from '../sourceConnectionAccess.js';
export interface GoalRow {
 id:string;space_id:string;owner_user_id:string;project_id:string|null;agent_id:string;runtime_profile_id:string;
 intent_json:{intent:string;includes:string[];excludes:string[]};budget_json:SourceGoalBudget;
 execution_search_path?:'agent'|'api';execution_filters?:{excluded_origins?:string[]};session_id?:string|null;legacy_channel_id?:string|null;compatibility_json?:Record<string,unknown>|null;execution_scope?:string;execution_authority?:string;execution_repair_binding?:string;status:string;revision:number;current_version_id:string|null;active_version_id:string|null;start_key:string|null;agent_attempts:number;adjustment_cycle?:number;
}
export async function requireGoal(db:Queryable,identity:SpaceUserIdentity,id:string,write=false):Promise<GoalRow>{
 const result=await db.query<GoalRow>(`SELECT g.* FROM source_goals g JOIN users u ON u.id=g.owner_user_id AND u.status='active' JOIN space_memberships m ON m.space_id=g.space_id AND m.user_id=$3 AND m.status='active' WHERE g.space_id=$1 AND g.id=$2 AND g.status<>'deleted'`,[identity.spaceId,id,identity.userId]);
 const g=result.rows[0];
 if(!g || g.owner_user_id!==identity.userId && !g.project_id)throw new HttpError(404,'Collection goal not found');
 if(g.project_id && !await canReadProject(db,g.space_id,g.project_id,identity.userId))throw new HttpError(404,'Collection goal not found');
 if(write && (g.owner_user_id!==identity.userId || g.project_id && !await canWriteProject(db,g.space_id,g.project_id,identity.userId)))throw new HttpError(403,'Goal owner and Project writer required');
 return g;
}
export async function requireGoalSource(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,goal:GoalRow,spec:SourceGoalBindingSpec,write=true,allowPausedChannel=false){
 await requireGoal(db,identity,goal.id,write);
 if(write){const policy=await enforce(config,await loadActionRegistry(),{action:'source.connection.manage',actor_type:'user',actor_id:identity.userId,space_id:identity.spaceId,resource_type:'source_connection',resource_id:spec.source_connection_id,force_record:false});if(policy.status==='blocked')throw new Error('source_policy_refused');}
 if(write)await assertSourceConnectionManageable(db,identity,spec.source_connection_id);else await assertSourceConnectionReadable(db,identity,spec.source_connection_id);
 if(await contentDecisionFromDb(db,identity,'source_connection',spec.source_connection_id,{includeOversight:false})!=='full')throw new HttpError(403,'Full source content access required');
 const c=await goalSourceRow(db,identity.spaceId,spec,{activeOnly:write,allowPausedChannel});
 if(!c || c.owner_user_id!==goal.owner_user_id || c.project_id!==goal.project_id)throw new HttpError(403,'Source context/owner mismatch or source inactive');
 return c;
}
export async function requireAuthorRun(db:Queryable,g:GoalRow,runId:string,purpose:'explore'|'repair',bindingId?:string){
 const r=await db.query(`SELECT 1 FROM runs WHERE id=$1 AND space_id=$2 AND agent_id=$3 AND instructed_by_user_id=$4 AND runtime_profile_id=$8 AND EXISTS (SELECT 1 FROM agent_runtime_profiles p WHERE p.id=$8 AND p.space_id=$2 AND p.agent_id=$3 AND p.enabled=true) AND project_id IS NOT DISTINCT FROM $9::varchar AND status IN ('running','succeeded') AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$5 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'=$6 AND ($6='repair' OR COALESCE((contract_snapshot_json->'workflow_input_json'->'source_goal'->>'adjustment_cycle')::int,0)=$10) AND ($7::varchar IS NULL OR contract_snapshot_json->'workflow_input_json'->'source_goal'->>'binding_id'=$7)`,[runId,g.space_id,g.agent_id,g.owner_user_id,g.id,purpose,bindingId??null,g.runtime_profile_id,g.project_id,g.adjustment_cycle??0]);
 if(!r.rows[0])throw new HttpError(403,'Bound Agent Run required');
}

export type GoalSourceRow=SourceConnectionRow & {endpoint_url:string;provider_query_json:unknown;query_json:unknown;channel_id:string;channel_status:string;connector_key:string;provider_connector_id:string};
/**
 * The Source and channel configuration a goal binding is authorized against,
 * read without any gate (callers apply their own). `activeOnly` keeps only an
 * active Source and channel (or paused ones with `allowPausedChannel`).
 */
export async function goalSourceRow(db:Queryable,spaceId:string,spec:Pick<SourceGoalBindingSpec,'source_connection_id'|'source_channel_id'>,options:{activeOnly?:boolean;allowPausedChannel?:boolean}={}):Promise<GoalSourceRow|undefined>{
 const rows=await db.query<GoalSourceRow>(`SELECT sc.*,ch.id AS channel_id,ch.endpoint_url,CASE WHEN ch.channel_type='search' THEN ss.compiled_provider_query_json ELSE ch.provider_query_json END AS provider_query_json,ch.query_json,ch.status AS channel_status,co.connector_key
 FROM source_connections sc JOIN source_channels ch ON ch.source_connection_id=sc.id AND ch.space_id=sc.space_id
 JOIN source_provider_connectors pc ON pc.id=sc.provider_connector_id JOIN source_connectors co ON co.id=pc.connector_id
 LEFT JOIN source_search_specs ss ON ss.source_channel_id=ch.id AND ss.space_id=ch.space_id
 WHERE sc.space_id=$1 AND sc.id=$2 AND ch.id=$3 AND sc.deleted_at IS NULL AND ($4=false OR ((sc.status='active' OR ($5=true AND sc.status='paused')) AND (ch.status='active' OR ($5=true AND ch.status='paused'))))`,[spaceId,spec.source_connection_id,spec.source_channel_id,options.activeOnly??false,options.allowPausedChannel??false]);
 return rows.rows[0];
}

/** No secret values: freeze the authorized source/channel configuration seen by a preview. */
export function goalSourceFingerprint(c:GoalSourceRow):string{
 return createHash('sha256').update(JSON.stringify([c.id,c.project_id,c.owner_user_id,c.endpoint_url,c.provider_query_json,c.query_json,c.credential_id,c.active_recipe_version_id,c.active_handler_version_id,c.status,c.channel_status,c.capture_policy,c.consent_json,c.policy_json,c.config_json])).digest('hex');
}

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex').slice(0,16);
/**
 * A readable, non-secret summary of the same authority the fingerprint covers,
 * kept with a binding when it is confirmed so a later change can be named
 * (which part changed), not only detected. Values a person reads are kept as
 * they are; structured settings are kept as short digests. Never a secret: a
 * credential is recorded only as present or absent.
 */
export function goalSourceScope(c:GoalSourceRow){
 const policy=(c.policy_json??{}) as Record<string,unknown>;
 return {capture_policy:c.capture_policy??null,retention_policy:typeof policy.retention_policy==='string'?policy.retention_policy:null,source_status:c.status,channel_status:c.channel_status,
  uses_credential:!!c.credential_id,owner_user_id:c.owner_user_id,project_id:c.project_id,endpoint:digest(c.endpoint_url),query:digest([c.provider_query_json,c.query_json]),
  versions:digest([c.active_recipe_version_id,c.active_handler_version_id]),consent:digest(c.consent_json),policy:digest(c.policy_json),config:digest(c.config_json)};
}
export type GoalSourceScope=ReturnType<typeof goalSourceScope>;

export async function requireLegacyGoalSource(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,g:GoalRow,write=false){
 if(!g.legacy_channel_id)return;
 const ch=(await db.query<{source_connection_id:string}>('SELECT source_connection_id FROM source_channels WHERE id=$1 AND space_id=$2',[g.legacy_channel_id,g.space_id])).rows[0];if(!ch)throw new HttpError(404,'Source unavailable');
 await requireGoalSource(db,config,identity,g,{source_connection_id:ch.source_connection_id,source_channel_id:g.legacy_channel_id,reason:'Existing source',supports_history:false,implementation:{kind:'connector'}},write,write);
}

/** Draft conversation refinements cannot change the semantics of active repair. */
export async function activeGoalIntent(db:Queryable,g:GoalRow):Promise<GoalRow>{
 if(!g.active_version_id)return g;
 const r=await db.query<{plan_json:import('@rainver/protocol').SourceGoalPlan}>('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2',[g.active_version_id,g.id]);
 const plan=r.rows[0]?.plan_json;
 const legacy=g.compatibility_json?.active_intent_snapshot as {version_id?:string;intent_json?:GoalRow['intent_json']}|undefined;
 return {...g,intent_json:plan?.intent_snapshot??(legacy?.version_id===g.active_version_id?legacy.intent_json:undefined)??g.intent_json,execution_filters:plan?.filters,execution_search_path:plan?.search_path_snapshot??'api'};
}

/** A person starting goal setup may request review, never activate a Source. */
export async function canRequestGoalSourceActivation(db:Queryable,run:import('../../runs/repository.js').AgentRunRecord){
 const goal=(run.contract_snapshot_json as {workflow_input_json?:{source_goal?:{goal_id?:string;purpose?:string;adjustment_cycle?:number}}}|null)?.workflow_input_json?.source_goal;
 if(!run.owner_user_id||run.trigger_origin!=='manual'||!run.session_id||goal?.purpose!=='explore'||!goal.goal_id||run.instructed_by_user_id!==run.owner_user_id)return false;
 const g=await requireGoal(db,{spaceId:run.space_id,userId:run.owner_user_id},goal.goal_id,true).catch(error=>{if(error instanceof HttpError&&[403,404].includes(error.statusCode))return null;throw error});
 if(!g||g.owner_user_id!==run.owner_user_id||g.agent_id!==run.agent_id||g.project_id!==run.project_id||g.session_id!==run.session_id||(g.adjustment_cycle??0)!==(goal.adjustment_cycle??0))return false;
 return !!(await db.query(`SELECT 1 FROM messages WHERE space_id=$1 AND session_id=$2 AND run_id=$3 AND role='user' AND user_id=$4 AND metadata_json->>'source_goal_cycle'=$5`,[g.space_id,g.session_id,run.id,g.owner_user_id,String(g.adjustment_cycle??0)])).rows[0];
}
