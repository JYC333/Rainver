import {createHash,randomUUID} from 'node:crypto';
import {HostCommandStatusSchema,type HostCommandKind,type HostCommandReceipt,type HostCommandStatus,type HostCommandStatusValue} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {canonical} from '../systemActions/operations/repository.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {canWriteProject} from '../projects/access.js';

/**
 * Host command intents (`host_command_intents`, `.agent/modules/hosts.md`
 * "Host commands"). The operation transaction locks the Host's authority,
 * commits one intent with its frozen parameters and its Job, and answers a
 * receipt. Nothing here talks to a Host: `hostCommandWorker.ts` performs the
 * effect outside every transaction. Only the issuing person reads a command,
 * and only while they still hold the authority it was admitted under.
 */
export const HOST_COMMAND_JOB='host_command';
export const ACTIVE_HOST_COMMAND_STATUSES=['pending','dispatched'] as const;

export interface HostCommandEffect{
  /** Written, and committed, before a frame leaves: from here the Host may have acted. */
  dispatched_at?:string;
  /** Whether the send carried a journaled identity (`host_command`). */
  journaled?:boolean;
  sends?:number;
  error_detail?:string|null;
  /**
   * The Host's own journal receipt for this command was read (`outcome:
   * completed`): it finished there, and any late copy only replays. `by` is
   * the command whose delivery read it — this one, or a later reset that
   * re-delivered this command's exact identity to reconcile it.
   */
  receipt?:{at:string;by:string;replayed:boolean};
}
export interface HostCommandIntent{
  id:string;space_id:string;host_id:string;user_id:string;agent_id:string|null;kind:HostCommandKind;scope_key:string;
  status:HostCommandStatusValue;job_id:string;frozen_json:Record<string,unknown>;effect_json:HostCommandEffect;
  result_json:Record<string,unknown>|null;error_code:string|null;created_at:string;updated_at:string;
}

/** A deterministic, person-written refusal (409/422) the operation adapter reflects and caches. */
export class HostCommandRefusal extends Error{
  constructor(readonly statusCode:409|422,message:string,readonly responseBody:Record<string,unknown>={}){super(message);this.name='HostCommandRefusal';}
}
/** The caller may not know this object exists; the core answers the hidden 404. */
export class HostNotVisible extends Error{readonly statusCode=404;constructor(){super('Host not found');}}

export interface ManagedHost{id:string;kind:'server'|'remote';owner_user_id:string|null;platform:string|null;capabilities_json:unknown;provider_proxy_base_url:string|null}

/** Instance admin, read through the caller's transaction (shared with the settings block). */
export {isInstanceAdminIn} from '../routeUtils/access.js';
import {isInstanceAdminIn} from '../routeUtils/access.js';

/**
 * The Host a person may manage, share-locked for the transaction so a revoke
 * serializes against it: a paired Host is its owner's alone; the built-in Host
 * is instance-admin work and only for commands that apply to it. Anything else
 * is the hidden 404 — an unowned Host is indistinguishable from none.
 */
export async function lockManagedHost(db:Queryable,config:ServerConfig,hostId:string,userId:string,options:{allowBuiltin?:boolean;lock?:'share'|'update'}={}):Promise<ManagedHost>{
  const row=(await db.query<ManagedHost&{status:string}>(
    `SELECT id,kind,owner_user_id,platform,capabilities_json,provider_proxy_base_url,status FROM hosts WHERE id=$1 ${options.lock==='update'?'FOR UPDATE':'FOR SHARE'}`,[hostId])).rows[0];
  if(!row||row.status==='revoked')throw new HostNotVisible();
  if(row.kind==='remote'&&row.owner_user_id!==userId)throw new HostNotVisible();
  if(row.kind==='server'&&(!options.allowBuiltin||!await isInstanceAdminIn(db,config,userId)))throw new HostNotVisible();
  return row;
}

/** A Host the person may use for their own account: the built-in one, or one they own. */
export async function lockUsableHost(db:Queryable,hostId:string,userId:string):Promise<ManagedHost>{
  const row=(await db.query<ManagedHost&{status:string}>(
    `SELECT id,kind,owner_user_id,platform,capabilities_json,provider_proxy_base_url,status FROM hosts WHERE id=$1 FOR SHARE`,[hostId])).rows[0];
  if(!row||row.status==='revoked'||row.kind==='remote'&&row.owner_user_id!==userId)throw new HostNotVisible();
  return row;
}

export const hostScopeKey=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');

