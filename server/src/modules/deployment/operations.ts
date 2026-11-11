import type {RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,OperationRefusal} from '../systemActions/operations/errors.js';
import {isInstanceAdminIn} from '../routeUtils/access.js';
import {classifySettingsError,settingsPolicyContext,user} from '../systemCommands/operationSupport.js';
import {DeploymentService} from './service.js';

/**
 * The instance administrator's deployment jobs (B43, ADR 0017/0020). The job
 * row is the command's only effect: argument-free (`update` or
 * `check_update`), written in the operation transaction; the deployer pulls
 * it over the internal channel. The single-active unique index stays the
 * authority for two simultaneous creates. User-only, never an Agent surface.
 */
type Id='deployment.job.create'|'deployment.job.cancel';
export function deploymentOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
  return (['deployment.job.create','deployment.job.cancel'] as Id[]).map((id):OperationRegistration=>({
    definition:definitions.get(id)!,...(id==='deployment.job.create'?{successStatus:201 as const}:{}),
    async resolve(_db,raw){
      const jobId=(raw as {job_id?:string}).job_id??null;
      return {authority:jobId?`deployment_job:${jobId}`:'instance:deployment',targets:{job_id:jobId},resourceType:'deployment',resourceId:jobId};
    },
    async authorize(db,_raw,a){if(!await isInstanceAdminIn(db,config,user(a)))throw hidden();},
    async authorizeResult(db,_raw,a){if(!await isInstanceAdminIn(db,config,user(a)))throw hidden();},
    policyContext:settingsPolicyContext,
    async execute(db,raw,a){
      const service=new DeploymentService(db,config.rainverEnv);
      const job=id==='deployment.job.create'
        ?await service.createJob((raw as {job_type:'update'|'check_update'}).job_type,user(a))
        :await service.cancelJob((raw as {job_id:string}).job_id);
      return JSON.parse(JSON.stringify(job));
    },
    classifyError(error){
      // A deployer that has not reported is a state the administrator resolves; not a transport failure.
      if((error as Error)?.name==='DeploymentDeployerOfflineError')return new OperationRefusal(409,'deployment',(error as Error).message,{code:'deployer_offline'});
      return classifySettingsError(error,'deployment');
    },
  }));
}
