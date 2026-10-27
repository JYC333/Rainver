import {computeNextCheckAt} from '../sourceScanCadence.js';
import {pauseTransfer,restoreTransfer,assertTransferUnchanged,type TransferState} from './transferState.js';
import {upsertSourceChannelScanTask,getSourceChannelScanTask} from '../sourceConnectionScheduler.js';
import {computeNextRunAtFromScheduleRule} from '../sourceScheduleInput.js';
import type {ServerConfig} from '../../../config.js';
import {randomUUID} from 'node:crypto';
import {SourceGoalBudgetSchema} from '@rainver/protocol';
import {HttpError,withDbTransaction,type Queryable,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {assertSourceConnectionManageable} from '../sourceConnectionAccess.js';
import {resolveContentCreationContext} from '../../access/creationContext.js';
import {contentDecisionFromDb} from '../../access/contentAccessQuery.js';
import {requireGoal,requireLegacyGoalSource} from './access.js';
/** Metadata-only compatibility mapping. Existing executors, budgets, cursor,
 * subscriptions and items remain authoritative; mapping itself sends nothing. */
export async function mapLegacyGoal(db:Pool,identity:SpaceUserIdentity,channelId:string,dryRun=false){
 return withDbTransaction(db,async tx=>{
  const r=await tx.query(`SELECT ch.*,sc.owner_user_id,sc.project_id,sc.name AS source_name FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id WHERE ch.id=$1 AND ch.space_id=$2 AND sc.deleted_at IS NULL FOR UPDATE OF ch`,[channelId,identity.spaceId]);const c=r.rows[0];if(!c || c.owner_user_id!==identity.userId)throw new HttpError(404,'Source not found');
  await assertSourceConnectionManageable(tx,identity,String(c.source_connection_id));await resolveContentCreationContext(tx,{userId:identity.userId,requestSpaceId:identity.spaceId,projectId:c.project_id as string|null});if(await contentDecisionFromDb(tx,identity,'source_connection',String(c.source_connection_id),{includeOversight:false})!=='full')throw new HttpError(403,'Source content unavailable');
  const existing=await tx.query('SELECT * FROM source_goals WHERE space_id=$1 AND legacy_channel_id=$2',[identity.spaceId,channelId]);if(existing.rows[0])return {goal:existing.rows[0],created:false,dry_run:dryRun};
  const intent=`${c.source_name} — ${c.name}`;if(dryRun)return {created:false,dry_run:true,source_connection_id:c.source_connection_id,source_channel_id:channelId,intent};
  const profile=await tx.query(`SELECT a.id,p.id AS profile_id FROM agents a JOIN agent_runtime_profiles p ON p.agent_id=a.id AND p.space_id=a.space_id WHERE a.space_id=$1 AND a.owner_user_id=$2 AND a.status='active' AND a.agent_kind<>'system_assistant' AND p.enabled=true ORDER BY p.is_default DESC,a.created_at LIMIT 1`,[identity.spaceId,identity.userId]);
  const scheduler=await tx.query(`SELECT * FROM scheduler_tasks WHERE space_id=$1 AND ((task_type='source_channel_scan' AND task_key=$2) OR (task_type='project_information_monitoring' AND task_key=$3 AND EXISTS(SELECT 1 FROM projects p JOIN project_information_monitoring_versions v ON v.id=p.active_information_monitoring_version_id WHERE p.id=$3 AND v.config_json->>'source_channel_id'=$2)))`,[identity.spaceId,channelId,c.project_id]);
  const snapshot={scheduler_owner:'legacy',channel:{fetch_frequency:c.fetch_frequency,status:c.status},tasks:scheduler.rows,mapped_at:new Date().toISOString(),original_intent_known:false};
  const result=await tx.query(`INSERT INTO source_goals(id,space_id,owner_user_id,project_id,agent_id,runtime_profile_id,intent_json,budget_json,status,legacy_channel_id,compatibility_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(space_id,legacy_channel_id) DO NOTHING RETURNING *`,[randomUUID(),identity.spaceId,identity.userId,c.project_id,profile.rows[0]?.id??null,profile.rows[0]?.profile_id??null,{intent,includes:[],excludes:[]},SourceGoalBudgetSchema.parse({}),c.status==='active'?'running':'paused',channelId,snapshot]);
  return {goal:result.rows[0]??(await tx.query('SELECT * FROM source_goals WHERE space_id=$1 AND legacy_channel_id=$2',[identity.spaceId,channelId])).rows[0],created:!!result.rows[0],dry_run:false};
 });
}
export async function takeGoalSchedulingOwnership(db:Queryable,goalId:string,spaceId:string,channelId:string){
 const g=(await db.query<{legacy_channel_id:string;compatibility_json:Record<string,unknown>;project_id:string|null;active_version_id:string|null}>('SELECT * FROM source_goals WHERE id=$1 AND space_id=$2',[goalId,spaceId])).rows[0];if(!g)throw new HttpError(404,'Goal unavailable');

 if(g.project_id)await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR UPDATE',[g.project_id,spaceId]);
 await db.query('SELECT id FROM source_channels WHERE id=$1 AND space_id=$2 FOR UPDATE',[channelId,spaceId]);

 const competing=await db.query(`SELECT 1 FROM source_goals g JOIN source_goal_bindings b ON b.goal_id=g.id WHERE g.space_id=$1 AND g.id<>$2 AND b.spec_json->>'source_channel_id'=$3 AND g.status<>'deleted' AND g.active_version_id IS NOT NULL`,[spaceId,goalId,channelId]);if(competing.rows.length)throw new HttpError(409,'Source already has scheduling owner');
 const previous=(g.compatibility_json?.transfers as Record<string,TransferState>|undefined)?.[channelId];
 if(previous){if(g.compatibility_json?.scheduler_owner!=='goal'||!g.active_version_id)throw new HttpError(409,'source_goal_transfer_changed');const owned=await db.query(`SELECT 1 FROM source_goal_bindings WHERE goal_id=$1 AND space_id=$2 AND spec_json->>'source_channel_id'=$3`,[goalId,spaceId,channelId]);if(!owned.rows[0])throw new HttpError(409,'source_goal_transfer_changed');await assertTransferUnchanged(db,spaceId,channelId,g.project_id,previous);return;}
 const pending=await db.query(`SELECT 1 FROM extraction_jobs WHERE space_id=$1 AND metadata_json->>'source_channel_id'=$2 AND status IN ('pending','running') UNION ALL SELECT 1 FROM source_handler_runs WHERE space_id=$1 AND source_connection_id=(SELECT source_connection_id FROM source_channels WHERE id=$2) AND status IN ('queued','running') UNION ALL SELECT 1 FROM project_operations WHERE space_id=$1 AND project_id=$3 AND status='active' AND progress_json->>'purpose'='information_monitoring'`,[spaceId,channelId,g.project_id]);if(pending.rows.length)throw new HttpError(409,'Existing collection must finish before scheduler transfer');
 const transfer=await pauseTransfer(db,spaceId,channelId,g.project_id);
 await db.query('UPDATE source_goals SET compatibility_json=$2 WHERE id=$1',[goalId,{...g.compatibility_json,scheduler_owner:'goal',transfers:{...((g.compatibility_json?.transfers??{}) as object),[channelId]:transfer}}]);
}
/** Safe rollback refuses after new collection or concurrent legacy edits, rather
 * than guessing an implementation-specific cursor or replaying successful work. */
export async function rollbackGoalCompatibility(db:Pool,identity:SpaceUserIdentity,goalId:string){
 return withDbTransaction(db,async tx=>{
  await tx.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[goalId]);const g=await requireGoal(tx,identity,goalId,true);const compat=g.compatibility_json as {scheduler_owner?:string;transfer?:{tasks:Array<Record<string,unknown>>;channel:{fetch_frequency:string;status:string}}}|null;
  if(!compat)throw new HttpError(409,'Not a compatibility goal');
  if(compat.scheduler_owner==='legacy')return {status:'legacy',changed:false};
  const used=await tx.query('SELECT 1 FROM source_goal_runs WHERE goal_id=$1 LIMIT 1',[goalId]);if(used.rows.length)throw new HttpError(409,'Collected work exists; safe automatic rollback unavailable');
  const transfers=(g.compatibility_json?.transfers??{}) as Record<string,TransferState>;
  if(!Object.keys(transfers).length)throw new HttpError(409,'source_goal_transfer_changed');
  if(g.project_id)await tx.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR UPDATE',[g.project_id,identity.spaceId]);
  for(const [channelId,transfer] of Object.entries(transfers).sort(([a],[b])=>a.localeCompare(b))){
   const source=(await tx.query('SELECT source_connection_id FROM source_channels WHERE id=$1 AND space_id=$2',[channelId,identity.spaceId])).rows[0];if(!source)throw new HttpError(404,'Source unavailable');await assertSourceConnectionManageable(tx,identity,String(source.source_connection_id));
   await restoreTransfer(tx,identity.spaceId,channelId,g.project_id,transfer);
  }
  await tx.query(`UPDATE scheduler_tasks SET status='paused',next_run_at=NULL WHERE task_type='source_goal_tick' AND task_key=$1 AND space_id=$2`,[goalId,identity.spaceId]);
  await tx.query(`UPDATE source_goal_bindings SET status='paused' WHERE goal_id=$1`,[goalId]);
  await tx.query(`UPDATE source_goals SET status='draft',active_version_id=NULL,start_key=NULL,compatibility_json=(compatibility_json-'transfer'-'transfers')||jsonb_build_object('scheduler_owner','legacy','transfer_audit',COALESCE(compatibility_json->'transfer_audit','[]'::jsonb)||jsonb_build_array(jsonb_build_object('rolled_back_at',now(),'transfers',compatibility_json->'transfers'))) WHERE id=$1`,[goalId]);return {status:'legacy',changed:true};
 });
}

