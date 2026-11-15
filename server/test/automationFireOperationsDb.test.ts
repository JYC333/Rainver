import {AsyncResource} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {AUTOMATION_FIRE_JOB} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedAgentWithVersion,seedServerRuntimeProfile} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {registerRoutes} from '../src/modules/automations/routes.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {registerAutomationFireJob} from '../src/modules/automations/fireRequests.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {JobWorker} from '../src/modules/jobs/worker.js';
import {performJobEffect,bindJobEffectAuthority} from '../src/modules/jobs/effectAuthority.js';
import {jobToOut} from '../src/modules/jobs/routes.js';
import {automationTargetHandlerRegistry} from '../src/modules/automations/targetRegistry.js';
import {AutomationService} from '../src/modules/automations/service.js';
import {PgAutomationRepository} from '../src/modules/automations/repository.js';
import {registerAutomationOwnedTargetHandlers} from '../src/modules/automations/targetHandlers.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,agent:string,project:string,id:string;
let app:ReturnType<typeof buildModuleServer>,queue:PgJobQueueRepository,registry:JobHandlerRegistry;
const base=()=>`/api/v1/spaces/${space}/automations`;
const send=(url:string,payload:object={},key:string|null=randomUUID())=>app.inject({method:'POST',url,payload,headers:key?{'idempotency-key':key}:{}});
const fire=(key:string|null=randomUUID(),body:object={})=>send(`${base()}/${id}/fire`,body,key);
const work=()=>new JobWorker(queue,registry,'fire-test',[AUTOMATION_FIRE_JOB]).processOne();
const result=(job:string)=>app.inject({method:'GET',url:`${base()}/${id}/fire-requests/${job}`});
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users','machines'],{cascade:true});
 space=randomUUID();owner=randomUUID();agent=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project});
 await seedAgentWithVersion(db.pool,{space,owner,agent,version:randomUUID(),name:'Agent'});
 await seedServerRuntimeProfile(db.pool,{space,agent,hostId:randomUUID()});
 const folder=randomUUID();
 await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,created_by_user_id,name,status,kind,is_primary,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,$4,'Code','active','code',true,false,false,now(),now())",[folder,space,project,owner]);
 const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
 app=buildModuleServer(config,[{name:'automations',registerRoutes},systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
 const made=await send(base(),{name:'Fire',agent_id:agent,project_id:project,project_folder_id:folder,trigger_type:'schedule',config_json:{target_type:'agent_run',prompt:'Configured',cron:'0 * * * *'}});
 expect(made.statusCode,made.body).toBe(201);id=made.json().data.id;
 queue=new PgJobQueueRepository(db.pool);registry=new JobHandlerRegistry();registerAutomationFireJob(registry,config);
});
afterEach(async()=>{__setAuthIdentityForTests(null);registerAutomationOwnedTargetHandlers();await app?.close();});
describe('formal durable automation.fire',()=>{
 it('requires a key and strict input, atomically queues once, then uses the real Run owner and readable receipt',async()=>{
  expect((await fire(null)).statusCode).toBe(422);
  expect((await fire(randomUUID(),{trigger_type:'schedule'})).statusCode).toBe(422);
  expect((await fire(randomUUID(),{owner_user_id:owner})).statusCode).toBe(422);
  const key=randomUUID(),accepted=await fire(key,{prompt:'My request'});
  expect(accepted.statusCode,accepted.body).toBe(202);
  expect((await send('/api/v1/actions/automation.fire',{space_id:space,automation_id:id,prompt:'My request'},key)).json()).toEqual(accepted.json());
  expect((await db.pool.query('SELECT id FROM runs')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT max_attempts FROM jobs WHERE job_type=$1',[AUTOMATION_FIRE_JOB])).rows).toEqual([{max_attempts:1}]);
  expect((await work()).status).toBe('completed');
  const job=await queue.getJob(accepted.json().data.job_id);expect(job?.result_json).toMatchObject({value:{trigger_origin:'manual'}});
  const value=(await result(job!.id)).json();expect(value.outcome).toBe('completed');expect(value.result.run_id).toBeTruthy();
  expect((await db.pool.query('SELECT instructed_by_user_id,trigger_origin,project_id FROM runs WHERE id=$1',[value.result.run_id])).rows).toEqual([{instructed_by_user_id:owner,trigger_origin:'manual',project_id:project}]);
  expect((await db.pool.query('SELECT id FROM automation_runs')).rows).toHaveLength(1);
  expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run'")).rows).toHaveLength(1);
  expect(jobToOut(job!).payload).toBeNull();expect(jobToOut(job!).result).toBeNull();
  expect((await fire(key,{prompt:'My request'})).json()).toEqual(accepted.json());
  expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1',[AUTOMATION_FIRE_JOB])).rows).toHaveLength(1);
 });
 it('rechecks authority on current-key replay and on private result release',async()=>{
  const key=randomUUID(),accepted=await fire(key);expect(accepted.statusCode,accepted.body).toBe(202);
  await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
  expect((await fire(key)).statusCode).toBe(404);
  expect([403,404]).toContain((await result(accepted.json().data.job_id)).statusCode);
  expect((await work()).status).toBe('failed');
  expect((await db.pool.query('SELECT id FROM runs')).rows).toHaveLength(0);
 });
 it.each(['configuration','version','grant'] as const)('refuses stale %s before the target creates work',async kind=>{
  const accepted=await fire();expect(accepted.statusCode,accepted.body).toBe(202);
  if(kind==='configuration')await db.pool.query("UPDATE automations SET config_json=config_json || '{\"prompt\":\"changed\"}'::jsonb WHERE id=$1",[id]);
  if(kind==='version')await db.pool.query("UPDATE agent_runtime_profiles SET runtime_config_json='{\"changed\":true}' WHERE agent_id=$1",[agent]);
  if(kind==='grant')await db.pool.query("UPDATE automation_credential_grants SET status='revoked' WHERE automation_id=$1",[id]);
  expect((await work()).status).toBe('failed');
  expect((await db.pool.query('SELECT id FROM runs')).rows).toHaveLength(0);
 });
 it('rolls intent and core receipt back when mandatory audit fails at COMMIT',async()=>{
  await db.pool.query(`CREATE FUNCTION refuse_fire_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM jobs WHERE job_type='automation_fire') THEN RAISE EXCEPTION 'injected fire audit failure'; END IF; RETURN NEW; END $$`);
  await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_fire_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_fire_audit()');
  const key=randomUUID();
  try{
   expect((await fire(key)).statusCode).toBeGreaterThanOrEqual(500);
   expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1',[AUTOMATION_FIRE_JOB])).rows).toHaveLength(0);
   expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE idempotency_key=$1',[key])).rows).toHaveLength(0);
  }finally{await db.pool.query('DROP TRIGGER refuse_fire_audit ON policy_decision_records');}
  expect((await fire(key)).statusCode).toBe(202);
 });
 it('refuses an invalidated worker claim at the target owner and never repeats unknown work',async()=>{
  const original=automationTargetHandlerRegistry.get('agent_run')!;
  await db.pool.query("UPDATE automations SET config_json='{\"target_type\":\"context_ops_review_cycle\"}' WHERE id=$1",[id]);
  let jobId:string;
  automationTargetHandlerRegistry.register('context_ops_review_cycle',{preflight:async()=>({executable:true}),execute:async c=>{
   await db.pool.query("UPDATE jobs SET claimed_by='replacement' WHERE id=$1",[jobId]);
   return original.execute(c);
  }},'contextOps');
  const accepted=await fire();expect(accepted.statusCode,accepted.body).toBe(202);jobId=accepted.json().data.job_id;
  expect((await work()).status).toBe('failed');
  expect((await db.pool.query('SELECT id FROM runs')).rows).toHaveLength(0);
  await db.pool.query("UPDATE jobs SET status='running',claimed_by='fire-test' WHERE id=$1",[accepted.json().data.job_id]);
  const row=await queue.getJob(accepted.json().data.job_id);
  await expect(registry.dispatch({job_id:row!.id,space_id:space,user_id:owner,job_type:AUTOMATION_FIRE_JOB,attempts:row!.attempts,max_attempts:1,worker_id:'fire-test',payload:row!.payload_json!})).rejects.toThrow('will not be repeated');
  expect((await db.pool.query('SELECT id FROM runs')).rows).toHaveLength(0);
 });
 it.each(['authority','claim'] as const)('rechecks %s at the actual external effect after asynchronous preparation',async kind=>{
  await db.pool.query("UPDATE automations SET config_json='{\"target_type\":\"context_ops_review_cycle\"}' WHERE id=$1",[id]);
  let jobId:string,effects=0;
  const incoming=new AsyncResource('test incoming Host event');
  automationTargetHandlerRegistry.register('context_ops_review_cycle',{preflight:async()=>({executable:true}),execute:async()=>{
   if(kind==='authority')await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
   else await db.pool.query("UPDATE jobs SET claimed_by='replacement' WHERE id=$1",[jobId]);
   const send=bindJobEffectAuthority(()=>performJobEffect(()=>{effects++;}));
   await incoming.runInAsyncScope(send);
   return {sent:true};
  }},'contextOps');
  const accepted=await fire();expect(accepted.statusCode,accepted.body).toBe(202);jobId=accepted.json().data.job_id;
  expect((await work()).status).toBe('failed');expect(effects).toBe(0);
 });

 it('scheduler sweeps commit the same single-attempt intent once per due slot and use the same worker',async()=>{
  await db.pool.query("UPDATE scheduler_tasks SET next_run_at=now()-interval '1 minute' WHERE task_type='automation' AND task_key=$1",[id]);
  const service=()=>new AutomationService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),new PgAutomationRepository(db.pool));
  const counts=await Promise.all([service().scanAndFire(),service().scanAndFire()]);
  expect(counts.reduce((a,b)=>a+b,0)).toBe(1);
  const jobs=(await db.pool.query('SELECT payload_json,max_attempts FROM jobs WHERE job_type=$1',[AUTOMATION_FIRE_JOB])).rows;
  expect(jobs).toHaveLength(1);expect(jobs[0].max_attempts).toBe(1);expect(jobs[0].payload_json.trigger_type).toBe('schedule');
  expect((await db.pool.query('SELECT id FROM runs')).rows).toHaveLength(0);
  expect((await work()).status).toBe('completed');
  expect((await db.pool.query('SELECT trigger_type FROM automation_runs')).rows).toEqual([{trigger_type:'schedule'}]);
  expect((await service().scanAndFire())).toBe(0);
 });

});
