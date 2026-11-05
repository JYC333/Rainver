import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {deleteTask} from '../src/modules/tasks/deleteTask.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
import {tasksModule} from '../src/modules/tasks/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {resolveUserActorId} from '../src/db/actorResolver.js';
import {registerProjectWorkSystemActionExecutors} from '../src/modules/projectWork/projectWorkSystemActionExecutors.js';
import {SYSTEM_ACTION_REGISTRY} from '@rainver/protocol';
import {ROOM_CONVERSATION_TOOL_ALLOWANCE} from '../src/modules/systemActions/scenarioToolAllowance.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,task:string,app:FastifyInstance|undefined;
const identity=()=>({spaceId:space,userId:owner});
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-task-delete'});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 task=String((await new PgTaskRepository(db.pool).createTask(identity(),{project_id:project,title:'Delete me',visibility:'space_shared'})).id);
 __setAuthIdentityForTests(identity());
});
afterEach(async()=>{if(app){await app.close();app=undefined;}__setAuthIdentityForTests(null);});
it('HTTP deletes without completing, retains audit and is safely repeatable',async()=>{
 app=await buildModuleServer(config(),[tasksModule]);
 const results=await Promise.all([app.inject({method:'DELETE',url:`/api/v1/tasks/${task}`}),app.inject({method:'DELETE',url:`/api/v1/tasks/${task}`})]);
 expect(results.map(r=>r.statusCode)).toEqual([200,200]);
 expect((await app.inject({method:'GET',url:`/api/v1/tasks/${task}`})).statusCode).toBe(404);
 const row=(await db.pool.query('SELECT status,deleted_at FROM tasks WHERE id=$1',[task])).rows[0];
 expect(row.status).toBe('inbox');expect(row.deleted_at).toBeTruthy();
 expect((await db.pool.query("SELECT * FROM project_work_events WHERE subject_id=$1 AND event_kind='task.deleted'",[task])).rows).toHaveLength(1);
 expect((await new PgTaskRepository(db.pool).listTasks(identity(),{projectId:project,boardId:null,projectFolderId:null,status:null,assignedToMe:false,q:null,limit:50,offset:0})).items).toEqual([]);
});
it('denies viewers, foreign scopes and summary-only content',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);
 await expect(deleteTask(db.pool,{spaceId:space,userId:peer},task)).rejects.toMatchObject({statusCode:403});
 await db.pool.query("UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",[project,peer]);
 await db.pool.query("UPDATE tasks SET access_level='summary' WHERE id=$1",[task]);
 await expect(deleteTask(db.pool,{spaceId:space,userId:peer},task)).rejects.toMatchObject({statusCode:404});
 await expect(deleteTask(db.pool,{spaceId:randomUUID(),userId:owner},task)).rejects.toMatchObject({statusCode:404});
 await expect(deleteTask(db.pool,identity(),task,{actorId:await resolveUserActorId(db.pool,space,owner),runId:randomUUID(),projectId:randomUUID(),reason:'Wrong project'})).rejects.toMatchObject({statusCode:404});
 expect((await new PgTaskRepository(db.pool).getTask(identity(),task))).toBeTruthy();
});
it('refuses unfinished execution and keeps its records when a terminal Task is deleted',async()=>{
 const run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query("UPDATE runs SET status='queued' WHERE id=$1",[run]);
 await db.pool.query("INSERT INTO task_runs(id,space_id,task_id,run_id,role,created_at) VALUES($1,$2,$3,$4,'primary',now())",[randomUUID(),space,task,run]);
 await expect(deleteTask(db.pool,identity(),task)).rejects.toMatchObject({statusCode:409});
 expect((await new PgTaskRepository(db.pool).getTask(identity(),task))).toBeTruthy();
 await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run]);
 await deleteTask(db.pool,identity(),task);
 expect((await db.pool.query('SELECT run_id FROM task_runs WHERE task_id=$1',[task])).rows[0].run_id).toBe(run);
});
it('makes event failures atomic with soft deletion',async()=>{
 await db.pool.query("CREATE FUNCTION reject_delete_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_kind='task.deleted' THEN RAISE EXCEPTION 'delete event rejected'; END IF; RETURN NEW; END $$");
 await db.pool.query('CREATE TRIGGER reject_delete_event BEFORE INSERT ON project_work_events FOR EACH ROW EXECUTE FUNCTION reject_delete_event()');
 try{await expect(deleteTask(db.pool,identity(),task)).rejects.toThrow('delete event rejected');expect(await new PgTaskRepository(db.pool).getTask(identity(),task)).toBeTruthy();}
 finally{await db.pool.query('DROP TRIGGER reject_delete_event ON project_work_events');await db.pool.query('DROP FUNCTION reject_delete_event()');}
});
it('exposes the CLI action and its real executor with Run provenance',async()=>{
 const run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query('UPDATE runs SET project_id=$2,instructed_by_user_id=$3 WHERE id=$1',[run,project,owner]);
 const record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 const executors=new Map();registerProjectWorkSystemActionExecutors(executors,config(),record);
 const def=SYSTEM_ACTION_REGISTRY.find(a=>a.id==='task.delete')!;
 expect(def.input_schema.safeParse({task_id:task,reason:'User removed duplicate'}).success).toBe(true);
 expect(ROOM_CONVERSATION_TOOL_ALLOWANCE).toContain('task.delete');
 const result=await executors.get('task.delete')({task_id:task,reason:'User removed duplicate'},{idempotency_key:'delete-1'});
 expect(result.modelResult).toMatchObject({ok:true,task_id:task,deleted:true});
 expect((await db.pool.query("SELECT data_json FROM project_work_events WHERE subject_id=$1 AND event_kind='task.deleted'",[task])).rows[0].data_json).toMatchObject({run_id:run,reason:'User removed duplicate'});
});

it('deletes a standalone Task and refuses a source Task with an active Plan',async()=>{
 const standalone=await new PgTaskRepository(db.pool).createTask(identity(),{title:'Standalone'});
 expect(await deleteTask(db.pool,identity(),String(standalone.id))).toMatchObject({deleted:true});
 await db.pool.query("INSERT INTO plans(id,space_id,project_id,source_task_id,name,status,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'Execution','active',$5,now(),now())",[randomUUID(),space,project,task,owner]);
 await expect(deleteTask(db.pool,identity(),task)).rejects.toMatchObject({statusCode:409});
 expect(await new PgTaskRepository(db.pool).getTask(identity(),task)).toBeTruthy();
});
