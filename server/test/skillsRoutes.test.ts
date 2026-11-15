import {seedSkillOperationHarness,skillFiles as files} from './support/skillOperationHarness.js';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {seedServerHost,seedSpaceMember} from './support/domainSeeds.js';
import {lockProjectAudienceForChange} from '../src/modules/projects/access.js';
import {sharedHostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import {SKILL_IO_JOB} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {buildModuleServer} from './support/moduleServer.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {previewSkillFiles} from '../src/modules/skills/skillImporter.js';
import {registerSkillSourceJob} from '../src/modules/skills/sourceRequests.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {JobWorker} from '../src/modules/jobs/worker.js';
import {executeSourceDispatch} from '../src/modules/sources/sourceDispatchExecution.js';
import {jobToOut} from '../src/modules/jobs/routes.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,pkg:string,app:ReturnType<typeof buildModuleServer>;
const preview=()=>previewSkillFiles({files});
const send=(url:string,payload:object={},key:string|null=randomUUID(),method:'POST'|'PUT'='POST')=>app.inject({method,url,payload,headers:key?{'idempotency-key':key}:{}});
const count=async(table:string)=>Number((await db.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
beforeEach(async()=>{
 ({space,owner,project,pkg,app}=await seedSkillOperationHarness(db.pool,db.connectionUri));
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{vi.restoreAllMocks();__setAuthIdentityForTests(null);await app?.close();});
describe('Skills operations on real PostgreSQL',()=>{
 it('fences the actual Host scan transport after cancellation, before any frame is sent',async()=>{
  const host=randomUUID(),queue=new PgJobQueueRepository(db.pool);
  await queue.enqueue({job_type:SKILL_IO_JOB,space_id:space,user_id:owner,max_attempts:1,payload:{kind:'skill.source.scan',input:{host_id:host}}});
  const claimed=(await queue.claimNext('skills-fence',[SKILL_IO_JOB]))!;await queue.startJob(claimed.id,'skills-fence');
  const frames:string[]=[];
  const sink={send(frame:{type:string;request_id:string}){frames.push(frame.type);queueMicrotask(()=>sharedHostConnectionRegistry.receiveHostActionResult(host,frame.request_id,{ok:true,error:null,result:{items:[],truncated:false,warnings:[]}}));},close(){}};
  sharedHostConnectionRegistry.registerConnection(host,sink as never);
  try{
   await expect(executeSourceDispatch(db.pool,{job_id:claimed.id,space_id:space,user_id:owner,job_type:SKILL_IO_JOB,attempts:claimed.attempts,max_attempts:1,worker_id:'skills-fence',payload:claimed.payload_json!},async()=>{
    await queue.cancelJob(claimed.id,'skills-fence');
    return {value:await sharedHostConnectionRegistry.scanHostSkills(host)};
   })).rejects.toThrow('no longer owns execution');
   expect(frames).toEqual([]);expect((await queue.getJob(claimed.id))!.status).toBe('cancelled');
  }finally{sharedHostConnectionRegistry.unregisterConnection(host,sink as never);}
 });
 it('queues owned-Host IO once and withholds completed results and replay after revocation',async()=>{
  const host=randomUUID();await seedServerHost(db.pool,{id:host});
  await db.pool.query("UPDATE hosts SET kind='remote',owner_user_id=$2,daemon_version='0.4.4' WHERE id=$1",[host,owner]);
  const scanned={items:[],truncated:false,warnings:[]};
  const spy=vi.spyOn(sharedHostConnectionRegistry,'scanHostSkills').mockResolvedValue({ok:true,error:null,result:scanned});
  const key=randomUUID(),accepted=await send(`/api/v1/skill-sources/hosts/${host}/scan`,{},key);expect(accepted.statusCode,accepted.body).toBe(202);expect(spy).not.toHaveBeenCalled();
  const queue=new PgJobQueueRepository(db.pool),claimed=(await queue.claimNext('skills-host',[SKILL_IO_JOB]))!;await queue.startJob(claimed.id,'skills-host');
  const registry=new JobHandlerRegistry();registerSkillSourceJob(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const job={job_id:claimed.id,space_id:space,user_id:owner,job_type:SKILL_IO_JOB,attempts:claimed.attempts,max_attempts:1,worker_id:'skills-host',payload:claimed.payload_json!};
  const result=await registry.dispatch(job);await queue.completeJob(claimed.id,result,'skills-host');expect(spy).toHaveBeenCalledTimes(1);
  expect((await app.inject({method:'GET',url:`/api/v1/skill-sources/requests/${claimed.id}`})).json().result).toEqual(scanned);
  await db.pool.query("UPDATE hosts SET status='revoked' WHERE id=$1",[host]);
  expect((await app.inject({method:'GET',url:`/api/v1/skill-sources/requests/${claimed.id}`})).statusCode).toBe(404);
  expect((await send(`/api/v1/skill-sources/hosts/${host}/scan`,{},key)).statusCode).toBe(404);
 });
 it('refuses Host content changed or revoked during IO without storing a releasable receipt',async()=>{
  const host=randomUUID();await seedServerHost(db.pool,{id:host});
  await db.pool.query("UPDATE hosts SET kind='remote',owner_user_id=$2,daemon_version='0.4.4' WHERE id=$1",[host,owner]);
  vi.spyOn(sharedHostConnectionRegistry,'scanHostSkills').mockImplementationOnce(async()=>{
   await db.pool.query("UPDATE hosts SET status='revoked' WHERE id=$1",[host]);
   return {ok:true,error:null,result:{items:[],truncated:false,warnings:[]}};
  });
  const accepted=await send(`/api/v1/skill-sources/hosts/${host}/scan`);expect(accepted.statusCode,accepted.body).toBe(202);
  const queue=new PgJobQueueRepository(db.pool),claimed=(await queue.claimNext('skills-host',[SKILL_IO_JOB]))!;await queue.startJob(claimed.id,'skills-host');
  const registry=new JobHandlerRegistry();registerSkillSourceJob(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  await expect(registry.dispatch({job_id:claimed.id,space_id:space,user_id:owner,job_type:SKILL_IO_JOB,attempts:claimed.attempts,max_attempts:1,worker_id:'skills-host',payload:claimed.payload_json!})).rejects.toThrow('Host not found');
  expect((await queue.getJob(claimed.id))!.result_json).toEqual({source_dispatch:'started'});
 });
 it('requires keys and strict inputs, deduplicates reviews across formal/generic routes and preserves pending-review status',async()=>{
  const url=`/api/v1/skill-packages/${pkg}/review-proposal`;
  expect((await send(url,{},null)).statusCode).toBe(422);
  expect((await send(url,{approved:true})).statusCode).toBe(422);
  const key=randomUUID(),first=await send(url,{},key);expect(first.statusCode,first.body).toBe(201);
  const replay=await send('/api/v1/actions/skill.review.propose',{skill_package_id:pkg},key);
  expect(replay.statusCode,replay.body).toBe(201);expect(replay.json()).toEqual(first.json());
  const existing=await send(url);expect(existing.statusCode,existing.body).toBe(200);
  expect(existing.json().data).toMatchObject({proposal_id:first.json().data.proposal_id,created:false});
  expect(await count('proposals')).toBe(1);
  expect((await send(url,{binding:{scope_type:'space',enabled:true}},key)).statusCode).toBe(422);
 });
 it('writes binding proposals without applying trust or enabling the package',async()=>{
  const url=`/api/v1/skill-packages/${pkg}/binding-proposal`,body={scope_type:'space',enabled:true};
  expect((await send(url,body)).statusCode).toBe(409);
  await db.pool.query("UPDATE skill_packages SET status='reviewed' WHERE id=$1",[pkg]);
  const key=randomUUID(),first=await send(url,body,key);expect(first.statusCode,first.body).toBe(201);
  expect((await send(url,body,key)).json()).toEqual(first.json());
  expect(await count('skill_bindings')).toBe(0);expect(await count('proposals')).toBe(1);
 });
 it('serializes current Project authority against overlay writes and denies replay after revocation',async()=>{
  const url=`/api/v1/skills/${pkg}/local-overlay`,body={scope_type:'project',scope_id:project,overlay_json:{alias:'Pinned'}},key=randomUUID();
  const first=await send(url,body,key,'PUT');expect(first.statusCode,first.body).toBe(200);
  expect((await send(url,body,key,'PUT')).json()).toEqual(first.json());
  expect((await send(url,{...body,overlay_json:{user_preferences:{api_key:'forbidden'}}},randomUUID(),'PUT')).statusCode).toBe(422);
  const client=await db.pool.connect();let pending:ReturnType<typeof send>|undefined;
  try{
   await client.query('BEGIN');await client.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[space,owner]);
   pending=send(url,body,key,'PUT');await waitForLockWaiter(db.pool);await client.query('COMMIT');
   expect((await pending).statusCode).toBe(404);
  }finally{await client.query('ROLLBACK');client.release();await pending;}
  expect(await count('skill_local_overlays')).toBe(1);
 });
 it('waits for the actual Project writer revocation before deciding whether an overlay may be saved',async()=>{
  const member=randomUUID();await seedSpaceMember(db.pool,{space,user:member});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,member]);
  __setAuthIdentityForTests({spaceId:space,userId:member});
  const client=await db.pool.connect();let pending:Promise<Awaited<ReturnType<typeof send>>>|undefined;let settled=false;
  try{
   await client.query('BEGIN');await lockProjectAudienceForChange(client,space,project);
   await client.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,member]);
   pending=Promise.resolve(send(`/api/v1/skills/${pkg}/local-overlay`,{scope_type:'project',scope_id:project,overlay_json:{alias:'must not save'}},randomUUID(),'PUT')).finally(()=>{settled=true;});
   await waitForLockWaiter(db.pool,{settled:()=>settled});await client.query('COMMIT');
   expect((await pending).statusCode).toBe(404);
  }finally{await client.query('ROLLBACK');client.release();await pending;}
  expect(await count('skill_local_overlays')).toBe(0);
 });
 it('atomically rolls back the proposal and operation receipt when required audit commit fails',async()=>{
  await db.pool.query(`CREATE FUNCTION refuse_skill_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM proposals) THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$`);
  await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_skill_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_skill_audit()');
  const url=`/api/v1/skill-packages/${pkg}/review-proposal`,key=randomUUID();
  expect((await send(url,{},key)).statusCode).toBeGreaterThanOrEqual(500);expect(await count('proposals')).toBe(0);
  await db.pool.query('DROP TRIGGER refuse_skill_audit ON policy_decision_records');
  expect((await send(url,{},key)).statusCode).toBe(201);
 });
 it('admits IO once and atomically settles immutable bytes and Job receipt under its current claim',async()=>{
  const input={source_type:'upload',files,package_hash:preview().package_hash},key=randomUUID();
  const admitted=await send('/api/v1/skill-sources/import',input,key);expect(admitted.statusCode,admitted.body).toBe(202);
  expect((await send('/api/v1/skill-sources/import',input,key)).json()).toEqual(admitted.json());
  expect(await count('skill_packages')).toBe(1);expect(await count('jobs')).toBe(1);
  const queue=new PgJobQueueRepository(db.pool),claimed=(await queue.claimNext('skills-test',[SKILL_IO_JOB]))!;
  await queue.startJob(claimed.id,'skills-test');
  const job={job_id:claimed.id,space_id:space,user_id:owner,job_type:SKILL_IO_JOB,attempts:claimed.attempts,max_attempts:1,worker_id:'skills-test',payload:claimed.payload_json!};
  const registry=new JobHandlerRegistry();registerSkillSourceJob(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const result=await registry.dispatch(job);
  expect(result).toMatchObject({value:{status:'imported'}});expect(await count('skill_packages')).toBe(2);
  expect(await registry.dispatch(job)).toEqual(result);expect(await count('skill_packages')).toBe(2);
  const stored=(await queue.getJob(claimed.id))!;expect(stored.result_json).toEqual(result);expect(jobToOut(stored).result).toBeNull();
  await queue.completeJob(claimed.id,result??{},'skills-test');
  const released=await app.inject({method:'GET',url:`/api/v1/skill-sources/requests/${claimed.id}`});expect(released.statusCode,released.body).toBe(200);expect(released.json().result.status).toBe('imported');
 });
 it('never repeats an IO start with unknown outcome and refuses a revoked requester before worker effects',async()=>{
  const admitted=await send('/api/v1/skill-sources/import-preview',{source_type:'upload',files});expect(admitted.statusCode,admitted.body).toBe(202);
  const queue=new PgJobQueueRepository(db.pool),claimed=(await queue.claimNext('skills-test',[SKILL_IO_JOB]))!;await queue.startJob(claimed.id,'skills-test');
  const registry=new JobHandlerRegistry();registerSkillSourceJob(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const job={job_id:claimed.id,space_id:space,user_id:owner,job_type:SKILL_IO_JOB,attempts:claimed.attempts,max_attempts:1,worker_id:'skills-test',payload:claimed.payload_json!};
  await db.pool.query(`UPDATE jobs SET result_json='{"source_dispatch":"started"}'::jsonb WHERE id=$1`,[claimed.id]);
  await expect(registry.dispatch(job)).rejects.toThrow('outcome unavailable');
  await db.pool.query('UPDATE jobs SET result_json=NULL WHERE id=$1',[claimed.id]);
  await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  await expect(registry.dispatch(job)).rejects.toThrow('Active user');expect(await count('skill_packages')).toBe(1);
 });
 it('rolls back imported bytes when the atomic Job receipt cannot be written',async()=>{
  const accepted=await send('/api/v1/skill-sources/import',{source_type:'upload',files,package_hash:preview().package_hash});expect(accepted.statusCode,accepted.body).toBe(202);
  const queue=new PgJobQueueRepository(db.pool),claimed=(await queue.claimNext('skills-rollback',[SKILL_IO_JOB]))!;await queue.startJob(claimed.id,'skills-rollback');
  await db.pool.query(`CREATE FUNCTION refuse_skill_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result_json ? 'value' THEN RAISE EXCEPTION 'receipt refused'; END IF; RETURN NEW; END $$`);
  await db.pool.query('CREATE TRIGGER refuse_skill_receipt BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_skill_receipt()');
  const registry=new JobHandlerRegistry();registerSkillSourceJob(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  try{
   await expect(registry.dispatch({job_id:claimed.id,space_id:space,user_id:owner,job_type:SKILL_IO_JOB,attempts:claimed.attempts,max_attempts:1,worker_id:'skills-rollback',payload:claimed.payload_json!})).rejects.toThrow('receipt refused');
   expect(await count('skill_packages')).toBe(1);expect(await count('skill_sources')).toBe(1);
   expect((await queue.getJob(claimed.id))!.result_json).toEqual({source_dispatch:'started'});
  }finally{await db.pool.query('DROP TRIGGER refuse_skill_receipt ON jobs');}
 });
 it('refuses changed import bytes through the real worker and releases only its fixed refusal code',async()=>{
  expect((await send('/api/v1/skill-sources/import',{source_type:'upload',files})).statusCode).toBe(422);
  const accepted=await send('/api/v1/skill-sources/import',{source_type:'upload',files,package_hash:'different-preview'});expect(accepted.statusCode,accepted.body).toBe(202);
  const registry=new JobHandlerRegistry();registerSkillSourceJob(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const queue=new PgJobQueueRepository(db.pool),worker=new JobWorker(queue,registry,'skills-hash',[SKILL_IO_JOB]);await worker.processOne();
  const job=(await queue.getJob(accepted.json().data.job_id))!;expect(job.status).toBe('failed');expect(job.attempts).toBe(1);
  expect(await count('skill_packages')).toBe(1);
  const result=await app.inject({method:'GET',url:`/api/v1/skill-sources/requests/${job.id}`});
  expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({status:'failed',result:null,error:{code:'skill_package_changed'}});
  expect(jobToOut(job)).toMatchObject({payload:null,result:null,error:null});
 });
});
