import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ServerConfig} from '../../src/config.js';
import type {SpaceUserIdentity} from '../../src/modules/routeUtils/common.js';
import {loadSystemActionRegistry} from '../../src/modules/systemActions/registry.js';
import {OperationExecutor} from '../../src/modules/systemActions/operations/executor.js';
import {sessionActor} from '../../src/modules/systemActions/operations/actor.js';
import {projectFolderIoRegistrations,PROJECT_FOLDER_IO_JOB} from '../../src/modules/projectFolders/ioOperations.js';
import {registerProjectFolderIoHandler} from '../../src/modules/projectFolders/ioWorker.js';
import {loadFolderIoIntent} from '../../src/modules/projectFolders/ioIntentRepository.js';
import {JobHandlerRegistry} from '../../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../../src/modules/jobs/repository.js';
import {JobWorker} from '../../src/modules/jobs/worker.js';
/** Real core + domain worker around the file-system boundary; no fake database. */
export async function folderIoHarness(pool:Pool,config:ServerConfig,identity:SpaceUserIdentity){
  const executor=new OperationExecutor(pool,config,projectFolderIoRegistrations(await loadSystemActionRegistry(config),config));
  const registry=new JobHandlerRegistry();registerProjectFolderIoHandler(registry,config);
  const queue=new PgJobQueueRepository(pool),worker=new JobWorker(queue,registry,`folder-io-${randomUUID()}`,[PROJECT_FOLDER_IO_JOB]);
  const submit=(operation:string,input:object,key=randomUUID())=>executor.execute(operation,input,sessionActor(identity),randomUUID(),key);
  const read=(id:string)=>loadFolderIoIntent(pool,id,identity.spaceId);
  return{config,submit,read,process:()=>worker.processOne(),queue,async run(operation:string,input:object){
    const accepted=await submit(operation,input);
    if(!('status'in accepted.body)||accepted.body.status!=='succeeded')throw Object.assign(new Error('Folder command refused'),{code:'error'in accepted.body?accepted.body.error.code:'pending_approval',statusCode:accepted.http_status});
    const id=(accepted.body.data as{id:string}).id;
    const job=await worker.processOne(),intent=await read(id);
    if(intent.status!=='succeeded')throw Object.assign(new Error(intent.error_code??job.status),{code:intent.error_code??'folder_io_incomplete',intent_id:id,statusCode:['draft_revision_too_large','draft_quota_exceeded'].includes(intent.error_code??'')?422:409});
    return intent.result_json!;
  }};
}
