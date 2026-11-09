import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {runActor} from '../src/modules/systemActions/operations/actor.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedRun} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {waitForLockWaiter} from './support/lockWait.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,app:ReturnType<typeof buildModuleServer>;
const body={provider_key:'arxiv',name:'New Monitor',query:{search_query:'cat:cs.AI'},fetch_frequency:'daily'};
const create=(payload:object=body,key=randomUUID(),generic=false)=>app.inject({method:'POST',url:generic?'/api/v1/actions/source.channel.create':'/api/v1/sources/channels',payload,headers:{'idempotency-key':key}});
const counts=async()=>({channels:(await db.pool.query('SELECT id FROM source_channels ORDER BY id')).rows,connections:(await db.pool.query('SELECT id FROM source_connections ORDER BY id')).rows,tasks:(await db.pool.query('SELECT id FROM scheduler_tasks ORDER BY id')).rows,subscriptions:(await db.pool.query('SELECT id FROM source_channel_user_subscriptions ORDER BY id')).rows,requests:(await db.pool.query('SELECT id FROM operation_idempotency ORDER BY id')).rows});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','source_connectors','source_providers'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner,project});await seedArxivSourceChain(db.pool,{space,owner,connection:randomUUID(),connector:randomUUID(),channel:[],now:new Date().toISOString()});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[sourcesModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('uses one canonical writer across REST/generic replay, preserves domain uniqueness and rejects changed input',async()=>{
 const key=randomUUID(),first=await create(body,key);expect(first.statusCode,first.body).toBe(201);const saved=await counts();expect((await create({...body,project_id:null,credential_id:null,source_connection_id:null,endpoint_url:null,schedule_rule:null},key,true)).json()).toEqual(first.json());expect(await counts()).toEqual(saved);
 expect((await create({...body,name:'Changed'},key,true)).json().error.code).toBe('idempotency_key_reused');
 expect((await create(body)).json().data.id).toBe(first.json().data.id);expect((await counts()).channels).toEqual(saved.channels);
 expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE action='source.connection.manage' AND metadata_json->>'operation_outcome' IS DISTINCT FROM 'failed'")).rows).toHaveLength(3);
});
it('pins Project placement and refuses revoked authority on receipt replay',async()=>{
 const key=randomUUID(),input={...body,project_id:project};const first=await create(input,key);expect(first.statusCode,first.body).toBe(201);
 expect((await db.pool.query('SELECT project_id,visibility FROM source_connections WHERE id=$1',[first.json().data.source_connection_id])).rows[0]).toMatchObject({project_id:project,visibility:'space_shared'});
 await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);expect((await create(input,key,true)).statusCode).toBe(404);
});
it.each(['scheduler_tasks','source_channel_user_subscriptions','operation_idempotency','policy_decision_records'])('rolls back all creation state when %s fails',async table=>{
 const before=await counts();await db.pool.query("CREATE FUNCTION refuse_channel_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage refused'; END $$");await db.pool.query(`CREATE TRIGGER refuse_channel_creation BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_channel_creation()`);
 try{const result=await create();expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(await counts()).toEqual(before);}
 finally{await db.pool.query(`DROP TRIGGER refuse_channel_creation ON ${table}`);await db.pool.query('DROP FUNCTION refuse_channel_creation()');}
});
it('requires a key and rejects forged internal authority fields without writing',async()=>{
 const before=await counts();expect((await app.inject({method:'POST',url:'/api/v1/sources/channels',payload:body})).statusCode).toBe(422);
 for(const extra of [{_force_create:true},{_initial_status:'active'},{agent_id:randomUUID()}])expect((await create({...body,...extra})).statusCode).toBe(422);
 expect(await counts()).toEqual(before);
});
it('rejects a foreign Source target and another owner credential without disclosing either',async()=>{
 const foreign=await create({...body,source_connection_id:randomUUID()});expect(foreign.statusCode,foreign.body).toBe(404);
 expect((await create({...body,credential_id:randomUUID()})).statusCode).toBe(404);
});
it('admits the same key before Project rows and makes only one concurrent Monitor',async()=>{
 const blocker=await db.pool.connect(),key=randomUUID();let pending:ReturnType<typeof create>|undefined;
 try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);pending=create({...body,project_id:project},key);await waitForLockWaiter(db.pool);expect((await create({...body,project_id:project},key,true)).json().error.code).toBe('idempotency_in_progress');await blocker.query('COMMIT');expect((await pending).statusCode).toBe(201);expect((await counts()).channels).toHaveLength(1);}
 finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});

