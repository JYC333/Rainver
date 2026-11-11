import {
  HOST_COMMAND_OPERATION_KIND,HOST_COMMAND_OPERATION_SCHEMAS,HOST_DIRECT_OPERATION_SCHEMAS,ORDINARY_TOOL_CATALOG,
  isOwnCliUpdateRuntimeKey,repositoryAcpAdapter,type OperationActor,type RegisteredSystemActionDefinition,
} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {assertProjectWriter} from '../projects/access.js';
import {getRuntimeAdapterSpec} from '../runtimeAdapters/index.js';
import {managedHostEgressTransport,readInstanceOperationsPolicyIn} from '../settings/index.js';
import {TERMINAL_RUN_STATUSES} from '../runs/orchestrationResults.js';
import {acpRuntimeProbe} from './runtimeProbes.js';
import {hasSubscriptionQuota} from './usageService.js';
import {hostInstallationIds,normalizeHostCapabilities} from './capabilities.js';
import {ownCliReleases} from './ownCliReleases.js';
import {PgRuntimeProvisioningRepository} from './runtimeProvisioningRepository.js';
import {sharedServerOpenCodeProvisioner} from './serverOpenCodeProvisioner.js';
import {PgHostThreadRepository} from './threadRepository.js';
import {ordinaryAccountKey} from './ordinaryToolAccountRoutes.js';
import {cutOffRevokedHost} from './revocation.js';
import {managedVersionOf,posixAbsoluteCommandPath,remoteInstallableRuntimeKeys} from './runtimeEligibility.js';
import {
  HostCommandRefusal,HostNotVisible,admitHostCommand,assertHostCommandReadable,loadHostCommand,lockAgentHostResetAdmission,
  lockManagedHost,lockUsableHost,type ManagedHost,
} from './hostCommands.js';

type CommandId=keyof typeof HOST_COMMAND_OPERATION_SCHEMAS;
type DirectId=keyof typeof HOST_DIRECT_OPERATION_SCHEMAS;
type Input=Record<string,unknown>&{host_id:string};
const user=(a:OperationActor)=>a.on_behalf_of_user_id!;
const refuse=(status:409|422,message:string,code?:string)=>new HostCommandRefusal(status,message,code?{code}:{});

/** Commands that are meaningless for the built-in Host keep answering the hidden 404 there. */
const PAIRED_ONLY=new Set<string>(['host.workspace.register','host.runtime.own_update','agent.host_state.reset','host.provider_proxy.set','host.revoke']);

async function currentManagedVersion(host:ManagedHost,runtimeKey:string):Promise<string|null>{
  return hostInstallationIds(host.capabilities_json,runtimeKey).map(managedVersionOf).find((v):v is string=>v!==null)??null;
}
function hostReportsReceipts(host:ManagedHost):boolean{
  return (host.capabilities_json as Record<string,unknown>|null)?.host_command_receipts===1;
}

/**
 * What one admitted command freezes: every parameter its Host frame needs,
 * decided now under the locked authority. The worker sends exactly this, so a
 * repeated send is the same command.
 */
