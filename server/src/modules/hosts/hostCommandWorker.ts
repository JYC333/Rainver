import {z} from 'zod';
import type {HostCommandInnerFrame,HostCommandKind,PolicyActionId} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool,type Pool} from '../../db/pool.js';
import {tryWithDedicatedSessionAdvisoryLock} from '../../db/advisoryLock.js';
import {HttpError,withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {withPolicyAuditRecovery} from '../policy/auditWriter.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import {JobDeferredError,type JobEnvelopeForHandler,type JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {assertCurrentActor,sessionActor} from '../systemActions/operations/actor.js';
import {canonical} from '../systemActions/operations/repository.js';
import {sharedHostConnectionRegistry,type HostCommandAnswer} from './connectionRegistry.js';
import {hostInstallationIds} from './capabilities.js';
import {recordHostRuntimeChange,refreshHostUsage} from './usageService.js';
import {ImportedSessionService} from '../importedSessions/service.js';
import {
  HOST_COMMAND_JOB,HostCommandRefusal,HostNotVisible,REDACTED_FROZEN,authorizeHostCommandResource,loadHostCommand,owesHostReceipt,
  type HostCommandEffect,type HostCommandIntent,
} from './hostCommands.js';
import {createHash} from 'node:crypto';

/**
 * Performs one committed Host command (`hostCommands.ts`), outside every
 * transaction. Before any frame leaves, the worker rechecks the person's
 * authority and records `dispatched_at` durably under its Job lease; the
 * outcome is recorded in a second short transaction that rechecks authority
 * again before any result is released. A journaled send (`host_command`) is
 * repeated with the same id until the Host answers with its receipt; an
 * unjournaled one is sent at most once, and a lost answer is
 * `needs_attention`, never success.
 */
type Registry=typeof sharedHostConnectionRegistry;
type InnerWithoutId=HostCommandInnerFrame extends infer F?F extends {request_id:string}?Omit<F,'request_id'>:never:never;
interface Settlement{
  ok:boolean;result:Record<string,unknown>;error:string|null;
  /**
   * A result that is released although the command did not succeed: its
   * owner committed what it reports (a history import that wrote some
   * sessions and then failed), so it is neither success nor "nothing happened".
   */
  outcome?:{status:'failed'|'needs_attention';code:string};
}
interface Delivery{
  sent:boolean;answered:boolean;settlement?:Settlement;terminal?:{status:'failed'|'needs_attention';code:string;detail?:string|null};
  /** The Host's journal answered `completed` for this command: it finished there. */
  receipt?:{replayed:boolean};
}
interface KindHandler{
  /** Re-running after an unknown outcome is safe (a read, an idempotent archive or import). */
  repeatable:boolean;
  /** The command has a journaled `host_command` form. */
  journal:boolean;
  /** Refused on a Host without command receipts: a late unjournaled copy could not be fenced. */
  requiresJournal?:boolean;
  policy:PolicyActionId;
  inner?(intent:HostCommandIntent):InnerWithoutId;
  /** A server-side effect that reaches the Host through its own owner (usage probe, history import). */
  run?(pool:Pool,config:ServerConfig,intent:HostCommandIntent,hosts:Registry):Promise<Delivery>;
  settle(db:Queryable,intent:HostCommandIntent,settlement:Settlement):Promise<Record<string,unknown>>;
}

const HOST_COMMAND_TIMEOUT_MS=20*60*1000;
const HOST_OFFLINE_RETRY_MS=30_000;
/**
 * A command whose frame never left gives up after this long: the person asked
 * for it now, and a Host that reconnects days later must not carry out a stale
 * install, removal or registration. Shorter than the browser's polling window.
 */
const HOST_UNSENT_EXPIRY_MS=10*60*1000;
const HOST_UNCONFIRMED_RETRY_MS=60_000;
/** A journaled command still unanswered after this long is reported; the Host may still hold it. */
const HOST_COMMAND_UNCONFIRMED_MS=24*60*60*1000;
/** Transport answers that mean the frame left and the Host's outcome is unknown. */
const UNKNOWN_ANSWERS=new Set(['host_timeout','host_disconnected','install_timed_out','tool_operation_timed_out','account_request_timed_out']);
/** A history import's transport losses (`requestAmbientImport`): the Host's listing is unknown. */
const AMBIENT_TRANSPORT_LOSSES=new Set(['host_disconnected','host_timeout','ambient_import_timed_out']);

const managedVersionOf=(installation:unknown)=>typeof installation==='string'&&installation.startsWith('managed:')?installation.slice('managed:'.length):null;
const frozen=<T=string>(intent:HostCommandIntent,key:string)=>intent.frozen_json[key] as T;
const str=(value:unknown)=>typeof value==='string'?value:null;
export const hostCommandFingerprint=(inner:InnerWithoutId)=>createHash('sha256').update(canonical(inner)).digest('hex');

async function hostReportsCommandReceipts(db:Queryable,hostId:string):Promise<boolean>{
  const row=(await db.query<{journaled:boolean}>(`SELECT (capabilities_json->>'host_command_receipts')='1' AS journaled FROM hosts WHERE id=$1`,[hostId])).rows[0];
  return row?.journaled===true;
}

/** The inner command's own answer, read the same way fresh or replayed. */
function settlementOf(frame:Record<string,unknown>):Settlement{
  const {type:_type,request_id:_request,...result}=frame;
  const ok=frame.ok===true;
  return {ok,result,error:ok?null:str(frame.error)??'host_command_failed'};
}

const tool=(policy:PolicyActionId,inner:(intent:HostCommandIntent)=>InnerWithoutId,settle:KindHandler['settle']):KindHandler=>({repeatable:false,journal:true,policy,inner,settle});

export const HOST_COMMAND_HANDLERS:Record<HostCommandKind,KindHandler>={
  runtime_install:tool('host.manage',intent=>({type:'install_tool',runtime_key:frozen(intent,'runtime_key'),version:frozen(intent,'version'),distribution:frozen(intent,'distribution'),login:frozen(intent,'login'),runtime_version_command:frozen(intent,'runtime_version_command'),health_check_protocol:frozen(intent,'health_check_protocol'),egress_transport:frozen(intent,'egress_transport')} as InnerWithoutId),
    async(db,intent,{result})=>{
      const before=frozen<string|null>(intent,'before_version');
      await recordHostRuntimeChange(db,{hostId:intent.host_id,runtimeKey:frozen(intent,'runtime_key'),action:before?'upgrade':'install',fromVersion:before,toVersion:managedVersionOf(result.installation),actorUserId:intent.user_id});
      return {host_id:intent.host_id,runtime_key:frozen(intent,'runtime_key'),ok:true,error:null,installation:str(result.installation)};
    }),
  runtime_uninstall:tool('host.manage',intent=>({type:'uninstall_tool',runtime_key:frozen(intent,'runtime_key'),version:frozen(intent,'version')}),
    async(db,intent,{result})=>{
      await recordHostRuntimeChange(db,{hostId:intent.host_id,runtimeKey:frozen(intent,'runtime_key'),action:'remove',fromVersion:frozen(intent,'version'),toVersion:null,actorUserId:intent.user_id});
      return {host_id:intent.host_id,runtime_key:frozen(intent,'runtime_key'),ok:true,error:null,installation:str(result.installation)};
    }),
  runtime_own_update:tool('host.manage',intent=>({type:'update_own_tool',runtime_key:frozen(intent,'runtime_key')} as InnerWithoutId),
    async(db,intent,{result})=>{
      const from=str(result.from_version),to=str(result.to_version),changed=!(from!==null&&from===to);
      if(changed)await recordHostRuntimeChange(db,{hostId:intent.host_id,runtimeKey:frozen(intent,'runtime_key'),action:'upgrade',fromVersion:from,toVersion:to,actorUserId:intent.user_id});
      return {host_id:intent.host_id,runtime_key:frozen(intent,'runtime_key'),ok:true,error:null,installation:str(result.installation),from_version:from,to_version:to,changed};
    }),
  runtime_managed_update:tool('host.manage',intent=>({type:'managed_cli',runtime_key:frozen(intent,'runtime_key'),operation:frozen(intent,'operation')} as InnerWithoutId),
    async(db,intent,{result})=>managedCliSettle(db,intent,result,'upgrade')),
  runtime_rollback:tool('host.manage',intent=>frozen(intent,'variant')==='managed_cli'
      ?{type:'managed_cli',runtime_key:frozen(intent,'runtime_key'),operation:{action:'rollback'}} as InnerWithoutId
      :{type:'rollback_tool',runtime_key:frozen(intent,'runtime_key')},
    async(db,intent,{result})=>{
      if(frozen(intent,'variant')==='managed_cli')return managedCliSettle(db,intent,result,'rollback');
      await recordHostRuntimeChange(db,{hostId:intent.host_id,runtimeKey:frozen(intent,'runtime_key'),action:'rollback',fromVersion:frozen<string|null>(intent,'before_version'),toVersion:managedVersionOf(result.installation),actorUserId:intent.user_id});
      return {host_id:intent.host_id,runtime_key:frozen(intent,'runtime_key'),ok:true,error:null,installation:str(result.installation)};
    }),
  ordinary_tool_install:tool('host.manage',ordinaryInner,ordinarySettle),
  ordinary_tool_register:tool('host.manage',ordinaryInner,ordinarySettle),
  ordinary_tool_remove:tool('host.manage',ordinaryInner,ordinarySettle),
  ordinary_account_logout:{repeatable:false,journal:true,policy:'host.account.manage',
    inner:intent=>({type:'ordinary_account_request',tool_id:frozen(intent,'tool_id'),account_key:frozen(intent,'account_key'),action:'logout'} as InnerWithoutId),
    async settle(_db,intent,{result}){return {host_id:intent.host_id,tool_id:frozen(intent,'tool_id'),status:result.status??null,...(result.logout?{logout:result.logout}:{})};},
  },
  agent_host_state_reset:{repeatable:true,journal:true,requiresJournal:true,policy:'agent.host_state.reset',
    inner:intent=>({type:'agent_profiles_reset',agent_id:intent.agent_id!}),
    async settle(_db,intent,{result}){return {agent_id:intent.agent_id,host_id:intent.host_id,profiles_archived:result.changed===true,sessions_retired:frozen<number>(intent,'sessions_retired')};},
  },
  workspace_register:{repeatable:false,journal:true,policy:'host.workspace.register',
    inner:intent=>({type:'workspace_register',path:frozen(intent,'path'),project_id:frozen(intent,'project_id'),name:frozen(intent,'name')}),
    async settle(_db,_intent,{result}){return {workspace_id:str(result.workspace_id),display_path:str(result.display_path)};},
  },
  runtime_usage_refresh:{repeatable:true,journal:false,policy:'host.manage',
    async run(pool,_config,intent,hosts){
      try{
        const row=await refreshHostUsage(pool,intent.host_id,frozen(intent,'runtime_key'),frozen(intent,'installation'),hosts as never);
        return {sent:true,answered:true,settlement:{ok:true,result:row as unknown as Record<string,unknown>,error:null}};
      }catch(error){return refusedRun(error);}
    },
    async settle(db,intent,{result}){
      // The probe may take the Host's full timeout: the copy must still be reported when it is released.
      const host=(await db.query<{capabilities_json:unknown}>('SELECT capabilities_json FROM hosts WHERE id=$1',[intent.host_id])).rows[0];
      if(!hostInstallationIds(host?.capabilities_json,frozen(intent,'runtime_key')).includes(frozen(intent,'installation')))throw new HostCommandRefusal(409,'The Host no longer reports this installation.',{code:'installation_gone'});
      return result;
    },
  },
  ambient_sync:{repeatable:true,journal:false,policy:'host.import.manage',
    async run(pool,config,intent){
      try{
        const report=await new ImportedSessionService(pool,config).sync({spaceId:intent.space_id,userId:intent.user_id},frozen(intent,'location_id'),{
          runtime_key:frozen(intent,'runtime_key'),installation:frozen(intent,'installation'),session_ids:frozen<string[]|null>(intent,'session_ids'),
          ...(frozen(intent,'visibility')?{visibility:frozen<'private'|'space_shared'>(intent,'visibility')}:{}),
        });
        return ambientDelivery(report as unknown as Record<string,unknown>);
      }catch(error){return refusedRun(error);}
    },
    async settle(_db,_intent,{result}){return result;},
  },
};

/**
 * What one history import's report means (`ImportedSessionService.sync`
 * reports, it does not throw). Each session lands whole in its own
 * transaction and a repeat reconciles by vendor identity, so the import may be
 * repeated; what it already committed is never reported as not having happened.
 * - no error: success, with the report;
 * - nothing committed and the Host offline or its answer lost: not done yet, repeated;
 * - nothing committed and a definite error: failed, with the report;
 * - something committed and then an error: `needs_attention`, with the report.
 */
export function ambientDelivery(report:Record<string,unknown>):Delivery{
  const error=str(report.error);
  if(error===null)return {sent:true,answered:true,settlement:{ok:true,result:report,error:null}};
  const committed=Number(report.sessions_written??0)>0||Number(report.marked_gone??0)>0;
  if(!committed&&error==='host_offline')return {sent:false,answered:false};
  if(!committed&&AMBIENT_TRANSPORT_LOSSES.has(error))return {sent:true,answered:false};
  return {sent:true,answered:true,settlement:{ok:false,result:report,error,
    outcome:committed?{status:'needs_attention',code:'ambient_sync_partial'}:{status:'failed',code:'ambient_sync_failed'}}};
}

/** A server-side owner's deterministic refusal (an `HttpError` it wrote for the person) settles as failed. */
function refusedRun(error:unknown):Delivery{
  const status=(error as {statusCode?:number})?.statusCode;
  if(error instanceof HttpError&&status!==undefined&&status>=400&&status<500)return {sent:true,answered:true,terminal:{status:'failed',code:'host_command_refused',detail:error.message}};
  throw error;
}

function ordinaryInner(intent:HostCommandIntent):InnerWithoutId{
  return {type:'ordinary_tool_request',operation:frozen(intent,'operation'),...(intent.frozen_json.egress_transport?{egress_transport:frozen(intent,'egress_transport')}:{})} as InnerWithoutId;
}
async function ordinarySettle(_db:Queryable,intent:HostCommandIntent,{result}:Settlement){
  return {host_id:intent.host_id,tool_id:frozen<{tool_id:string}>(intent,'operation').tool_id,ok:true,error:null,tool:result.tool??null};
}
async function managedCliSettle(db:Queryable,intent:HostCommandIntent,result:Record<string,unknown>,action:'upgrade'|'rollback'){
  const from=str(result.from_version),to=str(result.to_version);
  if(from!==to)await recordHostRuntimeChange(db,{hostId:intent.host_id,runtimeKey:frozen(intent,'runtime_key'),action,fromVersion:from,toVersion:to,actorUserId:intent.user_id});
  return {host_id:intent.host_id,runtime_key:frozen(intent,'runtime_key'),ok:true,error:null,installation:str(result.installation),from_version:from,to_version:to};
}

/** An unjournaled send through the registry's existing request for that frame. */
async function sendBare(hosts:Registry,hostId:string,inner:InnerWithoutId):Promise<{sent:boolean;frame:Record<string,unknown>}>{
  let answer:Record<string,unknown>;
  switch(inner.type){
    case 'install_tool':case 'uninstall_tool':case 'rollback_tool':case 'update_own_tool':case 'managed_cli':{
      const {type,...payload}=inner;answer={type:'tool_result',...await hosts.requestToolAction(hostId,type,payload as never)};break;
    }
    case 'ordinary_tool_request':{const {type:_t,...payload}=inner;answer={type:'ordinary_tool_result',...await hosts.requestOrdinaryTool(hostId,payload as never)};break;}
    case 'ordinary_account_request':{const {type:_t,...payload}=inner;answer={type:'ordinary_account_result',...await hosts.requestOrdinaryAccount(hostId,payload as never)};break;}
    case 'workspace_register':answer={type:'workspace_register_result',...await hosts.registerHostWorkspace(hostId,{path:inner.path,projectId:inner.project_id,name:inner.name})};break;
    case 'agent_profiles_reset':answer={type:'managed_workspace_result',...await hosts.resetAgentHostProfiles(hostId,inner.agent_id)};break;
  }
  const error=str(answer.error);
  // Refused before a frame left: no connection, or an operation already running on that copy or tool.
  const notSent=answer.ok!==true&&(error==='host_offline'||/already in progress/.test(error??''));
  return {sent:!notSent,frame:answer};
}

/** `journaled` is the committed effect's choice for this command, never re-read from a stale row. */
async function deliver(pool:Pool,config:ServerConfig,intent:HostCommandIntent,journaled:boolean,handler:KindHandler,hosts:Registry,sends:number):Promise<Delivery>{
  if(handler.run)return handler.run(pool,config,intent,hosts);
  const inner=handler.inner!(intent);
  if(journaled){
    const answer:HostCommandAnswer=await hosts.requestHostCommand(intent.host_id,{command_id:intent.id,fingerprint:hostCommandFingerprint(inner),command:{...inner,request_id:'pending'} as HostCommandInnerFrame},HOST_COMMAND_TIMEOUT_MS);
    if(!answer.sent)return {sent:false,answered:false};
    if(answer.outcome==='completed'&&answer.result)return {sent:true,answered:true,receipt:{replayed:answer.replayed},settlement:settlementOf(answer.result)};
    if(answer.outcome==='interrupted')return {sent:true,answered:true,terminal:{status:'needs_attention',code:'host_command_interrupted',detail:'The Host stopped while running this command; check its current state.'}};
    if(answer.outcome==='mismatch')return {sent:true,answered:true,terminal:{status:'needs_attention',code:'host_command_mismatch'}};
    // The Host ran it but its receipt is not durable yet: no proof, so the same command is repeated.
    if(answer.outcome==='unrecorded')return {sent:true,answered:false};
    // Refused means this delivery ran nothing; an earlier send of the same command may still have acted.
    if(answer.outcome==='refused')return {sent:true,answered:true,terminal:{status:sends>1?'needs_attention':'failed',code:'host_command_not_recorded',detail:answer.error}};
    return {sent:true,answered:false};
  }
  const bare=await sendBare(hosts,intent.host_id,inner);
  if(!bare.sent){
    const error=str(bare.frame.error);
    return error==='host_offline'?{sent:false,answered:false}:{sent:false,answered:true,terminal:{status:'failed',code:'host_command_busy',detail:error}};
  }
  if(bare.frame.ok!==true&&UNKNOWN_ANSWERS.has(str(bare.frame.error)??''))return {sent:true,answered:false};
  return {sent:true,answered:true,settlement:settlementOf(bare.frame)};
}

/**
 * Before a reset sends its own frame, every earlier reset of the same Agent
 * on the same Host that was sent and never proven (`owesHostReceipt`) is
 * re-delivered under its own command id and fingerprint. The Host's journal
 * answers it from its receipt, finishes it if it was left in progress, or
 * runs it if it never arrived — and from then on any late copy only replays.
 * Only that `completed` receipt is recorded as the earlier command's proof
 * (`effect_json.receipt`); anything else leaves the fence where it is.
 * - `clear`: nothing is owed any more;
 * - `waiting`: the Host is offline or did not answer; nothing of this reset left;
 * - `unprovable`: the Host answered, but not with a receipt (mismatch, refused, interrupted).
 */
async function reconcileEarlierResets(pool:Pool,intent:HostCommandIntent,job:JobEnvelopeForHandler,hosts:Registry):Promise<{state:'clear'}|{state:'waiting'}|{state:'unprovable';detail:string}>{
  const owed=(await pool.query<HostCommandIntent>(
    `SELECT * FROM host_command_intents WHERE host_id=$1 AND agent_id=$2 AND kind='agent_host_state_reset' AND id<>$3 AND created_at<=$4::timestamptz
       AND status='needs_attention' AND effect_json ? 'dispatched_at' AND NOT effect_json ? 'receipt' ORDER BY created_at`,
    [intent.host_id,intent.agent_id,intent.id,intent.created_at])).rows.filter(owesHostReceipt);
  for(const earlier of owed){
    // Every sent reset is journaled (`requiresJournal`); one that was not could never be fenced by a receipt.
    if(earlier.effect_json.journaled!==true)return {state:'unprovable',detail:'An earlier reset was sent without a command receipt.'};
    const inner=HOST_COMMAND_HANDLERS.agent_host_state_reset.inner!(earlier);
    const answer=await hosts.requestHostCommand(earlier.host_id,{command_id:earlier.id,fingerprint:hostCommandFingerprint(inner),command:{...inner,request_id:'pending'} as HostCommandInnerFrame},HOST_COMMAND_TIMEOUT_MS);
    // `unrecorded`: the Host holds the outcome but has not made its receipt durable yet; ask again later.
    if(!answer.sent||answer.outcome===null||answer.outcome==='unrecorded')return {state:'waiting'};
    if(answer.outcome!=='completed'||!answer.result)return {state:'unprovable',detail:`The Host could not confirm an earlier reset (${answer.outcome}).`};
    const proven=await pool.query(
      `UPDATE host_command_intents SET effect_json=effect_json||jsonb_build_object('receipt',jsonb_build_object('at',now(),'by',$2::text,'replayed',$3::boolean)),updated_at=now()
        WHERE id=$1 AND status='needs_attention' AND NOT effect_json ? 'receipt' AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=$4 AND j.claimed_by=$5 AND j.status='running')`,
      [earlier.id,intent.id,answer.replayed,job.job_id,job.worker_id]);
    if(!proven.rowCount&&!(await pool.query(`SELECT 1 FROM jobs WHERE id=$1 AND claimed_by=$2 AND status='running'`,[job.job_id,job.worker_id])).rows.length){
      throw new HostCommandLeaseLost('Host command Job no longer owns execution');
    }
  }
  return {state:'clear'};
}

class HostCommandLeaseLost extends Error{}
/** The person no longer holds what the command was admitted under: a hidden Host/Agent/Project, or a gone actor. */
const withdrawn=(error:unknown)=>error instanceof HostNotVisible||(error as {statusCode?:number})?.statusCode===404||(error as {statusCode?:number})?.statusCode===403;
const payload=z.object({intent_id:z.string().min(1).max(36)}).strict();

export function registerHostCommandHandler(registry:JobHandlerRegistry,config:ServerConfig):void{
  registry.register(HOST_COMMAND_JOB,async job=>{
    try{return await executeHostCommand(config,payload.parse(job.payload).intent_id,job);}
    catch(error){
      if(error instanceof JobDeferredError)throw error;
      // Job errors are user-readable transport; paths, account keys and Host text stay in the private status.
      throw new Error('Host command attempt did not complete; read its private status');
    }
  });
}

/**
 * Wakes this Host's waiting commands when it reconnects; the Job remains the
 * durable owner. Workers claim against their own clock, so a woken Job is
 * moved slightly into the past rather than to this database's `now()`.
 */
export async function wakeHostCommandsForHost(db:Queryable,hostId:string):Promise<void>{
  await db.query(`UPDATE jobs SET scheduled_at=now()-interval '5 seconds',updated_at=now() WHERE status='pending' AND job_type=$1
    AND scheduled_at>now()-interval '5 seconds'
    AND id IN (SELECT job_id FROM host_command_intents WHERE host_id=$2 AND status IN ('pending','dispatched'))`,[HOST_COMMAND_JOB,hostId]);
}

export async function executeHostCommand(config:ServerConfig,id:string,job:JobEnvelopeForHandler,hosts:Registry=sharedHostConnectionRegistry):Promise<Record<string,unknown>>{
  if(!config.databaseUrl)throw new Error('Host commands require a database');
  const pool=getDbPool(config.databaseUrl);
  const locked=await tryWithDedicatedSessionAdvisoryLock(pool,`host-command:${id}`,async()=>{
    let intent=await loadHostCommand(pool,id);
    if(!intent||intent.job_id!==job.job_id||intent.user_id!==job.user_id||intent.space_id!==job.space_id)throw new HostCommandLeaseLost('Host command does not own this Job');
    if(!['pending','dispatched'].includes(intent.status))return {intent_id:id,status:intent.status};
    const handler=HOST_COMMAND_HANDLERS[intent.kind];
    const effect:HostCommandEffect={...intent.effect_json};
    const assertLease=async(db:Queryable,lock=false)=>{
      if(!(await db.query(`SELECT id FROM jobs WHERE id=$1 AND claimed_by=$2 AND status='running'${lock?' FOR SHARE':''}`,[job.job_id,job.worker_id])).rows.length)throw new HostCommandLeaseLost('Host command Job no longer owns execution');
    };
    const audit=async(db:Queryable,phase:string,extra:Record<string,unknown>={})=>{
      const result=await enforce({...config,auditTransaction:db},await loadActionRegistry(config),{
        action:handler.policy,actor_type:'user',actor_id:intent!.user_id,space_id:intent!.space_id,resource_space_id:intent!.space_id,
        resource_type:handler.policy==='agent.host_state.reset'?'agent':handler.policy==='host.workspace.register'?'project':handler.policy==='host.import.manage'?'workspace_location':'host',
        resource_id:handler.policy==='agent.host_state.reset'?intent!.agent_id:handler.policy==='host.workspace.register'?frozen(intent!,'project_id'):handler.policy==='host.import.manage'?frozen(intent!,'location_id'):intent!.host_id,
        context:{trigger_origin:'manual',direct_user_write:true},metadata_json:{host_command_id:id,host_command_kind:intent!.kind,host_command_phase:phase,...extra},force_record:true,
      });
      if(result.status==='error')throw new HostCommandRefusal(409,'operation_audit_unavailable',{code:'operation_audit_unavailable'});
      if(result.status!=='allow')throw new HostNotVisible();
    };
    /** Under the lease and with authority rechecked: the only door to a send or a released result. */
    const owner=<T>(phase:'dispatch'|'settle',work:(db:Queryable)=>Promise<T>)=>withPolicyAuditRecovery(config.databaseUrl,()=>withQueryableTransaction(pool,async db=>{
      await assertLease(db,true);
      intent=(await loadHostCommand(db,id,true))!;
      if(!['pending','dispatched'].includes(intent.status))throw new HostCommandLeaseLost('Host command already settled');
      await assertCurrentActor(db,sessionActor({spaceId:intent.space_id,userId:intent.user_id}));
      await authorizeHostCommandResource(db,config,intent);
      await audit(db,phase);
      return work(db);
    }));
    /** Records an outcome that releases nothing; never needs the authority the command was admitted under. */
    const record=async(status:'failed'|'needs_attention'|'pending'|'dispatched',code:string|null,detail?:string|null)=>{
      effect.error_detail=detail?String(detail).slice(0,1000):null;
      const terminal=status==='failed'||status==='needs_attention';
      const result=await pool.query(
        `UPDATE host_command_intents i SET status=$3,error_code=$4,effect_json=$5::jsonb,frozen_json=CASE WHEN $6::boolean THEN ${REDACTED_FROZEN} ELSE frozen_json END,updated_at=now()
          WHERE i.id=$1 AND i.job_id=$2 AND i.status IN ('pending','dispatched') AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=$2 AND j.claimed_by=$7 AND j.status='running')`,
        [id,job.job_id,status,code,JSON.stringify(effect),terminal,job.worker_id]);
      if(!result.rowCount)throw new HostCommandLeaseLost('Host command progress no longer owns its Job');
      return {intent_id:id,status};
    };
    try{
      const unsentExpired=()=>!effect.dispatched_at&&Date.now()-new Date(intent!.created_at).getTime()>HOST_UNSENT_EXPIRY_MS;
      const step=await owner('dispatch',async db=>{
        if(effect.dispatched_at&&!effect.journaled&&!handler.repeatable)return 'unknown' as const;
        // A first send is decided here, under the intent's row lock: one never sent within the
        // window is given up whether or not the Host is online now, and no frame leaves. A command
        // already sent keeps its own path (repeat, unknown, unconfirmed): expiry never settles it.
        if(unsentExpired())return 'expired' as const;
        if(effect.dispatched_at&&Date.now()-Date.parse(effect.dispatched_at)>HOST_COMMAND_UNCONFIRMED_MS)return 'unconfirmed' as const;
        if(!hosts.isOnline(intent!.host_id))return 'offline' as const;
        const journaled=effect.dispatched_at?effect.journaled===true:handler.journal&&await hostReportsCommandReceipts(db,intent!.host_id);
        if(handler.requiresJournal&&!journaled)return 'update_required' as const;
        effect.dispatched_at??=new Date().toISOString();effect.journaled=journaled;effect.sends=(effect.sends??0)+1;
        await db.query(`UPDATE host_command_intents SET status='dispatched',effect_json=$2::jsonb,updated_at=now() WHERE id=$1`,[id,JSON.stringify(effect)]);
        return 'send' as const;
      });
      if(step==='unknown')return record('needs_attention','host_command_outcome_unknown','The earlier attempt may have reached the Host; check its current state before repeating.');
      if(step==='unconfirmed')return record('needs_attention','host_command_unconfirmed','The Host has not confirmed this command.');
      if(step==='update_required')return record('failed','host_update_required','Update this Host before using this command.');
      const offlineFailure='The Host was offline, so nothing was sent; request it again when the Host is online.';
      if(step==='expired')return hosts.isOnline(intent.host_id)
        ?record('failed','host_command_expired','The request waited too long to be sent, so nothing was sent; request it again.')
        :record('failed','host_offline',offlineFailure);
      if(step==='offline')throw new JobDeferredError('Host command is waiting for its Host',effect.dispatched_at?HOST_UNCONFIRMED_RETRY_MS:HOST_OFFLINE_RETRY_MS);
      await assertLease(pool);
      if(intent.kind==='agent_host_state_reset'){
        const earlier=await reconcileEarlierResets(pool,intent,job,hosts);
        if(earlier.state!=='clear'){
          // This reset's own frame has not left: a first attempt is not dispatched after all.
          const first=effect.sends===1;
          if(first){delete effect.dispatched_at;delete effect.journaled;effect.sends=0;}
          if(earlier.state==='unprovable')return record('failed','host_reset_unreconciled',earlier.detail);
          if(first&&unsentExpired())return record('failed','host_offline',offlineFailure);
          if(first)await record('pending',null);
          throw new JobDeferredError('Host command is waiting for its Host to confirm an earlier reset',HOST_OFFLINE_RETRY_MS);
        }
      }
      const delivery=await deliver(pool,config,intent,effect.journaled===true,handler,hosts,effect.sends??1);
      if(delivery.receipt)effect.receipt={at:new Date().toISOString(),by:id,replayed:delivery.receipt.replayed};
      if(!delivery.sent&&!delivery.answered){
        // Nothing left on this attempt. A first send never reached the Host: it is pending again.
        if(effect.sends===1){
          delete effect.dispatched_at;delete effect.journaled;effect.sends=0;
          if(unsentExpired())return record('failed','host_offline',offlineFailure);
          await record('pending',null);
        }
        throw new JobDeferredError('Host command is waiting for its Host',HOST_OFFLINE_RETRY_MS);
      }
      if(!delivery.answered){
        if(effect.journaled||handler.repeatable)throw new JobDeferredError('Host command answer is pending; the same command is repeated',HOST_UNCONFIRMED_RETRY_MS);
        return record('needs_attention','host_command_outcome_unknown','The Host did not answer; check its current state before repeating.');
      }
      if(delivery.terminal)return record(delivery.terminal.status,delivery.terminal.code,delivery.terminal.detail??null);
      const settlement=delivery.settlement!;
      if(!settlement.ok&&!settlement.outcome)return record('failed','host_command_failed',settlement.error);
      const settledStatus=settlement.outcome?.status??'succeeded';
      try{
        await owner('settle',async db=>{
          const result=await handler.settle(db,intent!,settlement);
          effect.error_detail=settlement.outcome&&settlement.error?settlement.error.slice(0,1000):null;
          await db.query(`UPDATE host_command_intents SET status=$4,result_json=$2::jsonb,effect_json=$3::jsonb,frozen_json=${REDACTED_FROZEN},error_code=$5,updated_at=now() WHERE id=$1`,
            [id,JSON.stringify(result),JSON.stringify(effect),settledStatus,settlement.outcome?.code??null]);
        });
      }catch(error){
        if(error instanceof HostCommandLeaseLost||error instanceof JobDeferredError)throw error;
        // The Host acted, but its result is no longer this person's to receive.
        if(withdrawn(error))return record('needs_attention','host_command_authority_withdrawn');
        if(error instanceof HostCommandRefusal)return record('needs_attention',String(error.responseBody.code??'host_command_refused'),error.message);
        throw error;
      }
      return {intent_id:id,status:settledStatus};
    }catch(error){
      if(error instanceof JobDeferredError||error instanceof HostCommandLeaseLost)throw error;
      const sent=Boolean(effect.dispatched_at);
      if(withdrawn(error))return record(sent?'needs_attention':'failed','host_command_authority_withdrawn');
      if(error instanceof HostCommandRefusal)return record(sent?'needs_attention':'failed',String(error.responseBody.code??'host_command_refused'),error.message);
      if(job.attempts>=job.max_attempts)await record(sent?'needs_attention':'failed','operation_internal_error').catch(()=>undefined);
      throw error;
    }
  });
  if(!locked.acquired)throw new JobDeferredError('Host command is already running',1000);
  return locked.value;
}
