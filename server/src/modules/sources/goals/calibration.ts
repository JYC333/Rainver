import {sourceGoalError} from './dispatchError.js';
import type {ServerConfig} from '../../../config.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {requireGoalSource,goalSourceFingerprint,type GoalRow} from './access.js';
import {cleanGoalSamples} from './samples.js';
export const CALIBRATION_UNAVAILABLE='source_repair_calibration_unavailable';
/** Must run before admission/attempt consumption; transaction caller holds goal
 * and Source policy rows. Candidate callers repeat it before using saved bytes. */
export async function checkRepairCalibration(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,g:GoalRow,bindingId?:string,pauseRevoked=false){
 await cleanGoalSamples(db,config,g.id);
 const rows=await db.query<{id:string;spec_json:import('@rainver/protocol').SourceGoalBindingSpec;fixture_json:Record<string,unknown>;checked_at:Date|string}>(`SELECT id,spec_json,fixture_json,clock_timestamp() AS checked_at FROM source_goal_bindings WHERE goal_id=$1 AND space_id=$2 AND ($3::varchar IS NULL OR id=$3) AND ($3::varchar IS NOT NULL OR status IN ('repair_required','repairing') OR fixture_json->>'repair_block_reason'=$4) ORDER BY id FOR UPDATE`,[g.id,g.space_id,bindingId??null,CALIBRATION_UNAVAILABLE]);
 if(bindingId&&!rows.rows.length)throw new HttpError(409,'Repair binding unavailable');
 let unavailable=false;
 for(const b of rows.rows){
  try{
  const source=await requireGoalSource(db,config,identity,g,b.spec_json);
  if(goalSourceFingerprint(source)!==b.fixture_json?.authority_sha256)throw sourceGoalError(409,'source_authority_revoked');
  // Saved raw calibration is optional. Without it the repair validator must
  // establish independent synthetic/live evidence before it can publish.

  }catch(error){
   const authorizationError=error instanceof HttpError&&([403,404].includes(error.statusCode)||(error.responseBody as {error?:string}|undefined)?.error==='source_authority_revoked')||error instanceof Error&&error.message==='source_policy_refused';
   if(!authorizationError)throw error;
   if(!pauseRevoked)throw sourceGoalError(error instanceof HttpError?error.statusCode:403,'source_authority_revoked');
   unavailable=true;await db.query(`UPDATE source_goal_bindings SET status='paused',retry_at=NULL,fixture_json=COALESCE(fixture_json,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1`,[b.id,{repair_block_reason:'source_authority_revoked'}]);
  }
 }
 return !unavailable;
}
