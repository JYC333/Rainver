import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import Fastify from 'fastify';
import type {ModuleContext} from '../src/gateway/routeRegistry.js';
import {registerProjectLiveUpdates,subscribeProjectUpdates} from '../src/modules/projects/liveUpdates.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests,__setAuthRepositoryForTests,type AuthRepository} from '../src/modules/auth/identity.js';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
const db=useTestDatabase(import.meta.filename);
const space=randomUUID(),owner=randomUUID(),viewer=randomUUID(),project=randomUUID(),other=randomUUID();
const stops:Array<()=>Promise<void>>=[];
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['projects','space_memberships','users','spaces'],{cascade:true});
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await seedSpaceMember(db.pool,{space,user:viewer});
 await db.pool.query("INSERT INTO project_members(id,project_id,space_id,user_id,role,status,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,$3,'viewer','active',now(),now())",[project,space,viewer]);
});
afterEach(async()=>{for(const stop of stops.splice(0))await stop();__setAuthIdentityForTests(null);__setAuthRepositoryForTests(null)});
const create=async()=>{const id=randomUUID();await db.pool.query("INSERT INTO tasks(id,space_id,project_id,title,created_at,updated_at) VALUES($1,$2,$3,'Task',now(),now())",[id,space,project]);return id};
it('notifies after commit for new/changed/deleted Tasks, never rollback or another Project; shares LISTEN',async ctx=>{
 if(!db.available)return ctx.skip();
 let changes=0,foreign=0;
 const before=db.pool.totalCount;
 stops.push(await subscribeProjectUpdates(db.pool,{space,project,change:()=>{changes++},disconnected:()=>{}}));
 const count=db.pool.totalCount;
 stops.push(await subscribeProjectUpdates(db.pool,{space,project:other,change:()=>{foreign++},disconnected:()=>{}}));
 expect(db.pool.totalCount).toBe(count);expect(count).toBeLessThanOrEqual(before+1);
 const tx=await db.pool.connect();await tx.query('BEGIN');
 await tx.query("UPDATE projects SET name='Uncommitted' WHERE id=$1",[project]);
 await new Promise(resolve=>setTimeout(resolve,40));expect(changes).toBe(0);
 await tx.query('ROLLBACK');tx.release();
 const task=await create();await expect.poll(()=>changes).toBe(1);
 await db.pool.query("UPDATE tasks SET status='done' WHERE id=$1",[task]);await expect.poll(()=>changes).toBe(2);
 await db.pool.query('DELETE FROM tasks WHERE id=$1',[task]);await expect.poll(()=>changes).toBe(3);expect(foreign).toBe(0);
});
it('streams only content-free scoped invalidations, denies revoked membership and denies foreign Projects before streaming',async ctx=>{
 if(!db.available)return ctx.skip();
 __setAuthIdentityForTests({userId:viewer,spaceId:space,sessionToken:viewer} as never);
 __setAuthRepositoryForTests({getCurrentUser:async()=>({id:viewer,email:'viewer@test.invalid',display_name:'Viewer',avatar_url:null,is_instance_admin:false,created_at:new Date().toISOString(),last_login_at:null})} as unknown as AuthRepository);
 const app=Fastify();registerProjectLiveUpdates(app,{config:loadConfig({SERVER_DATABASE_URL:db.connectionUri})} as ModuleContext);
 const address=await app.listen({host:'127.0.0.1',port:0});const controller=new AbortController();
 try{
  expect((await app.inject({url:`/api/v1/projects/${other}/updates/stream`})).statusCode).toBe(404);
  const response=await fetch(`${address}/api/v1/projects/${project}/updates/stream`,{signal:controller.signal});
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader=response.body!.getReader(),decoder=new TextDecoder();let buffered='';
  const frame=async()=>{while(!buffered.includes('\n\n')){const next=await reader.read();if(next.done)throw new Error('Stream ended');buffered+=decoder.decode(next.value)}const end=buffered.indexOf('\n\n'),value=buffered.slice(0,end);buffered=buffered.slice(end+2);return JSON.parse(value.split('\ndata: ')[1]!)};
  expect(await frame()).toEqual({type:'ready'});
  await create();expect(await frame()).toEqual({type:'changed'});
  await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,viewer]);
  expect(await frame()).toEqual({type:'denied'});await reader.cancel();
 }finally{controller.abort();await app.close()}
});

it('notifies Run status changes but excludes streamed output and heartbeat writes',async ctx=>{
 if(!db.available)return ctx.skip();
 const run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query("UPDATE runs SET project_id=$2,status='running' WHERE id=$1",[run,project]);
 let changes=0;
 stops.push(await subscribeProjectUpdates(db.pool,{space,project,change:()=>{changes++},disconnected:()=>{}}));
 for(let n=0;n<20;n++)await db.pool.query("UPDATE runs SET output_json=$2::jsonb,updated_at=now() WHERE id=$1",[run,JSON.stringify({text:'stream '+n})]);
 await new Promise(resolve=>setTimeout(resolve,40));expect(changes).toBe(0);
 await db.pool.query("UPDATE runs SET status='succeeded',ended_at=now() WHERE id=$1",[run]);
 await expect.poll(()=>changes).toBe(1);
});
it('ends an active stream when the server shuts down instead of holding its LISTEN connection',async ctx=>{
 if(!db.available)return ctx.skip();
 __setAuthIdentityForTests({userId:viewer,spaceId:space,sessionToken:viewer} as never);
 __setAuthRepositoryForTests({getCurrentUser:async()=>({id:viewer,email:'viewer@test.invalid',display_name:'Viewer',avatar_url:null,is_instance_admin:false,created_at:new Date().toISOString(),last_login_at:null})} as unknown as AuthRepository);
 const app=Fastify();registerProjectLiveUpdates(app,{config:loadConfig({SERVER_DATABASE_URL:db.connectionUri})} as ModuleContext);
 const address=await app.listen({host:'127.0.0.1',port:0}),controller=new AbortController();
 try{
  const response=await fetch(`${address}/api/v1/projects/${project}/updates/stream`,{signal:controller.signal}),reader=response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('project.ready');
  await app.close();expect((await reader.read()).done).toBe(true);
 }finally{controller.abort();await app.close()}
});
