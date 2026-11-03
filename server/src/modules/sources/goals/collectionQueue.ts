import {retryableNativeCollection} from './collectionRetry.js';
import {projectReadingDay} from '../../informationDigest/index.js';
import {randomUUID} from 'node:crypto';
import type {SourceGoalBindingSpec} from '@rainver/protocol';
import {SourceGoalCheckRequestSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import {PgSourcesRepository} from '../repository.js';
import {activeGoalIntent,requireGoal,requireLegacyGoalSource,goalSourceFingerprint,type GoalRow} from './access.js';
import {preflightGoalSource} from './preflight.js';
import {sourceGoalError} from './dispatchError.js';

/** Called with the goal row locked, by both the scheduler and manual admission.
 * Durable jobs and native collection audits are the existing execution owners. */
export async function enqueueGoalCollection(db:Queryable,g:GoalRow,slot?:string,projectTargets?:Array<{goal_id:string;version_id:string|null}>,slotAt?:string){
 const existing=await db.query<{id:string}>(`SELECT id FROM jobs WHERE space_id=$1 AND job_type='source_goal_tick' AND payload_json->>'goal_id'=$2 AND status IN ('pending','claimed','running') ORDER BY created_at LIMIT 1`,[g.space_id,g.id]);
 if(existing.rows[0])return {status:'in_progress' as const,job_id:existing.rows[0].id};
 // Expired leases/terminal native audits must permit a recovery tick; a stale
 // audit alone is not proof of live execution. The worker reconciles it.
 const active=await db.query(`SELECT 1 FROM source_goal_runs s JOIN runs r ON r.id=s.result_json->>'native_run_id' AND r.space_id=s.space_id WHERE s.space_id=$1 AND s.goal_id=$2 AND s.status IN ('queued','running','accepted','materializing') AND r.status IN ('queued','running','waiting_for_review','waiting_for_dependency','cancelling') UNION ALL SELECT 1 FROM source_goal_bindings WHERE space_id=$1 AND goal_id=$2 AND lease_until>now() LIMIT 1`,[g.space_id,g.id]);
 if(active.rows[0])return {status:'in_progress' as const};
 const edition=g.project_id?await projectReadingDay(db,g.space_id,g.project_id,slotAt):undefined;
 const {beginThemeRound}=await import('../../informationDigest/index.js');
 let round:Awaited<ReturnType<typeof beginThemeRound>>=null;
 // Optional analysis must never revoke independently authorized collection.
 // Roll back even partial round/deadline writes before recording a safe code.
 await db.query('SAVEPOINT optional_theme_admission');
 try{
  round=await beginThemeRound(db,g,slot??`manual:${randomUUID()}`,projectTargets,edition);
  await db.query('RELEASE SAVEPOINT optional_theme_admission');
  await db.query("UPDATE source_goals SET compatibility_json=COALESCE(compatibility_json,'{}'::jsonb)-'theme_analysis_admission' WHERE id=$1 AND space_id=$2 AND compatibility_json ? 'theme_analysis_admission'",[g.id,g.space_id]);
 }catch(error){
  if(!(error instanceof HttpError)||error.statusCode<400||error.statusCode>=500)throw error;
  await db.query('ROLLBACK TO SAVEPOINT optional_theme_admission');
  await db.query('RELEASE SAVEPOINT optional_theme_admission');
  const raw=(error.responseBody as {code?:unknown}|undefined)?.code;
  const code=typeof raw==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(raw)?raw:error.statusCode===403?'theme_analysis_access_changed':'theme_analysis_unavailable';
  await db.query("UPDATE source_goals SET compatibility_json=jsonb_set(COALESCE(compatibility_json,'{}'::jsonb),'{theme_analysis_admission}',$3::jsonb) WHERE id=$1 AND space_id=$2",[g.id,g.space_id,{status:'blocked',code,version_id:g.active_version_id,checked_at:new Date().toISOString()}]);
 }
 const job=await new PgJobQueueRepository(db).enqueue({job_type:'source_goal_tick',space_id:g.space_id,user_id:g.owner_user_id,payload:{goal_id:g.id,version_id:g.active_version_id,...(edition?{edition}:{}),...(round?{round_id:round.id}:{})},max_attempts:2});
 return {status:'queued' as const,job_id:job.id};
}

/** Metadata-only admission; execution, budgets, cursors and materialization stay
 * in the canonical worker. A manual check never changes the automatic cadence. */
export async function requestGoalCheck(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,id:string,raw:unknown){
 const input=SourceGoalCheckRequestSchema.parse(raw);
 return withDbTransaction(db,async tx=>{
  await tx.query('SELECT id FROM source_goals WHERE id=$1 AND space_id=$2 FOR UPDATE',[id,identity.spaceId]);
  const g=await requireGoal(tx,identity,id,true);
  if(g.status!=='running'||g.compatibility_json?.execution_mode==='manual')throw sourceGoalError(409,'source_goal_stopped');
  if(g.active_version_id!==input.expected_version_id)throw sourceGoalError(409,'source_goal_message_superseded');
  if(g.compatibility_json?.scheduler_owner==='legacy'&&g.legacy_channel_id){
   await requireLegacyGoalSource(tx,config,identity,g,true);
   await tx.query('SELECT id FROM source_channels WHERE id=$1 AND space_id=$2 FOR UPDATE',[g.legacy_channel_id,g.space_id]);
   const pending=await tx.query<{id:string}>(`SELECT id FROM extraction_jobs WHERE space_id=$1 AND metadata_json->>'source_channel_id'=$2 AND status IN ('pending','running') LIMIT 1`,[g.space_id,g.legacy_channel_id]);
   if(pending.rows[0])return {status:'in_progress' as const,job_id:pending.rows[0].id};
   const job=await new PgSourcesRepository(tx,config).scanChannel(identity,g.legacy_channel_id);
   return {status:'queued' as const,job_id:job.id};
  }
  if(!g.active_version_id)throw sourceGoalError(409,'source_goal_execution_setup_required');
  const rows=await tx.query<{id:string;status:string;spec_json:SourceGoalBindingSpec;fixture_json:{authority_sha256?:string;collection_error?:string};ready:boolean}>(`SELECT id,status,spec_json,fixture_json,
   ((status IN ('active','cooldown') AND (retry_at IS NULL OR retry_at<=now())) OR status='collecting') AS ready
   FROM source_goal_bindings b WHERE goal_id=$1 AND space_id=$2 AND EXISTS(
    SELECT 1 FROM source_goal_versions v CROSS JOIN LATERAL jsonb_array_elements(v.plan_json->'sources') s
    WHERE v.id=$3 AND v.goal_id=$1 AND s->>'source_connection_id'=b.source_connection_id)
   ORDER BY b.id FOR UPDATE`,[id,g.space_id,g.active_version_id]);
  const bindings=rows.rows.filter(b=>b.ready||input.retry_failed&&retryableNativeCollection(b));
  if(!bindings.length)throw sourceGoalError(409,'source_cooldown');
  const active=await activeGoalIntent(tx,g);
  for(const b of bindings){
   const current=await preflightGoalSource(tx,config,identity,active,b.spec_json);
   if(!b.fixture_json.authority_sha256||b.fixture_json.authority_sha256!==goalSourceFingerprint(current))throw sourceGoalError(409,'source_authority_revoked');
  }
  const result=await enqueueGoalCollection(tx,g);
  // A queued/running Check is reused without reopening another source. Retry
  // clears only native execution backoff; history, failure count and cadence stay.
  if(result.status==='queued'&&input.retry_failed){
   const retry=bindings.filter(retryableNativeCollection).map(b=>b.id);
   if(retry.length)await tx.query("UPDATE source_goal_bindings SET status='active',retry_at=NULL,fixture_json=fixture_json-'collection_error',updated_at=now() WHERE goal_id=$1 AND space_id=$2 AND id=ANY($3::varchar[])",[id,g.space_id,retry]);
  }
  return result;
 });
}
