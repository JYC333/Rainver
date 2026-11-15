import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedRun,seedSpaceMember,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {tasksModule} from '../src/modules/tasks/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {PgProjectRepository} from '../src/modules/projects/repository.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
import {readProjectColumns} from '../src/modules/tasks/boardColumns.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';

// Group 2 review closure on real PG: terminal placement at create, person
// placement, Board moves/delete replay, and the Task write reference closure
// (ordered locks, parent cycles) against the rows' real writers.
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,agent:string,run:string;
let app:ReturnType<typeof buildModuleServer>,config:ReturnType<typeof loadConfig>;
const as=(userId:string,spaceId=space)=>__setAuthIdentityForTests({spaceId,userId});
const send=(method:'POST'|'PATCH',url:string,payload:object,key:string=randomUUID())=>app.inject({method,url,payload,headers:{'idempotency-key':key}});
const count=async(sql:string,params:unknown[])=>Number((await db.pool.query(sql,params)).rows[0].n);
const repo=()=>new PgTaskRepository(db.pool);
const agentCall=async(name:string,body:object):Promise<any>=>new CliAgentToolTransport(config).call((await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0],{id:randomUUID(),name,arguments:body});
const addProject=async(name:string)=>{const id=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,$3,'active',$4,now(),now())",[id,space,name,owner]);return id;};
const addFolder=async(projectId:string)=>{const id=randomUUID();await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'repo','code','active',false,false,now(),now())",[id,space,projectId]);return id;};
/** A transaction that holds a real writer's uncommitted change until released. */
async function holding(statements:[string,unknown[]][]){
 const client=await db.pool.connect();await client.query('BEGIN');
 for(const [sql,params] of statements)await client.query(sql,params);
 return {release:async()=>{try{await client.query('COMMIT');}finally{client.release();}}};
}

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();agent=randomUUID();run=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 await seedRun(db.pool,{id:run,space,owner,agent,version:randomUUID()});
 await db.pool.query("UPDATE runs SET project_id=$2,instructed_by_user_id=$3,status='running',permission_snapshot_json=$4::jsonb WHERE id=$1",[run,project,owner,JSON.stringify({tool_grants:[{action_id:'task.create'},{action_id:'task.create_batch'}]})]);
 config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
 app=buildModuleServer(config,[tasksModule,projectsModule,systemActionsModule]);
 as(owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

describe('a Task is never created already finished',()=>{
 it('refuses a terminal column on every create path and keeps legal non-terminal placement',async()=>{
  await repo().createBoard({spaceId:space,userId:owner},{name:'Board',project_id:project});
  const board=await readProjectColumns(db.pool,space,project);
  const done=board.columns.find(c=>c.status_key==='done')!,ready=board.columns.find(c=>c.status_key==='ready')!;
  // Raw column ID with the status omitted: the column's own status must not finish the Task.
  const raw=await send('POST','/api/v1/tasks',{project_id:project,title:'Born done',column_id:done.key});
  expect(raw.statusCode,raw.body).toBe(422);
  expect((await send('POST','/api/v1/tasks',{project_id:project,title:'Born done',board_id:done.board_id,column_id:done.key})).statusCode).toBe(422);
  // Agent single and batch tool calls through the shared writer.
  const selection={column_key:done.key,columns_revision:board.revision};
  expect((await agentCall('task.create',{title:'Agent done',board_column:selection})).httpStatus).toBe(422);
  const batch=await agentCall('task.create_batch',{request_summary:'Split',tasks:[{title:'Batch done',board_column:selection}]});
  expect(batch,JSON.stringify(batch)).toMatchObject({ok:false,error:'Create the Task before completing or cancelling it'});
  // Internal producers call the same canonical writer.
  for(const body of [{column_id:done.key},{status:'done'},{status:'cancelled'}])
   await expect(repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Internal',visibility:'space_shared',...body}),JSON.stringify(body)).rejects.toMatchObject({statusCode:422});
  expect(await count('SELECT count(*) AS n FROM tasks WHERE space_id=$1',[space])).toBe(0);
  const placed=await send('POST','/api/v1/tasks',{project_id:project,title:'Ready',column_id:ready.key});
  expect(placed.statusCode,placed.body).toBe(201);
  expect(placed.json().data).toMatchObject({status:'ready',column_id:ready.key});
  const blocked=(await db.pool.query("SELECT id FROM board_columns WHERE board_id=$1 AND status_key='in_progress'",[ready.board_id])).rows[0].id;
  expect((await send('POST','/api/v1/tasks',{project_id:project,title:'Blocked',column_id:blocked,status:'blocked'})).json().data.status).toBe('blocked');
 });
});

describe('person placement of a context-free Task (ADR 0013 decision 3)',()=>{
 it('places a shared-Space request in the Personal Space, replays the receipt under current authority and keeps the cross-Space boundary',async()=>{
  const personal=randomUUID();
  await db.pool.query("INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Personal','personal',$2,now(),now())",[personal,owner]);
  await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,owner]);
  const key=randomUUID(),created=await send('POST','/api/v1/tasks',{title:'Context free'},key);
  expect(created.statusCode,created.body).toBe(201);
  expect(created.json().data).toMatchObject({space_id:personal,project_id:null});
  expect((await db.pool.query('SELECT space_id,visibility,project_id FROM tasks WHERE id=$1',[created.json().data.task_id])).rows[0]).toEqual({space_id:personal,visibility:'private',project_id:null});
  expect((await send('POST','/api/v1/tasks',{title:'Context free'},key)).json()).toEqual(created.json());
  const audit=(await db.pool.query("SELECT DISTINCT space_id FROM policy_decision_records WHERE metadata_json->>'request_space_id'=$1",[space])).rows;
  expect(audit).toEqual([{space_id:personal}]);
  // A Project of another Space is never reached from this request Space.
  const elsewhere=randomUUID(),foreign=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:elsewhere,owner:randomUUID(),project:foreign,spaceType:'household'});
  await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'admin','active',now(),now())",[randomUUID(),elsewhere,owner]);
  expect((await send('POST','/api/v1/tasks',{title:'Cross',project_id:foreign})).statusCode).toBe(404);
  // Replay is authorized against the person's current Personal Space.
  await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2",[personal,owner]);
  expect((await send('POST','/api/v1/tasks',{title:'Context free'},key)).statusCode).toBe(409);
  expect(await count('SELECT count(*) AS n FROM tasks WHERE created_by_user_id=$1',[owner])).toBe(1);
 });
});

