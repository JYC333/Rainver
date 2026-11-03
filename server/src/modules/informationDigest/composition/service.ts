import {readingDayRounds} from './rounds.js';
import type {Section,Composition} from './types.js';
export {readProjectComposition} from './projection.js';
import {randomUUID} from 'node:crypto';
import {withQueryableTransaction,HttpError,type Queryable} from '../../routeUtils/common.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import {PgBriefingRepository} from '../briefing/repository.js';
import {projectBriefing} from '../briefing/projection.js';
import {topicScope} from '../topics/scope.js';
import type {ThemeRound} from '../topics/rounds.js';

/** Publication belongs to an admitted analysis round, never a collection/day wake. */
export async function queueProjectComposition(db:Queryable,spaceId:string,projectId:string,roundId:string,scheduledAt?:Date){
 await withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`compose-job:${spaceId}:${projectId}:${roundId}`]);
  const pending=(await tx.query<{id:string}>("SELECT id FROM jobs WHERE space_id=$1 AND job_type='project_reading_compose' AND payload_json->>'project_id'=$2 AND payload_json->>'round_id'=$3 AND status IN ('pending','claimed') ORDER BY created_at LIMIT 1",[spaceId,projectId,roundId])).rows[0];
  if(pending){if(!scheduledAt)await tx.query('UPDATE jobs SET scheduled_at=LEAST(scheduled_at,now()) WHERE id=$1',[pending.id]);return;}
  await new PgJobQueueRepository(tx).enqueue({job_type:'project_reading_compose',space_id:spaceId,user_id:null,payload:{project_id:projectId,round_id:roundId},scheduled_at:scheduledAt,max_attempts:3});
 });
}

/** Round/audit records own preparation and failure. This writer publishes only
 * new analysis bodies, once the admitted cohort is complete, under the Project lock. */
export async function composeProjectReading(db:Queryable,spaceId:string,projectId:string,roundId:string){
 if(!roundId)throw new HttpError(422,'An analysis round is required for publication');
 return withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`project-reading:${spaceId}:${projectId}`]);
  if(!(await tx.query('SELECT id FROM projects WHERE space_id=$1 AND id=$2 AND deleted_at IS NULL',[spaceId,projectId])).rows.length)return null;
  const seed=(await tx.query<ThemeRound & {slot_key:string}>('SELECT * FROM project_reading_rounds WHERE space_id=$1 AND project_id=$2 AND id=$3',[spaceId,projectId,roundId])).rows[0];
  if(!seed)return null;
  const day=seed.execution_json.edition,targets=seed.execution_json.project_targets;
  const rounds=(await tx.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE space_id=$1 AND project_id=$2 AND slot_key=$3 ORDER BY goal_id',[spaceId,projectId,seed.slot_key])).rows.filter(r=>targets.some(t=>t.goal_id===r.goal_id&&t.version_id===r.version_id));
  if(rounds.length!==targets.length||rounds.some(r=>r.status!=='complete'))return null;
  const old=(await tx.query<Composition>(`SELECT c.*,c.edition_date::text AS edition_date FROM project_reading_compositions c WHERE c.space_id=$1 AND c.project_id=$2 AND c.edition_date=$3::date ORDER BY c.revision DESC LIMIT 1`,[spaceId,projectId,day.date])).rows[0];
  const active=(await tx.query<{id:string}>("SELECT id FROM source_goals WHERE space_id=$1 AND project_id=$2 AND status<>'deleted'",[spaceId,projectId])).rows.map(g=>g.id);
  const sections=(old?.sections_json??[]).filter(s=>active.includes(s.goal_id));
  const repository=new PgBriefingRepository(tx);
  let hasNewAnalysis=false;
  for(const round of rounds){
   if(!active.includes(round.goal_id)||!round.briefing_id)continue;
   const row=await repository.get(spaceId,round.briefing_id);
   // A no-new/empty check has no new body. Its previous report remains in its
   // original edition; it cannot become today's first version by being copied.
   if(!row||row.project_id!==projectId||row.scope_key!==`following:${round.goal_id}`||row.status!=='ready'||!row.result_json?.topic)continue;
   const index=sections.findIndex(s=>s.goal_id===round.goal_id),previous=sections[index];
   if(previous&&(previous.sequence>=round.sequence||previous.briefing_id===row.id))continue;
   const purpose=row.context_json.find(c=>c.source.type==='goal_version')?.source.id;
   if(!purpose)continue;
   const shown=await projectBriefing(tx,repository,topicScope(spaceId,projectId,round.goal_id),row);
   if(shown.visibility!=='visible')continue;
   const next:Section={goal_id:round.goal_id,purpose_version_id:purpose,round_id:round.id,sequence:round.sequence,briefing_id:row.id,published_at:new Date(row.completed_at??row.created_at).toISOString()};
   if(index<0){if(sections.length>=100)throw new HttpError(409,'Project composition supports at most 100 themes');sections.push(next);}else sections[index]=next;
   hasNewAnalysis=true;
  }
  if(!hasNewAnalysis)return old?.id??null;
  const snapshots=await readingDayRounds(tx,spaceId,projectId,day);
  const last=(await tx.query<{id:string;revision:number}>('SELECT id,revision FROM project_reading_compositions WHERE space_id=$1 AND project_id=$2 ORDER BY revision DESC LIMIT 1',[spaceId,projectId])).rows[0];
  const id=randomUUID();
  await tx.query(`INSERT INTO project_reading_compositions(id,space_id,project_id,revision,previous_id,sections_json,reason,edition_date,timezone,day_revision,rounds_json) VALUES($1,$2,$3,$4,$5,$6,'theme_terminal',$7::date,$8,$9,$10::jsonb)`,[id,spaceId,projectId,(last?.revision??0)+1,old?.id??last?.id??null,JSON.stringify(sections),day.date,day.timezone,(old?.day_revision??0)+1,JSON.stringify(snapshots)]);
  return id;
 });
}
