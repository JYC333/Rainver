import {InquiryIterationService} from "../src/modules/inquiry/iterationService.js";
import {waitForLockWaiter} from "./support/lockWait.js";
import {randomUUID} from 'node:crypto';
import {beforeEach,describe,it,expect} from 'vitest';
import type {SystemActionId} from '@rainver/protocol';
import type {RunRecord} from '../src/modules/runs/repository.js';
import type {SystemActionExecutor} from '../src/modules/systemActions/gateway.js';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {InquiryTaskAssociationService} from '../src/modules/inquiry/taskAssociations.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
import {registerProjectWorkSystemActionExecutors} from '../src/modules/projectWork/projectWorkSystemActionExecutors.js';
import {resolveAgentActorId} from '../src/db/actorResolver.js';
import {setTaskStatus} from '../src/modules/projectWork/taskActions.js';
import {getTaskWorkView} from '../src/modules/projectWork/boardReadModel.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,thread:string,agent:string,room:string,run:RunRecord;
const identity=()=>({spaceId:space,userId:owner});
const repo=()=>new PgTaskRepository(db.pool);
const service=()=>new InquiryTaskAssociationService(db.pool);
const ref=(id=thread,role='investigates')=>({entity_type:'inquiry_thread',entity_id:id,role});
const dispatch=(id:string)=>({idempotency_key:id} as never);
function tools(){const map=new Map<SystemActionId,SystemActionExecutor>();registerProjectWorkSystemActionExecutors(map,{databaseUrl:db.connectionUri} as never,run);return map;}
const command=(key:string,extra:Record<string,unknown>)=>({idempotency_key:key,reason:'Follow the requested work',role:'investigates',...extra});
const revision=async(id=thread)=>(await db.pool.query(`SELECT problem_revision FROM inquiry_threads WHERE object_id=$1`,[id])).rows[0].problem_revision;
beforeEach(async()=>{
 if(!db.available)return;await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();agent=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 thread=String((await new InquiryThreadService(db.pool).createThread(identity(),project,{kind:'question',statement:'What causes the failure?'})).id);
 const id=randomUUID();await seedRun(db.pool,{id,space,owner,agent,version:randomUUID()});
 room=(await db.pool.query(`SELECT id FROM rooms WHERE project_id=$1 AND space_id=$2 LIMIT 1`,[project,space])).rows[0].id;
 const session=randomUUID();await db.pool.query(`INSERT INTO sessions(id,space_id,room_id,project_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'Room turn','active',now(),now())`,[session,space,room,project]);
 await db.pool.query(`UPDATE runs SET project_id=$2,instructed_by_user_id=$3,session_id=$4 WHERE id=$1`,[id,project,owner,session]);
 run=(await db.pool.query(`SELECT * FROM runs WHERE id=$1`,[id])).rows[0];
});
describe('P4 targeted repair, real PostgreSQL',()=>{
 it('shares a valid Room Run creation with other Project members but keeps human creation private',async()=>{
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,peer]);
  await db.pool.query(`INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,room,peer]);
  const shared=await service().link(identity(),project,thread,command('room',{task:{title:'Room work'}}),{runId:run.id,agentId:agent});
  const privateTask=await service().link(identity(),project,thread,command('human',{task:{title:'Private work'}}));
  expect((await repo().getTask(identity(),String(shared.task_id)))?.visibility).toBe('space_shared');expect((await repo().getTask(identity(),String(privateTask.task_id)))?.visibility).toBe('private');
  const pi={spaceId:space,userId:peer};expect((await service().tasks(pi,project,thread)).items.map(t=>t.id)).toEqual([shared.task_id]);
  expect(await repo().findReadableTask(pi,String(privateTask.task_id))).toBeNull();
  const existing=await repo().createTask(identity(),{project_id:project,title:'Existing private Task'});
  await service().link(identity(),project,thread,command('existing',{task_id:existing.id}),{runId:run.id,agentId:agent});expect(await repo().findReadableTask(pi,existing.id)).toBeNull();
 });
 it('uses one fact writer for repository create/update, single tool, batch and Inquiry with exact revision/event dedupe',async()=>{
  const before=await revision(),map=tools();
  const a=await repo().createTask(identity(),{project_id:project,title:'Repository create',links:[ref()]});
  await repo().updateTask(identity(),a.id,{links:[ref(thread,'prepares')]});
  await repo().updateTask(identity(),a.id,{links:[ref(thread,'prepares')]});
  await service().link(identity(),project,thread,command('same',{task_id:a.id}));
  await map.get('task.create')!({title:'Single tool',links:[ref()]},dispatch('single'));
  const batch=map.get('task.create_batch')!;const input={request_summary:'Create the requested list',tasks:[{title:'Batch one',links:[ref()]},{title:'Batch two',links:[ref()]}]};
  await batch(input,dispatch('batch'));await batch(input,dispatch('retry'));
  await batch({request_summary:'Link the existing requested item',tasks:[{title:'Batch one',links:[ref(thread,'executes')]}]},dispatch('existing-new-role'));
  expect(await revision()).toBe(before+6);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM project_work_events WHERE subject_id=$1 AND event_kind='thread.work_recorded' AND data_json->>'work_kind'='link_task'`,[thread])).rows[0].n).toBe(6);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM project_work_events WHERE space_id=$1 AND event_kind='task.entity_linked'`,[space])).rows[0].n).toBe(6);
 });
 it.each(['archived','resolved'])('rejects %s Thread writes on every entry while retaining existing history and atomic batches',async(lifecycle)=>{
  const archived=String((await new InquiryThreadService(db.pool).createThread(identity(),project,{kind:'question',statement:'Closed problem'})).id);
  const old=await repo().createTask(identity(),{project_id:project,title:'Historical Task',links:[ref(archived)]});
  await db.pool.query(`UPDATE inquiry_threads SET lifecycle_status=$2,attention_state=$2 WHERE object_id=$1`,[archived,lifecycle]);
  const baseline=await revision(),beforeCounts=async()=> (await db.pool.query(`SELECT (SELECT count(*) FROM tasks WHERE space_id=$1) AS tasks,(SELECT count(*) FROM task_entity_links WHERE space_id=$1) AS links,(SELECT count(*) FROM project_work_events WHERE space_id=$1) AS events`,[space])).rows[0];const before=await beforeCounts();
  await expect(repo().createTask(identity(),{project_id:project,title:'Rejected repository',links:[ref(),ref(archived)]})).rejects.toMatchObject({statusCode:409});
  await expect(repo().updateTask(identity(),old.id,{links:[ref(archived,'prepares')]})).rejects.toMatchObject({statusCode:409});
  await expect(service().link(identity(),project,archived,command('closed',{task_id:old.id}))).rejects.toMatchObject({statusCode:409});
  const map=tools();await expect(map.get('task.create')!({title:'Rejected single',links:[ref(archived)]},dispatch('closed-single'))).rejects.toMatchObject({statusCode:409});
  await expect(map.get('task.create_batch')!({request_summary:'Two requested items',tasks:[{title:'Valid first',links:[ref()]},{title:'Rejected later',links:[ref(archived)]}]},dispatch('closed-batch'))).rejects.toMatchObject({statusCode:409});
  expect(await beforeCounts()).toEqual(before);expect(await revision()).toBe(baseline);
  expect((await service().tasks(identity(),project,archived)).items[0].id).toBe(old.id);expect((await service().threads(identity(),old.id)).items[0].lifecycle_status).toBe(lifecycle);
 });
 it('serializes all existing-task linking entries into one edge and one problem advancement',async()=>{
  const task=await repo().createTask(identity(),{project_id:project,title:'Concurrent work'}),before=await revision();
  await Promise.all([service().link(identity(),project,thread,command('concurrent',{task_id:task.id})),repo().updateTask(identity(),task.id,{links:[ref()]}),tools().get('task.create_batch')!({request_summary:'Link the requested existing Task',tasks:[{title:task.title,links:[ref()]}]},dispatch('concurrent-batch'))]);
  expect(await revision()).toBe(before+1);expect((await db.pool.query(`SELECT count(*)::int AS n FROM task_entity_links WHERE task_id=$1`,[task.id])).rows[0].n).toBe(1);
 });
 it('keeps generic repository links behind both full-content gates and Project scope with rollback',async()=>{
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,peer]);
  const pi={spaceId:space,userId:peer};await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`,[thread]);
  await expect(repo().createTask(pi,{project_id:project,title:'Cannot link private problem',links:[ref()]})).rejects.toMatchObject({statusCode:404});
  await db.pool.query(`UPDATE space_objects SET visibility='space_shared',access_level='summary' WHERE id=$1`,[thread]);
  await expect(repo().createTask(pi,{project_id:project,title:'Cannot link summary problem',links:[ref()]})).rejects.toMatchObject({statusCode:404});
  await db.pool.query(`UPDATE space_objects SET access_level='full' WHERE id=$1`,[thread]);
  const task=await repo().createTask(identity(),{project_id:project,title:'Summary Task',visibility:'space_shared'});await db.pool.query(`UPDATE tasks SET access_level='summary' WHERE id=$1`,[task.id]);
  await expect(repo().updateTask(pi,task.id,{title:'Must roll back',links:[ref()]})).rejects.toMatchObject({statusCode:404});expect((await repo().getTask(identity(),task.id))?.title).toBe('Summary Task');
  const otherProject=randomUUID();await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other','active',now(),now())`,[otherProject,space,owner]);
  const other=String((await new InquiryThreadService(db.pool).createThread(identity(),otherProject,{kind:'question',statement:'Other Project'})).id);
  await expect(repo().createTask(identity(),{project_id:project,title:'Wrong Project',links:[ref(other)]})).rejects.toMatchObject({statusCode:404});
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE space_id=$1`,[space])).rows[0].n).toBe(1);
 });
 it('linearizes generic Task creation against Thread lifecycle without admitting work after archive',async()=>{
  const client=await db.pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await client.query('BEGIN');await new InquiryIterationService(client).transitionLifecycle(identity(),project,thread,{lifecycle_status:'archived',reason:'Stop this problem'});
   const result=repo().createTask(identity(),{project_id:project,title:'Too late',links:[ref()]}).then(()=>({ok:true}),error=>({ok:false,error}));pending=result;
   await waitForLockWaiter(db.pool);await client.query('COMMIT');const settled=await result;expect(settled).toMatchObject({ok:false,error:{statusCode:409}});
   expect((await db.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE space_id=$1`,[space])).rows[0].n).toBe(0);
  }finally{await client.query('ROLLBACK');client.release();if(pending)await pending;}
 });
 it('persists and clears blockers across state paths, preserves person responsibility, and applies existing terminal/acceptance rules',async()=>{
  const task=await repo().createTask(identity(),{project_id:project,title:'Status work',assigned_agent_id:agent});
  const actorId=await resolveAgentActorId(db.pool,space,agent);const context={spaceId:space,actorId,agentId:agent,runId:run.id,instructedByUserId:owner,projectId:project,idempotencyKey:'status'};
  const move=(status:string,reason:string)=>setTaskStatus(db.pool,{...context,idempotencyKey:randomUUID()},{task_id:task.id,status,reason});
  await move('blocked','Waiting for a fixture');expect((await repo().getTask(identity(),task.id))?.blocked_reason).toBe('Waiting for a fixture');expect((await getTaskWorkView(db.pool,identity(),task.id)).responsible.kind).toBe('user');
  await move('blocked','Waiting for a credential');await move('blocked','Waiting for a credential');expect((await db.pool.query(`SELECT count(*)::int AS n FROM project_work_events WHERE subject_id=$1 AND data_json->>'change'='blocked_reason'`,[task.id])).rows[0].n).toBe(1);
  await move('ready','Fixture available');expect((await repo().getTask(identity(),task.id))?.blocked_reason).toBeNull();
  await move('blocked','Need a decision');await move('waiting_for_review','Choose the approach');expect((await repo().getTask(identity(),task.id))?.blocked_reason).toBeNull();
  await move('ready','Approved');await move('cancelled','No longer requested');expect((await repo().getTask(identity(),task.id))?.cancelled_at).not.toBeNull();await expect(move('done','Cannot finish a cancellation')).rejects.toMatchObject({statusCode:409});
  await move('ready','Explicitly resume');expect((await repo().getTask(identity(),task.id))?.cancelled_at).toBeNull();await move('blocked','Check result');await move('done','Result accepted');expect((await repo().getTask(identity(),task.id))?.blocked_reason).toBeNull();
  await move('ready','Explicitly reopen');expect((await repo().getTask(identity(),task.id))?.completed_at).toBeNull();
  await repo().updateTask(identity(),task.id,{required_outputs_json:['report']});await expect(move('done','Missing output')).rejects.toMatchObject({statusCode:422});
 });
 it('records server Run dispatch as one atomic flow transition and rolls everything back if its event fails',async()=>{
  const task=await repo().createTask(identity(),{project_id:project,title:'Dispatch me',status:'ready'});
  const first=await repo().createTaskRun(identity(),task.id,{agent_id:agent});expect((await repo().getTask(identity(),task.id))?.status).toBe('in_progress');
  let events=(await db.pool.query(`SELECT data_json FROM project_work_events WHERE subject_id=$1 AND event_kind='task.flow_changed' AND data_json->>'to'='in_progress'`,[task.id])).rows;expect(events).toHaveLength(1);expect(events[0].data_json.run_id).toBe(first.id);
  await db.pool.query(`UPDATE runs SET status='succeeded',runtime_profile_id=COALESCE(runtime_profile_id,requested_runtime_profile_id),runtime_profile_selection_source=COALESCE(runtime_profile_selection_source,'explicit'),runtime_key=(SELECT runtime_key FROM agent_runtime_profiles WHERE id=COALESCE(runs.runtime_profile_id,runs.requested_runtime_profile_id)),runtime_profile_snapshot_json=COALESCE(runtime_profile_snapshot_json,'{}'::jsonb) WHERE id=$1`,[first.id]);
  await repo().createTaskRun(identity(),task.id,{agent_id:agent});expect((await db.pool.query(`SELECT id FROM project_work_events WHERE subject_id=$1 AND event_kind='task.flow_changed' AND data_json->>'to'='in_progress'`,[task.id])).rowCount).toBe(1);
  const other=await repo().createTask(identity(),{project_id:project,title:'Rollback dispatch',status:'ready'});
  await db.pool.query(`CREATE FUNCTION reject_dispatch_flow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_kind='task.flow_changed' AND NEW.data_json->>'to'='in_progress' THEN RAISE EXCEPTION 'dispatch_event_failed'; END IF; RETURN NEW; END $$`);await db.pool.query(`CREATE TRIGGER reject_dispatch_flow BEFORE INSERT ON project_work_events FOR EACH ROW EXECUTE FUNCTION reject_dispatch_flow()`);
  try{await expect(repo().createTaskRun(identity(),other.id,{agent_id:agent})).rejects.toThrow('dispatch_event_failed');expect((await repo().getTask(identity(),other.id))?.status).toBe('ready');expect((await db.pool.query(`SELECT id FROM task_runs WHERE task_id=$1`,[other.id])).rowCount).toBe(0);}finally{await db.pool.query(`DROP TRIGGER reject_dispatch_flow ON project_work_events`);await db.pool.query(`DROP FUNCTION reject_dispatch_flow()`);}
 });
});