async function admission(db:Queryable,config:ServerConfig,id:CommandId,input:Input,a:OperationActor){
  const u=user(a);
  switch(id){
    case 'host.workspace.register':{
      const host=await lockManagedHost(db,config,input.host_id,u);
      await assertProjectWriter(db,a.space_id,String(input.project_id),u);
      return {host,scope:{path:input.path},frozen:{project_id:input.project_id,path:input.path,name:String(input.name).trim()}};
    }
    case 'host.runtime.install':{
      const host=await lockManagedHost(db,config,input.host_id,u,{allowBuiltin:true});
      const runtimeKey=String(input.runtime_key);
      if(!remoteInstallableRuntimeKeys().includes(runtimeKey))throw refuse(422,`Runtime adapter '${runtimeKey}' is not eligible for remote dispatch`);
      const probe=acpRuntimeProbe(runtimeKey,host.kind==='server'?'server':'remote');
      if(!probe?.distribution||!probe.version)throw refuse(422,`Runtime adapter '${runtimeKey}' has no distribution to install from`);
      if(repositoryAcpAdapter(runtimeKey)&&input.expected_version!==undefined)throw refuse(422,'ACP adapter versions are managed by the Rainver release');
      if(input.expected_version!==undefined&&input.expected_version!==probe.version)throw refuse(409,'The available ACP version changed. Refresh the agent list before installing.','version_changed');
      const before=await currentManagedVersion(host,runtimeKey);
      if(repositoryAcpAdapter(runtimeKey)&&before)throw refuse(409,'Use the native CLI update action; ACP adapters follow the Rainver release');
      const spec=getRuntimeAdapterSpec(runtimeKey);
      return {host,scope:{runtime:runtimeKey},frozen:{
        runtime_key:runtimeKey,version:probe.version,distribution:probe.distribution,login:probe.login,before_version:before,
        runtime_version_command:spec?.managed_runtime_version_command??null,health_check_protocol:spec?.invocation?.protocol==='acp'?'acp':null,
        egress_transport:host.kind==='server'?managedHostEgressTransport(await readInstanceOperationsPolicyIn(db,config)):{mode:'direct'},
      }};
    }
    case 'host.runtime.uninstall':{
      const host=await lockManagedHost(db,config,input.host_id,u,{allowBuiltin:true});
      const installation=String(input.installation);
      if(!installation.startsWith('managed:'))throw refuse(422,'Only a managed installation can be removed');
      return {host,scope:{runtime:input.runtime_key},frozen:{runtime_key:input.runtime_key,version:installation.slice('managed:'.length)}};
    }
    case 'host.runtime.own_update':{
      const host=await lockManagedHost(db,config,input.host_id,u);
      if(!isOwnCliUpdateRuntimeKey(String(input.runtime_key)))throw refuse(422,'Updating this own CLI is not supported yet');
      return {host,scope:{runtime:input.runtime_key},frozen:{runtime_key:input.runtime_key}};
    }
    case 'host.runtime.managed_update':
    case 'host.runtime.rollback':{
      const host=await lockManagedHost(db,config,input.host_id,u,{allowBuiltin:true});
      const runtimeKey=String(input.runtime_key);
      if(id==='host.runtime.rollback'&&!repositoryAcpAdapter(runtimeKey)){
        return {host,scope:{runtime:runtimeKey},frozen:{runtime_key:runtimeKey,variant:'tool',before_version:await currentManagedVersion(host,runtimeKey)}};
      }
      if(!isOwnCliUpdateRuntimeKey(runtimeKey))throw refuse(422,'This runtime has no separate CLI updater');
      const caps=normalizeHostCapabilities(host.capabilities_json);
      if(!caps.managed_cli_updates)throw refuse(409,'Update this Host before managing its CLI versions','host_update_required');
      if(!caps.installations[runtimeKey]?.some(copy=>copy.id!=='own'))throw refuse(409,'Install this managed CLI first');
      if(id==='host.runtime.rollback')return {host,scope:{runtime:runtimeKey},frozen:{runtime_key:runtimeKey,variant:'managed_cli'}};
      const version=ownCliReleases.peek(runtimeKey);
      if(!version)throw refuse(409,'The latest CLI release is not available yet. Refresh and retry.');
      return {host,scope:{runtime:runtimeKey},frozen:{runtime_key:runtimeKey,operation:{action:'update',version}}};
    }
    case 'host.runtime.usage.refresh':{
      const host=await lockManagedHost(db,config,input.host_id,u,{allowBuiltin:true});
      const runtimeKey=String(input.runtime_key),installation=String(input.installation);
      if(!hasSubscriptionQuota(runtimeKey))throw refuse(422,`Runtime adapter '${runtimeKey}' reports no subscription quota`);
      // Checked against what the Host reports: an arbitrary copy would spend a probe to learn nothing.
      if(!hostInstallationIds(host.capabilities_json,runtimeKey).includes(installation))throw refuse(422,`Host does not report installation '${installation}' of '${runtimeKey}'`);
      return {host,scope:{usage:runtimeKey,installation},frozen:{runtime_key:runtimeKey,installation}};
    }
    case 'host.ordinary_tool.install':
    case 'host.ordinary_tool.register':
    case 'host.ordinary_tool.remove':{
      const host=await lockManagedHost(db,config,input.host_id,u,{allowBuiltin:true});
      const toolId=input.tool_id as keyof typeof ORDINARY_TOOL_CATALOG;
      // Only Linux and macOS: the catalog's executables are bare POSIX names and its recipes POSIX archives.
      if(host.platform!=='linux'&&host.platform!=='darwin')throw refuse(422,'Ordinary CLI tools are supported on Linux and macOS Hosts only.');
      let operation:Record<string,unknown>;
      if(id==='host.ordinary_tool.install'){
        const recipe=ORDINARY_TOOL_CATALOG[toolId].managed;
        if(!recipe)throw refuse(422,"This tool has no managed installation; register the machine's own copy instead.");
        operation={action:'install',tool_id:toolId,version:recipe.version};
      }else if(id==='host.ordinary_tool.register'){
        const path=(input.path??null) as string|null;
        if(path!==null&&!posixAbsoluteCommandPath(path))throw refuse(422,'path must be an absolute path on the Host, without NUL characters.');
        operation={action:'register',tool_id:toolId,path};
      }else operation={action:'remove',tool_id:toolId,source:input.source};
      if(!normalizeHostCapabilities(host.capabilities_json).ordinary_tools)throw refuse(409,"Update this Host's rainver-host to manage ordinary CLI tools.",'host_update_required');
      return {host,scope:{ordinary:toolId},frozen:{operation,...(id==='host.ordinary_tool.install'&&host.kind==='server'?{egress_transport:managedHostEgressTransport(await readInstanceOperationsPolicyIn(db,config))}:{})}};
    }
    case 'host.ordinary_tool.account.logout':{
      const host=await lockUsableHost(db,input.host_id,u);
      const accounts=normalizeHostCapabilities(host.capabilities_json).ordinary_tool_accounts;
      if(!accounts)throw refuse(409,"Update this Host's rainver-host to use personal CLI accounts.",'host_update_required');
      if(!accounts.supported)throw refuse(409,accounts.reason??'Personal CLI accounts are not supported on this Host.','unsupported');
      // The account is always the caller's: its key is derived from them, never from input.
      return {host,scope:{account:u,tool:input.tool_id},frozen:{tool_id:input.tool_id,account_key:ordinaryAccountKey(u)}};
    }
    case 'agent.host_state.reset':{
      const host=await lockManagedHost(db,config,input.host_id,u);
      const agentId=String(input.agent_id);
      const agent=(await db.query<{owner_user_id:string|null}>('SELECT owner_user_id FROM agents WHERE id=$1 AND space_id=$2 FOR SHARE',[agentId,a.space_id])).rows[0];
      // An ownerless Agent (a Space or Project Assistant) is cleared by whoever owns the Host: the state is on their machine.
      if(!agent||agent.owner_user_id&&agent.owner_user_id!==u)throw new HostNotVisible();
      // Moving profiles needs a journal: an unjournaled late copy could rename a profile under a later Run.
      if(!hostReportsReceipts(host))throw refuse(409,"Update this Host's rainver-host before clearing an Agent's CLI state.",'host_update_required');
      await lockAgentHostResetAdmission(db,host.id,agentId);
      // The Agent's threads on this Host, held until commit: a dispatch claiming its lock blocks on them,
      // and a Task/Automation thread is asked whether a Run is still writing into the profile.
      const threads=await db.query<{id:string;dispatch_lock_id:string|null;run_in_flight:boolean}>(
        `SELECT thread.id,thread.dispatch_lock_id,
                EXISTS(SELECT 1 FROM runs r WHERE r.host_task_thread_id=thread.id AND r.status<>ALL($3::text[])) AS run_in_flight
           FROM host_threads thread
          WHERE COALESCE(thread.execution_host_id,(SELECT wl.execution_host_id FROM workspace_locations wl WHERE wl.id=thread.workspace_location_id))=$2
            AND thread.status IN ('active','session_reset')
            AND (thread.agent_id=$1 OR (thread.agent_id IS NULL AND (SELECT r.agent_id FROM runs r WHERE r.host_task_thread_id=thread.id ORDER BY r.created_at DESC LIMIT 1)=$1))
          FOR UPDATE OF thread`,[agentId,host.id,[...TERMINAL_RUN_STATUSES]]);
      if(threads.rows.some(t=>t.dispatch_lock_id))throw refuse(409,'The Agent is handling a message; try again when it finishes');
      if(threads.rows.some(t=>t.run_in_flight))throw refuse(409,'The Agent has a Run in flight on this Host; try again when it finishes');
      // A Room re-add restore of this Agent's state on this Host that is not finished would interleave with
      // the archive; it waits on this reset's fence if it starts later (`rooms/workspaceRestoreJob.ts`).
      const restoring=(await db.query(`SELECT 1 FROM jobs WHERE job_type='room_agent_workspace_restore' AND status IN ('pending','claimed','running')
          AND payload_json->>'agent_id'=$1 AND payload_json->>'host_id'=$2 LIMIT 1`,[agentId,host.id])).rows[0];
      if(restoring)throw refuse(409,"The Agent's previous Room state is still being restored on this Host; try again when it finishes",'host_restore_in_progress');
      // Retired with the intent: the next turn starts a fresh session whatever the Host does; the
      // launch fence (`agentHostResetFence`) keeps every launch off these profiles until the Host answers.
      const retired=await new PgHostThreadRepository(db).retireAgentSessionsOnHost(agentId,host.id);
      return {host,agentId,scope:{agent:agentId},frozen:{sessions_retired:retired}};
    }
    case 'host.location.ambient.sync':{
      const target=await ambientTarget(db,config,a,String(input.location_id));
      const runtimeKey=String(input.runtime_key);
      if(!acpRuntimeProbe(runtimeKey))throw refuse(422,`Unknown runtime adapter ${runtimeKey}`);
      const installation=String(input.installation??'own');
      return {host:target.host,scope:{location:input.location_id,runtime:runtimeKey,installation},frozen:{
        location_id:input.location_id,runtime_key:runtimeKey,installation,session_ids:input.session_ids??null,visibility:input.visibility??null}};
    }
  }
}

