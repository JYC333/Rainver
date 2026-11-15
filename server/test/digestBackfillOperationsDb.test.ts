import {JobWorker} from '../src/modules/jobs/worker.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,PROJECT,OWNER} from './support/briefingFixture.js';
import {buildModuleServer} from './support/moduleServer.js';
import {informationDigestModule} from '../src/modules/informationDigest/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {DIGEST_BACKFILL_JOB,registerDigestBackfillJobs} from '../src/modules/informationDigest/backfillOperations.js';
const db=useTestDatabase(import.meta.filename),world=briefingWorld(db);
let app:ReturnType<typeof buildModuleServer>,registry:JobHandlerRegistry;
const request=(key=randomUUID(),project=false,payload:object={date:'2026-01-01'})=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/${project?`projects/${PROJECT}/information-digests`:'information-digests/personal'}/backfill`,headers:{'idempotency-key':key},payload});
const claim=async()=>{
 const queue=new PgJobQueueRepository(db.pool),worker=randomUUID();
 const job=(await queue.claimNext(worker,[DIGEST_BACKFILL_JOB]))!;expect(job).toBeTruthy();
 expect(await queue.startJob(job.id,worker)).toBe(true);
 return {job_id:job.id,space_id:job.space_id,user_id:job.user_id,job_type:job.job_type,attempts:job.attempts,max_attempts:job.max_attempts,worker_id:worker,payload:job.payload_json};
};
beforeEach(async()=>{
 if(!db.available)return;
 await world.seed();await world.material('Backfill evidence');
 app=buildModuleServer(world.config(),[informationDigestModule,systemActionsModule]);
 registry=new JobHandlerRegistry();registerDigestBackfillJobs(registry,world.config());
 __setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
for(const project of [false,true])it(`queues and settles the ${project?'Project':'personal'} backfill through its canonical owner`,async()=>{
 const key=randomUUID(),first=await request(key,project);expect(first.statusCode,first.body).toBe(202);
 const replay=await request(key,project);expect(replay.statusCode,replay.body).toBe(202);expect(replay.json().data).toEqual(first.json().data);
 expect((await db.pool.query('SELECT id FROM information_digests')).rows).toHaveLength(0);
 const result=await registry.dispatch(await claim());expect(result).toMatchObject({created:true});
 expect((await db.pool.query('SELECT id FROM information_digests')).rows).toHaveLength(1);
 expect((await db.pool.query('SELECT status FROM jobs WHERE job_type=$1',[DIGEST_BACKFILL_JOB])).rows).toEqual([{status:'completed'}]);
});
it('deduplicates distinct keys and rejects a cancelled or stale claim without writing a digest',async()=>{
 expect((await request()).statusCode).toBe(202);expect((await request()).statusCode).toBe(202);
 expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1',[DIGEST_BACKFILL_JOB])).rows).toHaveLength(1);
 const job=await claim();
 await expect(registry.dispatch({...job,attempts:job.attempts+1})).rejects.toThrow('claim');
 expect((await db.pool.query('SELECT id FROM information_digests')).rows).toHaveLength(0);
 await new PgJobQueueRepository(db.pool).cancelJob(job.job_id,job.worker_id);
 await expect(registry.dispatch(job)).rejects.toThrow('claim');
 expect((await db.pool.query('SELECT id FROM information_digests')).rows).toHaveLength(0);
});
it('refuses replay and queued execution after Source or scope authority changes',async()=>{
 const key=randomUUID();expect((await request(key)).statusCode).toBe(202);
 const job=await claim();await db.pool.query("UPDATE source_connections SET status='archived' WHERE space_id=$1",[SPACE]);
 expect((await request(key)).statusCode).toBe(404);
 await expect(registry.dispatch(job)).rejects.toThrow('inputs changed');
 expect((await db.pool.query('SELECT id FROM information_digests')).rows).toHaveLength(0);
});
it('rolls back admission and receipt when mandatory audit fails',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_backfill_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_backfill_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_backfill_audit()');
 try{
  const response=await request();expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1',[DIGEST_BACKFILL_JOB])).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_backfill_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_backfill_audit()');}
});
it('rejects invalid dates, unfinished days, authority injection and missing keys',async()=>{
 expect((await app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/information-digests/personal/backfill`,payload:{date:'2026-01-01'}})).statusCode).toBe(422);
 for(const payload of [{date:'2026-02-30'},{date:'2999-01-01'},{date:'2026-01-01',user_id:OWNER}])expect((await request(randomUUID(),false,payload)).statusCode).toBe(422);
 expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1',[DIGEST_BACKFILL_JOB])).rows).toHaveLength(0);
});

it('rolls back digest publication and Job settlement when execution audit fails',async()=>{
 expect((await request()).statusCode).toBe(202);const job=await claim();
 await db.pool.query("CREATE FUNCTION refuse_execution_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_execution_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_execution_audit()');
 try{
  await expect(registry.dispatch(job)).rejects.toThrow('audit unavailable');
  expect((await db.pool.query('SELECT id FROM information_digests')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[job.job_id])).rows[0].status).toBe('running');
 }finally{await db.pool.query('DROP TRIGGER refuse_execution_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_execution_audit()');}
});

it('rechecks the requesting person and Project writer at worker execution',async()=>{
 const key=randomUUID();expect((await request(key,true)).statusCode).toBe(202);const job=await claim();
 await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[PROJECT]);
 expect((await request(key,true)).statusCode).toBe(404);
 await expect(registry.dispatch(job)).rejects.toThrow();
 expect((await db.pool.query('SELECT id FROM information_digests')).rows).toHaveLength(0);
});

it('reports canonical worker completion after atomic snapshot and Job settlement',async()=>{
 const response=await request();expect(response.statusCode,response.body).toBe(202);
 const queue=new PgJobQueueRepository(db.pool),worker=randomUUID();
 const result=await new JobWorker(queue,registry,worker,[DIGEST_BACKFILL_JOB]).processOne();
 expect(result).toEqual({status:'completed',job_id:response.json().data.job_id});
 const row=await queue.getJob(response.json().data.job_id);
 expect(row?.status).toBe('completed');
 expect(await queue.confirmCompletedJob(row!.id,row!.result_json,worker,row!.attempts)).toBe(true);
 expect(await queue.confirmCompletedJob(row!.id,row!.result_json,worker,row!.attempts+1)).toBe(false);
 expect(await queue.confirmCompletedJob(row!.id,row!.result_json,randomUUID(),row!.attempts)).toBe(false);
 expect(await queue.confirmCompletedJob(row!.id,{digest_id:'other',created:true},worker,row!.attempts)).toBe(false);
});
it.each(['failed','cancelled'])('review regression: reruns atomic database backfill after %s and returns its completed result without duplication',async status=>{
 const first=await request();expect(first.statusCode,first.body).toBe(202);const id=first.json().data.job_id;
 await db.pool.query('UPDATE jobs SET status=$2 WHERE id=$1',[id,status]);
 const next=await request();expect(next.statusCode,next.body).toBe(202);expect(next.json().data.job_id).not.toBe(id);
 const output=await registry.dispatch(await claim());
 const completed=await request();expect(completed.statusCode,completed.body).toBe(202);expect(completed.json().data).toMatchObject({job_id:next.json().data.job_id,status:'completed',result:output});
 expect((await db.pool.query('SELECT id FROM information_digests')).rows).toHaveLength(1);
});
