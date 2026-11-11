import {AsyncLocalStorage} from 'node:async_hooks';
import type {OperationResponse,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {isInstanceAdminIn,isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import {admitSystemCommand,SystemCommandRefusal,type SystemCommandKindHandler} from '../systemCommands/intents.js';
import {classifySettingsError,settingsPolicyContext,user} from '../systemCommands/operationSupport.js';
import {pluginServiceFor} from './service.js';
import {getOfficialPlugin} from './registry.js';
import {installOfficialPlugin} from './installer.js';
import {BUILT_IN_PLUGINS} from './builtInPlugins.js';
import {
  applyOperationPluginEnabledIn,aroundOperationPluginTransition,authorizedPluginTransition,hasOperationPluginEffects,
  type OperationPluginTransition,
} from './lifecycle.js';

/**
 * Official plugin lifecycle commands (`plugin.*`). Scope is the descriptor's
 * (B53): a Space plugin is written by a Space owner or admin, a user plugin
 * only by that user. Installation is the instance admin's: its plugin-owned
 * migrations are multi-statement DDL, so it is a system command whose worker
 * runs them in its own transaction together with the intent's settlement
 * (`plugin_install`, never an unknown outcome). Enable/disable of an operation
 * package keeps its process-local effects outside every transaction
 * (`aroundOperationPluginTransition`), the DB half runs in the operation and
 * a disable's local cleanup follows its commit.
 */
type Input={plugin_id:string;settings?:Record<string,unknown>};
type Id='official_plugin.enable'|'official_plugin.disable'|'official_plugin.settings.update';
const transitions=new AsyncLocalStorage<OperationPluginTransition>();
const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;

/** B53 write authority for one plugin at its declared scope, in the caller's transaction. */
export async function assertPluginWritable(db:Queryable,config:ServerConfig,pluginId:string,spaceId:string,userId:string):Promise<void>{
  const descriptor=getOfficialPlugin(pluginId,config);
  if(!descriptor)throw hidden();
  if(descriptor.scope==='space'&&!await isSpaceOwnerOrAdminIn(db,spaceId,userId))throw hidden();
}
async function assertInstallable(db:Queryable,config:ServerConfig,pluginId:string,spaceId:string,userId:string):Promise<void>{
  await assertPluginWritable(db,config,pluginId,spaceId,userId);
  if(!await isInstanceAdminIn(db,config,userId))throw hidden();
}

export function pluginSettingsOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  const direct=(['official_plugin.enable','official_plugin.disable','official_plugin.settings.update'] as Id[]).map((id):OperationRegistration=>({
    definition:definitions.get(id)!,
    async resolve(_db,raw){const i=raw as Input;return {authority:`plugin:${i.plugin_id}`,targets:{plugin_id:i.plugin_id},resourceType:'plugin',resourceId:i.plugin_id};},
    async authorize(db,raw,a){await assertPluginWritable(db,config,(raw as Input).plugin_id,a.space_id,user(a));},
    async authorizeResult(db,raw,a){
      const pluginId=String(((raw as {descriptor?:{id?:unknown}}).descriptor?.id)??'');
      await assertPluginWritable(db,config,pluginId,a.space_id,user(a));
    },
    policyContext:settingsPolicyContext,
    async execute(db,raw,a){
      const i=raw as Input,u=user(a),service=pluginServiceFor(config);
      if(id==='official_plugin.settings.update')return json(await service.patchSettings(db,i.plugin_id,a.space_id,u,i.settings!));
      const enabled=id==='official_plugin.enable';
      if(hasOperationPluginEffects(config,i.plugin_id)){
        // Only the retained URL's `around` step may give this command its local transition.
        const transition=transitions.getStore();
        if(!transition)throw hidden();
        return json(await applyOperationPluginEnabledIn(db,config,i.plugin_id,a.space_id,u,enabled,transition,i.settings));
      }
      return json(enabled?await service.enablePlugin(db,i.plugin_id,a.space_id,u,{settings:i.settings}):await service.disablePlugin(db,i.plugin_id,a.space_id,u));
    },
    classifyError:error=>classifySettingsError(error,'plugins'),
  }));
  const install:OperationRegistration={
    definition:definitions.get('official_plugin.install')!,successStatus:202,
    async resolve(_db,raw){const i=raw as Input;return {authority:`plugin:${i.plugin_id}`,targets:{plugin_id:i.plugin_id},resourceType:'plugin',resourceId:i.plugin_id};},
    async authorize(db,raw,a){await assertInstallable(db,config,(raw as Input).plugin_id,a.space_id,user(a));},
    async authorizeResult(db,_raw,a){if(!await isInstanceAdminIn(db,config,user(a)))throw hidden();},
    policyContext:settingsPolicyContext,
    async execute(db,raw,a){
      const pluginId=(raw as Input).plugin_id;
      return admitSystemCommand(db,{spaceId:a.space_id,userId:user(a),kind:'plugin_install',scope:{plugin_id:pluginId},frozen:{plugin_id:pluginId,operation_id:'official_plugin.install'}});
    },
    classifyError:error=>classifySettingsError(error,'plugins'),
  };
  return [...direct,install];
}

/**
 * The retained enable/disable URLs' local step. Authority is checked before
 * anything else (read-only); the operation rechecks it in its transaction.
 * No local effect is touched until the operation has validated, keyed and
 * committed a new outcome: a refusal, a conflict, a malformed or unkeyed
 * request and a replayed receipt leave every local effect as it was. A
 * committed disable's cleanup runs after commit from the durable obligation
 * its transaction recorded; the first response reports a cleanup that did not
 * finish (`cleanup_pending`, and the `scope_cleanup_failed` event).
 */
export function pluginTransitionAround(config:ServerConfig,enabled:boolean){
  return async(identity:{spaceId:string;userId:string},input:Record<string,unknown>,run:()=>Promise<OperationResponse>):Promise<OperationResponse>=>{
    const pluginId=typeof input.plugin_id==='string'?input.plugin_id:'';
    if(!hasOperationPluginEffects(config,pluginId))return run();
    await authorizedPluginTransition(config,pluginId,identity.spaceId,identity.userId);
    const out=await aroundOperationPluginTransition(config,pluginId,identity.spaceId,identity.userId,enabled,async transition=>{
      const response=await transitions.run(transition,run);
      return {committed:!response.replayed&&'status' in response.body&&response.body.status==='succeeded',value:response};
    });
    const body=out.value.body as {status?:string;data?:Record<string,unknown>};
    if(out.cleanupFailures&&body.status==='succeeded'&&body.data)return {...out.value,body:{...body,data:{...body.data,cleanup_pending:true}}} as OperationResponse;
    return out.value;
  };
}

/** `plugin_install`: the migrations and the settlement are one worker transaction. */
export const PLUGIN_SYSTEM_COMMAND_HANDLERS={
  plugin_install:{
    policy:'official_plugin.manage',resourceType:'plugin',resourceId:intent=>String(intent.frozen_json.plugin_id??''),repeatable:true,
    authorize:(db,config,intent)=>assertInstallable(db,config,String(intent.frozen_json.plugin_id??''),intent.space_id,intent.user_id),
    async atomic(db,config,intent){
      const pluginId=String(intent.frozen_json.plugin_id);
      // A migration the installer refuses (checksum drift, an earlier failure, an operation package)
      // is a definite outcome: the transaction rolls back and the command fails, it is not retried.
      const installed=await installOfficialPlugin(db,pluginId,BUILT_IN_PLUGINS,{actorUserId:intent.user_id,source:'official'}).catch(error=>{
        if(error instanceof HttpError&&(error.statusCode===409||error.statusCode===422))throw new SystemCommandRefusal(error.statusCode,error.message,{code:'plugin_install_refused'});
        throw error;
      });
      const item=await pluginServiceFor(config).getPlugin(db,pluginId,intent.space_id,intent.user_id);
      return json({install:installed,item}) as Record<string,unknown>;
    },
  },
} satisfies Record<string,SystemCommandKindHandler>;
