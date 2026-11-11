import {createHash,randomUUID} from 'node:crypto';
import {SystemCommandStatusSchema,type PolicyActionId,type SystemCommandKind,type SystemCommandReceipt,type SystemCommandStatus} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {canonical} from '../systemActions/operations/repository.js';

/**
 * Durable system commands (`system_command_intents`): the settings / tool
 * configuration block's commands whose effect is vendor, filesystem or network
 * IO, or (plugin install) DDL that must run in its own transaction. The
 * operation transaction admits the intent and its Job; the worker
 * (`worker.ts`) performs the effect outside every transaction under its Job
 * lease, rechecking the issuer's authority before the effect and before any
 * result is released. The issuer-only status read is the only release.
 */
export const SYSTEM_COMMAND_JOB='system_command';
export const ACTIVE_SYSTEM_COMMAND_STATUSES=['pending','dispatched'] as const;

export interface SystemCommandEffect{dispatched_at?:string;error_detail?:string|null;attempts?:number}
export interface SystemCommandIntent{
  id:string;space_id:string;user_id:string;kind:SystemCommandKind;scope_key:string;status:string;job_id:string|null;
  frozen_json:Record<string,unknown>;effect_json:SystemCommandEffect;result_json:Record<string,unknown>|null;error_code:string|null;
  created_at:string;updated_at:string;
}

/** The issuer's command, or something they may no longer see. Always the hidden 404. */
export class SystemCommandNotVisible extends Error{readonly statusCode=404;constructor(){super('operation_not_found');}}
/** A deterministic refusal written for the person; reflected as the operation's 409/422. */
export class SystemCommandRefusal extends Error{
  constructor(readonly statusCode:409|422,message:string,readonly responseBody:Record<string,unknown>={}){super(message);this.name='SystemCommandRefusal';}
}

/**
 * Per kind: the authority the command is about (rechecked at admission, before
 * the effect, before a result is released and at every status read), the
 * policy action its worker phases are audited under, and how the effect runs.
 * `run` performs IO outside every transaction; `atomic` performs a DB-only
 * effect in the same transaction that settles the intent, so it never has an
 * unknown outcome. `repeatable` says re-running after an unknown outcome is
 * safe (a read); otherwise a started effect without an outcome is
 * `needs_attention` and is never repeated.
 */
export interface SystemCommandSettlement{ok:boolean;result?:Record<string,unknown>;code?:string;detail?:string|null}
export interface SystemCommandKindHandler{
  policy:PolicyActionId;
  resourceType:string;
  resourceId(intent:SystemCommandIntent):string|null;
  repeatable:boolean;
  authorize(db:Queryable,config:ServerConfig,intent:Pick<SystemCommandIntent,'space_id'|'user_id'|'kind'|'frozen_json'>):Promise<void>;
  run?(config:ServerConfig,intent:SystemCommandIntent):Promise<SystemCommandSettlement>;
  atomic?(db:Queryable,config:ServerConfig,intent:SystemCommandIntent):Promise<Record<string,unknown>>;
}

/** Every terminal write drops request content a settled command no longer needs (a webhook's event payload). */
export const REDACTED_SYSTEM_FROZEN=`(frozen_json - 'payload')`;
const scopeKey=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');

export async function loadSystemCommand(db:Queryable,id:string,lock=false):Promise<SystemCommandIntent|null>{
  return (await db.query<SystemCommandIntent>(`SELECT * FROM system_command_intents WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0]??null;
}

/**
 * A command whose Job can no longer run (cancelled, or out of attempts)
 * settles here, the same way at admission and at the status read: never
 * started is `failed`; started without an outcome is `needs_attention`,
 * because what happened outside is unknown.
 */
export async function settleStaleSystemCommand(db:Queryable,intent:SystemCommandIntent):Promise<SystemCommandIntent>{
  if(!ACTIVE_SYSTEM_COMMAND_STATUSES.includes(intent.status as 'pending'))return intent;
  const job=(await db.query<{status:string}>('SELECT status FROM jobs WHERE id=$1',[intent.job_id])).rows[0];
  if(job&&!['failed','cancelled'].includes(job.status))return intent;
  const status=intent.effect_json.dispatched_at?'needs_attention':'failed';
  const updated=(await db.query<SystemCommandIntent>(
    `UPDATE system_command_intents SET status=$2,error_code=$3,frozen_json=${REDACTED_SYSTEM_FROZEN},updated_at=now()
      WHERE id=$1 AND status IN ('pending','dispatched') RETURNING *`,[intent.id,status,`system_command_job_${job?.status??'missing'}`])).rows[0];
  return updated??intent;
}

/**
 * Admits one system command. At most one active command per scope: a second
 * is a conflict the person sees (with the active command's id when it is
 * theirs), never a second effect. A stale active command is settled first.
 * `frozen` must never carry a secret; the worker reads credentials through
 * their own encrypted channel when it runs.
 */
export async function admitSystemCommand(db:Queryable,input:{
  spaceId:string;userId:string;kind:SystemCommandKind;scope:unknown;frozen:Record<string,unknown>;
}):Promise<SystemCommandReceipt>{
  const scope=scopeKey({kind:input.kind,scope:input.scope});
  const active=(await db.query<SystemCommandIntent>(
    `SELECT * FROM system_command_intents WHERE scope_key=$1 AND status IN ('pending','dispatched') FOR UPDATE`,[scope])).rows[0];
  if(active&&ACTIVE_SYSTEM_COMMAND_STATUSES.includes((await settleStaleSystemCommand(db,active)).status as 'pending')){
    throw new SystemCommandRefusal(409,'Another request for this is already in progress.',
      {code:'system_command_busy',...(active.user_id===input.userId&&active.space_id===input.spaceId?{command_id:active.id}:{})});
  }
  const id=randomUUID();
  await db.query(
    `INSERT INTO system_command_intents(id,space_id,user_id,kind,scope_key,status,frozen_json,effect_json,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb,'{}'::jsonb,now(),now())`,
    [id,input.spaceId,input.userId,input.kind,scope,JSON.stringify(input.frozen)]);
  const job=await new PgJobQueueRepository(db).enqueue({job_type:SYSTEM_COMMAND_JOB,space_id:input.spaceId,user_id:input.userId,payload:{intent_id:id},max_attempts:3});
  await db.query('UPDATE system_command_intents SET job_id=$2 WHERE id=$1',[id,job.id]);
  return {id,space_id:input.spaceId,kind:input.kind,job_id:job.id,status:'pending'};
}

export function systemCommandStatusView(intent:SystemCommandIntent):SystemCommandStatus{
  return SystemCommandStatusSchema.parse({
    id:intent.id,space_id:intent.space_id,kind:intent.kind,job_id:intent.job_id,status:intent.status,
    error:intent.error_code?{code:intent.error_code,detail:intent.effect_json.error_detail??null}:null,
    // Written only by the worker's settle step, under the authority recheck. Never for an unknown outcome.
    result:intent.status==='succeeded'?intent.result_json??null:null,
    created_at:new Date(intent.created_at).toISOString(),updated_at:new Date(intent.updated_at).toISOString(),
  });
}
