import {workspaceContributorCtes} from './workspaceContributors.js';
import {parseRunContextTaint} from '../runs/contextTaint.js';
import type {Queryable} from '../routeUtils/common.js';

/** Assess code contributors to this frozen change, not every past conversation
 * turn. Legacy adopted children remain conservative until explicit lineage exists. */
export async function workspacePublicationNeedsReview(db:Queryable,input:{spaceId:string;changeSetId:string;requesterId:string;repairRunId:string|null;instructionRunId?:string|null;verificationRunIds?:string[]}){
 const rows=(await db.query<{responsible_user:string|null;context_taint_json:unknown}>(`${workspaceContributorCtes('$1','$2')}, contributors AS (
  SELECT r.id,COALESCE(r.instructed_by_user_id,r.owner_user_id) AS responsible_user,r.context_taint_json
   FROM contributor_ids ci JOIN runs r ON r.id=ci.id AND r.space_id=ci.space_id WHERE r.has_context_taint=true
  UNION
  SELECT id,COALESCE(instructed_by_user_id,owner_user_id),context_taint_json FROM runs WHERE (id IN ($3,$4) OR id=ANY($5::varchar[])) AND space_id=$2 AND has_context_taint=true
 ) SELECT responsible_user,context_taint_json FROM contributors LIMIT 1001`,[input.changeSetId,input.spaceId,input.repairRunId,input.instructionRunId??null,input.verificationRunIds??[]])).rows;
 if(rows.length>1000)return true;
 return rows.some(row=>{
  const raw=row.context_taint_json as Record<string,unknown>|null;
  const taint=parseRunContextTaint(raw);
  // A legacy boolean alone is not proof that the requester owns its inputs.
  const arrays=['input_owner_user_ids','non_instructing_owner_user_ids','personal_memory_grant_ids'];
  if(!taint||!raw||!arrays.every(key=>Array.isArray(raw[key])&&(raw[key] as unknown[]).every(v=>typeof v==='string'&&v.length>0)))return true;
  return row.responsible_user!==input.requesterId||taint.non_instructing_owner_user_ids.length>0||taint.personal_memory_grant_ids.length>0;
 });
}
