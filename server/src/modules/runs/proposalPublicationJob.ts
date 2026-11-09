import {OperationError} from '../systemActions/operations/errors.js';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import {withQueryableTransaction} from '../routeUtils/common.js';
import {JobDeferredError,type JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {lockProposalTransitions} from '../systemActions/operations/proposalTransitions.js';
/** A required insertion intent closes late staged output without delaying Run termination. */
export function registerRunProposalPublication(registry:JobHandlerRegistry,config:ServerConfig){
 registry.register('run_proposal_publication',async job=>{
  try{return await withQueryableTransaction(getDbPool(config.databaseUrl!),async db=>{
   const id=String(job.payload.proposal_id),runId=String(job.payload.run_id);
   const run=(await db.query<{status:string}>('SELECT status FROM runs WHERE id=$1 AND space_id=$2',[runId,job.space_id])).rows[0];
   if(!run)return {missing:true};
   if(!['succeeded','degraded','failed','cancelled','orphaned'].includes(run.status))throw new JobDeferredError('Run has not settled',1000);
   const transitions=await lockProposalTransitions(db,job.space_id,[id]);
   await db.query(`UPDATE proposals SET status=CASE WHEN $4 IN ('succeeded','degraded') THEN 'pending' ELSE 'rejected' END,updated_at=now()
     WHERE id=$1 AND space_id=$2 AND created_by_run_id=$3 AND status='staged'`,[id,job.space_id,runId,run.status]);
   await transitions.finish();return {settled:true};
  });}catch(error){if(error instanceof OperationError && error.retryable)throw new JobDeferredError('Proposal publication is busy',1000);throw error;}
 });
}
