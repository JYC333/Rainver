import type {RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {isInstanceAdminIn} from '../routeUtils/access.js';
import {classifySettingsError,settingsPolicyContext,user} from '../systemCommands/operationSupport.js';
import {SourceProviderCatalogService} from './catalog/sourceProviderCatalogService.js';

/**
 * The instance Source catalog (`source_catalog.*`): the instance admin turns
 * a provider, connector or provider-connector mapping on or off (and orders
 * mappings), through the catalog service bound to the operation transaction.
 * Space-level Source configuration is a different family.
 */
type Id='source_catalog.provider.update'|'source_catalog.connector.update'|'source_catalog.mapping.update';
const TARGET:Record<Id,'provider_id'|'connector_id'|'mapping_id'>={'source_catalog.provider.update':'provider_id','source_catalog.connector.update':'connector_id','source_catalog.mapping.update':'mapping_id'};
export function sourceCatalogOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return (Object.keys(TARGET) as Id[]).map((id):OperationRegistration=>({
    definition:definitions.get(id)!,
    async resolve(_db,raw){const target=String((raw as Record<string,unknown>)[TARGET[id]]);return {authority:`${TARGET[id]}:${target}`,targets:{[TARGET[id]]:target},resourceType:'instance',resourceId:null};},
    async authorize(db,_raw,a){if(!await isInstanceAdminIn(db,config,user(a)))throw hidden();},
    async authorizeResult(db,_raw,a){if(!await isInstanceAdminIn(db,config,user(a)))throw hidden();},
    policyContext:settingsPolicyContext,
    async execute(db,raw,_a){
      const i=raw as {status?:string;priority?:number}&Record<string,unknown>;
      const catalog=new SourceProviderCatalogService(db),target=String(i[TARGET[id]]);
      const out=id==='source_catalog.provider.update'?await catalog.updateProvider(target,{status:i.status})
        :id==='source_catalog.connector.update'?await catalog.updateConnector(target,{status:i.status})
        :await catalog.updateMapping(target,{status:i.status,priority:i.priority});
      return JSON.parse(JSON.stringify(out));
    },
    classifyError:error=>classifySettingsError(error,'sources'),
  }));
}
