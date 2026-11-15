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
import {plansModule} from '../src/modules/plans/index.js';
import {jobsModule} from '../src/modules/jobs/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
import {PgPlanRepository} from '../src/modules/plans/repository.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {readProjectColumns} from '../src/modules/tasks/boardColumns.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {runActor} from '../src/modules/systemActions/operations/actor.js';

// Group 2: Task create/update/evaluation/planning/Run, Board create/update,
// Plan execute/reconcile and generic Job cancel through the core, on real PG.
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,viewer:string,agent:string,run:string,record:any;
let app:ReturnType<typeof buildModuleServer>,config:ReturnType<typeof loadConfig>;
const as=(userId:string,spaceId=space)=>__setAuthIdentityForTests({spaceId,userId});
const send=(method:'POST'|'PATCH',url:string,payload:object,key:string|null=randomUUID())=>app.inject({method,url,payload,headers:key?{'idempotency-key':key}:{}});
const count=async(sql:string,params:unknown[])=>Number((await db.pool.query(sql,params)).rows[0].n);
const projectTask=async(extra:Record<string,unknown>={})=>new PgTaskRepository(db.pool).createTask({spaceId:space,userId:owner},{project_id:project,title:'Contract',visibility:'space_shared',...extra});
const agentCall=async(name:string,body:object,key=randomUUID()):Promise<any>=>new CliAgentToolTransport(config).call((await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0],{id:key,name,arguments:body});

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();viewer=randomUUID();agent=randomUUID();run=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 await seedSpaceMember(db.pool,{space,user:viewer});
 await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())`,[randomUUID(),space,project,viewer]);
 await seedRun(db.pool,{id:run,space,owner,agent,version:randomUUID()});
 await db.pool.query("UPDATE runs SET project_id=$2,instructed_by_user_id=$3,status='running',permission_snapshot_json=$4::jsonb WHERE id=$1",[run,project,owner,JSON.stringify({tool_grants:[{action_id:'task.create'}]})]);
 record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
 app=buildModuleServer(config,[tasksModule,plansModule,jobsModule,systemActionsModule]);
 as(owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

describe('task.create',()=>{
 it('creates a shared Project Task with one key, replays it, and refuses reuse, missing keys and server-owned fields',async()=>{
  expect((await send('POST','/api/v1/tasks',{project_id:project,title:'No key'},null)).json().error.code).toBe('idempotency_key_required');
  const key=randomUUID(),body={project_id:project,title:'Draft chapter',task_type:'writing',priority:'high',tags:['thesis'],max_runs:2};
  const first=await send('POST','/api/v1/tasks',body,key);
  expect(first.statusCode,first.body).toBe(201);
  const created=first.json().data;
  expect(created).toMatchObject({space_id:space,project_id:project,title:'Draft chapter',status:'inbox'});
  expect((await db.pool.query('SELECT visibility,owner_user_id,max_runs,source_run_id FROM tasks WHERE id=$1',[created.task_id])).rows[0]).toEqual({visibility:'space_shared',owner_user_id:owner,max_runs:2,source_run_id:null});
  expect((await send('POST','/api/v1/tasks',body,key)).json()).toEqual(first.json());
  expect((await send('POST','/api/v1/tasks',{...body,title:'Changed'},key)).json().error.code).toBe('idempotency_key_reused');
  expect(await count("SELECT count(*) AS n FROM tasks WHERE space_id=$1",[space])).toBe(1);
  expect(await count("SELECT count(*) AS n FROM project_work_events WHERE subject_id=$1 AND event_kind='task.created'",[created.task_id])).toBe(1);
  for(const extra of [{source_run_id:run},{visibility:'private'},{status:'done'},{status:'cancelled'},{source_proposal_id:randomUUID()}]){
   const refused=await send('POST','/api/v1/tasks',{project_id:project,title:'Refused',...extra});
   expect(refused.statusCode,JSON.stringify(extra)).toBe(422);
  }
  expect(await count("SELECT count(*) AS n FROM tasks WHERE space_id=$1",[space])).toBe(1);
 });
 it('hides a Project from a viewer and references outside the caller\'s reach, writing nothing',async()=>{
  as(viewer);
  expect((await send('POST','/api/v1/tasks',{project_id:project,title:'Viewer'})).statusCode).toBe(404);
  as(owner);
  const elsewhere=randomUUID(),foreignAgent=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:elsewhere,owner:randomUUID(),project:randomUUID(),spaceType:'household'});
  await db.pool.query("INSERT INTO agents(id,space_id,name,status,created_at,updated_at,visibility) VALUES($1,$2,'Elsewhere','active',now(),now(),'space_shared')",[foreignAgent,elsewhere]);
  const standaloneBoard=(await new PgTaskRepository(db.pool).createBoard({spaceId:space,userId:owner},{name:'Space board'})).id;
  for(const ref of [{assigned_agent_id:foreignAgent},{assigned_user_id:randomUUID()},{parent_task_id:randomUUID()},{board_id:standaloneBoard}]){
   const refused=await send('POST','/api/v1/tasks',{project_id:project,title:'Bad reference',...ref});
   expect(refused.statusCode,JSON.stringify(ref)).toBe(404);
  }
  expect(await count("SELECT count(*) AS n FROM tasks WHERE space_id=$1",[space])).toBe(0);
 });
 it('keeps context-free creation private in the Personal Space (shared-Space placement: taskBoardClosureDb)',async()=>{
  const personal=randomUUID();
  await db.pool.query("INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Personal','personal',$2,now(),now())",[personal,owner]);
  await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,owner]);
  as(owner,personal);
  const created=await send('POST','/api/v1/tasks',{title:'Context free'});
  expect(created.statusCode,created.body).toBe(201);
  expect((await db.pool.query('SELECT space_id,visibility,project_id FROM tasks WHERE id=$1',[created.json().data.task_id])).rows[0]).toEqual({space_id:personal,visibility:'private',project_id:null});
 });
 it('serves the Agent tool through the same core with Run provenance, bounded fields, replay and current grants',async()=>{
  const human=await agentCall('task.create',{title:'Agent split',task_type:'coding'});
  expect(human.httpStatus).toBe(422);
  const key=randomUUID(),first=await agentCall('task.create',{title:'Agent split',priority:'high',required_outputs:['report']},key);
  expect(first.httpStatus,JSON.stringify(first.body)).toBe(201);
  const id=first.body.data.task_id;
  expect((await db.pool.query('SELECT source_run_id,visibility,project_id,required_outputs_json FROM tasks WHERE id=$1',[id])).rows[0]).toEqual({source_run_id:run,visibility:'space_shared',project_id:project,required_outputs_json:['report']});
  const event=(await db.pool.query("SELECT a.agent_id FROM project_work_events e JOIN actors a ON a.id=e.actor_id WHERE e.subject_id=$1 AND e.event_kind='task.created'",[id])).rows[0];
  expect(event.agent_id).toBe(agent);
  const engine=await operationRuntime(config),actor=await runActor(db.pool,record);
  const replay=await engine.execute('task.create',{title:'Agent split',priority:'high',required_outputs:['report']},actor,randomUUID(),key);
  expect(replay.replayed).toBe(true);expect((replay.body as any).data).toEqual(first.body.data);
  expect(await count("SELECT count(*) AS n FROM tasks WHERE source_run_id=$1",[run])).toBe(1);
  await db.pool.query("UPDATE runs SET permission_snapshot_json='{}' WHERE id=$1",[run]);
  expect((await engine.execute('task.create',{title:'Agent split',priority:'high',required_outputs:['report']},actor,randomUUID(),key)).http_status).toBe(403);
 });
});

describe('task.update',()=>{
 it('edits contract fields under current Project writer authority and refuses lifecycle and placement fields',async()=>{
  const task=await projectTask();
  const key=randomUUID(),edited=await send('PATCH',`/api/v1/tasks/${task.id}`,{title:'Renamed',description:null,max_runs:null},key);
  expect(edited.statusCode,edited.body).toBe(200);
  expect(edited.json().data).toEqual({task_id:task.id,project_id:project,status:'inbox',title:'Renamed',description:null});
  expect((await db.pool.query('SELECT title,description,max_runs FROM tasks WHERE id=$1',[task.id])).rows[0]).toEqual({title:'Renamed',description:null,max_runs:null});
  for(const field of [{status:'done'},{board_id:null},{column_id:null},{deleted_at:new Date().toISOString()},{blocked_reason:'x'},{completed_at:null},{task_id:randomUUID()}])
   expect((await send('PATCH',`/api/v1/tasks/${task.id}`,field)).statusCode,JSON.stringify(field)).toBe(422);
  as(viewer);
  expect((await send('PATCH',`/api/v1/tasks/${task.id}`,{title:'Viewer edit'})).statusCode).toBe(404);
  // A revoked writer cannot replay a committed edit.
  as(owner);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  await db.pool.query("UPDATE projects SET owner_user_id=$2 WHERE id=$1",[project,viewer]);
  expect((await send('PATCH',`/api/v1/tasks/${task.id}`,{title:'Renamed',description:null,max_runs:null},key)).statusCode).toBe(404);
  expect((await db.pool.query('SELECT title FROM tasks WHERE id=$1',[task.id])).rows[0].title).toBe('Renamed');
 });
 it('serializes with archive: an edit waiting on the Project lock fails once the Project is archived',async()=>{
  const task=await projectTask();
  const lock=await db.pool.connect();await lock.query('BEGIN');
  await lock.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
  const attempt=send('PATCH',`/api/v1/tasks/${task.id}`,{title:'Late edit'});
  try{await waitForLockWaiter(db.pool);}finally{await lock.query('COMMIT');lock.release();}
  const response=await attempt;expect(response.statusCode,response.body).toBe(409);
  expect((await db.pool.query('SELECT title FROM tasks WHERE id=$1',[task.id])).rows[0].title).toBe('Contract');
 });
});

describe('Task evaluation, planning and Run commands',()=>{
 it('records an evaluation only with linked readable evidence and a known recommendation',async()=>{
  const task=await projectTask();
  expect((await send('POST',`/api/v1/tasks/${task.id}/evaluations`,{evaluator_type:'human',recommendation:'ship_it'})).statusCode).toBe(422);
  const unlinked=await send('POST',`/api/v1/tasks/${task.id}/evaluations`,{evaluator_type:'human',run_id:run});
  expect(unlinked.statusCode).toBe(422);expect(unlinked.json().error.message).toContain('linked');
  const recorded=await send('POST',`/api/v1/tasks/${task.id}/evaluations`,{evaluator_type:'human',score:0.8,recommendation:'accept'});
  expect(recorded.statusCode,recorded.body).toBe(201);
  expect(recorded.json().data).toMatchObject({task_id:task.id,run_id:null,recommendation:'accept'});
  as(viewer);
  expect((await send('POST',`/api/v1/tasks/${task.id}/evaluations`,{evaluator_type:'human'})).statusCode).toBe(404);
  expect(await count('SELECT count(*) AS n FROM task_evaluations WHERE task_id=$1',[task.id])).toBe(1);
 });
 it('queues one Task Run with its link, Job and in-progress event atomically; role and parent Run are not caller-owned',async()=>{
  const task=await projectTask({status:'ready',assigned_agent_id:agent});
  for(const extra of [{role:'merge'},{parent_run_id:run},{run_type:'system'},{trigger_origin:'manual'}])
   expect((await send('POST',`/api/v1/tasks/${task.id}/runs`,extra)).statusCode,JSON.stringify(extra)).toBe(422);
  const key=randomUUID(),queued=await send('POST',`/api/v1/tasks/${task.id}/runs`,{mode:'live'},key);
  expect(queued.statusCode,queued.body).toBe(201);
  const runId=queued.json().data.run_id;
  expect((await db.pool.query('SELECT role FROM task_runs WHERE task_id=$1 AND run_id=$2',[task.id,runId])).rows[0].role).toBe('primary');
  expect(await count("SELECT count(*) AS n FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=$1",[runId])).toBe(1);
  expect((await db.pool.query('SELECT status FROM tasks WHERE id=$1',[task.id])).rows[0].status).toBe('in_progress');
  expect((await send('POST',`/api/v1/tasks/${task.id}/runs`,{mode:'live'},key)).json()).toEqual(queued.json());
  expect(await count('SELECT count(*) AS n FROM task_runs WHERE task_id=$1',[task.id])).toBe(1);
  await db.pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1",[task.id]);
  const refused=await send('POST',`/api/v1/tasks/${task.id}/runs`,{mode:'live'});
  expect(refused.statusCode).toBe(409);expect(refused.json().error.message).toContain('cancelled');
  expect(await count('SELECT count(*) AS n FROM task_runs WHERE task_id=$1',[task.id])).toBe(1);
 });
 it('requests planning only for a source Task and creates the planning Run with its Job',async()=>{
  const source=await projectTask();
  const sub=await projectTask({task_role:'subtask',parent_task_id:source.id,title:'Child'});
  expect((await send('POST',`/api/v1/tasks/${sub.id}/plan-requests`,{agent_id:agent})).statusCode).toBe(409);
  const queued=await send('POST',`/api/v1/tasks/${source.id}/plan-requests`,{agent_id:agent});
  expect(queued.statusCode,queued.body).toBe(202);
  const runId=queued.json().data.run_id;
  expect((await db.pool.query('SELECT run_type FROM runs WHERE id=$1',[runId])).rows[0].run_type).toBe('planning');
  expect(await count("SELECT count(*) AS n FROM jobs WHERE payload_json->>'run_id'=$1",[runId])).toBe(1);
 });
});

describe('Board commands',()=>{
 it('creates Project and Personal-placement Boards and keeps Project Board selection revision-bearing',async()=>{
  const created=await send('POST','/api/v1/boards',{name:'Project board',project_id:project});
  expect(created.statusCode,created.body).toBe(201);
  const board=created.json().data.board_id;
  expect(await count('SELECT count(*) AS n FROM board_columns WHERE board_id=$1',[board])).toBe(5);
  as(viewer);
  expect((await send('POST','/api/v1/boards',{name:'Viewer board',project_id:project})).statusCode).toBe(404);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{name:'Viewer rename'})).statusCode).toBe(404);
  as(owner);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{name:'Renamed'})).statusCode).toBe(200);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{status:'archived'})).statusCode).toBe(409);
  expect((await send('PATCH',`/api/v1/boards/${board}`,{status:'archived',columns_revision:'stale'})).statusCode).toBe(409);
  const revision=(await readProjectColumns(db.pool,space,project)).revision;
  const archived=await send('PATCH',`/api/v1/boards/${board}`,{status:'archived',columns_revision:revision});
  expect(archived.statusCode,archived.body).toBe(200);
  expect((await db.pool.query('SELECT name,status FROM boards WHERE id=$1',[board])).rows[0]).toEqual({name:'Renamed',status:'archived'});
  expect((await send('PATCH',`/api/v1/boards/${board}`,{deleted_at:new Date().toISOString()})).statusCode).toBe(422);
 });
});

describe('Plan commands',()=>{
 const definition={schema_version:'workflow_definition.v1',workflow_id:'group-two-plan',name:'Group two plan',description:'Plan',input_schema_json:{},output_artifact_types:[],
  metadata_json:{primary_objective:'Complete the source task.',scope_json:{inputs:['source task contract']}},
  nodes:[{id:'work',title:'Do the work',depends_on:[],capability_id:'task-work',verification_recipe_refs:['output-check'],contract_json:{risk_level:'low',max_runs:1,max_attempts:1},metadata_json:{runtime_delegation_allowed:false}}]};
 async function approvedPlan(){
  const source=await projectTask();
  const repo=new PgTaskRepository(db.pool),planning=await repo.requestPlanningRun({spaceId:space,userId:owner},source.id,{agent_id:agent}) as {id:string};
  const plan=await new PgPlanRepository(db.pool,config).createPlanFromAgent({spaceId:space,userId:owner},{sourceTaskId:source.id,planningRunId:planning.id,planningToolCallId:'tool-1',agentId:agent,definitionJson:definition,budgetCap:100});
  expect((plan.current_version as {status:string}).status).toBe('approved');
  return String(plan.id);
 }
 it('executes an approved Plan once per key under Project writer authority and reconciles only as owner/admin',async()=>{
  const plan=await approvedPlan();
  as(viewer);
  expect((await send('POST',`/api/v1/plans/${plan}/execute`,{agent_id:agent})).statusCode).toBe(404);
  expect((await send('POST',`/api/v1/plans/${plan}/reconcile`,{})).statusCode).toBe(404);
  expect(await count('SELECT count(*) AS n FROM plans WHERE id=$1 AND root_run_id IS NOT NULL',[plan])).toBe(0);
  as(owner);
  const key=randomUUID(),executed=await send('POST',`/api/v1/plans/${plan}/execute`,{agent_id:agent},key);
  expect(executed.statusCode,executed.body).toBe(202);
  const out=executed.json().data;
  expect(out).toMatchObject({plan_id:plan,idempotent:false});expect(out.scheduled_node_ids).toHaveLength(1);
  expect((await send('POST',`/api/v1/plans/${plan}/execute`,{agent_id:agent},key)).json()).toEqual(executed.json());
  const again=await send('POST',`/api/v1/plans/${plan}/execute`,{agent_id:agent});
  expect(again.json().data).toMatchObject({root_run_id:out.root_run_id,idempotent:true,scheduled_node_ids:[]});
  expect(await count("SELECT count(*) AS n FROM jobs WHERE job_type='agent_run' AND payload_json->>'plan_id'=$1",[plan])).toBe(1);
  const reconciled=await send('POST',`/api/v1/plans/${plan}/reconcile`,{});
  expect(reconciled.statusCode,reconciled.body).toBe(200);
  expect(reconciled.json().data).toMatchObject({plan_id:plan,status:'active'});
  // A Project writer who is not a Space owner/admin cannot reconcile.
  const writer=randomUUID();await seedSpaceMember(db.pool,{space,user:writer});
  await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,writer]);
  as(writer);
  expect((await send('POST',`/api/v1/plans/${plan}/reconcile`,{})).statusCode).toBe(404);
  // The retained contract adds no active-Project gate: an owner/admin still reconciles after archive.
  as(owner);
  await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
  const archived=await send('POST',`/api/v1/plans/${plan}/reconcile`,{});
  expect(archived.statusCode,archived.body).toBe(200);
  expect(archived.json().data).toMatchObject({plan_id:plan,status:'active'});
 });
 it('ends the Plan and its root coordinator through the admitted Run terminal owner when a node failed',async()=>{
  const plan=await approvedPlan();
  const root=(await send('POST',`/api/v1/plans/${plan}/execute`,{agent_id:agent})).json().data.root_run_id;
  const child=(await db.pool.query("SELECT payload_json->>'run_id' AS id FROM jobs WHERE job_type='agent_run' AND payload_json->>'plan_id'=$1",[plan])).rows[0].id;
  await db.pool.query("UPDATE runs SET status='failed',ended_at=now() WHERE id=$1",[child]);
  const reconciled=await send('POST',`/api/v1/plans/${plan}/reconcile`,{});
  expect(reconciled.statusCode,reconciled.body).toBe(200);
  expect(reconciled.json().data).toMatchObject({plan_id:plan,status:'failed'});
  expect((await db.pool.query('SELECT status FROM plans WHERE id=$1',[plan])).rows[0].status).toBe('failed');
  expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[root])).rows[0].status).toBe('failed');
 });
 it('refuses to execute a Plan whose Project was archived while the command waited',async()=>{
  const plan=await approvedPlan();
  const lock=await db.pool.connect();await lock.query('BEGIN');
  await lock.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
  const attempt=send('POST',`/api/v1/plans/${plan}/execute`,{agent_id:agent});
  try{await waitForLockWaiter(db.pool);}finally{await lock.query('COMMIT');lock.release();}
  expect((await attempt).statusCode).toBe(409);
  expect(await count('SELECT count(*) AS n FROM plans WHERE id=$1 AND root_run_id IS NOT NULL',[plan])).toBe(0);
 });
});

describe('job.cancel',()=>{
 it('ends the Run behind a pending agent_run Job in the same transaction and hides other people\'s Jobs',async()=>{
  const task=await projectTask({status:'ready',assigned_agent_id:agent});
  const queued=(await send('POST',`/api/v1/tasks/${task.id}/runs`,{mode:'live'})).json().data.run_id;
  const job=(await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=$1",[queued])).rows[0].id;
  as(viewer);
  expect((await send('POST',`/api/v1/jobs/${job}/cancel`,{})).statusCode).toBe(404);
  as(owner);
  const cancelled=await send('POST',`/api/v1/jobs/${job}/cancel`,{});
  expect(cancelled.statusCode,cancelled.body).toBe(200);
  expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[job])).rows[0].status).toBe('cancelled');
  expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[queued])).rows[0].status).toBe('cancelled');
  const own=await new PgJobQueueRepository(db.pool).enqueue({job_type:'extract_text',space_id:space,user_id:viewer,payload:{}});
  expect((await send('POST',`/api/v1/jobs/${own.id}/cancel`,{})).statusCode).toBe(404);
  expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[own.id])).rows[0].status).toBe('pending');
 });
});
