import type {Queryable} from '../../routeUtils/common.js';
import {goalReadingDayChecks} from '../../sources/index.js';
import {projectRoundState} from '../topics/roundProjection.js';
import type {EditionDay,RoundSummary} from './types.js';

/** The same safe projection is used for a live day and an immutable revision. */
export async function readingDayRounds(db:Queryable,spaceId:string,projectId:string,day:EditionDay):Promise<RoundSummary[]>{
 const rows=(await db.query<{id:string;goal_id:string;status:string;error_code:string|null;coverage_json:Record<string,unknown>;analysis_present:boolean;targets_json:Array<{audit_id:string}>;created_at:string}>(`SELECT DISTINCT ON (r.goal_id) r.id,r.goal_id,r.status,r.error_code,r.coverage_json,r.targets_json,r.created_at::text,(b.id IS NOT NULL) AS analysis_present
 FROM project_reading_rounds r LEFT JOIN information_briefings b ON b.id=r.briefing_id AND b.space_id=r.space_id
 WHERE r.space_id=$1 AND r.project_id=$2 AND r.execution_json->'edition'->>'date'=$3 ORDER BY r.goal_id,r.sequence DESC LIMIT 100`,[spaceId,projectId,day.date])).rows;
 const checks=await goalReadingDayChecks(db,spaceId,projectId,day.date);
 const result=new Map<string,RoundSummary>();
 for(const r of rows)result.set(r.goal_id,{id:r.id,goal_id:r.goal_id,...projectRoundState(r,r.analysis_present),coverage:r.coverage_json} as RoundSummary);
 for(const {audit_ids,started_at,...check} of checks){
  const analysis=rows.find(r=>r.goal_id===check.goal_id);
  if(!analysis||!analysis.targets_json.some(t=>audit_ids.includes(t.audit_id))&&started_at>analysis.created_at)result.set(check.goal_id,check as RoundSummary);
 }
 return [...result.values()].sort((a,b)=>a.goal_id.localeCompare(b.goal_id));
}
