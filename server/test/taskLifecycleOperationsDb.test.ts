import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {projectWorkModule} from '../src/modules/projectWork/index.js';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedRun,seedSpaceMember} from './support/domainSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {tasksModule} from '../src/modules/tasks/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {runActor} from '../src/modules/systemActions/operations/actor.js';
import {TASK_LIFECYCLE_OPERATIONS as ids} from '../src/modules/projectWork/taskLifecycleOperations.js';
import {registerProjectWorkSystemActionExecutors} from '../src/modules/projectWork/projectWorkSystemActionExecutors.js';
import {getProjectBoard} from '../src/modules/projectWork/boardReadModel.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,run:string,task:string,record:any;
let app:ReturnType<typeof buildModuleServer>,config:ReturnType<typeof loadConfig>;
const input=(id:string)=>({task_id:task,...({
 'task.report':{summary:'Readable progress',outcome:'done'},
 'task.complete':{summary:'Work complete'},
 'task.request_review':{reason:'Choose next step',options:['Accept','Revise']},
 'task.handoff':{to:null,note:'Release work'},
 'task.set_status':{status:'in_progress',reason:'Person asked'},
 'task.delete':{reason:'Person explicitly removed it'},
} as Record<string,object>)[id]});
const generic=(id:string,body:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/actions/${id}`,payload:body,headers:{'idempotency-key':key}});
const status=(body:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/tasks/${task}/status`,payload:body,headers:{'idempotency-key':key}});
const remove=(key=randomUUID())=>app.inject({method:'DELETE',url:`/api/v1/tasks/${task}`,headers:{'idempotency-key':key}});
const agent=(id:string,body:object,key=randomUUID()):Promise<any>=>new CliAgentToolTransport(config).call(record,{id:key,name:id,arguments:body});
const row=async()=> (await db.pool.query('SELECT status,deleted_at,claimed_by_agent_id FROM tasks WHERE id=$1',[task])).rows[0];
const events=async()=> (await db.pool.query('SELECT event_kind,actor_id,data_json FROM project_work_events WHERE subject_id=$1',[task])).rows;
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();run=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query("UPDATE runs SET project_id=$2,instructed_by_user_id=$3,status='running',permission_snapshot_json=$4::jsonb WHERE id=$1",[run,project,owner,JSON.stringify({tool_grants:ids.map(action_id=>({action_id}))})]);
 record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
 app=buildModuleServer(config,[tasksModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
 task=(await new PgTaskRepository(db.pool).createTask({spaceId:space,userId:owner},{project_id:project,title:'Lifecycle',status:'ready',visibility:'space_shared'})).id;
 const old=new Map();registerProjectWorkSystemActionExecutors(old,config,record);
 for(const id of ids)expect(old.has(id)).toBe(false);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('shares user formal/generic status and deletion keys without changing the status on delete',async()=>{
 const key=randomUUID(),first=await status({status:'in_progress'},key);
 expect(first.statusCode,first.body).toBe(200);
 expect((await generic('task.set_status',{task_id:task,status:'in_progress',reason:null,override_completion:null},key)).json()).toEqual(first.json());
 expect((await generic('task.set_status',{task_id:task,status:'done'},key)).json().error.code).toBe('idempotency_key_reused');
 const deletion=randomUUID(),deleted=await remove(deletion);expect(deleted.statusCode,deleted.body).toBe(200);
 expect((await generic('task.delete',{task_id:task},deletion)).json()).toEqual(deleted.json());
 expect(await row()).toMatchObject({status:'in_progress',deleted_at:expect.anything()});
 expect((await events()).filter(e=>e.event_kind==='task.deleted')).toHaveLength(1);
 expect((await app.inject({method:'DELETE',url:`/api/v1/tasks/${task}`})).statusCode).toBe(422);
});
it.each(ids)('replays %s through Agent/core with one event chain and current grant checks',async id=>{
 const body=input(id),key=randomUUID(),one=await agent(id,body,key);expect(one.httpStatus,JSON.stringify(one.body)).toBe(200);
 expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[key])).rows).toHaveLength(1);
 const before=await events(),engine=await operationRuntime(config),actor=await runActor(db.pool,record);
 const replay=await engine.execute(id,body,actor,randomUUID(),key);
 expect(replay.replayed).toBe(true);expect((replay.body as any).data).toEqual(one.body.data);expect(await events()).toEqual(before);
 const changed=id==='task.handoff'?{...body,note:'Changed'}:id==='task.set_status'?{...body,status:'blocked'}:{...body,...(id==='task.delete'||id==='task.request_review'?{reason:'Changed'}:{summary:'Changed'})};
 expect(((await engine.execute(id,changed,actor,randomUUID(),key)).body as any).error.code).toBe('idempotency_key_reused');
 const actorRow=(await db.pool.query('SELECT agent_id,user_id FROM actors WHERE id=$1',[before.at(-1).actor_id])).rows[0];
 expect(actorRow).toMatchObject({agent_id:record.agent_id,user_id:null});
 expect(before.at(-1).data_json.run_id).toBe(run);
 await db.pool.query("UPDATE runs SET permission_snapshot_json='{}' WHERE id=$1",[run]);
 expect((await engine.execute(id,body,actor,randomUUID(),key)).http_status).toBe(404);
});
it.each(ids)('rejects concurrent same-key %s before a second domain invocation',async id=>{
 const body=input(id),key=randomUUID(),lock=await db.pool.connect();
 await lock.query('BEGIN');await lock.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
 const first=agent(id,body,key);
 try{await waitForLockWaiter(db.pool);const second=await agent(id,body,key);expect(second.httpStatus).toBe(409);expect(second.body.error.code).toBe('idempotency_in_progress');}
 finally{await lock.query('ROLLBACK');lock.release();}
 expect((await first).httpStatus).toBe(200);
});
it('report done is an account, complete closes, and review hands responsibility back to a person',async()=>{
 await db.pool.query('UPDATE tasks SET claimed_by_agent_id=$2 WHERE id=$1',[task,record.agent_id]);
 expect((await agent('task.report',input('task.report'))).httpStatus).toBe(200);expect((await row()).status).toBe('ready');
 expect((await agent('task.set_status',{task_id:task,status:'waiting_for_review',reason:'Need decision'})).httpStatus).toBe(200);
 const card=(await getProjectBoard(db.pool,{spaceId:space,userId:owner},project)).cards.find(c=>c.id===task)!;
 expect(card.responsible).toMatchObject({kind:'user',id:owner});
 expect((await row()).claimed_by_agent_id).toBe(record.agent_id);
 expect((await agent('task.set_status',{task_id:task,status:'done',reason:'Decision applied'})).httpStatus).toBe(200);
 expect((await row()).status).toBe('done');
 const all=await events();expect(all.filter(e=>e.event_kind==='task.flow_changed')).toHaveLength(2);
 expect(all.filter(e=>e.event_kind==='task.reported')).toHaveLength(3);
});
it('preserves human completion acknowledgement and refuses Agent override and public PATCH status',async()=>{
 await db.pool.query("UPDATE tasks SET required_outputs_json='[\"report\"]' WHERE id=$1",[task]);
 const refusal=await status({status:'done'});expect(refusal.statusCode).toBe(422);expect(refusal.json().error.metadata.missing).toContain('required_output:report');
 expect((await agent('task.complete',input('task.complete'))).httpStatus).toBe(422);
 expect((await agent('task.set_status',{task_id:task,status:'done',reason:'Bypass',override_completion:{acknowledged:['required_output:report']}})).httpStatus).toBe(422);
 expect((await status({status:'done',override_completion:{acknowledged:['required_output:report']}})).statusCode).toBe(200);
 expect((await app.inject({method:'PATCH',url:`/api/v1/tasks/${task}`,payload:{status:'ready',title:'Do not partially edit'}})).statusCode).toBe(422);
 expect((await row()).status).toBe('done');
});
it('hides same-Space foreign Project, summary-only Tasks and current authority revocation',async()=>{
 const foreign=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,'Other','active',$3,now(),now())",[foreign,space,owner]);
 await db.pool.query('UPDATE tasks SET project_id=$2 WHERE id=$1',[task,foreign]);
 expect((await agent('task.report',input('task.report'))).httpStatus).toBe(404);
 await db.pool.query('UPDATE tasks SET project_id=$2 WHERE id=$1',[task,project]);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
 __setAuthIdentityForTests({spaceId:space,userId:peer});
 const key=randomUUID();expect((await status({status:'in_progress'},key)).statusCode).toBe(200);
 await db.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,peer]);
 expect((await status({status:'in_progress'},key)).statusCode).toBe(404);
 const reader=randomUUID();await seedSpaceMember(db.pool,{space,user:reader});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,reader]);
 __setAuthIdentityForTests({spaceId:space,userId:reader});
 await db.pool.query("UPDATE tasks SET access_level='summary' WHERE id=$1",[task]);
 expect((await status({status:'ready'})).statusCode).toBe(404);
});
it('refuses unfinished Runs and active Plans before deletion and preserves all execution evidence',async()=>{
 await db.pool.query("INSERT INTO task_runs(id,space_id,task_id,run_id,role,created_at) VALUES($1,$2,$3,$4,'primary',now())",[randomUUID(),space,task,run]);
 expect((await remove()).statusCode).toBe(409);expect((await row()).deleted_at).toBeNull();
 await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run]);
 const plan=randomUUID();await db.pool.query("INSERT INTO plans(id,space_id,project_id,source_task_id,name,status,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'Active','active',$5,now(),now())",[plan,space,project,task,owner]);
 expect((await remove()).statusCode).toBe(409);
 await db.pool.query("UPDATE plans SET status='completed' WHERE id=$1",[plan]);
 expect((await remove()).statusCode).toBe(200);expect((await db.pool.query('SELECT id FROM task_runs WHERE task_id=$1',[task])).rows).toHaveLength(1);
});
it.each(['task.set_status','task.delete','task.complete'])('keeps unattended %s failclosed without enabling approval mapping',async id=>{
 await db.pool.query("UPDATE runs SET trigger_origin='autonomous' WHERE id=$1",[run]);record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 const result=await agent(id,input(id));expect(result.httpStatus).toBe(503);expect(result.body.error).toMatchObject({code:'operation_approval_mapping_unavailable',retryable:false});
 expect(result.body.error.message).toContain('Do not retry automatically');
 expect((await row()).status).toBe('ready');expect((await row()).deleted_at).toBeNull();
 expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(0);
 const audits=(await db.pool.query('SELECT metadata_json FROM policy_decision_records WHERE space_id=$1',[space])).rows;
 expect(audits).toHaveLength(1);expect(audits[0].metadata_json.operation_outcome).toBe('failed');
});
it.each(ids)('rolls back %s if receipt storage fails and retains one failed policy audit',async id=>{
 const before=await events();
 await db.pool.query("CREATE FUNCTION reject_lifecycle_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private receipt fault'; END $$");
 await db.pool.query('CREATE TRIGGER reject_lifecycle_receipt BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_receipt()');
 try{
  const result=await agent(id,input(id));expect(result.httpStatus).toBe(500);expect(JSON.stringify(result.body)).not.toContain('private receipt fault');
  expect(await events()).toEqual(before);expect(await row()).toMatchObject({status:'ready',deleted_at:null});
  const audits=(await db.pool.query('SELECT metadata_json FROM policy_decision_records WHERE space_id=$1',[space])).rows;
  expect(audits).toHaveLength(1);expect(audits[0].metadata_json.operation_outcome).toBe('failed');
 }finally{await db.pool.query('DROP TRIGGER reject_lifecycle_receipt ON operation_idempotency');await db.pool.query('DROP FUNCTION reject_lifecycle_receipt()');}
});
it('withholds all effects if mandatory policy audit storage fails',async()=>{
 const before=await events();
 await db.pool.query("CREATE FUNCTION reject_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private audit fault'; END $$");
 await db.pool.query('CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_audit()');
 try{const result=await agent('task.complete',input('task.complete'));expect(result.httpStatus).toBe(503);expect(await events()).toEqual(before);expect((await row()).status).toBe('ready');}
 finally{await db.pool.query('DROP TRIGGER reject_lifecycle_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION reject_lifecycle_audit()');}
});
it('retains standalone human Task status/delete without introducing Agent access or new human tool powers',async()=>{
 const standalone=await new PgTaskRepository(db.pool).createTask({spaceId:space,userId:owner},{title:'Standalone'});
 task=standalone.id;expect((await status({status:'blocked',blocked_reason:'Waiting supplier'})).statusCode).toBe(200);
 expect((await agent('task.report',input('task.report'))).httpStatus).toBe(404);
 expect((await generic('task.complete',input('task.complete'))).statusCode).toBe(404);
 expect((await remove()).statusCode).toBe(200);
});
it('keeps unattended reporting, handoff and review available without granting advancement',async()=>{
 await db.pool.query("UPDATE runs SET trigger_origin='autonomous' WHERE id=$1",[run]);record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 for(const id of ['task.report','task.handoff','task.request_review'])expect((await agent(id,input(id))).httpStatus).toBe(200);
 expect((await row()).status).toBe('waiting_for_review');
 expect((await agent('task.set_status',{task_id:task,status:'in_progress',reason:'Try advance'})).httpStatus).toBe(503);
 expect((await row()).status).toBe('waiting_for_review');
});
it('hides cross-Space Tasks and never replays a receipt across user and Agent identities',async()=>{
 const elsewhere=randomUUID(),other=randomUUID(),foreign=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space:elsewhere,owner:other,project:foreign});
 const target=await new PgTaskRepository(db.pool).createTask({spaceId:elsewhere,userId:other},{project_id:foreign,title:'Private foreign title'});
 for(const id of ids){
  const denied=await agent(id,{...input(id),task_id:target.id});
  expect(denied.httpStatus).toBe(404);expect(JSON.stringify(denied.body)).not.toContain('Private foreign title');
 }
 const key=randomUUID();expect((await status({status:'in_progress',reason:'Person asked'},key)).statusCode).toBe(200);
 const result=await agent('task.set_status',{task_id:task,status:'in_progress',reason:'Person asked'},key);
 expect(result.httpStatus).toBe(200);expect(result.body.replayed).toBe(false);
 expect((await db.pool.query('SELECT principal_kind FROM operation_idempotency WHERE space_id=$1 AND idempotency_key=$2',[space,key])).rows.map(r=>r.principal_kind).sort()).toEqual(['agent','user']);
});

