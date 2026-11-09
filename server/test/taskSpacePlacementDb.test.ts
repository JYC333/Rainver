import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {tasksModule} from '../src/modules/tasks/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,taskId:string,boardId:string,columnId:string;
let app:ReturnType<typeof buildModuleServer>;
const identity=()=>({spaceId:space,userId:owner});
const formal=(changes:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/tasks/${taskId}/space-board-placement`,headers:{'idempotency-key':key},payload:{changes}});
const generic=(changes:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/task.place_in_space_board',headers:{'idempotency-key':key},payload:{task_id:taskId,changes}});
const row=async()=> (await db.pool.query('SELECT title,project_id,board_id,column_id,status,updated_at FROM tasks WHERE id=$1',[taskId])).rows[0];
beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users'],{cascade:true});
  space=randomUUID();owner=randomUUID();project=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space,owner,project});
  const repository=new PgTaskRepository(db.pool);
  taskId=(await repository.createTask(identity(),{title:'Standalone',visibility:'private'})).id;
  boardId=(await repository.createBoard(identity(),{name:'Space board'})).id;
  columnId=(await db.pool.query("SELECT id FROM board_columns WHERE board_id=$1 AND status_key='in_progress'",[boardId])).rows[0]!.id;
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[tasksModule,systemActionsModule]);
  __setAuthIdentityForTests(identity());
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('commits placement with contract edits once and shares formal/generic replay',async()=>{
  const key=randomUUID(),changes={board_id:boardId,column_id:columnId,title:'Edited together',max_runs:3,tags:['keep']};
  const one=await formal(changes,key);expect(one.statusCode,one.body).toBe(200);
  expect(one.json().data).toMatchObject({task_id:taskId,board_id:boardId,column_id:columnId,status:'in_progress'});
  expect(one.headers['cache-control']).toContain('no-store');
  const after=await row();
  expect((await generic(changes,key)).json()).toEqual(one.json());expect(await row()).toEqual(after);
  expect((await generic({...changes,title:'Changed'},key)).json().error.code).toBe('idempotency_key_reused');
  const next=await new PgTaskRepository(db.pool).createBoard(identity(),{name:'Next board'});
  expect((await formal({board_id:next.id})).json().data).toMatchObject({board_id:next.id,column_id:null,status:'in_progress'});
  expect((await formal({board_id:null,column_id:null})).json().data).toMatchObject({board_id:null,column_id:null});
});
it('closes raw PATCH placement and refuses Project/reparent/lifecycle bypass',async()=>{
  expect((await app.inject({method:'PATCH',url:`/api/v1/tasks/${taskId}`,payload:{board_id:boardId,title:'Bypass'}})).statusCode).toBe(422);
  for(const changes of [{board_id:boardId,project_id:project},{board_id:boardId,status:'done'},{board_id:boardId,deleted_at:new Date().toISOString()}])expect((await formal(changes)).statusCode).toBe(422);
  expect((await row()).title).toBe('Standalone');
  await db.pool.query('UPDATE tasks SET project_id=$2 WHERE id=$1',[taskId,project]);
  expect((await formal({board_id:boardId})).statusCode).toBe(404);
});
it('rechecks current read authority on replay and hides foreign or Project destinations',async()=>{
  const key=randomUUID(),changes={board_id:boardId};expect((await formal(changes,key)).statusCode).toBe(200);
  const stranger=randomUUID();await seedSpaceMember(db.pool,{space,user:stranger});
  __setAuthIdentityForTests({spaceId:space,userId:stranger});expect((await formal(changes,key)).statusCode).toBe(404);
  __setAuthIdentityForTests(identity());
  await db.pool.query('UPDATE boards SET project_id=$2 WHERE id=$1',[boardId,project]);
  expect((await formal(changes)).statusCode).toBe(404);
  expect((await formal({board_id:randomUUID()})).statusCode).toBe(404);
  await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await formal(changes,key)).statusCode).toBe(404);
});
it('does not turn a concurrent Task reparent into a Project write',async()=>{
  const client=await db.pool.connect();let pending:Promise<unknown>|undefined;
  try{
    await client.query('BEGIN');await client.query('UPDATE tasks SET project_id=$2 WHERE id=$1',[taskId,project]);
    pending=Promise.resolve(formal({board_id:boardId,title:'Unsafe reparent'}));
    await waitForLockWaiter(db.pool);await client.query('COMMIT');
    expect((await pending as {statusCode:number}).statusCode).toBe(404);
    expect(await row()).toMatchObject({title:'Standalone',project_id:project,board_id:null});
  }finally{await client.query('ROLLBACK');client.release();await pending;}
});
it('refuses a concurrent same-key placement, then replays the committed contract without another write',async()=>{
  const client=await db.pool.connect(),key=randomUUID(),changes={board_id:boardId,title:'Once'};
  let pending:ReturnType<typeof formal>|undefined;
  try{
    await client.query('BEGIN');await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
    pending=formal(changes,key);await waitForLockWaiter(db.pool);
    const busy=await generic(changes,key);expect(busy.statusCode,busy.body).toBe(409);expect(busy.json().error.code).toBe('idempotency_in_progress');
    await client.query('COMMIT');const first=await pending;expect(first.statusCode,first.body).toBe(200);
    const saved=await row();expect((await generic(changes,key)).json()).toEqual(first.json());expect(await row()).toEqual(saved);
  }finally{await client.query('ROLLBACK');client.release();await pending;}
});
it('keeps the stored completion gate even when a placement request also edits the contract',async()=>{
  await db.pool.query('UPDATE tasks SET required_outputs_json=$2::jsonb WHERE id=$1',[taskId,JSON.stringify(['report'])]);
  const before=await row();
  const done=(await db.pool.query("SELECT id FROM board_columns WHERE board_id=$1 AND status_key='done'",[boardId])).rows[0]!.id;
  const refused=await formal({column_id:done,required_outputs_json:[],title:'Premature'});
  expect(refused.statusCode,refused.body).toBe(422);expect(refused.json().error.metadata.code).toBe('completion_requirements_unmet');
  expect(await row()).toEqual(before);
  expect((await db.pool.query('SELECT required_outputs_json FROM tasks WHERE id=$1',[taskId])).rows[0]!.required_outputs_json).toEqual(['report']);
});
it('rolls back metadata, placement and receipt when required audit storage fails',async()=>{
  await db.pool.query("CREATE FUNCTION refuse_space_placement_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='task.column.move' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER refuse_space_placement_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_space_placement_audit()');
  try{
    expect((await formal({board_id:boardId,title:'No partial'})).statusCode).toBe(503);
    expect(await row()).toMatchObject({title:'Standalone',board_id:null});
    expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);
  }finally{await db.pool.query('DROP TRIGGER refuse_space_placement_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_space_placement_audit()');}
});
it('rolls back the writer if storing its success receipt fails',async()=>{
  const before=await row();
  await db.pool.query("CREATE FUNCTION refuse_space_placement_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id='task.place_in_space_board' AND NEW.state='succeeded' THEN RAISE EXCEPTION 'receipt unavailable'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER refuse_space_placement_receipt BEFORE INSERT OR UPDATE ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_space_placement_receipt()');
  try{
    expect((await formal({board_id:boardId,column_id:columnId,title:'No partial receipt'})).statusCode).toBe(500);
    expect(await row()).toEqual(before);
    expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);
  }finally{await db.pool.query('DROP TRIGGER refuse_space_placement_receipt ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_space_placement_receipt()');}
});