export async function loadHostCommand(db:Queryable,id:string,lock=false):Promise<HostCommandIntent|null>{
  return (await db.query<HostCommandIntent>(`SELECT * FROM host_command_intents WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0]??null;
}

/**
 * Every terminal write of an intent (`succeeded`, `failed`, `needs_attention`,
 * by the worker or here) applies this to `frozen_json`: a settled command keeps
 * no Host-private path it was given (a directory, a registered executable) and
 * no egress transport (a proxy URL may carry credentials). What stays is what a
 * settled command still needs: the ids its read authority checks (`project_id`,
 * `location_id`, `operation.tool_id`, the `agent_id` column) and what a later
 * reset re-delivers to reconcile it (`agent_id`), never a path.
 */
export const REDACTED_FROZEN=`(frozen_json - 'path' - 'egress_transport') #- '{operation,path}'`;

/**
 * A command whose Job can no longer run (a person cancelled it, or it used up
 * its attempts) settles here, the same way at admission, read and launch
 * barrier: never sent is `failed`; sent without an outcome is
 * `needs_attention`, because what the Host did is unknown. Either is terminal,
 * so it is redacted like every other terminal write (`REDACTED_FROZEN`).
 */
export async function settleStaleHostCommand(db:Queryable,intent:HostCommandIntent):Promise<HostCommandIntent>{
  if(!ACTIVE_HOST_COMMAND_STATUSES.includes(intent.status as 'pending'))return intent;
  const job=(await db.query<{status:string}>('SELECT status FROM jobs WHERE id=$1',[intent.job_id])).rows[0];
  if(job&&!['failed','cancelled'].includes(job.status))return intent;
  const status=intent.effect_json.dispatched_at?'needs_attention':'failed';
  const code=`host_command_job_${job?.status??'missing'}`;
  const updated=(await db.query<HostCommandIntent>(
    `UPDATE host_command_intents SET status=$2,error_code=$3,frozen_json=${REDACTED_FROZEN},updated_at=now() WHERE id=$1 AND status IN ('pending','dispatched') RETURNING *`,[intent.id,status,code])).rows[0];
  return updated??intent;
}

/**
 * Admits one Host command. At most one active command per Host scope: a
 * second is a conflict the person sees (with the active command's id when it
 * is theirs), never a second effect. A stale active command is settled first.
 */
export async function admitHostCommand(db:Queryable,input:{
  spaceId:string;userId:string;hostId:string;agentId?:string|null;kind:HostCommandKind;scope:unknown;frozen:Record<string,unknown>;
}):Promise<HostCommandReceipt>{
  const scope=hostScopeKey({kind:input.kind,scope:input.scope});
  const active=(await db.query<HostCommandIntent>(
    `SELECT * FROM host_command_intents WHERE host_id=$1 AND scope_key=$2 AND status IN ('pending','dispatched') FOR UPDATE`,[input.hostId,scope])).rows[0];
  if(active&&ACTIVE_HOST_COMMAND_STATUSES.includes((await settleStaleHostCommand(db,active)).status as 'pending')){
    throw new HostCommandRefusal(409,'Another request for this is already in progress on this Host.',
      {code:'host_command_busy',...(active.user_id===input.userId?{command_id:active.id}:{})});
  }
  const id=randomUUID();
  await db.query(
    `INSERT INTO host_command_intents(id,space_id,host_id,user_id,agent_id,kind,scope_key,status,frozen_json,effect_json,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb,'{}'::jsonb,now(),now())`,
    [id,input.spaceId,input.hostId,input.userId,input.agentId??null,input.kind,scope,JSON.stringify(input.frozen)]);
  const job=await new PgJobQueueRepository(db).enqueue({job_type:HOST_COMMAND_JOB,space_id:input.spaceId,user_id:input.userId,agent_id:input.agentId??null,payload:{intent_id:id},max_attempts:5});
  await db.query('UPDATE host_command_intents SET job_id=$2 WHERE id=$1',[id,job.id]);
  return {id,space_id:input.spaceId,host_id:input.hostId,kind:input.kind,job_id:job.id,status:'pending'};
}

/**
 * The authority one command is about, read now: the Host the kind needs, and
 * the resource behind it — the Agent of a reset, the Project of a Location
 * registration, the Location (and its Project) of a history import. The worker
 * checks it before a send and before a result is released; the status read
 * and the receipt replay check exactly the same thing. It reads only ids a
 * settled command keeps (`agent_id`, `project_id`, `location_id`), never a
 * private path the redaction removed.
 */
export async function authorizeHostCommandResource(db:Queryable,config:ServerConfig,intent:Pick<HostCommandIntent,'space_id'|'host_id'|'user_id'|'agent_id'|'kind'|'frozen_json'>):Promise<void>{
  const kept=(key:string)=>{const value=intent.frozen_json[key];if(typeof value!=='string'||!value)throw new HostNotVisible();return value;};
  switch(intent.kind){
    case 'ordinary_account_logout':await lockUsableHost(db,intent.host_id,intent.user_id);return;
    case 'runtime_own_update':await lockManagedHost(db,config,intent.host_id,intent.user_id);return;
    case 'agent_host_state_reset':{
      await lockManagedHost(db,config,intent.host_id,intent.user_id);
      const agent=(await db.query<{owner_user_id:string|null}>('SELECT owner_user_id FROM agents WHERE id=$1 AND space_id=$2 FOR SHARE',[intent.agent_id,intent.space_id])).rows[0];
      // An ownerless Agent (a Space or Project Assistant) is the Host owner's to clear; an owned one only its owner's.
      if(!agent||agent.owner_user_id&&agent.owner_user_id!==intent.user_id)throw new HostNotVisible();
      return;
    }
    case 'workspace_register':
      await lockManagedHost(db,config,intent.host_id,intent.user_id);
      if(!await canWriteProject(db,intent.space_id,kept('project_id'),intent.user_id))throw new HostNotVisible();
      return;
    case 'ambient_sync':{
      await lockManagedHost(db,config,intent.host_id,intent.user_id);
      const target=(await db.query<{project_id:string;space_id:string}>(
        `SELECT f.project_id,wl.space_id FROM workspace_locations wl JOIN project_folders f ON f.id=wl.project_folder_id AND f.space_id=wl.space_id
          WHERE wl.id=$1 AND wl.execution_host_id=$2 FOR SHARE OF wl`,[kept('location_id'),intent.host_id])).rows[0];
      if(!target||target.space_id!==intent.space_id||!await canWriteProject(db,intent.space_id,target.project_id,intent.user_id))throw new HostNotVisible();
      return;
    }
    default:await lockManagedHost(db,config,intent.host_id,intent.user_id,{allowBuiltin:true});
  }
}

/**
 * Whether the person may still read this command: theirs, in this Space, and
 * still holding today the authority its kind needs (`authorizeHostCommandResource`).
 * A revoked Host, a lost Agent, Project or Location hides it, exactly as a new
 * request would be refused — whatever state the command settled in.
 */
export async function assertHostCommandReadable(db:Queryable,config:ServerConfig,intent:HostCommandIntent,spaceId:string,userId:string):Promise<void>{
  if(intent.space_id!==spaceId||intent.user_id!==userId)throw new HostNotVisible();
  await authorizeHostCommandResource(db,config,intent);
}

export function hostCommandStatusView(intent:HostCommandIntent):HostCommandStatus{
  return HostCommandStatusSchema.parse({
    id:intent.id,space_id:intent.space_id,host_id:intent.host_id,kind:intent.kind,job_id:intent.job_id,status:intent.status,
    error:intent.error_code?{code:intent.error_code,detail:intent.effect_json.error_detail??null}:null,
    // Written only by the worker's settle step, under the authority recheck: a success, or what a
    // partly committed command did commit (`ambient_sync_partial`). Never for an unknown outcome.
    result:intent.result_json??null,
    created_at:new Date(intent.created_at).toISOString(),updated_at:new Date(intent.updated_at).toISOString(),
  });
}

/**
 * The reset fence (`agent.host_state.reset`). An Agent's launch on a Host
 * waits while a reset of its profiles there is active, or was sent and its
 * outcome was never proven. Only the Host's receipt for that exact command
 * proves it (`effect_json.receipt`): read by its own delivery, or by a later
 * reset re-delivering that command's identity (`reconcileEarlierResets` in
 * the worker). A later reset that failed — never sent, refused, or answered
 * after archiving only part of the profiles — proves nothing about the
 * earlier one and releases nothing. The share-mode advisory lock pairs with
 * the reset admission's exclusive one: a launch either sees the committed
 * reset, or the reset's own in-flight check sees the launch's Run.
 */
export async function agentHostResetFence(db:Queryable,hostId:string,agentId:string):Promise<HostCommandIntent|null>{
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`agent-host-reset:${hostId}:${agentId}`]);
  const rows=(await db.query<HostCommandIntent>(
    `SELECT * FROM host_command_intents WHERE host_id=$1 AND agent_id=$2 AND kind='agent_host_state_reset'
       AND (status IN ('pending','dispatched') OR (status='needs_attention' AND effect_json ? 'dispatched_at' AND NOT effect_json ? 'receipt'))
     ORDER BY created_at DESC`,[hostId,agentId])).rows;
  for(const row of rows){
    const current=await settleStaleHostCommand(db,row);
    if(ACTIVE_HOST_COMMAND_STATUSES.includes(current.status as 'pending'))return current;
    if(owesHostReceipt(current))return current;
  }
  return null;
}
/** A reset that may have reached the Host and whose receipt nobody has read. */
export const owesHostReceipt=(intent:HostCommandIntent)=>intent.status==='needs_attention'&&Boolean(intent.effect_json.dispatched_at)&&!intent.effect_json.receipt;
export async function lockAgentHostResetAdmission(db:Queryable,hostId:string,agentId:string):Promise<void>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`agent-host-reset:${hostId}:${agentId}`]);
}
