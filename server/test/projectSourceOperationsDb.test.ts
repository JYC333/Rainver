import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,connection:string,channel:string,item:string,app:ReturnType<typeof buildModuleServer>;
const base=()=>`/api/v1/projects/${project}/sources/bindings`;
const create=(body:object={source_channel_id:channel},key=randomUUID())=>app.inject({method:'POST',url:base(),payload:body,headers:{'idempotency-key':key}});
const generic=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
const mutate=(id:string,kind:'update'|'unbind'|'backfill',body:object={},key=randomUUID())=>app.inject({method:kind==='update'?'PATCH':kind==='unbind'?'DELETE':'POST',url:base()+'/'+id+(kind==='backfill'?'/backfill':''),...(kind==='unbind'?{}:{payload:body}),headers:{'idempotency-key':key}});
const state=async()=>({bindings:(await db.pool.query('SELECT * FROM project_source_bindings ORDER BY id')).rows,links:(await db.pool.query('SELECT * FROM project_source_item_links ORDER BY id')).rows,corpus:(await db.pool.query('SELECT id,status FROM project_corpus_items ORDER BY id')).rows});
beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
  space=randomUUID();owner=randomUUID();project=randomUUID();connection=randomUUID();channel=randomUUID();item=randomUUID();
  const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
  await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now});
  await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,connection_id,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared',$4,'external_url','Retained paper',$5,$5,'excerpt_saved','summary_only',$5,$5)",[item,space,owner,connection,now]);
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[projectsModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('shares create receipts and preserves binding uniqueness/restore and Corpus writes',async()=>{
  const body={source_channel_id:channel,project_id:project,backfill_history:true},key=randomUUID(),first=await create(body,key);
  expect(first.statusCode,first.body).toBe(201);const binding=first.json().data;
  expect(binding).toMatchObject({project_id:project,source_channel_id:channel,status:'active',delivery_scope:'source_subscribers',backfill_result:{created_links:1}});
  const before=await state();expect(before.links).toHaveLength(1);expect(before.corpus).toHaveLength(1);
  expect((await generic('project.source.bind',body,key)).json()).toEqual(first.json());expect(await state()).toEqual(before);
  expect((await create(body)).statusCode).toBe(409);expect((await create({...body,priority:9},key)).json().error.code).toBe('idempotency_key_reused');
  expect((await mutate(binding.id,'unbind')).statusCode).toBe(200);
  const restored=await create(body);expect(restored.statusCode,restored.body).toBe(201);expect(restored.json().data.id).toBe(binding.id);
});
it('updates, archives and routes retained material through the same atomic writer',async()=>{
  const first=await create({source_channel_id:channel,backfill_history:true});expect(first.statusCode,first.body).toBe(201);const id=first.json().data.id;
  const key=randomUUID(),paused=await mutate(id,'update',{status:'paused'},key);expect(paused.statusCode,paused.body).toBe(200);expect((await state()).links[0]?.status).toBe('archived');
  const before=await state();expect((await generic('project.source.update',{project_id:project,binding_id:id,changes:{status:'paused'}},key)).json()).toEqual(paused.json());expect(await state()).toEqual(before);
  expect((await mutate(id,'backfill')).statusCode).toBe(422);
  expect((await mutate(id,'update',{status:'active'})).statusCode).toBe(200);expect((await state()).links[0]?.status).toBe('active');
  const routed=await mutate(id,'backfill');expect(routed.statusCode,routed.body).toBe(200);expect(routed.json().data).toMatchObject({binding_id:id,source_channel_id:channel,created_links:0});
});
it('enforces Source reach, restricted sharing and live Project writer on replay',async()=>{
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
  __setAuthIdentityForTests({spaceId:space,userId:peer});expect((await create()).statusCode).toBe(404);
  await db.pool.query("UPDATE source_connections SET visibility='selected_users' WHERE id=$1",[connection]);
  await db.pool.query("INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,access_level,granted_by_user_id,created_at,updated_at) VALUES($1,$2,'source_connection',$3,$4,'full',$5,now(),now())",[randomUUID(),space,connection,peer,owner]);
  expect((await create({source_channel_id:channel,delivery_scope:'project_members'})).statusCode).toBe(404);
  const key=randomUUID(),created=await create({source_channel_id:channel},key);expect(created.statusCode,created.body).toBe(201);
  expect((await mutate(created.json().data.id,'update',{delivery_scope:'project_members'})).statusCode).toBe(404);
  const wrong=await app.inject({method:'PATCH',url:`/api/v1/projects/${randomUUID()}/sources/bindings/${created.json().data.id}`,payload:{status:'paused'},headers:{'idempotency-key':randomUUID()}});expect(wrong.statusCode).toBe(404);
  await db.pool.query('DELETE FROM content_access_grants WHERE resource_id=$1',[connection]);
  expect((await create({source_channel_id:channel},key)).statusCode).toBe(404);
  // Existing consumption settings are Project-owned; losing Source read scope
  // must not remove the writer's ability to pause this existing binding.
  expect((await mutate(created.json().data.id,'update',{status:'paused'})).statusCode).toBe(200);
  await db.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,peer]);expect((await create({source_channel_id:channel},key)).statusCode).toBe(404);
});
it('keeps Project fencing, path authority, strict fields and profile validation',async()=>{
  expect((await create({source_channel_id:channel,project_id:randomUUID()})).statusCode).toBe(422);
  expect((await create({source_channel_id:channel,extraction_policy:{profile_key:'unknown_profile'}})).statusCode).toBe(422);
  expect((await create({source_channel_id:channel,status:'active',created_by_user_id:owner})).statusCode).toBe(422);
  await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);expect((await create()).statusCode).toBe(409);expect((await state()).bindings).toHaveLength(0);
});
it('rejects a second same-key admission while awaiting the Project fence',async()=>{
  const hold=await db.pool.connect(),body={source_channel_id:channel},key=randomUUID();let pending:ReturnType<typeof create>|undefined;
  try{await hold.query('BEGIN');await hold.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);pending=create(body,key);await waitForLockWaiter(db.pool);
    const conflict=await create(body,key);expect(conflict.statusCode,conflict.body).toBe(409);expect(conflict.json().error.code).toBe('idempotency_in_progress');
    await hold.query('COMMIT');expect((await pending).statusCode).toBe(201);expect((await state()).bindings).toHaveLength(1);
  }finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it.each(['project_source_item_links','operation_idempotency','policy_decision_records'])('rolls back binding/Corpus when %s refuses storage',async table=>{
  await db.pool.query(`CREATE FUNCTION refuse_binding_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'binding storage refused'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_binding_store BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_binding_store()`);
  try{const result=await create({source_channel_id:channel,backfill_history:true});expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(await state()).toEqual({bindings:[],links:[],corpus:[]});}
  finally{await db.pool.query(`DROP TRIGGER refuse_binding_store ON ${table}`);await db.pool.query('DROP FUNCTION refuse_binding_store()');}
});
it.each(['update','unbind','backfill'] as const)('rolls back %s and routing effects when its receipt fails',async kind=>{
  const first=await create({source_channel_id:channel,backfill_history:kind!=='backfill'});expect(first.statusCode,first.body).toBe(201);const id=first.json().data.id,before=await state();
  await db.pool.query(`CREATE FUNCTION refuse_binding_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt refused'; END $$`);
  await db.pool.query('CREATE TRIGGER refuse_binding_receipt BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_binding_receipt()');
  try{expect((await mutate(id,kind,kind==='update'?{status:'paused'}:{})).statusCode).toBe(500);expect(await state()).toEqual(before);}
  finally{await db.pool.query('DROP TRIGGER refuse_binding_receipt ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_binding_receipt()');}
});
it('initializes Standing comparison notes in the binding transaction',async()=>{
  const body={source_channel_id:channel,standing_comparison_enabled:true,backfill_history:true},key=randomUUID();
  const first=await create(body,key);expect(first.statusCode,first.body).toBe(201);
  expect((await db.pool.query('SELECT object_id FROM notes WHERE space_id=$1',[space])).rows.length).toBeGreaterThan(0);expect(first.json().data.standing_comparison_enabled).toBe(true);
  const jobs=(await db.pool.query("SELECT id FROM jobs WHERE space_id=$1 AND job_type='project_research_standing_dispatch'",[space])).rows;expect(jobs).toHaveLength(1);
  expect((await create(body,key)).json()).toEqual(first.json());expect((await db.pool.query("SELECT id FROM jobs WHERE space_id=$1 AND job_type='project_research_standing_dispatch'",[space])).rows).toEqual(jobs);
});

it.each(['operation_idempotency','jobs'])('rolls back Standing Notes/batch/routing when %s fails',async table=>{
  const notes=(await db.pool.query('SELECT object_id FROM notes ORDER BY object_id')).rows;
  const folders=(await db.pool.query('SELECT id FROM note_collections ORDER BY id')).rows;
  await db.pool.query(`CREATE FUNCTION refuse_standing_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt refused'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_standing_receipt BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_standing_receipt()`);
  try{
    expect((await create({source_channel_id:channel,standing_comparison_enabled:true,backfill_history:true})).statusCode).toBe(500);
    expect((await db.pool.query('SELECT object_id FROM notes ORDER BY object_id')).rows).toEqual(notes);
    expect((await db.pool.query('SELECT id FROM note_collections ORDER BY id')).rows).toEqual(folders);
    expect(await state()).toEqual({bindings:[],links:[],corpus:[]});
    expect((await db.pool.query('SELECT id FROM project_research_standing_batches WHERE space_id=$1',[space])).rows).toEqual([]);
    expect((await db.pool.query("SELECT id FROM jobs WHERE space_id=$1 AND job_type='project_research_standing_dispatch'",[space])).rows).toEqual([]);
  }finally{await db.pool.query(`DROP TRIGGER refuse_standing_receipt ON ${table}`);await db.pool.query('DROP FUNCTION refuse_standing_receipt()');}
});
it('hides cross-Space Source/binding references without touching the original binding',async()=>{
  const first=await create();expect(first.statusCode,first.body).toBe(201);const before=await state();
  const foreign={space:randomUUID(),owner:randomUUID(),project:randomUUID(),spaceType:'team' as const};await seedSpaceOwnerProject(db.pool,foreign);
  __setAuthIdentityForTests({spaceId:foreign.space,userId:foreign.owner});
  const result=await generic('project.source.bind',{project_id:foreign.project,source_channel_id:channel});expect(result.statusCode).toBe(404);
  expect((await generic('project.source.update',{project_id:foreign.project,binding_id:first.json().data.id,changes:{status:'paused'}})).statusCode).toBe(404);
  expect(await state()).toEqual(before);
});

it('reports a binding-key collision without partial changes or private SQL details',async()=>{
  const a=await create(),b=await create({source_channel_id:channel,binding_key:'second'});expect(a.statusCode,a.body).toBe(201);expect(b.statusCode,b.body).toBe(201);
  const before=await state(),key=randomUUID(),result=await mutate(a.json().data.id,'update',{binding_key:'second'},key);
  expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('operation_conflict');expect(result.body).not.toContain('uq_project_source');
  expect(await state()).toEqual(before);expect((await mutate(a.json().data.id,'update',{binding_key:'second'},key)).statusCode).toBe(409);
});
