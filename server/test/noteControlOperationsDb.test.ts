import {ensureProjectNotesFolder} from '../src/modules/knowledge/noteProjectFolders.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedProjectMainlineRoom,seedRun} from './support/domainSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {PgKnowledgeRepository} from '../src/modules/knowledge/repository.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,note:string,app:ReturnType<typeof buildModuleServer>,repo:PgKnowledgeRepository;
const doc=(text:string)=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
const rollback=(key=randomUUID(),input:object={to_version:1,expect_version:2})=>app.inject({method:'POST',url:`/api/v1/knowledge/notes/${note}/rollback`,payload:input,headers:{'idempotency-key':key}});
const trash=(key=randomUUID())=>app.inject({method:'DELETE',url:`/api/v1/knowledge/notes/${note}`,headers:{'idempotency-key':key}});
const generic=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
const snapshot=async()=>({root:(await db.pool.query('SELECT id,title,visibility,primary_project_id,deleted_at,archived_at,updated_at FROM space_objects WHERE id=$1',[note])).rows,note:(await db.pool.query('SELECT object_id,content_json,plain_text,version,status FROM notes WHERE object_id=$1',[note])).rows,revisions:(await db.pool.query('SELECT id,version,content_json,refs_json,source,created_at FROM note_revisions WHERE note_id=$1 ORDER BY version',[note])).rows,outbox:(await db.pool.query("SELECT id,source_ref_json FROM domain_change_outbox WHERE source_kind='note' AND source_id=$1 ORDER BY id",[note])).rows});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});repo=new PgKnowledgeRepository(db.pool);
 note=String((await repo.createNote({spaceId:space,userId:owner},{title:'Working note',visibility:'private',content_json:doc('First version'),plain_text:'First version'})).id);
 await repo.updateNote({spaceId:space,userId:owner},note,{content_json:doc('Second version'),plain_text:'Second version',expect_version:1});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[knowledgeModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('restores through the canonical version writer once and returns a body-free historical receipt across transports',async()=>{
 const key=randomUUID(),result=await rollback(key);expect(result.statusCode,result.body).toBe(200);expect(result.headers['cache-control']).toContain('no-store');expect(result.json()).toEqual({status:'succeeded',data:{id:note,space_id:space,version:3}});
 const saved=await snapshot();expect(saved.note[0]).toMatchObject({version:3,plain_text:'First version'});expect(saved.revisions).toHaveLength(3);expect(saved.revisions[2]?.source).toBe('rollback');expect(saved.outbox).toHaveLength(3);
 expect((await generic('knowledge.note.rollback',{note_id:note,to_version:1,expect_version:2},key)).json()).toEqual(result.json());expect(await snapshot()).toEqual(saved);
 await repo.updateNote({spaceId:space,userId:owner},note,{content_json:doc('Later version'),plain_text:'Later version',expect_version:3});const later=await snapshot();expect((await rollback(key)).json()).toEqual(result.json());expect(await snapshot()).toEqual(later);
 expect((await generic('knowledge.note.rollback',{note_id:note,to_version:2,expect_version:2},key)).json().error.code).toBe('idempotency_key_reused');
});
it('keeps soft deletion idempotent per key and never repeats an old delete after a legitimate restore',async()=>{
 const key=randomUUID(),result=await trash(key);expect(result.statusCode,result.body).toBe(200);const saved=await snapshot();expect(saved.note[0]?.status).toBe('deleted');expect(saved.root[0]?.deleted_at).not.toBeNull();expect(saved.revisions).toHaveLength(2);
 expect((await generic('knowledge.note.delete',{note_id:note},key)).json()).toEqual(result.json());expect(await snapshot()).toEqual(saved);
 await repo.updateNote({spaceId:space,userId:owner},note,{status:'active'});const restored=await snapshot();expect(restored.root[0]?.deleted_at).toBeNull();expect((await trash(key)).json()).toEqual(result.json());expect(await snapshot()).toEqual(restored);
});
it('preserves optimistic conflicts without a new revision and replays only the sanitized failure',async()=>{
 const before=await snapshot(),key=randomUUID(),input={to_version:1,expect_version:1};const response=await rollback(key,input);expect(response.statusCode,response.body).toBe(409);expect(response.json().error).toMatchObject({code:'operation_conflict',domain:'knowledge'});expect(await snapshot()).toEqual(before);
 expect((await rollback(key,input)).json().error.code).toBe('operation_conflict');expect(await snapshot()).toEqual(before);
});
it('does not turn a readable private Note or oversight into mutation authority',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer,role:'admin'});await db.pool.query("INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,access_level,granted_by_user_id,created_at,updated_at) VALUES($1,$2,'space_object',$3,$4,'full',$5,now(),now())",[randomUUID(),space,note,peer,owner]);
 __setAuthIdentityForTests({spaceId:space,userId:peer});const before=await snapshot();expect((await trash()).statusCode).toBe(404);expect((await rollback()).statusCode).toBe(404);expect(await snapshot()).toEqual(before);
});
it('retains shared-full-content editing and the required B11 read audit',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='space_shared' WHERE id=$1",[note]);__setAuthIdentityForTests({spaceId:space,userId:peer});const response=await rollback();expect(response.statusCode,response.body).toBe(200);expect((await snapshot()).note[0]?.version).toBe(3);
 expect((await db.pool.query('SELECT id FROM content_access_logs WHERE resource_id=$1 AND viewer_user_id=$2',[note,peer])).rows.length).toBeGreaterThan(0);
});
it('refuses a summary-only shared reader and Project viewers, preserving the owner writer gate',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='space_shared',access_level='summary' WHERE id=$1",[note]);__setAuthIdentityForTests({spaceId:space,userId:peer});expect((await trash()).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:space,userId:owner});note=String((await repo.createNote({spaceId:space,userId:owner},{title:'Project note',primary_project_id:project,content_json:doc('Project evidence')})).id);await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});expect((await trash()).statusCode).toBe(404);
 await db.pool.query("UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",[project,peer]);expect((await trash()).statusCode).toBe(200);
});
it('rechecks current membership and Note ownership before replaying any receipt',async()=>{
 const key=randomUUID();expect((await rollback(key)).statusCode).toBe(200);const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});await db.pool.query('UPDATE space_objects SET owner_user_id=$2 WHERE id=$1',[note,other]);expect((await rollback(key)).statusCode).toBe(404);
 await db.pool.query('UPDATE space_objects SET owner_user_id=$2 WHERE id=$1',[note,owner]);await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);expect((await rollback(key)).statusCode).toBe(404);
});
it('hides foreign Note ids like unknown ids and refuses injected authority/version fields',async()=>{
 const foreign={space:randomUUID(),owner:randomUUID(),project:randomUUID(),spaceType:'team' as const};await seedSpaceOwnerProject(db.pool,foreign);__setAuthIdentityForTests({spaceId:foreign.space,userId:foreign.owner});expect((await trash()).statusCode).toBe(404);expect((await generic('knowledge.note.delete',{note_id:randomUUID()})).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:space,userId:owner});for(const extra of [{space_id:space},{user_id:owner},{note_id:note},{to_version:0},{force:true}])expect((await rollback(randomUUID(),{to_version:1,...extra})).statusCode).toBe(422);
 expect((await app.inject({method:'DELETE',url:`/api/v1/knowledge/notes/${note}`})).statusCode).toBe(422);expect((await rollback(randomUUID(),{to_version:99})).statusCode).toBe(404);
});
it('admits only one concurrent restore key before waiting on the Note row',async()=>{
 const hold=await db.pool.connect(),key=randomUUID();let pending:ReturnType<typeof rollback>|undefined;
 try{await hold.query('BEGIN');await hold.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE',[note]);pending=rollback(key);await waitForLockWaiter(db.pool);const duplicate=await rollback(key);expect(duplicate.statusCode).toBe(409);expect(duplicate.json().error.code).toBe('idempotency_in_progress');await hold.query('COMMIT');expect((await pending).statusCode).toBe(200);expect((await snapshot()).revisions).toHaveLength(3);}
 finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it('rechecks a private Note after a concurrent owner change while waiting for its row',async()=>{
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});const hold=await db.pool.connect();let pending:ReturnType<typeof rollback>|undefined;
 try{await hold.query('BEGIN');await hold.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE',[note]);pending=rollback();await waitForLockWaiter(db.pool);await hold.query('UPDATE space_objects SET owner_user_id=$2 WHERE id=$1',[note,other]);await hold.query('COMMIT');expect((await pending).statusCode).toBe(404);expect((await snapshot()).revisions).toHaveLength(2);}
 finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it.each(['note_revisions','domain_change_outbox','operation_idempotency','policy_decision_records'])('rolls back the restored content/revision when %s storage fails',async table=>{
 const before=await snapshot();await db.pool.query("CREATE FUNCTION refuse_note_control() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'note control storage refused'; END $$");await db.pool.query(`CREATE TRIGGER refuse_note_control BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_note_control()`);
 try{const response=await rollback();expect(response.statusCode,response.body).toBe(table==='policy_decision_records'?503:500);expect(await snapshot()).toEqual(before);}
 finally{await db.pool.query(`DROP TRIGGER refuse_note_control ON ${table}`);await db.pool.query('DROP FUNCTION refuse_note_control()');}
});
it('rolls back soft deletion if the receipt cannot be persisted',async()=>{
 const before=await snapshot();await db.pool.query("CREATE FUNCTION refuse_trash_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'trash receipt refused'; END $$");await db.pool.query('CREATE TRIGGER refuse_trash_receipt BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_trash_receipt()');
 try{expect((await trash()).statusCode).toBe(500);expect(await snapshot()).toEqual(before);}
 finally{await db.pool.query('DROP TRIGGER refuse_trash_receipt ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_trash_receipt()');}
});
it('contains a derived-index failure behind the existing writer savepoint without losing the canonical restore',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_note_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'projection unavailable'; END $$");await db.pool.query('CREATE TRIGGER refuse_note_projection BEFORE INSERT OR UPDATE ON retrieval_objects FOR EACH ROW EXECUTE FUNCTION refuse_note_projection()');
 try{const response=await rollback();expect(response.statusCode,response.body).toBe(200);expect((await snapshot()).note[0]).toMatchObject({version:3,plain_text:'First version'});}
 finally{await db.pool.query('DROP TRIGGER refuse_note_projection ON retrieval_objects');await db.pool.query('DROP FUNCTION refuse_note_projection()');}
});
it('withholds another person\'s shared body and rolls back the mutation if its required read audit fails',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='space_shared' WHERE id=$1",[note]);__setAuthIdentityForTests({spaceId:space,userId:peer});const before=await snapshot();
 await db.pool.query("CREATE FUNCTION refuse_note_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'read audit refused'; END $$");await db.pool.query('CREATE TRIGGER refuse_note_read_audit BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION refuse_note_read_audit()');
 try{expect((await rollback()).statusCode).toBe(500);expect(await snapshot()).toEqual(before);}
 finally{await db.pool.query('DROP TRIGGER refuse_note_read_audit ON content_access_logs');await db.pool.query('DROP FUNCTION refuse_note_read_audit()');}
});
it('rechecks the authoritative Project writer role after waiting without changing the Note',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
 note=String((await repo.createNote({spaceId:space,userId:owner},{title:'Project work',primary_project_id:project,content_json:doc('First')})).id);await repo.updateNote({spaceId:space,userId:owner},note,{content_json:doc('Second'),expect_version:1});const before=await snapshot();__setAuthIdentityForTests({spaceId:space,userId:peer});
 const hold=await db.pool.connect();let pending:ReturnType<typeof rollback>|undefined;
 try{await hold.query('BEGIN');await hold.query('SELECT id FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE',[project,peer]);pending=rollback();await waitForLockWaiter(db.pool);await hold.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,peer]);await hold.query('COMMIT');expect((await pending).statusCode).toBe(404);expect(await snapshot()).toEqual(before);}
 finally{await hold.query('ROLLBACK');hold.release();await pending;}
});

