import {projectReadingDay} from '../composition/day.js';
import type {EditionDay} from '../composition/types.js';
import {queueProjectComposition} from '../composition/service.js';
import {nativeProfileFingerprint} from '../../sources/index.js';
import {topicScope} from './scope.js';
import type {BriefingContextEntry} from '../briefing/contract.js';
import {randomUUID} from 'node:crypto';
import {PROJECT_THEME_LIMITS} from '@rainver/protocol';
import type {Queryable} from '../../routeUtils/common.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
export interface CollectionTarget {binding_id:string;revision:number;audit_id:string;previous_audit_ids?:string[]}
export interface ThemeRound {id:string;space_id:string;project_id:string;goal_id:string;version_id:string;sequence:number;status:string;targets_json:CollectionTarget[];execution_json:{session_config?:import('@rainver/protocol').RuntimeSessionConfigSelection[];edition:EditionDay;profile_hash:string;input_cutoff?:string;agent_id:string;runtime_profile_id:string;frozen_context:BriefingContextEntry[];project_targets:Array<{goal_id:string;version_id:string|null}>};briefing_id:string|null;deadline_at:string;coverage_json:Record<string,unknown>;error_code:string|null;created_at:string}
/** Caller holds the canonical goal admission lock. No opt-in -> no new work. */
export async function beginThemeRound(db:Queryable,g:{id:string;space_id:string;project_id:string|null;active_version_id:string|null;owner_user_id:string;compatibility_json?:Record<string,unknown>|null},slot:string,projectTargets?:Array<{goal_id:string;version_id:string|null}>,edition?:EditionDay){
 const consent=g.compatibility_json?.theme_analysis as {enabled?:boolean;version_id?:string;agent_id:string;runtime_profile_id:string;session_config?:import('@rainver/protocol').RuntimeSessionConfigSelection[]}|undefined;
 if(!g.project_id||!g.active_version_id||!consent?.enabled||consent.version_id!==g.active_version_id)return null;
 const old=(await db.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE space_id=$1 AND goal_id=$2 AND slot_key=$3',[g.space_id,g.id,slot])).rows[0];if(old)return old;
 const bindings=(await db.query<{id:string;revision:number}>("SELECT id,revision FROM source_goal_bindings WHERE space_id=$1 AND goal_id=$2 AND status IN ('active','cooldown','collecting') AND (retry_at IS NULL OR retry_at<=now()) ORDER BY id",[g.space_id,g.id])).rows;
 edition??=await projectReadingDay(db,g.space_id,g.project_id);
 const context=await topicScope(g.space_id,g.project_id,g.id,g.active_version_id).context(db);
 const targets=bindings.map(b=>({binding_id:b.id,revision:b.revision,audit_id:randomUUID()}));const id=randomUUID();
 const row=(await db.query<ThemeRound>(`INSERT INTO project_reading_rounds(id,space_id,project_id,goal_id,version_id,sequence,slot_key,targets_json,execution_json,deadline_at) SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,$5::varchar,COALESCE(max(sequence),0)+1,$6::varchar,$7::jsonb,$8::jsonb,now()+make_interval(secs=>$9::integer) FROM project_reading_rounds WHERE space_id=$2 AND goal_id=$4 RETURNING *`,[id,g.space_id,g.project_id,g.id,g.active_version_id,slot,JSON.stringify(targets),{edition,agent_id:consent.agent_id,runtime_profile_id:consent.runtime_profile_id,...(consent.session_config?{session_config:consent.session_config}:{}),profile_hash:await nativeProfileFingerprint(db,consent.runtime_profile_id),frozen_context:context,project_targets:projectTargets??[{goal_id:g.id,version_id:g.active_version_id}]},PROJECT_THEME_LIMITS.collectionDeadlineSeconds])).rows[0]!;
 await new PgJobQueueRepository(db).enqueue({job_type:'project_reading_theme',space_id:g.space_id,user_id:g.owner_user_id,payload:{round_id:id},scheduled_at:new Date(row.deadline_at),max_attempts:2});
 await queueProjectComposition(db,g.space_id,g.project_id,id,new Date(row.deadline_at));
 return row;
}
/** Existing scheduler/reconciler event, never a new timer or polling loop. */
export async function wakeThemeRounds(db:Queryable,spaceId:string,goalId:string){
 const rows=(await db.query<{id:string;owner_user_id:string}>(`SELECT r.id,g.owner_user_id FROM project_reading_rounds r JOIN source_goals g ON g.id=r.goal_id AND g.space_id=r.space_id WHERE r.space_id=$1 AND r.goal_id=$2 AND (r.status='collecting' OR r.status='blocked' AND r.error_code='theme_scope_busy') ORDER BY r.sequence LIMIT 20`,[spaceId,goalId])).rows;
 for(const r of rows)if(!(await db.query(`SELECT 1 FROM jobs WHERE space_id=$1 AND job_type='project_reading_theme' AND payload_json->>'round_id'=$2 AND status IN ('pending','claimed') AND scheduled_at<=now()`,[spaceId,r.id])).rows.length)await new PgJobQueueRepository(db).enqueue({job_type:'project_reading_theme',space_id:spaceId,user_id:r.owner_user_id,payload:{round_id:r.id},max_attempts:2});
}

/** Terminal publication hook; only marks rows associated with that canonical
 * version, then wakes an already-admitted round waiting for the scope. */
export async function finishThemeRounds(db:Queryable,spaceId:string,goalId:string){
 await db.query(`UPDATE project_reading_rounds r SET status=CASE WHEN b.status='ready' THEN 'complete' ELSE 'blocked' END,error_code=b.error_code,updated_at=now() FROM information_briefings b WHERE r.space_id=$1 AND r.goal_id=$2 AND r.briefing_id=b.id AND b.space_id=r.space_id AND r.status='generating' AND b.status IN ('ready','failed','cancelled')`,[spaceId,goalId]);
 const finished=(await db.query<ThemeRound>("SELECT * FROM project_reading_rounds WHERE space_id=$1 AND goal_id=$2 AND status IN ('complete','blocked','superseded') ORDER BY sequence DESC LIMIT 20",[spaceId,goalId])).rows;
 for(const r of finished)await queueProjectComposition(db,spaceId,r.project_id,r.id);
 await wakeThemeRounds(db,spaceId,goalId);
}
export async function themeCollectionTargets(db:Queryable,id:string,spaceId:string,goalId:string){return (await db.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE id=$1 AND space_id=$2 AND goal_id=$3',[id,spaceId,goalId])).rows[0]?.targets_json;}
/** A crashed deterministic collector gets a new audit identity under the same
 * logical target. Its old late callback cannot overwrite the new attempt. */
export async function retryThemeCollectionTarget(db:Queryable,roundId:string,bindingId:string,oldAuditId:string){
 const r=(await db.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE id=$1 FOR UPDATE',[roundId])).rows[0];
 if(!r||r.status!=='collecting'||Date.parse(String(r.deadline_at))<=Date.now())return null;
 const target=r.targets_json.find(t=>t.binding_id===bindingId&&t.audit_id===oldAuditId);if(!target)return null;
 const previous=target.previous_audit_ids??[];if(previous.length>=1)return null;
 const id=randomUUID();target.previous_audit_ids=[...previous,oldAuditId];target.audit_id=id;
 await db.query('UPDATE project_reading_rounds SET targets_json=$2,updated_at=now() WHERE id=$1',[roundId,JSON.stringify(r.targets_json)]);
 return id;
}

/** Original preparation can finish after the collection Run's final callback.
 * Wake only already admitted rounds, through the existing durable queue. */
export async function wakeThemeRoundsForItem(db:Queryable,spaceId:string,itemId:string){
 const goals=(await db.query<{goal_id:string}>(`SELECT DISTINCT gi.goal_id FROM source_goal_items gi JOIN project_reading_rounds r ON r.goal_id=gi.goal_id AND r.space_id=gi.space_id WHERE gi.space_id=$1 AND gi.source_item_id=$2 AND r.status='collecting'`,[spaceId,itemId])).rows;
 for(const g of goals)await wakeThemeRounds(db,spaceId,g.goal_id);
}

/** Collection workers recover the date from the owning admitted round, rather
 * than making completion time the publication day after restart. */
export async function themeCollectionDay(db:Queryable,spaceId:string,goalId:string,roundId:string){
 const round=(await db.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE id=$1 AND space_id=$2 AND goal_id=$3',[roundId,spaceId,goalId])).rows[0];
 return round?round.execution_json.edition:undefined;
}
