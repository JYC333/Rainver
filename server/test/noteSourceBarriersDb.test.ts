import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import type {PoolClient} from 'pg';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedMainlineRoomsForAllProjects} from './support/domainSeeds.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {PgProjectRepository} from '../src/modules/projects/repository.js';
import {lockProjectAudience} from '../src/modules/projects/access.js';

/**
 * Commit barriers of the Note/Source block, each raced on real PostgreSQL in
 * the order a review found open: the command's unlocked check passes, a
 * canonical writer (membership removal, a Delivery's closure) holds its locks
 * uncommitted, and only then does the command reach its commit. The command
 * must wait on that writer and decide under it, never act on the stale check.
 */
const db=useTestDatabase(import.meta.filename,{max:8});
let space:string,owner:string,member:string,project:string,other:string,app:ReturnType<typeof buildModuleServer>;
const call=(id:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;
const pid=async(client:PoolClient)=>Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);

async function note(input:{project:string|null;owner:string;deletedDaysAgo?:number}){
  const id=randomUUID(),deleted=input.deletedDaysAgo===undefined?null:`now() - interval '${input.deletedDaysAgo} days'`;
  await db.pool.query(`INSERT INTO space_objects(id,space_id,object_type,title,visibility,owner_user_id,primary_project_id,created_by_user_id,created_at,updated_at,deleted_at)
    VALUES($1,$2,'note','Note','space_shared',$3,$4,$3,now()-interval '40 days',now(),${deleted??'NULL'})`,[id,space,input.owner,input.project]);
  await db.pool.query(`INSERT INTO notes(object_id,space_id,content_json,content_format,content_schema_version,plain_text,version,content_hash,status)
    VALUES($1,$2,'{}'::jsonb,'markdown',1,'',1,'seed',$3)`,[id,space,deleted?'deleted':'active']);
  return id;
}
async function joinProject(projectId:string,user:string){
  await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,projectId,user]);
}
/** The canonical membership writer, left uncommitted on `holder`: its Project change lock is held. */
async function removalHeld(holder:PoolClient,projectId:string,user:string){
  await holder.query('BEGIN');
  await new PgProjectRepository(holder).removeMember({spaceId:space,userId:owner},projectId,user);
  return pid(holder);
}

beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
  space=randomUUID();owner=randomUUID();member=randomUUID();project=randomUUID();other=randomUUID();
  const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
  await db.pool.query(`INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,'Other','active',$3,$4,$4)`,[other,space,owner,now]);
  await seedMainlineRoomsForAllProjects(db.pool);
  await seedSpaceMember(db.pool,{space,user:member,role:'member'});
  await joinProject(project,member);await joinProject(other,member);
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[sourcesModule,knowledgeModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:member});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('Note purge: a Project writer removed after the candidate check waits, then the purge deletes nothing and its receipt is no longer released',async()=>{
  const doomed=await note({project,owner:member,deletedDaysAgo:31});
  const holder=await db.pool.connect();let settled=false,open=true;
  try{
    const holderPid=await removalHeld(holder,project,member);
    const key=randomUUID();
    const purging=call('knowledge.note.trash.purge',{},key).finally(()=>{settled=true;});
    // The candidate check reads the still-committed membership and passes; the
    // commit then waits on the removal's Project lock instead of deleting.
    await waitForBlockedBy(db.pool,holderPid,{settled:()=>settled});
    expect(settled).toBe(false);
    await holder.query('COMMIT');open=false;
    const purged=await purging;
    expect(purged.statusCode,purged.body).toBe(200);
    expect(purged.json().data).toMatchObject({deleted:0,project_ids:[]});
    expect(await rows('SELECT id FROM space_objects WHERE id=$1',[doomed])).toHaveLength(1);
  }finally{if(open)await holder.query('ROLLBACK').catch(()=>undefined);holder.release();}
});

