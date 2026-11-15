import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,OWNER,MEMBER,PROJECT,AGENT,PROFILE} from './support/briefingFixture.js';
import {buildModuleServer} from './support/moduleServer.js';
import {informationDigestModule} from '../src/modules/informationDigest/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {PgAutomationRepository} from '../src/modules/automations/repository.js';
const db=useTestDatabase(import.meta.filename),world=briefingWorld(db);
let app:ReturnType<typeof buildModuleServer>,automation:string;
const base=()=>`/api/v1/spaces/${SPACE}/information-briefings/personal/settings`;
const set=(daily_enabled:boolean,key=randomUUID(),extra:object={})=>app.inject({method:'PUT',url:base(),headers:{'idempotency-key':key},payload:{daily_enabled,...extra}});
const stored=async()=> (await db.pool.query('SELECT config_json FROM automations WHERE id=$1',[automation])).rows[0].config_json;
beforeEach(async()=>{
 if(!db.available)return;
 await world.seed();
 automation=(await new PgAutomationRepository(db.pool).create({spaceId:SPACE,ownerUserId:OWNER,agentId:AGENT,projectId:null,name:'Daily',triggerType:'schedule',configJson:{target_type:'information_digest',scope:'personal',operation:'daily',cron:'0 7 * * *',timezone:'UTC'},preflightSnapshot:{executable:true,target_type:'information_digest'}})).id;
 app=buildModuleServer(world.config(),[informationDigestModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('commits the canonical setting with a receipt, and replays without overwriting a newer choice',async()=>{
 const key=randomUUID(),first=await set(true,key,{agent_id:AGENT,runtime_profile_id:PROFILE});
 expect(first.statusCode,first.body).toBe(200);
 expect((await stored()).briefing).toEqual({enabled:true,user_id:OWNER,agent_id:AGENT,runtime_profile_id:PROFILE});
 expect((await set(false)).statusCode).toBe(200);
 expect((await set(true,key,{agent_id:AGENT,runtime_profile_id:PROFILE})).json().data).toEqual(first.json().data);
 expect((await stored()).briefing).toEqual({enabled:false});
 expect((await stored()).timezone).toBe('UTC');
 expect((await db.pool.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
});
it.each(['account','membership'])('refuses replay after current %s revocation',async kind=>{
 const key=randomUUID();expect((await set(false,key)).statusCode).toBe(200);
 if(kind==='account')await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[OWNER]);
 else await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
 expect((await set(false,key)).statusCode).toBe(404);
});
it.each(['policy_decision_records','operation_idempotency'])('rolls back config when mandatory %s fails',async table=>{
 const key=randomUUID();
 await db.pool.query("CREATE FUNCTION refuse_briefing_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'briefing store refused'; END $$");
 await db.pool.query(table==='policy_decision_records'
  ? 'CREATE CONSTRAINT TRIGGER refuse_briefing_store AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_briefing_store()'
  : 'CREATE TRIGGER refuse_briefing_store BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_briefing_store()');
 try{const r=await set(true,key);expect(r.statusCode,r.body).toBe(table==='policy_decision_records'?503:500);expect((await stored()).briefing).toBeUndefined();}
 finally{await db.pool.query(`DROP TRIGGER refuse_briefing_store ON ${table}`);await db.pool.query('DROP FUNCTION refuse_briefing_store()');}
 expect((await set(true,key)).statusCode).toBe(200);
});
it('rejects missing key, unknown owner fields and unusable or foreign execution',async()=>{
 expect((await app.inject({method:'PUT',url:base(),payload:{daily_enabled:false}})).statusCode).toBe(422);
 expect((await set(false,randomUUID(),{user_id:MEMBER})).statusCode).toBe(422);
 expect((await set(true,randomUUID(),{agent_id:randomUUID(),runtime_profile_id:PROFILE})).statusCode).toBe(409);
 await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[PROFILE]);
 expect((await set(true,randomUUID(),{agent_id:AGENT,runtime_profile_id:PROFILE})).statusCode).toBe(409);
 expect((await stored()).briefing).toBeUndefined();
});
it('keeps Project replacement conditional on current reader and writer authority',async()=>{
 const url=`/api/v1/spaces/${SPACE}/projects/${PROJECT}/information-briefings/settings`;
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});
 const denied=await app.inject({method:'PUT',url,payload:{daily_enabled:true},headers:{'idempotency-key':randomUUID()}});
 expect(denied.statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});
 const retired=await app.inject({method:'PUT',url,payload:{daily_enabled:true},headers:{'idempotency-key':randomUUID()}});
 expect(retired.statusCode,retired.body).toBe(410);
 expect(retired.json().error.metadata.code).toBe('project_daily_briefing_replaced');
 expect((await stored()).briefing).toBeUndefined();
});

it('coalesces concurrent same-key settings into one durable receipt',async()=>{
 const key=randomUUID();const replies=await Promise.all([set(true,key),set(true,key)]);
 expect(replies.some(r=>r.statusCode===200)).toBe(true);
 expect(replies.every(r=>[200,409].includes(r.statusCode))).toBe(true);
 expect((await set(true,key)).statusCode).toBe(200);
 expect((await db.pool.query("SELECT id FROM operation_idempotency WHERE operation_id='briefing.personal.settings.set' AND idempotency_key=$1",[key])).rows).toHaveLength(1);
 expect((await stored()).briefing.enabled).toBe(true);
});
