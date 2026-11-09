import {waitForLockWaiter} from './support/lockWait.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {PgKnowledgeRepository} from '../src/modules/knowledge/repository.js';
const db=useTestDatabase(import.meta.filename);
let space:string,user:string,project:string,note:string,app:ReturnType<typeof buildModuleServer>;
const call=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
beforeEach(async()=>{await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();user=randomUUID();project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});note=String((await new PgKnowledgeRepository(db.pool).createNote({spaceId:space,userId:user},{title:'Private draft',visibility:'private',primary_project_id:project})).id);app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[knowledgeModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:user});});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('promotes a passage once across REST/generic replay, preserving pending proposal provenance and old receipt',async()=>{
 const key=randomUUID(),body={content:'Selected passage'};
 const r=await app.inject({method:'POST',url:`/api/v1/knowledge/notes/${note}/promote`,payload:body,headers:{'idempotency-key':key}});
 expect(r.statusCode,r.body).toBe(202);const receipt=r.json();expect(receipt.status).toBe('succeeded');expect(r.body).not.toContain(body.content);
 expect((await call('note.promote_to_knowledge',{note_id:note,...body},key)).json()).toEqual(receipt);
 expect((await call('note.promote_to_knowledge',{note_id:note,content:'Different'},key)).statusCode).toBe(422);
 const rows=(await db.pool.query('SELECT status,payload_json,created_by_user_id FROM proposals WHERE space_id=$1',[space])).rows;
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({status:'pending',created_by_user_id:user,payload_json:{source_refs:[{source_type:'note',source_id:note,evidence_json:{note_version:1,excerpt:body.content}}]}});
 expect((await db.pool.query('SELECT * FROM knowledge_items WHERE space_id=$1',[space])).rows).toHaveLength(0);
 await db.pool.query("UPDATE proposals SET status='superseded' WHERE space_id=$1",[space]);
 expect((await call('note.promote_to_knowledge',{note_id:note,...body},key)).json()).toEqual(receipt);
});
it('hides private and foreign Notes and rechecks current authority on receipt replay',async()=>{
 const input={note_id:note,content:'Selected'},key=randomUUID();expect((await call('note.promote_to_knowledge',input,key)).statusCode).toBe(202);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});__setAuthIdentityForTests({spaceId:space,userId:peer});
 const denied=await call('note.promote_to_knowledge',input);expect(denied.statusCode,denied.body).toBe(404);expect(denied.body).not.toContain('Private draft');
 __setAuthIdentityForTests({spaceId:space,userId:user});await db.pool.query('UPDATE space_objects SET owner_user_id=$2 WHERE id=$1',[note,peer]);expect((await call('note.promote_to_knowledge',input,key)).statusCode).toBe(404);
 expect((await call('note.promote_to_knowledge',{...input,note_id:randomUUID()})).statusCode).toBe(404);
});
it.each(['proposals','operation_idempotency','policy_decision_records'])('rolls promotion and request back when %s storage fails',async table=>{
 await db.pool.query("CREATE FUNCTION refuse_knowledge_object() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE storage'; END $$");await db.pool.query(`CREATE TRIGGER refuse_knowledge_object BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_knowledge_object()`);
 try{const r=await call('note.promote_to_knowledge',{note_id:note,content:'Selected'});expect(r.statusCode,r.body).toBe(table==='policy_decision_records'?503:500);expect(r.body).not.toContain('PRIVATE');if(table==='proposals')expect((await db.pool.query("SELECT metadata_json->>'operation_outcome' AS outcome FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[r.json().error.request_id])).rows).toEqual([{outcome:'failed'}]);expect((await db.pool.query('SELECT * FROM proposals WHERE space_id=$1',[space])).rows).toEqual([]);expect((await db.pool.query('SELECT * FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);}finally{await db.pool.query(`DROP TRIGGER refuse_knowledge_object ON ${table}`);await db.pool.query('DROP FUNCTION refuse_knowledge_object()');}
});
it('serializes same-key promotion without duplicating human approval',async()=>{const key=randomUUID(),input={note_id:note,content:'Race'};const results=await Promise.all([call('note.promote_to_knowledge',input,key),call('note.promote_to_knowledge',input,key)]);const first=results.find(r=>r.statusCode===202)!;expect(first).toBeDefined();for(const result of results)if(result.statusCode!==202){expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('idempotency_in_progress');}expect((await call('note.promote_to_knowledge',input,key)).json()).toEqual(first.json());expect((await db.pool.query('SELECT id FROM proposals WHERE space_id=$1',[space])).rows).toHaveLength(1);});
it('creates and updates evidence Sources under their actual Project, with body-free receipts and archive replay',async()=>{
 const key=randomUUID(),body={source_type:'manual_reference',title:'Evidence',project_id:project,raw_text:'PRIVATE content'};
 const created=await app.inject({method:'POST',url:'/api/v1/knowledge/sources',payload:body,headers:{'idempotency-key':key}});expect(created.statusCode,created.body).toBe(201);expect(created.body).not.toContain('PRIVATE');expect((await call('knowledge.source.create',body,key)).json()).toEqual(created.json());
 const id=created.json().data.id;
 const updated=await app.inject({method:'PATCH',url:`/api/v1/knowledge/sources/${id}`,payload:{title:'Updated',raw_text:null},headers:{'idempotency-key':randomUUID()}});expect(updated.statusCode,updated.body).toBe(200);
 const read=await new PgKnowledgeRepository(db.pool).getSource({spaceId:space,userId:user},id);expect(read).toMatchObject({title:'Updated',raw_text:null});
 const archiveKey=randomUUID();expect((await app.inject({method:'DELETE',url:`/api/v1/knowledge/sources/${id}`,headers:{'idempotency-key':archiveKey}})).statusCode).toBe(200);expect((await call('knowledge.source.archive',{source_id:id},archiveKey)).statusCode).toBe(200);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[id,peer]);expect((await call('knowledge.source.archive',{source_id:id},archiveKey)).statusCode).toBe(404);
});
it.each(['sources','operation_idempotency','policy_decision_records'])('rolls evidence Source root and extension back if %s fails',async table=>{
 await db.pool.query("CREATE FUNCTION refuse_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE storage'; END $$");await db.pool.query(`CREATE TRIGGER refuse_evidence BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_evidence()`);
 try{const r=await call('knowledge.source.create',{source_type:'paper',title:'No partial',project_id:project});expect(r.statusCode,r.body).toBe(table==='policy_decision_records'?503:500);expect(r.body).not.toContain('PRIVATE');expect((await db.pool.query("SELECT id FROM space_objects WHERE space_id=$1 AND object_type='source'",[space])).rows).toEqual([]);}finally{await db.pool.query(`DROP TRIGGER refuse_evidence ON ${table}`);await db.pool.query('DROP FUNCTION refuse_evidence()');}
});
it('rejects a real granted Agent Run for every new human entry',async()=>{
 const {runActor,assertCurrentActor}=await import('../src/modules/systemActions/operations/actor.js');const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
 const run=randomUUID();await seedRun(db.pool,{id:run,space,owner:user,agent:randomUUID(),version:randomUUID()});
 const commands=[['note.promote_to_knowledge',{note_id:note,content:'Selected'}],['knowledge.source.create',{title:'No',source_type:'paper',project_id:project}],['knowledge.source.update',{source_id:note,changes:{title:'No'}}],['knowledge.source.archive',{source_id:note}]] as const;
 await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1",[run,user,JSON.stringify({tool_grants:commands.map(([action_id])=>({action_id}))})]);
 const actor=await runActor(db.pool,(await db.pool.query<import('../src/modules/runs/repository.js').RunRecord>('SELECT * FROM runs WHERE id=$1',[run])).rows[0]!);await assertCurrentActor(db.pool,actor);
 const runtime=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));for(const [id,input] of commands)expect((await runtime.execute(id,input,actor,randomUUID(),randomUUID())).http_status).toBe(404);
 expect((await db.pool.query('SELECT * FROM proposals WHERE space_id=$1',[space])).rows).toEqual([]);
});
it('rejects Note scope growth after a real row wait without creating a proposal or taking a late Project key',async()=>{
 const holder=await db.pool.connect();let pending:ReturnType<typeof call>|undefined;
 try{await holder.query('BEGIN');await holder.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE',[note]);pending=call('note.promote_to_knowledge',{note_id:note,content:'Selected'});await waitForLockWaiter(db.pool);await holder.query('UPDATE space_objects SET primary_project_id=NULL WHERE id=$1',[note]);await holder.query('COMMIT');const result=await pending;expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('operation_conflict');expect((await db.pool.query('SELECT * FROM proposals WHERE space_id=$1',[space])).rows).toEqual([]);expect((await db.pool.query('SELECT * FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);}finally{await holder.query('ROLLBACK');holder.release();await pending;}
});
it('does not cache an unknown helper422 or expose its message',async()=>{
 const {HttpError}=await import('../src/modules/routeUtils/common.js');const spy=vi.spyOn(PgKnowledgeRepository.prototype,'promoteNoteToKnowledge').mockRejectedValueOnce(new HttpError(422,'PRIVATE unknown helper'));
 try{const r=await call('note.promote_to_knowledge',{note_id:note,content:'Selected'});expect(r.statusCode,r.body).toBe(500);expect(r.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT * FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);}finally{spy.mockRestore();}
});
it('keeps context-free evidence roots private in Personal and preserves separate-key creation intent',async()=>{
 const personal=randomUUID();await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Personal','personal',now(),now())",[personal]);await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,user]);
 const body={title:'Private evidence',source_type:'paper',visibility:'space_shared'},key=randomUUID();const r=await call('knowledge.source.create',body,key);expect(r.statusCode,r.body).toBe(201);expect(r.json().data.space_id).toBe(personal);expect((await db.pool.query('SELECT visibility,primary_project_id FROM space_objects WHERE id=$1',[r.json().data.id])).rows).toEqual([{visibility:'private',primary_project_id:null}]);expect((await call('knowledge.source.create',{...body,title:'Changed'},key)).statusCode).toBe(422);expect((await call('knowledge.source.create',body)).statusCode).toBe(201);expect((await db.pool.query('SELECT object_id FROM sources WHERE space_id=$1',[personal])).rows).toHaveLength(2);
});
it('keeps different-key evidence edits serialized without losing independent field updates',async()=>{
 const r=await call('knowledge.source.create',{title:'Source',source_type:'paper',project_id:project}),source_id=r.json().data.id;
 const responses=await Promise.all([call('knowledge.source.update',{source_id,changes:{title:'New title'}}),call('knowledge.source.update',{source_id,changes:{uri:'https://example.test/evidence'}})]);expect(responses.map(r=>r.statusCode)).toEqual([200,200]);expect(await new PgKnowledgeRepository(db.pool).getSource({spaceId:space,userId:user},source_id)).toMatchObject({title:'New title',uri:'https://example.test/evidence'});
});
it('rechecks evidence Project writer while waiting on the granting membership and rolls back on revocation',async()=>{
 const r=await call('knowledge.source.create',{title:'Source',source_type:'paper',project_id:project}),source_id=r.json().data.id,peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
 const holder=await db.pool.connect();let pending:ReturnType<typeof call>|undefined;try{await holder.query('BEGIN');await holder.query('SELECT id FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE',[project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});pending=call('knowledge.source.update',{source_id,changes:{title:'Forbidden'}});await waitForLockWaiter(db.pool);await holder.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,peer]);await holder.query('COMMIT');const result=await pending;expect(result.statusCode,result.body).toBe(404);expect((await db.pool.query('SELECT title FROM space_objects WHERE id=$1',[source_id])).rows).toEqual([{title:'Source'}]);}finally{await holder.query('ROLLBACK');holder.release();await pending;}
});
it('returns no private Note or evidence signal across a real foreign Space',async()=>{
 const other=randomUUID(),otherOwner=randomUUID();await seedSpaceOwnerProject(db.pool,{space:other,owner:otherOwner,project:randomUUID(),spaceType:'team'});__setAuthIdentityForTests({spaceId:other,userId:otherOwner});for(const [id,input] of [['note.promote_to_knowledge',{note_id:note,content:'Selected'}],['knowledge.source.update',{source_id:note,changes:{title:'No'}}]] as const){const r=await call(id,input);expect(r.statusCode,r.body).toBe(404);expect(r.body).not.toContain('Private draft');}
});
it('normalizes omitted/null evidence creation defaults under the same key',async()=>{const key=randomUUID(),input={title:'Defaults',source_type:'paper',project_id:project};const r=await call('knowledge.source.create',input,key);expect(r.statusCode,r.body).toBe(201);expect((await call('knowledge.source.create',{...input,raw_text:null,summary:null,uri:null,content_ref:null,metadata:{},status:'raw'},key)).json()).toEqual(r.json());});
it('fails closed on required cross-user evidence detail read audit storage without releasing content',async()=>{
 const r=await call('knowledge.source.create',{title:'Shared evidence',raw_text:'BODY MUST NOT ESCAPE',source_type:'paper',project_id:project}),id=r.json().data.id,peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});
 await db.pool.query("CREATE FUNCTION refuse_evidence_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE audit'; END $$");await db.pool.query('CREATE TRIGGER refuse_evidence_read BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION refuse_evidence_read()');
 try{const response=await app.inject({method:'GET',url:`/api/v1/knowledge/sources/${id}`});expect(response.statusCode,response.body).toBe(503);expect(response.body).not.toContain('BODY MUST NOT ESCAPE');}finally{await db.pool.query('DROP TRIGGER refuse_evidence_read ON content_access_logs');await db.pool.query('DROP FUNCTION refuse_evidence_read()');}
});
