import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedRun} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {publicationsModule} from '../src/modules/publications/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {sessionActor} from '../src/modules/systemActions/operations/actor.js';
import {reserve,requestScope} from '../src/modules/systemActions/operations/repository.js';
import {PublicationService} from '../src/modules/publications/service.js';
import {insertMemoryEntry} from './support/memoryFixtures.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
const db=useTestDatabase(import.meta.filename);
let space:string,target:string,owner:string,other:string,task:string;
let app:ReturnType<typeof buildModuleServer>;
const as=(userId:string,spaceId=space)=>__setAuthIdentityForTests({spaceId,userId});
const send=(url:string,payload:object={},key:string|null=randomUUID())=>app.inject({method:'POST',url,payload,headers:key?{'idempotency-key':key}:{}});
const body=()=>({resource_type:'task',resource_id:task,target_space_ids:[target]});
const create=()=>send('/api/v1/publications',body());
const count=async(table:string)=>Number((await db.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();target=randomUUID();owner=randomUUID();other=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID(),spaceType:'household'});
 await seedSpaceOwnerProject(db.pool,{space:target,owner:other,project:randomUUID(),spaceType:'household'});
 await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())",[randomUUID(),target,owner]);
 task=(await new PgTaskRepository(db.pool).createTask({spaceId:space,userId:owner},{title:'Private immutable snapshot'})).id;
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[publicationsModule,systemActionsModule]);as(owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
describe('Publication operations on PostgreSQL',()=>{
 it('requires a key, rejects unknown fields, and shares the same receipt across formal and generic entry points',async()=>{
  expect((await send('/api/v1/publications',body(),null)).statusCode).toBe(422);
  expect((await send('/api/v1/publications',{...body(),owner_user_id:other})).statusCode).toBe(422);
  const key=randomUUID(),first=await send('/api/v1/publications',body(),key);
  expect(first.statusCode,first.body).toBe(201);
  expect(first.json().data).toMatchObject({source_space_id:space,published_by_user_id:owner,target_space_ids:[target]});
  const repeat=await send('/api/v1/actions/publication.create',body(),key);
  expect(repeat.statusCode,repeat.body).toBe(201);expect(repeat.json()).toEqual(first.json());
  expect(await count('content_publications')).toBe(1);
  const another=(await new PgTaskRepository(db.pool).createTask({spaceId:space,userId:owner},{title:'Another source'})).id;
  expect((await send('/api/v1/publications',{...body(),resource_id:another},key)).statusCode).toBe(422);
 });
 it('refuses a concurrent duplicate key without waiting or writing a second snapshot',async()=>{
  const key=randomUUID(),client=await db.pool.connect();
  try{
   await client.query('BEGIN');await reserve(client,requestScope(sessionActor({spaceId:space,userId:owner}),`space:${space}`,'publication.create',key));
   const refused=await send('/api/v1/publications',body(),key);
   expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.code).toBe('idempotency_in_progress');
   expect(await count('content_publications')).toBe(0);await client.query('COMMIT');
  }finally{await client.query('ROLLBACK');client.release();}
  expect((await send('/api/v1/publications',body(),key)).statusCode).toBe(201);
 });
 it('joins a raw owner transaction; an outer rollback removes snapshot and targets',async()=>{
  const client=await db.pool.connect();
  try{
   await client.query('BEGIN');
   await new PublicationService(client).create({spaceId:space,userId:owner},body());
   expect(Number((await client.query('SELECT count(*) AS n FROM content_publications')).rows[0].n)).toBe(1);
   await client.query('ROLLBACK');
  }finally{client.release();}
  expect(await count('content_publications')).toBe(0);expect(await count('content_publication_targets')).toBe(0);
 });
 it('imports the frozen snapshot with provenance, conceals another importer copy, and retains a private copy after revoke',async()=>{
  const created=await create();expect(created.statusCode,created.body).toBe(201);const publication=created.json().data.id;
  await db.pool.query('UPDATE tasks SET title=$2 WHERE id=$1',[task,'Changed source']);
  as(owner,target);const url=`/api/v1/publications/${publication}/import`,key=randomUUID();
  const imported=await send(url,{},key);expect(imported.statusCode,imported.body).toBe(201);
  const copy=imported.json().data;
  expect(copy.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  expect((await db.pool.query('SELECT title,visibility,owner_user_id,space_id FROM tasks WHERE id=$1',[copy.imported_resource_id])).rows[0]).toEqual({title:'Private immutable snapshot',visibility:'private',owner_user_id:owner,space_id:target});
  expect((await send(url,{},key)).json()).toEqual(imported.json());
  as(other,target);const colleague=await send(url);expect(colleague.statusCode,colleague.body).toBe(201);expect(colleague.json().data.imported_resource_id).toBeNull();
  as(owner);const revoked=await send(`/api/v1/publications/${publication}/revoke`);expect(revoked.statusCode,revoked.body).toBe(200);
  as(owner,target);expect((await app.inject({method:'GET',url:`/api/v1/publications/${publication}`})).json().snapshot.payload).toEqual({});
  expect((await send(url)).json().data).toMatchObject({imported_resource_id:copy.imported_resource_id,snapshot_hash:null});
  expect((await send(url,{},key)).json().data).toMatchObject({imported_resource_id:copy.imported_resource_id,snapshot_hash:null});
  as(other,target);
  expect((await send(url)).json().data).toMatchObject({imported_resource_id:null,snapshot_hash:null});
 });
 it('imports ordinary Memory through its canonical writer with user confirmation provenance and refuses Agent persona types',async()=>{
  const memory=randomUUID();
  await insertMemoryEntry(db.pool,space,{id:memory,owner_user_id:owner,subject_user_id:owner,memory_type:'semantic',source_trust:'agent_inferred'});
  const published=await send('/api/v1/publications',{resource_type:'memory',resource_id:memory,target_space_ids:[target]});
  expect(published.statusCode,published.body).toBe(201);as(owner,target);
  const imported=await send(`/api/v1/publications/${published.json().data.id}/import`);
  expect(imported.statusCode,imported.body).toBe(201);
  expect(imported.json().data.imported_resource_type).toBe('memory');
  const copy=imported.json().data.imported_resource_id;
  const memoryRow=(await db.pool.query('SELECT * FROM memory_entries WHERE id=$1',[copy])).rows[0];
  expect(memoryRow).toMatchObject({scope_type:'user',owner_user_id:owner,subject_user_id:owner,visibility:'private',space_id:target});
  // The importer's confirmation is provenance only; the publisher's trust is not upgraded.
  expect(memoryRow.source_trust).toBe('agent_inferred');
  // Import provenance lives on the provenance link, not on the Memory row.
  expect(JSON.stringify(memoryRow)).not.toContain('publication_import');
  const provenance=(await db.pool.query('SELECT * FROM provenance_links WHERE target_id=$1',[copy])).rows;
  expect(JSON.stringify(provenance)).toContain('user_confirmation');expect(JSON.stringify(provenance)).toContain('publication_import');
  as(owner);const agent=randomUUID();
  await seedRun(db.pool,{id:randomUUID(),space,owner,agent,version:randomUUID()});
  await db.pool.query("UPDATE memory_entries SET scope_type='agent',memory_type='persona',subject_user_id=NULL,agent_id=$2 WHERE id=$1",[memory,agent]);
  expect((await send('/api/v1/publications',{resource_type:'memory',resource_id:memory,target_space_ids:[target]})).statusCode).toBe(422);
 });
 it('publishes and imports an inline Artifact and rejects Host-backed content',async()=>{
  const artifact=randomUUID();
  await db.pool.query(`INSERT INTO artifacts(id,space_id,artifact_type,title,content,mime_type,export_formats_json,visibility,access_level,owner_user_id,created_at,updated_at)
   VALUES($1,$2,'report','Inline report','original','text/markdown','[]'::jsonb,'private','full',$3,now(),now())`,[artifact,space,owner]);
  const publication=await send('/api/v1/publications',{resource_type:'artifact',resource_id:artifact,target_space_ids:[target]});
  expect(publication.statusCode,publication.body).toBe(201);as(owner,target);
  const imported=await send(`/api/v1/publications/${publication.json().data.id}/import`);expect(imported.statusCode,imported.body).toBe(201);
  expect((await db.pool.query('SELECT content,owner_user_id,visibility FROM artifacts WHERE id=$1',[imported.json().data.imported_resource_id])).rows[0]).toEqual({content:'original',owner_user_id:owner,visibility:'private'});
  as(owner);await db.pool.query("UPDATE artifacts SET storage_ref='opaque-host-reference' WHERE id=$1",[artifact]);
  expect((await send('/api/v1/publications',{resource_type:'artifact',resource_id:artifact,target_space_ids:[target]})).statusCode).toBe(422);
 });
 it('refuses non-owner publication, tampering, and fresh imports of revoked snapshots',async()=>{
  as(other);expect((await create()).statusCode).toBe(404);as(owner);
  const first=await create(),id=first.json().data.id;
  await db.pool.query("UPDATE content_publications SET snapshot_hash=repeat('0',64) WHERE id=$1",[id]);
  as(owner,target);expect((await send(`/api/v1/publications/${id}/import`)).statusCode).toBe(409);
  expect(await count('content_publication_imports')).toBe(0);
  as(owner);await send(`/api/v1/publications/${id}/revoke`);
  as(owner,target);expect((await send(`/api/v1/publications/${id}/import`)).statusCode).toBe(409);
 });
 it('rechecks target membership on replay and serializes a concurrent membership revocation before snapshot creation',async()=>{
  const key=randomUUID(),first=await send('/api/v1/publications',body(),key);expect(first.statusCode,first.body).toBe(201);
  const client=await db.pool.connect();let pending:ReturnType<typeof send>|undefined;
  try{
   await client.query('BEGIN');await client.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[target,owner]);
   pending=send('/api/v1/publications',body(),key);await waitForLockWaiter(db.pool);
   await client.query('COMMIT');const denied=await pending;expect(denied.statusCode,denied.body).toBe(404);
  }finally{await client.query('ROLLBACK');client.release();await pending;}
  expect(await count('content_publications')).toBe(1);
 });
 it('rolls back all business effects when mandatory outcome audit fails, then succeeds with the same key after recovery',async()=>{
  await db.pool.query(`CREATE FUNCTION refuse_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM content_publications) THEN RAISE EXCEPTION 'injected publication audit failure'; END IF; RETURN NEW; END $$`);
  await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_publication_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_publication_audit()');
  const key=randomUUID();const failed=await send('/api/v1/publications',body(),key);expect(failed.statusCode,failed.body).toBeGreaterThanOrEqual(500);
  expect(await count('content_publications')).toBe(0);expect(await count('content_publication_targets')).toBe(0);
  await db.pool.query('DROP TRIGGER refuse_publication_audit ON policy_decision_records');
  expect((await send('/api/v1/publications',body(),key)).statusCode).toBe(201);
 });
});
