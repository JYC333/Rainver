import {randomUUID} from 'node:crypto';
import {withQueryableTransaction,HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {canReadProject} from '../../projects/access.js';
import {PgJobQueueRepository} from '../../jobs/repository.js';
import {PgBriefingRepository} from '../briefing/repository.js';
import {projectBriefing} from '../briefing/projection.js';
import {topicScope} from '../topics/scope.js';
import type {ThemeRound} from '../topics/rounds.js';
interface Section {goal_id:string;purpose_version_id:string;round_id:string;sequence:number;briefing_id:string;published_at:string}
interface Composition {id:string;space_id:string;project_id:string;revision:number;previous_id:string|null;sections_json:Section[];created_at:string;reason:string}
export async function queueProjectComposition(db:Queryable,spaceId:string,projectId:string,roundId?:string,scheduledAt?:Date){
 await withQueryableTransaction(db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`compose-job:${spaceId}:${projectId}:${roundId??'withdrawal'}`]);
  const pending=(await tx.query<{id:string}>("SELECT id FROM jobs WHERE space_id=$1 AND job_type='project_reading_compose' AND payload_json->>'project_id'=$2 AND COALESCE(payload_json->>'round_id','')=$3 AND status IN ('pending','claimed') ORDER BY created_at LIMIT 1",[spaceId,projectId,roundId??''])).rows[0];
  // A running handler may already have checked the barrier: retain a new wake
  // rather than coalescing an event into work that is about to finish.
  if(pending){if(!scheduledAt)await tx.query('UPDATE jobs SET scheduled_at=LEAST(scheduled_at,now()) WHERE id=$1',[pending.id]);return;}
  await new PgJobQueueRepository(tx).enqueue({job_type:'project_reading_compose',space_id:spaceId,user_id:null,payload:{project_id:projectId,...(roundId?{round_id:roundId}:{})},scheduled_at:scheduledAt,max_attempts:3});
 });
}
/** A sticky cutover flag is set only by explicit theme consent, never by GET or deployment. */
export async function projectReadingSwitched(db:Queryable,spaceId:string,projectId:string){return !!(await db.query("SELECT 1 FROM source_goals WHERE space_id=$1 AND project_id=$2 AND (compatibility_json->>'reading_composition_enabled'='true' OR status='running' AND compatibility_json->'theme_analysis'->>'enabled'='true' AND compatibility_json->'theme_analysis'->>'version_id'=active_version_id) LIMIT 1",[spaceId,projectId])).rows.length;}
/** No model invocation: under a short Project lock apply patches to the latest
 * version, preserving every untouched reference, position and original time. */
