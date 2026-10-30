import {randomUUID} from 'node:crypto';
import {SourceGoalPlanSchema,type SourceGoalBindingSpec} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,type Pool,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {PgSchedulerTaskStore} from '../../scheduler/taskStore.js';
import {openSubscriptionWindow} from '../channels/subscriptionWindows.js';
import {goalSourceFingerprint,goalSourceScope,type GoalRow} from './access.js';
import {takeGoalSchedulingOwnership} from './compatibility.js';
import {sourceGoalError} from './dispatchError.js';
import {stageManualSearch,stagePreviewBootstrap} from './manualSearch.js';
import {preflightGoalSource} from './preflight.js';
import {cleanGoalSamples} from './samples.js';
import {GOAL_CURSOR_RESET_SQL} from './selection.js';
type Contribution={source_connection_id:string;status:string;authority_sha256?:string;run_id?:string;output?:unknown;[key:string]:unknown};
export interface GoalActivation{reusedPreviewId:string|null;reusedConnections:string[];bootstrapNow:boolean}
/** The single activation path for an exact immutable version. Callers hold the
 * goal row lock. A manual preview is optional for continuous following: every
 * Source is preflighted and fingerprinted here, and a fresh exact-version
 * preview, when one exists, supplies the first Agent-search results instead
 * of a second paid collection. Manual saving still requires that preview. */