export async function setLegacyGoalPaused(db:Queryable,identity:SpaceUserIdentity,goalId:string,paused:boolean,config:ServerConfig){
 const g=await requireGoal(db,identity,goalId,true);if(!g.legacy_channel_id || g.compatibility_json?.scheduler_owner!=='legacy')return false;
 await requireLegacyGoalSource(db,config,identity,g,true);
 if(g.project_id){
  const monitoring=(await db.query(`SELECT p.active_information_monitoring_version_id AS id FROM projects p JOIN project_information_monitoring_versions v ON v.id=p.active_information_monitoring_version_id WHERE p.id=$1 AND p.space_id=$2 AND v.config_json->>'source_channel_id'=$3`,[g.project_id,identity.spaceId,g.legacy_channel_id])).rows[0];
  if(monitoring){const {ProjectMonitoringService}=await import('../../projects/monitoring/service.js');await new ProjectMonitoringService(db,config).setPaused(identity,g.project_id,String(monitoring.id),paused);}
 }
 const channel=(await db.query('SELECT * FROM source_channels WHERE id=$1 AND space_id=$2 FOR UPDATE',[g.legacy_channel_id,identity.spaceId])).rows[0];if(!channel)throw new HttpError(404,'Source unavailable');
 await db.query('UPDATE source_channels SET status=$2 WHERE id=$1',[g.legacy_channel_id,paused?'paused':'active']);
 const rule=channel.schedule_rule_json as import('../sourceScheduleInput.js').SourceScheduleRule|null;
 const scheduled=!paused&&channel.fetch_frequency!=='manual';
 const existing=await getSourceChannelScanTask(db,g.legacy_channel_id);
 await upsertSourceChannelScanTask(db,{lastRunAt:existing?.last_run_at?new Date(existing.last_run_at as string).toISOString():null,channel:{id:g.legacy_channel_id,space_id:identity.spaceId,owner_user_id:identity.userId,status:paused?'paused':'active',fetch_frequency:String(channel.fetch_frequency)},nextRunAt:scheduled?(rule?computeNextRunAtFromScheduleRule(rule,new Date()):computeNextCheckAt(String(channel.fetch_frequency),new Date())):null});
 // A manual channel has no automatic owner; never overwrite the Project service's decision.
 if(!scheduled)await db.query("UPDATE scheduler_tasks SET status='paused',next_run_at=NULL WHERE space_id=$1 AND task_type='source_channel_scan' AND task_key=$2",[identity.spaceId,g.legacy_channel_id]);return true;
}

