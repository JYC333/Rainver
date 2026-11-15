import {withJobEffectAuthority,JobEffectLeaseLost} from '../jobs/effectAuthority.js';
import {HttpError} from '../routeUtils/common.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import type {Queryable} from '../routeUtils/common.js';
import type {JobEnvelopeForHandler,JobHandlerResult} from '../jobs/handlerRegistry.js';
/** Only a canonical pre-effect claim failure may release a start fence. */
export class SourceDispatchBusyError extends HttpError {constructor(message='Source work is currently claimed',readonly resourceId?:string){super(409,message);}}
/** The worker no longer holds this Job's claim (reclaimed, exhausted, cancelled or claimed again). */
export {JobEffectLeaseLost as SourceDispatchLeaseLost} from '../jobs/effectAuthority.js';
const SourceDispatchLeaseLost=JobEffectLeaseLost;
/** The queue's own claim fence (status, worker, attempt), carried by every fence write. */
const CLAIM="status='running' AND claimed_by=$3 AND attempts=$4";
/** A manual Source dispatch gets one external attempt. The existing Job result
 * holds its durable start fence before I/O, and its receipt before worker ack.
 * Work carries the Job credential to each actual HTTP/Host/queue boundary.
 * The boundary's irreversible-start write and cancel/reclaim serialize on this
 * same Job row; no asynchronous preparation follows that write before send.
 * Both writes are conditioned on the worker still holding the current claim:
 * a worker that lost it never starts external work and never writes a receipt.
 * A crash, or a claim lost between them, is indeterminate, never permission to
 * repeat the effect. */
export async function executeSourceDispatch(db:Queryable,job:JobEnvelopeForHandler,work:()=>Promise<JobHandlerResult>):Promise<JobHandlerResult>{
 const fence=[job.job_id,job.space_id,job.worker_id,job.attempts];
 const admitted=await db.query(`UPDATE jobs SET result_json=$5::jsonb WHERE id=$1 AND space_id=$2 AND ${CLAIM} AND result_json IS NULL RETURNING id`,[...fence,JSON.stringify({source_dispatch:'started'})]);
 if(!admitted.rows.length){
  const previous=(await db.query<{result_json:Record<string,unknown>|null;owned:boolean}>(`SELECT result_json,(${CLAIM}) AS owned FROM jobs WHERE id=$1 AND space_id=$2`,fence)).rows[0];
  if(!previous?.owned)throw new SourceDispatchLeaseLost();
  if(!previous.result_json||previous.result_json.source_dispatch==='started')throw new Error('Source dispatch outcome unavailable; external work will not be repeated');
  return previous.result_json;
 }
 let result:JobHandlerResult;
 try{result=await withJobEffectAuthority(db,job,work);}catch(error){
  if(error instanceof SourceDispatchBusyError&&error.resourceId&&(error.resourceId===job.payload.extraction_job_id||error.resourceId===job.payload.rule_id)){
   const released=await db.query(`UPDATE jobs SET result_json=NULL WHERE id=$1 AND space_id=$2 AND ${CLAIM} AND result_json=$5::jsonb`,[...fence,JSON.stringify({source_dispatch:'started'})]);
   if(!released.rowCount)throw new SourceDispatchLeaseLost();
   throw new JobDeferredError('Source work is currently claimed; waiting without executing again',1000);
  }
  throw error;
 }
 // The effect happened. Without the claim the receipt is not this worker's to
 // write: the start fence stays, so no later claim repeats the effect.
 const recorded=await db.query(`UPDATE jobs SET result_json=$5::jsonb WHERE id=$1 AND space_id=$2 AND ${CLAIM}`,[...fence,JSON.stringify(result??{})]);
 if(!recorded.rowCount)throw new SourceDispatchLeaseLost('Source dispatch Job lost its claim after the external effect; its outcome stays indeterminate');
 return result;
}
