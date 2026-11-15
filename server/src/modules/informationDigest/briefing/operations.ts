import {ProjectBriefingReplaced} from './settingsOperations.js';
import type {OperationActor, OperationInput, RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {dbPool, HttpError, type Queryable} from '../../routeUtils/common.js';
import {lockActivePerson} from '../../access/activePerson.js';
import {assertProjectReadableLocked, assertProjectWriterForMutation} from '../../projects/access.js';
import {hidden, markedRefusal} from '../../systemActions/operations/errors.js';
import type {OperationRegistration} from '../../systemActions/operations/types.js';
import {InformationBriefingService} from './service.js';
import {personalBriefingScope} from './personalScope.js';
import {projectBriefingScope} from './projectScope.js';

type Input=OperationInput<'briefing.personal.cancel'> | OperationInput<'briefing.project.cancel'>;
function adapter(input:Input,actor:OperationActor){
 return 'project_id' in input ? projectBriefingScope(actor.space_id,input.project_id) : personalBriefingScope(actor.space_id,actor.on_behalf_of_user_id!);
}
/** No Source text is returned by a stop receipt. Revoked input consent cannot
 * prevent an authorized scope writer from stopping the exact admitted Run. */
export function briefingCancelRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 const service=(db:Queryable)=>new InformationBriefingService(db,config);
 const check=async(db:Queryable,input:Input,actor:OperationActor)=>{
  if(input.space_id!==actor.space_id||!actor.on_behalf_of_user_id)throw hidden();
  if('project_id' in input){
   await assertProjectReadableLocked(db,actor.space_id,input.project_id,actor.on_behalf_of_user_id);
   await assertProjectWriterForMutation(db,actor.space_id,input.project_id,actor.on_behalf_of_user_id);
  }
  await lockActivePerson(db,actor.space_id,actor.on_behalf_of_user_id);
  return service(db).cancellationTarget(adapter(input,actor),actor.on_behalf_of_user_id,input.briefing_id);
 };
 return (['briefing.personal.cancel','briefing.project.cancel'] as const).map(id=>({
  definition:definitions.get(id)!,
  runTerminalOwner:{async discover(db,raw,actor){
   // Discovery reads scope authority; domain locks are taken by authorize only
   // after the host has admitted the terminal owner's complete Run set.
   const input=raw as Input;
   const row=await service(db).cancellationTarget(adapter(input,actor),actor.on_behalf_of_user_id!,input.briefing_id);
   return row.run_id?[{space_id:actor.space_id,id:row.run_id}]:[];
  }},
  async resolve(_db,raw,actor){const input=raw as Input;return {authority:`briefing:${actor.space_id}:${'project_id' in input?input.project_id:actor.on_behalf_of_user_id}`,targets:{...input,user_id:actor.on_behalf_of_user_id},resourceType:'run',resourceId:null};},
  async authorize(db,raw,actor){await check(db,raw as Input,actor);},
  async authorizeResult(db,raw,actor){
   const output=raw as Input&{user_id:string};
   if(output.user_id!==actor.on_behalf_of_user_id)throw hidden();
   // Receipt is historical intent. Recheck current scope, never demand that a
   // completed or superseded attempt become current again to replay the stop.
   await check(db,output,actor);
  },
  async execute(db,raw,actor){const input=raw as Input;return {...input,user_id:actor.on_behalf_of_user_id!,...await service(db).requestCancel(adapter(input,actor),actor.on_behalf_of_user_id!,input.briefing_id)};},
  async afterCommit(raw,actor){const output=raw as Input&{run_id:string|null;attempt:number};await service(dbPool(config)).finishCancel(adapter(output,actor),actor.on_behalf_of_user_id!,output.briefing_id,output.run_id,output.attempt);},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'information_digest'):undefined,
 }));
}

/** Historical Project generation is conditionally retired, after the same live
 * read/writer gates as the original URL. No Run or Job is created. */
export function projectBriefingRequestRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration {
 type Request=OperationInput<'briefing.project.request'>;
 return {
  definition:definitions.get('briefing.project.request')!,
  async resolve(_db,raw,actor){const input=raw as Request;return {authority:`briefing:${actor.space_id}:${input.project_id}`,targets:input,resourceType:'project',resourceId:input.project_id};},
  async authorize(db,raw,actor){
   const input=raw as Request;
   if(input.space_id!==actor.space_id||!actor.on_behalf_of_user_id)throw hidden();
   await assertProjectReadableLocked(db,actor.space_id,input.project_id,actor.on_behalf_of_user_id);
   await assertProjectWriterForMutation(db,actor.space_id,input.project_id,actor.on_behalf_of_user_id);
   await lockActivePerson(db,actor.space_id,actor.on_behalf_of_user_id);
   throw new ProjectBriefingReplaced();
  },
  async execute(){throw new ProjectBriefingReplaced();},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'information_digest'):undefined,
 };
}
