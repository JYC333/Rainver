import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {ensureDefaultRuntimeProfile,seedAgentWithVersion,seedSpaceMember,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {agentsModule} from '../src/modules/agents/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';

/** Direct conversation turns through the core: one transaction for the session,
 * message, Run and Job; Host work is a frozen request the dispatch performs. */
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,agent:string,hostId:string,app:ReturnType<typeof buildModuleServer>;
const send=(payload:Record<string,unknown>,key:string=randomUUID(),agentId=agent)=>app.inject({method:'POST',url:`/api/v1/agents/${agentId}/chat`,payload,headers:{'idempotency-key':key}});
const count=async(table:string)=>(await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[space])).rows[0].n as number;

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','hosts','machines','jobs'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();agent=randomUUID();hostId=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'personal'});
 await db.pool.query("INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,'Desk','desktop',now(),now())",[hostId,owner]);
 await db.pool.query(`INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,last_heartbeat_at,created_at,updated_at)
  VALUES($1,$2,$1,'Desk','remote','linux_native','online',$3::jsonb,now(),now(),now())`,[hostId,owner,JSON.stringify({execution_workspaces:{version:2},runtimes:[],versions:{},installations:{opencode:[{id:'managed:1.0.0',version:'1.0.0',logged_in:true,health_check_protocol:'acp',options:{config_options:[],prompt_capabilities:{image:true,embedded_context:false,resource_link:true}}}]}})]);
 await seedAgentWithVersion(db.pool,{space,owner,agent,version:randomUUID(),seedDefaultRuntimeProfile:false});
 await ensureDefaultRuntimeProfile(db.pool,{agent,space,runtimeKey:'opencode',executionHostId:hostId,runtimeInstallation:'managed:1.0.0',workspaceMode:'managed'});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[agentsModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app.close();});

describe('direct Agent turns (real PostgreSQL)',()=>{
 it('commits the session, message, Run and Job together and replays the receipt without a second turn',async()=>{
  const key=randomUUID(),body={message:'  Plan the week  ',restore_workspace:true};
  const first=await send(body,key);
  expect(first.statusCode,first.body).toBe(202);
  const receipt=first.json().data as {run_id:string;session_id:string;user_message_id:string;space_id:string;status:string};
  expect(receipt).toMatchObject({space_id:space,status:'queued',event_stream_url:`/api/v1/runs/${receipt.run_id}/turn/stream`});
  const replay=await app.inject({method:'POST',url:'/api/v1/actions/agent.chat.send',payload:{...body,agent_id:agent},headers:{'idempotency-key':key}});
  expect(replay.json()).toEqual(first.json());
  expect([await count('messages'),await count('runs')]).toEqual([1,1]);
  const run=(await db.pool.query("SELECT status,trigger_origin,model_override_json FROM runs WHERE id=$1",[receipt.run_id])).rows[0];
  expect(run).toMatchObject({status:'queued',trigger_origin:'manual'});
  // The restore is a frozen request for the Host dispatch, not Host IO in this transaction.
  expect(run.model_override_json.chat_turn).toMatchObject({assigned_task:'Plan the week',user_message_id:receipt.user_message_id,restore_managed_workspace:{include_workspace:true}});
  expect((await db.pool.query("SELECT payload_json->>'run_id' AS run FROM jobs WHERE space_id=$1 AND job_type='agent_run'",[space])).rows).toEqual([{run:receipt.run_id}]);
  // The same conversation refuses an overlapping turn as a conflict, writing nothing.
  const overlap=await send({message:'Again',session_id:receipt.session_id});
  expect(overlap.statusCode,overlap.body).toBe(409);
  expect(await count('messages')).toBe(1);
 });

 it('rolls the whole turn back when its Job cannot be written',async()=>{
  await db.pool.query("CREATE FUNCTION refuse_chat_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job refused'; END $$");
  await db.pool.query("CREATE TRIGGER refuse_chat_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_chat_job()");
  try{
   const refused=await send({message:'Hello'});
   expect(refused.statusCode).toBe(500);
   expect([await count('sessions'),await count('messages'),await count('runs')]).toEqual([0,0,0]);
  }finally{await db.pool.query('DROP TRIGGER refuse_chat_job ON jobs');await db.pool.query('DROP FUNCTION refuse_chat_job()');}
 });

 it('hides invisible Agents and sessions and refuses empty or foreign-context turns before writing',async()=>{
  const stranger=randomUUID();
  await seedSpaceMember(db.pool,{space,user:stranger});
  const first=(await send({message:'Mine'})).json().data as {session_id:string;run_id:string};
  await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[first.run_id]);
  expect((await send({message:''})).statusCode).toBe(422);
  expect((await send({message:'Elsewhere',session_id:first.session_id,project_id:project})).statusCode).toBe(409);
  __setAuthIdentityForTests({spaceId:space,userId:stranger});
  // The Agent is shared in the Space, but the session is the owner's.
  expect((await send({message:'Peek',session_id:first.session_id})).statusCode).toBe(404);
  const retry=await app.inject({method:'POST',url:`/api/v1/agents/${agent}/chat/retry`,payload:{run_id:first.run_id},headers:{'idempotency-key':randomUUID()}});
  expect(retry.statusCode).toBe(404);
  await db.pool.query("UPDATE agents SET visibility='private' WHERE id=$1",[agent]);
  expect((await send({message:'Hi'})).statusCode).toBe(404);
  expect(await count('messages')).toBe(1);
 });

 it('retries a failed turn once per key with its original message, keeping the restore request',async()=>{
  const first=(await send({message:'Draft',restore_workspace:true})).json().data as {session_id:string;run_id:string;user_message_id:string};
  const retry=(key:string)=>app.inject({method:'POST',url:`/api/v1/agents/${agent}/chat/retry`,payload:{run_id:first.run_id},headers:{'idempotency-key':key}});
  expect((await retry(randomUUID())).statusCode).toBe(409);
  await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[first.run_id]);
  await db.pool.query("UPDATE conversation_runtime_sessions SET active_turn_user_id=NULL,active_turn_claimed_at=NULL WHERE session_id=$1",[first.session_id]).catch(()=>undefined);
  await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL WHERE agent_id=$1",[agent]);
  const key=randomUUID(),retried=await retry(key);
  expect(retried.statusCode,retried.body).toBe(202);
  const data=retried.json().data as {run_id:string;retry_of_run_id:string;user_message_id:string};
  expect(data).toMatchObject({retry_of_run_id:first.run_id,user_message_id:first.user_message_id});
  expect((await retry(key)).json()).toEqual(retried.json());
  expect((await db.pool.query("SELECT model_override_json->'chat_turn' AS turn FROM runs WHERE id=$1",[data.run_id])).rows[0].turn).toMatchObject({retry_of_run_id:first.run_id,restore_managed_workspace:{include_workspace:true}});
  expect(await count('runs')).toBe(2);
 });
});
