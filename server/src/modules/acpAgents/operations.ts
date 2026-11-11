import type {RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {isInstanceAdminIn} from '../routeUtils/access.js';
import {classifySettingsError,settingsPolicyContext,user} from '../systemCommands/operationSupport.js';
import {AcpAgentService,acpAgentRuntimeKey} from './service.js';

/**
 * The instance ACP registry (`acp_agent.enable` / `.disable`): an instance
 * admin decision written to the instance setting in the operation
 * transaction. The registry fetch happens before the transaction (the
 * adapter's `prepare`); publishing to this process's adapter catalog happens
 * after commit, and every process's 60-second refresh rebuilds it from the
 * committed setting (`startAcpAgentSpecRefresh`).
 */
type Id='acp_agent.enable'|'acp_agent.disable';
export function acpAgentOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return (['acp_agent.enable','acp_agent.disable'] as Id[]).map((id):OperationRegistration=>({
    definition:definitions.get(id)!,...(id==='acp_agent.enable'?{successStatus:201 as const}:{}),
    async resolve(_db,raw){const registryId=String((raw as {registry_id:string}).registry_id);return {authority:`acp_registry:${registryId}`,targets:{registry_id:registryId},resourceType:'instance',resourceId:null};},
    async authorize(db,_raw,a){if(!await isInstanceAdminIn(db,config,user(a)))throw hidden();},
    async authorizeResult(db,_raw,a){if(!await isInstanceAdminIn(db,config,user(a)))throw hidden();},
    policyContext:settingsPolicyContext,
    async execute(db,raw,a){
      const registryId=String((raw as {registry_id:string}).registry_id);
      const service=new AcpAgentService(db);
      if(id==='acp_agent.enable'){
        const agent=await service.enableIn(registryId,user(a));
        return JSON.parse(JSON.stringify({...agent,runtime_key:acpAgentRuntimeKey(agent.id),installed_on:[]}));
      }
      if(!await service.disableIn(registryId,user(a)))throw hidden();
      return {registry_id:registryId,space_id:a.space_id,disabled:true};
    },
    async afterCommit(){
      // Process-local reach only; the refresh timer republishes from the committed setting anyway.
      if(config.databaseUrl)await new AcpAgentService(getDbPool(config.databaseUrl)).refreshRuntimeAdapterSpecs();
    },
    classifyError:error=>classifySettingsError(error,'acp_agents'),
  }));
}
