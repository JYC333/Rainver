import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {waitForBlockedBy} from './support/lockWait.js';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,PROJECT,OWNER,AGENT,PROFILE} from './support/briefingFixture.js';
import {buildModuleServer} from './support/moduleServer.js';
import {informationDigestModule} from '../src/modules/informationDigest/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {ReadingPreferences} from '../src/modules/informationDigest/readingPreferences.js';
const db=useTestDatabase(import.meta.filename),world=briefingWorld(db);
let app:ReturnType<typeof buildModuleServer>;
const request=(key=randomUUID(),payload:object={})=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/information-briefings/personal`,headers:{'idempotency-key':key},payload});
beforeEach(async()=>{
 if(!db.available)return;
 await world.seed();
 await new ReadingPreferences(db.pool).set({spaceId:SPACE,userId:OWNER},PROJECT,true);
 await world.material('Request evidence');
 app=buildModuleServer(world.config(),[informationDigestModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('commits one briefing Run and Job with audit and receipt and replays once',async()=>{
 const key=randomUUID(),first=await request(key,{agent_id:AGENT,runtime_profile_id:PROFILE});
 expect(first.statusCode,first.body).toBe(201);
 const replay=await request(key,{agent_id:AGENT,runtime_profile_id:PROFILE});
 expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().data).toEqual(first.json().data);
 expect((await db.pool.query('SELECT id FROM information_briefings')).rows).toHaveLength(1);
 expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run'")).rows).toHaveLength(1);
 expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(1);
 expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE action='briefing.personal.request'")).rows.length).toBeGreaterThan(0);
});
it('deduplicates distinct intent keys at the canonical version owner',async()=>{
 expect((await request()).statusCode).toBe(201);
 const again=await request();expect(again.statusCode,again.body).toBe(200);
 expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run'")).rows).toHaveLength(1);
});
it('refuses cached content after Source consent or membership withdrawal',async()=>{
 const key=randomUUID();expect((await request(key)).statusCode).toBe(201);
 await db.pool.query("UPDATE source_connections SET consent_json='{}' WHERE space_id=$1",[SPACE]);
 expect((await request(key)).statusCode).toBe(404);
 await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
 expect((await request(key)).statusCode).toBe(404);
});
it('rolls back the version, Run, Job and receipt when mandatory audit cannot commit',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_request_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_request_audit()');
 try{
  const response=await request();expect(response.statusCode,response.body).toBe(503);
  for(const table of ['information_briefings','runs','jobs','operation_idempotency'])expect((await db.pool.query(`SELECT id FROM ${table}`)).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_request_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_request_audit()');}
});
it('requires the key and rejects identity, claim and request-time injection',async()=>{
 expect((await app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/information-briefings/personal`,payload:{}})).statusCode).toBe(422);
 for(const extra of [{user_id:OWNER},{claim_id:'claim'},{cutoff:'2000-01-01'},{run_id:'run'}])expect((await request(randomUUID(),extra)).statusCode).toBe(422);
 expect((await db.pool.query('SELECT id FROM jobs')).rows).toHaveLength(0);
});

it('refuses replay after the admitted execution Profile is disabled',async()=>{
 const key=randomUUID();expect((await request(key)).statusCode).toBe(201);
 await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[PROFILE]);
 const replay=await request(key);expect(replay.statusCode,replay.body).toBe(409);
 expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run'")).rows).toHaveLength(1);
});

it('ignores an unrelated unreadable Reading opt-in for request and replay',async()=>{
 const stale=randomUUID();
 await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Private stale opt-in','active',now(),now())`,[stale,SPACE,OWNER]);
 await new ReadingPreferences(db.pool).set({spaceId:SPACE,userId:OWNER},stale,true);
 await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[stale]);
 const key=randomUUID(),first=await request(key);
 expect(first.statusCode,first.body).toBe(201);
 const replay=await request(key);expect(replay.statusCode,replay.body).toBe(201);
 expect(replay.json().data).toEqual(first.json().data);
 expect(first.body).not.toContain('Private stale opt-in');
});

it('reselects optional Projects after concurrent revocation and retries without stale authority',async()=>{
 const stale=randomUUID();
 await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Private stale opt-in','active',now(),now())`,[stale,SPACE,OWNER]);
 await new ReadingPreferences(db.pool).set({spaceId:SPACE,userId:OWNER},stale,true);
 const hold=await db.pool.connect(),key=randomUUID();let pending:ReturnType<typeof request>|undefined;
 try{
  await hold.query('BEGIN');
  const pid=(await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await hold.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[stale]);
  pending=request(key);await waitForBlockedBy(db.pool,pid);
  await hold.query('COMMIT');const response=await pending;
  expect(response.statusCode,response.body).toBe(409);
 }finally{await hold.query('ROLLBACK');hold.release();await pending;}
 expect((await db.pool.query('SELECT id FROM information_briefings')).rows).toHaveLength(0);
 const retry=await request(key);expect(retry.statusCode,retry.body).toBe(201);
 const replay=await request(key);expect(replay.statusCode,replay.body).toBe(201);
 expect(replay.json().data).toEqual(retry.json().data);
});