it.each(ids)('offers safe missing-id discovery for %s only inside the live authorized Run Project',async id=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
 const privateTask=await new PgTaskRepository(db.pool).createTask({spaceId:space,userId:owner},{project_id:project,title:'Never disclose private work',visibility:'private'});
 const foreign=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,'Other Project','active',$3,now(),now())",[foreign,space,owner]);
 const otherTask=await new PgTaskRepository(db.pool).createTask({spaceId:space,userId:owner},{project_id:foreign,title:'Never disclose foreign work',visibility:'space_shared'});
 await db.pool.query('UPDATE runs SET instructed_by_user_id=$2 WHERE id=$1',[run,peer]);
 record=(await db.pool.query('SELECT * FROM runs WHERE id=$1',[run])).rows[0];
 const missing=await agent(id,{...input(id),task_id:'composed-task-title'});
 expect(missing.httpStatus).toBe(404);
 expect(missing.body.error.message).toBe(`No Task in this Project has id 'composed-task-title'. Use one of these ids exactly: ${task} — Lifecycle`);
 for(const target of [privateTask,otherTask]){
  const denied=await agent(id,{...input(id),task_id:target.id});
  expect(denied.httpStatus).toBe(404);expect(denied.body.error.message).toBe('operation not found');
  expect(JSON.stringify(denied.body)).not.toContain(task);
 }
 await db.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,peer]);
 const revoked=await agent(id,{...input(id),task_id:'composed-task-title'});
 expect(revoked.body.error.message).toBe('operation not found');
 await db.pool.query("UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",[project,peer]);
 await db.pool.query("UPDATE runs SET permission_snapshot_json='{}' WHERE id=$1",[run]);
 expect((await agent(id,{...input(id),task_id:'composed-task-title'})).body.error.message).toBe('operation not found');
});
it('treats cross-Space missing ids like random missing ids, and never gives users Agent discovery',async()=>{
 const elsewhere=randomUUID(),other=randomUUID(),foreign=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space:elsewhere,owner:other,project:foreign});
 const target=await new PgTaskRepository(db.pool).createTask({spaceId:elsewhere,userId:other},{project_id:foreign,title:'Cross Space secret'});
 const missing=randomUUID();
 const foreignResult=await agent('task.report',{task_id:target.id,summary:'Report'});
 const randomResult=await agent('task.report',{task_id:missing,summary:'Report'});
 expect(foreignResult.body.error.message.replace(target.id,'missing')).toBe(randomResult.body.error.message.replace(missing,'missing'));
 expect(JSON.stringify(foreignResult.body)).not.toContain('Cross Space secret');
 const user=await generic('task.set_status',{task_id:missing,status:'ready'});
 expect(user.json().error.message).toBe('operation not found');
});
it('bounds safe discovery to the existing 50-Task list limit',async()=>{
 const more=Array.from({length:51},()=>randomUUID());
 await db.pool.query("INSERT INTO tasks(id,space_id,project_id,title,status,owner_user_id,created_by_user_id,visibility,created_at,updated_at) SELECT id,$2,$3,'Visible card','ready',$4,$4,'space_shared',now(),now() FROM unnest($1::varchar[]) id",[more,space,project,owner]);
 const result=await agent('task.report',{task_id:'made-up-id',summary:'Report'});
 expect(result.httpStatus).toBe(404);
 expect(result.body.error.message.match(/ — /g)).toHaveLength(50);
});
it('gives fixed safe Artifact guidance to an Agent completion refusal while preserving canonical metadata',async()=>{
 await db.pool.query("UPDATE tasks SET required_outputs_json='[\"report\"]' WHERE id=$1",[task]);
 const result=await agent('task.complete',input('task.complete'));
 expect(result.body.error.code).toBe('operation_invalid_input');
 expect(result.body.error.metadata).toMatchObject({code:'completion_requirements_unmet',missing:expect.arrayContaining(['required_output:report'])});
 expect(result.body.error.message).toContain('required_outputs are Artifact type labels');
 expect(result.body.error.message).toContain('artifact.submit');
 expect(result.body.error.message).toContain('task.request_review');
 expect((await row()).status).toBe('ready');
});
it('preserves human blocker normalization without a new field quota and keeps human reason out of work events',async()=>{
 const long='Waiting supplier '.repeat(600);
 const response=await status({status:'blocked',blocked_reason:'  '+long+'  ',reason:'Human transport reason'});
 expect(response.statusCode,response.body).toBe(200);
 expect((await db.pool.query('SELECT blocked_reason FROM tasks WHERE id=$1',[task])).rows[0].blocked_reason).toBe(long.trim());
 expect((await events()).filter(e=>e.event_kind==='task.flow_changed').at(-1).data_json).not.toHaveProperty('reason');
 expect((await status({status:'blocked',blocked_reason:'   '})).statusCode).toBe(200);
 expect((await db.pool.query('SELECT blocked_reason FROM tasks WHERE id=$1',[task])).rows[0].blocked_reason).toBeNull();
});