/**
 * The Location an ambient-history command is about, under the same three
 * checks as its owning service: a paired Host's Location in this Space, the
 * Host's registered owner, and Project write.
 */
export async function ambientTarget(db:Queryable,config:ServerConfig,a:OperationActor,locationId:string){
  const row=(await db.query<{space_id:string;project_id:string;host_id:string;kind:string}>(
    `SELECT wl.space_id,f.project_id,wl.execution_host_id AS host_id,h.kind FROM workspace_locations wl
       JOIN project_folders f ON f.id=wl.project_folder_id AND f.space_id=wl.space_id JOIN hosts h ON h.id=wl.execution_host_id
      WHERE wl.id=$1 FOR SHARE OF wl`,[locationId])).rows[0];
  if(!row||row.space_id!==a.space_id)throw new HostNotVisible();
  if(row.kind!=='remote')throw refuse(422,"Ambient session import applies to a paired host's own CLI history, not to a server-host location");
  const host=await lockManagedHost(db,config,row.host_id,user(a));
  await assertProjectWriter(db,a.space_id,row.project_id,user(a));
  return {host,projectId:row.project_id};
}

function classify(error:unknown){
  if(error instanceof HostCommandRefusal)return markedRefusal(error,'hosts');
  // Two people (or tabs) admitting the same Host scope at once: the unique active index is the referee.
  if((error as {code?:string;constraint?:string})?.code==='23505'&&(error as {constraint?:string}).constraint==='uq_host_command_active_scope')
    return markedRefusal({statusCode:409,message:'Another request for this is already in progress on this Host.',responseBody:{code:'host_command_busy'}},'hosts');
  return undefined;
}