describe('Board moves and delete replay',()=>{
 let writer:string,board:string,other:string;
 beforeEach(async()=>{
  writer=randomUUID();await seedSpaceMember(db.pool,{space,user:writer});
  other=await addProject('Other');
  board=(await send('POST','/api/v1/boards',{name:'Moving',project_id:project})).json().data.board_id;
 });
 const grant=(p:string,role='member')=>db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',now(),now())`,[randomUUID(),space,p,writer,role]);
 const revision=async(p:string)=>(await readProjectColumns(db.pool,space,p)).revision;
 it('moves a Board between two Projects with both writers and both current revisions',async()=>{
  await grant(project);await grant(other);as(writer);
  const body=async()=>({project_id:other,columns_revision:await revision(project),target_columns_revision:await revision(other)});
  expect((await send('PATCH',`/api/v1/boards/${board}`,{project_id:other,columns_revision:await revision(project)})).statusCode).toBe(409);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{...await body(),target_columns_revision:'stale'})).statusCode).toBe(409);
  const moved=await send('PATCH',`/api/v1/boards/${board}`,await body());
  expect(moved.statusCode,moved.body).toBe(200);
  expect(moved.json().data).toMatchObject({board_id:board,project_id:other});
 });
 it('refuses a move when either side withdrew the writer, and keeps the Folder inside the Project',async()=>{
  await grant(other);as(writer);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{project_id:other,columns_revision:await revision(project),target_columns_revision:await revision(other)})).statusCode).toBe(404);
  await db.pool.query('DELETE FROM project_members WHERE user_id=$1',[writer]);await grant(project);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{project_id:other,columns_revision:await revision(project),target_columns_revision:await revision(other)})).statusCode).toBe(404);
  as(owner);
  const folder=await addFolder(project);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{project_folder_id:folder})).statusCode).toBe(200);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{project_id:other,columns_revision:await revision(project),target_columns_revision:await revision(other)})).statusCode).toBe(409);
  const cleared=await send('PATCH',`/api/v1/boards/${board}`,{project_id:other,project_folder_id:null,columns_revision:await revision(project),target_columns_revision:await revision(other)});
  expect(cleared.statusCode,cleared.body).toBe(200);
  expect((await db.pool.query('SELECT project_id,project_folder_id FROM boards WHERE id=$1',[board])).rows[0]).toEqual({project_id:other,project_folder_id:null});
 });
 it('refuses a move whose destination columns changed while it waited for the Project lock',async()=>{
  const target=(await send('POST','/api/v1/boards',{name:'Target board',project_id:other})).json().data.board_id;
  const payload={project_id:other,columns_revision:await revision(project),target_columns_revision:await revision(other)};
  const writerTx=await holding([["SELECT id FROM projects WHERE id=$1 FOR UPDATE",[other]],["UPDATE board_columns SET name='Renamed' WHERE board_id=$1 AND status_key='ready'",[target]]]);
  const attempt=send('PATCH',`/api/v1/boards/${board}`,payload);
  try{await waitForLockWaiter(db.pool);}finally{await writerTx.release();}
  expect((await attempt).statusCode).toBe(409);
  expect((await db.pool.query('SELECT project_id FROM boards WHERE id=$1',[board])).rows[0].project_id).toBe(project);
 });
 it('replays a lost delete response with the same key under current authority, and nothing else reaches a deleted Board',async()=>{
  await grant(project);as(writer);
  const key=randomUUID(),body={deleted:true,columns_revision:await revision(project)};
  const first=await send('PATCH',`/api/v1/boards/${board}`,body,key);
  expect(first.statusCode,first.body).toBe(200);
  const replay=await send('PATCH',`/api/v1/boards/${board}`,body,key);
  expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual(first.json());
  expect((await send('PATCH',`/api/v1/boards/${board}`,{...body,name:'Changed'},key)).statusCode).toBe(422);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{deleted:true,columns_revision:await revision(project)})).statusCode).toBe(404);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{name:'Rename'})).statusCode).toBe(404);
  await db.pool.query('DELETE FROM project_members WHERE user_id=$1',[writer]);
  expect((await send('PATCH',`/api/v1/boards/${board}`,body,key)).statusCode).toBe(404);
 });
});