it('saves Project contracts and standalone Board changes from the rendered Task Detail parent against real PG routes',async()=>{
 const space=randomUUID(),owner=randomUUID(),project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 const identity={spaceId:space,userId:owner},repository=new PgTaskRepository(db.pool);
 const projectTask=await repository.createTask(identity,{title:'Project contract',project_id:project,visibility:'space_shared'});
 const standalone=await repository.createTask(identity,{title:'Standalone contract'});
 const first=await repository.createBoard(identity,{name:'Original board'}),next=await repository.createBoard(identity,{name:'Next board'});
 await repository.updateTask(identity,standalone.id,{board_id:first.id});
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[tasksModule,projectWorkModule,systemActionsModule]);
 __setAuthIdentityForTests(identity);
 const web=join(import.meta.dirname,'../../apps/web'),shots=process.env.TASK_CONTRACT_VISUAL_OUT??'/tmp/rainver-task-contract-review';
 const {preview}=await import(pathToFileURL(join(web,'node_modules/vite/dist/node/index.js')).href);
 const {chromium}=await import(pathToFileURL(join(web,'node_modules/playwright-core/index.mjs')).href);
 let server:any,browser:any;
 const writes:Array<{body:Record<string,unknown>;status:number}>=[];
 try{
  await mkdir(shots,{recursive:true});
  server=await preview({root:web,configFile:false,preview:{host:'127.0.0.1',port:0}});
  const base=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});
  const wirePage=(page:any)=>page.route('**/api/v1/**',async(route:any)=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1','');
    if(path.startsWith('/tasks/')||path==='/boards'||path==='/actions/task.place_in_space_board'){
     const key=request.headers()['idempotency-key'];
     const response=await app.inject({method:request.method(),url:url.pathname+url.search,headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(request.postData()?{payload:request.postData()}: {})});
     if(request.method()==='PATCH'||path==='/actions/task.place_in_space_board')writes.push({body:path.startsWith('/actions/')?request.postDataJSON().changes:request.postDataJSON(),status:response.statusCode});
     return route.fulfill({status:response.statusCode,body:response.body,contentType:'application/json'});
    }
    if(path==='/me')return route.fulfill({json:{id:owner,display_name:'Contract reviewer',email:'fixture@test.invalid',default_space_id:space}});
    if(path==='/me/spaces')return route.fulfill({json:[{id:space,name:'Test Space',type:'household',role:'owner',status:'active'}]});
    if(path==='/agents')return route.fulfill({json:[]});
    if(path==='/plugins/effective')return route.fulfill({json:{plugins:{}}});
    if(path==='/me/agent-attention/snapshot')return route.fulfill({json:{type:'attention.snapshot',seq:1,version:'fixture',unread_count:0,page:{items:[],total:0,limit:100,offset:0},notices:[]}});
    return route.fulfill({status:404,json:{detail:'Unavailable in contract fixture'}});
   });
  for(const theme of ['dark','light'])for(const locale of ['en','zh-CN'])for(const width of [390,1280]){
   const page=await browser.newPage({viewport:{width,height:1000},serviceWorkers:'block'});
   await page.addInitScript(({theme,locale}:{theme:string;locale:string})=>{localStorage.setItem('rainver:theme',theme);localStorage.setItem('rainver:locale',locale);},{theme,locale});
   await wirePage(page);
   await page.goto(`${base}/spaces/${space}/tasks/${projectTask.id}`);
   await page.getByRole('button',{name:'Edit contract',exact:true}).waitFor();
   await page.screenshot({path:join(shots,`entry-${theme}-${locale}-${width}.png`),fullPage:true});
   await page.getByRole('button',{name:'Edit contract',exact:true}).click();
   const dialog=page.getByRole('dialog');
   await dialog.getByRole('button',{name:'Save contract',exact:true}).waitFor();
   expect(await dialog.getByText('Board',{exact:true}).count()).toBe(0);
   const title=`Saved ${theme} ${locale} ${width}`;
   await dialog.getByLabel('Title',{exact:true}).fill(title);
   // Shared Dialog enters with a CSS transition; inspect its settled surface.
   await page.evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>undefined)))");
   const bounds=await dialog.boundingBox();
   expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.y).toBeGreaterThanOrEqual(0);
   expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
   await page.screenshot({path:join(shots,`project-editor-${theme}-${locale}-${width}.png`),fullPage:true});
   await dialog.getByRole('button',{name:'Save contract',exact:true}).click();
   await dialog.waitFor({state:'hidden'});
   expect(writes.at(-1)).toMatchObject({status:200,body:{title}});
   expect(writes.at(-1)!.body).not.toHaveProperty('board_id');
   expect(writes.at(-1)!.body).not.toHaveProperty('column_id');
   expect((await repository.getTask(identity,projectTask.id))!.title).toBe(title);
   await page.close();
  }
  // The standalone destination still exposes and persists the existing Board selector.
  const page=await browser.newPage({viewport:{width:1280,height:1000},serviceWorkers:'block'});
  await wirePage(page);
  await page.goto(`${base}/spaces/${space}/tasks/${standalone.id}`);
  await page.getByRole('button',{name:'Edit contract',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Original board',exact:true}).click();
  await page.getByRole('option',{name:'Next board',exact:true}).click();
  await page.evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>undefined)))");
  await page.screenshot({path:join(shots,'standalone-editor.png'),fullPage:true});
  await dialog.getByRole('button',{name:'Save contract',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  expect(writes.at(-1)).toMatchObject({status:200,body:{board_id:next.id}});
  expect((await repository.getTask(identity,standalone.id))!.board_id).toBe(next.id);
  // Same real route still refuses the former Project payload; no backend relaxation.
  const denied=await app.inject({method:'PATCH',url:`/api/v1/tasks/${projectTask.id}`,payload:{title:'Must not partially save',board_id:null}});
  expect(denied.statusCode).toBe(422);
  expect((await repository.getTask(identity,projectTask.id))!.title).not.toBe('Must not partially save');
 }finally{
  await browser?.close();
  if(server)await new Promise<void>(resolve=>server.httpServer.close(()=>resolve()));
  await app.close();__setAuthIdentityForTests(null);
 }
},90000);
