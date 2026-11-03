import {themeCollectionDay,projectReadingDay,type EditionDay} from '../../informationDigest/index.js';
import type {GoalRow} from './access.js';
import type {Queryable} from '../../routeUtils/common.js';
/** Safe collection metadata for the Project's daily edition. Bodies and native
 * runtime diagnostics never cross this projection. The admission day is frozen. */
export async function goalReadingDayChecks(db:Queryable,spaceId:string,projectId:string,date:string){
 const rows=(await db.query<{id:string;goal_id:string;status:string;started_at:string;error:string|null}>(`SELECT DISTINCT ON (s.goal_id,s.binding_id) s.id,s.goal_id,s.status,s.started_at::text,s.result_json->>'error' AS error
 FROM source_goal_runs s JOIN source_goals g ON g.id=s.goal_id AND g.space_id=s.space_id
 WHERE s.space_id=$1 AND g.project_id=$2 AND s.reading_date=$3::date AND s.binding_id IS NOT NULL
 ORDER BY s.goal_id,s.binding_id,s.started_at DESC,s.id DESC`,[spaceId,projectId,date])).rows;
 const groups=new Map<string,typeof rows>();for(const r of rows)groups.set(r.goal_id,[...(groups.get(r.goal_id)??[]),r]);
 return [...groups].map(([goal_id,group])=>{
  const failed=group.filter(r=>['failed','cancelled','interrupted'].includes(r.status));
  const pending=group.filter(r=>!['succeeded','insufficient','failed','cancelled','interrupted'].includes(r.status));
  const latest=[...group].sort((a,b)=>b.started_at.localeCompare(a.started_at))[0];
  const raw=failed[0]?.error;
  return {id:latest.id,goal_id,status:pending.length?'collecting':failed.length?'blocked':'complete',error_code:failed.length?(raw&&/^source_[a-z_]{1,56}$/.test(raw)?raw:'source_collection_failed'):null,
   coverage:{target_sources:group.length,completed_sources:group.length-pending.length,failed_sources:failed.length,pending_sources:pending.length,complete:!failed.length&&!pending.length},audit_ids:group.map(r=>r.id),started_at:latest.started_at};
 });
}

/** Collection uses its admitted round's date; direct collection without an
 * analysis round uses the Project day. Personal collection has no Project edition. */
export async function readingDayForRun(db:Queryable,goal:GoalRow,roundId?:string):Promise<EditionDay|undefined>{
 if(!goal.project_id)return undefined;
 if(roundId){const day=await themeCollectionDay(db,goal.space_id,goal.id,roundId);if(day)return day;}
 return projectReadingDay(db,goal.space_id,goal.project_id);
}