export function hostCommandRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return (Object.keys(HOST_COMMAND_OPERATION_SCHEMAS) as CommandId[]).map(id=>({
    definition:definitions.get(id)!,successStatus:202 as const,
    async resolve(_db,raw){
      const i=raw as Record<string,unknown>;
      if(id==='host.location.ambient.sync')return {authority:`location:${i.location_id}`,targets:{location_id:i.location_id},resourceType:'workspace_location',resourceId:String(i.location_id)};
      if(id==='agent.host_state.reset')return {authority:`host:${i.host_id}`,targets:{host_id:i.host_id,agent_id:i.agent_id},resourceType:'agent',resourceId:String(i.agent_id)};
      return {authority:`host:${i.host_id}`,targets:{host_id:i.host_id},resourceType:id==='host.workspace.register'?'project':'host',resourceId:String(id==='host.workspace.register'?i.project_id:i.host_id)};
    },
    async authorize(db,raw,a){
      const i=raw as Input;
      if(id==='host.location.ambient.sync'){await ambientTarget(db,config,a,String(i.location_id));return;}
      if(id==='host.ordinary_tool.account.logout'){await lockUsableHost(db,i.host_id,user(a));return;}
      await lockManagedHost(db,config,i.host_id,user(a),{allowBuiltin:!PAIRED_ONLY.has(id)});
    },
    async authorizeResult(db,raw,a){
      const receipt=raw as {id:string;space_id:string};
      if(receipt.space_id!==a.space_id)throw hidden();
      const intent=await loadHostCommand(db,receipt.id);
      if(!intent)throw hidden();
      await assertHostCommandReadable(db,config,intent,a.space_id,user(a));
    },
    policyContext(){return {trigger_origin:'manual',direct_user_write:true};},
    async execute(db,raw,a){
      const i=raw as Input;
      const admitted=await admission(db,config,id,i,a);
      return admitHostCommand(db,{spaceId:a.space_id,userId:user(a),hostId:admitted.host.id,agentId:'agentId' in admitted?admitted.agentId:null,
        kind:HOST_COMMAND_OPERATION_KIND[id],scope:admitted.scope,frozen:{...admitted.frozen,operation_id:id}});
    },
    classifyError:classify,
  }));
}