export async function composeProjectReading(db:Queryable,spaceId:string,projectId:string,roundId?:string){
 return withQueryableTransaction(db,async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`project-reading:${spaceId}:${projectId}`]);
  if(!(await tx.query('SELECT id FROM projects WHERE space_id=$1 AND id=$2',[spaceId,projectId])).rows.length)return null;
  let rounds:ThemeRound[]=[];
  if(roundId){
   const seed=(await tx.query<ThemeRound & {slot_key:string}>('SELECT * FROM project_reading_rounds WHERE space_id=$1 AND project_id=$2 AND id=$3',[spaceId,projectId,roundId])).rows[0];if(!seed)return null;
   const targets=seed.execution_json.project_targets;
   rounds=(await tx.query<ThemeRound>('SELECT * FROM project_reading_rounds WHERE space_id=$1 AND project_id=$2 AND slot_key=$3 ORDER BY goal_id',[spaceId,projectId,seed.slot_key])).rows.filter(r=>targets.some(t=>t.goal_id===r.goal_id&&t.version_id===r.version_id));
   if(rounds.length<targets.length||rounds.some(r=>['collecting','generating'].includes(r.status)))return null;
  }
  const old=(await tx.query<Composition>('SELECT * FROM project_reading_compositions WHERE space_id=$1 AND project_id=$2 ORDER BY revision DESC LIMIT 1',[spaceId,projectId])).rows[0];
  const active=(await tx.query<{id:string}> ("SELECT id FROM source_goals WHERE space_id=$1 AND project_id=$2 AND status='running' AND compatibility_json->'theme_analysis'->>'enabled'='true'",[spaceId,projectId])).rows.map(g=>g.id);
  const sections=(old?.sections_json??[]).filter(s=>active.includes(s.goal_id));
  for(const r of rounds){
   if(!active.includes(r.goal_id)||r.status!=='complete'||!r.briefing_id)continue;
   const repository=new PgBriefingRepository(tx),adapter=topicScope(spaceId,projectId,r.goal_id);
   const index=sections.findIndex(s=>s.goal_id===r.goal_id),previous=sections[index];
   let row=await repository.get(spaceId,r.briefing_id);
   if(!row||row.project_id!==projectId||row.scope_key!==adapter.scope.key||row.status!=='ready')continue;
   const restoring=!row.result_json?.topic;
   if(restoring){
    // A successful no-new check has no report of its own. Restore only a
    // missing section, from the published version that check actually froze;
    // never treat malformed, empty, failed or future output as a reusable report.
    if(index>=0||row.outcome!=='no_new_material'||row.result_json!==null||!row.previous_briefing_id)continue;
    const published=await repository.latestPublished(adapter.scope,row.cutoff_at);
    if(!published||published.id!==row.previous_briefing_id)continue;
    row=published;
   }
   if(row.project_id!==projectId||row.scope_key!==adapter.scope.key||row.status!=='ready'||!row.result_json?.topic)continue;
   // A reused briefing keeps its original purpose; never relabel it from the current Goal pointer.
   const purpose=row.context_json.find(c=>c.source.type==='goal_version')?.source.id;if(!purpose)continue;
   if(restoring&&purpose!==r.version_id)continue;
   if(previous&&(previous.sequence>=r.sequence||previous.briefing_id===row.id))continue;
   const shown=await projectBriefing(tx,repository,adapter,row);
   if(shown.visibility!=='visible')continue;
   const next:Section={goal_id:r.goal_id,purpose_version_id:purpose,round_id:r.id,sequence:r.sequence,briefing_id:row.id,published_at:new Date(row.completed_at??row.created_at).toISOString()};
   if(index<0){if(sections.length>=100)throw new HttpError(409,'Project composition supports at most 100 themes');sections.push(next);}else sections[index]=next;
  }
  if(!old&&!sections.length)return null;
  if(old&&JSON.stringify(sections)===JSON.stringify(old.sections_json))return old.id;
  const id=randomUUID();await tx.query('INSERT INTO project_reading_compositions(id,space_id,project_id,revision,previous_id,sections_json,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,spaceId,projectId,(old?.revision??0)+1,old?.id??null,JSON.stringify(sections),roundId?'theme_terminal':'theme_withdrawn']);return id;
 });
}
export async function readProjectComposition(db:Queryable,identity:SpaceUserIdentity,projectId:string,id?:string){
 if(!await canReadProject(db,identity.spaceId,projectId,identity.userId))throw new HttpError(404,'Project Reading not found');
 const rows=(await db.query<Composition>(`SELECT * FROM project_reading_compositions WHERE space_id=$1 AND project_id=$2 ${id?'AND id=$3':''} ORDER BY revision DESC LIMIT ${id?'1':'20'}`,[identity.spaceId,projectId,...(id?[id]:[])])).rows;
 if(id&&!rows.length)throw new HttpError(404,'Project Reading version not found');
 const repository=new PgBriefingRepository(db);
 const versions=await Promise.all(rows.slice(0,1).map(async row=>({id:row.id,revision:row.revision,previous_id:row.previous_id,created_at:new Date(row.created_at).toISOString(),reason:row.reason,sections:await Promise.all(row.sections_json.map(async s=>{
  const g=(await db.query("SELECT id FROM source_goals WHERE space_id=$1 AND project_id=$2 AND id=$3 AND status='running' AND compatibility_json->'theme_analysis'->>'enabled'='true'",[identity.spaceId,projectId,s.goal_id])).rows[0];
  const b=await repository.get(identity.spaceId,s.briefing_id);
  const shown=g&&b?.project_id===projectId&&b.scope_key===`following:${s.goal_id}`?await projectBriefing(db,repository,topicScope(identity.spaceId,projectId,s.goal_id),b):null;
  let purpose_text:string|null=null;if(shown?.visibility==='visible'){try{const p=JSON.parse(b!.context_json.find(c=>c.kind==='following_purpose')?.text??'null');if(typeof p?.intent==='string')purpose_text=[p.intent,typeof p.analysis_brief==='string'?p.analysis_brief:null].filter(Boolean).join('\n').slice(0,16000)}catch{/* Legacy unparseable context is unknown, never replaced by today's purpose. */}}
  return {...s,purpose_text,visibility:shown?.visibility==='visible'?'visible' as const:'withheld' as const,briefing:shown?.visibility==='visible'?shown:null};
 }))})));
 const rounds=(await db.query<{id:string;goal_id:string;status:string;error_code:string|null;coverage_json:Record<string,unknown>}>('SELECT DISTINCT ON (goal_id) id,goal_id,status,error_code,coverage_json FROM project_reading_rounds WHERE space_id=$1 AND project_id=$2 ORDER BY goal_id,sequence DESC LIMIT 100',[identity.spaceId,projectId])).rows;
 return {latest:versions[0]??null,history:rows.map(({id,revision,previous_id,created_at,reason})=>({id,revision,previous_id,created_at:new Date(created_at).toISOString(),reason})),rounds:rounds.map(r=>({id:r.id,goal_id:r.goal_id,status:r.status,error_code:r.error_code,coverage:r.coverage_json})),cross_theme_status:'not_generated' as const};
}
