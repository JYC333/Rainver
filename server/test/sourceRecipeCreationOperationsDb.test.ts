import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedCustomSourceWorld} from './support/customSourceWorld.js';
import {seedProjectMainlineRoom,seedSpaceMember} from './support/domainSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {buildRecipeForSourceType} from '../src/modules/sources/sourceRecipes/recipePlanner.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {OperationExecutor} from '../src/modules/systemActions/operations/executor.js';
const db=useTestDatabase(import.meta.filename);
let team:string,personal:string,owner:string,project:string,app:ReturnType<typeof buildModuleServer>,config:ReturnType<typeof loadConfig>;
const body={name:'Private feed',endpoint_url:'https://fixture.test/rss',source_type:'rss',fetch_frequency:'daily',capture_policy:'reference_only',retention_policy:'metadata_only'};
const create=(input:object=body,key=randomUUID(),generic=false)=>app.inject({method:'POST',url:generic?'/api/v1/actions/source.recipe.create':'/api/v1/sources/source-recipes',payload:input,headers:{'idempotency-key':key}});
const counts=async()=>({connections:(await db.pool.query('SELECT id,space_id,status,visibility,project_id FROM source_connections ORDER BY id')).rows,channels:(await db.pool.query('SELECT id,space_id,status FROM source_channels ORDER BY id')).rows,recipes:(await db.pool.query('SELECT id,space_id,status FROM source_recipe_versions ORDER BY id')).rows,tasks:(await db.pool.query('SELECT id,space_id,status FROM scheduler_tasks ORDER BY id')).rows,requests:(await db.pool.query('SELECT id,space_id FROM operation_idempotency ORDER BY id')).rows});
async function addPersonal(){const id=randomUUID();await db.pool.query("INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Personal','personal',$2,now(),now())",[id,owner]);await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),id,owner]);return id;}
beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users','source_provider_connectors','source_providers','source_connectors'],{cascade:true});
  team=randomUUID();owner=randomUUID();project=randomUUID();await seedCustomSourceWorld(db.pool,{spaceId:team,userId:owner});personal=await addPersonal();
  await db.pool.query("INSERT INTO projects(id,space_id,name,owner_user_id,status,created_at,updated_at) VALUES($1,$2,'Research',$3,'active',now(),now())",[project,team,owner]);await seedProjectMainlineRoom(db.pool,{space:team,project,owner});
  config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});app=buildModuleServer(config,[sourcesModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:team,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('creates private content in the owner Personal Space from a team page, with receipt/audit/scheduler in the same Space',async()=>{
  const key=randomUUID(),result=await create({...body,visibility:'space_shared'},key);expect(result.statusCode,result.body).toBe(201);
  const data=result.json().data;expect(data.connection).toMatchObject({space_id:personal,status:'paused',handler_kind:'recipe'});expect(data.recipe_version.status).toBe('draft');
  const saved=await counts();expect(saved.connections).toEqual([expect.objectContaining({id:data.connection.id,space_id:personal,visibility:'private',project_id:null,status:'paused'})]);
  for(const rows of Object.values(saved))expect(rows).toHaveLength(1);
  for(const rows of Object.values(saved))expect(rows[0]?.space_id).toBe(personal);
  const audits=(await db.pool.query("SELECT space_id,actor_id,metadata_json FROM policy_decision_records WHERE action='source.recipe.create'")).rows;
  expect(audits).toHaveLength(1);expect(audits[0]).toMatchObject({space_id:personal,actor_id:owner,metadata_json:{request_space_id:team}});
  __setAuthIdentityForTests({spaceId:personal,userId:owner});expect((await create({...body,visibility:'space_shared'},key,true)).json()).toEqual(result.json());expect(await counts()).toEqual(saved);
});
it('creates a Project draft shared in its actual Space, without using Personal placement',async()=>{
  const result=await create({...body,project_id:project,visibility:'private'});expect(result.statusCode,result.body).toBe(201);
  expect((await counts()).connections).toEqual([expect.objectContaining({space_id:team,project_id:project,visibility:'space_shared'})]);
});
it('uses the target Space creator policy rather than the browsed Space policy',async()=>{
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1",[team]);expect((await create()).statusCode).toBe(201);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1",[personal]);expect((await create({...body,name:'Another'})).statusCode).toBe(404);
  expect((await counts()).connections).toHaveLength(1);
});
it('rejects forged Space/actor authority, missing keys and unknown creation fields before writes',async()=>{
  for(const extra of [{space_id:team},{owner_user_id:randomUUID()},{_force_create:false},{status:'active'}])expect((await create({...body,...extra})).statusCode).toBe(422);
  expect((await app.inject({method:'POST',url:'/api/v1/actions/source.recipe.create',payload:body})).statusCode).toBe(422);expect((await counts()).connections).toEqual([]);
});
it('fails closed when Personal placement is absent or ambiguous instead of falling back to a team Space',async()=>{
  await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1",[personal]);expect((await create()).statusCode).toBe(409);
  await db.pool.query("UPDATE space_memberships SET status='active' WHERE space_id=$1",[personal]);await addPersonal();expect((await create()).statusCode).toBe(409);expect((await counts()).connections).toEqual([]);
});
it('hides foreign Projects and revoked Project read scope while rejecting archived Projects without partial creation',async()=>{
  expect((await create({...body,project_id:randomUUID()})).statusCode).toBe(404);
  const member=randomUUID();await seedSpaceMember(db.pool,{space:team,user:member});__setAuthIdentityForTests({spaceId:team,userId:member});expect((await create({...body,project_id:project})).statusCode).toBe(404);
  __setAuthIdentityForTests({spaceId:team,userId:owner});await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);expect((await create({...body,project_id:project})).statusCode).toBe(404);expect((await counts()).connections).toEqual([]);
});
it('rechecks both request membership and target membership on replay',async()=>{
  const key=randomUUID();expect((await create(body,key)).statusCode).toBe(201);
  await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1",[team]);expect((await create(body,key)).statusCode).toBe(404);
  await db.pool.query("UPDATE space_memberships SET status='active' WHERE space_id=$1",[team]);await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1",[personal]);expect((await create(body,key)).statusCode).toBe(409);
});
it('does not replay previously visible content after the Source is deleted',async()=>{
  const key=randomUUID();const made=await create(body,key);expect(made.statusCode,made.body).toBe(201);await db.pool.query('UPDATE source_connections SET deleted_at=now() WHERE id=$1',[made.json().data.connection.id]);expect((await create(body,key)).statusCode).toBe(404);
});
it('serializes the same target key across formal/generic requests without duplicating the draft',async()=>{
  const hold=await db.pool.connect(),key=randomUUID();let pending:ReturnType<typeof create>|undefined;
  try{await hold.query('BEGIN');await hold.query('SELECT id FROM space_memberships WHERE space_id=$1 FOR UPDATE',[personal]);pending=create(body,key);await waitForLockWaiter(db.pool);expect((await create(body,key,true)).statusCode).toBe(409);await hold.query('COMMIT');expect((await pending).statusCode).toBe(201);expect((await counts()).connections).toHaveLength(1);}
  finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it('rechecks target membership after waiting rather than writing under revoked access',async()=>{
  const hold=await db.pool.connect();let pending:ReturnType<typeof create>|undefined;
  try{await hold.query('BEGIN');await hold.query('SELECT id FROM space_memberships WHERE space_id=$1 FOR UPDATE',[personal]);pending=create();await waitForLockWaiter(db.pool);await hold.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1",[personal]);await hold.query('COMMIT');expect((await pending).statusCode).toBe(404);expect((await counts()).connections).toEqual([]);}
  finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it('refuses placement drift between discovery and admission without late rebinding the key',async()=>{
  const hold=await db.pool.connect();let pending:ReturnType<typeof create>|undefined;
  try{await hold.query('BEGIN');await hold.query('SELECT id FROM space_memberships WHERE space_id=$1 FOR UPDATE',[team]);pending=create();await waitForLockWaiter(db.pool);await addPersonal();await hold.query('COMMIT');expect((await pending).statusCode).toBe(409);expect((await counts()).connections).toEqual([]);expect((await counts()).requests).toEqual([]);}
  finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it.each(['source_recipe_versions','scheduler_tasks','operation_idempotency','policy_decision_records'])('rolls back the whole draft when %s persistence fails',async table=>{
  const before=await counts();await db.pool.query("CREATE FUNCTION refuse_recipe_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recipe storage refused'; END $$");await db.pool.query(`CREATE TRIGGER refuse_recipe_store BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_recipe_store()`);
  try{const response=await create();expect(response.statusCode,response.body).toBe(table==='policy_decision_records'?503:500);expect(await counts()).toEqual(before);}
  finally{await db.pool.query(`DROP TRIGGER refuse_recipe_store ON ${table}`);await db.pool.query('DROP FUNCTION refuse_recipe_store()');}
});
it('never enables human creation placement for Agent, approval-mapped or durable-effect commands',async()=>{
  const runtime=await operationRuntime(config),registration=runtime.registrations.get('source.recipe.create')!;
  for(const definition of [{...registration.definition,allowed_actor_types:['user','agent']},{...registration.definition,grantable:true},{...registration.definition,side_effects:'durable'}])expect(()=>new OperationExecutor(db.pool,config,[{...registration,definition:definition as typeof registration.definition}])).toThrow('Human content creation');
});
it('keeps key reuse strict and validates recipe network origins without persisting a partial source',async()=>{
  const key=randomUUID();expect((await create(body,key)).statusCode).toBe(201);expect((await create({...body,name:'Different'},key)).json().error.code).toBe('idempotency_key_reused');
  const before=await counts(),recipe=buildRecipeForSourceType('rss');recipe.steps[0]={type:'fetch_page',url:'https://foreign.test/rss',bind:'feed'};
  const result=await create({...body,recipe});expect(result.statusCode,result.body).toBe(422);const after=await counts();expect({...after,requests:before.requests}).toEqual(before);expect(after.requests).toHaveLength(before.requests.length+1);
});

it('preserves explicit name conflicts and canonical schedule validation as safe domain errors',async()=>{
  expect((await create()).statusCode).toBe(201);
  const duplicate=await create();expect(duplicate.statusCode,duplicate.body).toBe(409);expect(duplicate.json().error.code).toBe('operation_conflict');expect((await counts()).connections).toHaveLength(1);
  const key=randomUUID(),invalid={...body,name:'Invalid schedule',schedule_rule:{frequency:'daily',hour:99,minute:0}};
  const response=await create(invalid,key);expect(response.statusCode,response.body).toBe(422);expect(response.json().error.code).toBe('operation_invalid_input');expect((await create(invalid,key,true)).json().error).toEqual({...response.json().error,request_id:expect.any(String)});expect((await counts()).connections).toHaveLength(1);
});
