import type {RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import {classifySettingsError,keyedSecretFingerprint,settingsPolicyContext,user} from '../systemCommands/operationSupport.js';
import {networkProfileRepositoryIn} from './repository.js';

/**
 * Network profiles (`network_profile.*`): a Space owner or admin's egress
 * policy objects, written through the existing repository bound to the
 * operation transaction. A proxy URL is credential-free by validation, so the
 * stored receipt holds nothing secret.
 */
type Id='network_profile.create'|'network_profile.update'|'network_profile.delete';
export function networkProfileOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return (['network_profile.create','network_profile.update','network_profile.delete'] as Id[]).map((id):OperationRegistration=>({
    definition:definitions.get(id)!,...(id==='network_profile.create'?{successStatus:201 as const}:{}),
    async resolve(_db,raw,a){
      const target=(raw as {profile_id?:string}).profile_id??null;
      return {authority:target?`network_profile:${target}`:`space:${a.space_id}`,targets:{profile_id:target},resourceType:'network_profile',resourceId:target};
    },
    async authorize(db,_raw,a){if(!await isSpaceOwnerOrAdminIn(db,a.space_id,user(a)))throw hidden();},
    async authorizeResult(db,raw,a){
      if(!await isSpaceOwnerOrAdminIn(db,a.space_id,user(a)))throw hidden();
      if((raw as {space_id?:string}).space_id!==a.space_id)throw hidden();
    },
    policyContext:settingsPolicyContext,
    fingerprintInput:input=>keyedSecretFingerprint(config,input,['proxy_url']),
    async execute(db,raw,a){
      const {profile_id:profileId,...body}=raw as Record<string,unknown>&{profile_id?:string};
      const repository=networkProfileRepositoryIn(db);
      if(id==='network_profile.create')return JSON.parse(JSON.stringify(await repository.create(a.space_id,body as never)));
      if(id==='network_profile.update')return JSON.parse(JSON.stringify(await repository.update(a.space_id,profileId!,body as never)));
      await repository.delete(a.space_id,profileId!);
      return {profile_id:profileId!,space_id:a.space_id,deleted:true};
    },
    classifyError:error=>classifySettingsError(error,'network_profiles'),
  }));
}
