import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedSpaceMember } from './support/domainSeeds.js';
import { waitForBlockedBy } from './support/lockWait.js';
import { buildModuleServer } from './support/moduleServer.js';
import { informationDigestModule } from '../src/modules/informationDigest/index.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { InterestProfileService } from '../src/modules/interestProfile/service.js';
import { PgInterestProfileRepository } from '../src/modules/interestProfile/repository.js';
import { loadConfig } from '../src/config.js';
const db=useTestDatabase(import.meta.filename,{max:5});
let space:string,owner:string,viewer:string,app:ReturnType<typeof buildModuleServer>;
const write=(path:string,payload:object={},key=randomUUID(),method:'POST'|'PATCH'='POST')=>app.inject({method,url:`/api/v1/spaces/${space}/interest-profile/${path}`,payload,headers:{'idempotency-key':key}});
const topic={label:'Reliable software',domain_key:'software_engineering',weight:2};
const profile=()=>new InterestProfileService(db.pool).snapshot(space,owner);
async function candidate(phrase:string) {
 const p=await new PgInterestProfileRepository(db.pool).ensureProfile(space,owner);
 await db.pool.query("INSERT INTO interest_topic_candidates(id,space_id,user_id,profile_id,phrase_key,display_phrase,domain_key,occurrence_count,read_count,status,last_seen_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5,'software_engineering',4,2,'ready',now(),now(),now())",[randomUUID(),space,owner,p.id,phrase]);
}
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();viewer=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID(),spaceType:'team'});await seedSpaceMember(db.pool,{space,user:viewer});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[informationDigestModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('creates, edits and archives an owner topic; replay cannot overwrite the later edit or reactivate it',async()=>{
 const key=randomUUID(),first=await write('topics',topic,key);expect(first.statusCode,first.body).toBe(201);
 const t=first.json().data.topic;expect(t).toMatchObject({origin:'user',label:topic.label,weight:2});
 expect((await write(`topics/${t.topic_key}`,{...topic,label:'Changed',weight:7},randomUUID(),'PATCH')).statusCode).toBe(200);
 expect((await write('topics',topic,key)).json().data).toEqual(first.json().data);expect((await profile()).topics[0].weight).toBe(7);
 const archiveKey=randomUUID(),a=await write(`topics/${t.topic_key}/archive`,{},archiveKey);expect(a.statusCode,a.body).toBe(200);expect((await profile()).topics).toEqual([]);
 expect((await write(`topics/${t.topic_key}/archive`,{},archiveKey)).json().data).toEqual(a.json().data);
 __setAuthIdentityForTests({spaceId:space,userId:viewer});expect((await write(`topics/${t.topic_key}`,topic,randomUUID(),'PATCH')).statusCode).toBe(404);
});
it('accepts one candidate atomically and dismisses another; successful replay survives consumed candidate state',async()=>{
 await candidate('reliability');await candidate('dismissed phrase');const key=randomUUID();
 const first=await write('candidates/reliability/accept',{},key);expect(first.statusCode,first.body).toBe(200);expect(first.json().data.topic.topic_key).toBe('reliability');
 expect((await write('candidates/reliability/accept',{},key)).json().data).toEqual(first.json().data);
 expect((await write('candidates/dismissed%20phrase/dismiss')).statusCode).toBe(200);expect((await profile()).ready_candidates).toEqual([]);
});
it('merges settings under canonical transaction and refuses invalid merged thresholds without changing state',async()=>{
 expect((await write('settings',{interest_slots:9},randomUUID(),'PATCH')).statusCode).toBe(200);
 expect((await write('settings',{new_topic_read_threshold:100},randomUUID(),'PATCH')).statusCode).toBe(422);expect((await profile()).settings.interest_slots).toBe(9);
 const old=await profile();expect(old.settings.new_topic_read_threshold).toBe(2);
});
it.each(['membership','account'])('rechecks current %s on a cached success',async kind=>{
 const key=randomUUID();expect((await write('topics',topic,key)).statusCode).toBe(201);
 if(kind==='membership')await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);else await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
 expect((await write('topics',topic,key)).statusCode).toBe(404);
});
it('rejects missing key, identity/target injection, unknown domain, empty settings and mismatched payload',async()=>{
 expect((await app.inject({method:'POST',url:`/api/v1/spaces/${space}/interest-profile/topics`,payload:topic})).statusCode).toBe(422);
 for(const body of [{...topic,user_id:viewer},{...topic,space_id:space},{...topic,domain_key:'unknown'}])expect((await write('topics',body)).statusCode).toBe(422);
 expect((await write('settings',{},randomUUID(),'PATCH')).statusCode).toBe(422);
 const key=randomUUID();expect((await write('topics',topic,key)).statusCode).toBe(201);expect((await write('topics',{...topic,weight:9},key)).statusCode).toBe(422);
});
it.each(['topics','candidates/reliability/accept','settings'])('deferred audit failure rolls back %s and receipt; same-key recovery works',async path=>{
 if(path.includes('candidate'))await candidate('reliability');
 const key=randomUUID(),body=path==='topics'?topic:path==='settings'?{interest_slots:9}:{},method=path==='settings'?'PATCH':'POST';
 await db.pool.query("CREATE FUNCTION refuse_interest_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_interest_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_interest_audit()');
 try{const r=await write(path,body,key,method);expect(r.statusCode,r.body).toBe(503);expect((await profile()).topics).toEqual([]);expect((await profile()).settings.interest_slots).toBe(6);expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);if(path.includes('candidate'))expect((await profile()).ready_candidates).toHaveLength(1);}
 finally{await db.pool.query('DROP TRIGGER refuse_interest_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_interest_audit()');}
 expect((await write(path,body,key,method)).statusCode).toBe(path==='topics'?201:200);
});
it('serializes concurrent settings merges, including direct canonical callers, without losing either field',async()=>{
 const hold=await db.pool.connect();let pending:ReturnType<typeof write>|undefined;
 try{await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 await new InterestProfileService(hold).updateSettings(space,owner,{interest_slots:8});pending=write('settings',{serendipity_slots:4},randomUUID(),'PATCH');await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');const r=await pending;expect(r.statusCode,r.body).toBe(200);}
 finally{await hold.query('ROLLBACK');hold.release();await pending;}
 expect((await profile()).settings).toMatchObject({interest_slots:8,serendipity_slots:4});
});