it('refuses Project scope growth after the Note wait without taking late Project authority or undoing the legitimate move',async()=>{
 const second=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,owner_user_id,status,created_at,updated_at) VALUES($1,$2,'Second',$3,'active',now(),now())",[second,space,owner]);await seedProjectMainlineRoom(db.pool,{space,project:second,owner});const targetFolder=await ensureProjectNotesFolder(db.pool,space,second);
 note=String((await repo.createNote({spaceId:space,userId:owner},{title:'Moving work',primary_project_id:project,content_json:doc('First')})).id);await repo.updateNote({spaceId:space,userId:owner},note,{content_json:doc('Second'),expect_version:1});
 const hold=await db.pool.connect();let pending:ReturnType<typeof rollback>|undefined;
 try{await hold.query('BEGIN');await hold.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE',[note]);pending=rollback();await waitForLockWaiter(db.pool);await new PgKnowledgeRepository(hold).updateNote({spaceId:space,userId:owner},note,{primary_project_id:second,collection_id:targetFolder});await hold.query('COMMIT');const moved=await snapshot();const refused=await pending;expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.code).toBe('operation_conflict');expect(moved.root[0]?.primary_project_id).toBe(second);expect(await snapshot()).toEqual(moved);expect(moved.revisions).toHaveLength(2);}
 finally{await hold.query('ROLLBACK');hold.release();await pending;}
});

