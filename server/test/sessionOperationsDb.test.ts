import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceMember,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {sessionsModule} from '../src/modules/sessions/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';

/** Direct conversation commands through the operation core. */
const db=useTestDatabase(import.meta.filename,{max:6});
let personal:string,team:string,user:string,member:string,project:string,app:ReturnType<typeof buildModuleServer>;
const send=(method:'POST'|'DELETE',url:string,payload:object={},key:string=randomUUID())=>app.inject({method,url,payload,headers:{'idempotency-key':key}});

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 personal=randomUUID();team=randomUUID();user=randomUUID();member=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space:personal,owner:user,project:randomUUID(),spaceType:'personal'});
 await db.pool.query("INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Team','team',$2,now(),now())",[team,user]);
 await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),team,user]);
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Team project','active',now(),now())",[project,team,user]);
 await seedSpaceMember(db.pool,{space:team,user:member});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[sessionsModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:team,userId:user});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app.close();});

describe('direct session commands (real PostgreSQL)',()=>{
 it('places, writes, reflects and deletes a conversation with one key per intent',async()=>{
  const key=randomUUID(),created=await send('POST','/api/v1/sessions',{title:'Notes'},key);
  expect(created.statusCode,created.body).toBe(201);
  const {session_id:sessionId,space_id:spaceId}=created.json().data;
  expect(spaceId).toBe(personal);
  expect((await send('POST','/api/v1/actions/session.create',{title:'Notes'},key)).json()).toEqual(created.json());
  expect((await db.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[user])).rows[0].n).toBe(1);
  __setAuthIdentityForTests({spaceId:personal,userId:user});
  expect((await send('POST',`/api/v1/sessions/${sessionId}/messages`,{content:''})).statusCode).toBe(422);
  expect((await send('POST',`/api/v1/sessions/${sessionId}/messages`,{content:'x',role:'assistant'})).statusCode).toBe(422);
  const message=await send('POST',`/api/v1/sessions/${sessionId}/messages`,{content:'Remember I prefer short replies'});
  expect(message.statusCode,message.body).toBe(201);
  expect((await db.pool.query('SELECT role,content FROM messages WHERE id=$1',[message.json().data.message_id])).rows).toEqual([{role:'user',content:'Remember I prefer short replies'}]);
  const reflected=await send('POST',`/api/v1/sessions/${sessionId}/reflect`);
  expect(reflected.statusCode,reflected.body).toBe(200);
  expect(reflected.json().data.proposals_created).toBe(1);
  // The reflection is a private proposal awaiting the person, never an applied Memory.
  expect((await db.pool.query("SELECT proposal_type,status FROM proposals WHERE space_id=$1",[personal])).rows).toEqual([{proposal_type:'memory_create',status:'pending'}]);
  const deleted=await send('DELETE',`/api/v1/sessions/${sessionId}`);
  expect(deleted.statusCode,deleted.body).toBe(200);
  expect((await db.pool.query('SELECT status FROM sessions WHERE id=$1',[sessionId])).rows[0].status).toBe('archived');
  expect((await send('DELETE',`/api/v1/sessions/${sessionId}`)).statusCode).toBe(404);
 });

 it('places Project sessions for writers only and hides another person\'s conversation',async()=>{
  const created=await send('POST','/api/v1/sessions',{project_id:project,title:'Project chat'});
  expect(created.statusCode,created.body).toBe(201);
  expect(created.json().data.space_id).toBe(team);
  const sessionId=created.json().data.session_id;
  __setAuthIdentityForTests({spaceId:team,userId:member});
  expect((await send('POST','/api/v1/sessions',{project_id:project})).statusCode).toBe(404);
  expect((await send('POST',`/api/v1/sessions/${sessionId}/messages`,{content:'Peek'})).statusCode).toBe(404);
  expect((await send('POST',`/api/v1/sessions/${sessionId}/reflect`)).statusCode).toBe(404);
  expect((await send('DELETE',`/api/v1/sessions/${sessionId}`)).statusCode).toBe(404);
  expect((await db.pool.query('SELECT count(*)::int AS n FROM messages WHERE session_id=$1',[sessionId])).rows[0].n).toBe(0);
 });
});
