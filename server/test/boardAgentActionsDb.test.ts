import {randomUUID} from 'node:crypto';
import {beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedRun} from './support/domainSeeds.js';
import {loadConfig} from '../src/config.js';
import {registerProjectWorkSystemActionExecutors} from '../src/modules/projectWork/projectWorkSystemActionExecutors.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
import {getProjectBoard} from '../src/modules/projectWork/boardReadModel.js';
import {SYSTEM_ACTION_REGISTRY} from '@rainver/protocol';
import {ROOM_CONVERSATION_TOOL_ALLOWANCE} from '../src/modules/systemActions/scenarioToolAllowance.js';
const db=useTestDatabase(import.meta.filename);
const space=randomUUID(),owner=randomUUID(),project=randomUUID(),run=randomUUID();
const identity={spaceId:space,userId:owner};
let executors:Map<any,any>;
const call=async(name:string,input:unknown)=>{
 const definition=SYSTEM_ACTION_REGISTRY.find(a=>a.id===name)!;
 expect(ROOM_CONVERSATION_TOOL_ALLOWANCE).toContain(name);
 return (await executors.get(name)(definition.input_schema.parse(input),{idempotency_key:randomUUID()})).modelResult;
};
const config=(board:any)=>({revision:board.columns_revision,columns:board.columns.filter((c:any)=>c.status_key).map(({key,label,status_key,wip_limit}:any)=>({key,label,status_key,wip_limit})),moves:{},reason:'Person requested this Board change'});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query('UPDATE runs SET project_id=$2,instructed_by_user_id=$3 WHERE id=$1',[run,project,owner]);
 const record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 executors=new Map();registerProjectWorkSystemActionExecutors(executors,loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-board-actions'}),record);
});
it('CLI can read/create/rename/reorder/delete columns and create/move Tasks in exact columns',async()=>{
 let board=await call('board.read',{});const body=config(board);
 body.columns.splice(1,0,{key:'new:design',label:'Design',status_key:'in_progress',wip_limit:3});
 board=await call('board.configure',body);
 const design=board.columns.find((c:any)=>c.label==='Design');
 const created=await call('task.create',{title:'Agent placement',board_column:{column_key:design.key,columns_revision:board.columns_revision}});
 const taskId=created.task_id??created.task?.id;
 expect(taskId).toBeTruthy();
 expect((await db.pool.query('SELECT column_id,status FROM tasks WHERE id=$1',[taskId])).rows[0]).toMatchObject({column_id:design.key,status:'in_progress'});
 expect((await call('task.list',{})).tasks.find((t:any)=>t.task_id===taskId).column_key).toBe(design.key);
 const ready=board.columns.find((c:any)=>c.status_key==='ready');
 await call('task.move_to_column',{task_id:taskId,column_key:ready.key,columns_revision:board.columns_revision,reason:'Person moved it'});
 const changed=config(board);changed.columns.reverse();changed.columns=changed.columns.map((c:any)=>c.key===design.key?{...c,label:'Build'}:c);
 board=await call('board.configure',changed);
 expect(board.columns.find((c:any)=>c.key===design.key).label).toBe('Build');
 const deletion=config(board);deletion.columns=deletion.columns.filter((c:any)=>c.key!==design.key);
 await call('board.configure',deletion);
 expect((await getProjectBoard(db.pool,identity,project)).columns.some(c=>c.key===design.key)).toBe(false);
 expect((await db.pool.query("SELECT data_json FROM project_work_events WHERE subject_id=$1 AND event_kind='task.flow_changed' ORDER BY seq DESC LIMIT 1",[taskId])).rows[0].data_json).toMatchObject({run_id:run,reason:'Person moved it'});
 await expect(call('task.move_to_column',{task_id:taskId,column_key:ready.key,columns_revision:body.revision,reason:'Stale selection'})).rejects.toMatchObject({statusCode:409});
});
it('changing an existing meaning migrates Tasks atomically and cannot bypass Done requirements',async()=>{
 const task=await new PgTaskRepository(db.pool).createTask(identity,{project_id:project,title:'Needs report',status:'ready',required_outputs_json:['report'],visibility:'space_shared'});
 let board=await call('board.read',{});let body=config(board);
 body.columns=body.columns.map((c:any)=>c.key==='ready'?{...c,status_key:'done'}:c);
 await expect(call('board.configure',body)).rejects.toMatchObject({statusCode:422});
 expect((await call('board.read',{})).columns_revision).toBe(board.columns_revision);
 body=config(board);body.columns=body.columns.map((c:any)=>c.key==='ready'?{...c,status_key:'in_progress'}:c);
 board=await call('board.configure',body);
 expect((await new PgTaskRepository(db.pool).getTask(identity,task.id))?.status).toBe('in_progress');
 expect(board.columns.find((c:any)=>c.label==='Ready').status_key).toBe('in_progress');
 const done=board.columns.find((c:any)=>c.status_key==='done');
 await expect(call('task.move_to_column',{task_id:task.id,column_key:done.key,columns_revision:board.columns_revision,reason:'Premature close'})).rejects.toMatchObject({statusCode:422});
 await expect(call('task.create',{title:'No precomplete',board_column:{column_key:done.key,columns_revision:board.columns_revision}})).rejects.toMatchObject({statusCode:422});
});

it('rejects Task movement outside the Run Project without changing that Task',async()=>{
 const foreign=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,'Elsewhere','active',$3,now(),now())",[foreign,space,owner]);
 const task=await new PgTaskRepository(db.pool).createTask(identity,{project_id:foreign,title:'Other scope',status:'ready'});
 const board=await call('board.read',{});
 await expect(call('task.move_to_column',{task_id:task.id,column_key:'in_progress',columns_revision:board.columns_revision,reason:'Wrong Project'})).rejects.toMatchObject({statusCode:404});
 expect((await new PgTaskRepository(db.pool).getTask(identity,task.id))?.status).toBe('ready');
});

it('remapping an explicit Blocked column to In progress changes the actual Task state',async()=>{
 const task=await new PgTaskRepository(db.pool).createTask(identity,{project_id:project,title:'Blocked work',status:'ready'});
 let board=await call('board.read',{}),body=config(board);
 body.columns=body.columns.map((c:any)=>c.key==='ready'?{...c,status_key:'blocked'}:c);
 board=await call('board.configure',body);
 expect((await new PgTaskRepository(db.pool).getTask(identity,task.id))?.status).toBe('blocked');
 body=config(board);body.columns=body.columns.map((c:any)=>c.label==='Ready'?{...c,status_key:'in_progress'}:c);
 await call('board.configure',body);
 expect((await new PgTaskRepository(db.pool).getTask(identity,task.id))?.status).toBe('in_progress');
});