it('does not grant Monitor creation to a real Agent Run',async()=>{
 const run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2 WHERE id=$1",[run,owner]);
 const actor=await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(space,run))!);
 const before=await counts(),runtime=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
 const parent=(await db.pool.query('SELECT id FROM source_connections WHERE space_id=$1 LIMIT 1',[space])).rows[0].id;
 for(const input of [body,{...body,source_connection_id:parent}]){const result=await runtime.execute('source.channel.create',input,actor,randomUUID(),randomUUID());expect(result.http_status).toBe(404);}expect(await counts()).toEqual(before);
});
it('hides an existing foreign-Space Source just like an unknown target',async()=>{
 const other={space:randomUUID(),owner:randomUUID(),project:randomUUID()};await seedSpaceOwnerProject(db.pool,other);__setAuthIdentityForTests({spaceId:other.space,userId:other.owner});
 const foreign=await create();expect(foreign.statusCode,foreign.body).toBe(201);__setAuthIdentityForTests({spaceId:space,userId:owner});const before=await counts();
 expect((await create({...body,source_connection_id:foreign.json().data.source_connection_id})).statusCode).toBe(404);expect(await counts()).toEqual(before);
});

it.each([
 {query:{}},
 {policy:{source_egress_class:'unknown'}},
 {schedule_rule:{frequency:'daily',hour:99,minute:0}},
])('caches only known create-owner input failures: %j',async change=>{
 const key=randomUUID(),input={...body,...change},before=await counts();const first=await create(input,key);expect(first.statusCode,first.body).toBe(422);expect(first.json().error.code).toBe('operation_invalid_input');
 expect((await create(input,key,true)).json().error.code).toBe('operation_invalid_input');const after=await counts();expect({...after,requests:before.requests}).toEqual(before);expect(after.requests).toHaveLength(before.requests.length+1);
});
it.each([422,409])('unknown helper HttpError%s rolls back actual writes, with no terminal receipt or reflected text',async status=>{
 const {SourceChannelService}=await import('../src/modules/sources/channels/sourceChannelService.js');const {HttpError}=await import('../src/modules/routeUtils/common.js');const {vi}=await import('vitest');
 const original=SourceChannelService.prototype.create,key=randomUUID(),before=await counts();
 const fault=vi.spyOn(SourceChannelService.prototype,'create').mockImplementation(async function(this:import('../src/modules/sources/channels/sourceChannelService.js').SourceChannelService,...args){await original.apply(this,args);throw new HttpError(status,'PRIVATE unexpected helper failure');});
 try{const result=await create(body,key);expect(result.statusCode,result.body).toBe(500);expect(result.body).not.toContain('PRIVATE');expect(await counts()).toEqual(before);const audits=(await db.pool.query("SELECT id FROM policy_decision_records WHERE space_id=$1 AND metadata_json->>'operation_outcome'='failed'",[space])).rows;expect(audits).toHaveLength(1);}
 finally{fault.mockRestore();}
 expect((await create(body,key,true)).statusCode).toBe(201);
});
it('classifies the exact ensureConnection no-row conflict without caching arbitrary Http409 failures',async()=>{
 // A real storage refusal reaches ensureConnection's no-insert/no-concurrent-row
 // branch. No mocked domain result or policy decision is used.
 await db.pool.query('DELETE FROM source_connections');
 await db.pool.query("CREATE FUNCTION skip_source_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");await db.pool.query('CREATE TRIGGER skip_source_insert BEFORE INSERT ON source_connections FOR EACH ROW EXECUTE FUNCTION skip_source_insert()');
 const key=randomUUID();try{const result=await create(body,key);expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('operation_conflict');expect((await create(body,key,true)).json().error.code).toBe('operation_conflict');}
 finally{await db.pool.query('DROP TRIGGER skip_source_insert ON source_connections');await db.pool.query('DROP FUNCTION skip_source_insert()');}
});
it('inherits an existing same-request-Space parent without a repeated Project field, and rejects A/B scope mismatch',async()=>{
 const parent=(await create({...body,project_id:project})).json().data.source_connection_id;
 // The request is a team Space with no Personal Space for this actor.
 await db.pool.query("UPDATE spaces SET type='household' WHERE id=$1",[space]);
 const input={...body,source_connection_id:parent,query:{search_query:'cat:cs.LG'}},key=randomUUID();const result=await create(input,key);
 expect(result.statusCode,result.body).toBe(201);expect(result.json().data.project_id).toBe(project);expect((await create(input,key,true)).json()).toEqual(result.json());
 const other=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other','active',now(),now())",[other,space,owner]);
 expect((await create({...input,project_id:other})).statusCode).toBe(409);
 await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);expect((await create(input)).statusCode).toBe(409);expect((await create(input,key,true)).statusCode).toBe(409);
});
it('cannot use an owned parent in an unreadable Project B through an authorized Project A',async()=>{
 const parent=(await create({...body,project_id:project})).json().data.source_connection_id;
 const {seedSpaceMember}=await import('./support/domainSeeds.js');const person=randomUUID();await seedSpaceMember(db.pool,{space,user:person});
 await db.pool.query("UPDATE spaces SET type='household' WHERE id=$1",[space]);await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[project,person]);
 const a=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Accessible A','active',now(),now())",[a,space,owner]);
 const before=await counts();expect((await create({...body,project_id:a,source_connection_id:parent})).statusCode).toBe(404);expect((await create({...body,source_connection_id:parent})).statusCode).toBe(404);expect(await counts()).toEqual(before);
});
it('refuses parent scope growth between discovery and domain lock, without late keys or partial children',async()=>{
 const parent=(await create({...body,project_id:project})).json().data.source_connection_id;
 const hold=await db.pool.connect();let pending:ReturnType<typeof create>|undefined;
 try{await hold.query('BEGIN');await hold.query('SELECT id FROM source_connections WHERE id=$1 FOR UPDATE',[parent]);
 pending=create({...body,source_connection_id:parent,query:{search_query:'cat:cs.LG'}});await waitForLockWaiter(db.pool);
 const changedProject=randomUUID();await hold.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Changed parent','active',now(),now())",[changedProject,space,owner]);await hold.query('UPDATE source_connections SET project_id=$2 WHERE id=$1',[parent,changedProject]);await hold.query('COMMIT');const result=await pending;expect(result.statusCode,result.body).toBe(409);expect((await counts()).channels).toHaveLength(1);
 }finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it('different keys and REST/generic entries serialize domain fingerprint reuse with explicit/implicit parent overlap',async()=>{
 const parent=(await create()).json().data.source_connection_id;
 const input={...body,query:{search_query:'cat:cs.LG'}};
 const hold=await db.pool.connect();let a,b;try{await hold.query('BEGIN');await hold.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`source-monitor-create:${space}:${owner}`]);
 const first=create(input),second=create({...input,source_connection_id:parent},randomUUID(),true);await waitForLockWaiter(db.pool,{waiters:2});await hold.query('COMMIT');[a,b]=await Promise.all([first,second]);}finally{await hold.query('ROLLBACK');hold.release();}
 expect(a.statusCode,a.body).toBe(201);expect(b.statusCode,b.body).toBe(201);expect(a.json().data.id).toBe(b.json().data.id);expect((await counts()).channels).toHaveLength(2);
});
it('Recipe creation and Monitor creation make progress under the same domain admission without deadlock or partial writes',async()=>{
 const {seedCustomSourceWorld}=await import('./support/customSourceWorld.js');
 // Reuse the canonical Custom Source fixture in a second Space; the user here
 // remains the original owner with the already-established request context.
 const otherSpace=randomUUID(),otherUser=randomUUID();await seedCustomSourceWorld(db.pool,{spaceId:otherSpace,userId:otherUser});
 const hold=await db.pool.connect();let monitor,recipe;try{await hold.query('BEGIN');await hold.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`source-monitor-create:${space}:${owner}`]);
 const first=create(),second=app.inject({method:'POST',url:'/api/v1/sources/source-recipes',headers:{'idempotency-key':randomUUID()},payload:{name:'Recipe',endpoint_url:'https://fixture.test/feed',source_type:'rss'}});await waitForLockWaiter(db.pool,{waiters:2});await hold.query('COMMIT');[monitor,recipe]=await Promise.all([first,second]);}finally{await hold.query('ROLLBACK');hold.release();}
 expect(monitor.statusCode,monitor.body).toBe(201);expect(recipe.statusCode,recipe.body).toBe(201);expect((await counts()).channels).toHaveLength(2);expect((await db.pool.query('SELECT id FROM source_recipe_versions WHERE space_id=$1',[space])).rows).toHaveLength(1);
});
it('withholds a retained create receipt after its real parent is soft deleted',async()=>{
 const key=randomUUID(),first=await create(body,key);expect(first.statusCode).toBe(201);await db.pool.query('UPDATE source_connections SET deleted_at=now() WHERE id=$1',[first.json().data.source_connection_id]);
 const before=await counts();expect((await create(body,key,true)).statusCode).toBe(404);expect(await counts()).toEqual(before);
});
it('retains the old source_channel/null policy scope and denial on both entries with one failed audit per call',async()=>{
 const {vi}=await import('vitest');const registryModule=await import('../src/modules/policy/actionRegistry.js');const original=registryModule.loadActionRegistry;
 const deny=vi.spyOn(registryModule,'loadActionRegistry').mockImplementation(async(...args)=>{const registry=new Map(await original(...args));registry.set('source.connection.manage',{...registry.get('source.connection.manage')!,default_decision:'deny'});return registry;});
 try{
  const before=await counts();for(const generic of [false,true]){const result=await create(body,randomUUID(),generic);expect(result.statusCode,result.body).toBe(404);}
  expect(await counts()).toEqual(before);const records=(await db.pool.query("SELECT resource_type,resource_id,decision,metadata_json FROM policy_decision_records WHERE action='source.connection.manage' AND space_id=$1",[space])).rows;
  expect(records).toHaveLength(2);for(const record of records)expect(record).toMatchObject({resource_type:'source_channel',resource_id:null,decision:'deny',metadata_json:{operation_outcome:'failed'}});
 }finally{deny.mockRestore();}
});
it('does not release an old child receipt after its parent Project changes, even for a writer of both Projects',async()=>{
 const parent=(await create()).json().data.source_connection_id,input={...body,source_connection_id:parent,query:{search_query:'cat:cs.LG'}},key=randomUUID();
 const old=await create(input,key);expect(old.statusCode,old.body).toBe(201);expect(old.json().data.project_id).toBeNull();
 await db.pool.query('UPDATE source_connections SET project_id=$2 WHERE id=$1',[parent,project]);const before=await counts();
 expect((await create(input,key,true)).statusCode).toBe(409);expect(await counts()).toEqual(before);
});
it('still places a new root privately in the Personal Space when browsing a Team Space',async()=>{
 const team=randomUUID();await db.pool.query("INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Team','household',$2,now(),now())",[team,owner]);await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),team,owner]);
 __setAuthIdentityForTests({spaceId:team,userId:owner});const result=await create({...body,visibility:'space_shared'});expect(result.statusCode,result.body).toBe(201);expect(result.json().data.space_id).toBe(space);
 expect((await db.pool.query('SELECT project_id,visibility FROM source_connections WHERE id=$1',[result.json().data.source_connection_id])).rows[0]).toMatchObject({project_id:null,visibility:'private'});
});
it('rejects a foreign Project on an authorized same-Space parent without using it to select a Space',async()=>{
 const parent=(await create()).json().data.source_connection_id,foreign={space:randomUUID(),owner:randomUUID(),project:randomUUID()};await seedSpaceOwnerProject(db.pool,foreign);const before=await counts();
 expect((await create({...body,source_connection_id:parent,project_id:foreign.project})).statusCode).toBe(409);expect(await counts()).toEqual(before);
});
