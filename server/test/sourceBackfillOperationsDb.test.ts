import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {ProjectSourceBindingRepository} from '../src/modules/projects/projectSourceBindingRepository.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,connection:string,channel:string,otherChannel:string;
let app:ReturnType<typeof buildModuleServer>;
const base=()=>`/api/v1/sources/channels/${channel}/backfill/plans`;
const payload=(extra:object={})=>({idempotency_key:randomUUID(),strategy:{from:'2026-01-01',to:'2026-03-01',max_items:5},...extra});
const create=(body:object,key=randomUUID())=>app.inject({method:'POST',url:base(),payload:body,headers:{'idempotency-key':key}});
const generic=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
const control=(plan:string,kind:string,key=randomUUID())=>app.inject({method:'POST',url:`${base()}/${plan}/${kind}`,headers:{'idempotency-key':key}});
const rows=async()=>({plans:(await db.pool.query('SELECT id FROM source_backfill_plans ORDER BY id')).rows,segments:(await db.pool.query('SELECT id FROM source_backfill_segments ORDER BY id')).rows});
beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
  space=randomUUID();owner=randomUUID();project=randomUUID();connection=randomUUID();channel=randomUUID();otherChannel=randomUUID();
  const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
  await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel:[{id:channel,fingerprint:'one'},{id:otherChannel,fingerprint:'two'}],space,owner,now});
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  await operationRuntime(config);
  app=buildModuleServer(config,[sourcesModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('previews through the formal query without a key or business mutation',async()=>{
  const before=await rows(),body={strategy:{from:'2026-01-01',to:'2026-03-01',max_items:'5'}};
  const result=await app.inject({method:'POST',url:base()+'/preview',payload:body});
  expect(result.statusCode,result.body).toBe(200);expect(result.json().data.strategy).toMatchObject({max_items:5,direction:'backward'});
  const query=await app.inject({method:'GET',url:'/api/v1/queries/source.backfill.preview?input='+encodeURIComponent(JSON.stringify({...body,source_channel_id:channel}))});
  expect(query.statusCode,query.body).toBe(200);expect(query.json().data).toEqual(result.json().data);
  expect(await rows()).toEqual(before);expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);
});
it('shares create receipts across REST/generic and retains separate domain uniqueness',async()=>{
  const body=payload(),key=randomUUID(),first=await create(body,key);
  expect(first.statusCode,first.body).toBe(201);const id=first.json().data.plan_id;
  const saved=await rows();
  expect((await generic('source.backfill.create_plan',{...body,source_channel_id:channel,project_operation_id:null,project_source_binding_id:null},key)).json()).toEqual(first.json());
  expect(await rows()).toEqual(saved);
  expect((await generic('source.backfill.create_plan',{...body,strategy:{...body.strategy,max_items:7},source_channel_id:channel},key)).json().error.code).toBe('idempotency_key_reused');
  expect((await create({...body,strategy:{...body.strategy,max_items:9}})).json().data.plan_id).toBe(id);
  expect(await rows()).toEqual(saved);
  const conflict=await generic('source.backfill.create_plan',{...body,source_channel_id:otherChannel});
  expect(conflict.statusCode,conflict.body).toBe(409);expect(conflict.json().error.code).toBe('operation_conflict');
  expect((await app.inject({method:'POST',url:base(),payload:body})).statusCode).toBe(422);
});
it('pauses/resumes only approved plans, preserving replay and terminal conflicts',async()=>{
  const first=await create(payload());expect(first.statusCode,first.body).toBe(201);const id=first.json().data.plan_id;
  expect((await control(id,'pause')).statusCode).toBe(409);
  // Fixture represents the separately approved start; no planning endpoint approves it.
  await db.pool.query("UPDATE source_backfill_plans SET status='approved' WHERE id=$1",[id]);
  const key=randomUUID(),paused=await control(id,'pause',key);expect(paused.statusCode,paused.body).toBe(200);expect(paused.json().data.status).toBe('paused');
  expect((await generic('source.backfill.pause',{source_channel_id:channel,source_backfill_plan_id:id},key)).json()).toEqual(paused.json());
  expect((await control(id,'resume')).json().data.status).toBe('approved');
  await db.pool.query("UPDATE source_backfill_plans SET status='completed' WHERE id=$1",[id]);expect((await control(id,'resume')).statusCode).toBe(409);
});
it('hides private/currently revoked Source authority, including original-key replay',async()=>{
  const body=payload(),key=randomUUID(),first=await create(body,key);expect(first.statusCode,first.body).toBe(201);
  const stranger=randomUUID();await seedSpaceMember(db.pool,{space,user:stranger});__setAuthIdentityForTests({spaceId:space,userId:stranger});
  expect((await create(body,key)).statusCode).toBe(404);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
  await db.pool.query("UPDATE source_channels SET status='archived' WHERE id=$1",[channel]);
  expect((await create(body,key)).statusCode).toBe(404);
  expect((await generic('source.backfill.pause',{source_channel_id:otherChannel,source_backfill_plan_id:first.json().data.plan_id})).statusCode).toBe(404);
});
it('refuses concurrent same-key creation before a second set of segments',async()=>{
  const client=await db.pool.connect(),body=payload(),key=randomUUID();let pending:ReturnType<typeof create>|undefined;
  try{
    await client.query('BEGIN');await client.query('SELECT id FROM source_channels WHERE id=$1 FOR UPDATE',[channel]);
    pending=create(body,key);await waitForLockWaiter(db.pool);
    const second=await create(body,key);expect(second.statusCode,second.body).toBe(409);expect(second.json().error.code).toBe('idempotency_in_progress');
    await client.query('COMMIT');const first=await pending;expect(first.statusCode,first.body).toBe(201);
    const before=await rows();expect((await create(body,key)).json()).toEqual(first.json());expect(await rows()).toEqual(before);
  }finally{await client.query('ROLLBACK');client.release();await pending;}
});
it.each(['source_backfill_segments','operation_idempotency','policy_decision_records'])('rolls back plan/segments/receipt if %s storage refuses',async table=>{
  await db.pool.query(`CREATE FUNCTION refuse_backfill_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'backfill storage refused'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_backfill_store BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_backfill_store()`);
  try{
    const response=await create(payload());expect(response.statusCode,response.body).toBe(table==='policy_decision_records'?503:500);
    expect(await rows()).toEqual({plans:[],segments:[]});expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);
  }finally{await db.pool.query(`DROP TRIGGER refuse_backfill_store ON ${table}`);await db.pool.query('DROP FUNCTION refuse_backfill_store()');}
});

