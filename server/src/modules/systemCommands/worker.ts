import {z} from 'zod';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import {tryWithDedicatedSessionAdvisoryLock} from '../../db/advisoryLock.js';
import {withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {withPolicyAuditRecovery} from '../policy/auditWriter.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import {JobDeferredError,type JobEnvelopeForHandler,type JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {assertCurrentActor,sessionActor} from '../systemActions/operations/actor.js';
import {
  REDACTED_SYSTEM_FROZEN,SYSTEM_COMMAND_JOB,SystemCommandNotVisible,SystemCommandRefusal,loadSystemCommand,
  type SystemCommandEffect,type SystemCommandIntent,type SystemCommandSettlement,
} from './intents.js';
import {systemCommandHandler} from './handlers.js';

/**
 * Performs one committed system command outside every transaction. Before the
 * effect starts the worker rechecks the issuer's authority, audits the phase
 * and records `dispatched_at` durably under its Job lease; the outcome is
 * recorded in a second short transaction that rechecks authority again before
 * any result is released. A non-repeatable effect found started without an
 * outcome is `needs_attention`, never repeated and never success. A DB-only
 * effect (`atomic`) commits in the same transaction that settles the intent.
 */
class SystemCommandLeaseLost extends Error{}
/**
 * A command whose effect never started gives up after this long: the person
 * asked for it now, and a backlog must not carry out a stale send or backup.
 * Shorter than the browser's status-read window.
 */
const SYSTEM_UNSENT_EXPIRY_MS=10*60*1000;
const MAX_REPEATS=3;
const withdrawn=(error:unknown)=>error instanceof SystemCommandNotVisible||[403,404].includes((error as {statusCode?:number})?.statusCode??0);
const payload=z.object({intent_id:z.string().min(1).max(36)}).strict();

export function registerSystemCommandHandler(registry:JobHandlerRegistry,config:ServerConfig):void{
  registry.register(SYSTEM_COMMAND_JOB,async job=>{
    try{return await executeSystemCommand(config,payload.parse(job.payload).intent_id,job);}
    catch(error){
      if(error instanceof JobDeferredError)throw error;
      // Job errors are user-readable transport; vendor and target text stay in the private status.
      throw new Error('System command attempt did not complete; read its private status');
    }
  });
}

export async function executeSystemCommand(config:ServerConfig,id:string,job:JobEnvelopeForHandler):Promise<Record<string,unknown>>{
  if(!config.databaseUrl)throw new Error('System commands require a database');
  const pool=getDbPool(config.databaseUrl);
  const locked=await tryWithDedicatedSessionAdvisoryLock(pool,`system-command:${id}`,async()=>{
    let intent=await loadSystemCommand(pool,id);
    if(!intent||intent.job_id!==job.job_id||intent.user_id!==job.user_id||intent.space_id!==job.space_id)throw new SystemCommandLeaseLost('System command does not own this Job');
    if(!['pending','dispatched'].includes(intent.status))return {intent_id:id,status:intent.status};
    const handler=systemCommandHandler(intent.kind);
    const effect:SystemCommandEffect={...intent.effect_json};
    const assertLease=async(db:Queryable)=>{
      if(!(await db.query(`SELECT id FROM jobs WHERE id=$1 AND claimed_by=$2 AND status='running' FOR SHARE`,[job.job_id,job.worker_id])).rows.length)throw new SystemCommandLeaseLost('System command Job no longer owns execution');
    };
    const audit=async(db:Queryable,phase:string)=>{
      const result=await enforce({...config,auditTransaction:db},await loadActionRegistry(config),{
        action:handler.policy,actor_type:'user',actor_id:intent!.user_id,space_id:intent!.space_id,resource_space_id:intent!.space_id,
        resource_type:handler.resourceType,resource_id:handler.resourceId(intent!),
        context:{trigger_origin:'manual',direct_user_write:true},
        metadata_json:{system_command_id:id,system_command_kind:intent!.kind,system_command_phase:phase},force_record:true,
      });
      if(result.status==='error')throw new SystemCommandRefusal(409,'operation_audit_unavailable',{code:'operation_audit_unavailable'});
      if(result.status!=='allow')throw new SystemCommandNotVisible();
    };
    /**
     * Under the lease and with authority rechecked: the only door to an effect or a released result.
     * The issuer's user and membership rows (every basis of the kind checks: active user, active
     * membership and its role, the instance-admin email) are share-locked before the kind's own
     * check and held until this transaction commits. A concurrent disable, membership change or
     * instance-admin revocation therefore either commits first (and this check refuses) or waits
     * until the dispatch record, or an `atomic` effect such as an install's DDL, has committed.
     */
    const owner=<T>(phase:'dispatch'|'settle',work:(db:Queryable)=>Promise<T>)=>withPolicyAuditRecovery(config.databaseUrl,()=>withQueryableTransaction(pool,async db=>{
      await assertLease(db);
      intent=(await loadSystemCommand(db,id,true))!;
      if(!['pending','dispatched'].includes(intent.status))throw new SystemCommandLeaseLost('System command already settled');
      await assertCurrentActor(db,sessionActor({spaceId:intent.space_id,userId:intent.user_id}),true);
      await handler.authorize(db,config,intent);
      await audit(db,phase);
      return work(db);
    }));
    /** Records an outcome that releases nothing; never needs the authority the command was admitted under. */
    const record=async(status:'failed'|'needs_attention'|'pending',code:string|null,detail?:string|null)=>{
      effect.error_detail=detail?String(detail).slice(0,1000):null;
      const terminal=status!=='pending';
      const result=await pool.query(
        `UPDATE system_command_intents i SET status=$3,error_code=$4,effect_json=$5::jsonb,frozen_json=CASE WHEN $6::boolean THEN ${REDACTED_SYSTEM_FROZEN} ELSE frozen_json END,updated_at=now()
          WHERE i.id=$1 AND i.job_id=$2 AND i.status IN ('pending','dispatched') AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=$2 AND j.claimed_by=$7 AND j.status='running')`,
        [id,job.job_id,status,code,JSON.stringify(effect),terminal,job.worker_id]);
      if(!result.rowCount)throw new SystemCommandLeaseLost('System command progress no longer owns its Job');
      return {intent_id:id,status};
    };
    const succeed=async(db:Queryable,result:Record<string,unknown>)=>{
      effect.error_detail=null;
      await db.query(`UPDATE system_command_intents SET status='succeeded',result_json=$2::jsonb,effect_json=$3::jsonb,frozen_json=${REDACTED_SYSTEM_FROZEN},error_code=NULL,updated_at=now() WHERE id=$1`,
        [id,JSON.stringify(result),JSON.stringify(effect)]);
      return {intent_id:id,status:'succeeded'};
    };
    try{
      if(handler.atomic){
        // The effect and its settlement are one transaction: committed together or not at all.
        if(Date.now()-new Date(intent.created_at).getTime()>SYSTEM_UNSENT_EXPIRY_MS)return record('failed','system_command_expired','The request waited too long to start, so nothing was done; request it again.');
        return await owner('settle',async db=>succeed(db,await handler.atomic!(db,config,intent!)));
      }
      const step=await owner('dispatch',async db=>{
        if(effect.dispatched_at&&(!handler.repeatable||(effect.attempts??0)>=MAX_REPEATS))return 'unknown' as const;
        if(!effect.dispatched_at&&Date.now()-new Date(intent!.created_at).getTime()>SYSTEM_UNSENT_EXPIRY_MS)return 'expired' as const;
        effect.dispatched_at??=new Date().toISOString();effect.attempts=(effect.attempts??0)+1;
        await db.query(`UPDATE system_command_intents SET status='dispatched',effect_json=$2::jsonb,updated_at=now() WHERE id=$1`,[id,JSON.stringify(effect)]);
        return 'run' as const;
      });
      if(step==='unknown')return record('needs_attention','system_command_outcome_unknown','An earlier attempt may have run; check the current state before repeating.');
      if(step==='expired')return record('failed','system_command_expired','The request waited too long to start, so nothing was done; request it again.');
      await assertLease(pool);
      let settlement:SystemCommandSettlement;
      try{settlement=await handler.run!(config,intent);}
      catch(error){
        if(withdrawn(error))return record('needs_attention','system_command_authority_withdrawn');
        if(error instanceof SystemCommandRefusal)return record('failed',String(error.responseBody.code??'system_command_refused'),error.message);
        // A repeatable read is repeated a bounded number of times (deferral refunds the Job's attempt,
        // so the intent counts its own). Anything else started and did not report: its outcome is
        // unknown, never retried as if nothing happened.
        if(handler.repeatable&&(effect.attempts??1)<MAX_REPEATS){
          await record('pending',null);
          throw new JobDeferredError('System command is repeated after an unreported read',5000);
        }
        return record('needs_attention','system_command_outcome_unknown','The effect did not report an outcome; check the current state before repeating.');
      }
      if(!settlement.ok)return record('failed',settlement.code??'system_command_failed',settlement.detail??null);
      try{return await owner('settle',db=>succeed(db,settlement.result??{}));}
      catch(error){
        if(error instanceof SystemCommandLeaseLost||error instanceof JobDeferredError)throw error;
        // The effect happened, but its result is no longer this person's to receive.
        if(withdrawn(error))return record('needs_attention','system_command_authority_withdrawn');
        if(error instanceof SystemCommandRefusal)return record('needs_attention',String(error.responseBody.code??'system_command_refused'),error.message);
        throw error;
      }
    }catch(error){
      if(error instanceof JobDeferredError||error instanceof SystemCommandLeaseLost)throw error;
      const started=Boolean(effect.dispatched_at)&&!handler.atomic;
      if(withdrawn(error))return record(started?'needs_attention':'failed','system_command_authority_withdrawn');
      if(error instanceof SystemCommandRefusal)return record(started?'needs_attention':'failed',String(error.responseBody.code??'system_command_refused'),error.message);
      if(job.attempts>=job.max_attempts)await record(started?'needs_attention':'failed','operation_internal_error').catch(()=>undefined);
      throw error;
    }
  });
  if(!locked.acquired)throw new JobDeferredError('System command is already running',1000);
  return locked.value;
}

export type {SystemCommandIntent};
