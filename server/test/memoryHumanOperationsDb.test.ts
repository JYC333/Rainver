import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {memoryModule} from '../src/modules/memory/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {insertMemoryEntry} from './support/memoryFixtures.js';
import {waitForLockWaiter} from './support/lockWait.js';
// A person's own Memory commands through their formal adapters (ADR 0003, B10).
const db=useTestDatabase(import.meta.filename,{max:4});
let space:string,owner:string,project:string,personal:string,peer:string,app:ReturnType<typeof buildModuleServer>;
const send=(method:'POST'|'PATCH'|'DELETE',url:string,payload:object={},key=randomUUID())=>app.inject({method,url,payload,headers:{'idempotency-key':key}});
const status=async(id:string)=>(await db.pool.query('SELECT status FROM memory_entries WHERE id=$1',[id])).rows[0]?.status;
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();personal=randomUUID();peer=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Personal','personal',now(),now())",[personal]);
 await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,owner]);
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[memoryModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('places a personal memory proposal once, derives provenance on the server and writes no memory',async()=>{
 const key=randomUUID(),body={title:'Remember',content:'PRIVATE fact',type:'semantic',namespace:'user.default'};
 const first=await send('POST','/api/v1/memory',body,key);expect(first.statusCode,first.body).toBe(202);
 expect(first.body).not.toContain('PRIVATE');expect(first.json().data.space_id).toBe(personal);
 expect((await app.inject({method:'POST',url:'/api/v1/actions/memory.propose_create',payload:body,headers:{'idempotency-key':key}})).json()).toEqual(first.json());
 expect((await send('POST','/api/v1/memory',{...body,content:'Other'},key)).statusCode).toBe(422);
 const rows=(await db.pool.query('SELECT space_id,proposal_type,status,created_by_user_id,payload_json FROM proposals')).rows;
 expect(rows).toMatchObject([{space_id:personal,proposal_type:'memory_create',status:'pending',created_by_user_id:owner,payload_json:{target_scope:'user',target_visibility:'private',proposed_content:'PRIVATE fact'}}]);
 expect(JSON.stringify(rows[0].payload_json.provenance_entries)).toContain(owner);
 expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toEqual([]);
});
it('refuses client-supplied attribution and places a Project memory only for a writer',async()=>{
 for(const extra of [{actor_user_id:peer},{provenance_entries:[{source_type:'user',source_id:peer}]},{owner_user_id:peer},{agent_id:randomUUID()},{visibility:'space_shared'}])
  expect((await send('POST','/api/v1/memory',{title:'T',content:'C',type:'semantic',...extra})).statusCode).toBe(422);
 const ok=await send('POST','/api/v1/memory',{title:'T',content:'C',type:'semantic',project_id:project});expect(ok.statusCode,ok.body).toBe(202);
 expect((await db.pool.query('SELECT space_id,project_id,payload_json FROM proposals')).rows).toMatchObject([{space_id:space,project_id:project,payload_json:{target_scope:'project',target_visibility:'space_shared'}}]);
 __setAuthIdentityForTests({spaceId:space,userId:peer});
 expect([403,404]).toContain((await send('POST','/api/v1/memory',{title:'T',content:'C',type:'semantic',project_id:project})).statusCode);
 expect((await db.pool.query('SELECT id FROM proposals')).rows).toHaveLength(1);
});
it('archives and restores the owner\'s entry directly; another person\'s entry becomes an archive proposal',async()=>{
 const own=randomUUID(),theirs=randomUUID();
 await insertMemoryEntry(db.pool,space,{id:own,owner_user_id:owner,subject_user_id:owner,created_by:owner});
 await insertMemoryEntry(db.pool,space,{id:theirs,owner_user_id:null,subject_user_id:null,created_by:peer},{visibility:'space_shared'});
 const archived=await send('DELETE',`/api/v1/memory/${own}`);expect(archived.statusCode,archived.body).toBe(200);
 expect(archived.json().data).toEqual({id:own,space_id:space,outcome:'archived'});expect(await status(own)).toBe('archived');
 const again=await send('DELETE',`/api/v1/memory/${own}`);expect(again.statusCode).toBe(409);
 const restored=await send('POST',`/api/v1/memory/${own}/restore`);expect(restored.statusCode,restored.body).toBe(200);expect(await status(own)).toBe('active');
 const proposed=await send('DELETE',`/api/v1/memory/${theirs}`);expect(proposed.statusCode,proposed.body).toBe(200);expect(proposed.json().data.outcome).toBe('proposed');
 expect(await status(theirs)).toBe('active');
 expect((await db.pool.query('SELECT proposal_type,status FROM proposals')).rows).toEqual([{proposal_type:'memory_archive',status:'pending'}]);
 __setAuthIdentityForTests({spaceId:space,userId:peer});
 expect((await send('POST',`/api/v1/memory/${own}/restore`)).statusCode).toBe(404);
});
it('undoes one revision in a single command, leaving exactly one active version',async()=>{
 const v1=randomUUID(),v2=randomUUID();
 await insertMemoryEntry(db.pool,space,{id:v1,owner_user_id:owner,subject_user_id:owner,created_by:owner,status:'superseded',content:'first'});
 await insertMemoryEntry(db.pool,space,{id:v2,owner_user_id:owner,subject_user_id:owner,created_by:owner,root_memory_id:v1,supersedes_memory_id:v1,version:2,content:'second'});
 const res=await send('POST',`/api/v1/memory/${v2}/revert`);expect(res.statusCode,res.body).toBe(200);expect(res.json().data.id).toBe(v1);
 expect([await status(v1),await status(v2)]).toEqual(['active','archived']);
});
it('rolls back the proposal and request when the domain policy audit cannot be written',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_memory_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE failure'; END $$");
 await db.pool.query('CREATE TRIGGER refuse_memory_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_memory_audit()');
 try{const res=await send('POST','/api/v1/memory',{title:'T',content:'C',type:'semantic',project_id:project});expect([500,503]).toContain(res.statusCode);expect(res.body).not.toContain('PRIVATE');
  expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);expect((await db.pool.query("SELECT id FROM operation_idempotency WHERE state='succeeded'")).rows).toEqual([]);
 }finally{await db.pool.query('DROP TRIGGER refuse_memory_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_memory_audit()');}
});
it('refuses a restore whose ownership moved while it waited on the entry, with no status change',async()=>{
 const own=randomUUID();await insertMemoryEntry(db.pool,space,{id:own,owner_user_id:owner,subject_user_id:owner,created_by:owner,status:'archived'});
 const holder=await db.pool.connect();let pending:ReturnType<typeof send>|undefined;
 try{await holder.query('BEGIN');await holder.query('SELECT id FROM memory_entries WHERE id=$1 FOR UPDATE',[own]);
  pending=send('POST',`/api/v1/memory/${own}/restore`);await waitForLockWaiter(db.pool);
  await holder.query('UPDATE memory_entries SET owner_user_id=$2 WHERE id=$1',[own,peer]);await holder.query('COMMIT');
  const res=await pending;expect(res.statusCode,res.body).toBe(404);expect(await status(own)).toBe('archived');
 }finally{await holder.query('ROLLBACK').catch(()=>undefined);holder.release();await pending;}
});