it('Note purge receipt carries its batch scope: replay is released only while the caller still writes those Projects, and never deletes the next batch',async()=>{
  const first=await note({project,owner:member,deletedDaysAgo:31});
  const key=randomUUID(),purged=await call('knowledge.note.trash.purge',{},key);
  expect(purged.statusCode,purged.body).toBe(200);expect(purged.json().data).toMatchObject({deleted:1,project_ids:[project]});
  expect(await rows('SELECT id FROM space_objects WHERE id=$1',[first])).toHaveLength(0);
  const next=await note({project:null,owner:member,deletedDaysAgo:31});
  expect((await call('knowledge.note.trash.purge',{},key)).json()).toEqual(purged.json());
  expect(await rows('SELECT id FROM space_objects WHERE id=$1',[next])).toHaveLength(1);
  await new PgProjectRepository(db.pool).removeMember({spaceId:space,userId:owner},project,member);
  expect((await call('knowledge.note.trash.purge',{},key)).statusCode).toBe(404);
  expect(await rows('SELECT id FROM space_objects WHERE id=$1',[next])).toHaveLength(1);
});

it('incoming Note link: removal of the source endpoint\'s Project writer waits ahead of the link, which is then refused with no edge',async()=>{
  const mine=await note({project,owner:member}),source=await note({project:other,owner:member});
  const holder=await db.pool.connect();let settled=false,open=true;
  try{
    const holderPid=await removalHeld(holder,other,member);
    const linking=call('knowledge.note.link.create',{note_id:mine,target_type:'note',target_id:source,direction:'incoming'}).finally(()=>{settled=true;});
    await waitForBlockedBy(db.pool,holderPid,{settled:()=>settled});
    expect(settled).toBe(false);
    await holder.query('COMMIT');open=false;
    const linked=await linking;
    expect([403,404]).toContain(linked.statusCode);
    expect(await rows('SELECT id FROM note_links WHERE space_id=$1',[space])).toEqual([]);
  }finally{if(open)await holder.query('ROLLBACK').catch(()=>undefined);holder.release();}
  // The legitimate incoming link (both endpoints writable) and an outgoing link to a read-only target still work.
  await joinProject(other,member);
  expect((await call('knowledge.note.link.create',{note_id:mine,target_type:'note',target_id:source,direction:'incoming'})).statusCode).toBe(201);
  const readOnly=await note({project:null,owner});
  await db.pool.query("UPDATE space_objects SET visibility='space_shared' WHERE id=$1",[readOnly]);
  expect((await call('knowledge.note.link.create',{note_id:mine,target_type:'note',target_id:readOnly})).statusCode).toBe(201);
});

it('Goal command and briefing Delivery share one closure order: a Delivery holding the Project audience never waits on a Goal the command already holds',async()=>{
  __setAuthIdentityForTests({spaceId:space,userId:owner});
  const goal=randomUUID();
  await db.pool.query(`INSERT INTO source_goals(id,space_id,project_id,owner_user_id,intent_json,budget_json,status,compatibility_json) VALUES($1,$2,$3,$4,'{"intent":"Following"}','{}','running','{}')`,[goal,space,project,owner]);
  const delivery=await db.pool.connect();let settled=false,open=true;
  try{
    await delivery.query('BEGIN');
    // A Delivery's closure order: Project audience (share), then context roots.
    await lockProjectAudience(delivery,space,project);
    const deliveryPid=await pid(delivery);
    const pausing=call('source.goal.pause',{goal_id:goal}).finally(()=>{settled=true;});
    await waitForBlockedBy(db.pool,deliveryPid,{settled:()=>settled});
    expect(settled).toBe(false);
    // The command waits at the Project, before the Goal: the Delivery's Goal
    // share lock is granted at once (a cycle would end one side as 40P01).
    await delivery.query("SET LOCAL lock_timeout='5s'");
    expect((await delivery.query('SELECT id FROM source_goals WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[space,[goal]])).rows).toHaveLength(1);
    await delivery.query('COMMIT');open=false;
    const paused=await pausing;
    expect(paused.statusCode,paused.body).toBe(200);
    expect((await rows('SELECT status FROM source_goals WHERE id=$1',[goal]))[0].status).toBe('paused');
  }finally{if(open)await delivery.query('ROLLBACK').catch(()=>undefined);delivery.release();}
});
