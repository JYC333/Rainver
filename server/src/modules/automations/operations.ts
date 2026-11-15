import {AUTOMATION_CONFIGURATION_OPERATION_SCHEMAS,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {AutomationService,automationToOut} from './service.js';
import {PgAutomationRepository} from './repository.js';
import {lockAutomationConfiguration,type ConfigurationInput} from './configurationAuthority.js';
type Scope=ResolvedOperation&{context?:Record<string,unknown>};
export function automationConfigurationRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(AUTOMATION_CONFIGURATION_OPERATION_SCHEMAS) as (keyof typeof AUTOMATION_CONFIGURATION_OPERATION_SCHEMAS)[]).map(id=>({
  definition:definitions.get(id)!,successStatus:id==='automation.create'?201:200,
  async resolve(_db,raw,a){
   const i=raw as ConfigurationInput;
   return {authority:`space:${a.space_id}`,targets:{space_id:i.space_id,...(i.automation_id?{automation_id:i.automation_id}:{})},resourceType:'automation',resourceId:i.automation_id??null};
  },
  async authorize(db,raw,a,scope){
   (scope as Scope).context=await lockAutomationConfiguration(db,a.space_id,a.on_behalf_of_user_id!,raw as ConfigurationInput,id==='automation.autonomy.configure');
  },
  policyContext(_raw,_a,scope){return (scope as Scope).context;},
  async authorizeResult(db,raw,a){
   const out=raw as {id:string;access:string;project_id:string|null;agent_id:string};
   const row=await new PgAutomationRepository(db).get(a.space_id,out.id);
   if(!row||row.project_id!==out.project_id||row.agent_id!==out.agent_id)throw hidden();
   // authorize already pinned the request's complete Project/Agent closure.
   // A receipt whose placement drifted cannot extend it after domain locks.
   await db.query('SELECT id FROM automations WHERE space_id=$1 AND id=$2 FOR SHARE',[a.space_id,out.id]);
   const current=await new PgAutomationRepository(db).get(a.space_id,out.id,{readableBy:a.on_behalf_of_user_id!,includeOpsView:true});
   if(!current||current.project_id!==out.project_id||current.agent_id!==out.agent_id||(current.access==='ops'&&out.access!=='ops'))throw hidden();
  },
  classifyError(e){return e instanceof HttpError?markedRefusal(e,'automations'):undefined;},
  async execute(db,raw,a){
   const {space_id,automation_id,...body}=raw as ConfigurationInput;
   const service=AutomationService.forConfigurationTransaction(config,db);
   const row=id==='automation.create'?await service.create({spaceId:space_id,ownerUserId:a.on_behalf_of_user_id!,body}):
    id==='automation.update'?await service.update({spaceId:space_id,automationId:automation_id!,actorUserId:a.on_behalf_of_user_id!,body}):
    await service.enableAutonomy({spaceId:space_id,actorUserId:a.on_behalf_of_user_id!,body});
   return automationToOut(row);
  },
 }));
}
