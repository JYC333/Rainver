import {JobWorker} from '../src/modules/jobs/worker.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {registerActivitySummaryJob,ACTIVITY_SUMMARY_JOB} from '../src/modules/activity/summaryOperation.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedRun,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {resetTables} from './support/resetTables.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {captureModule} from '../src/modules/capture/index.js';
import {activityModule} from '../src/modules/activity/index.js';
import {dailyReportsModule} from '../src/modules/dailyReports/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {PgActivityRepository} from '../src/modules/activity/repository.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
const db=useTestDatabase(import.meta.filename),space=randomUUID(),user=randomUUID(),project=randomUUID();
let app:ReturnType<typeof buildModuleServer>,activity:string;
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-activity-operation-test'});
const settings='/api/v1/daily-capture-report/settings';
const send=(method:'PATCH'|'PUT',url:string,payload:Record<string,unknown>={},key=randomUUID())=>app.inject({method,url,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 await seedSpaceOwnerProject(db.pool,{space,owner:user,project});
 activity=String((await new PgActivityRepository(db.pool).create({spaceId:space,userId:user},{source_type:'user_capture',content:'Private thought'})).id);
 app=buildModuleServer(config(),[activityModule,captureModule,dailyReportsModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:user});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
for(const action of ['review','archive'] as const)it(`commits ${action} once and refuses replay after current membership withdrawal`,async()=>{
 const url=`/api/v1/activity/${activity}/${action}`,key=randomUUID();
 const first=await send('PATCH',url,{},key);expect(first.statusCode,first.body).toBe(200);expect(first.json().data.status).toBe(action==='review'?'processed':'archived');
 expect((await send('PATCH',url,{},key)).json()).toEqual(first.json());
 expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(1);
 await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2",[space,user]);
 expect((await send('PATCH',url,{},key)).statusCode).toBe(404);
});
for(const method of ['PATCH','PUT'] as const)it(`preserves legal ${method} settings and current person replay`,async()=>{
 const input={enabled:true,timezone:'Europe/London',local_time:'08:30',include_source_types:['user_capture'],create_memory_proposals:false,max_experience_proposals_per_day:4},key=randomUUID();
 const first=await send(method,settings,input,key);expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject(input);
 expect((await send(method,settings,input,key)).json()).toEqual(first.json());
 await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[user]);
 expect((await send(method,settings,input,key)).statusCode).toBe(404);
});
it('rolls status, settings and successful receipts back when mandatory audit cannot commit',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_activity_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_activity_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_activity_audit()');
 try{
  expect((await send('PATCH',`/api/v1/activity/${activity}/archive`)).statusCode).toBe(503);
  expect((await send('PATCH',settings,{enabled:true})).statusCode).toBe(503);
  expect((await db.pool.query('SELECT status FROM activity_records WHERE id=$1',[activity])).rows[0]?.status).toBe('raw');
  expect((await db.pool.query('SELECT id FROM settings')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_activity_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_activity_audit()');}
});
it('serializes same-key requests and retains independent concurrent setting patches',async()=>{
 const key=randomUUID(),url=`/api/v1/activity/${activity}/review`;
 const results=await Promise.all([send('PATCH',url,{},key),send('PATCH',url,{},key)]);
 expect(results.some(result=>result.statusCode===200)).toBe(true);
 for(const result of results){expect([200,409]).toContain(result.statusCode);if(result.statusCode===409)expect(result.json().error.code).toBe('idempotency_in_progress');}
 const completed=results.find(result=>result.statusCode===200)!;
 expect((await send('PATCH',url,{},key)).json()).toEqual(completed.json());
 expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(1);
 const changed=await Promise.all([send('PATCH',settings,{enabled:true}),send('PATCH',settings,{local_time:'07:45'})]);
 for(const result of changed)expect(result.statusCode,result.body).toBe(200);
 const current=await app.inject({method:'GET',url:settings});expect(current.json()).toMatchObject({enabled:true,local_time:'07:45'});
});
it('requires keys and rejects undeclared authority and invalid settings without mutation',async()=>{
 expect((await app.inject({method:'PATCH',url:`/api/v1/activity/${activity}/review`,payload:{}})).statusCode).toBe(422);
 for(const input of [{user_id:user},{local_time:'99:99'},{timezone:'Mars/Base'},{include_source_types:['source']}])expect((await send('PATCH',settings,input)).statusCode).toBe(422);
 expect((await db.pool.query('SELECT status FROM activity_records WHERE id=$1',[activity])).rows[0]?.status).toBe('raw');
});
it('consolidates into one canonical reviewable proposal, replays it and refuses withdrawn ownership',async()=>{
 const url=`/api/v1/activity/${activity}/consolidate`,key=randomUUID();
 const first=await app.inject({method:'POST',url,payload:{},headers:{'idempotency-key':key}});
 expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toHaveLength(1);
 const second=await app.inject({method:'POST',url,payload:{},headers:{'idempotency-key':key}});expect(second.statusCode,second.body).toBe(200);expect(second.json()).toEqual(first.json());
 expect((await db.pool.query('SELECT proposal_type,status,payload_json FROM proposals')).rows).toMatchObject([{proposal_type:'memory_create',status:'pending',payload_json:{source_activity_id:activity,proposed_content:'Private thought'}}]);
 expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
 await db.pool.query("UPDATE activity_records SET visibility='space_shared',owner_user_id=NULL,user_id=NULL WHERE id=$1",[activity]);
 const replay=await app.inject({method:'POST',url,payload:{},headers:{'idempotency-key':key}});expect(replay.statusCode,replay.body).toBe(404);
});
it('rolls back consolidation status, proposal provenance and receipt on late audit failure',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_consolidation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_consolidation_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_consolidation_audit()');
 try{
  const response=await app.inject({method:'POST',url:`/api/v1/activity/${activity}/consolidate`,payload:{},headers:{'idempotency-key':randomUUID()}});
  expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT id FROM proposals')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT status FROM activity_records WHERE id=$1',[activity])).rows[0]?.status).toBe('raw');
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_consolidation_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_consolidation_audit()');}
});
for(const destination of ['personal_inbox','project_raw','project_marginalia'] as const)it(`captures ${destination} once through the retained URL and canonical owner`,async()=>{
 const key=randomUUID(),body={text:'  A captured thought  ',destination,project_id:project};
 const send=()=>app.inject({method:'POST',url:'/api/v1/captures',payload:body,headers:{'idempotency-key':key}});
 const first=await send();expect(first.statusCode,first.body).toBe(201);
 expect(first.json().data).toMatchObject({destination,space_id:space,project_id:destination==='personal_inbox'?null:project,visibility:destination==='project_raw'?'space_shared':'private',status:destination==='project_marginalia'?'processed':'raw'});
 expect((await send()).json()).toEqual(first.json());
 const saved=(await db.pool.query('SELECT content,payload_json FROM activity_records WHERE id=$1',[first.json().data.activity_id])).rows[0];expect(saved.content).toBe('A captured thought');
 if(destination==='project_marginalia'){
  expect(first.json().data.note_title).toBe('My project notes');expect(first.json().data.block_id).toBeTruthy();
  expect(saved.payload_json.marginalia.note_id).toBe(first.json().data.note_id);
 }
 expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(2);
 await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[user]);expect((await send()).statusCode).toBe(404);
});
it('does not leave a capture or marginalia note after late mandatory audit failure',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_capture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_capture_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_capture_audit()');
 try{
  const response=await app.inject({method:'POST',url:'/api/v1/captures',payload:{text:'A thought',destination:'project_marginalia',project_id:project},headers:{'idempotency-key':randomUUID()}});expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT object_id FROM notes')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_capture_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_capture_audit()');}
});
it('ingests keyed raw Activity through its owner, with current replay and no active Memory',async()=>{
 const payload={source_type:'manual',content:'Raw input',project_id:project,user_id:user,metadata_json:{tag:'kept'}},key=randomUUID();
 const send=()=>app.inject({method:'POST',url:'/api/v1/activity',payload,headers:{'idempotency-key':key}});
 const first=await send();expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({source_type:'user_capture',content:'Raw input',visibility:'space_shared',project_id:project,user_id:user,metadata_json:{tag:'kept'}});
 expect((await send()).json()).toEqual(first.json());
 expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
 await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);expect((await send()).statusCode).toBe(404);
});
it('rejects inaccessible provenance references and rolls raw Activity back on audit failure',async()=>{
 const body={source_type:'user_capture',content:'Thought',project_id:project};
 const absent=await app.inject({method:'POST',url:'/api/v1/activity',payload:{...body,source_run_id:randomUUID()},headers:{'idempotency-key':randomUUID()}});expect(absent.statusCode,absent.body).toBe(404);
 await db.pool.query("CREATE FUNCTION refuse_ingest_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_ingest_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_ingest_audit()');
 try{
  const response=await app.inject({method:'POST',url:'/api/v1/activity',payload:body,headers:{'idempotency-key':randomUUID()}});expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_ingest_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_ingest_audit()');}
});
it('preserves a visible Agent and real Run as Activity provenance',async()=>{
 const run=randomUUID(),agent=randomUUID();await seedRun(db.pool,{id:run,space,owner:user,agent,version:randomUUID()});
 const payload={source_type:'agent_run',content:'Run observation',agent_id:agent,source_run_id:run};
 const {ACTIVITY_OPERATION_SCHEMAS}=await import('@rainver/protocol');expect(ACTIVITY_OPERATION_SCHEMAS['activity.create'].input.safeParse(payload)).toMatchObject({success:true});
 const response=await app.inject({method:'POST',url:'/api/v1/activity',payload,headers:{'idempotency-key':randomUUID()}});
 expect(response.statusCode,response.body).toBe(200);expect(response.json().data).toMatchObject({agent_id:agent,source_run_id:run,source_type:'run_event',user_id:user});
});
const summary=(activityId:string,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/activity/summary-runs',payload:{activity_ids:[activityId],create_memory_proposal:true},headers:{'idempotency-key':key}});
function summaryRegistry(){const registry=new JobHandlerRegistry();registerActivitySummaryJob(registry,config());return registry;}
async function summaryClaim(){
 const queue=new PgJobQueueRepository(db.pool),worker=randomUUID(),job=(await queue.claimNext(worker,[ACTIVITY_SUMMARY_JOB]))!;expect(job).toBeTruthy();expect(await queue.startJob(job.id,worker)).toBe(true);
 return {job_id:job.id,space_id:job.space_id,user_id:job.user_id,job_type:job.job_type,attempts:job.attempts,max_attempts:job.max_attempts,worker_id:worker,payload:job.payload_json};
}
it('queues one summary intent and settles canonical Artifact/proposal and Job together',async()=>{
 const key=randomUUID(),first=await summary(activity,key);expect(first.statusCode,first.body).toBe(202);
 expect((await summary(activity,key)).json()).toEqual(first.json());expect((await summary(activity)).statusCode).toBe(202);
 expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1',[ACTIVITY_SUMMARY_JOB])).rows).toHaveLength(1);
 expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
 const result=await new JobWorker(new PgJobQueueRepository(db.pool),summaryRegistry(),randomUUID(),[ACTIVITY_SUMMARY_JOB]).processOne();
 expect(result).toEqual({status:'completed',job_id:first.json().data.job_id});
 expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(1);
 expect((await db.pool.query('SELECT proposal_type,status FROM proposals')).rows).toMatchObject([{proposal_type:'memory_create',status:'pending'}]);
 expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
});
it('refuses stale summary claims and changed-input replay without producing content',async()=>{
 const key=randomUUID();expect((await summary(activity,key)).statusCode).toBe(202);const job=await summaryClaim(),registry=summaryRegistry();
 await expect(registry.dispatch({...job,attempts:job.attempts+1})).rejects.toThrow('claim');
 expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
 await db.pool.query("UPDATE activity_records SET content='Changed input' WHERE id=$1",[activity]);
 expect((await summary(activity,key)).statusCode).toBe(404);
 await expect(registry.dispatch(job)).rejects.toThrow('inputs changed');
 expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
});
it('rolls summary admission and result settlement back on mandatory audit failure',async()=>{
 expect((await summary(activity)).statusCode).toBe(202);const job=await summaryClaim();
 await db.pool.query("CREATE FUNCTION refuse_summary_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_summary_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_summary_audit()');
 try{
  await expect(summaryRegistry().dispatch(job)).rejects.toThrow('audit unavailable');
  expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);expect((await db.pool.query('SELECT id FROM proposals')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[job.job_id])).rows[0].status).toBe('running');
  const before=(await db.pool.query('SELECT id FROM operation_idempotency')).rows;
  expect((await summary(activity)).statusCode).toBe(503);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toEqual(before);
 }finally{await db.pool.query('DROP TRIGGER refuse_summary_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_summary_audit()');}
});
it('refuses summary execution and replay after the responsible person exits',async()=>{
 const key=randomUUID();expect((await summary(activity,key)).statusCode).toBe(202);const job=await summaryClaim();
 await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[user]);
 expect((await summary(activity,key)).statusCode).toBe(404);await expect(summaryRegistry().dispatch(job)).rejects.toThrow('Active');
 expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
});
for(const mode of ['copy','move'] as const)it(`relocates ${mode} through canonical current Note blocks and replays the exact receipt`,async()=>{
 const created=await app.inject({method:'POST',url:'/api/v1/captures',payload:{text:'Relocation source',destination:'project_marginalia',project_id:project},headers:{'idempotency-key':randomUUID()}});expect(created.statusCode,created.body).toBe(201);
 const source=created.json().data,key=randomUUID(),payload={destination:'project_raw',project_id:project,mode,block_ids:[source.block_id]};
 const request=()=>app.inject({method:'POST',url:`/api/v1/captures/${source.activity_id}/relocation`,payload,headers:{'idempotency-key':key}});
 const first=await request();expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({destination:'project_raw',mode,moved_block_ids:[source.block_id],note_id:null});
 const second=await request();expect(second.statusCode,second.body).toBe(200);expect(second.json()).toEqual(first.json());
 expect((await db.pool.query('SELECT content FROM activity_records WHERE id=$1',[first.json().data.activity_id])).rows[0].content).toBe('Relocation source');
 expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(3);
 await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[user]);expect((await request()).statusCode).toBe(404);
});
it('rolls relocation destination and source Note removal back on late mandatory audit failure',async()=>{
 const created=await app.inject({method:'POST',url:'/api/v1/captures',payload:{text:'Original note',destination:'project_marginalia',project_id:project},headers:{'idempotency-key':randomUUID()}});const source=created.json().data;
 const original=(await db.pool.query('SELECT content_json FROM notes WHERE object_id=$1',[source.note_id])).rows[0].content_json;
 const receipts=(await db.pool.query('SELECT id FROM operation_idempotency')).rows;
 await db.pool.query("CREATE FUNCTION refuse_relocation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_relocation_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_relocation_audit()');
 try{
  const response=await app.inject({method:'POST',url:`/api/v1/captures/${source.activity_id}/relocation`,payload:{destination:'project_raw',project_id:project,mode:'move',block_ids:[source.block_id]},headers:{'idempotency-key':randomUUID()}});expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT content_json FROM notes WHERE object_id=$1',[source.note_id])).rows[0].content_json).toEqual(original);
  expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(2);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toEqual(receipts);
 }finally{await db.pool.query('DROP TRIGGER refuse_relocation_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_relocation_audit()');}
});
it('serializes competing move intents without duplicating the selected Note block',async()=>{
 const created=await app.inject({method:'POST',url:'/api/v1/captures',payload:{text:'Only one move',destination:'project_marginalia',project_id:project},headers:{'idempotency-key':randomUUID()}});const source=created.json().data;
 const request=()=>app.inject({method:'POST',url:`/api/v1/captures/${source.activity_id}/relocation`,payload:{destination:'project_raw',project_id:project,mode:'move',block_ids:[source.block_id]},headers:{'idempotency-key':randomUUID()}});
 const results=await Promise.all([request(),request()]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,422]);
 expect((await db.pool.query("SELECT id FROM activity_records WHERE content='Only one move'")).rows).toHaveLength(2);
});