it('pins Project scope and rechecks writer authority on original-key replay',async()=>{
  const binding=await new ProjectSourceBindingRepository(db.pool).createProjectSourceBinding({spaceId:space,userId:owner},{source_channel_id:channel,project_id:project});
  const body=payload({project_source_binding_id:binding.id}),key=randomUUID();
  const first=await create(body,key);expect(first.statusCode,first.body).toBe(201);
  const id=first.json().data.plan_id,before=await rows();
  expect((await create({...body,project_source_binding_id:randomUUID()})).statusCode).toBe(404);
  // A domain key cannot return a receipt from another authorized Project scope.
  expect((await create({...body,project_source_binding_id:null})).statusCode).toBe(409);
  await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
  expect((await create(body,key)).statusCode).toBe(409);
  await db.pool.query("UPDATE projects SET status='active' WHERE id=$1",[project]);
  const successor=randomUUID();await seedSpaceMember(db.pool,{space,user:successor});
  await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[project,successor]);
  await db.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project,owner]);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await create(body,key)).statusCode).toBe(404);
  expect((await control(id,'pause')).statusCode).toBe(404);
  expect(await rows()).toEqual(before);
});
it('links a plan to its Project operation in the same core transaction',async()=>{
  const binding=await new ProjectSourceBindingRepository(db.pool).createProjectSourceBinding({spaceId:space,userId:owner},{source_channel_id:channel,project_id:project});
  const operation=randomUUID();
  await db.pool.query("INSERT INTO project_operations(id,space_id,project_id,kind,title,status,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'source_backfill','History','active',$4,now(),now())",[operation,space,project,owner]);
  const result=await create(payload({project_source_binding_id:binding.id,project_operation_id:operation}));
  expect(result.statusCode,result.body).toBe(201);
  expect((await db.pool.query("SELECT target_id FROM project_operation_links WHERE operation_id=$1 AND target_type='source_backfill_plan'",[operation])).rows).toEqual([{target_id:result.json().data.plan_id}]);
  const wrongChannel=await generic('source.backfill.create_plan',{...payload({project_source_binding_id:binding.id}),source_channel_id:otherChannel});
  expect(wrongChannel.statusCode).toBe(404);
});
it.each(['pause','resume'])('rolls back %s if the core receipt cannot be stored',async kind=>{
  const created=await create(payload());expect(created.statusCode,created.body).toBe(201);
  const id=created.json().data.plan_id,status=kind==='pause'?'approved':'paused';
  await db.pool.query('UPDATE source_backfill_plans SET status=$2 WHERE id=$1',[id,status]);
  const before=(await db.pool.query('SELECT status,updated_at FROM source_backfill_plans WHERE id=$1',[id])).rows;
  await db.pool.query(`CREATE FUNCTION refuse_control_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt refused'; END $$`);
  await db.pool.query('CREATE TRIGGER refuse_control_receipt BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_control_receipt()');
  try{
    expect((await control(id,kind)).statusCode).toBe(500);
    expect((await db.pool.query('SELECT status,updated_at FROM source_backfill_plans WHERE id=$1',[id])).rows).toEqual(before);
  }finally{await db.pool.query('DROP TRIGGER refuse_control_receipt ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_control_receipt()');}
});
it('rejects conflicting path authority and unknown nested fields without writing',async()=>{
  for(const body of [payload({source_channel_id:channel}),payload({strategy:{direction:'forward'}}),payload({quota_policy:{window:'minute',limit_count:1,unbounded:true}})]){
    expect((await create(body)).statusCode).toBe(422);
  }
  expect(await rows()).toEqual({plans:[],segments:[]});
});