export async function activateGoalVersion(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,g:GoalRow,input:{versionId:string;mode:'continuous'|'manual';key:string;previewId?:string|null;requirePreview:boolean;reusePreview:boolean}):Promise<GoalActivation>{
 await cleanGoalSamples(db,config,g.id);
 const preview=input.previewId
  ?(await db.query<{id:string;result_json:{contributions:Contribution[]}}>(`SELECT id,result_json FROM source_goal_previews WHERE id=$1 AND goal_id=$2 AND version_id=$3 AND status='ready' AND expires_at>now()`,[input.previewId,g.id,input.versionId])).rows[0]
  :input.requirePreview?undefined:(await db.query<{id:string;result_json:{contributions:Contribution[]}}>(`SELECT id,result_json FROM source_goal_previews WHERE goal_id=$1 AND version_id=$2 AND status IN ('ready','partial') AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[g.id,input.versionId])).rows[0];
 if(input.requirePreview&&!preview)throw new HttpError(409,'Fresh exact-version preview required');
 const active=await db.query('SELECT lease_token FROM source_goal_bindings WHERE goal_id=$1 FOR UPDATE',[g.id]);if(active.rows.some(b=>b.lease_token))throw new HttpError(409,'Source execution in progress');
 const v=await db.query('SELECT plan_json FROM source_goal_versions WHERE id=$1 AND goal_id=$2',[input.versionId,g.id]);if(!v.rows[0])throw new HttpError(404,'Version not found');const plan=SourceGoalPlanSchema.parse(v.rows[0].plan_json);
 if(input.mode==='manual'&&plan.sources.some(s=>s.implementation.kind!=='agent_search'))throw sourceGoalError(409,'source_manual_implementation_unsupported');
 if(plan.interval_seconds && plan.interval_seconds<g.budget_json.interval_seconds)throw new HttpError(403,'Faster collection requires an approved usage limit');
 const reused:string[]=[];
 for(const spec of plan.sources){
  const c=await preflightGoalSource(db,config,identity,{...g,execution_search_path:plan.search_path_snapshot??'api'},spec);
  // Stop and transfer legacy triggers under the same source lock before
  // creating the single goal-owned schedule; mapping alone never transfers.
  await takeGoalSchedulingOwnership(db,g.id,g.space_id,spec.source_channel_id);
  const channel=await db.query('SELECT fetch_frequency FROM source_channels WHERE id=$1',[spec.source_channel_id]);if(channel.rows[0]?.fetch_frequency!=='manual')throw new HttpError(409,'Source already has a scheduling owner');
  const contribution=preview?.result_json.contributions.find(x=>x.source_connection_id===c.id);
  if(input.requirePreview){
   if(!contribution || contribution.status!=='succeeded')throw new HttpError(409,'Preview contribution missing or insufficient');
   if(contribution.authority_sha256!==goalSourceFingerprint(c))throw new HttpError(409,'Source authorization or scope changed since preview');
  }
  // A preview sample is reusable only when it succeeded under the exact
  // authority being activated; otherwise the binding starts from a fresh check.
  const usable=!!contribution&&contribution.status==='succeeded'&&contribution.authority_sha256===goalSourceFingerprint(c);
  const fixture:Record<string,unknown>=usable?{...contribution}:{authority_sha256:goalSourceFingerprint(c)};
  // What was confirmed, in readable form, so a later change can be named (see goalSourceScope).
  fixture.authority_scope=goalSourceScope(c);fixture.confirmed_at=new Date().toISOString();
  if(spec.implementation.kind==='agent_search'&&(c.config_json as {native_draft?:boolean}|null)?.native_draft===true){const promoted=await promoteNativeDraft(db,config,identity,g,spec,c.id);fixture.authority_sha256=goalSourceFingerprint(promoted);fixture.authority_scope=goalSourceScope(promoted);}
  if(input.reusePreview&&usable&&input.mode==='continuous'&&spec.implementation.kind==='agent_search')reused.push(c.id);
  await db.query(`INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json,fixture_json) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(goal_id,source_connection_id) DO UPDATE SET spec_json=EXCLUDED.spec_json,fixture_json=jsonb_set(EXCLUDED.fixture_json,'{previous}',source_goal_bindings.fixture_json-'previous'),revision=source_goal_bindings.revision+1,status='active',previous_spec_json=source_goal_bindings.spec_json WHERE source_goal_bindings.lease_token IS NULL RETURNING id`,[randomUUID(),g.space_id,g.id,c.id,spec,fixture]);
 }
 await db.query(`UPDATE source_goal_bindings SET ${GOAL_CURSOR_RESET_SQL} WHERE goal_id=$1`,[g.id]);
 await db.query(`UPDATE source_goal_bindings SET status='paused' WHERE goal_id=$1 AND NOT(source_connection_id=ANY($2::varchar[]))`,[g.id,plan.sources.map(s=>s.source_connection_id)]);
 const interval=plan.interval_seconds??g.budget_json.interval_seconds;
 const bootstrapNow=input.mode==='continuous'&&reused.length<plan.sources.length;
 await new PgSchedulerTaskStore(db).upsert({taskType:'source_goal_tick',taskKey:g.id,scopeType:'space',scopeId:g.space_id,spaceId:g.space_id,userId:g.owner_user_id,status:input.mode==='manual'?'paused':'active',nextRunAt:input.mode==='manual'?null:new Date(bootstrapNow?Date.now():Date.now()+interval*1000).toISOString(),metadataJson:{version_id:input.versionId}});
 await db.query(`UPDATE source_goals SET compatibility_json=COALESCE(compatibility_json,'{}'::jsonb)||jsonb_build_object('execution_mode',$5::text),active_version_id=$2,start_key=$3,budget_json=jsonb_set(budget_json,'{interval_seconds}',to_jsonb($4::int)),status='running',updated_at=now() WHERE id=$1`,[g.id,input.versionId,input.key,interval,input.mode]);
 if(input.mode==='manual')await stageManualSearch(db,identity,g.id,input.versionId,preview!.id);
 else if(reused.length)await stagePreviewBootstrap(db,g,input.versionId,preview!.id,reused);
 return {reusedPreviewId:reused.length?preview!.id:null,reusedConnections:reused,bootstrapNow};
}
/** Agent-search provenance created paused at planning becomes active only when
 * its owner activates the plan; this transaction holds the channel lock and
 * records its own promotion, preserving the rollback snapshot and later CAS. */
async function promoteNativeDraft(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,g:GoalRow,spec:SourceGoalBindingSpec,connectionId:string){
 await db.query("UPDATE source_connections SET status='active',config_json=config_json-'native_draft' WHERE id=$1",[connectionId]);await db.query("UPDATE source_channels SET status='active' WHERE id=$1",[spec.source_channel_id]);
 await db.query(`UPDATE source_goals g SET compatibility_json=jsonb_set(g.compatibility_json,ARRAY['transfers',$2::text,'expected','channel'],to_jsonb(ch),false) FROM source_channels ch WHERE g.id=$1 AND ch.id=$2 AND ch.space_id=g.space_id`,[g.id,spec.source_channel_id]);
 await db.query("INSERT INTO source_channel_user_subscriptions(id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at) VALUES($1,$2,$3,$4,'subscribed',true,true,now(),now()) ON CONFLICT(space_id,source_channel_id,user_id) DO UPDATE SET status='subscribed'",[randomUUID(),g.space_id,spec.source_channel_id,g.owner_user_id]);
 await openSubscriptionWindow(db,{spaceId:g.space_id,channelId:spec.source_channel_id,userId:g.owner_user_id,at:new Date().toISOString()});
 return preflightGoalSource(db,config,identity,{...g,execution_search_path:'agent'},spec);
}
/** Post-commit cleanup of collections from versions older than the
 * authoritative active version. A delayed caller whose version is no longer
 * active does nothing, and every victim is re-checked against the current
 * active version immediately before its cancellation (version CAS), so stale
 * cleanup can never cancel work of a newer active plan. */
export async function cancelSupersededCollections(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,goalId:string,versionId:string){
 const stale=await db.query<{id:string;version_id:string}>(`SELECT r.id,s.version_id FROM source_goals g JOIN source_goal_runs s ON s.goal_id=g.id AND s.space_id=g.space_id JOIN runs r ON r.id=s.result_json->>'native_run_id' AND r.space_id=s.space_id WHERE g.id=$1 AND g.space_id=$2 AND g.active_version_id=$3 AND s.binding_id IS NOT NULL AND s.version_id<>g.active_version_id AND r.status IN ('queued','running','waiting_for_review','waiting_for_dependency')`,[goalId,identity.spaceId,versionId]);
 if(!stale.rows.length)return;const {buildRunOrchestration}=await import('../../runs/orchestrationFactory.js');const {orchestration}=buildRunOrchestration(config);
 for(const run of stale.rows){
  const superseded=await db.query(`SELECT 1 FROM source_goals WHERE id=$1 AND space_id=$2 AND active_version_id IS DISTINCT FROM $3`,[goalId,identity.spaceId,run.version_id]);
  if(superseded.rows[0])await orchestration.cancelRun({run_id:run.id,space_id:identity.spaceId,requested_by_user_id:identity.userId,reason:'A newly confirmed Source plan superseded this collection'});
 }
}
