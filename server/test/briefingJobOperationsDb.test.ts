import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,PROJECT,OWNER,MEMBER,AGENT,PROFILE} from './support/briefingFixture.js';
import {buildModuleServer} from './support/moduleServer.js';
import {informationDigestModule} from '../src/modules/informationDigest/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {ReadingPreferences} from '../src/modules/informationDigest/readingPreferences.js';
import {personalBriefingScope} from '../src/modules/informationDigest/briefing/personalScope.js';
import {waitForBlockedBy} from './support/lockWait.js';
const db=useTestDatabase(import.meta.filename,{max:6}),world=briefingWorld(db);
let app:ReturnType<typeof buildModuleServer>,briefing:string,run:string;
const path=(project=false)=>`/api/v1/spaces/${SPACE}/${project?`projects/${PROJECT}/information-briefings`:'information-briefings/personal'}/${briefing}/cancel`;
const stop=(key=randomUUID(),project=false,extra:object={})=>app.inject({method:'POST',url:path(project),headers:{'idempotency-key':key},payload:extra});
beforeEach(async()=>{
 if(!db.available)return;
 await world.seed();
 await new ReadingPreferences(db.pool).set({spaceId:SPACE,userId:OWNER},PROJECT,true);
 await world.material('Cancellation evidence');
 const result=await world.service().request(personalBriefingScope(SPACE,OWNER),OWNER,{kind:'manual',execution:{},origin:'manual',label:'Personal'});
 briefing=result.briefing.id;run=(await world.rowOf(briefing)).run_id!;
 app=buildModuleServer(world.config(),[informationDigestModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('commits the exact stop intent once and replays without another Job',async()=>{
 const key=randomUUID(),jobs=(await db.pool.query('SELECT id FROM jobs ORDER BY id')).rows;
 const first=await stop(key);expect(first.statusCode,first.body).toBe(200);
 expect(first.json().data).toMatchObject({briefing_id:briefing,run_id:run,status:'cancelling',attempt:1});
 const replay=await stop(key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);
 expect((await db.pool.query('SELECT id FROM jobs ORDER BY id')).rows).toEqual(jobs);
 expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toHaveLength(1);
});
it('refuses foreign owner, wrong scope and injected Run targets',async()=>{
 expect((await stop(randomUUID(),false,{run_id:randomUUID()})).statusCode).toBe(422);
 expect((await stop(randomUUID(),true)).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});expect((await stop()).statusCode).toBe(404);
});
it('rechecks current authority on replay after membership withdrawal',async()=>{
 const key=randomUUID();expect((await stop(key)).statusCode).toBe(200);
 await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
 expect((await stop(key)).statusCode).toBe(404);
});
it('rolls back cancellation intent and receipt when the deferred audit fails',async()=>{
 const key=randomUUID();
 await db.pool.query("CREATE FUNCTION refuse_briefing_job_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_briefing_job_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_briefing_job_audit()');
 try{
  const response=await stop(key);expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0].status).toBe('queued');
  expect((await world.rowOf(briefing)).status).toBe('queued');
  expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);
 }finally{await db.pool.query('DROP TRIGGER refuse_briefing_job_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_briefing_job_audit()');}
 expect((await stop(key)).statusCode).toBe(200);
});
it('preserves terminal settlement when it wins concurrent cancellation',async()=>{
 const holder=await db.pool.connect();let pending:ReturnType<typeof stop>|undefined;
 try{
  await holder.query('BEGIN');const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await holder.query("UPDATE runs SET status='failed',ended_at=now() WHERE id=$1",[run]);
  await holder.query("UPDATE information_briefings SET status='failed',error_code='briefing_run_failed' WHERE id=$1",[briefing]);
  pending=stop();await waitForBlockedBy(db.pool,pid);await holder.query('COMMIT');
  const result=await pending;expect(result.statusCode,result.body).toBe(200);expect(result.json().data.status).toBe('failed');
 }finally{await holder.query('ROLLBACK');holder.release();await pending;}
 expect((await world.rowOf(briefing)).status).toBe('failed');
});
it('exposes the historical Project cancellation URL under current Project writer authority',async()=>{
 const started=await world.service().request(world.adapter(),OWNER,{kind:'manual',execution:{},origin:'manual',label:'Project'});
 briefing=started.briefing.id;
 const response=await stop(randomUUID(),true);expect(response.statusCode,response.body).toBe(200);
 expect(response.json().data).toMatchObject({project_id:PROJECT,briefing_id:briefing,status:'cancelling'});
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});expect((await stop(randomUUID(),true)).statusCode).toBe(404);
});
it('refuses a stale attempt binding without cancelling its Run',async()=>{
 await db.pool.query('UPDATE information_briefings SET attempt=attempt+1 WHERE id=$1',[briefing]);
 const result=await stop();expect(result.statusCode,result.body).toBe(409);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0].status).toBe('queued');
});
it('requires an explicit command key before accepting a cancellation',async()=>{
 expect((await app.inject({method:'POST',url:path(),payload:{}})).statusCode).toBe(422);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0].status).toBe('queued');
});
it('allows the owner to stop after Source consent is withdrawn',async()=>{
 await db.pool.query("UPDATE source_connections SET status='archived',capture_policy='reference_only' WHERE space_id=$1",[SPACE]);
 const response=await stop();expect(response.statusCode,response.body).toBe(200);
 expect(response.json().data.status).toBe('cancelling');
});
it('rechecks Project writer authority when replaying a historical Project stop',async()=>{
 const started=await world.service().request(world.adapter(),OWNER,{kind:'manual',execution:{},origin:'manual',label:'Project'});
 briefing=started.briefing.id;const key=randomUUID();expect((await stop(key,true)).statusCode).toBe(200);
 await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[PROJECT,MEMBER]);
 expect((await stop(key,true)).statusCode).toBe(404);
});
it('preserves conditional Project generation retirement without creating work',async()=>{
 const jobs=(await db.pool.query('SELECT id FROM jobs ORDER BY id')).rows;
 const request=(payload:object={},key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/projects/${PROJECT}/information-briefings`,headers:{'idempotency-key':key},payload});
 const response=await request({agent_id:AGENT,runtime_profile_id:PROFILE});expect(response.statusCode,response.body).toBe(410);
 expect(response.json().error.metadata.code).toBe('project_daily_briefing_replaced');
 expect((await db.pool.query('SELECT id FROM jobs ORDER BY id')).rows).toEqual(jobs);
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});expect((await request()).statusCode).toBe(404);
});
