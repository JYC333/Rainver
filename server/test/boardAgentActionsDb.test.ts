import {afterEach} from 'vitest';
import {projectWorkModule} from '../src/modules/projectWork/index.js';
import {tasksModule} from '../src/modules/tasks/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {runActor} from '../src/modules/systemActions/operations/actor.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
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
let record:any;
let app:ReturnType<typeof buildModuleServer>;
let runtimeConfig:ReturnType<typeof loadConfig>;
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
const call=async(name:string,input:unknown)=>{
 const definition=SYSTEM_ACTION_REGISTRY.find(a=>a.id===name)!;
 expect(ROOM_CONVERSATION_TOOL_ALLOWANCE).toContain(name);
 if(definition.execution){
   const response:any=await new CliAgentToolTransport(loadConfig({SERVER_DATABASE_URL:db.connectionUri})).call(record,{id:randomUUID(),name,arguments:input});
   if(response.httpStatus>=400)throw Object.assign(new Error(response.body.error.code),{statusCode:response.httpStatus});
   return response.body.data;
 }
 return (await executors.get(name)(definition.input_schema.parse(input),{idempotency_key:randomUUID()})).modelResult;
};
const config=(board:any)=>({revision:board.columns_revision,columns:board.columns.filter((c:any)=>c.status_key).map(({key,label,status_key,wip_limit}:any)=>({key,label,status_key,wip_limit})),moves:{},reason:'Person requested this Board change'});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query("UPDATE runs SET project_id=$2,instructed_by_user_id=$3,status='running',permission_snapshot_json=$4::jsonb WHERE id=$1",[run,project,owner,JSON.stringify({tool_grants:[{action_id:'board.configure'},{action_id:'task.move_to_column'}]})]);
 record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 runtimeConfig=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
 app=buildModuleServer(runtimeConfig,[projectWorkModule,tasksModule,systemActionsModule]);
 __setAuthIdentityForTests(identity);
 executors=new Map();registerProjectWorkSystemActionExecutors(executors,loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-board-actions'}),record);
 expect(executors.has('board.configure')).toBe(false);expect(executors.has('task.move_to_column')).toBe(false);
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

const readBoard=()=>getProjectBoard(db.pool,identity,project);
const command=(name:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/actions/${name}`,payload:input,headers:{'idempotency-key':key}});
const configure=(input:object,key=randomUUID())=>app.inject({method:'PUT',url:`/api/v1/projects/${project}/board/columns`,payload:input,headers:{'idempotency-key':key}});
const move=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/tasks/${id}/move-to-column`,payload:input,headers:{'idempotency-key':key}});
const task=(extra:object={})=>new PgTaskRepository(db.pool).createTask(identity,{project_id:project,title:'Card',status:'ready',visibility:'space_shared',...extra});
it('shares formal/generic configure and move keys, normalized inputs and one effect',async()=>{
 const initial=await readBoard(),body=config(initial),key=randomUUID();delete (body as any).reason;
 const first=await configure(body,key);expect(first.statusCode,first.body).toBe(200);
 const again=await command('board.configure',{...body,project_id:project},key);expect(again.json()).toEqual(first.json());
 const changed=await command('board.configure',{...body,project_id:project,columns:body.columns.map((c:any)=>({...c,label:'Changed'}))},key);
 expect(changed.json().error.code).toBe('idempotency_key_reused');
 const t=await task(),layout=first.json().data,selection={column_key:layout.columns.find((c:any)=>c.status_key==='in_progress').key,columns_revision:layout.columns_revision},mk=randomUUID();
 const one=await move(t.id,selection,mk);expect(one.statusCode,one.body).toBe(200);
 expect((await command('task.move_to_column',{task_id:t.id,...selection},mk)).json()).toEqual(one.json());
 expect((await db.pool.query("SELECT id FROM project_work_events WHERE subject_id=$1 AND event_kind='task.flow_changed'",[t.id])).rows).toHaveLength(1);
 expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE action='task.column.move' AND resource_id=$1",[t.id])).rows).toHaveLength(2);
});
it('preserves the Agent principal, instruction identity, grants and core replay scope',async()=>{
 const t=await task(),board=await readBoard(),key=randomUUID();
 const input={task_id:t.id,column_key:'in_progress',columns_revision:board.columns_revision,reason:'Move requested'};
 const transport=new CliAgentToolTransport(runtimeConfig),one:any=await transport.call(record,{id:key,name:'task.move_to_column',arguments:input});
 expect(one.httpStatus).toBe(200);
 const engine=await operationRuntime(runtimeConfig),actor=await runActor(db.pool,record);
 const replay=await engine.execute('task.move_to_column',input,actor,'retry',key);
 expect(replay.replayed).toBe(true);expect((replay.body as any).data).toEqual(one.body.data);
 const event=(await db.pool.query("SELECT a.agent_id,a.user_id,e.data_json FROM project_work_events e JOIN actors a ON a.id=e.actor_id WHERE e.subject_id=$1 AND e.event_kind='task.flow_changed'",[t.id])).rows[0];
 expect(event).toMatchObject({agent_id:record.agent_id,user_id:null,data_json:{via:'agent',run_id:run}});
 const request=(await db.pool.query("SELECT principal_kind,principal_id,on_behalf FROM operation_idempotency WHERE operation_id='task.move_to_column' AND idempotency_key=$1",[key])).rows[0];
 expect(request).toMatchObject({principal_kind:'agent',principal_id:record.agent_id,on_behalf:`user:${owner}`});
 const conflict=await engine.execute('task.move_to_column',{...input,column_key:'done'},actor,'changed',key);
 expect((conflict.body as any).error.code).toBe('idempotency_key_reused');
 await db.pool.query("UPDATE runs SET permission_snapshot_json='{}' WHERE id=$1",[run]);
 expect((await engine.execute('task.move_to_column',input,actor,'revoked',key)).http_status).toBe(404);
});
it('refuses concurrent same-key configuration before a second mutation and then replays',async()=>{
 const body=config(await readBoard()),key=randomUUID(),lock=await db.pool.connect();
 await lock.query('BEGIN');await lock.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
 const first=Promise.resolve(configure(body,key));
 try{await waitForLockWaiter(db.pool);const second=await command('board.configure',{...body,project_id:project},key);expect(second.statusCode).toBe(409);expect(second.json().error.code).toBe('idempotency_in_progress');}
 finally{await lock.query('ROLLBACK');lock.release();}
 expect((await first).statusCode).toBe(200);expect((await configure(body,key)).statusCode).toBe(200);
 expect((await db.pool.query('SELECT id FROM boards WHERE space_id=$1',[space])).rows).toHaveLength(1);
});
it('keeps same-status columns distinct, WIP as hints, and blocked overlays intact',async()=>{
 const body=config(await readBoard());body.columns.push({key:'new:design',label:'Design',status_key:'in_progress',wip_limit:1});
 const configured=await configure(body),layout=configured.json().data,design=layout.columns.find((c:any)=>c.label==='Design');
 for(let i=0;i<2;i++){const t=await task({status:i===0?'blocked':'ready'});const response=await move(t.id,{column_key:design.key,columns_revision:layout.columns_revision});expect(response.statusCode,response.body).toBe(200);expect(response.json().data.status).toBe(i===0?'blocked':'in_progress');}
 const board=await readBoard();expect(board.cards.every(c=>c.column_key===design.key)).toBe(true);expect(board.columns.find(c=>c.key===design.key)?.wip_limit).toBe(1);
 const t=await task();expect((await move(t.id,{column_key:'unassigned',columns_revision:layout.columns_revision})).statusCode).toBe(404);
 expect((await move(t.id,{column_key:design.key,columns_revision:'stale'})).statusCode).toBe(409);
 const patch=await app.inject({method:'PATCH',url:`/api/v1/tasks/${t.id}`,payload:{column_id:design.key}});expect(patch.statusCode).toBe(422);
});
it('preserves human completion refusal metadata and explicit acknowledgement without Agent override',async()=>{
 const t=await task({required_outputs_json:['report']}),board=await readBoard();
 const input={column_key:'done',columns_revision:board.columns_revision};
 const failed=await move(t.id,input);expect(failed.statusCode).toBe(422);
 expect(failed.json()).toMatchObject({error:{code:'operation_invalid_input',metadata:{code:'completion_requirements_unmet',missing:expect.arrayContaining(['required_output:report'])}}});
 const agent:any=await new CliAgentToolTransport(runtimeConfig).call(record,{id:randomUUID(),name:'task.move_to_column',arguments:{task_id:t.id,...input,reason:'Try override',override_completion:{acknowledged:['required_output:report']}}});
 expect(agent.httpStatus).toBe(422);
 const accepted=await move(t.id,{...input,override_completion:{acknowledged:['required_output:report']}});
 expect(accepted.statusCode,accepted.body).toBe(200);
});
it('hides current Project write revocation and foreign Tasks, including success replay',async()=>{
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,other]);
 const body=config(await readBoard()),key=randomUUID();__setAuthIdentityForTests({spaceId:space,userId:other});
 expect((await configure(body,key)).statusCode).toBe(200);
 await db.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,other]);
 expect((await configure(body,key)).statusCode).toBe(404);
 __setAuthIdentityForTests(identity);
 const foreign=randomUUID(),fo=randomUUID(),fp=randomUUID();await seedSpaceOwnerProject(db.pool,{space:foreign,owner:fo,project:fp});
 const t=await new PgTaskRepository(db.pool).createTask({spaceId:foreign,userId:fo},{project_id:fp,title:'Hidden title'});
 const result=await move(t.id,{column_key:'ready',columns_revision:'unknown'});expect(result.statusCode).toBe(404);expect(result.body).not.toContain('Hidden title');
});
it('rolls back configured columns if a relocated Task fails its completion gate',async()=>{
 const t=await task({required_outputs_json:['report']}),before=await readBoard(),body=config(before);
 body.columns=body.columns.map((c:any)=>c.key==='ready'?{...c,status_key:'done'}:c);
 const result=await configure(body);expect(result.statusCode,result.body).toBe(422);
 expect((await readBoard()).columns_revision).toBe(before.columns_revision);
 expect((await new PgTaskRepository(db.pool).getTask(identity,t.id))?.status).toBe('ready');
 expect((await db.pool.query('SELECT id FROM boards WHERE space_id=$1',[space])).rows).toHaveLength(0);
});
it.each(['policy_decision_records','operation_idempotency'] as const)('withholds Board effects if required %s storage fails',async table=>{
 const body=config(await readBoard());
 await db.pool.query("CREATE FUNCTION refuse_board_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private storage failure'; END $$");
 await db.pool.query(`CREATE TRIGGER refuse_board_storage BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_board_storage()`);
 try{const result=await configure(body);expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(result.body).not.toContain('private storage failure');expect((await db.pool.query('SELECT id FROM boards WHERE space_id=$1',[space])).rows).toHaveLength(0);expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(0);}
 finally{await db.pool.query(`DROP TRIGGER refuse_board_storage ON ${table}`);await db.pool.query('DROP FUNCTION refuse_board_storage()');}
});