it('normalizes omitted and explicit null optimistic versions to one historical receipt',async()=>{
 const key=randomUUID(),first=await rollback(key,{to_version:1});expect(first.statusCode,first.body).toBe(200);const before=await snapshot();
 expect((await generic('knowledge.note.rollback',{note_id:note,to_version:1,expect_version:null},key)).json()).toEqual(first.json());expect(await snapshot()).toEqual(before);
 expect(first.headers['x-request-id']).toBeTruthy();
});
it.each(['{broken','null','[]','"text"'])('uses the canonical malformed-body error without reserving a request: %s',async body=>{
 const before=await snapshot();const r=await app.inject({method:'POST',url:`/api/v1/knowledge/notes/${note}/rollback`,headers:{'content-type':'application/json','idempotency-key':randomUUID()},payload:body});
 expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('operation_invalid_input');expect(await snapshot()).toEqual(before);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
});
it('does not cache or reflect an unknown writer error, including arbitrary HTTP errors',async()=>{
 const {HttpError}=await import('../src/modules/routeUtils/common.js');const before=await snapshot();const key=randomUUID();
 const fault=vi.spyOn(PgKnowledgeRepository.prototype,'rollbackNote').mockRejectedValueOnce(new HttpError(422,'PRIVATE unknown writer failure'));
 try{const r=await rollback(key);expect(r.statusCode,r.body).toBe(500);expect(r.body).not.toContain('PRIVATE');expect(await snapshot()).toEqual(before);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);}finally{fault.mockRestore();}
 expect((await rollback(key)).statusCode).toBe(200);
});
it('requires B11 before historical body release and withholds revisions on audit storage failure',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='space_shared' WHERE id=$1",[note]);__setAuthIdentityForTests({spaceId:space,userId:peer});
 const read=()=>app.inject({method:'GET',url:`/api/v1/knowledge/notes/${note}/revisions`});expect((await read()).statusCode).toBe(200);
 expect((await db.pool.query('SELECT id FROM content_access_logs WHERE resource_id=$1 AND viewer_user_id=$2',[note,peer])).rows).toHaveLength(1);
 await db.pool.query("CREATE FUNCTION refuse_history_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE history audit'; END $$");await db.pool.query('CREATE TRIGGER refuse_history_audit BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION refuse_history_audit()');
 try{const r=await read();expect(r.statusCode).toBe(500);expect(r.body).not.toContain('First version');}finally{await db.pool.query('DROP TRIGGER refuse_history_audit ON content_access_logs');await db.pool.query('DROP FUNCTION refuse_history_audit()');}
});