export async function assertLegacySourceOwner(db:Queryable,spaceId:string,channelId:string){
 const owner=await db.query(`SELECT 1 FROM source_goal_bindings b JOIN source_goals g ON g.id=b.goal_id AND g.space_id=b.space_id WHERE g.space_id=$1 AND b.spec_json->>'source_channel_id'=$2 AND g.active_version_id IS NOT NULL AND g.status<>'deleted'`,[spaceId,channelId]);if(owner.rows.length)throw new HttpError(409,'source_goal_owns_schedule');
}

/** Read projection only; the original task/cursor remains authoritative until transfer. */
export async function legacyGoalView(db:Queryable,g:{space_id:string;legacy_channel_id?:string|null;project_id:string|null;compatibility_json?:Record<string,unknown>|null}){
 if(!g.legacy_channel_id)return null;
 const c=(await db.query<{id:string;source_connection_id:string;name:string;channel_name:string;status:string}>(`SELECT ch.id,sc.id AS source_connection_id,sc.name,ch.name AS channel_name,ch.status FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id WHERE ch.id=$1 AND ch.space_id=$2 AND sc.deleted_at IS NULL`,[g.legacy_channel_id,g.space_id])).rows[0];
 if(!c)return null;
 const task=(await db.query(`SELECT * FROM scheduler_tasks WHERE space_id=$1 AND ((task_type='source_channel_scan' AND task_key=$2) OR (task_type='project_information_monitoring' AND task_key=$3 AND EXISTS(SELECT 1 FROM projects p JOIN project_information_monitoring_versions v ON v.id=p.active_information_monitoring_version_id WHERE p.id=$3 AND v.config_json->>'source_channel_id'=$2))) ORDER BY CASE WHEN task_type='project_information_monitoring' THEN 0 ELSE 1 END LIMIT 1`,[g.space_id,g.legacy_channel_id,g.project_id])).rows[0];
 return {...c,scheduler_owner:String(g.compatibility_json?.scheduler_owner??'legacy'),schedule:task?{status:task.status,next_run_at:task.next_run_at,last_run_at:task.last_run_at}:null};
}

