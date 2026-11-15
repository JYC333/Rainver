import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,MEMBER} from './support/briefingFixture.js';
import {buildModuleServer} from './support/moduleServer.js';
import {activityModule} from '../src/modules/activity/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {JobWorker} from '../src/modules/jobs/worker.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {registerActivitySummaryJob,ACTIVITY_SUMMARY_JOB} from '../src/modules/activity/summaryOperation.js';
const db=useTestDatabase(import.meta.filename),world=briefingWorld(db);
let app:ReturnType<typeof buildModuleServer>,item:string;
const request=(key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/activity/summary-runs',headers:{'idempotency-key':key},payload:{source_item_ids:[item]}});
const registry=()=>{const result=new JobHandlerRegistry();registerActivitySummaryJob(result,world.config());return result;};
beforeEach(async()=>{
 if(!db.available)return;
 await world.seed();item=await world.material('Summary source');
 app=buildModuleServer(world.config(),[activityModule]);__setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('summarizes currently authorized Source excerpts and audits the cross-owner read',async()=>{
 const result=await request();expect(result.statusCode,result.body).toBe(202);
 expect(await new JobWorker(new PgJobQueueRepository(db.pool),registry(),randomUUID(),[ACTIVITY_SUMMARY_JOB]).processOne()).toEqual({status:'completed',job_id:result.json().data.job_id});
 expect((await db.pool.query("SELECT content FROM artifacts WHERE artifact_type='summary'")).rows[0].content).toContain('Summary source excerpt');
 expect((await db.pool.query("SELECT id FROM content_access_logs WHERE resource_type='source_item' AND viewer_user_id=$1",[MEMBER])).rows.length).toBeGreaterThan(0);
});
it('rechecks Source derived-write consent on replay and before the Job publishes',async()=>{
 const key=randomUUID(),result=await request(key);expect(result.statusCode,result.body).toBe(202);
 await db.pool.query('UPDATE source_connections SET policy_json=$2::jsonb WHERE space_id=$1',[SPACE,JSON.stringify({derived_write_policy:'disabled'})]);
 expect((await request(key)).statusCode).toBe(404);
 const execution=await new JobWorker(new PgJobQueueRepository(db.pool),registry(),randomUUID(),[ACTIVITY_SUMMARY_JOB]).processOne();expect(execution.status).toBe('failed');
 expect((await db.pool.query("SELECT id FROM artifacts WHERE artifact_type='summary'")).rows).toHaveLength(0);
});
it('rejects archived Source replay and produces no derived Artifact',async()=>{
 const key=randomUUID(),result=await request(key);expect(result.statusCode,result.body).toBe(202);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE space_id=$1",[SPACE]);expect((await request(key)).statusCode).toBe(404);
 expect((await new JobWorker(new PgJobQueueRepository(db.pool),registry(),randomUUID(),[ACTIVITY_SUMMARY_JOB]).processOne()).status).toBe('failed');
 expect((await db.pool.query("SELECT id FROM artifacts WHERE artifact_type='summary'")).rows).toHaveLength(0);
});
it.each(['failed','cancelled'])('review regression: reruns atomic summary after %s and reuses the completed business result',async status=>{
 const first=await request();expect(first.statusCode,first.body).toBe(202);const id=first.json().data.job_id;
 await db.pool.query('UPDATE jobs SET status=$2 WHERE id=$1',[id,status]);
 const next=await request();expect(next.statusCode,next.body).toBe(202);expect(next.json().data.job_id).not.toBe(id);
 const queue=new PgJobQueueRepository(db.pool);expect((await new JobWorker(queue,registry(),randomUUID(),[ACTIVITY_SUMMARY_JOB]).processOne()).status).toBe('completed');
 const completed=await request();expect(completed.statusCode,completed.body).toBe(202);expect(completed.json().data).toMatchObject({job_id:next.json().data.job_id,status:'completed',result:(await queue.getJob(next.json().data.job_id))!.result_json});
 expect((await db.pool.query("SELECT id FROM artifacts WHERE artifact_type='summary'")).rows).toHaveLength(1);
});