it('does not grant a real manual Agent Run human Note controls, even with explicit tool grants',async()=>{
 const agent=randomUUID(),version=randomUUID(),run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent,version});
 await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1",[run,owner,JSON.stringify({tool_grants:[{action_id:'knowledge.note.rollback'},{action_id:'knowledge.note.delete'}]})]);
 const {runActor,assertCurrentActor,assertOperationGrant}=await import('../src/modules/systemActions/operations/actor.js');const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
 const row=(await db.pool.query<import('../src/modules/runs/repository.js').RunRecord>('SELECT * FROM runs WHERE id=$1',[run])).rows[0]!;const actor=await runActor(db.pool,row);await assertCurrentActor(db.pool,actor);
 const runtime=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));const before=await snapshot();
 for(const id of ['knowledge.note.rollback','knowledge.note.delete']){await assertOperationGrant(db.pool,actor,id);const result=await runtime.execute(id,{note_id:note,...(id.endsWith('rollback')?{to_version:1}:{})},actor,randomUUID(),randomUUID());expect(result.http_status).toBe(404);}
 expect(await snapshot()).toEqual(before);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
});
it.each(['policy_decision_records'])('rolls back trash and its current status when %s fails',async table=>{
 const before=await snapshot();await db.pool.query("CREATE FUNCTION refuse_note_trash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE trash'; END $$");await db.pool.query(`CREATE TRIGGER refuse_note_trash BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_note_trash()`);
 try{const r=await trash();expect(r.statusCode,r.body).toBe(table==='policy_decision_records'?503:500);expect(r.body).not.toContain('PRIVATE');expect(await snapshot()).toEqual(before);}finally{await db.pool.query(`DROP TRIGGER refuse_note_trash ON ${table}`);await db.pool.query('DROP FUNCTION refuse_note_trash()');}
});
