import type {Queryable,SpaceUserIdentity} from '../../routeUtils/common.js';
import {HttpError} from '../../routeUtils/common.js';
import {canReadProject} from '../../projects/access.js';
import {PgBriefingRepository} from '../briefing/repository.js';
import {projectBriefing} from '../briefing/projection.js';
import {topicScope} from '../topics/scope.js';
import {projectReadingDay,assertEditionDate} from './day.js';
import {readingDayRounds} from './rounds.js';
import type {Composition} from './types.js';
export async function readProjectComposition(db:Queryable,identity:SpaceUserIdentity,projectId:string,id?:string,date?:string){
 if(!await canReadProject(db,identity.spaceId,projectId,identity.userId))throw new HttpError(404,'Project Reading not found');
 const today=await projectReadingDay(db,identity.spaceId,projectId);if(date)assertEditionDate(date);
 const rows=(await db.query<Composition>(`SELECT c.*,c.edition_date::text AS edition_date FROM project_reading_compositions c WHERE c.space_id=$1 AND c.project_id=$2 ${id?'AND c.id=$3':'AND c.edition_date=$3::date'} ORDER BY c.revision DESC LIMIT 1`,[identity.spaceId,projectId,id??date??today.date])).rows;
 if(id&&!rows.length)throw new HttpError(404,'Project Reading version not found');
 const day=rows[0]?.edition_date??date??today.date;
 // The selected body does not determine which sibling versions remain navigable.
 type Version=Omit<Composition,'space_id'|'project_id'|'sections_json'|'rounds_json'>;
 let history=(await db.query<Version>(`SELECT id,revision,previous_id,created_at,reason,edition_date::text AS edition_date,timezone,day_revision FROM project_reading_compositions WHERE space_id=$1 AND project_id=$2 AND edition_date=$3::date ORDER BY revision DESC LIMIT 20`,[identity.spaceId,projectId,day])).rows;
 if(rows[0]&&!history.some(v=>v.id===rows[0].id))history=[...history.slice(0,19),rows[0]];
 const repository=new PgBriefingRepository(db);
 const versions=await Promise.all(rows.slice(0,1).map(async row=>({id:row.id,revision:row.revision,previous_id:row.previous_id,created_at:new Date(row.created_at).toISOString(),reason:row.reason,edition_date:row.edition_date,timezone:row.timezone,day_revision:row.day_revision,sections:await Promise.all(row.sections_json.map(async s=>{
  const g=(await db.query("SELECT id FROM source_goals WHERE space_id=$1 AND project_id=$2 AND id=$3 AND status<>'deleted'",[identity.spaceId,projectId,s.goal_id])).rows[0];
  const b=await repository.get(identity.spaceId,s.briefing_id);
  const shown=g&&b?.project_id===projectId&&b.scope_key===`following:${s.goal_id}`?await projectBriefing(db,repository,topicScope(identity.spaceId,projectId,s.goal_id),b):null;
  let purpose_text:string|null=null;if(shown?.visibility==='visible'){try{const p=JSON.parse(b!.context_json.find(c=>c.kind==='following_purpose')?.text??'null');if(typeof p?.intent==='string')purpose_text=[p.intent,typeof p.analysis_brief==='string'?p.analysis_brief:null].filter(Boolean).join('\n').slice(0,16000)}catch{/* Invalid purpose context is unavailable, never replaced by today's purpose. */}}
  return {...s,purpose_text,visibility:shown?.visibility==='visible'?'visible' as const:'withheld' as const,briefing:shown?.visibility==='visible'?shown:null};
 }))})));
 // Exact published versions are immutable. A date view follows that day's
 // admitted work, including analysis delayed past midnight, without publishing.
 const frozen=!!id;
 const rounds=frozen?(rows[0]?.rounds_json??[]):await readingDayRounds(db,identity.spaceId,projectId,{date:day,timezone:today.timezone});
 const job=frozen?undefined:(await db.query<{status:string}>(`SELECT j.status FROM jobs j JOIN project_reading_rounds r ON r.id=j.payload_json->>'round_id' AND r.space_id=j.space_id AND r.project_id=$2 WHERE j.space_id=$1 AND j.job_type='project_reading_compose' AND j.payload_json->>'project_id'=$2 AND r.execution_json->'edition'->>'date'=$3 ORDER BY (j.status IN ('pending','claimed','running')) DESC,j.created_at DESC,j.id DESC LIMIT 1`,[identity.spaceId,projectId,day])).rows[0];
 const composition_status=rounds.some(r=>['collecting','generating','blocked','awaiting_analysis'].includes(r.status))?'waiting_for_analysis' as const:!frozen&&job?.status==='pending'?'queued' as const:!frozen&&job&&['claimed','running'].includes(job.status)?'running' as const:!frozen&&job?.status==='failed'?'failed' as const:rows[0]?'complete' as const:'idle' as const;
 return {date:day,timezone:rows[0]?.timezone??today.timezone,today:today.date,composition_status,latest:versions[0]??null,history:history.map(({id,revision,previous_id,created_at,reason,edition_date,timezone,day_revision})=>({id,revision,previous_id,created_at:new Date(created_at).toISOString(),reason,edition_date,timezone,day_revision})),rounds:rounds.map(r=>({id:r.id,goal_id:r.goal_id,status:r.status,error_code:r.error_code,coverage:r.coverage})),cross_theme_status:'not_generated' as const};
}