describe('Task reference closure',()=>{
 const standalone=async(title:string,extra:Record<string,unknown>={})=>(await repo().createTask({spaceId:space,userId:owner},{title,visibility:'private',...extra})).id;
 it('serializes crossing reparents of standalone Tasks and refuses the one that would close a loop',async()=>{
  const root=await standalone('Root'),a=await standalone('A',{task_role:'subtask',parent_task_id:root}),b=await standalone('B',{task_role:'subtask',parent_task_id:root});
  const gate=await holding([['SELECT id FROM tasks WHERE id = ANY($1) FOR UPDATE',[[a,b]]]]);
  const one=send('PATCH',`/api/v1/tasks/${a}`,{parent_task_id:b}),two=send('PATCH',`/api/v1/tasks/${b}`,{parent_task_id:a});
  try{await waitForLockWaiter(db.pool,{waiters:2});}finally{await gate.release();}
  const statuses=(await Promise.all([one,two])).map(r=>r.statusCode).sort();
  expect(statuses).toEqual([200,422]);
  const parents=(await db.pool.query('SELECT id,parent_task_id FROM tasks WHERE id = ANY($1)',[[a,b]])).rows;
  expect(parents.filter(r=>r.parent_task_id===root)).toHaveLength(1);
 });
 it('locks the whole ancestry, so two reparents that share no endpoint cannot close a longer loop',async()=>{
  const root=await standalone('Root');
  const a=await standalone('A',{task_role:'subtask',parent_task_id:root}),c=await standalone('C',{task_role:'subtask',parent_task_id:root});
  const b=await standalone('B',{task_role:'subtask',parent_task_id:c}),d=await standalone('D',{task_role:'subtask',parent_task_id:a});
  const gate=await holding([['SELECT id FROM tasks WHERE id = ANY($1) FOR UPDATE',[[a,b,c,d,root]]]]);
  const one=send('PATCH',`/api/v1/tasks/${a}`,{parent_task_id:b}),two=send('PATCH',`/api/v1/tasks/${c}`,{parent_task_id:d});
  try{await waitForLockWaiter(db.pool,{waiters:2});}finally{await gate.release();}
  expect((await Promise.all([one,two])).map(r=>r.statusCode).sort()).toEqual([200,422]);
  // Sequentially, too: a Task cannot move under its own descendant, nor itself.
  expect((await send('PATCH',`/api/v1/tasks/${root}`,{parent_task_id:d})).statusCode).toBe(422);
  expect((await send('PATCH',`/api/v1/tasks/${a}`,{parent_task_id:a})).statusCode).toBe(422);
 });
 it('holds an assigned Agent, assignee and Folder live until commit against their real writers',async()=>{
  const parent=(await repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Parent',visibility:'space_shared'})).id;
  const assignee=randomUUID();await seedSpaceMember(db.pool,{space,user:assignee});
  const folder=await addFolder(project);
  const cases:[string,[string,unknown[]],Record<string,unknown>][]=[
   ['Agent deactivated',["UPDATE agents SET status='inactive',updated_at=now() WHERE space_id=$1 AND id=$2",[space,agent]],{assigned_agent_id:agent}],
   ['account disabled',["UPDATE users SET status='disabled',updated_at=now() WHERE id=$1 AND status IN ('active','disabled')",[assignee]],{assigned_user_id:assignee}],
   ['Folder archived',["UPDATE project_folders SET status='archived',updated_at=now() WHERE id=$1 AND space_id=$2 AND project_id=$3",[folder,space,project]],{project_folder_id:folder}],
  ];
  for(const [label,write,ref] of cases){
   // The writer commits while the create waits on it (or, before the fix, waits on the parent after its unlocked check).
   const writerTx=await holding([write,['SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[parent]]]);
   const attempt=send('POST','/api/v1/tasks',{project_id:project,title:label,task_role:'subtask',parent_task_id:parent,...ref});
   try{await waitForLockWaiter(db.pool);}finally{await writerTx.release();}
   const response=await attempt;
   expect(response.statusCode,`${label}: ${response.body}`).toBe(404);
  }
  expect(await count('SELECT count(*) AS n FROM tasks WHERE parent_task_id=$1',[parent])).toBe(0);
 });
 it('refuses an edit that assigns an Agent deactivated before the edit commits',async()=>{
  const parent=(await repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Parent',visibility:'space_shared'})).id;
  const task=(await repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Child',visibility:'space_shared',task_role:'subtask',parent_task_id:parent})).id;
  const other=(await repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Other parent',visibility:'space_shared'})).id;
  const writerTx=await holding([["UPDATE agents SET status='inactive',updated_at=now() WHERE space_id=$1 AND id=$2",[space,agent]],['SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[other]]]);
  const attempt=send('PATCH',`/api/v1/tasks/${task}`,{assigned_agent_id:agent,parent_task_id:other});
  try{await waitForLockWaiter(db.pool);}finally{await writerTx.release();}
  expect((await attempt).statusCode).toBe(404);
  expect((await db.pool.query('SELECT assigned_agent_id,parent_task_id FROM tasks WHERE id=$1',[task])).rows[0]).toEqual({assigned_agent_id:null,parent_task_id:parent});
 });
});

describe('one Task write closure for every entry',()=>{
 let writer:string,other:string,qAgent:string;
 const member=(p:string,user:string)=>db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,p,user]);
 const place=(task:string,changes:object)=>send('POST',`/api/v1/tasks/${task}/space-board-placement`,{changes});
 const removeMember=(p:string,user:string)=>app.inject({method:'POST',url:'/api/v1/actions/project.member.remove',payload:{project_id:p,user_id:user},headers:{'idempotency-key':randomUUID()}});
 /** The real project.member.remove repository writer, held uncommitted. */
 async function removing(p:string,user:string){
  const client=await db.pool.connect();await client.query('BEGIN');
  await new PgProjectRepository(client).removeMember({spaceId:space,userId:owner},p,user);
  return {release:async()=>{try{await client.query('COMMIT');}finally{client.release();}}};
 }
 beforeEach(async()=>{
  writer=randomUUID();await seedSpaceMember(db.pool,{space,user:writer});
  other=await addProject('Q');await member(project,writer);await member(other,writer);
  // An Agent of Project Q: the writer reads it only through their Q membership.
  qAgent=randomUUID();
  await db.pool.query("INSERT INTO agents(id,space_id,owner_user_id,name,status,visibility,project_id,created_at,updated_at) VALUES($1,$2,$3,'Q Agent','active','space_shared',$4,now(),now())",[qAgent,space,owner,other]);
 });
 const standalone=async(title:string,extra:Record<string,unknown>={})=>(await repo().createTask({spaceId:space,userId:owner},{title,visibility:'private',...extra})).id;

 it('refuses a loop closed through PATCH and Space placement, serially and concurrently',async()=>{
  const root=await standalone('Root');
  const a=await standalone('A',{task_role:'subtask',parent_task_id:root}),b=await standalone('B',{task_role:'subtask',parent_task_id:root});
  expect((await send('PATCH',`/api/v1/tasks/${a}`,{parent_task_id:b})).statusCode).toBe(200);
  const loop=await place(b,{board_id:null,parent_task_id:a});
  expect(loop.statusCode,loop.body).toBe(422);
  expect((await db.pool.query('SELECT parent_task_id FROM tasks WHERE id=$1',[b])).rows[0].parent_task_id).toBe(root);
  // Crossing writers through the two entries: one wins, the other sees it.
  const c=await standalone('C',{task_role:'subtask',parent_task_id:root}),d=await standalone('D',{task_role:'subtask',parent_task_id:root});
  const gate=await holding([['SELECT id FROM tasks WHERE id = ANY($1) FOR UPDATE',[[c,d]]]]);
  const one=send('PATCH',`/api/v1/tasks/${c}`,{parent_task_id:d}),two=place(d,{board_id:null,parent_task_id:c});
  try{await waitForLockWaiter(db.pool,{waiters:2});}finally{await gate.release();}
  expect((await Promise.all([one,two])).map(r=>r.statusCode).sort()).toEqual([200,422]);
 });
 it('refuses a Space placement that assigns a deactivated Agent or a Folder, and keeps legal accompanying fields',async()=>{
  const task=await standalone('Standalone');
  await db.pool.query("UPDATE agents SET status='inactive' WHERE id=$1",[agent]);
  expect((await place(task,{board_id:null,assigned_agent_id:agent})).statusCode).toBe(404);
  expect((await place(task,{board_id:null,project_folder_id:await addFolder(project)})).statusCode).toBe(422);
  expect((await db.pool.query('SELECT assigned_agent_id,project_folder_id FROM tasks WHERE id=$1',[task])).rows[0]).toEqual({assigned_agent_id:null,project_folder_id:null});
  await db.pool.query("UPDATE agents SET status='active' WHERE id=$1",[agent]);
  const placed=await place(task,{board_id:null,assigned_agent_id:agent,title:'Renamed'});
  expect(placed.statusCode,placed.body).toBe(200);
  expect((await db.pool.query('SELECT assigned_agent_id,title FROM tasks WHERE id=$1',[task])).rows[0]).toEqual({assigned_agent_id:agent,title:'Renamed'});
 });
 it('holds the Project a cross-Project Agent is read through against the real membership writer, both ways',async()=>{
  as(writer);
  const ok=await send('POST','/api/v1/tasks',{project_id:project,title:'Legal cross-Project assignment',assigned_agent_id:qAgent});
  expect(ok.statusCode,ok.body).toBe(201);
  // The create holds Q first: the removal waits for it and commits after.
  const parent=(await repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Parent',visibility:'space_shared'})).id;
  const gate=await holding([['SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[parent]]]);
  const create=send('POST','/api/v1/tasks',{project_id:project,title:'Waits on parent',task_role:'subtask',parent_task_id:parent,assigned_agent_id:qAgent});
  let removal:ReturnType<typeof removeMember>|undefined;
  try{
   await waitForLockWaiter(db.pool);
   as(owner);removal=removeMember(other,writer);
   await waitForLockWaiter(db.pool,{waiters:2});
  }finally{await gate.release();}
  expect((await create).statusCode).toBe(201);
  expect((await removal!).statusCode).toBe(200);
  expect(await count('SELECT count(*) AS n FROM project_members WHERE project_id=$1 AND user_id=$2',[other,writer])).toBe(0);
  // The removal holds Q first: the create waits for it and is refused.
  await member(other,writer);as(writer);
  const held=await removing(other,writer);
  const late=send('POST','/api/v1/tasks',{project_id:project,title:'After removal',assigned_agent_id:qAgent});
  try{await waitForLockWaiter(db.pool);}finally{await held.release();}
  expect((await late).statusCode).toBe(404);
  expect(await count("SELECT count(*) AS n FROM tasks WHERE title='After removal'",[])).toBe(0);
 });
 it('holds the Project a cross-Project parent Task is read through, and keeps the legal cross-Project parent',async()=>{
  const parent=(await repo().createTask({spaceId:space,userId:owner},{project_id:other,title:'Q parent',visibility:'space_shared'})).id;
  as(writer);
  const ok=await send('POST','/api/v1/tasks',{project_id:project,title:'Child in P',task_role:'subtask',parent_task_id:parent});
  expect(ok.statusCode,ok.body).toBe(201);
  const child=ok.json().data.task_id;
  const held=await removing(other,writer);
  const edit=send('PATCH',`/api/v1/tasks/${child}`,{parent_task_id:parent,title:'Edited'});
  try{await waitForLockWaiter(db.pool);}finally{await held.release();}
  expect((await edit).statusCode).toBe(404);
  expect((await db.pool.query('SELECT title FROM tasks WHERE id=$1',[child])).rows[0].title).toBe('Child in P');
 });
 it('never moves a Task to another Project with a Folder of the old one, on every writer entry',async()=>{
  const fp=await addFolder(project),fq=await addFolder(other);
  const task=(await repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Placed',visibility:'space_shared',project_folder_id:fp})).id;
  as(writer);
  const kept=await send('PATCH',`/api/v1/tasks/${task}`,{project_id:other});
  expect(kept.statusCode,kept.body).toBe(409);
  expect((await send('PATCH',`/api/v1/tasks/${task}`,{project_id:other,project_folder_id:fp})).statusCode).toBe(404);
  expect((await db.pool.query('SELECT project_id,project_folder_id FROM tasks WHERE id=$1',[task])).rows[0]).toEqual({project_id:project,project_folder_id:fp});
  const cleared=await send('PATCH',`/api/v1/tasks/${task}`,{project_id:other,project_folder_id:null});
  expect(cleared.statusCode,cleared.body).toBe(200);
  expect((await db.pool.query('SELECT project_id,project_folder_id FROM tasks WHERE id=$1',[task])).rows[0]).toEqual({project_id:other,project_folder_id:null});
  // Back to P with that Project's Folder, while a real archive of it is uncommitted: it waits and is refused.
  const archive=await holding([["UPDATE project_folders SET status='archived',updated_at=now() WHERE id=$1 AND space_id=$2 AND project_id=$3",[fp,space,project]]]);
  const back=send('PATCH',`/api/v1/tasks/${task}`,{project_id:project,project_folder_id:fp});
  try{await waitForLockWaiter(db.pool);}finally{await archive.release();}
  expect((await back).statusCode).toBe(404);
  const moved=await send('PATCH',`/api/v1/tasks/${task}`,{project_id:project,project_folder_id:fq});
  expect(moved.statusCode).toBe(404);
  // Internal producers use the same canonical writer.
  await expect(repo().updateTask({spaceId:space,userId:owner},task,{project_id:project,project_folder_id:fq})).rejects.toMatchObject({statusCode:404});
  await repo().updateTask({spaceId:space,userId:owner},task,{project_folder_id:fq});
  await expect(repo().updateTask({spaceId:space,userId:owner},task,{project_id:project})).rejects.toMatchObject({statusCode:409});
 });
 it('holds an Agent handoff recipient until the handoff commits',async()=>{
  await db.pool.query("UPDATE runs SET permission_snapshot_json=$2::jsonb WHERE id=$1",[run,JSON.stringify({tool_grants:[{action_id:'task.handoff'}]})]);
  const task=(await repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Hand me',visibility:'space_shared'})).id;
  const recipient=randomUUID();
  await db.pool.query("INSERT INTO agents(id,space_id,owner_user_id,name,status,visibility,created_at,updated_at) VALUES($1,$2,$3,'Recipient','active','space_shared',now(),now())",[recipient,space,owner]);
  const disable=await holding([["UPDATE agents SET status='inactive',updated_at=now() WHERE space_id=$1 AND id=$2",[space,recipient]]]);
  const handoff=agentCall('task.handoff',{task_id:task,to:{kind:'agent',id:recipient}});
  try{await waitForLockWaiter(db.pool);}finally{await disable.release();}
  const result=await handoff;
  expect(result.body.ok,JSON.stringify(result)).toBe(false);
  expect((await db.pool.query('SELECT claimed_by_agent_id FROM tasks WHERE id=$1',[task])).rows[0].claimed_by_agent_id).toBeNull();
 });
 it('hands a Task only to an active account, against the real account-disable writer, both ways',async()=>{
  await db.pool.query("UPDATE runs SET permission_snapshot_json=$2::jsonb WHERE id=$1",[run,JSON.stringify({tool_grants:[{action_id:'task.handoff'}]})]);
  // The auth admin disable route's own statement: it keeps Space and Project membership.
  const DISABLE="UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1 AND status IN ('active', 'disabled')";
  const setup=async()=>{
   const task=(await repo().createTask({spaceId:space,userId:owner},{project_id:project,title:'Hand me',visibility:'space_shared'})).id;
   const person=randomUUID();await seedSpaceMember(db.pool,{space,user:person});
   await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,person]);
   return {task,person};
  };
  const state=async(task:string)=>({claimed:(await db.pool.query('SELECT claimed_by_user_id FROM tasks WHERE id=$1',[task])).rows[0].claimed_by_user_id,
   events:await count("SELECT count(*) n FROM project_work_events WHERE subject_id=$1 AND event_kind='task.responsibility_changed'",[task])});
  // A disable that commits while the handoff waits on the account: refused, nothing written.
  const first=await setup();
  const disable=await holding([[DISABLE,[first.person]]]);
  const refused=agentCall('task.handoff',{task_id:first.task,to:{kind:'user',id:first.person}});
  try{await waitForLockWaiter(db.pool);}finally{await disable.release();}
  const no=await refused;
  expect(no.body.ok,JSON.stringify(no)).toBe(false);
  expect(JSON.stringify(no.body)).toContain('operation_invalid_input');
  expect(await state(first.task)).toEqual({claimed:null,events:0});
  // A handoff that holds the active account first: the disable waits for it to commit.
  const second=await setup();
  const gate=await holding([['SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[second.task]]]);
  const handed=agentCall('task.handoff',{task_id:second.task,to:{kind:'user',id:second.person}});
  let disabled=false,later:Promise<void>=Promise.resolve();
  try{
   await waitForLockWaiter(db.pool); // the handoff, holding the account, waits on the gated Task row
   later=db.pool.query(DISABLE,[second.person]).then(()=>{disabled=true;});
   await waitForLockWaiter(db.pool,{waiters:2}); // the disable waits on the handoff's hold
   expect(disabled).toBe(false);
  }finally{await gate.release();}
  const yes=await handed;await later;
  expect(yes.body.ok,JSON.stringify(yes)).toBe(true);
  expect(await state(second.task)).toEqual({claimed:second.person,events:1});
  expect((await db.pool.query('SELECT status FROM users WHERE id=$1',[second.person])).rows[0].status).toBe('disabled');
 });
});
