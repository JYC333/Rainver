import {AmbientImportPolicyEntrySchema,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {HostCommandRefusal} from '../hosts/hostCommands.js';
import {ambientTarget} from '../hosts/operations.js';
import {ImportedSessionService} from './service.js';
import {importedSessionToWire} from './wire.js';

type Id='host.location.ambient.policy.set'|'host.location.ambient.dismiss'|'imported_session.visibility.set'|'imported_session.delete';
const identity=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});

/**
 * Location history consent and imported-session changes, over the owning
 * service in the core transaction. Consent and import are the Host owner's
 * act on their own machine (ADR 0016) with Project write; changing or
 * deleting a session needs the authority its service already checks.
 */
export function importedSessionRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return (['host.location.ambient.policy.set','host.location.ambient.dismiss','imported_session.visibility.set','imported_session.delete'] as Id[]).map(id=>({
    definition:definitions.get(id)!,
    async resolve(_db,raw){
      const i=raw as Record<string,unknown>;
      if(id==='imported_session.delete')return {authority:`imported_sessions:${[...(i.session_ids as string[])].sort().join(',')}`.slice(0,512),targets:{session_ids:[...(i.session_ids as string[])].sort()},resourceType:'imported_session',resourceId:null};
      if(id==='imported_session.visibility.set')return {authority:`imported_session:${i.session_id}`,targets:{session_id:i.session_id},resourceType:'imported_session',resourceId:String(i.session_id)};
      return {authority:`location:${i.location_id}`,targets:{location_id:i.location_id},resourceType:'workspace_location',resourceId:String(i.location_id)};
    },
    async authorize(db,raw,a){
      const i=raw as Record<string,unknown>;
      if(id==='host.location.ambient.policy.set'||id==='host.location.ambient.dismiss'){await ambientTarget(db,config,a,String(i.location_id));return;}
      // The service's own authority, not only that the row exists: its importer, or the Location's Host owner with Project write.
      if(id==='imported_session.visibility.set')await new ImportedSessionService(db,config).authorizeSession(identity(a),String(i.session_id));
    },
    async authorizeResult(db,raw,a){
      const out=raw as {space_id:string;location_id?:string;session?:{id:string}};
      if(out.space_id!==a.space_id)throw hidden();
      if(out.location_id)await ambientTarget(db,config,a,out.location_id);
      // A replayed change is released only to someone who could make it now.
      if(out.session)await new ImportedSessionService(db,config).authorizeSession(identity(a),out.session.id);
    },
    policyContext(){return {trigger_origin:'manual',direct_user_write:true};},
    async execute(db,raw,a){
      const i=raw as Record<string,unknown>,service=new ImportedSessionService(db,config);
      switch(id){
        case 'host.location.ambient.policy.set':{
          // The stored policy is read back through the strict entry schema; one entry it refuses empties the
          // whole Location's consent, so only what that read accepts is admitted.
          if(!AmbientImportPolicyEntrySchema.shape.runtime_key.safeParse(i.runtime_key).success)throw new HostCommandRefusal(422,'runtime_key is not a valid runtime key');
          if(i.installation!==undefined&&!AmbientImportPolicyEntrySchema.shape.installation.safeParse(i.installation).success)throw new HostCommandRefusal(422,'installation must be 1 to 64 characters');
          const policy=await service.setPolicy(identity(a),String(i.location_id),{
            runtime_key:String(i.runtime_key),installation:i.installation as string|undefined,sync:i.sync===true,
            default_visibility:(i.default_visibility??undefined) as 'private'|'space_shared'|undefined,auto_extract:i.auto_extract as boolean|undefined,
          });
          return {location_id:String(i.location_id),space_id:a.space_id,policy};
        }
        case 'host.location.ambient.dismiss':
          return {location_id:String(i.location_id),space_id:a.space_id,policy:await service.dismissOffer(identity(a),String(i.location_id))};
        case 'imported_session.visibility.set':
          return {space_id:a.space_id,session:importedSessionToWire(await service.setVisibility(identity(a),String(i.session_id),i.visibility as 'private'|'space_shared'))};
        case 'imported_session.delete':
          return {space_id:a.space_id,deleted:await service.remove(identity(a),i.session_ids as string[])};
      }
    },
    classifyError(error){
      if(error instanceof HostCommandRefusal)return markedRefusal(error,'imported_sessions');
      // The service's own 409/422 answers are written for the person (consent, ownership, shape).
      if(error instanceof HttpError&&(error.statusCode===409||error.statusCode===422))return markedRefusal(error,'imported_sessions');
      return undefined;
    },
  }));
}
