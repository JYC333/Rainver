import {focusAreasModule} from '../src/modules/focusAreas/index.js';
import {projectWorkModule} from '../src/modules/projectWork/index.js';
import {projectReviewModule} from '../src/modules/projectReview/index.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {decisionsModule} from '../src/modules/decisions/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {waitForLockWaiter} from './support/lockWait.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,user:string,project:string,app:ReturnType<typeof buildModuleServer>;
const call=(id:string,input:object,key:string=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
beforeEach(async()=>{await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();user=randomUUID();project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[projectsModule,decisionsModule,focusAreasModule,projectWorkModule,projectReviewModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:user});});
afterEach(async()=>{__setAuthIdentityForTests(null);await app.close();});
it('creates Project, published Brief v1 and mainline Room atomically and replays across REST and generic entries',async()=>{
 const key=randomUUID(),input={name:'PRIVATE Project',goal:'PRIVATE goal'};
 const r=await app.inject({method:'POST',url:'/api/v1/projects',payload:input,headers:{'idempotency-key':key}});expect(r.statusCode,r.body).toBe(201);expect(r.body).not.toContain('PRIVATE');const id=r.json().data.id;
 expect((await call('project.create',input,key)).json()).toEqual(r.json());
 expect((await db.pool.query('SELECT id FROM projects WHERE id=$1 AND active_brief_version_id IS NOT NULL',[id])).rows).toHaveLength(1);
 expect((await db.pool.query('SELECT id FROM rooms WHERE project_id=$1 AND is_mainline=true',[id])).rows).toHaveLength(1);
 expect((await call('project.create',{...input,name:'different'},key)).statusCode).toBe(422);
 expect((await call('project.create',input)).statusCode).toBe(409);
});
it('strictly refuses spoofed authority and missing keys without a domain row',async()=>{
 for(const input of [{name:'X',user_id:randomUUID()},{name:'X',space_id:randomUUID()},{name:'X',status:'archived'}])expect((await call('project.create',input)).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:'/api/v1/projects',payload:{name:'X'}})).statusCode).toBe(422);
 expect((await db.pool.query('SELECT id FROM projects')).rows).toHaveLength(1);
});
it('runs Brief and Instruction draft/review/publication transitions and replays old receipts without republishing',async()=>{
 for(const kind of ['brief','instruction']){
  const draft=await call(`project.${kind}.create`,{project_id:project,...(kind==='brief'?{goal:'PRIVATE new goal'}:{title:'PRIVATE title',instruction_text:'PRIVATE instructions'})});expect(draft.statusCode,draft.body).toBe(201);expect(draft.body).not.toContain('PRIVATE');const version=draft.json().data.id;
  expect((await call(`project.${kind}.publish`,{project_id:project,version_id:version})).statusCode).toBe(409);
  const key=randomUUID(),input={project_id:project,version_id:version};const reviewed=await call(`project.${kind}.submit_review`,input,key);expect(reviewed.statusCode,reviewed.body).toBe(200);
  const published=await call(`project.${kind}.publish`,input);expect(published.statusCode,published.body).toBe(200);
  expect((await call(`project.${kind}.submit_review`,input,key)).json()).toEqual(reviewed.json());
  expect((await db.pool.query(`SELECT status FROM project_${kind}_versions WHERE id=$1`,[version])).rows).toEqual([{status:'published'}]);
 }
});
it('revalidates publication authority on replay and active Project status',async()=>{
 const draft=await call('project.brief.create',{project_id:project,goal:'Goal'}),version=draft.json().data.id;
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});
 expect((await call('project.brief.submit_review',{project_id:project,version_id:version})).statusCode).toBe(200);
 expect((await call('project.brief.publish',{project_id:project,version_id:version})).statusCode).toBe(404);
 const key=randomUUID(),input={project_id:project,goal:'Second'};const created=await call('project.brief.create',input,key);expect(created.statusCode,created.body).toBe(201);
 await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,peer]);expect((await call('project.brief.create',input,key)).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:space,userId:user});await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);expect((await call('project.brief.create',{project_id:project,goal:'Archived'})).statusCode).toBe(409);
});
it('keeps roster role authority and live Space membership on new calls and replay',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});const key=randomUUID(),input={project_id:project,user_id:peer,role:'viewer'};
 const added=await call('project.member.add',input,key);expect(added.statusCode,added.body).toBe(201);expect((await call('project.member.add',input,key)).json()).toEqual(added.json());
 expect((await db.pool.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',[project,peer])).rows).toEqual([{role:'viewer'}]);
 await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,peer]);expect((await call('project.member.add',input,key)).statusCode).toBe(422);
 const removed=await call('project.member.remove',{project_id:project,user_id:peer});expect(removed.statusCode,removed.body).toBe(200);expect((await db.pool.query('SELECT id FROM project_members WHERE project_id=$1 AND user_id=$2',[project,peer])).rows).toEqual([]);
});
it('retains Space admin inability to replace a Project owner',async()=>{
 const admin=randomUUID();await seedSpaceMember(db.pool,{space,user:admin});await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[space,admin]);await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'owner','active',now(),now())",[randomUUID(),space,project,user]);__setAuthIdentityForTests({spaceId:space,userId:admin});
 expect((await call('project.member.add',{project_id:project,user_id:user,role:'member'})).statusCode).toBe(404);expect((await call('project.member.remove',{project_id:project,user_id:user})).statusCode).toBe(404);
});
it('lets a Project reader set only their own attention state',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});const source=randomUUID(),input={project_id:project,source_type:'inquiry',source_id:source,seen_at:'2026-01-01T00:00:00.000Z'},key=randomUUID();const r=await call('project.attention.set_state',input,key);expect(r.statusCode,r.body).toBe(200);expect((await call('project.attention.set_state',input,key)).json()).toEqual(r.json());expect((await db.pool.query('SELECT user_id,seen_at FROM project_attention_user_states WHERE project_id=$1',[project])).rows[0]?.user_id).toBe(peer);expect((await call('project.attention.set_state',{...input,user_id:user})).statusCode).toBe(422);
});
async function decision(){const r=await call('decision.case.create',{project_id:project,title:'PRIVATE case'});expect(r.statusCode,r.body).toBe(201);return r.json().data.id as string;}
it('closes the seven Decision commands through one writer and produces one delivery Task',async()=>{
 const c=await decision(),base={project_id:project,case_id:c};
 const o=await call('decision.option.add',{...base,title:'PRIVATE option'});expect(o.statusCode,o.body).toBe(201);const option=o.json().data.id;
 const cr=await call('decision.criterion.add',{...base,name:'PRIVATE criterion',weight:3});expect(cr.statusCode,cr.body).toBe(201);
 const sc=await call('decision.option.score',{...base,option_id:option,criterion_id:cr.json().data.id,score:5});expect(sc.statusCode,sc.body).toBe(201);
 expect((await call('decision.commitment.add',{...base,statement:'Too early'})).statusCode).toBe(409);
 expect((await call('decision.case.decide',{...base,option_id:option})).statusCode).toBe(200);
 const commitment=await call('decision.commitment.add',{...base,statement:'PRIVATE promise'});expect(commitment.statusCode,commitment.body).toBe(201);
 const key=randomUUID(),input={...base,commitment_id:commitment.json().data.id};const delivered=await call('decision.commitment.deliver',input,key);expect(delivered.statusCode,delivered.body).toBe(201);expect(delivered.body).not.toContain('PRIVATE');expect((await call('decision.commitment.deliver',input,key)).json()).toEqual(delivered.json());expect((await call('decision.commitment.deliver',input)).statusCode).toBe(409);expect((await db.pool.query('SELECT id FROM tasks WHERE project_id=$1',[project])).rows).toHaveLength(1);
});
it('withholds old Decision receipts after Case content visibility is withdrawn',async()=>{
 const c=await decision(),key=randomUUID(),input={project_id:project,case_id:c,title:'PRIVATE option'};expect((await call('decision.option.add',input,key)).statusCode).toBe(201);const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[c,peer]);const replay=await call('decision.option.add',input,key);expect(replay.statusCode,replay.body).toBe(404);expect(replay.body).not.toContain('PRIVATE');
});
it('rolls Project/Brief/Room and request back on mandatory audit failure',async()=>{
 const before=await Promise.all(['project_brief_versions','rooms','operation_idempotency'].map(async table=>(await db.pool.query(`SELECT id FROM ${table} WHERE space_id=$1 ORDER BY id`,[space])).rows));
 await db.pool.query("CREATE FUNCTION refuse_management_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE audit failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_management_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_management_audit()');
 try{const r=await call('project.create',{name:'Do not persist'});expect(r.statusCode,r.body).toBe(503);expect(r.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM projects')).rows).toHaveLength(1);expect(await Promise.all(['project_brief_versions','rooms','operation_idempotency'].map(async table=>(await db.pool.query(`SELECT id FROM ${table} WHERE space_id=$1 ORDER BY id`,[space])).rows))).toEqual(before);}finally{await db.pool.query('DROP TRIGGER refuse_management_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_management_audit()');}
});
it('revalidates writer revocation after waiting for the Project fence',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});const hold=await db.pool.connect();try{await hold.query('BEGIN');await hold.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);const pending=call('project.brief.create',{project_id:project,goal:'Must not persist'});await waitForLockWaiter(db.pool);await hold.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,peer]);await hold.query('COMMIT');expect((await pending).statusCode).toBe(404);expect((await db.pool.query('SELECT id FROM project_brief_versions WHERE project_id=$1',[project])).rows).toEqual([]);}finally{await hold.query('ROLLBACK');hold.release();}
});
it('rolls back the Project and Brief when the nested canonical Room writer fails',async()=>{
 const before=(await db.pool.query('SELECT id FROM projects WHERE space_id=$1 ORDER BY id',[space])).rows;
 await db.pool.query("CREATE FUNCTION refuse_management_room() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE Room failed'; END $$");await db.pool.query('CREATE TRIGGER refuse_management_room BEFORE INSERT ON rooms FOR EACH ROW EXECUTE FUNCTION refuse_management_room()');
 try{const r=await call('project.create',{name:'Rollback nested writer'});expect(r.statusCode,r.body).toBe(500);expect(r.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM projects WHERE space_id=$1 ORDER BY id',[space])).rows).toEqual(before);expect((await db.pool.query('SELECT id FROM project_brief_versions WHERE space_id=$1',[space])).rows).toEqual([]);expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);}finally{await db.pool.query('DROP TRIGGER refuse_management_room ON rooms');await db.pool.query('DROP FUNCTION refuse_management_room()');}
});
it('refuses a concurrent same-key reservation while the first writer waits, then replays the sole draft',async()=>{
 const hold=await db.pool.connect(),key=randomUUID(),input={project_id:project,goal:'Once'};
 try{await hold.query('BEGIN');await hold.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);const pending=call('project.brief.create',input,key);await waitForLockWaiter(db.pool);const concurrent=await call('project.brief.create',input,key);expect(concurrent.statusCode,concurrent.body).toBe(409);await hold.query('COMMIT');const first=await pending;expect(first.statusCode,first.body).toBe(201);expect((await call('project.brief.create',input,key)).json()).toEqual(first.json());expect((await db.pool.query('SELECT id FROM project_brief_versions WHERE project_id=$1',[project])).rows).toHaveLength(1);}finally{await hold.query('ROLLBACK');hold.release();}
});
it('classifies and clears a Project with cross-entry replay, live focus status and no classification ACL',async()=>{
 const area=randomUUID();await db.pool.query("INSERT INTO focus_areas(id,space_id,owner_user_id,name,created_at,updated_at) VALUES($1,$2,$3,'PRIVATE area',now(),now())",[area,space,user]);
 const key=randomUUID(),input={project_id:project,focus_area_id:area};const r=await call('project.focus_area.set',input,key);expect(r.statusCode,r.body).toBe(200);expect(r.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT focus_area_id FROM projects WHERE id=$1',[project])).rows).toEqual([{focus_area_id:area}]);
 expect((await app.inject({method:'PUT',url:`/api/v1/projects/${project}/focus-area`,payload:{focus_area_id:area},headers:{'idempotency-key':key}})).json()).toEqual(r.json());
 await db.pool.query('UPDATE focus_areas SET archived_at=now() WHERE id=$1',[area]);expect((await call('project.focus_area.set',input,key)).statusCode).toBe(409);expect((await call('project.focus_area.set',{project_id:project,focus_area_id:null})).statusCode).toBe(200);
});
it('reports exactly one append-only work event and replays without returning the report body',async()=>{
 const key=randomUUID(),input={project_id:project,summary:'PRIVATE report'};const r=await call('project.update.report',input,key);expect(r.statusCode,r.body).toBe(201);expect(r.body).not.toContain('PRIVATE');expect((await call('project.update.report',input,key)).json()).toEqual(r.json());expect((await db.pool.query("SELECT id FROM project_work_events WHERE project_id=$1 AND event_kind='project.reported'",[project])).rows).toHaveLength(1);
 const undoInput={project_id:project,event_id:r.json().data.id};const refused=await call('project.update.undo',undoInput);expect(refused.statusCode,refused.body).toBe(409);
});
it('opens one combined review without reopening or replacing its packets on receipt replay',async()=>{
 const key=randomUUID(),input={project_id:project,limit:5};const r=await call('project.review_session.open',input,key);expect(r.statusCode,r.body).toBe(201);expect(r.json().data.inquiry_packet_id).toBeNull();const packet=r.json().data.knowledge_packet_id;
 expect((await call('project.review_session.open',input,key)).json()).toEqual(r.json());expect((await db.pool.query('SELECT id FROM knowledge_promotion_review_packets WHERE project_id=$1',[project])).rows).toEqual([{id:packet}]);
 expect((await call('project.review_session.open',input)).statusCode).toBe(201);expect((await call('project.review_session.open',input,key)).json()).toEqual(r.json());expect((await db.pool.query('SELECT status FROM knowledge_promotion_review_packets WHERE id=$1',[packet])).rows).toEqual([{status:'closed'}]);
});
it('undoes a Thread creation atomically once and suppresses replay when its private audience is withdrawn',async()=>{
 const {InquiryThreadService}=await import('../src/modules/inquiry/threadService.js'),thread=await new InquiryThreadService(db.pool).createThread({spaceId:space,userId:user},project,{kind:'question',statement:'PRIVATE thread'});
 const event=(await db.pool.query("SELECT id FROM project_work_events WHERE project_id=$1 AND subject_id=$2 AND event_kind='thread.created'",[project,thread.id])).rows[0]!.id as string,key=randomUUID(),input={project_id:project,event_id:event};
 const r=await call('project.update.undo',input,key);expect(r.statusCode,r.body).toBe(200);expect(r.body).not.toContain('PRIVATE');expect((await call('project.update.undo',input,key)).json()).toEqual(r.json());expect((await db.pool.query('SELECT lifecycle_status FROM inquiry_threads WHERE object_id=$1',[thread.id])).rows).toEqual([{lifecycle_status:'archived'}]);expect((await call('project.update.undo',input)).statusCode).toBe(409);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[thread.id,peer]);expect((await call('project.update.undo',input,key)).statusCode).toBe(404);
});
it('retains a Project reader’s right to undo their own Memory through the canonical applier, including old-key replay',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);
 const {insertMemoryEntry}=await import('./support/memoryFixtures.js'),{resolveUserActorId}=await import('../src/db/actorResolver.js'),{appendProjectWorkEvent}=await import('../src/modules/projectWork/eventWriter.js');const memory=randomUUID();await insertMemoryEntry(db.pool,space,{id:memory,scope_type:'project',project_id:project,owner_user_id:peer,content:'PRIVATE own memory'});const event=await appendProjectWorkEvent(db.pool,{spaceId:space,projectId:project,subjectType:'memory_entry',subjectId:memory,eventKind:'memory.remembered',actorId:await resolveUserActorId(db.pool,space,peer),data:{summary:'PRIVATE own memory'}});
 __setAuthIdentityForTests({spaceId:space,userId:peer});const key=randomUUID(),body={project_id:project,event_id:event.id},r=await call('project.update.undo',body,key);expect(r.statusCode,r.body).toBe(200);expect(r.body).not.toContain('PRIVATE');expect((await call('project.update.undo',body,key)).json()).toEqual(r.json());expect((await db.pool.query('SELECT status FROM memory_entries WHERE id=$1',[memory])).rows).toEqual([{status:'archived'}]);
 await db.pool.query('UPDATE memory_entries SET owner_user_id=$2 WHERE id=$1',[memory,user]);expect((await call('project.update.undo',body,key)).statusCode).toBe(404);
});
it('rolls a canonical own-Memory undo back when its required Project event fails',async()=>{
 const {insertMemoryEntry}=await import('./support/memoryFixtures.js'),{resolveUserActorId}=await import('../src/db/actorResolver.js'),{appendProjectWorkEvent}=await import('../src/modules/projectWork/eventWriter.js');const memory=randomUUID();await insertMemoryEntry(db.pool,space,{id:memory,scope_type:'project',project_id:project,owner_user_id:user});const event=await appendProjectWorkEvent(db.pool,{spaceId:space,projectId:project,subjectType:'memory_entry',subjectId:memory,eventKind:'memory.remembered',actorId:await resolveUserActorId(db.pool,space,user)});
 await db.pool.query("CREATE FUNCTION refuse_memory_undo_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_kind='memory.archived' THEN RAISE EXCEPTION 'PRIVATE event failure'; END IF; RETURN NEW; END $$");await db.pool.query('CREATE TRIGGER refuse_memory_undo_event BEFORE INSERT ON project_work_events FOR EACH ROW EXECUTE FUNCTION refuse_memory_undo_event()');
 try{const r=await call('project.update.undo',{project_id:project,event_id:event.id});expect(r.statusCode,r.body).toBe(500);expect(r.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT status FROM memory_entries WHERE id=$1',[memory])).rows).toEqual([{status:'active'}]);expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);}finally{await db.pool.query('DROP TRIGGER refuse_memory_undo_event ON project_work_events');await db.pool.query('DROP FUNCTION refuse_memory_undo_event()');}
});