it('rejects concurrent same-key movement and preserves one Task flow event',async()=>{
 const t=await task(),layout=await readBoard(),input={column_key:'in_progress',columns_revision:layout.columns_revision},key=randomUUID(),lock=await db.pool.connect();
 await lock.query('BEGIN');await lock.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
 const first=Promise.resolve(move(t.id,input,key));
 try{await waitForLockWaiter(db.pool);const second=await command('task.move_to_column',{task_id:t.id,...input},key);expect(second.statusCode).toBe(409);expect(second.json().error.code).toBe('idempotency_in_progress');}
 finally{await lock.query('ROLLBACK');lock.release();}
 expect((await first).statusCode).toBe(200);
 expect((await db.pool.query("SELECT id FROM project_work_events WHERE subject_id=$1 AND event_kind='task.flow_changed'",[t.id])).rows).toHaveLength(1);
});
it('refuses private Task movement and column remapping without leaking or partially configuring',async()=>{
 const t=await task({visibility:'private'}),before=await readBoard(),body=config(before),peer=randomUUID();
 await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
 __setAuthIdentityForTests({spaceId:space,userId:peer});
 const moved=await move(t.id,{column_key:'in_progress',columns_revision:before.columns_revision});expect(moved.statusCode).toBe(404);
 body.columns=body.columns.map((c:any)=>c.key==='ready'?{...c,status_key:'in_progress'}:c);
 const configured=await configure(body);expect(configured.statusCode).toBe(404);expect(configured.json().error.code).toBe('operation_not_found');expect(configured.body).not.toContain('cannot move');
 expect((await readBoard()).columns_revision).toBe(before.columns_revision);
 expect((await new PgTaskRepository(db.pool).getTask(identity,t.id))?.status).toBe('ready');
 const audit=(await db.pool.query("SELECT id FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[configured.headers['x-request-id']])).rows;
 expect(audit).toHaveLength(1);
});

it('preserves standalone Space Board placement through its dedicated core entry',async()=>{
 const repository=new PgTaskRepository(db.pool),board=await repository.createBoard(identity,{name:'Standalone board'});
 const columns=board.columns as Array<{id:string;status_key:string}>;
 const standalone=await repository.createTask(identity,{title:'Standalone',board_id:board.id,column_id:columns.find(c=>c.status_key==='ready')!.id});
 const result=await app.inject({method:'POST',url:`/api/v1/tasks/${standalone.id}/space-board-placement`,headers:{'idempotency-key':randomUUID()},payload:{changes:{column_id:columns.find(c=>c.status_key==='in_progress')!.id}}});
 expect(result.statusCode,result.body).toBe(200);expect(result.json().data.status).toBe('in_progress');
 const boardOnly=await app.inject({method:'POST',url:`/api/v1/tasks/${standalone.id}/space-board-placement`,headers:{'idempotency-key':randomUUID()},payload:{changes:{board_id:board.id}}});
 expect(boardOnly.statusCode,boardOnly.body).toBe(200);
});

it.each(['autonomous','job','continuation'])('fails closed for unattended %s Board writes with durable failed audits',async origin=>{
 if(origin==='continuation'){
  const root=randomUUID();
  await seedRun(db.pool,{id:root,space,owner,agent:record.agent_id,version:record.agent_version_id,existingAgent:true});
  await db.pool.query("UPDATE runs SET trigger_origin='autonomous',instructed_by_user_id=$2,project_id=$3 WHERE id=$1",[root,owner,project]);
  await db.pool.query("UPDATE runs SET trigger_origin='continuation',cause_run_id=$2 WHERE id=$1",[run,root]);
 }else await db.pool.query('UPDATE runs SET trigger_origin=$2 WHERE id=$1',[run,origin]);
 record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 const t=await task(),before=await readBoard();
 const requestIds:string[]=[];
 for(const name of ['board.configure','task.move_to_column']){
  const input=name==='board.configure'?config(before):{task_id:t.id,column_key:'in_progress',columns_revision:before.columns_revision,reason:'Unattended work'};
  const response:any=await new CliAgentToolTransport(runtimeConfig).call(record,{id:randomUUID(),name,arguments:input});
  expect(response.httpStatus,JSON.stringify(response.body)).toBe(503);
  expect(response.body.error).toMatchObject({code:'operation_approval_mapping_unavailable',retryable:false});
  expect(response.body.error.message).toContain('requires human initiation or approval');
  expect(response.body.error.message).toContain('Do not retry automatically');
  requestIds.push(response.body.error.request_id);
  const audits=(await db.pool.query("SELECT id,metadata_json FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[response.body.error.request_id])).rows;
  expect(audits[0]?.id).toBe(response.body.policy_decision_record_id);
  expect(audits).toHaveLength(1);expect(audits[0].metadata_json.operation_outcome).toBe('failed');
 }
 expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=ANY($1::text[])",[requestIds])).rows).toHaveLength(2);
 expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(0);
 expect((await db.pool.query('SELECT id FROM authorization_requests WHERE space_id=$1',[space])).rows).toHaveLength(0);
 expect((await readBoard()).columns_revision).toBe(before.columns_revision);
 expect((await db.pool.query('SELECT status FROM tasks WHERE id=$1',[t.id])).rows[0].status).toBe('ready');
});

it('rejects every public Project placement field under the Task transaction lock',async()=>{
 const t=await task();
 for(const payload of [{board_id:null},{column_id:null},{project_id:null,board_id:null},{project_id:null,column_id:null}]){
  const response=await app.inject({method:'PATCH',url:`/api/v1/tasks/${t.id}`,payload});
  expect(response.statusCode,response.body).toBe(422);expect(response.json().error.code).toBe('operation_invalid_input');
 }
 const standalone=await new PgTaskRepository(db.pool).createTask(identity,{title:'Not yet in Project'});
 const combined=await app.inject({method:'PATCH',url:`/api/v1/tasks/${standalone.id}`,payload:{project_id:project,board_id:null}});
 expect(combined.statusCode).toBe(422);
 expect((await db.pool.query('SELECT project_id FROM tasks WHERE id=$1',[standalone.id])).rows[0].project_id).toBeNull();
});

it('cannot race standalone placement past concurrent reparenting into a Project',async()=>{
 const t=await new PgTaskRepository(db.pool).createTask(identity,{title:'Concurrent reparent'});
 const before=(await db.pool.query('SELECT status FROM tasks WHERE id=$1',[t.id])).rows[0].status;
 const lock=await db.pool.connect();await lock.query('BEGIN');
 await lock.query('UPDATE tasks SET project_id=$2 WHERE id=$1',[t.id,project]);
 const attempt=Promise.resolve(app.inject({method:'PATCH',url:`/api/v1/tasks/${t.id}`,payload:{board_id:null,column_id:null,status:'done'}}));
 try{await waitForLockWaiter(db.pool);}
 finally{await lock.query('COMMIT');lock.release();}
 const response=await attempt;expect(response.statusCode,response.body).toBe(409);
 expect((await db.pool.query('SELECT project_id,status FROM tasks WHERE id=$1',[t.id])).rows[0]).toMatchObject({project_id:project,status:before});
 expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(0);
 expect((await db.pool.query("SELECT id FROM project_work_events WHERE subject_id=$1 AND event_kind='task.flow_changed'",[t.id])).rows).toHaveLength(0);
});
