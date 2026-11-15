import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,OWNER,CHANNEL,CONNECTION} from './support/briefingFixture.js';
import {informationDigestModule} from '../src/modules/informationDigest/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {InterestProfileService} from '../src/modules/interestProfile/service.js';
import {waitForBlockedBy} from './support/lockWait.js';
const db=useTestDatabase(import.meta.filename,{max:6}),world=briefingWorld(db);
let app:ReturnType<typeof buildModuleServer>;
const write=(path:string,body:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/interest-profile/${path}`,headers:{'idempotency-key':key},payload:body});
const count=async(table:string)=>Number((await db.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
beforeEach(async()=>{if(!db.available)return;await world.seed();app=buildModuleServer(world.config(),[informationDigestModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
async function history(){return world.material('History',{analysed:false});}
async function recommendation(){
 const id=await world.material('Recommended');
 await db.pool.query("UPDATE source_item_annotations SET domain_key='artificial_intelligence' WHERE source_item_id=$1",[id]);
 await db.pool.query('DELETE FROM source_channel_user_subscriptions WHERE space_id=$1 AND source_channel_id=$2 AND user_id=$3',[SPACE,CHANNEL,OWNER]);
 return id;
}
it('queues bounded recent subscription history and one existing Job atomically; same-key replay creates nothing',async()=>{
 const item=await history(),key=randomUUID(),before=await count('jobs');
 const first=await write('history-backfill',{limit:1},key);expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({queued:1,limit:1,source_refs:[{item_id:item,channel_id:CHANNEL,connection_id:CONNECTION}]});
 expect(await count('jobs')).toBe(before+1);expect((await write('history-backfill',{limit:1},key)).json().data).toEqual(first.json().data);expect(await count('jobs')).toBe(before+1);
 const row=(await db.pool.query('SELECT status,attempt_count FROM source_item_annotations WHERE source_item_id=$1',[item])).rows[0];expect(row).toEqual({status:'pending',attempt_count:0});
});
it.each(['Source','subscription','item'])('refuses history replay after current %s withdrawal',async kind=>{
 const item=await history(),key=randomUUID();expect((await write('history-backfill',{limit:1},key)).statusCode).toBe(200);
 if(kind==='Source')await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[CONNECTION]);
 else if(kind==='subscription')await db.pool.query("UPDATE source_channel_user_subscriptions SET status='muted' WHERE source_channel_id=$1 AND user_id=$2",[CHANNEL,OWNER]);
 else await db.pool.query("UPDATE source_items SET deleted_at=now() WHERE id=$1",[item]);
 const r=await write('history-backfill',{limit:1},key);expect(r.statusCode,r.body).toBe(404);
});
it('applies only missing starter topics, preserves existing origin/weight, and creates only pending Source recommendations',async()=>{
 await recommendation();const profiles=new InterestProfileService(db.pool);
 await profiles.createTopic(SPACE,OWNER,{label:'Artificial intelligence',domainKey:'artificial_intelligence',weight:7});
 await db.pool.query("UPDATE interest_topics SET origin='agent' WHERE user_id=$1",[OWNER]);
 const key=randomUUID(),first=await write('starter-pack',{key:'technology'},key);expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({topics:2,source_recommendations:1});
 expect((await db.pool.query('SELECT status FROM source_channel_user_subscriptions WHERE source_channel_id=$1 AND user_id=$2',[CHANNEL,OWNER])).rows[0].status).toBe('pending');
 expect((await profiles.snapshot(SPACE,OWNER)).topics.find(t=>t.topic_key==='artificial-intelligence')).toMatchObject({origin:'agent',weight:7});
 expect((await write('starter-pack',{key:'technology'},key)).json().data).toEqual(first.json().data);
 expect((await write('starter-pack',{key:'technology'})).json().data).toMatchObject({topics:0,source_recommendations:0});
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[CONNECTION]);
 expect((await write('starter-pack',{key:'technology'},key)).statusCode).toBe(404);
});
it.each(['starter-pack','history-backfill'])('deferred audit failure rolls back all %s state and intent, then same-key recovery succeeds',async path=>{
 if(path==='starter-pack')await recommendation();else await history();
 const before=await Promise.all(['jobs','source_item_annotations','source_channel_user_subscriptions','activity_records'].map(count)),key=randomUUID(),body=path==='starter-pack'?{key:'technology'}:{limit:1};
 await db.pool.query("CREATE FUNCTION refuse_interest_sources_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_interest_sources_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_interest_sources_audit()');
 try{const r=await write(path,body,key);expect(r.statusCode,r.body).toBe(503);expect(await Promise.all(['jobs','source_item_annotations','source_channel_user_subscriptions','activity_records'].map(count))).toEqual(before);expect(await count('interest_topics')).toBe(0);expect(await count('operation_idempotency')).toBe(0);}
 finally{await db.pool.query('DROP TRIGGER refuse_interest_sources_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_interest_sources_audit()');}
 expect((await write(path,body,key)).statusCode).toBe(200);
});
it('mandatory annotation Job failure rolls back annotations and receipt with no false success',async()=>{
 await history();const key=randomUUID();
 await db.pool.query("CREATE FUNCTION refuse_history_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job unavailable'; END $$");
 await db.pool.query('CREATE TRIGGER refuse_history_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_history_job()');
 try{expect((await write('history-backfill',{limit:1},key)).statusCode).toBe(500);expect(await count('source_item_annotations')).toBe(0);expect(await count('operation_idempotency')).toBe(0);}
 finally{await db.pool.query('DROP TRIGGER refuse_history_job ON jobs');await db.pool.query('DROP FUNCTION refuse_history_job()');}
 expect((await write('history-backfill',{limit:1},key)).statusCode).toBe(200);
});
it('a concurrent Source archive cannot pass history admission with stale discovery',async()=>{
 await history();const hold=await db.pool.connect();let pending:ReturnType<typeof write>|undefined;
 try{await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 await hold.query("UPDATE source_connections SET status='archived' WHERE id=$1",[CONNECTION]);pending=write('history-backfill',{limit:1});await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');const r=await pending;expect(r.statusCode,r.body).toBe(404);}
 finally{await hold.query('ROLLBACK');hold.release();await pending;}
 expect(await count('source_item_annotations')).toBe(0);
});
it.each(['starter-pack','history-backfill'])('review regression: %s discovers Projects before taking any person lock',async path=>{
 const item=path==='starter-pack'?await recommendation():await history();
 const {PROJECT}=await import('./support/briefingFixture.js');await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[item,PROJECT]);
 const hold=await db.pool.connect(),probe=await db.pool.connect();let pending:ReturnType<typeof write>|undefined;
 try{
  await hold.query('BEGIN');const pid=(await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await hold.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[PROJECT]);
  pending=write(path,path==='starter-pack'?{key:'technology'}:{limit:1});await waitForBlockedBy(db.pool,pid);
  await probe.query('BEGIN');await probe.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[OWNER]);
  await probe.query('ROLLBACK');await hold.query('COMMIT');const result=await pending;expect(result.statusCode,result.body).toBe(200);
 }finally{await probe.query('ROLLBACK');await hold.query('ROLLBACK');probe.release();hold.release();await pending;}
});
it.each(['operation','service'])('review regression: annotation retry %s discovers Projects before any person lock',async mode=>{
 const item=await history(),{PROJECT}=await import('./support/briefingFixture.js');
 await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[item,PROJECT]);
 await db.pool.query("INSERT INTO source_item_annotations(id,space_id,source_item_id,source_channel_id,status,wait_reason,next_retry_at,topic_candidates_json,attempt_count,created_at,updated_at) VALUES($1,$2,$3,$4,'pending','retry_scheduled',now(),'[]',0,now(),now())",[randomUUID(),SPACE,item,CHANNEL]);
 const hold=await db.pool.connect(),probe=await db.pool.connect();let pending:Promise<unknown>|undefined;
 try{
  await hold.query('BEGIN');const pid=(await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await hold.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[PROJECT]);
  if(mode==='operation')pending=Promise.resolve(app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/source-annotation/retry`,headers:{'idempotency-key':randomUUID()},payload:{}}));
  else{const {SourceAnnotationService}=await import('../src/modules/sourceAnnotation/service.js');pending=new SourceAnnotationService(db.pool,world.config()).manualRetry(SPACE,OWNER);}
  await waitForBlockedBy(db.pool,pid);await probe.query('BEGIN');await probe.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[OWNER]);
  await probe.query('ROLLBACK');await hold.query('COMMIT');await pending;
 }finally{await probe.query('ROLLBACK');await hold.query('ROLLBACK');probe.release();hold.release();await pending;}
});
