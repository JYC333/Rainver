import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {inquiryModule} from '../src/modules/inquiry/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {PgKnowledgeRepository} from '../src/modules/knowledge/repository.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,note:string,app:ReturnType<typeof buildModuleServer>;
const body=()=>({note_object_id:note,statement:'Does the effect survive a stronger control?'});
const url=()=>`/api/v1/projects/${project}/inquiry/threads/from-note`;
const formal=(input:object=body(),key=randomUUID())=>app.inject({method:'POST',url:url(),payload:input,headers:{'idempotency-key':key}});
const generic=(input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/note.raise_as_question',payload:input,headers:{'idempotency-key':key}});
const created=async()=>({
  threads:(await db.pool.query('SELECT object_id FROM inquiry_threads ORDER BY object_id')).rows,
  roots:(await db.pool.query("SELECT id FROM space_objects WHERE object_type='inquiry_thread' ORDER BY id")).rows,
  links:(await db.pool.query("SELECT id FROM object_relations WHERE from_object_id IN (SELECT object_id FROM inquiry_threads) ORDER BY id")).rows,
  revisions:(await db.pool.query('SELECT id FROM inquiry_thread_revisions ORDER BY id')).rows,
  outbox:(await db.pool.query("SELECT id FROM domain_change_outbox WHERE source_kind='inquiry_thread' ORDER BY id")).rows,
  events:(await db.pool.query("SELECT id FROM project_work_events WHERE event_kind='thread.created' ORDER BY id")).rows,
});
beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users'],{cascade:true});
  space=randomUUID();owner=randomUUID();project=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
  note=String((await new PgKnowledgeRepository(db.pool).createNote({spaceId:space,userId:owner},{title:'Working note',primary_project_id:project,plain_text:'Original reasoning'})).id);
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[inquiryModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('shares formal/generic receipts with canonical revision, event and Note provenance',async()=>{
  const key=randomUUID(),input=body(),original=(await db.pool.query('SELECT version,plain_text FROM notes WHERE object_id=$1',[note])).rows;
  const response=await formal(input,key);expect(response.statusCode,response.body).toBe(201);
  const out=response.json().data;expect(out).toMatchObject({note_object_id:note,project_id:project,kind:'question'});
  const saved=await created();for(const value of Object.values(saved))expect(value).toHaveLength(1);
  expect((await generic({...input,project_id:project},key)).json()).toEqual(response.json());expect(await created()).toEqual(saved);
  expect((await db.pool.query('SELECT version,plain_text FROM notes WHERE object_id=$1',[note])).rows).toEqual(original);
  expect((await db.pool.query('SELECT to_object_id,link_type FROM object_relations WHERE from_object_id=$1',[out.thread_id])).rows).toEqual([{to_object_id:note,link_type:'references'}]);
  expect((await generic({...input,project_id:project,statement:'A different question'},key)).json().error.code).toBe('idempotency_key_reused');
});
it('preserves hypothesis state, parent and separate producer uniqueness',async()=>{
  const first=await formal();expect(first.statusCode,first.body).toBe(201);
  const input={...body(),kind:'hypothesis',primary_parent_id:first.json().data.thread_id,producer_idempotency_key:'producer-one',proposed_claim:'Depth drives gain',predictions:'A deeper control improves',falsification_criteria:'A matched control fails',link_kind:'primary_working_note'};
  const response=await formal(input);expect(response.statusCode,response.body).toBe(201);
  const before=await created();expect((await formal(input)).json().data).toEqual(response.json().data);expect(await created()).toEqual(before);
  expect((await db.pool.query('SELECT proposed_claim,predictions,falsification_criteria FROM inquiry_hypothesis_states WHERE thread_id=$1',[response.json().data.thread_id])).rows[0]).toMatchObject({proposed_claim:input.proposed_claim,predictions:input.predictions,falsification_criteria:input.falsification_criteria});
  expect((await formal({...input,statement:'Changed producer intent'})).statusCode).toBe(409);
});
it('rechecks Project writer and Note read reach on replay',async()=>{
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
  await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=$1",[note]);
  __setAuthIdentityForTests({spaceId:space,userId:peer});
  expect((await formal()).statusCode).toBe(404);
  await db.pool.query("UPDATE space_objects SET visibility='selected_users' WHERE id=$1",[note]);
  await db.pool.query("INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,access_level,granted_by_user_id,created_at,updated_at) VALUES($1,$2,'space_object',$3,$4,'full',$5,now(),now())",[randomUUID(),space,note,peer,owner]);
  const key=randomUUID(),response=await formal(body(),key);expect(response.statusCode,response.body).toBe(201);
  await db.pool.query('DELETE FROM content_access_grants WHERE resource_id=$1',[note]);expect((await formal(body(),key)).statusCode).toBe(404);
  await db.pool.query("UPDATE space_objects SET visibility='space_shared' WHERE id=$1",[note]);
  await db.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,peer]);expect((await formal(body(),key)).statusCode).toBe(404);
});
it('refuses archived Project and invalid authority/fields before mutation',async()=>{
  for(const input of [{...body(),project_id:project},{...body(),kind:'answer'},{...body(),run_id:randomUUID()}])expect((await formal(input)).statusCode).toBe(422);
  expect((await formal({...body(),note_object_id:randomUUID()})).statusCode).toBe(404);
  await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);expect((await formal()).statusCode).toBe(409);
  for(const value of Object.values(await created()))expect(value).toHaveLength(0);
  expect((await app.inject({method:'POST',url:url(),payload:body()})).statusCode).toBe(422);
});
it('concurrent same-key admission creates one Thread, reference and work event',async()=>{
  const hold=await db.pool.connect(),input=body(),key=randomUUID();let pending:ReturnType<typeof formal>|undefined;
  try{
    await hold.query('BEGIN');await hold.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
    pending=formal(input,key);await waitForLockWaiter(db.pool);
    const conflict=await formal(input,key);expect(conflict.statusCode,conflict.body).toBe(409);expect(conflict.json().error.code).toBe('idempotency_in_progress');
    await hold.query('COMMIT');expect((await pending).statusCode).toBe(201);
    for(const value of Object.values(await created()))expect(value).toHaveLength(1);
  }finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it.each(['object_relations','inquiry_thread_revisions','project_work_events','domain_change_outbox','operation_idempotency','policy_decision_records'])('rolls back the complete advancement if %s cannot be persisted',async table=>{
  await db.pool.query(`CREATE FUNCTION refuse_question_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'question storage refused'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_question_store BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_question_store()`);
  try{
    const response=await formal();expect(response.statusCode,response.body).toBe(table==='policy_decision_records'?503:500);
    for(const value of Object.values(await created()))expect(value).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);
  }finally{await db.pool.query(`DROP TRIGGER refuse_question_store ON ${table}`);await db.pool.query('DROP FUNCTION refuse_question_store()');}
});

it('does not distinguish a foreign-Space Note from an absent Note',async()=>{
  const elsewhere={space:randomUUID(),owner:randomUUID(),project:randomUUID(),spaceType:'team' as const};
  await seedSpaceOwnerProject(db.pool,elsewhere);
  const foreign=await new PgKnowledgeRepository(db.pool).createNote({spaceId:elsewhere.space,userId:elsewhere.owner},{title:'Foreign reasoning',primary_project_id:elsewhere.project,plain_text:'Private foreign contents'});
  const actual=await formal({...body(),note_object_id:foreign.id}),absent=await formal({...body(),note_object_id:randomUUID()});
  expect(actual.statusCode).toBe(404);expect(absent.statusCode).toBe(404);expect(actual.json().error.code).toBe(absent.json().error.code);
  const otherProject=await generic({...body(),project_id:elsewhere.project});expect(otherProject.statusCode).toBe(404);
  for(const value of Object.values(await created()))expect(value).toHaveLength(0);
});

it('migrates direct human Thread creation with a distinct receipt scope and existing state fields',async()=>{
  const key=randomUUID(),input={kind:'question',statement:'An ordinary human question?',answerability:'Empirical',resolution_criteria:'Matched comparison',producer_idempotency_key:'human-producer'};
  const url=`/api/v1/projects/${project}/inquiry/threads`;
  const first=await app.inject({method:'POST',url,payload:input,headers:{'idempotency-key':key}});expect(first.statusCode,first.body).toBe(201);
  expect(first.json().data).not.toHaveProperty('note_object_id');
  const next=await app.inject({method:'POST',url:'/api/v1/actions/inquiry.thread.create',payload:{...input,project_id:project},headers:{'idempotency-key':key}});
  expect(next.json()).toEqual(first.json());
  expect((await db.pool.query('SELECT answerability,resolution_criteria FROM inquiry_question_states WHERE thread_id=$1',[first.json().data.thread_id])).rows).toEqual([{answerability:'Empirical',resolution_criteria:'Matched comparison'}]);
  // Distinct named commands never replay one another's receipt.
  const raised=await formal(body(),key);expect(raised.statusCode,raised.body).toBe(201);expect(raised.json().data.thread_id).not.toBe(first.json().data.thread_id);
  expect((await created()).threads).toHaveLength(2);
  expect((await app.inject({method:'POST',url,payload:{statement:'Missing kind'},headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(422);
});
it.each(['operation_idempotency','project_work_events','policy_decision_records'])('rolls back direct human creation if %s fails',async table=>{
  await db.pool.query(`CREATE FUNCTION refuse_human_thread() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'human thread refused'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_human_thread BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_human_thread()`);
  try{
    const result=await app.inject({method:'POST',url:`/api/v1/projects/${project}/inquiry/threads`,payload:{kind:'question',statement:'Human question'},headers:{'idempotency-key':randomUUID()}});
    expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);
    for(const value of Object.values(await created()))expect(value).toHaveLength(0);
  }finally{await db.pool.query(`DROP TRIGGER refuse_human_thread ON ${table}`);await db.pool.query('DROP FUNCTION refuse_human_thread()');}
});
