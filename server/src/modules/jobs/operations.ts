import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import type {Queryable} from '../routeUtils/common.js';
import {OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {PgRunRepository} from '../runs/repository.js';
import {RunMaterializationService} from '../runs/materializationService.js';
import {PgJobQueueRepository} from './repository.js';

type Input=OperationInput<'job.cancel'>;
/** A person cancels only work that has not started: a running Job is its worker's. */
const CANCELLABLE=['pending','claimed'] as const;
const RUN_BACKED=['agent_run','provider_task_run','daily_capture_report'];
class JobNotCancellable extends OperationBusinessError {constructor(){super('operation_conflict',409,'jobs');}}

/** The Job's own requesting person in this Space; other Jobs are indistinguishable from absent ones. */
async function ownJob(db:Queryable,a:OperationActor,jobId:string){
  const row=(await db.query<{id:string;status:string;job_type:string;run_id:string|null}>(`SELECT id,status,job_type,payload_json->>'run_id' AS run_id FROM jobs
    WHERE id=$1 AND space_id=$2 AND user_id=$3`,[jobId,a.space_id,a.on_behalf_of_user_id])).rows[0];
  if(!row)throw hidden();
  return row;
}

/** Generic Job cancellation. It keeps the queue's own terminal contract (pending/claimed only,
 * one statement guarded by status) and is not a Research or deployment cancellation. */
export function jobOperationRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  return [{
    definition:definitions.get('job.cancel')!,
    // The Run a Run-backed Job would perform ends with it; its terminal transition is admitted first.
    runTerminalOwner:{async discover(db,raw,a){
      const job=(await db.query<{id:string}>(`SELECT payload_json->>'run_id' AS id FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3
        AND job_type=ANY($4::text[]) AND payload_json->>'run_id' IS NOT NULL AND status=ANY($5::text[])`,
        [(raw as Input).job_id,a.space_id,a.on_behalf_of_user_id,RUN_BACKED,[...CANCELLABLE]])).rows[0];
      return job?[{space_id:a.space_id,id:job.id}]:[];
    }},
    async resolve(db,raw,a){const id=(raw as Input).job_id;await ownJob(db,a,id);return {authority:`job:${id}`,targets:{job_id:id},resourceType:'job',resourceId:id};},
    async authorize(db,raw,a){await ownJob(db,a,(raw as Input).job_id);},
    async authorizeResult(db,raw,a){await ownJob(db,a,(raw as {job_id:string}).job_id);},
    async execute(db,raw,a){
      const id=(raw as Input).job_id,queue=new PgJobQueueRepository(db);
      if(!(CANCELLABLE as readonly string[]).includes((await ownJob(db,a,id)).status))throw new JobNotCancellable();
      // Guarded by status in the cancelling statement itself; a Run behind it ends in the same transaction.
      if(!(await queue.cancelJob(id,null,new Date(),CANCELLABLE)))throw new JobNotCancellable();
      await queue.appendJobEvent({job_id:id,event_type:'status_change',message:'Job cancelled by user'});
      return {job_id:id,status:'cancelled' as const};
    },
    // Finalization reads the committed cancellation outside the transaction; owed finalizations are swept.
    async afterCommit(raw,a){
      const pool=getDbPool(config.databaseUrl!);
      const job=(await pool.query<{job_type:string;run_id:string|null}>(`SELECT job_type,payload_json->>'run_id' AS run_id FROM jobs WHERE id=$1 AND space_id=$2`,[(raw as {job_id:string}).job_id,a.space_id])).rows[0];
      if(!job?.run_id||!RUN_BACKED.includes(job.job_type))return;
      const run=await new PgRunRepository(pool).getRun(a.space_id,job.run_id);
      if(run?.status==='cancelled')await RunMaterializationService.fromConfig(config).finalizeRun(run);
    },
  }];
}
