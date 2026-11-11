import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedAgentWithVersion} from './support/domainSeeds.js';
import {createQuestionThreadScope,seedArxivSourceChain,seedPendingScreeningGate} from './support/researchSeeds.js';
import {insertResearchWorkflowFixture} from './support/researchWorkflow.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectResearchModule} from '../src/modules/projectResearch/index.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {registerProjectResearchExecutionHandlers} from '../src/modules/projectResearch/executionRegistration.js';
import {loadConfig} from '../src/config.js';
import {ContentAccessService} from '../src/modules/contentAccess/service.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';

// Human Research/Corpus/monitoring controls migrated onto the operation core:
// formal URLs and the generic entry share one request identity, deterministic
// domain refusals are cached, and authority/rollback hold at the real database.
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,workflow:string,operation:string,plan:string,channel:string,thread:{thread_id:string;version:number;kind:string;statement:string};
let app:ReturnType<typeof buildModuleServer>;
const as=(userId:string)=>__setAuthIdentityForTests({spaceId:space,userId});
const call=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
const formal=(method:'POST'|'PUT',path:string,payload:object,key=randomUUID())=>app.inject({method,url:`/api/v1/projects/${project}${path}`,payload,headers:{'idempotency-key':key}});
const count=async(sql:string,args:unknown[])=>Number((await db.pool.query<{n:string}>(sql,args)).rows[0]!.n);
beforeAll(()=>{registerProjectResearchExecutionHandlers();});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','source_provider_connectors','source_providers','source_connectors'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();workflow=randomUUID();operation=randomUUID();plan=randomUUID();channel=randomUUID();
 const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 const agent=randomUUID();await seedAgentWithVersion(db.pool,{agent,version:randomUUID(),space,owner,now});
 thread=await createQuestionThreadScope(db.pool,{spaceId:space,userId:owner},project,'Does X improve Y?');
 await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection:randomUUID(),channel,space,owner,now});
 await insertResearchWorkflowFixture(db.pool,{id:workflow,spaceId:space,projectId:project,startedByUserId:owner,currentStage:'screening',primaryThreadId:thread.thread_id,state:{research_question:'Does X improve Y?',research_question_version:thread.version,thread_scope:[thread],agent_id:agent,initial_intake:{max_items:10}},now});
 await db.pool.query(`INSERT INTO project_operations (id,space_id,project_id,kind,title,status,created_by_user_id,progress_json,created_at,updated_at) VALUES ($1,$2,$3,'research','Initial literature intake','waiting_review',$4,$5::jsonb,$6,$6)`,
  [operation,space,project,owner,JSON.stringify({schema_version:'project_research_operation.v1',run_kind:'baseline',workflow_id:workflow,agent_id:agent,research_question:'Does X improve Y?',research_question_version:thread.version,thread_scope:[thread],source_backfill_plan_ids:[plan],source_backfill_plan_id:plan,current_stage:'backfill',stage_state:'running',history:{mode:'bounded_range',from:'2026-01-01T00:00:00.000Z',to:'2026-02-01T00:00:00.000Z',max_items:10},partial:false,channel_ids:[channel],source_item_ids:[],checkpoint_ids:[]}),now]);
 await db.pool.query(`INSERT INTO source_backfill_plans (id,space_id,source_channel_id,project_operation_id,requested_by_user_id,origin,strategy_json,quota_policy_json,status,segments_total,segments_completed,segments_failed,items_ingested,idempotency_key,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'user',$6::jsonb,$7::jsonb,'completed',1,1,0,0,$8,$9,$9)`,
  [plan,space,channel,operation,owner,JSON.stringify({window_unit:'date_window',history_mode:'bounded_range',from:'2026-01-01T00:00:00.000Z',to:'2026-02-01T00:00:00.000Z',window_size:30,direction:'backward'}),JSON.stringify({window:'minute',limit_count:10}),`idem-${plan}`,now]);
 await db.pool.query(`INSERT INTO source_backfill_segments (id,plan_id,space_id,seq,window_json,status,attempt_count,items_ingested) VALUES ($1,$2,$3,0,$4::jsonb,'succeeded',1,0)`,[randomUUID(),plan,space,JSON.stringify({from:'2026-01-01T00:00:00.000Z',to:'2026-02-01T00:00:00.000Z',max_items:10})]);
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-p5-tests'}),[projectResearchModule,projectsModule,systemActionsModule]);as(owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('rescans through the formal URL once; generic replay returns the same receipt and a changed target with the key is refused',async()=>{
 const key=randomUUID(),first=await formal('POST',`/research/operations/${operation}/rescan`,{},key);
 expect(first.statusCode,first.body).toBe(202);expect(first.json().data).toEqual({id:operation,project_id:project,space_id:space});
 const reconciles=await count("SELECT count(*) AS n FROM jobs WHERE space_id=$1 AND payload_json->>'operation_id'=$2",[space,operation]);
 expect(reconciles).toBeGreaterThan(0);
 const replay=await call('research.operation.rescan',{project_id:project,operation_id:operation},key);
 expect(replay.statusCode).toBe(202);expect(replay.json()).toEqual(first.json());
 expect(await count("SELECT count(*) AS n FROM jobs WHERE space_id=$1 AND payload_json->>'operation_id'=$2",[space,operation])).toBe(reconciles);
 expect((await call('research.operation.rescan',{project_id:project,operation_id:randomUUID()},key)).statusCode).toBe(404);
 expect((await formal('POST',`/research/operations/${operation}/rescan`,{operation_id:operation})).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/operations/${operation}/rescan`,payload:{}})).statusCode).toBe(422);
});

it('caches a deterministic domain refusal under its key while a fresh key observes current state',async()=>{
 const key=randomUUID(),refused=await call('research.operation.retry',{project_id:project,operation_id:operation},key);
 expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error).toMatchObject({code:'operation_conflict',domain:'research'});
 expect(refused.body).not.toContain('Only failed');
 await db.pool.query("UPDATE project_operations SET status='failed' WHERE id=$1",[operation]);
 const replay=await call('research.operation.retry',{project_id:project,operation_id:operation},key);
 expect(replay.statusCode).toBe(409);expect(replay.json().error.code).toBe('operation_conflict');
 const fresh=await formal('POST',`/research/operations/${operation}/retry`,{});
 expect(fresh.statusCode,fresh.body).toBe(202);expect(fresh.json().data.id).toBe(operation);
});

it('raises the item limit only upward and refuses a viewer without changing state',async()=>{
 const raised=await formal('PUT',`/research/operations/${operation}/item-limit`,{max_items:25});
 expect(raised.statusCode,raised.body).toBe(200);
 expect((await db.pool.query("SELECT progress_json->'history'->>'max_items' AS n FROM project_operations WHERE id=$1",[operation])).rows[0]!.n).toBe('25');
 expect((await call('research.operation.item_limit',{project_id:project,operation_id:operation,max_items:12})).statusCode).toBe(409);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});as(peer);
 const hidden=await call('research.operation.item_limit',{project_id:project,operation_id:operation,max_items:40});
 expect(hidden.statusCode).toBe(404);
 expect((await db.pool.query("SELECT progress_json->'history'->>'max_items' AS n FROM project_operations WHERE id=$1",[operation])).rows[0]!.n).toBe('25');
});

it('decides a checkpoint once and replays its receipt without re-running the rejection',async()=>{
 const checkpoint=randomUUID();await seedPendingScreeningGate(db.pool,{id:checkpoint,space,project,workflow,machineResult:{operation_id:operation,total:0},now:new Date().toISOString()});
 const key=randomUUID(),url=`/research/workflow/${workflow}/checkpoints/${checkpoint}/decide`;
 const decided=await formal('POST',url,{decision:'rejected',reason:'Out of scope'},key);
 expect(decided.statusCode,decided.body).toBe(200);expect(decided.json().data).toEqual({id:checkpoint,workflow_id:workflow,project_id:project,space_id:space});
 expect((await db.pool.query('SELECT status FROM project_operations WHERE id=$1',[operation])).rows[0]!.status).toBe('failed');
 const updated=(await db.pool.query<{updated_at:Date}>('SELECT updated_at FROM project_research_checkpoints WHERE id=$1',[checkpoint])).rows[0]!.updated_at;
 expect((await call('research.checkpoint.decide',{project_id:project,workflow_id:workflow,checkpoint_id:checkpoint,decision:'rejected',reason:'Out of scope'},key)).json()).toEqual(decided.json());
 expect((await db.pool.query<{updated_at:Date}>('SELECT updated_at FROM project_research_checkpoints WHERE id=$1',[checkpoint])).rows[0]!.updated_at).toEqual(updated);
 expect((await formal('POST',url,{decision:'approved'})).statusCode).toBe(409);
 expect((await formal('POST',`/research/workflow/${randomUUID()}/checkpoints/${checkpoint}/decide`,{decision:'approved'})).statusCode).toBe(404);
});

it('hides an operation whose bound Workflow Thread the caller can no longer change',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
 await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=ANY($1::varchar[])",[[thread.thread_id,workflow]]);as(peer);
 for(const result of [await formal('POST',`/research/operations/${operation}/rescan`,{}),await call('research.operation.reconcile',{project_id:project,operation_id:operation})]){expect(result.statusCode,result.body).toBe(404);}
 expect((await db.pool.query("SELECT progress_json->>'current_stage' AS stage FROM project_operations WHERE id=$1",[operation])).rows[0]!.stage).toBe('backfill');
});

it('refuses writes on an archived Project as a conflict without effects',async()=>{
 await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
 const result=await formal('POST',`/research/operations/${operation}/rescan`,{});
 expect(result.statusCode,result.body).toBe(409);
 expect(await count("SELECT count(*) AS n FROM jobs WHERE space_id=$1 AND payload_json->>'operation_id'=$2",[space,operation])).toBe(0);
});

it('shares one Corpus rebuild command across both retained URLs and rolls back when the decision audit cannot persist',async()=>{
 const key=randomUUID(),corpus=await formal('POST','/corpus/backfill-source-items',{},key);
 expect(corpus.statusCode,corpus.body).toBe(200);expect(corpus.json().data).toMatchObject({project_id:project,space_id:space,source_items:0});
 expect((await formal('POST','/research/evidence-matrix/rebuild',{},key)).json()).toEqual(corpus.json());
 await db.pool.query("CREATE FUNCTION refuse_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE audit fault'; END $$");
 await db.pool.query('CREATE TRIGGER refuse_decision BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_decision()');
 try{const failed=await formal('POST',`/research/operations/${operation}/rescan`,{});expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('PRIVATE');}
 finally{await db.pool.query('DROP TRIGGER refuse_decision ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_decision()');}
 expect(await count("SELECT count(*) AS n FROM jobs WHERE space_id=$1 AND payload_json->>'operation_id'=$2",[space,operation])).toBe(0);
 expect(await count("SELECT count(*) AS n FROM operation_idempotency WHERE space_id=$1 AND operation_id='research.operation.rescan'",[space])).toBe(0);
});

it('records private monitoring feedback for a Project reader and requires a readable linked item',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);as(peer);
 expect((await formal('POST',`/information-monitoring/items/${randomUUID()}/feedback`,{feedback:'relevant'})).statusCode).toBe(404);
 expect((await formal('POST','/information-monitoring/reconcile',{})).statusCode).toBe(404);
});

it('submits a Source binding proposal once per key and hides absent Sources',async()=>{
 const key=randomUUID(),first=await formal('POST','/sources/propose-bind',{source_channel_id:channel},key);
 expect(first.statusCode,first.body).toBe(201);
 expect((await formal('POST','/sources/propose-bind',{source_channel_id:channel},key)).json()).toEqual(first.json());
 expect(await count("SELECT count(*) AS n FROM proposals WHERE space_id=$1 AND proposal_type='project_source_bind'",[space])).toBe(1);
 expect((await db.pool.query('SELECT status,project_id FROM proposals WHERE id=$1',[first.json().data.id])).rows[0]).toEqual({status:'pending',project_id:project});
 expect((await formal('POST','/sources/propose-bind',{source_channel_id:randomUUID()})).statusCode).toBe(404);
 expect((await formal('POST','/sources/propose-bind',{source_channel_id:channel,unexpected:true})).statusCode).toBe(422);
});

it('refuses public summary feedback for a summary the person cannot read',async()=>{
 const result=await app.inject({method:'POST',url:'/api/v1/projects/public-summaries/feedback',payload:{query:'q',object_type:'project_public_summary',object_id:randomUUID(),signal_type:'opened'},headers:{'idempotency-key':randomUUID()}});
 expect(result.statusCode,result.body).toBe(404);
 expect(await count('SELECT count(*) AS n FROM retrieval_feedback_events WHERE space_id=$1',[space])).toBe(0);
});

// --- Incremental update with already-scanned items and a business update key.

async function monitoredWorkflow(){
 await db.pool.query(`UPDATE project_research_workflows SET state_json=state_json||jsonb_build_object('channel_ids',jsonb_build_array($2::text),'project_source_binding_ids',jsonb_build_array('binding-1'),'monitoring',jsonb_build_object('active',true),'report_depth','quick') WHERE object_id=$1`,[workflow,channel]);
 // The baseline has finished; an update may start.
 await db.pool.query("UPDATE project_operations SET status='completed' WHERE id=$1",[operation]);
 return (await db.pool.query<{id:string}>('SELECT source_connection_id AS id FROM source_channels WHERE id=$1',[channel])).rows[0]!.id;
}
async function scannedItem(connection:string|null,itemOwner=owner,visibility='space_shared'){
 const id=randomUUID();
 await db.pool.query(`INSERT INTO source_items (id,space_id,owner_user_id,visibility,connection_id,item_type,title,excerpt,source_uri,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
  VALUES ($1,$2,$3,$4,$5,'feed_entry','Scanned entry','Scanned text.',$6,now()-interval '1 minute',now(),'excerpt_saved','summary_only',now(),now())`,[id,space,itemOwner,visibility,connection,`https://example.com/${id}`]);
 return id;
}
const incrementalOps=()=>count("SELECT count(*) AS n FROM project_operations WHERE space_id=$1 AND progress_json->>'run_kind'='incremental'",[space]);
const trigger=(payload:object,key=randomUUID())=>formal('POST',`/research/workflow/${workflow}/trigger`,payload,key);

it('queues an update for named scanned items under a business key and replays it by transport key and by business key',async()=>{
 const connection=await monitoredWorkflow(),first=await scannedItem(connection),second=await scannedItem(connection);
 const transport=randomUUID();
 // The historical body marker is still accepted on the formal URL.
 const queued=await trigger({run_kind:'incremental',source_item_ids:[first,second],idempotency_key:'daily-update-1'},transport);
 expect(queued.statusCode,queued.body).toBe(202);
 const opId=queued.json().data.id as string;
 expect((await db.pool.query("SELECT progress_json->'source_item_ids' AS items,progress_json->'idempotency'->>'key' AS key,progress_json->>'awaiting_source_scan' AS scan FROM project_operations WHERE id=$1",[opId])).rows[0])
  .toEqual({items:[first,second],key:'daily-update-1',scan:'false'});
 // Same transport key, same body: the cached receipt, no new work.
 expect((await trigger({run_kind:'incremental',source_item_ids:[first,second],idempotency_key:'daily-update-1'},transport)).json()).toEqual(queued.json());
 // Same transport key, different body: refused as a reused key.
 expect((await trigger({source_item_ids:[first]},transport)).statusCode).toBe(422);
 // A fresh transport key with the same business key replays the same update (the generic entry too).
 const replay=await call('research.workflow.trigger',{project_id:project,workflow_id:workflow,source_item_ids:[first,second],idempotency_key:'daily-update-1'});
 expect(replay.statusCode,replay.body).toBe(202);expect(replay.json().data.id).toBe(opId);
 expect(await incrementalOps()).toBe(1);
});

it('treats an explicit empty item list as the omitted one: one scan-first update, one transport replay, one business replay',async()=>{
 await monitoredWorkflow();
 const scans=()=>count("SELECT count(*) AS n FROM extraction_jobs WHERE space_id=$1 AND job_type='connection_scan'",[space]);
 const transport=randomUUID();
 const queued=await trigger({source_item_ids:[],idempotency_key:'scan-first'},transport);
 expect(queued.statusCode,queued.body).toBe(202);
 const opId=queued.json().data.id as string;
 expect((await db.pool.query("SELECT progress_json->'source_item_ids' AS items,progress_json->>'awaiting_source_scan' AS scan FROM project_operations WHERE id=$1",[opId])).rows[0]).toEqual({items:[],scan:'true'});
 expect(await scans()).toBe(1);
 // Same transport key with the list omitted: one request fingerprint, so the cached receipt.
 const transportReplay=await trigger({idempotency_key:'scan-first'},transport);
 expect(transportReplay.statusCode,transportReplay.body).toBe(202);expect(transportReplay.json()).toEqual(queued.json());
 // A fresh transport key with the same business key replays the update without scanning again.
 const businessReplay=await call('research.workflow.trigger',{project_id:project,workflow_id:workflow,source_item_ids:[],idempotency_key:'scan-first'});
 expect(businessReplay.statusCode,businessReplay.body).toBe(202);expect(businessReplay.json().data.id).toBe(opId);
 expect(await scans()).toBe(1);expect(await incrementalOps()).toBe(1);
});

it('refuses named items the Workflow never scanned or the person can no longer read in full, and an unbounded list',async()=>{
 const connection=await monitoredWorkflow();
 const loose=await scannedItem(null);
 // A second connection of the same person that this Workflow does not monitor.
 const otherConnection=randomUUID();
 await db.pool.query(`INSERT INTO source_connections (id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at)
  SELECT $1,space_id,provider_connector_id,owner_user_id,'Unmonitored',status,capture_policy,trust_level,consent_json,policy_json,config_json,now(),now() FROM source_connections WHERE id=$2`,[otherConnection,connection]);
 const elsewhere=await scannedItem(otherConnection);
 for(const item of [loose,elsewhere,randomUUID()]){
  const refused=await trigger({source_item_ids:[item]});
  expect(refused.statusCode,refused.body).toBe(404);
 }
 // A peer's scanned item shared by grant, then taken back through the content policy.
 const peer=randomUUID(),other=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await seedSpaceMember(db.pool,{space,user:other});
 const shared=await scannedItem(connection,peer,'selected_users');
 const grant=(user:string)=>new ContentAccessService(db.pool).updatePolicy({spaceId:space,userId:peer},'source_item',shared,{project_id:null,visibility:'selected_users',access_level:'full',grants:[{user_id:user,access_level:'full'}]} as never);
 await grant(owner);
 const key='granted-update';
 expect((await trigger({source_item_ids:[shared],idempotency_key:key})).statusCode).toBe(202);
 await grant(other);
 const revoked=await trigger({source_item_ids:[shared],idempotency_key:'after-revocation'});
 expect(revoked.statusCode,revoked.body).toBe(404);
 // Narrowed to summary: listed, but not readable in full.
 await grant(owner);
 await new ContentAccessService(db.pool).updatePolicy({spaceId:space,userId:peer},'source_item',shared,{project_id:null,visibility:'selected_users',access_level:'summary',grants:[{user_id:owner,access_level:'summary'}]} as never);
 expect((await trigger({source_item_ids:[shared],idempotency_key:'summary-only'})).statusCode).toBe(404);
 expect((await trigger({source_item_ids:Array.from({length:501},()=>randomUUID())})).statusCode).toBe(422);
 expect(await incrementalOps()).toBe(1);
});

it('refuses a business key that already names another Workflow\'s Operation',async()=>{
 const connection=await monitoredWorkflow(),item=await scannedItem(connection);
 await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('workflow_id',$2::text,'idempotency',jsonb_build_object('key','shared-key')) WHERE id=$1`,[operation,randomUUID()]);
 const refused=await trigger({source_item_ids:[item],idempotency_key:'shared-key'});
 expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error).toMatchObject({code:'operation_conflict',domain:'research'});
 expect(await incrementalOps()).toBe(0);
});