export function hostDirectRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return (['host.runtime.provisioning.retry','host.provider_proxy.set','host.revoke'] as DirectId[]).map(id=>({
    definition:definitions.get(id)!,...(id==='host.runtime.provisioning.retry'?{successStatus:202 as const}:{}),
    async resolve(_db,raw){const i=raw as Input;return {authority:`host:${i.host_id}`,targets:{host_id:i.host_id},resourceType:'host',resourceId:i.host_id};},
    async authorize(db,raw,a){
      const i=raw as Input;
      if(id==='host.revoke'){
        // Revocation is the owner's, and stays theirs to have done: a replay of it after it
        // committed is admitted here, and a new revoke of a revoked Host changes nothing (404).
        const row=(await db.query<{owner_user_id:string|null;kind:string}>('SELECT owner_user_id,kind FROM hosts WHERE id=$1 FOR UPDATE',[i.host_id])).rows[0];
        if(!row||row.kind!=='remote'||row.owner_user_id!==user(a))throw new HostNotVisible();
        return;
      }
      await lockManagedHost(db,config,i.host_id,user(a),{allowBuiltin:!PAIRED_ONLY.has(id)});
    },
    async authorizeResult(db,raw,a){
      const out=raw as {host_id:string;space_id:string};
      if(out.space_id!==a.space_id)throw hidden();
      // A revoked Host stays its owner's to have revoked; every other result needs live management.
      if(id==='host.revoke'){const row=(await db.query<{owner_user_id:string|null}>('SELECT owner_user_id FROM hosts WHERE id=$1',[out.host_id])).rows[0];if(row?.owner_user_id!==user(a))throw hidden();return;}
      await lockManagedHost(db,config,out.host_id,user(a),{allowBuiltin:!PAIRED_ONLY.has(id)});
    },
    policyContext(){return {trigger_origin:'manual',direct_user_write:true};},
    async execute(db,raw,a){
      const i=raw as Input&{base_url?:string|null};
      switch(id){
        case 'host.runtime.provisioning.retry':{
          const host=await lockManagedHost(db,config,i.host_id,user(a),{allowBuiltin:true});
          if(host.kind!=='server')throw new HostNotVisible();
          const repo=new PgRuntimeProvisioningRepository(db),existing=await repo.get(host.id,'opencode');
          const state=existing?await repo.retry(host.id,'opencode',existing.desired_version):null;
          if(!state)throw refuse(409,'Only a failed Server OpenCode installation can be retried.');
          return {host_id:host.id,space_id:a.space_id,runtime_key:'opencode' as const,state:state.state as 'queued',desired_version:state.desired_version};
        }
        case 'host.provider_proxy.set':{
          const raw=typeof i.base_url==='string'?i.base_url.trim():'';
          let baseUrl:string|null=null;
          if(raw){
            let parsed:URL;
            try{parsed=new URL(raw);}catch{throw refuse(422,'base_url must be an absolute http(s) URL');}
            if(parsed.protocol!=='http:'&&parsed.protocol!=='https:')throw refuse(422,'base_url must be http or https');
            baseUrl=raw.replace(/\/+$/,'');
          }
          await db.query('UPDATE hosts SET provider_proxy_base_url=$2,updated_at=now() WHERE id=$1',[i.host_id,baseUrl]);
          return {host_id:i.host_id,space_id:a.space_id,provider_proxy_base_url:baseUrl};
        }
        case 'host.revoke':{
          const updated=await db.query(`UPDATE hosts SET status='revoked',token_hash=NULL,updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND kind='remote' AND status<>'revoked'`,[i.host_id,user(a)]);
          if(!updated.rowCount)throw new HostNotVisible();
          return {host_id:i.host_id,space_id:a.space_id,revoked:true as const};
        }
        default:throw hidden();
      }
    },
    ...(id==='host.revoke'?{async afterCommit(output:unknown){cutOffRevokedHost((output as {host_id:string}).host_id);}}:{}),
    ...(id==='host.runtime.provisioning.retry'?{async afterCommit(){
      // Rebuildable: the scheduler's provisioner reconciles queued rows on its own cadence.
      void sharedServerOpenCodeProvisioner(getDbPool(config.databaseUrl!),{config}).reconcile();
    }}:{}),
    classifyError:classify,
  }));
}
