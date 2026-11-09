import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedAgentWithVersion,seedSpaceMember} from './support/domainSeeds.js';
import {seedRelevantCorpusItem} from './support/researchSeeds.js';
import {insertResearchWorkflowFixture} from './support/researchWorkflow.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectResearchModule} from '../src/modules/projectResearch/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {loadConfig,type ServerConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {syncBuiltinPrompts} from '../src/modules/prompts/builtins.js';
import {waitForLockWaiter} from './support/lockWait.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,user:string,project:string,workflow:string,thread:string,config:ServerConfig,app:ReturnType<typeof buildModuleServer>;
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();user=randomUUID();project=randomUUID();workflow=randomUUID();const agent=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});
 await seedAgentWithVersion(db.pool,{agent,version:randomUUID(),space,owner:user,systemPrompt:'Test research Agent'});
 const question=await new InquiryThreadService(db.pool).createThread({spaceId:space,userId:user},project,{kind:'question',statement:'PRIVATE research question'});thread=String(question.id);
 await insertResearchWorkflowFixture(db.pool,{id:workflow,spaceId:space,projectId:project,startedByUserId:user,primaryThreadId:thread,currentStage:'synthesis',state:{research_question:'PRIVATE research question',research_question_version:1,report_depth:'quick',thread_scope:[{thread_id:thread,version:question.version,kind:'question',statement:'PRIVATE research question'}],agent_id:agent,question_refine_skipped:true}});
 await seedRelevantCorpusItem(db.pool,{space,project,owner:user});await syncBuiltinPrompts(db.pool,join(process.cwd(),'..','catalog'));
 config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,SERVER_DEBUG:'false'});app=buildModuleServer(config,[projectResearchModule,projectsModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:user});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
const call=(key=randomUUID(),input:object={project_id:project})=>app.inject({method:'POST',url:'/api/v1/actions/research.report.snapshot',payload:input,headers:{'idempotency-key':key}});
it('commits one report execution and its required Agent Job across transports, keeps copied context private, and replays stable IDs',async()=>{
 const key=randomUUID(),first=await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/reports`,payload:{},headers:{'idempotency-key':key}});expect(first.statusCode,first.body).toBe(202);expect(first.body).not.toContain('PRIVATE');const receipt=first.json().data;
 expect((await call(key)).json()).toEqual(first.json());expect((await db.pool.query('SELECT id FROM project_operations WHERE id=$1',[receipt.id])).rows).toHaveLength(1);
 const executions=await db.pool.query("SELECT id,contract_snapshot_json->>'run_visibility' AS visibility FROM workflow_executions WHERE research_operation_id=$1",[receipt.id]);expect(executions.rows).toHaveLength(1);expect(executions.rows[0].visibility).toBe('private');expect((await db.pool.query('SELECT visibility FROM runs WHERE space_id=$1',[space])).rows).toEqual([{visibility:'private'},{visibility:'private'}]);expect((await db.pool.query("SELECT id FROM jobs WHERE space_id=$1 AND job_type='agent_run'",[space])).rows).toHaveLength(1);
 const next=await call();expect(next.statusCode,next.body).toBe(409);expect((await db.pool.query('SELECT id FROM workflow_executions WHERE space_id=$1',[space])).rows).toHaveLength(1);
});
it.each(['jobs','policy_decision_records'])('rolls the entire snapshot graph, artifact, Run, required Job and receipt back on %s failure',async table=>{
 await db.pool.query("CREATE FUNCTION refuse_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE storage failure'; END $$");await db.pool.query(`CREATE TRIGGER refuse_snapshot BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_snapshot()`);
 try{const result=await call();expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(result.body).not.toContain('PRIVATE');for(const table of ['project_operations','workflow_executions','runs','artifacts','operation_idempotency'])expect((await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`,[space])).rows).toEqual([]);}
 finally{await db.pool.query(`DROP TRIGGER refuse_snapshot ON ${table}`);await db.pool.query('DROP FUNCTION refuse_snapshot()');}
});
it('rechecks a private Thread after waiting for the Project lock and denies old receipt replay after withdrawal',async()=>{
 const key=randomUUID(),first=await call(key);expect(first.statusCode,first.body).toBe(202);const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});const holder=await db.pool.connect();
 try{await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);const pending=call();await waitForLockWaiter(db.pool);await holder.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[thread,peer]);await holder.query('COMMIT');const denied=await pending;expect(denied.statusCode,denied.body).toBe(404);expect(denied.body).not.toContain('PRIVATE');}finally{await holder.query('ROLLBACK');holder.release();}
 expect((await db.pool.query('SELECT id FROM workflow_executions WHERE space_id=$1',[space])).rows).toHaveLength(1);
 expect((await call(key)).statusCode).toBe(404);
});
it('fails closed and leaves no snapshot when mandatory cross-owner Thread read auditing cannot persist',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query('UPDATE space_objects SET owner_user_id=$2 WHERE id=$1',[thread,peer]);
 await db.pool.query("CREATE FUNCTION refuse_snapshot_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE content-read failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_snapshot_read BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION refuse_snapshot_read()');
 try{const result=await call();expect(result.statusCode,result.body).toBe(503);expect(result.body).not.toContain('PRIVATE');for(const table of ['project_operations','workflow_executions','runs','artifacts','operation_idempotency'])expect((await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`,[space])).rows).toEqual([]);}
 finally{await db.pool.query('DROP TRIGGER refuse_snapshot_read ON content_access_logs');await db.pool.query('DROP FUNCTION refuse_snapshot_read()');}
});
it('rejects Corpus scope growth after the Project wait before creating any graph or taking newly discovered child locks',async()=>{
 const holder=await db.pool.connect();try{await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);const pending=call();await waitForLockWaiter(db.pool);await seedRelevantCorpusItem(holder as unknown as typeof db.pool,{space,project,owner:user});await holder.query('COMMIT');const result=await pending;expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('operation_conflict');expect((await db.pool.query('SELECT id FROM workflow_executions WHERE space_id=$1',[space])).rows).toEqual([]);}finally{await holder.query('ROLLBACK');holder.release();}
});
it('keeps a private Workflow question out of another Project reader’s snapshot GET and operation list',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=ANY($1::varchar[])",[[thread,workflow]]);
 const queued=await call();expect(queued.statusCode,queued.body).toBe(202);const id=queued.json().data.id,url=`/api/v1/projects/${project}/operations/${id}`;const ownerRead=await app.inject({method:'GET',url});expect(ownerRead.statusCode,ownerRead.body).toBe(200);expect(ownerRead.body).toContain('PRIVATE research question');
 __setAuthIdentityForTests({spaceId:space,userId:peer});const hidden=await app.inject({method:'GET',url});expect(hidden.statusCode,hidden.body).toBe(404);expect(hidden.body).not.toContain('PRIVATE');const list=await app.inject({method:'GET',url:`/api/v1/projects/${project}/operations`});expect(list.statusCode,list.body).toBe(200);expect(list.json()).toEqual([]);
});
