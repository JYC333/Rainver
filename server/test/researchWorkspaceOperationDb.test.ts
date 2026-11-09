import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectResearchModule} from '../src/modules/projectResearch/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {createQuestionThreadScope} from './support/researchSeeds.js';
import {insertResearchWorkflowFixture} from './support/researchWorkflow.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,user:string,project:string,app:ReturnType<typeof buildModuleServer>;
const call=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
const create=(text='Checklist content',key=randomUUID())=>call('research.checklist.create',{project_id:project,text},key);
beforeEach(async()=>{await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();user=randomUUID();project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[projectResearchModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:user});});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
const questionFramework={reply:'PRIVATE assessment reply',recommended_question:'Which recovery methods work?',assessment:{answerable:true,finer:{feasible:4,interesting:4,novel:4,ethical:4,relevant:4},issues:[]},suggested_questions:['Which recovery methods work?'],sub_questions:['Which failure classes?'],scope:{in:['Managed agents'],out:['General intelligence']},clarifying_questions:[]};
async function assessmentThread(){const {thread_id}=await createQuestionThreadScope(db.pool,{spaceId:space,userId:user},project,'Which recovery methods work?');const {ProjectResearchQuestionAssessmentRepository}=await import('../src/modules/projectResearch/questionAssessmentRepository.js');await new ProjectResearchQuestionAssessmentRepository(db.pool).beginTurn({spaceId:space,userId:user},project,thread_id,'Assess this question');return thread_id;}
it('confirms a framework atomically with a body-free receipt and stable cross-transport replay after a later confirmation',async()=>{
 const thread=await assessmentThread(),key=randomUUID(),body={thread_id:thread,refinement:questionFramework,manually_adjusted:true};
 const first=await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/question/assessment/confirm`,payload:body,headers:{'idempotency-key':key}});expect(first.statusCode,first.body).toBe(201);expect(first.body).not.toContain('PRIVATE');
 expect((await call('research.question.assessment.confirm',{project_id:project,...body},key)).json()).toEqual(first.json());
 const saved=await app.inject({method:'GET',url:`/api/v1/projects/${project}/research/question/assessment?thread_id=${thread}`});expect(saved.statusCode,saved.body).toBe(200);expect(saved.json().latest_refinement.research_context_version_id).toBe(first.json().data.id);
 const next=await call('research.question.assessment.confirm',{project_id:project,...body,refinement:{...questionFramework,recommended_question:'Which constrained recovery methods work?'}});expect(next.statusCode,next.body).toBe(201);expect(next.json().data.id).not.toBe(first.json().data.id);
 expect((await call('research.question.assessment.confirm',{project_id:project,...body},key)).json()).toEqual(first.json());expect((await db.pool.query('SELECT id FROM project_research_context_versions WHERE space_id=$1',[space])).rows).toHaveLength(2);
 expect((await call('research.question.assessment.confirm',{project_id:project,...body,manually_adjusted:false},key)).statusCode).toBe(422);
});
it('revalidates full Thread visibility for confirmation replay and current assessment/history reads, with mandatory cross-owner audit',async()=>{
 const thread=await assessmentThread(),peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});
 const key=randomUUID(),body={project_id:project,thread_id:thread,refinement:questionFramework};expect((await call('research.question.assessment.confirm',body,key)).statusCode).toBe(201);
 const url=`/api/v1/projects/${project}/research/question/assessment`,query=`?thread_id=${thread}`;
 expect((await app.inject({method:'GET',url:url+query})).statusCode).toBe(200);expect((await db.pool.query('SELECT id FROM content_access_logs WHERE resource_id=$1 AND viewer_user_id=$2',[thread,peer])).rows.length).toBeGreaterThan(0);
 await db.pool.query("CREATE FUNCTION refuse_assessment_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE audit fault'; END $$");await db.pool.query('CREATE TRIGGER refuse_assessment_read BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION refuse_assessment_read()');
 try{for(const path of [url+query,url+'/confirmations'+query]){const denied=await app.inject({method:'GET',url:path});expect(denied.statusCode,denied.body).toBe(503);expect(denied.body).not.toContain('PRIVATE');}}
 finally{await db.pool.query('DROP TRIGGER refuse_assessment_read ON content_access_logs');await db.pool.query('DROP FUNCTION refuse_assessment_read()');}
 await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=$1",[thread]);
 for(const result of [await call('research.question.assessment.confirm',body,key),await app.inject({method:'GET',url:url+query}),await app.inject({method:'GET',url:url+'/confirmations'+query})]){expect(result.statusCode,result.body).toBe(404);expect(result.body).not.toContain('PRIVATE');}
});
it.each(['project_research_context_versions','policy_decision_records'])('rolls confirmation, session and request back when %s cannot persist',async table=>{
 const thread=await assessmentThread();await db.pool.query("CREATE FUNCTION refuse_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE confirmation fault'; END $$");await db.pool.query(`CREATE TRIGGER refuse_confirmation BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_confirmation()`);
 try{const result=await call('research.question.assessment.confirm',{project_id:project,thread_id:thread,refinement:questionFramework});expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(result.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM project_research_context_versions WHERE space_id=$1',[space])).rows).toEqual([]);expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);expect((await db.pool.query('SELECT research_context_version_id FROM project_research_question_assessment_sessions WHERE thread_id=$1',[thread])).rows).toEqual([{research_context_version_id:null}]);}
 finally{await db.pool.query(`DROP TRIGGER refuse_confirmation ON ${table}`);await db.pool.query('DROP FUNCTION refuse_confirmation()');}
});
it('saves one intake draft across formal and generic entries and replays its receipt without overwriting later edits',async()=>{
 const {thread_id}=await createQuestionThreadScope(db.pool,{spaceId:space,userId:user},project,'PRIVATE question');
 const body={thread_id,research_question:'PRIVATE question',report_depth:'quick',question_refine_skipped:true},key=randomUUID();
 const saved=await app.inject({method:'PUT',url:`/api/v1/projects/${project}/research/initial-intake`,payload:body,headers:{'idempotency-key':key}});
 expect(saved.statusCode,saved.body).toBe(200);expect(saved.body).not.toContain('PRIVATE');
 expect((await call('research.intake.draft',{project_id:project,...body},key)).json()).toEqual(saved.json());
 const workflow=saved.json().data.id;
 const edited=await call('research.intake.draft',{project_id:project,...body,workflow_id:workflow,research_question:'New question'});expect(edited.statusCode,edited.body).toBe(200);
 expect((await call('research.intake.draft',{project_id:project,...body},key)).json()).toEqual(saved.json());
 expect((await db.pool.query("SELECT state_json->>'research_question' AS question FROM project_research_workflows WHERE object_id=$1",[workflow])).rows).toEqual([{question:'New question'}]);
 expect((await call('research.intake.draft',{project_id:project,...body,research_question:'Changed input'},key)).statusCode).toBe(422);
 expect((await db.pool.query('SELECT object_id FROM project_research_workflows WHERE space_id=$1',[space])).rows).toHaveLength(1);
});
it('rechecks Thread reach on draft replay even while the caller remains a Project writer',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const {thread_id}=await createQuestionThreadScope(db.pool,{spaceId:space,userId:user},project,'PRIVATE question');
 const body={project_id:project,thread_id,research_question:'PRIVATE question',report_depth:'quick',question_refine_skipped:true},key=randomUUID();
 expect((await call('research.intake.draft',body,key)).statusCode).toBe(200);
 await db.pool.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[thread_id,peer]);
 const denied=await call('research.intake.draft',body,key);expect(denied.statusCode,denied.body).toBe(404);expect(denied.body).not.toContain('PRIVATE');
});
it('records stages atomically with stable receipts, validates Run references and retains later stage state on replay',async()=>{
 const workflow=randomUUID();await insertResearchWorkflowFixture(db.pool,{id:workflow,spaceId:space,projectId:project,startedByUserId:user});
 const body={project_id:project,workflow_id:workflow,stage_key:'screening'},key=randomUUID();
 const first=await call('research.workflow.stage.record',body,key);expect(first.statusCode,first.body).toBe(200);
 const formal=await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/workflow/${workflow}/stages/screening/run`,payload:{},headers:{'idempotency-key':key}});expect(formal.json()).toEqual(first.json());
 expect((await call('research.workflow.stage.record',{...body,stage_key:'synthesis'})).statusCode).toBe(200);
 expect((await call('research.workflow.stage.record',body,key)).json()).toEqual(first.json());
 expect((await db.pool.query('SELECT current_stage FROM project_research_workflows WHERE object_id=$1',[workflow])).rows).toEqual([{current_stage:'synthesis'}]);
 expect((await call('research.workflow.stage.record',{...body,run_id:randomUUID()})).statusCode).toBe(404);
 await db.pool.query("UPDATE project_research_workflows SET status='paused' WHERE object_id=$1",[workflow]);
 const invalid=await call('research.workflow.stage.record',body);expect(invalid.statusCode,invalid.body).toBe(422);expect(invalid.json().error.code).toBe('operation_invalid_input');
});
it('replays across formal/generic with normalized text, no cached content, current GET and changed-input rejection',async()=>{
 const key=randomUUID(),r=await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/checklist`,payload:{text:'  Checklist content  '},headers:{'idempotency-key':key}});
 expect(r.statusCode,r.body).toBe(201);expect(r.body).not.toContain('Checklist content');expect((await create('Checklist content',key)).json()).toEqual(r.json());expect((await create('Changed',key)).statusCode).toBe(422);
 const item=r.json().data.id,read=await app.inject({method:'GET',url:`/api/v1/projects/${project}/research/checklist/${item}`});expect(read.statusCode,read.body).toBe(200);expect(read.json().text).toBe('Checklist content');
 const result=await call('research.checklist.update',{project_id:project,item_id:item,status:'done',text:'Current'});expect(result.statusCode,result.body).toBe(200);
 expect((await create('Checklist content',key)).json()).toEqual(r.json());expect((await db.pool.query('SELECT text FROM research_checklist_items WHERE id=$1',[item])).rows[0].text).toBe('Current');
});
it('serializes same-key creation and distinct-key checklist ordering through the Project aggregate',async()=>{
 const key=randomUUID(),holder=await db.pool.connect();let first;try{await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);const pending=create('One',key);await waitForLockWaiter(db.pool);const busy=await create('One',key);expect(busy.statusCode,busy.body).toBe(409);expect(busy.json().error.code).toBe('idempotency_in_progress');await holder.query('COMMIT');first=await pending;expect(first.statusCode,first.body).toBe(201);}finally{await holder.query('ROLLBACK');holder.release();}expect((await create('One',key)).json()).toEqual(first!.json());
 const other=await Promise.all([create('Two'),create('Three')]);expect(other.map(r=>r.statusCode)).toEqual([201,201]);expect((await db.pool.query('SELECT sort_order FROM research_checklist_items ORDER BY sort_order')).rows).toEqual([{sort_order:0},{sort_order:1},{sort_order:2}]);
});
it('deletion replay does not repeat the writer or affect a new item and uses current Project authority',async()=>{
 const item=(await create()).json().data.id,key=randomUUID(),payload={project_id:project,item_id:item};const r=await call('research.checklist.delete',payload,key);expect(r.statusCode,r.body).toBe(200);const next=(await create('Next')).json().data.id;
 const replay=await app.inject({method:'DELETE',url:`/api/v1/projects/${project}/research/checklist/${item}`,headers:{'idempotency-key':key}});expect(replay.json()).toEqual(r.json());expect((await db.pool.query('SELECT id FROM research_checklist_items')).rows).toEqual([{id:next}]);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});__setAuthIdentityForTests({spaceId:space,userId:peer});expect((await call('research.checklist.delete',payload,key)).statusCode).toBe(404);
});
it.each(['research_checklist_items','operation_idempotency','policy_decision_records'])('atomically rolls domain/request/audit back on %s failure',async table=>{
 await db.pool.query("CREATE FUNCTION refuse_workspace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE store failure'; END $$");await db.pool.query(`CREATE TRIGGER refuse_workspace BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_workspace()`);
 try{const r=await create('PRIVATE content');expect(r.statusCode,r.body).toBe(table==='policy_decision_records'?503:500);expect(r.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM research_checklist_items')).rows).toEqual([]);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toEqual([]);if(table!=='policy_decision_records'){const audits=await db.pool.query("SELECT metadata_json->>'operation_outcome' AS outcome FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[r.json().error.request_id]);expect(audits.rows).toEqual([{outcome:'failed'}]);}}
 finally{await db.pool.query(`DROP TRIGGER refuse_workspace ON ${table}`);await db.pool.query('DROP FUNCTION refuse_workspace()');}
});
it('preserves screening rule snapshots and caches only specifically classified validation failures',async()=>{
 const body={project_id:project,include_keywords:['bounded'],date_range_start:'2026-02-01',date_range_end:'2026-01-01'},key=randomUUID();const r=await call('research.screening.configure',body,key);expect(r.statusCode,r.body).toBe(422);expect((await call('research.screening.configure',body,key)).json().error.code).toBe('operation_invalid_input');expect((await db.pool.query('SELECT id FROM project_research_screening_criteria')).rows).toEqual([]);
 const ok=await call('research.screening.configure',{project_id:project,include_keywords:['bounded']});expect(ok.statusCode,ok.body).toBe(200);expect(ok.body).not.toContain('bounded');expect((await db.pool.query('SELECT include_keywords_json FROM project_research_screening_criteria')).rows).toEqual([{include_keywords_json:['bounded']}]);
});
it('rechecks writer revocation after waiting for the Project lock without partial state',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});
 const holder=await db.pool.connect();try{await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);const pending=create('must not write');await waitForLockWaiter(db.pool);await holder.query("UPDATE project_members SET role='viewer' WHERE space_id=$1 AND project_id=$2 AND user_id=$3",[space,project,peer]);await holder.query('COMMIT');const r=await pending;expect(r.statusCode,r.body).toBe(404);expect((await db.pool.query('SELECT id FROM research_checklist_items')).rows).toEqual([]);}finally{await holder.query('ROLLBACK');holder.release();}
});

it('preserves Claim link history, same-key replay, distinct-key uniqueness and current private-source authority',async()=>{
 const claim=randomUUID(),now=new Date().toISOString();await db.pool.query("INSERT INTO space_objects(id,space_id,object_type,title,visibility,owner_user_id,created_by_user_id,primary_project_id,created_at,updated_at) VALUES($1,$2,'claim','PRIVATE Claim','space_shared',$3,$3,$4,$5,$5)",[claim,space,user,project,now]);
 await db.pool.query("INSERT INTO claims(object_id,space_id,subject_text,claim_kind,claim_text,normalized_claim_hash,confidence_method,resolution_state,metadata_json) VALUES($1,$2,'Subject','fact','PRIVATE Claim',$3,'human_confirmed','unreviewed','{}'::jsonb)",[claim,space,randomUUID()]);
 const key=randomUUID(),payload={project_id:project,claim_id:claim};const result=await call('research.claim.link',payload,key);expect(result.statusCode,result.body).toBe(201);expect((await call('research.claim.link',payload,key)).json()).toEqual(result.json());expect(result.body).not.toContain('PRIVATE');
 const id=result.json().data.id;expect((await call('research.claim.link',payload)).statusCode).toBe(409);
 const update=await call('research.claim.update',{project_id:project,claim_link_id:id,support_status:'gap_declared',unresolved_gap:true,gap_reason:'Need evidence'});expect(update.statusCode,update.body).toBe(200);expect((await db.pool.query('SELECT support_status,unresolved_gap FROM project_research_claim_links WHERE id=$1',[id])).rows).toEqual([{support_status:'gap_declared',unresolved_gap:true}]);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[claim,peer]);const replay=await call('research.claim.link',payload,key);expect(replay.statusCode,replay.body).toBe(404);expect(replay.body).not.toContain('PRIVATE');
});
it('refuses foreign Space targets and Agent principals without granting a manual authority path',async()=>{
 const otherSpace=randomUUID(),otherProject=randomUUID();await seedSpaceOwnerProject(db.pool,{space:otherSpace,owner:randomUUID(),project:otherProject,spaceType:'team'});expect((await call('research.checklist.create',{project_id:otherProject,text:'Foreign'})).statusCode).toBe(404);
 const {OperationExecutor}=await import('../src/modules/systemActions/operations/executor.js'),{loadSystemActionRegistry}=await import('../src/modules/systemActions/registry.js'),{researchWorkspaceRegistrations}=await import('../src/modules/projectResearch/workspaceOperations.js'),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
 const defs=await loadSystemActionRegistry(config),executor=new OperationExecutor(db.pool,config,researchWorkspaceRegistrations(defs,config));const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');const result=await executor.execute('research.checklist.create',{project_id:project,text:'Forged manual'},{...sessionActor({spaceId:space,userId:user}),principal:{kind:'agent',id:randomUUID()},agent_id:randomUUID(),run_id:randomUUID(),surface:'agent_tool'},randomUUID(),randomUUID());
 expect(result.http_status).toBe(404);expect((await db.pool.query('SELECT id FROM research_checklist_items')).rows).toEqual([]);
});
it('initializes through NoteWriter atomically and retains the existing initialized-area reader behavior',async()=>{
 const key=randomUUID(),r=await call('research.area.initialize',{project_id:project},key);expect(r.statusCode,r.body).toBe(201);expect(r.body).not.toContain('content_json');expect((await call('research.area.initialize',{project_id:project},key)).json()).toEqual(r.json());
 const notes=(await db.pool.query('SELECT n.object_id,n.version FROM notes n JOIN space_objects so ON so.id=n.object_id WHERE so.primary_project_id=$1',[project])).rows;expect(notes.length).toBeGreaterThan(0);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});
 const reader=await call('research.area.initialize',{project_id:project});expect(reader.statusCode,reader.body).toBe(201);expect(reader.json().data.id).toBe(r.json().data.id);expect((await db.pool.query('SELECT n.object_id,n.version FROM notes n JOIN space_objects so ON so.id=n.object_id WHERE so.primary_project_id=$1',[project])).rows).toEqual(notes);
});
async function seedCardMaterial(){const item=randomUUID(),corpus=randomUUID(),now=new Date().toISOString();
 await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared','feed_entry','PRIVATE material',$4,$4,'excerpt_saved','summary_only',$4,$4)",[item,space,user,now]);
 await db.pool.query("INSERT INTO project_corpus_items(id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at) VALUES($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)",[corpus,space,project,item,now]);
 await db.pool.query('INSERT INTO project_corpus_item_sources(id,corpus_item_id,space_id,project_id,source_item_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),corpus,space,project,item,now]);return item;}
it('keeps evidence card content out of receipts and checks the Source again on replay and current GET',async()=>{
 const item=await seedCardMaterial(),key=randomUUID(),body={project_id:project,source_item_id:item,why_md:'PRIVATE why'};
 const r=await call('research.evidence_card.update',body,key);expect(r.statusCode,r.body).toBe(200);expect(r.body).not.toContain('PRIVATE');expect((await call('research.evidence_card.update',{...body,how_md:'',what_md:''},key)).json()).toEqual(r.json());
 const url=`/api/v1/projects/${project}/research/reading-list/${item}/card`;expect((await app.inject({method:'GET',url})).json().why_md).toBe('PRIVATE why');
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE source_items SET visibility='private',owner_user_id=$2 WHERE id=$1",[item,peer]);const replay=await call('research.evidence_card.update',body,key);expect(replay.statusCode,replay.body).toBe(404);expect((await app.inject({method:'GET',url})).statusCode).toBe(404);expect(replay.body).not.toContain('PRIVATE');
});
it('returns no evidence card content when mandatory cross-owner read auditing fails',async()=>{
 const item=await seedCardMaterial();expect((await call('research.evidence_card.update',{project_id:project,source_item_id:item,why_md:'PRIVATE why'})).statusCode).toBe(200);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query('UPDATE source_items SET owner_user_id=$2 WHERE id=$1',[item,peer]);
 await db.pool.query("CREATE FUNCTION refuse_card_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE audit failed'; END $$");await db.pool.query('CREATE TRIGGER refuse_card_read BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION refuse_card_read()');
 try{const r=await app.inject({method:'GET',url:`/api/v1/projects/${project}/research/reading-list/${item}/card`});expect(r.statusCode,r.body).toBe(503);expect(r.body).not.toContain('PRIVATE');}
 finally{await db.pool.query('DROP TRIGGER refuse_card_read ON content_access_logs');await db.pool.query('DROP FUNCTION refuse_card_read()');}
});

it('rejects a Source scope that grows while waiting before acquiring any late Project lock',async()=>{
 const item=await seedCardMaterial(),otherProject=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other','active',now(),now())",[otherProject,space,user]);
 const holder=await db.pool.connect();try{await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);const pending=call('research.evidence_card.update',{project_id:project,source_item_id:item,why_md:'must not write'});await waitForLockWaiter(db.pool);await holder.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[item,otherProject]);await holder.query('COMMIT');const r=await pending;expect(r.statusCode,r.body).toBe(409);expect(r.json().error.code).toBe('operation_conflict');expect((await db.pool.query('SELECT id FROM research_evidence_cards')).rows).toEqual([]);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toEqual([]);}finally{await holder.query('ROLLBACK');holder.release();}
});
it('rolls the real writer and request back for an unknown helper Http422 without caching or reflecting its message',async()=>{
 const {OperationExecutor}=await import('../src/modules/systemActions/operations/executor.js'),{loadSystemActionRegistry}=await import('../src/modules/systemActions/registry.js'),{researchWorkspaceRegistrations}=await import('../src/modules/projectResearch/workspaceOperations.js'),{sessionActor}=await import('../src/modules/systemActions/operations/actor.js'),{HttpError}=await import('../src/modules/routeUtils/common.js');
 const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),definitions=await loadSystemActionRegistry(config),registrations=researchWorkspaceRegistrations(definitions,config),registration=registrations.find(r=>r.definition.id==='research.checklist.create')!,write=registration.execute;
 registration.execute=async(db,input,actor)=>{await write(db,input,actor);throw new HttpError(422,'PRIVATE unexpected helper failure');};
 const requestId=randomUUID(),result=await new OperationExecutor(db.pool,config,registrations).execute('research.checklist.create',{project_id:project,text:'must roll back'},sessionActor({spaceId:space,userId:user}),requestId,randomUUID());
 expect(result.http_status).toBe(500);expect(JSON.stringify(result.body)).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM research_checklist_items')).rows).toEqual([]);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toEqual([]);expect((await db.pool.query("SELECT metadata_json->>'operation_outcome' AS outcome FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[requestId])).rows).toEqual([{outcome:'failed'}]);
});
it('rolls the entire initialized notebook and receipt back when mandatory NoteWriter outbox storage fails',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_notebook_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE outbox failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_notebook_outbox BEFORE INSERT ON domain_change_outbox FOR EACH ROW EXECUTE FUNCTION refuse_notebook_outbox()');
 try{const r=await call('research.area.initialize',{project_id:project});expect(r.statusCode,r.body).toBe(500);expect(r.body).not.toContain('PRIVATE');for(const table of ['notes','note_collections','note_revisions','operation_idempotency'])expect((await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`,[space])).rows).toEqual([]);expect((await db.pool.query("SELECT metadata_json->>'operation_outcome' AS outcome FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[r.json().error.request_id])).rows).toEqual([{outcome:'failed'}]);}
 finally{await db.pool.query('DROP TRIGGER refuse_notebook_outbox ON domain_change_outbox');await db.pool.query('DROP FUNCTION refuse_notebook_outbox()');}
});

it('returns the canonical archived conflict on new intent and old-key replay while retaining initialized reader inspection',async()=>{
 const area=await call('research.area.initialize',{project_id:project});expect(area.statusCode,area.body).toBe(201);const key=randomUUID(),created=await create('Before archive',key);expect(created.statusCode,created.body).toBe(201);await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
 for(const result of [await create('After archive'),await create('Before archive',key)]){expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('operation_conflict');}
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});expect((await call('research.area.initialize',{project_id:project})).statusCode).toBe(201);
});
it('creates a real initial-limit Workflow once, replays across transports, updates explicitly and preserves the old receipt',async()=>{
 const key=randomUUID(),r=await app.inject({method:'PUT',url:`/api/v1/projects/${project}/research/item-limit`,payload:{max_items:25},headers:{'idempotency-key':key}});expect(r.statusCode,r.body).toBe(200);
 const id=r.json().data.id;expect((await call('research.intake.limit',{project_id:project,max_items:25,workflow_id:null},key)).json()).toEqual(r.json());expect((await call('research.intake.limit',{project_id:project,max_items:26},key)).statusCode).toBe(422);
 expect((await call('research.intake.limit',{project_id:project,workflow_id:id,max_items:30})).statusCode).toBe(200);
 expect((await db.pool.query("SELECT state_json->'initial_intake'->>'max_items' AS items FROM project_research_workflows WHERE object_id=$1",[id])).rows).toEqual([{items:'30'}]);expect((await call('research.intake.limit',{project_id:project,max_items:25},key)).json()).toEqual(r.json());expect((await db.pool.query('SELECT object_id FROM project_research_workflows WHERE space_id=$1',[space])).rows).toHaveLength(1);
});
async function seedStandingBatch(){const id=randomUUID();await db.pool.query("INSERT INTO project_research_standing_batches(id,space_id,project_id,status,source_item_ids_json,window_started_at,ready_at,created_at,updated_at) VALUES($1,$2,$3,'failed','[]'::jsonb,now(),now(),now(),now())",[id,space,project]);return id;}
it('standing retry writes one durable dispatch intent and replays without a second Job',async()=>{
 const id=await seedStandingBatch(),key=randomUUID(),payload={project_id:project,batch_id:id};const r=await call('research.standing.retry',payload,key);expect(r.statusCode,r.body).toBe(200);const replay=await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/standing/batches/${id}/retry`,payload:{},headers:{'idempotency-key':key}});expect(replay.json()).toEqual(r.json());expect((await db.pool.query("SELECT status FROM project_research_standing_batches WHERE id=$1",[id])).rows).toEqual([{status:'pending'}]);expect((await db.pool.query("SELECT id FROM jobs WHERE payload_json->>'batch_id'=$1",[id])).rows).toHaveLength(1);
});
it('standing retry rolls status/request back if its required dispatch Job cannot be stored',async()=>{
 const id=await seedStandingBatch();await db.pool.query("CREATE FUNCTION refuse_standing_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE dispatch failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_standing_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_standing_job()');
 try{const r=await call('research.standing.retry',{project_id:project,batch_id:id});expect(r.statusCode,r.body).toBe(500);expect(r.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT status FROM project_research_standing_batches WHERE id=$1',[id])).rows).toEqual([{status:'failed'}]);expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);expect((await db.pool.query("SELECT metadata_json->>'operation_outcome' AS outcome FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[r.json().error.request_id])).rows).toEqual([{outcome:'failed'}]);}finally{await db.pool.query('DROP TRIGGER refuse_standing_job ON jobs');await db.pool.query('DROP FUNCTION refuse_standing_job()');}
});
it('dismisses advice without requiring its no-longer-readable Source and safely replays the body-free receipt',async()=>{
 const {seedRun}=await import('./support/domainSeeds.js');const run=randomUUID();await seedRun(db.pool,{id:run,space,owner:user,agent:randomUUID(),version:randomUUID()});
 const item=await seedCardMaterial(),batch=await seedStandingBatch(),advice=randomUUID(),peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE source_items SET visibility='private',owner_user_id=$2 WHERE id=$1",[item,peer]);
 await db.pool.query("INSERT INTO project_research_standing_advice(id,space_id,project_id,source_item_id,batch_id,detail,status,action_id,action_input_json,idempotency_key,created_by_run_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'PRIVATE detail','open','source.raise_as_question','{}'::jsonb,$6,$7,now(),now())",[advice,space,project,item,batch,randomUUID(),run]);
 const key=randomUUID(),body={project_id:project,advice_id:advice},r=await call('research.standing.dismiss',body,key);expect(r.statusCode,r.body).toBe(200);expect(r.body).not.toContain('PRIVATE');const replay=await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/standing/advice/${advice}/dismiss`,payload:{},headers:{'idempotency-key':key}});expect(replay.json()).toEqual(r.json());expect((await db.pool.query('SELECT status FROM project_research_standing_advice WHERE id=$1',[advice])).rows).toEqual([{status:'dismissed'}]);
 __setAuthIdentityForTests({spaceId:space,userId:peer});expect((await call('research.standing.dismiss',body,key)).statusCode).toBe(404);
});
