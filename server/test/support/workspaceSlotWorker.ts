import {randomUUID} from 'node:crypto';
import {PgRunRepository} from '../../src/modules/runs/repository.js';
import {invocationDelivery} from './runtimeDelivery.js';

/** Real queue + handler + executeRun; only context delivery and the external
 * ACP agent are deterministic boundaries. Admission/attempts/locks use PG. */
export async function createWorkspaceSlotWorker(db:{pool:import('pg').Pool;connectionUri:string},runId:string,scope:{SPACE:string;OWNER:string;PROJECT:string;FOLDER:string;HOST:string;LOCATION:string;AGENT:string;CONVERSATION:string;roomId:string}){
 const {SPACE,OWNER,PROJECT,FOLDER,HOST,LOCATION,AGENT,CONVERSATION,roomId}=scope;
 const {loadConfig}=await import('../../src/config.js');
 const {RunOrchestrationService}=await import('../../src/modules/runs/orchestrationService.js');
 const {handleAgentRun}=await import('../../src/modules/runs/agentRunHandler.js');
 const {RunMaterializationService}=await import('../../src/modules/runs/materializationService.js');
 const {PgJobQueueRepository}=await import('../../src/modules/jobs/repository.js');
 const {JobHandlerRegistry}=await import('../../src/modules/jobs/handlerRegistry.js');
 const {JobWorker}=await import('../../src/modules/jobs/worker.js');
 const {HostConnectionRegistry}=await import('../../src/modules/hosts/connectionRegistry.js');
 const {SyntheticAcpHost}=await import('./syntheticAcpHost.js');
 const {NO_PROVIDER_BINDINGS}=await import('../../src/modules/runs/remoteHostCliAdapter.js');
 await db.pool.query("INSERT INTO room_agent_members(id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now()) ON CONFLICT DO NOTHING",[randomUUID(),SPACE,roomId,AGENT]);
 const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-slot-worker-fixture'});
 const registry=new HostConnectionRegistry(),host=new SyntheticAcpHost(registry,HOST).connect();
 const repository=new PgRunRepository(db.pool,config);
 const orchestration=new RunOrchestrationService(config,repository,{
  routeResolver:{routeRun:async r=>r},
  policyEnforcer:async()=>({status:'allow'}),
  hostKindResolver:async()=>({hostKind:'remote',hostId:HOST,workspaceLocationId:LOCATION}),
  workContextResolver:async r=>({workContextScopeId:CONVERSATION,workContextSetupRef:{type:'work_context_setup',id:CONVERSATION,version:'1'},projectId:PROJECT,projectFolderId:FOLDER,agentId:AGENT,runtimeProfileId:r.runtime_profile_id??null,projectBriefRef:null,projectInstructionRef:null}),
  ensureWorkContextSetup:async()=>({id:CONVERSATION,version:1}),
  executionControlSnapshotWriter:async()=>({id:CONVERSATION} as import('@rainver/protocol').ExecutionControlSnapshot),
  runtimeContextGateway:{async preview(){throw new Error('unused');},async prepareInvocation(){return {...invocationDelivery('Complete fixture'),runtime_key:'opencode'};},async acknowledgeDelivery(){return {};},async finalizeInvocation(){return {};}} as never,
  hostCli:{connectionRegistry:registry,bindings:NO_PROVIDER_BINDINGS},
 });
 const queue=new PgJobQueueRepository(db.pool),handlers=new JobHandlerRegistry();
 const materializer=RunMaterializationService.fromConfig(config);
 handlers.register('agent_run',job=>handleAgentRun(job,orchestration,materializer,repository,config));
 const job=await queue.enqueue({job_type:'agent_run',space_id:SPACE,user_id:OWNER,agent_id:AGENT,payload:{run_id:runId}});
 return {worker:new JobWorker(queue,handlers,'slot-worker',['agent_run']),job,host,orchestration,registry};
}
