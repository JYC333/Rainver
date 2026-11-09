import {HttpError} from '../routeUtils/common.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import type {Queryable} from '../routeUtils/common.js';
import type {JobEnvelopeForHandler,JobHandlerResult} from '../jobs/handlerRegistry.js';
/** Only a canonical pre-effect claim failure may release a start fence. */
export class SourceDispatchBusyError extends HttpError {constructor(message='Source work is currently claimed',readonly resourceId?:string){super(409,message);}}
/** A manual Source dispatch gets one external attempt. The existing Job result
 * holds its durable start fence before I/O, and its receipt before worker ack.
 * A crash between them is indeterminate, never permission to repeat the effect. */
export async function executeSourceDispatch(db:Queryable,job:JobEnvelopeForHandler,work:()=>Promise<JobHandlerResult>):Promise<JobHandlerResult>{
 const admitted=await db.query("UPDATE jobs SET result_json=$3::jsonb WHERE id=$1 AND space_id=$2 AND result_json IS NULL RETURNING id",[job.job_id,job.space_id,JSON.stringify({source_dispatch:'started'})]);
 if(!admitted.rows.length){
  const previous=(await db.query<{result_json:Record<string,unknown>|null}>('SELECT result_json FROM jobs WHERE id=$1 AND space_id=$2',[job.job_id,job.space_id])).rows[0];
  if(!previous?.result_json||previous.result_json.source_dispatch==='started')throw new Error('Source dispatch outcome unavailable; external work will not be repeated');
  return previous.result_json;
 }
 let result:JobHandlerResult;
 try{result=await work();}catch(error){
  if(error instanceof SourceDispatchBusyError&&error.resourceId&&(error.resourceId===job.payload.extraction_job_id||error.resourceId===job.payload.rule_id)){
   await db.query("UPDATE jobs SET result_json=NULL WHERE id=$1 AND space_id=$2 AND result_json=$3::jsonb",[job.job_id,job.space_id,JSON.stringify({source_dispatch:'started'})]);
   throw new JobDeferredError('Source work is currently claimed; waiting without executing again',1000);
  }
  throw error;
 }
 await db.query('UPDATE jobs SET result_json=$3::jsonb WHERE id=$1 AND space_id=$2',[job.job_id,job.space_id,JSON.stringify(result??{})]);
 return result;
}
