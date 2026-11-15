import {waitForBlockedBy} from './support/lockWait.js';
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentAttentionQuerySchema } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedAttentionRun } from "./support/agentAttentionSeeds.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { AgentAttentionRepository } from "../src/modules/agentAttention/repository.js";
import { loadWorks, changeReadState } from "../src/modules/agentAttention/readStateService.js";
import { boundWork } from "../src/modules/agentAttention/readModel.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { agentAttentionModule } from "../src/modules/agentAttention/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
let app:ReturnType<typeof buildModuleServer>;
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
const db = useTestDatabase(import.meta.url,{max:5});
const user = randomUUID(), space = randomUUID(), project = randomUUID();
const now = new Date().toISOString();
beforeEach(async()=>{
  if (!db.available) return;
  await resetTables(db.pool,['spaces','users'],{cascade:true});
  await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});
  const personal=randomUUID();
  await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Personal','personal',now(),now())",[personal]);
  await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,user]);
  __setAuthIdentityForTests({spaceId:space,userId:user});
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[agentAttentionModule]);

});
async function run(status='succeeded',time=now) {
  return seedAttentionRun(db.pool,{space,owner:user,status,now:time});
}
async function page(query={}) {
  return new AgentAttentionRepository(db.pool).page((await loadWorks(db.pool,user)).map(i=>boundWork(i)),AgentAttentionQuerySchema.parse(query),now);
}
async function request() {
  await run(); const item=(await page()).items[0]!;
  return {identity:item.identity,space_id:space,subject:item.read_states[0]!.subject,state_version:0,action:'read' as const};
}

const headers=(key:string)=>({'idempotency-key':key});
const read=(input:import('@rainver/protocol').AgentAttentionReadRequest,key:string)=>app.inject({method:'PATCH',url:'/api/v1/me/agent-attention/read-state',headers:headers(key),payload:input});
async function conversation(){
 const id=await run(),session=randomUUID(),message=randomUUID();
 const {agent_id}=(await db.pool.query('SELECT agent_id FROM runs WHERE id=$1',[id])).rows[0];
 await db.pool.query("INSERT INTO sessions(id,space_id,user_id,agent_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())",[session,space,user,agent_id]);
 await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1',[id,session]);
 await db.pool.query(`INSERT INTO messages(id,space_id,session_id,sender_agent_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
 VALUES($1,$2,$3,$4,'assistant','Ready','{}',1,'/',$5,$6)`,[message,space,session,agent_id,id,now]);
 await db.pool.query('UPDATE sessions SET head_message_id=$2 WHERE id=$1',[session,message]);
 return {space_id:space,session_id:session,message_ids:[message]};
}
describe('attention core canonical writes (real PG)',()=>{
 it('read replay retains a later manual unread decision',async()=>{
  const input=await request(),first=await read(input,'read');expect(first.statusCode).toBe(200);
  const state=first.json().data.state;expect(state.state_version).toBe(1);
  expect((await read(input,'read')).json()).toEqual(first.json());
  const later=await read({...input,state_version:1,action:'unread'},'unread');expect(later.statusCode).toBe(200);
  expect((await read(input,'read')).json()).toEqual(first.json());
  expect((await page()).items[0]!.read_states[0]).toMatchObject({manual_unread:true,state_version:2});
 });
 it('view POST has real effects and replays without reading a later unread again',async()=>{
  const input=await conversation(),send=()=>app.inject({method:'POST',url:'/api/v1/me/agent-attention/views',headers:headers('views'),payload:input});
  const first=await send();expect(first.statusCode).toBe(200);expect(first.json().data.read_count).toBe(1);
  const item=(await page()).items[0]!,state=first.json().data.read_states[0];
  await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:state.subject,state_version:1,action:'unread'});
  expect((await send()).json()).toEqual(first.json());
  expect((await page()).items[0]!.read_states[0]).toMatchObject({manual_unread:true,state_version:2});
 });
 it('source membership withdrawal withholds the old read receipt',async()=>{
  const input=await request();expect((await read(input,'withdraw')).statusCode).toBe(200);
  await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[space,user]);
  expect((await read(input,'withdraw')).statusCode).toBe(404);
 });
 it('source membership withdrawal withholds the old views receipt',async()=>{
  const input=await conversation(),send=()=>app.inject({method:'POST',url:'/api/v1/me/agent-attention/views',headers:headers('withdraw-views'),payload:input});
  expect((await send()).statusCode).toBe(200);
  await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[space,user]);
  expect((await send()).statusCode).toBe(404);
 });
 it('late audit failure rolls back read and receipt and same key recovers',async()=>{
  const input=await request();
  await db.pool.query("CREATE FUNCTION refuse_attention_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
  await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_attention_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_attention_audit()');
  try{expect((await read(input,'rollback')).statusCode).toBe(503);
   expect((await page()).items[0]!.read_states[0]!.state_version).toBe(0);
  }finally{await db.pool.query('DROP TRIGGER refuse_attention_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_attention_audit()');}
  expect((await read(input,'rollback')).statusCode).toBe(200);
 });
 it('canonical read writer waits on source membership withdrawal and refuses',async()=>{
  const input=await request(),client=await db.pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await client.query('BEGIN');const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await client.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[space,user]);
   const result=changeReadState(db.pool,user,input).then(()=>({ok:true}),error=>({ok:false,status:error.statusCode}));pending=result;
   await waitForBlockedBy(db.pool,pid);
   expect((await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))',[pid])).rows.length).toBeGreaterThan(0);
   await client.query('COMMIT');expect(await result).toMatchObject({ok:false});
  }finally{await client.query('ROLLBACK');client.release();await pending;}
 });
});