/** Resolve only an existing owner-visible mapping; mounting a deep link writes nothing. */
export async function findLegacyGoal(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,channelId:string){
 const c=(await db.query('SELECT sc.id,sc.owner_user_id FROM source_connections sc JOIN source_channels ch ON ch.source_connection_id=sc.id AND ch.space_id=sc.space_id WHERE ch.id=$1 AND sc.space_id=$2 AND sc.deleted_at IS NULL',[channelId,identity.spaceId])).rows[0];
 if(!c||c.owner_user_id!==identity.userId)throw new HttpError(404,'Source unavailable');
 if(await contentDecisionFromDb(db,identity,'source_connection',String(c.id),{includeOversight:false})!=='full')throw new HttpError(404,'Source unavailable');
 const found=(await db.query(`SELECT g.id,g.status FROM source_goals g WHERE g.space_id=$1 AND g.owner_user_id=$3 AND (g.legacy_channel_id=$2 OR (g.active_version_id IS NOT NULL AND g.status<>'deleted' AND EXISTS(SELECT 1 FROM source_goal_bindings b WHERE b.goal_id=g.id AND b.space_id=g.space_id AND b.spec_json->>'source_channel_id'=$2))) ORDER BY (g.active_version_id IS NOT NULL AND g.status<>'deleted') DESC LIMIT 1`,[identity.spaceId,channelId,identity.userId])).rows[0];
 if(!found)return {goal_id:null};if(found.status==='deleted')throw new HttpError(409,'source_goal_stopped');
 const g=await requireGoal(db,identity,String(found.id));await requireLegacyGoalSource(db,config,identity,g);return {goal_id:g.id};
}
