import {SourceExtractionWorker} from '../src/modules/sources/extractionWorker.js';
import {publicAddressGuard} from './support/outboundGuard.js';
import {RuntimeContextPolicyRepository} from '../src/modules/policy/runtimeContextPolicyRepository.js';
import {buildServerDist,startWorkerProcess,until,isPrompted,isFrame,settledCommands,type WorkerProcess} from './support/briefingWorkerHarness.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {beforeEach,afterEach,expect,vi} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,PROJECT,OWNER,MEMBER,AGENT,PROFILE,CONNECTION,CHANNEL,HOST,outputValue} from './support/briefingFixture.js';
import {syncBuiltinPrompts} from '../src/modules/prompts/builtins.js';
import {goalSourceRow,goalSourceFingerprint,type GoalRow} from '../src/modules/sources/goals/access.js';
import {configureThemeAnalysis,settleThemeRound,readThemeRounds} from '../src/modules/informationDigest/topics/service.js';
import {requestGoalCheck,enqueueGoalCollection} from '../src/modules/sources/goals/collectionQueue.js';
import {runSourceGoalTick,enqueueDueSourceGoals} from '../src/modules/sources/goals/worker.js';
import type {GoalExecutionPort} from '../src/modules/sources/goals/service.js';
import {sourcePolicyEnvelope} from './support/customSourceFixtures.js';
import {saveSourceReadingDocument,agentReadingDocument} from '../src/modules/sources/materialProcessing/documents.js';
import {assertBriefingDispatch} from '../src/modules/informationDigest/briefing/settlement.js';
import {withDbTransaction} from '../src/modules/routeUtils/common.js';
import {PgSchedulerTaskStore} from '../src/modules/scheduler/taskStore.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {buildModuleServer} from './support/moduleServer.js';
import {informationDigestModule} from '../src/modules/informationDigest/index.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {PostRunFinalizationService} from '../src/modules/runs/finalizationService.js';
import {runSettlement} from '../src/modules/runs/runSettlement.js';
import {composeProjectReading,readProjectComposition} from '../src/modules/informationDigest/composition/service.js';

import type {TestPartition} from './support/testPartition.js';

/** Registered by the `projectReadingThemesDb.N.test.ts` entry files, one part each (see support/testPartition.ts). */
export function defineProjectReadingThemesDbSuite(filename: string, {it}: TestPartition): void {
const db=useTestDatabase(filename,{max:6}),w=briefingWorld(db),identity={spaceId:SPACE,userId:OWNER};
let goalId:string,versionId:string,bindingId:string,itemId:string;
let empty=false,fail=false,root='';let worker:WorkerProcess|undefined;
const config=()=>({...w.config(),rainverHome:root,artifactStorageRoot:join(root,'artifacts'),sandboxRoot:join(root,'sandbox')});
const spec={source_connection_id:CONNECTION,source_channel_id:CHANNEL,reason:'Topic source',supports_history:false,implementation:{kind:'connector' as const}};
const executor:GoalExecutionPort={async execute(){if(fail)throw new Error('source_network_failed');return {output:{contract_version:'custom_source.handler_output.v1',items:empty?[]:[{external_id:'paper',title:'Evidence article',source_uri:'https://news.test/article',published_at:'2026-10-31T12:00:00Z',snapshots:[],evidence:[]}]},fixture:null,source_kind:'feed',cursor:{},filesRoot:root,envelope:sourcePolicyEnvelope({capture_policy:'extract_text',retention_policy:'full_text',allowed_network_origins:['https://news.test']}),cleanup:async()=>{}};}};
afterEach(async()=>{vi.restoreAllMocks();if(worker){await worker.stop();worker=undefined;}__setAuthIdentityForTests(null);if(root)await rm(root,{recursive:true,force:true});});
beforeEach(async()=>{if(!db.available)return;root=await mkdtemp(join(tmpdir(),'reading-theme-'));await w.seed();empty=false;fail=false;
 await syncBuiltinPrompts(db.pool,config().catalogRoot,['reading.following_synthesis']);
 await db.pool.query(`UPDATE source_connections SET project_id=$2,capture_policy='extract_text',policy_json='{"retention_policy":"full_text","source_egress_class":"external_provider_allowed"}' WHERE id=$1`,[CONNECTION,PROJECT]);
 await db.pool.query("UPDATE source_channels SET fetch_frequency='manual' WHERE id=$1",[CHANNEL]);
 goalId=randomUUID();versionId=randomUUID();bindingId=randomUUID();
 await db.pool.query(`INSERT INTO source_goals(id,space_id,project_id,owner_user_id,agent_id,runtime_profile_id,intent_json,budget_json,status,active_version_id,compatibility_json) VALUES($1,$2,$3,$4,$5,$6,'{"intent":"Understand mechanisms and risks","includes":[],"excludes":[]}','{"requests_per_run":8,"items_per_source":20,"agent_attempts":2,"repair_attempts":0,"interval_seconds":86400}','running',$7,'{}')`,[goalId,SPACE,PROJECT,OWNER,AGENT,PROFILE,versionId]);
 await db.pool.query(`INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_user_id) VALUES($1,$2,$3,1,$4,$5)`,[versionId,SPACE,goalId,{title:'System mechanisms',summary:'Purpose',analysis_brief:'Understand mechanisms and independent counter-evidence',sources:[spec],limitations:[]},OWNER]);
 const source=await goalSourceRow(db.pool,SPACE,spec);
 await db.pool.query('INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json,fixture_json) VALUES($1,$2,$3,$4,$5,$6)',[bindingId,SPACE,goalId,CONNECTION,spec,{authority_sha256:goalSourceFingerprint(source!)}]);
 itemId=await w.material('Evidence article',{uri:'https://news.test/article'});await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[itemId,PROJECT]);await original('Original mechanism A with limitations.');
});
async function original(text:string){return saveSourceReadingDocument(db.pool,{spaceId:SPACE,itemId,document:{...agentReadingDocument({kind:'article',format:'source_text',text,sources:['https://news.test/article']},'https://news.test/article'),extraction_method:'plain_text_v1'}});}
async function enable(){return configureThemeAnalysis(db.pool,config(),identity,goalId,{expected_version_id:versionId,enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE});}
async function collect(){const admission=await requestGoalCheck(db.pool,config(),identity,goalId,{expected_version_id:versionId});const job=(await db.pool.query('SELECT payload_json FROM jobs WHERE id=$1',[admission.job_id])).rows[0];expect(job.payload_json.round_id).toBeTruthy();const collected=await runSourceGoalTick(db.pool,config(),goalId,SPACE,executor,versionId,job.payload_json.round_id);if(!fail)expect(collected,JSON.stringify(collected)).toMatchObject({results:[{status:'succeeded'}]});await db.pool.query("UPDATE jobs SET status='completed' WHERE id=$1",[admission.job_id]);return job.payload_json.round_id as string;}
async function round(id:string){return (await db.pool.query('SELECT * FROM project_reading_rounds WHERE id=$1',[id])).rows[0];}
async function publish(id:string,novelty:'baseline'|'ongoing'|'update'='baseline'){await settleThemeRound(db.pool,config(),id);const r=await round(id);const run=await w.runOf(r.briefing_id);const refs=(await db.pool.query('SELECT ref_key FROM information_briefing_inputs WHERE briefing_id=$1 AND status=\'included\' ORDER BY ref_key',[r.briefing_id])).rows.map(x=>x.ref_key);const text=JSON.stringify(outputValue({overview:{text:'Mechanisms and limitations affect the purpose.',refs},topic:{quick_line:'Evidence identifies a useful mechanism and a limit.',summary:'The retained original explains the mechanism. Its limits remain important.',stop_reason:'Only the authorized retained evidence was available.'}},novelty));const done=await w.finishRun(run.id,text);await new PostRunFinalizationService(new PgRunRepository(db.pool),undefined,undefined,undefined,runSettlement(config(),db.pool)).finalize(done.id,SPACE);return r.briefing_id as string;}
it('requires explicit exact-version analysis consent; metadata reads never enqueue',async()=>{
 const before=await w.count('runs');const g=(await db.pool.query<GoalRow>('SELECT * FROM source_goals WHERE id=$1',[goalId])).rows[0];await withDbTransaction(db.pool,tx=>enqueueGoalCollection(tx,g,'old-consent'));
 expect(await w.count('project_reading_rounds')).toBe(0);expect((await readThemeRounds(db.pool,identity,goalId)).analysis).toBeNull();expect(await w.count('runs')).toBe(before);
 await expect(configureThemeAnalysis(db.pool,config(),{spaceId:SPACE,userId:MEMBER},goalId,{expected_version_id:versionId,enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE})).rejects.toMatchObject({statusCode:403});
 await expect(configureThemeAnalysis(db.pool,config(),identity,goalId,{expected_version_id:randomUUID(),enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE})).rejects.toMatchObject({statusCode:409});await enable();
});
it('manual durable collection -> exact original manifest -> canonical settlement -> theme API, then unchanged reuses without new Run',async()=>{
 await enable();const id=await collect();const audit=(await db.pool.query('SELECT status FROM source_goal_runs WHERE id=$1',[(await round(id)).targets_json[0].audit_id])).rows[0];// The collector deduplicated an already retained original; its durable no-new audit is terminal.
 expect(audit.status).toBe('insufficient');
 const published=await publish(id),run=await w.runOf(published);expect(run.prompt).toContain('Original mechanism A');expect(run.prompt).not.toContain('Evidence article summary');expect(run.contract_snapshot_json).toHaveProperty('workflow_input_json.project_reading_theme.method.source.provenance.content_hash');
 const shown=await readThemeRounds(db.pool,{spaceId:SPACE,userId:MEMBER},goalId);expect(shown.latest?.visibility).toBe('visible');expect(shown.latest?.topic?.quick_line).toContain('mechanism');expect(shown.latest?.evidence[0]?.original_snapshot_id).toBeTruthy();
 const before=await w.count('runs');const next=await collect();await settleThemeRound(db.pool,config(),next);expect(await w.count('runs')).toBe(before);expect((await readThemeRounds(db.pool,identity,goalId)).latest?.id).toBe(published);
 const app=buildModuleServer(config(),[informationDigestModule]);__setAuthIdentityForTests(identity);try{const response=await app.inject({method:'GET',url:`/api/v1/sources/goals/${goalId}/theme-rounds`});expect(response.statusCode,response.body).toBe(200);expect(response.json().latest.topic.summary).toContain('retained original');}finally{await app.close();}
});
it('scheduler freezes a durable slot and repeated ticks/terminal callbacks do not duplicate theme Runs',async()=>{
 await enable();await new PgSchedulerTaskStore(db.pool).upsert({taskType:'source_goal_tick',taskKey:goalId,scopeType:'space',scopeId:SPACE,spaceId:SPACE,userId:OWNER,nextRunAt:new Date(Date.now()-1000).toISOString(),metadataJson:{version_id:versionId}});
 await enqueueDueSourceGoals(db.pool);await enqueueDueSourceGoals(db.pool);expect(await w.count('project_reading_rounds')).toBe(1);const r=(await db.pool.query('SELECT * FROM project_reading_rounds')).rows[0];await runSourceGoalTick(db.pool,config(),goalId,SPACE,executor,versionId,r.id);await runSourceGoalTick(db.pool,config(),goalId,SPACE,executor,versionId,r.id);
 await Promise.all([settleThemeRound(db.pool,config(),r.id),settleThemeRound(db.pool,config(),r.id)]);expect(await w.count('runs')).toBe(1);
});
it('source/retention/whole-audience withdrawal hides theme output and rejects queued dispatch',async()=>{
 await enable();const id=await collect(),version=await publish(id);await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);expect((await readThemeRounds(db.pool,identity,goalId)).latest?.visibility).toBe('withheld');
 await db.pool.query("UPDATE source_connections SET capture_policy='extract_text' WHERE id=$1",[CONNECTION]);expect((await readThemeRounds(db.pool,identity,goalId)).latest?.visibility).toBe('visible');
 await original('New mechanism B');const next=await collect();await settleThemeRound(db.pool,config(),next);const run=await w.runOf((await round(next)).briefing_id);await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allow_external_model_egress":false}' WHERE id=$1`,[CONNECTION]);await expect(assertBriefingDispatch(config(),run,db.pool)).rejects.toMatchObject({statusCode:403});expect((await readThemeRounds(db.pool,identity,goalId)).latest?.visibility).toBe('withheld');expect(version).toBeTruthy();
});
it('freezes actual original versions across subsequent extraction and never relabels report as original',async()=>{
 await enable();const id=await collect();await settleThemeRound(db.pool,config(),id);const r=await round(id),run=await w.runOf(r.briefing_id);const refs=await w.inputsOf(r.briefing_id);const frozen=refs.find(x=>x.status==='included').analysis_json.deps.items[0].original;
 await original('Later author version Z');expect(run.prompt).toContain('Original mechanism A');expect(run.prompt).not.toContain('Later author version Z');await expect(assertBriefingDispatch(config(),run,db.pool)).resolves.toBeUndefined();expect(frozen.snapshot_id).toBeTruthy();
 await publish(id);
 const shown=await readThemeRounds(db.pool,identity,goalId);
 expect(shown.latest?.evidence[0]).toMatchObject({original_snapshot_id:frozen.snapshot_id,excerpt:'Original mechanism A with limitations.'});
 expect(JSON.stringify(shown.latest?.evidence)).not.toContain('Later author version Z');
});
it('pending audit is not material terminal, deadline partial differs from failure and stopped purpose cannot publish',async()=>{
 await enable();const g=(await db.pool.query<GoalRow>('SELECT * FROM source_goals WHERE id=$1',[goalId])).rows[0];const admitted=await withDbTransaction(db.pool,tx=>enqueueGoalCollection(tx,g,'pending-slot'));const job=(await db.pool.query('SELECT payload_json FROM jobs WHERE id=$1',[admitted.job_id])).rows[0];const id=job.payload_json.round_id;
 await settleThemeRound(db.pool,config(),id);expect((await round(id)).status).toBe('collecting');expect(await w.count('runs')).toBe(0);
 await db.pool.query("UPDATE project_reading_rounds SET deadline_at=now()-interval '1 second' WHERE id=$1",[id]);await settleThemeRound(db.pool,config(),id);expect((await round(id)).coverage_json).toMatchObject({pending_sources:1,complete:false});
 await db.pool.query("UPDATE source_goals SET status='paused' WHERE id=$1",[goalId]);const r=await round(id);if(r.briefing_id){const row=await w.rowOf(r.briefing_id);if(row.run_id)await expect(assertBriefingDispatch(config(),await w.runOf(r.briefing_id),db.pool)).rejects.toMatchObject({statusCode:403});}
});
it('failed collection is blocked, not no-new, and a changed active purpose supersedes its old round',async()=>{
 await enable();fail=true;const id=await collect();await settleThemeRound(db.pool,config(),id);expect(await round(id)).toMatchObject({status:'blocked',error_code:'source_network_failed'});expect(await w.count('runs')).toBe(0);
 await db.pool.query('UPDATE source_goals SET active_version_id=$2 WHERE id=$1',[goalId,randomUUID()]);await settleThemeRound(db.pool,config(),id,true);expect((await round(id)).status).toBe('superseded');
});

it('new deterministic capture must finish before synthesis; actual extraction worker preserves original provenance',async()=>{
 await db.pool.query('DELETE FROM source_snapshots WHERE source_item_id=$1',[itemId]);await db.pool.query("UPDATE source_items SET extracted_artifact_id=NULL,content_state='metadata_only',content_hash=NULL WHERE id=$1",[itemId]);
 await enable();const id=await collect();const extraction=(await db.pool.query("SELECT id,status FROM extraction_jobs WHERE source_item_id=$1 AND job_type='extract_text'",[itemId])).rows[0];expect(extraction).toMatchObject({status:'pending'});
 await settleThemeRound(db.pool,config(),id);expect((await round(id)).status).toBe('collecting');expect(await w.count('runs')).toBe(0);
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('<html><article><h1>Mechanism</h1><p>The device uses a compliant membrane to protect fragile objects. Calibration remains necessary.</p></article></html>',{status:200,headers:{'content-type':'text/html'}}));
 await db.pool.query("UPDATE jobs SET status='running' WHERE job_type='project_reading_theme' AND scheduled_at<=now()");
 const extracted=await new SourceExtractionWorker(db.pool,config(),publicAddressGuard).runPendingJob(extraction.id,SPACE);expect(extracted.status).toBe('succeeded');
 expect((await db.pool.query("SELECT count(*)::int n FROM jobs WHERE job_type='project_reading_theme' AND payload_json->>'round_id'=$1 AND status='pending' AND scheduled_at<=now()",[id])).rows[0].n).toBe(1);
 const published=await publish(id);const run=await w.runOf(published);expect(run.prompt).toContain('compliant membrane');expect((await readThemeRounds(db.pool,identity,goalId)).latest?.evidence[0]?.original_snapshot_id).toBeTruthy();
});
it('real worker/orchestrator/Host wire Delivery settles a theme, without fixture finishRun',async()=>{
 await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
 await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic worker fixture'});
 await enable();const id=await collect();await settleThemeRound(db.pool,config(),id);const r=await round(id);const version=await w.rowOf(r.briefing_id);
 const refs=(await db.pool.query("SELECT ref_key FROM information_briefing_inputs WHERE briefing_id=$1 AND status='included' ORDER BY ref_key",[r.briefing_id])).rows.map(x=>x.ref_key);
 await buildServerDist();worker=await startWorkerProcess({databaseUrl:db.connectionUri,home:root,hostId:HOST});
 worker.send({cmd:'policy',prompt:{answer:JSON.stringify(outputValue({overview:{text:'Evidence-based theme synthesis.',refs},topic:{quick_line:'The mechanism has a bounded use.',summary:'The original describes a mechanism. Its limitations matter.',stop_reason:'Authorized fixture only.'}}))}});
 const terminal=await until(()=>w.rowOf(r.briefing_id),row=>row.status!=='queued','theme canonical settlement',150);
 expect(terminal.status,JSON.stringify(terminal)).toBe('ready');expect((await w.runs().getRun(SPACE,version.run_id))?.status).toBe('succeeded');
 expect(Number((await db.pool.query('SELECT count(*) FROM invocation_deliveries WHERE invocation_id=$1',[version.run_id])).rows[0].count)).toBe(1);
 expect((await readThemeRounds(db.pool,identity,goalId)).latest?.topic?.quick_line).toContain('mechanism');
 const total=await until(()=>readProjectComposition(db.pool,identity,PROJECT),v=>!!v.latest,'stage-two canonical Job publication',150);expect(total.latest!.sections[0].briefing_id).toBe(r.briefing_id);expect(total.latest!.sections[0].briefing?.topic?.quick_line).toContain('mechanism');
},60000);
it('crashed collector retry uses a new bounded audit identity; an old late materialization cannot overwrite it',async()=>{
 await enable();const admitted=await requestGoalCheck(db.pool,config(),identity,goalId,{expected_version_id:versionId});const payload=(await db.pool.query('SELECT payload_json FROM jobs WHERE id=$1',[admitted.job_id])).rows[0].payload_json;
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
 const delayed:GoalExecutionPort={async execute(...args){enter();await held;return executor.execute(...args);}};
 const first=runSourceGoalTick(db.pool,config(),goalId,SPACE,delayed,versionId,payload.round_id);await entered;
 const before=await round(payload.round_id);const old=before.targets_json[0].audit_id;
 await db.pool.query("UPDATE source_goal_bindings SET lease_until=now()-interval '1 second' WHERE id=$1",[bindingId]);
 try{await runSourceGoalTick(db.pool,config(),goalId,SPACE,executor,versionId,payload.round_id);}finally{release();}
 await first;const current=await round(payload.round_id);expect(current.targets_json[0].audit_id).not.toBe(old);expect(current.targets_json[0].previous_audit_ids).toEqual([old]);
 const audit=(await db.pool.query('SELECT status FROM source_goal_runs WHERE id=$1',[current.targets_json[0].audit_id])).rows[0];expect(audit.status).toBe('insufficient');await settleThemeRound(db.pool,config(),payload.round_id);expect((await round(payload.round_id)).status).toBe('generating');
});
it('freezes purpose/method/context at collection admission and refuses changed context before any model',async()=>{
 await enable();const id=await collect(),r=await round(id);expect(r.execution_json.frozen_context.some((c:{kind:string})=>c.kind==='following_method')).toBe(true);
 const next=randomUUID();
 await db.pool.query("INSERT INTO project_brief_versions(id,space_id,project_id,version,goal,project_status,status,created_at) VALUES($1,$2,$3,'new-purpose','Changed current project goal','active','published',now())",[next,SPACE,PROJECT]);
 await db.pool.query('UPDATE projects SET active_brief_version_id=$2 WHERE id=$1',[PROJECT,next]);
 await settleThemeRound(db.pool,config(),id);expect((await round(id)).status).toBe('blocked');expect(await w.count('runs')).toBe(0);
});
it('cancelled analysis is not publication; explicit retry is bounded and late old settlement is ignored',async()=>{
 const {cancelThemeRound}=await import('../src/modules/informationDigest/topics/service.js');
 await enable();const id=await collect();await settleThemeRound(db.pool,config(),id);const r=await round(id),old=await w.runOf(r.briefing_id);
 await cancelThemeRound(db.pool,config(),identity,goalId,id);expect((await w.rowOf(r.briefing_id)).status).toBe('cancelled');
 await settleThemeRound(db.pool,config(),id,true);const next=await w.runOf(r.briefing_id);expect(next.id).not.toBe(old.id);expect((await w.rowOf(r.briefing_id)).attempt).toBe(2);
 await (await import('../src/modules/informationDigest/briefing/settlement.js')).settleBriefingRun(db.pool,old);expect((await w.rowOf(r.briefing_id)).run_id).toBe(next.id);
});

it('empty first collection is honestly empty and does not spend a model Run',async()=>{
 await db.pool.query('DELETE FROM source_goal_items WHERE goal_id=$1',[goalId]);empty=true;await enable();const id=await collect();await settleThemeRound(db.pool,config(),id);
 expect((await round(id)).status).toBe('complete');expect(await w.count('runs')).toBe(0);expect((await w.rowOf((await round(id)).briefing_id)).outcome).toBe('no_material');
});
it('late original beyond the closed boundary stays pending and is processed by a later round',async()=>{
 await db.pool.query('DELETE FROM source_snapshots WHERE source_item_id=$1',[itemId]);await db.pool.query("UPDATE source_items SET extracted_artifact_id=NULL,content_state='metadata_only',content_hash=NULL WHERE id=$1",[itemId]);
 await enable();const id=await collect();await db.pool.query("UPDATE project_reading_rounds SET deadline_at=now()-interval '1 second' WHERE id=$1",[id]);
 await settleThemeRound(db.pool,config(),id);expect((await round(id)).status).toBe('blocked');expect(await w.count('runs')).toBe(0);
 await original('Late original now genuinely retained');await settleThemeRound(db.pool,config(),id,true);expect(await w.count('runs')).toBe(0);
 await db.pool.query("UPDATE extraction_jobs SET status='succeeded' WHERE source_item_id=$1",[itemId]);
 const next=await collect();await settleThemeRound(db.pool,config(),next);expect((await round(next)).status).toBe('generating');expect((await w.runOf((await round(next)).briefing_id)).prompt).toContain('Late original');
});
it('current full audience gates original evidence; private analysis cannot make unavailable original ready',async()=>{
 await enable();const id=await collect();await db.pool.query("UPDATE source_connections SET access_level='summary' WHERE id=$1",[CONNECTION]);
 await settleThemeRound(db.pool,config(),id);expect(await w.count('runs')).toBe(0);const blocked=await w.rowOf((await round(id)).briefing_id);expect(blocked.coverage_json.complete).toBe(false);
 await db.pool.query("UPDATE source_connections SET access_level='full' WHERE id=$1",[CONNECTION]);
 const next=await collect();await settleThemeRound(db.pool,config(),next);expect((await round(next)).status).toBe('generating');
});
it('disabled runtime refuses admission without leaving an orphan queued version and can explicitly recover',async()=>{
 await enable();const id=await collect();await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[PROFILE]);
 await settleThemeRound(db.pool,config(),id);expect((await round(id)).status).toBe('blocked');expect(await w.count('information_briefings')).toBe(0);expect(await w.count('runs')).toBe(0);
 await db.pool.query('UPDATE agent_runtime_profiles SET enabled=true WHERE id=$1',[PROFILE]);await settleThemeRound(db.pool,config(),id,true);expect((await round(id)).status).toBe('generating');
});
it('worker SIGKILL recovery settles the failed attempt, explicit retry publishes once and late old Host completion cannot replace it',async()=>{
 await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
 await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic worker recovery fixture'});
 await enable();const id=await collect();await settleThemeRound(db.pool,config(),id);const r=await round(id),old=await w.runOf(r.briefing_id);
 const refs=(await db.pool.query("SELECT ref_key FROM information_briefing_inputs WHERE briefing_id=$1 AND status='included' ORDER BY ref_key",[r.briefing_id])).rows.map(x=>x.ref_key);
 await buildServerDist();worker=await startWorkerProcess({databaseUrl:db.connectionUri,home:root,hostId:HOST});const launch=await worker.next(isPrompted(old.id));await worker.kill();worker=undefined;
 // Only persisted lease time is accelerated; the worker itself really died.
 await db.pool.query("UPDATE jobs SET heartbeat_at=now()-interval '11 minutes',updated_at=now()-interval '11 minutes' WHERE payload_json->>'run_id'=$1",[old.id]);
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home:root,hostId:HOST});
 worker.send({cmd:'policy',terminate:'ack',prompt:{answer:JSON.stringify(outputValue({overview:{text:'Recovered original-based theme.',refs},topic:{quick_line:'Recovered theme',summary:'Original evidence remains traceable.',stop_reason:'Bounded fixture.'}}))}});
 expect((await worker.next(isFrame('terminate',old.id))).frame.launch_id).toBe(launch.launchId);
 expect((await until(()=>w.rowOf(r.briefing_id),x=>x.status!=='queued','recovered theme failure',150)).status).toBe('failed');
 await settleThemeRound(db.pool,config(),id,true);const next=await w.runOf(r.briefing_id);expect(next.id).not.toBe(old.id);
 expect((await until(()=>w.rowOf(r.briefing_id),x=>x.status==='ready','theme retry publication',150)).attempt).toBe(2);
 worker.send({cmd:'complete',runId:old.id,launchId:launch.launchId,exitCode:0});await settledCommands(worker);
 expect((await w.rowOf(r.briefing_id)).run_id).toBe(next.id);expect((await w.rowOf(r.briefing_id)).status).toBe('ready');
},60000);
it('an activated new purpose needs new consent and reassesses unchanged originals without relabeling old history',async()=>{
 await enable();const oldRound=await collect(),oldVersion=await publish(oldRound);await composeProjectReading(db.pool,SPACE,PROJECT,oldRound);const oldTotal=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;const next=randomUUID();
 await db.pool.query('INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_user_id) VALUES($1,$2,$3,2,$4,$5)',[next,SPACE,goalId,{title:'Failure mechanisms',summary:'New learning purpose',analysis_brief:'Evaluate failure modes rather than adoption',sources:[spec],limitations:[]},OWNER]);
 await db.pool.query('UPDATE source_goals SET current_version_id=$2,active_version_id=$2 WHERE id=$1',[goalId,next]);
 await expect(configureThemeAnalysis(db.pool,config(),identity,goalId,{expected_version_id:versionId,enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE})).rejects.toMatchObject({statusCode:409});
 await configureThemeAnalysis(db.pool,config(),identity,goalId,{expected_version_id:next,enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE});versionId=next;
 const id=await collect();await settleThemeRound(db.pool,config(),id);const row=await w.rowOf((await round(id)).briefing_id),run=await w.runOf(row.id);
 expect(row.context_hash).not.toBe((await w.rowOf(oldVersion)).context_hash);expect(row.coverage_json.context_changed).toBe(true);expect(run.prompt).toContain('Evaluate failure modes');expect(row.id).not.toBe(oldVersion);
 await expect(assertBriefingDispatch(config(),run,db.pool)).resolves.toBeUndefined();expect((await readThemeRounds(db.pool,identity,goalId)).latest?.id).toBe(oldVersion);
 const refs=(await db.pool.query("SELECT ref_key FROM information_briefing_inputs WHERE briefing_id=$1 AND status='included'",[row.id])).rows.map(x=>x.ref_key);
 const done=await w.finishRun(run.id,JSON.stringify(outputValue({overview:{text:'Reassessed under the newly confirmed purpose',refs},topic:{quick_line:'Same evidence, changed purpose',summary:'Reassessed, not new publication.',stop_reason:'No additional evidence.'}},'ongoing')));
 await new PostRunFinalizationService(new PgRunRepository(db.pool),undefined,undefined,undefined,runSettlement(config(),db.pool)).finalize(done.id,SPACE);
 expect((await readThemeRounds(db.pool,identity,goalId)).latest?.id).toBe(row.id);expect((await w.rowOf(oldVersion)).context_hash).not.toBe(row.context_hash);await composeProjectReading(db.pool,SPACE,PROJECT,id);expect((await readProjectComposition(db.pool,identity,PROJECT)).latest!.sections[0].purpose_version_id).toBe(next);expect((await readProjectComposition(db.pool,identity,PROJECT,oldTotal.id)).latest!.sections[0].purpose_version_id).not.toBe(next);
});

it('legacy content_saved from an Agent is not original readiness or an extraction dedup key',async()=>{
 await db.pool.query("UPDATE artifacts SET metadata_json=jsonb_set(metadata_json,'{extraction_method}','\"agent_provided_v1\"') WHERE id=(SELECT extracted_artifact_id FROM source_items WHERE id=$1)",[itemId]);
 expect((await db.pool.query('SELECT content_state FROM source_items WHERE id=$1',[itemId])).rows[0].content_state).toBe('content_saved');
 await enable();const id=await collect();expect((await db.pool.query("SELECT status FROM extraction_jobs WHERE source_item_id=$1 AND job_type='extract_text'",[itemId])).rows[0]).toMatchObject({status:'pending'});
 await settleThemeRound(db.pool,config(),id);expect((await round(id)).status).toBe('collecting');expect(await w.count('runs')).toBe(0);
});
it('theme publication uses the canonical Source fence: revocation-first denies, publication-lock-first makes the writer wait',async()=>{
 const {lockBriefingGenerationAuthority}=await import('../src/modules/runtimeContext/index.js');
 await enable();const id=await collect();await settleThemeRound(db.pool,config(),id);const r=await round(id),run=await w.runOf(r.briefing_id);
 const holder=await db.pool.connect(),writer=await db.pool.connect();let waiting:Promise<unknown>|undefined;
 try{
  await holder.query('BEGIN');await writer.query('BEGIN');const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await lockBriefingGenerationAuthority(holder,run);waiting=writer.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);
  expect(await until(async()=>Boolean((await db.pool.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[writerPid,holderPid])).rows[0].blocked),Boolean,'Source revoker blocked by theme fence',30)).toBe(true);
  await holder.query('COMMIT');await waiting;await writer.query('COMMIT');
 }finally{await holder.query('ROLLBACK');if(waiting)await waiting.catch(()=>{});await writer.query('ROLLBACK');holder.release();writer.release();}
 await expect(assertBriefingDispatch(config(),run,db.pool)).rejects.toMatchObject({statusCode:403});
 const refs=(await db.pool.query("SELECT ref_key FROM information_briefing_inputs WHERE briefing_id=$1 AND status='included'",[r.briefing_id])).rows.map(x=>x.ref_key);
 const terminal=await w.finishRun(run.id,JSON.stringify(outputValue({overview:{text:'Output after revocation must not publish',refs},topic:{quick_line:'Must not publish',summary:'Must not publish',stop_reason:'Fixture'}})));
 await new PostRunFinalizationService(new PgRunRepository(db.pool),undefined,undefined,undefined,runSettlement(config(),db.pool)).finalize(terminal.id,SPACE);
 expect((await w.rowOf(r.briefing_id)).status).toBe('failed');expect((await readThemeRounds(db.pool,identity,goalId)).latest).toBeNull();
});
it('HTTP consent and retry are real thin domain entries; readers cannot admit work and exports reauthorize',async()=>{
 const app=buildModuleServer(config(),[informationDigestModule]);
 try{
  __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});
  expect((await app.inject({method:'POST',url:`/api/v1/sources/goals/${goalId}/theme-analysis`,payload:{expected_version_id:versionId,enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE}})).statusCode).toBe(403);
  __setAuthIdentityForTests(identity);const enabled=await app.inject({method:'POST',url:`/api/v1/sources/goals/${goalId}/theme-analysis`,payload:{expected_version_id:versionId,enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE}});expect(enabled.statusCode,enabled.body).toBe(200);expect(await w.count('runs')).toBe(0);
  const id=await collect();await publish(id);const good=await app.inject({method:'GET',url:`/api/v1/sources/goals/${goalId}/theme-rounds/${id}/export`});expect(good.statusCode,good.body).toBe(200);expect(good.json().topic.quick_line).toBeTruthy();
  await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);
  const hidden=await app.inject({method:'GET',url:`/api/v1/sources/goals/${goalId}/theme-rounds/${id}/export`});expect(hidden.statusCode,hidden.body).toBe(200);expect(hidden.json().topic).toBeNull();expect(hidden.json().briefing.overview).toBeNull();
  __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});expect((await app.inject({method:'POST',url:`/api/v1/sources/goals/${goalId}/theme-rounds/retry`,payload:{round_id:id}})).statusCode).toBe(403);
 }finally{await app.close();}
});

it('invalid theme output fails closed; three explicit same-version attempts exhaust without a fourth Run or fake no-new',async()=>{
 await enable();const id=await collect();
 for(let attempt=1;attempt<=3;attempt++){
  await settleThemeRound(db.pool,config(),id,attempt>1);const r=await round(id),run=await w.runOf(r.briefing_id);expect((await w.rowOf(r.briefing_id)).attempt).toBe(attempt);
  const terminal=await w.finishRun(run.id,JSON.stringify(outputValue())); // Valid generic briefing is not a valid theme contract.
  await new PostRunFinalizationService(new PgRunRepository(db.pool),undefined,undefined,undefined,runSettlement(config(),db.pool)).finalize(terminal.id,SPACE);
  expect((await w.rowOf(r.briefing_id)).status).toBe('failed');
 }
 await settleThemeRound(db.pool,config(),id,true);expect(await w.count('runs')).toBe(3);expect(await round(id)).toMatchObject({status:'blocked',error_code:'briefing_attempts_exhausted'});expect((await readThemeRounds(db.pool,identity,goalId)).latest).toBeNull();
});

it('a delayed older barrier cannot spend or replace an already published newer round',async()=>{
 await enable();const older=await collect(),newer=await collect();const published=await publish(newer),before=await w.count('runs');
 await original('A change after the newer round publication');await settleThemeRound(db.pool,config(),older);
 expect(await round(older)).toMatchObject({status:'superseded',error_code:'theme_round_superseded'});expect(await w.count('runs')).toBe(before);expect((await readThemeRounds(db.pool,identity,goalId)).latest?.id).toBe(published);
});

it('execution config is frozen at collection admission, strict at dispatch, and never a historical read-authority substitute',async()=>{
 await enable();const id=await collect();await db.pool.query('UPDATE agent_runtime_profiles SET runtime_config_json=$2 WHERE id=$1',[PROFILE,{fixture_mode:'changed'}]);
 await settleThemeRound(db.pool,config(),id);expect(await round(id)).toMatchObject({status:'blocked',error_code:'theme_execution_changed'});expect(await w.count('runs')).toBe(0);
 const fresh=await collect();await settleThemeRound(db.pool,config(),fresh);const r=await round(fresh),run=await w.runOf(r.briefing_id);
 await db.pool.query('UPDATE agent_runtime_profiles SET runtime_config_json=$2 WHERE id=$1',[PROFILE,{fixture_mode:'changed_again'}]);await expect(assertBriefingDispatch(config(),run,db.pool)).rejects.toMatchObject({code:'theme_execution_changed'});
 await db.pool.query('UPDATE agent_runtime_profiles SET runtime_config_json=$2 WHERE id=$1',[PROFILE,{fixture_mode:'changed'}]);await publish(fresh);
 await db.pool.query('UPDATE agent_runtime_profiles SET runtime_config_json=$2 WHERE id=$1',[PROFILE,{fixture_mode:'history_drift'}]);expect((await readThemeRounds(db.pool,identity,goalId)).latest?.visibility).toBe('visible');
});
it('generic Run detail/list cannot bypass theme Source withdrawal; ordinary config drift does not hide historical output',async()=>{
 await enable();const id=await collect();await publish(id);const run=await w.runOf((await round(id)).briefing_id),repo=new PgRunRepository(db.pool);
 expect(await repo.getVisibleRun(SPACE,OWNER,run.id)).not.toBeNull();
 await db.pool.query('UPDATE agent_runtime_profiles SET runtime_config_json=$2 WHERE id=$1',[PROFILE,{fixture_history:'new_config'}]);expect(await repo.getVisibleRun(SPACE,OWNER,run.id)).not.toBeNull();
 await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);expect(await repo.getVisibleRun(SPACE,OWNER,run.id)).toBeNull();
 expect((await repo.listRuns({space_id:SPACE,user_id:OWNER,limit:50,offset:0})).some(r=>r.id===run.id)).toBe(false);
 await db.pool.query("UPDATE source_connections SET capture_policy='extract_text' WHERE id=$1",[CONNECTION]);expect(await repo.getVisibleRun(SPACE,OWNER,run.id)).not.toBeNull();
});

async function changedThemeMethod(text:string){
 const base=(await db.pool.query("SELECT v.* FROM evolvable_asset_versions v JOIN evolvable_assets a ON a.id=v.asset_id WHERE a.asset_key='reading.following_synthesis' ORDER BY v.version DESC LIMIT 1")).rows[0];const id=randomUUID();
 const content={...base.content_json,template:text};
 await db.pool.query(`INSERT INTO evolvable_asset_versions(id,asset_id,scope_type,scope_id,version,status,source,content_json,content_hash,created_at,updated_at) VALUES($1,$2,'system',NULL,$3,'approved',$4,$5,$6,now(),now())`,[id,base.asset_id,base.version+1,base.source,content,createHash('sha256').update(JSON.stringify(content)).digest('hex')]);
 await db.pool.query('UPDATE prompt_deployment_refs SET version_id=$2 WHERE asset_id=$1 AND status=\'active\'',[base.asset_id,id]);
}
for(const broken of ['missing','disabled','oversized'] as const)it(`F1 ${broken} analysis method does not block manual or multi-group scheduled collection`,async()=>{
 await enable();if(broken==='missing')await db.pool.query("UPDATE evolvable_assets SET asset_key='fixture.missing_theme' WHERE asset_key='reading.following_synthesis'");else if(broken==='disabled')await db.pool.query("UPDATE evolvable_assets SET status='disabled' WHERE asset_key='reading.following_synthesis'");else await changedThemeMethod('Valid text strategy. '.repeat(260));
 const personal=randomUUID();await db.pool.query(`INSERT INTO source_goals(id,space_id,owner_user_id,intent_json,budget_json,status) VALUES($1,$2,$3,'{"intent":"Independent personal collection"}','{"interval_seconds":86400}','running')`,[personal,SPACE,OWNER]);
 for(const id of [goalId,personal])await new PgSchedulerTaskStore(db.pool).upsert({taskType:'source_goal_tick',taskKey:id,scopeType:'space',scopeId:SPACE,spaceId:SPACE,userId:OWNER,nextRunAt:new Date(Date.now()-2000).toISOString(),metadataJson:{}});
 await enqueueDueSourceGoals(db.pool);
 for(const id of [goalId,personal]){expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='source_goal_tick' AND payload_json->>'goal_id'=$1",[id])).rows).toHaveLength(1);expect(Date.parse(String((await new PgSchedulerTaskStore(db.pool).get('source_goal_tick',id))?.next_run_at))).toBeGreaterThan(Date.now());}
 expect(await w.count('project_reading_rounds')).toBe(0);expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='project_reading_theme'")).rows).toHaveLength(0);expect(await w.count('runs')).toBe(0);
 expect((await readThemeRounds(db.pool,identity,goalId)).analysis_admission).toMatchObject({status:'blocked'});
 await db.pool.query("UPDATE jobs SET status='completed' WHERE job_type='source_goal_tick'");const manual=await requestGoalCheck(db.pool,config(),identity,goalId,{expected_version_id:versionId});expect(manual.status).toBe('queued');expect((await db.pool.query('SELECT payload_json FROM jobs WHERE id=$1',[manual.job_id])).rows[0].payload_json.round_id).toBeUndefined();
 const performed=await runSourceGoalTick(db.pool,config(),goalId,SPACE,executor,versionId);expect(performed).toMatchObject({results:[{status:'succeeded'}]});expect(await w.count('runs')).toBe(0);
 await db.pool.query("UPDATE jobs SET status='completed' WHERE job_type='source_goal_tick'");await syncBuiltinPrompts(db.pool,config().catalogRoot,['reading.following_synthesis']);await db.pool.query("UPDATE evolvable_assets SET status='active' WHERE asset_key='reading.following_synthesis'");const restored=await collect();expect((await readThemeRounds(db.pool,identity,goalId)).analysis_admission).toBeNull();await publish(restored);expect((await readThemeRounds(db.pool,identity,goalId)).latest?.topic).toBeTruthy();
});
it('F2 only collection coverage changing reuses published theme, while a real method change still reassesses',async()=>{
 const other=randomUUID(),channel=randomUUID(),binding=randomUUID();await w.addSource(other,channel,'Second source',{allow_external_model_egress:true,allow_local_provider_egress:true});await db.pool.query('UPDATE source_connections SET project_id=$2 WHERE id=$1',[other,PROJECT]);
 const second={...spec,source_connection_id:other,source_channel_id:channel};const source=await goalSourceRow(db.pool,SPACE,second);await db.pool.query('INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json,fixture_json) VALUES($1,$2,$3,$4,$5,$6)',[binding,SPACE,goalId,other,second,{authority_sha256:goalSourceFingerprint(source!)}]);
 let failing=true;const port:GoalExecutionPort={async execute(...args){if(args[2].source_connection_id===other){if(failing)throw new Error('source_network_failed');const result=await executor.execute(...args);return {...result,output:{contract_version:'custom_source.handler_output.v1',items:[]}};}return executor.execute(...args);}};
 async function next(){const q=await requestGoalCheck(db.pool,config(),identity,goalId,{expected_version_id:versionId});const p=(await db.pool.query('SELECT payload_json FROM jobs WHERE id=$1',[q.job_id])).rows[0].payload_json;await runSourceGoalTick(db.pool,config(),goalId,SPACE,port,versionId,p.round_id);await db.pool.query("UPDATE jobs SET status='completed' WHERE id=$1",[q.job_id]);return p.round_id as string;}
 await enable();const first=await next(),published=await publish(first),before=await w.count('runs');const frozenPublished=await w.rowOf(published);expect((await round(first)).coverage_json.failed_sources).toBe(1);
 failing=false;await db.pool.query("UPDATE source_goal_bindings SET retry_at=NULL WHERE id=$1",[binding]);const secondRound=await next();await settleThemeRound(db.pool,config(),secondRound);
 expect(await w.count('runs')).toBe(before);expect((await readThemeRounds(db.pool,identity,goalId)).latest?.id).toBe(published);expect((await round(secondRound)).coverage_json).toMatchObject({failed_sources:0,complete:true});expect((await w.rowOf(published)).result_json).toEqual(frozenPublished.result_json);expect((await w.rowOf(published)).completed_at).toEqual(frozenPublished.completed_at);
 await changedThemeMethod('Reassess mechanisms and contradictions against the authorized purpose; return the required complete theme JSON.');const third=await next();await settleThemeRound(db.pool,config(),third);expect(await w.count('runs')).toBe(before+1);expect((await w.runOf((await round(third)).briefing_id)).prompt).toContain('Reassess mechanisms');
});

it('F1 an unexpected PostgreSQL cohort failure is reported after independent groups still advance',async()=>{
 const normal=randomUUID();await db.pool.query(`INSERT INTO source_goals(id,space_id,owner_user_id,intent_json,budget_json,status) VALUES($1,$2,$3,'{"intent":"Independent collection"}','{"interval_seconds":86400}','running')`,[normal,SPACE,OWNER]);
 for(const id of [goalId,normal])await new PgSchedulerTaskStore(db.pool).upsert({taskType:'source_goal_tick',taskKey:id,scopeType:'space',scopeId:SPACE,spaceId:SPACE,userId:OWNER,nextRunAt:new Date(Date.now()-2000).toISOString(),metadataJson:{}});
 // Real DB write refusal, confined to this disposable fixture. No SQL mock.
 await db.pool.query(`CREATE FUNCTION fixture_refuse_goal_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_type='source_goal_tick' AND NEW.payload_json->>'goal_id'='${goalId}' THEN RAISE EXCEPTION 'synthetic cohort storage refusal' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_refuse_goal_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION fixture_refuse_goal_job()`);
 try{
  await expect(enqueueDueSourceGoals(db.pool)).rejects.toThrow('Source goal collection admission');
  expect((await db.pool.query("SELECT id FROM jobs WHERE payload_json->>'goal_id'=$1",[normal])).rows).toHaveLength(1);
  expect(Date.parse(String((await new PgSchedulerTaskStore(db.pool).get('source_goal_tick',normal))?.next_run_at))).toBeGreaterThan(Date.now());
  expect(Date.parse(String((await new PgSchedulerTaskStore(db.pool).get('source_goal_tick',goalId))?.next_run_at))).toBeLessThan(Date.now());
 }finally{await db.pool.query('DROP TRIGGER fixture_refuse_goal_job ON jobs; DROP FUNCTION fixture_refuse_goal_job()');}
});

// Stage-two tests use the same real collection, original writer and canonical
// theme settlement fixtures as stage one; no synthetic successful briefing rows.

async function anotherTheme(){
 const prior={goalId,versionId,bindingId};goalId=randomUUID();versionId=randomUUID();bindingId=randomUUID();
 await db.pool.query(`INSERT INTO source_goals(id,space_id,project_id,owner_user_id,agent_id,runtime_profile_id,intent_json,budget_json,status,active_version_id,compatibility_json) SELECT $2,space_id,project_id,owner_user_id,agent_id,runtime_profile_id,intent_json,budget_json,status,$3,'{}' FROM source_goals WHERE id=$1`,[prior.goalId,goalId,versionId]);
 await db.pool.query(`INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_user_id) SELECT $2,space_id,$3,1,plan_json,created_by_user_id FROM source_goal_versions WHERE id=$1`,[prior.versionId,versionId,goalId]);
 await db.pool.query(`INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json,fixture_json) SELECT $2,space_id,$3,source_connection_id,spec_json,fixture_json FROM source_goal_bindings WHERE id=$1`,[prior.bindingId,bindingId,goalId]);
 return prior;
}
async function compositionCount(){return Number((await db.pool.query('SELECT count(*) AS n FROM project_reading_compositions')).rows[0].n);}
it('composition keeps independent immutable versions and manual patches preserve other section identity, order and time',async()=>{
 await enable();const a=await collect();await publish(a);await composeProjectReading(db.pool,SPACE,PROJECT,a);
 const first=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;expect(first.sections).toHaveLength(1);const aSection=first.sections[0];
 const prior=await anotherTheme();await enable();const b=await collect();await publish(b);await composeProjectReading(db.pool,SPACE,PROJECT,b);
 const second=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;expect(second.sections[0]).toEqual(aSection);expect(second.sections).toHaveLength(2);
 const bIdentity={goalId,versionId,bindingId};await anotherTheme();await enable();const c=await collect();await publish(c);await composeProjectReading(db.pool,SPACE,PROJECT,c);const cSection=(await readProjectComposition(db.pool,identity,PROJECT)).latest!.sections[2];
 ({goalId,versionId,bindingId}=bIdentity);
 await changedThemeMethod('Synthesize mechanisms with explicit limitations and independent counter-evidence for this purpose.');const b2=await collect();await publish(b2,'ongoing');await composeProjectReading(db.pool,SPACE,PROJECT,b2);
 const latest=await readProjectComposition(db.pool,identity,PROJECT);expect(latest.latest!.sections[0]).toEqual(aSection);expect(latest.latest!.sections[1].briefing_id).not.toBe(second.sections[1].briefing_id);expect(latest.latest!.sections[2]).toEqual(cSection);expect(latest.latest!.sections.map(s=>s.goal_id)).toEqual([aSection.goal_id,bIdentity.goalId,cSection.goal_id]);
 expect((await readProjectComposition(db.pool,identity,PROJECT,first.id)).latest!.sections).toEqual(first.sections);
 const n=await compositionCount(),runs=await w.count('runs');await composeProjectReading(db.pool,SPACE,PROJECT,b);await composeProjectReading(db.pool,SPACE,PROJECT,b2);expect(await compositionCount()).toBe(n);expect(await w.count('runs')).toBe(runs);expect(prior.goalId).toBe(aSection.goal_id);
});
it('scheduled cohort waits for every frozen target, then combines themes once; concurrent manual patches do not lose either update',async()=>{
 await enable();const aGoal=goalId,aVersion=versionId;await anotherTheme();await enable();const bGoal=goalId;
 for(const [id,v] of [[aGoal,aVersion],[bGoal,versionId]])await new PgSchedulerTaskStore(db.pool).upsert({taskType:'source_goal_tick',taskKey:id,scopeType:'space',scopeId:SPACE,spaceId:SPACE,userId:OWNER,nextRunAt:new Date(Date.now()-1000).toISOString(),metadataJson:{version_id:v}});
 await enqueueDueSourceGoals(db.pool);const admitted=(await db.pool.query('SELECT * FROM project_reading_rounds ORDER BY goal_id')).rows;
 expect(admitted).toHaveLength(2);expect(admitted[0].slot_key).toBe(admitted[1].slot_key);
 for(const r of admitted)await runSourceGoalTick(db.pool,config(),r.goal_id,SPACE,executor,r.version_id,r.id);
 await db.pool.query("UPDATE jobs SET status='completed' WHERE job_type='source_goal_tick'");
 await publish(admitted[0].id);expect(await composeProjectReading(db.pool,SPACE,PROJECT,admitted[0].id)).toBeNull();expect(await compositionCount()).toBe(0);
 await publish(admitted[1].id);await Promise.all(admitted.map(r=>composeProjectReading(db.pool,SPACE,PROJECT,r.id)));expect(await compositionCount()).toBe(1);expect((await readProjectComposition(db.pool,identity,PROJECT)).latest!.sections).toHaveLength(2);
 await changedThemeMethod('Second approved strategy with explicit counter-evidence and limitations.');
 const updates:string[]=[];
 for(const r of admitted){goalId=r.goal_id;versionId=r.version_id;updates.push(await collect());await publish(updates.at(-1)!,'ongoing');}
 const held=await db.pool.connect(),one=await db.pool.connect(),two=await db.pool.connect();
 let requests:Promise<unknown>[]=[];
 try{
  await held.query('BEGIN');await one.query('BEGIN');await two.query('BEGIN');
  const pid=(await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const pids=await Promise.all([one,two].map(async c=>(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
  await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`project-reading:${SPACE}:${PROJECT}`]);
  requests=[one,two].map((c,i)=>(async()=>{await composeProjectReading(c,SPACE,PROJECT,updates[i]);await c.query('COMMIT');})());
  await until(async()=>Number((await db.pool.query('SELECT count(*)::int AS n FROM unnest($1::int[]) p WHERE $2::int=ANY(pg_blocking_pids(p))',[pids,pid])).rows[0].n),n=>n===2,'both patch writers blocked by Project fence',40);
  await held.query('COMMIT');await Promise.all(requests);
 }finally{await held.query('ROLLBACK');held.release();await Promise.allSettled(requests);for(const c of [one,two]){await c.query('ROLLBACK');c.release();}}
 const total=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;
 for(const id of updates)expect(total.sections.find(s=>s.round_id===id)?.briefing_id).toBe((await round(id)).briefing_id);
 const count=await compositionCount();await composeProjectReading(db.pool,SPACE,PROJECT,admitted[0].id);expect(await compositionCount()).toBe(count);

});
it('one admitted collection and analysis publishes exactly one version; a later analysis publishes the next',async()=>{
 await enable();const id=await collect();
 expect(await compositionCount()).toBe(0);expect(await composeProjectReading(db.pool,SPACE,PROJECT,id)).toBeNull();
 await settleThemeRound(db.pool,config(),id);
 const preparing=await readProjectComposition(db.pool,identity,PROJECT);
 expect(preparing.latest).toBeNull();expect(preparing.history).toEqual([]);expect(preparing.rounds[0].status).toBe('generating');
 expect(await composeProjectReading(db.pool,SPACE,PROJECT,id)).toBeNull();
 await publish(id);await Promise.all([composeProjectReading(db.pool,SPACE,PROJECT,id),composeProjectReading(db.pool,SPACE,PROJECT,id)]);
 const first=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;
 expect(first.day_revision).toBe(1);expect(await compositionCount()).toBe(1);
 expect((await db.pool.query("SELECT payload_json FROM jobs WHERE job_type='project_reading_compose'")).rows.every(j=>typeof j.payload_json.round_id==='string'&&!j.payload_json.edition)).toBe(true);
 await changedThemeMethod('Reassess the authorized evidence with independent counter-evidence and explain limitations.');
 const next=await collect();await settleThemeRound(db.pool,config(),next);
 expect(await composeProjectReading(db.pool,SPACE,PROJECT,next)).toBeNull();
 expect((await readProjectComposition(db.pool,identity,PROJECT)).latest!.id).toBe(first.id);
 await publish(next,'ongoing');await composeProjectReading(db.pool,SPACE,PROJECT,next);
 expect((await readProjectComposition(db.pool,identity,PROJECT)).latest!.day_revision).toBe(2);expect(await compositionCount()).toBe(2);
 expect((await readProjectComposition(db.pool,identity,PROJECT,first.id)).latest).toEqual(first);
});

it('publishes only a new analysis body; empty, no-new and failed checks stay execution state',async()=>{
 await enable();empty=true;await db.pool.query('DELETE FROM source_goal_items WHERE goal_id=$1',[goalId]);const e=await collect();await settleThemeRound(db.pool,config(),e);await composeProjectReading(db.pool,SPACE,PROJECT,e);expect(await compositionCount()).toBe(0);
 expect((await readProjectComposition(db.pool,identity,PROJECT)).latest).toBeNull();
 empty=false;const a=await collect();await publish(a);await composeProjectReading(db.pool,SPACE,PROJECT,a);const before=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;
 const noNew=await collect();await settleThemeRound(db.pool,config(),noNew);const runs=await w.count('runs');await composeProjectReading(db.pool,SPACE,PROJECT,noNew);expect(await w.count('runs')).toBe(runs);expect(await compositionCount()).toBe(1);
 fail=true;const failed=await collect();await settleThemeRound(db.pool,config(),failed);await composeProjectReading(db.pool,SPACE,PROJECT,failed);const shown=await readProjectComposition(db.pool,identity,PROJECT);expect(shown.latest).toEqual(before);expect(shown.rounds[0].status).toBe('blocked');expect(await compositionCount()).toBe(1);
});
it('composition history and export hide revoked Source segments and enforce Project scope without writes',async()=>{
 await enable();const a=await collect();await publish(a);await composeProjectReading(db.pool,SPACE,PROJECT,a);const first=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;
 const before=await w.count('runs');await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);const hidden=await readProjectComposition(db.pool,identity,PROJECT,first.id);expect(hidden.latest!.sections[0]).toMatchObject({visibility:'withheld',briefing:null});expect(JSON.stringify(hidden)).not.toContain('Evidence identifies');
 const app=buildModuleServer(config(),[informationDigestModule]);__setAuthIdentityForTests(identity);try{const response=await app.inject({method:'GET',url:`/api/v1/spaces/${SPACE}/projects/${PROJECT}/reading-compositions/${first.id}/export`});expect(response.statusCode,response.body).toBe(200);expect(response.json().latest.sections[0].briefing).toBeNull();const wrong=await app.inject({method:'GET',url:`/api/v1/spaces/${SPACE}/projects/${randomUUID()}/reading-compositions/${first.id}/export`});expect(wrong.statusCode).toBe(404);}finally{await app.close();}
 expect(await w.count('runs')).toBe(before);await db.pool.query("UPDATE source_connections SET capture_policy='extract_text' WHERE id=$1",[CONNECTION]);expect((await readProjectComposition(db.pool,identity,PROJECT)).latest!.sections[0].visibility).toBe('visible');
 await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allow_external_model_egress":false}'::jsonb WHERE id=$1`,[CONNECTION]);expect((await readProjectComposition(db.pool,identity,PROJECT,first.id)).latest!.sections[0].briefing).toBeNull();
 await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allow_external_model_egress":true}'::jsonb WHERE id=$1`,[CONNECTION]);expect((await readProjectComposition(db.pool,identity,PROJECT,first.id)).latest!.sections[0].visibility).toBe('visible');
 await db.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[PROJECT,MEMBER]);await expect(readProjectComposition(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT,first.id)).rejects.toMatchObject({statusCode:404});
 await db.pool.query("UPDATE source_goals SET status='paused' WHERE id=$1",[goalId]);expect((await readProjectComposition(db.pool,identity,PROJECT,first.id)).latest!.sections[0].visibility).toBe('visible');expect((await readProjectComposition(db.pool,identity,PROJECT)).latest!.sections).toHaveLength(1);
});
it('composition storage failure retries only the second stage, preserving the first-stage output and Run count',async()=>{
 await enable();const a=await collect();await publish(a);const runs=await w.count('runs');
 await db.pool.query(`CREATE FUNCTION reject_composition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture disk failure'; END $$; CREATE TRIGGER reject_composition BEFORE INSERT ON project_reading_compositions FOR EACH ROW EXECUTE FUNCTION reject_composition()`);
 try{await expect(composeProjectReading(db.pool,SPACE,PROJECT,a)).rejects.toThrow('fixture disk failure');}finally{await db.pool.query('DROP TRIGGER reject_composition ON project_reading_compositions; DROP FUNCTION reject_composition()');}
 expect(await compositionCount()).toBe(0);await composeProjectReading(db.pool,SPACE,PROJECT,a);expect(await compositionCount()).toBe(1);expect(await w.count('runs')).toBe(runs);expect((await readProjectComposition(db.pool,identity,PROJECT)).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});


it('Goal deletion withholds the segment without manufacturing a new content version',async()=>{
 const {SourceGoalService}=await import('../src/modules/sources/goals/service.js');
 await enable();const a=await collect();await publish(a);await composeProjectReading(db.pool,SPACE,PROJECT,a);const old=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;
 await new SourceGoalService(db.pool,config(),executor).stop(identity,goalId,true);
 expect((await readProjectComposition(db.pool,identity,PROJECT,old.id)).latest!.sections[0].briefing).toBeNull();
 expect((await readProjectComposition(db.pool,identity,PROJECT)).latest!.sections[0].visibility).toBe('withheld');expect(await compositionCount()).toBe(1);
 expect((await db.pool.query('SELECT sections_json FROM project_reading_compositions WHERE id=$1',[old.id])).rows[0].sections_json[0].briefing_id).toBe(old.sections[0].briefing_id);
});
it('cancelled analysis records a blocked check and retains the last successful section',async()=>{
 expect((await readProjectComposition(db.pool,identity,PROJECT)).latest).toBeNull();await enable();
 const a=await collect();await publish(a);await composeProjectReading(db.pool,SPACE,PROJECT,a);const old=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;
 await changedThemeMethod('Reassess mechanisms and contradictions against the authorized purpose; return the required complete theme JSON with explicit limitations.');const b=await collect();await settleThemeRound(db.pool,config(),b);
 const {cancelThemeRound}=await import('../src/modules/informationDigest/topics/service.js');await cancelThemeRound(db.pool,config(),identity,goalId,b);await composeProjectReading(db.pool,SPACE,PROJECT,b);
 expect((await readProjectComposition(db.pool,identity,PROJECT)).latest!.sections).toEqual(old.sections);expect((await readProjectComposition(db.pool,identity,PROJECT)).rounds[0].status).toBe('blocked');
});

it.each(['pause','disable'] as const)('preserves %s theme history through a real no-new check without rerunning the model or changing other sections',async mode=>{
 const {SourceGoalService}=await import('../src/modules/sources/goals/service.js');
 await enable();const a=await collect();await publish(a);await composeProjectReading(db.pool,SPACE,PROJECT,a);
 await anotherTheme();await enable();const bIdentity={goalId,versionId,bindingId};const b=await collect();const published=await publish(b);await composeProjectReading(db.pool,SPACE,PROJECT,b);
 await anotherTheme();await enable();const c=await collect();await publish(c);await composeProjectReading(db.pool,SPACE,PROJECT,c);
 const originalTotal=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;
 const originalRefs=(await db.pool.query('SELECT sections_json FROM project_reading_compositions WHERE id=$1',[originalTotal.id])).rows[0].sections_json;
 const oldB=originalTotal.sections[1];({goalId,versionId,bindingId}=bIdentity);
 const goals=new SourceGoalService(db.pool,config(),executor);
 if(mode==='pause')await goals.stop(identity,goalId);else await configureThemeAnalysis(db.pool,config(),identity,goalId,{expected_version_id:versionId,enabled:false});
 const withdrawn=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;expect(withdrawn.sections).toEqual(originalTotal.sections);
 if(mode==='pause')await goals.resume(identity,goalId,versionId);
 await enable();const runCount=await w.count('runs'),check=await collect();await settleThemeRound(db.pool,config(),check);
 const checked=await round(check),noNew=await w.rowOf(checked.briefing_id);expect(checked.status).toBe('complete');expect(noNew).toMatchObject({status:'ready',outcome:'no_new_material',result_json:null});
 await composeProjectReading(db.pool,SPACE,PROJECT,check);
 const restored=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;
 expect(restored.id).toBe(withdrawn.id);expect(restored.sections).toEqual(withdrawn.sections);
 expect(restored.sections.find(s=>s.goal_id===goalId)).toMatchObject({briefing_id:published,purpose_version_id:oldB.purpose_version_id,published_at:oldB.published_at,visibility:'visible'});
 expect(await w.count('runs')).toBe(runCount);
 expect((await db.pool.query('SELECT sections_json FROM project_reading_compositions WHERE id=$1',[originalTotal.id])).rows[0].sections_json).toEqual(originalRefs);
 const n=await compositionCount();await composeProjectReading(db.pool,SPACE,PROJECT,check);expect(await compositionCount()).toBe(n);
});

it.each(['capture','egress','project'] as const)('a no-new check cannot copy an unattached report; its original publication rechecks %s authority',async gate=>{
 await enable();const first=await collect(),published=await publish(first);const originalRow=await w.rowOf(published);const before=await w.count('runs');
 // The theme exists, but publication was not yet incorporated in a total.
 const check=await collect();await settleThemeRound(db.pool,config(),check);const r=await round(check);expect(r.status).toBe('complete');expect(await w.rowOf(r.briefing_id)).toMatchObject({outcome:'no_new_material',result_json:null,previous_briefing_id:published});
 const authority=async(allowed:boolean)=>{
  if(gate==='capture')await db.pool.query('UPDATE source_connections SET capture_policy=$2 WHERE id=$1',[CONNECTION,allowed?'extract_text':'reference_only']);
  else if(gate==='egress')await db.pool.query('UPDATE source_connections SET consent_json=consent_json||$2::jsonb WHERE id=$1',[CONNECTION,JSON.stringify({allow_external_model_egress:allowed})]);
  else await db.pool.query('UPDATE projects SET deleted_at=$2 WHERE id=$1',[PROJECT,allowed?null:new Date().toISOString()]);
 };
 await authority(false);await composeProjectReading(db.pool,SPACE,PROJECT,check);
 expect(await compositionCount()).toBe(0);
 if(gate==='project')await expect(readProjectComposition(db.pool,identity,PROJECT)).rejects.toMatchObject({statusCode:404});
 await authority(true);await composeProjectReading(db.pool,SPACE,PROJECT,check);expect(await compositionCount()).toBe(0);await composeProjectReading(db.pool,SPACE,PROJECT,first);
 const total=(await readProjectComposition(db.pool,identity,PROJECT)).latest!;expect(total.sections[0]).toMatchObject({briefing_id:published,purpose_version_id:versionId,published_at:new Date(originalRow.completed_at!).toISOString(),visibility:'visible'});
 expect(await w.count('runs')).toBe(before);const n=await compositionCount();await composeProjectReading(db.pool,SPACE,PROJECT,check);expect(await compositionCount()).toBe(n);
});

it('private deep operations do not delay or disclose into the shared original barrier',async()=>{
 const {startDeepReading}=await import('../src/modules/sources/deepReading/service.js');
 await syncBuiltinPrompts(db.pool,config().catalogRoot,['reading.project_investigation']);await enable();const id=await collect();
 await startDeepReading(db.pool,config(),identity,PROJECT,itemId,{agent_id:AGENT,runtime_profile_id:PROFILE});
 await settleThemeRound(db.pool,config(),id);expect((await round(id)).briefing_id).toBeTruthy();expect((await round(id)).coverage_json).toMatchObject({pending_originals:0,complete:true});
});
it('queue_content creates a deterministic job beside private deep work and legacy null-metadata original jobs still block',async()=>{
 const {startDeepReading}=await import('../src/modules/sources/deepReading/service.js');const {PgSourcesRepository}=await import('../src/modules/sources/repository.js');const repo=new PgSourcesRepository(db.pool,config());
 await syncBuiltinPrompts(db.pool,config().catalogRoot,['reading.project_investigation']);await enable();const id=await collect();
 await startDeepReading(db.pool,config(),identity,PROJECT,itemId,{agent_id:AGENT,runtime_profile_id:PROFILE});
 await repo.itemAction(identity,itemId,{action:'queue_content'});
 const originals=(await db.pool.query("SELECT id FROM extraction_jobs WHERE source_item_id=$1 AND job_type='extract_text' AND NOT COALESCE(metadata_json ? 'deep_project',false)",[itemId])).rows;expect(originals).toHaveLength(1);
 await db.pool.query('UPDATE extraction_jobs SET metadata_json=NULL WHERE id=$1',[originals[0].id]);
 await repo.itemAction(identity,itemId,{action:'queue_content'});expect(Number((await db.pool.query("SELECT count(*) n FROM extraction_jobs WHERE source_item_id=$1 AND NOT COALESCE(metadata_json ? 'deep_project',false)",[itemId])).rows[0].n)).toBe(1);
 await settleThemeRound(db.pool,config(),id);expect((await round(id)).status).toBe('collecting');
 await db.pool.query("UPDATE project_reading_rounds SET deadline_at=now()-interval '1 second' WHERE id=$1",[id]);await settleThemeRound(db.pool,config(),id);expect((await round(id)).coverage_json).toMatchObject({pending_originals:1,complete:false});
});

it('exact analysis consent freezes advertised model and mode into the theme Run without changing other consumers',async()=>{
 const options=[{id:'model',type:'select',category:'model',name:'Model',current_value:'m1',options:[{value:'m1',name:'one'},{value:'m2',name:'two'}]},{id:'mode',type:'select',category:'mode',name:'Mode',current_value:'review',options:[{value:'review',name:'Review'}]}];
 await db.pool.query('UPDATE hosts SET capabilities_json=$2 WHERE id=$1',[HOST,{runtimes:['claude_code'],versions:{claude_code:'fixture'},installations:{claude_code:[{id:'own',version:'fixture',logged_in:true,options:{session_available:true,config_options:options},health_check_protocol:'acp'}]}}]);
 const session_config=[{id:'model',type:'select',category:'model',value:'m2'},{id:'mode',type:'select',category:'mode',value:'review'}];
 await configureThemeAnalysis(db.pool,config(),identity,goalId,{expected_version_id:versionId,enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE,session_config});const id=await collect();await settleThemeRound(db.pool,config(),id);const run=await w.runOf((await round(id)).briefing_id);expect((run.model_override_json as {acp_session_config:unknown}).acp_session_config).toEqual(session_config);
 await expect(configureThemeAnalysis(db.pool,config(),identity,goalId,{expected_version_id:versionId,enabled:true,agent_id:AGENT,runtime_profile_id:PROFILE,session_config:[{...session_config[0],value:'not-advertised'}]})).rejects.toBeTruthy();
});

it('publishes meaningful Following theme changes through the existing private aggregate notification',async()=>{
 await enable();await publish(await collect());
 await db.pool.query("UPDATE activity_records SET status='processed' WHERE payload_json->>'pointer_type'='following_updates'");
 await original('Revised mechanism with new independent evidence and changed limitations.');
 const next=await collect();const briefing=await publish(next,'update');
 const row=await w.rowOf(briefing);expect(row.status).toBe('ready');
 const notices=(await db.pool.query("SELECT * FROM activity_records WHERE payload_json->>'pointer_type'='following_updates' ORDER BY user_id")).rows;
 expect(notices.map(n=>n.user_id).sort()).toEqual([OWNER,MEMBER].sort());
 expect(notices.every(n=>n.visibility==='private'&&n.project_id===null&&n.status==='raw'&&n.payload_json.goal_id===goalId&&n.payload_json.briefing_id===briefing)).toBe(true);
 await db.pool.query("UPDATE activity_records SET status='processed' WHERE payload_json->>'pointer_type'='following_updates'");
 await settleThemeRound(db.pool,config(),next);
 expect((await db.pool.query("SELECT status FROM activity_records WHERE payload_json->>'pointer_type'='following_updates'")).rows.every(n=>n.status==='processed')).toBe(true);
});

it('invalid suggested_action is explained as analysis failure; HTTP retry reruns analysis only and then permits composition',async()=>{
 await enable();const id=await collect();await settleThemeRound(db.pool,config(),id);const r=await round(id),run=await w.runOf(r.briefing_id);
 expect(run.instruction).toContain('Never use "adopt"');
 const bad=outputValue({topic:{quick_line:'Mechanism',summary:'Evidence and limitations',stop_reason:'Bounded evidence'}});(bad.highlights[0] as unknown as {suggested_action:string}).suggested_action='adopt';
 const done=await w.finishRun(run.id,JSON.stringify(bad));await new PostRunFinalizationService(new PgRunRepository(db.pool),undefined,undefined,undefined,runSettlement(config(),db.pool)).finalize(done.id,SPACE);
 expect(await round(id)).toMatchObject({status:'blocked',error_code:'briefing_output_invalid'});
 const app=buildModuleServer(config(),[informationDigestModule]);__setAuthIdentityForTests(identity);
 try{
  const base=`/api/v1/spaces/${SPACE}/projects/${PROJECT}/reading-compositions`;
  expect((await app.inject({method:'GET',url:base})).json().composition_status).toBe('waiting_for_analysis');
  const jobsBefore=await w.count('jobs');expect((await app.inject({method:'POST',url:base+'/retry',payload:{}})).statusCode).toBe(409);expect(await w.count('jobs')).toBe(jobsBefore);
  const collections=await w.count('source_goal_runs');
  const response=await app.inject({method:'POST',url:`/api/v1/sources/goals/${goalId}/theme-rounds/retry`,payload:{round_id:id}});expect(response.statusCode,response.body).toBe(200);expect(response.json().rounds[0].status).toBe('generating');
  expect(await w.count('source_goal_runs')).toBe(collections);expect(await w.count('runs')).toBe(2);expect((await w.rowOf(r.briefing_id)).attempt).toBe(2);
  await app.inject({method:'POST',url:`/api/v1/sources/goals/${goalId}/theme-rounds/retry`,payload:{round_id:id}});expect(await w.count('runs')).toBe(2);
  await publish(id);
  // Simulate the composition worker's own failure, after analysis succeeded.
  await db.pool.query("UPDATE jobs SET status='failed' WHERE job_type='project_reading_compose' AND payload_json->>'project_id'=$1",[PROJECT]);
  expect((await app.inject({method:'GET',url:base})).json().composition_status).toBe('failed');
  expect((await app.inject({method:'POST',url:base+'/retry',payload:{}})).statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:base})).json().composition_status).toBe('queued');expect(await w.count('runs')).toBe(2);
  // An older active queue entry outranks a newer failed job; repeated retry is idempotent.
  const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
  const later=await new PgJobQueueRepository(db.pool).enqueue({job_type:'project_reading_compose',space_id:SPACE,user_id:OWNER,payload:{project_id:PROJECT,round_id:id},max_attempts:1});
  await db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1",[later.id]);
  expect((await app.inject({method:'GET',url:base})).json().composition_status).toBe('queued');
  const queuedJobs=await w.count('jobs');expect((await app.inject({method:'POST',url:base+'/retry',payload:{}})).statusCode).toBe(200);expect(await w.count('jobs')).toBe(queuedJobs);

 }finally{await app.close()}
});

it('does not project a removed analysis output as a current failure and keeps existing retry usable',async()=>{
 await enable();const id=await collect();await settleThemeRound(db.pool,config(),id);const r=await round(id),run=await w.runOf(r.briefing_id);
 const done=await w.finishRun(run.id,JSON.stringify(outputValue()));await new PostRunFinalizationService(new PgRunRepository(db.pool),undefined,undefined,undefined,runSettlement(config(),db.pool)).finalize(done.id,SPACE);
 expect((await round(id)).status).toBe('blocked');
 await withDbTransaction(db.pool,async tx=>{await tx.query('UPDATE project_reading_rounds SET briefing_id=NULL WHERE id=$1',[id]);await tx.query('DELETE FROM information_briefings WHERE id=$1',[r.briefing_id]);});
 const runs=await w.count('runs'),collections=await w.count('source_goal_runs');
 const view=await readThemeRounds(db.pool,identity,goalId);expect(view.rounds[0]).toMatchObject({status:'awaiting_analysis',error_code:null,briefing:null});
 const {readProjectComposition}=await import('../src/modules/informationDigest/composition/service.js');const overview=await readProjectComposition(db.pool,identity,PROJECT);
 expect(overview.composition_status).toBe('waiting_for_analysis');expect(overview.rounds[0]).toMatchObject({status:'awaiting_analysis',error_code:null});
 expect(await w.count('runs')).toBe(runs);expect(await w.count('source_goal_runs')).toBe(collections);expect(await round(id)).toMatchObject({status:'blocked',error_code:'briefing_output_invalid'});
 await settleThemeRound(db.pool,config(),id,true);expect((await round(id)).status).toBe('generating');expect(await w.count('source_goal_runs')).toBe(collections);expect(await w.count('runs')).toBe(runs+1);
});
it.each(['briefing_daily_limit','briefing_attempts_exhausted','theme_scope_busy','source_network_failed'])('keeps real admission/collection error %s without an analysis record',async error_code=>{
 await enable();const id=await collect();await db.pool.query("UPDATE project_reading_rounds SET status='blocked',error_code=$2 WHERE id=$1",[id,error_code]);expect((await readThemeRounds(db.pool,identity,goalId)).rounds[0]).toMatchObject({status:'blocked',error_code});
});

it('a new day has no content version until its own analysis succeeds, while older exact editions remain readable',async()=>{
 await enable();const firstRound=await collect();await publish(firstRound);await composeProjectReading(db.pool,SPACE,PROJECT,firstRound);
 const first=(await readProjectComposition(db.pool,identity,PROJECT)).latest!,runs=await w.count('runs');
 const nextDate=new Date(`${first.edition_date}T00:00:00Z`);nextDate.setUTCDate(nextDate.getUTCDate()+1);const date=nextDate.toISOString().slice(0,10);
 expect((await readProjectComposition(db.pool,identity,PROJECT,undefined,date)).latest).toBeNull();
 expect((await readProjectComposition(db.pool,identity,PROJECT,first.id)).latest).toEqual(first);expect(await w.count('runs')).toBe(runs);expect(await compositionCount()).toBe(1);
});

it('freezes a delayed scheduler slot day in both round and collection audit, including a DST timezone',async()=>{
 const {PgAutomationRepository}=await import('../src/modules/automations/repository.js');
 await new PgAutomationRepository(db.pool).create({spaceId:SPACE,ownerUserId:OWNER,agentId:AGENT,projectId:PROJECT,name:'Daily',triggerType:'schedule',configJson:{target_type:'information_digest',scope:'project',operation:'daily',cron:'0 7 * * *',timezone:'America/New_York'},preflightSnapshot:{}});
 await enable();await new PgSchedulerTaskStore(db.pool).upsert({taskType:'source_goal_tick',taskKey:goalId,scopeType:'space',scopeId:SPACE,spaceId:SPACE,userId:OWNER,nextRunAt:'2026-11-01T03:30:00Z',metadataJson:{}});
 await enqueueDueSourceGoals(db.pool);const admitted=(await db.pool.query("SELECT payload_json FROM jobs WHERE job_type='source_goal_tick'")).rows[0].payload_json;
 expect(admitted.edition).toEqual({date:'2026-10-31',timezone:'America/New_York'});
 expect((await round(admitted.round_id)).execution_json.edition).toEqual(admitted.edition);
 await runSourceGoalTick(db.pool,config(),goalId,SPACE,executor,versionId,admitted.round_id);
 const audit=(await db.pool.query('SELECT reading_date::text,reading_timezone FROM source_goal_runs WHERE goal_id=$1',[goalId])).rows[0];
 expect(audit).toEqual({reading_date:'2026-10-31',reading_timezone:'America/New_York'});
 await publish(admitted.round_id);await composeProjectReading(db.pool,SPACE,PROJECT,admitted.round_id);
 expect((await readProjectComposition(db.pool,identity,PROJECT,undefined,'2026-10-31')).latest).toMatchObject({edition_date:'2026-10-31',timezone:'America/New_York',day_revision:1});
 expect((await readProjectComposition(db.pool,identity,PROJECT)).latest).toBeNull();
});

it('collection without analysis exposes its day check but creates no content version or composition work',async()=>{
 const q=await requestGoalCheck(db.pool,config(),identity,goalId,{expected_version_id:versionId});const payload=(await db.pool.query('SELECT payload_json FROM jobs WHERE id=$1',[q.job_id])).rows[0].payload_json;
 expect(payload.round_id).toBeUndefined();await runSourceGoalTick(db.pool,config(),goalId,SPACE,executor,versionId,undefined,payload.edition);
 const state=await readProjectComposition(db.pool,identity,PROJECT);expect(state.latest).toBeNull();expect(state.history).toEqual([]);expect(state.rounds).toMatchObject([{goal_id:goalId,status:'complete'}]);expect(await w.count('runs')).toBe(0);expect(await compositionCount()).toBe(0);
 expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='project_reading_compose'")).rows).toEqual([]);
});

it.each([2,25])('keeps the day version directory and pinned selection when reading version 1 of %s',async count=>{
 await db.pool.query(`INSERT INTO project_reading_compositions(id,space_id,project_id,revision,edition_date,timezone,day_revision,sections_json,rounds_json,reason) SELECT 'selector-'||n,$1,$2,n,'2001-02-03','UTC',n,'[]','[]','theme_terminal' FROM generate_series(1,$3::integer) n`,[SPACE,PROJECT,count]);
 const runs=await w.count('runs');
 const pinned=await readProjectComposition(db.pool,identity,PROJECT,'selector-1');
 expect(pinned.date).toBe('2001-02-03');expect(pinned.latest).toMatchObject({id:'selector-1',day_revision:1});
 expect(pinned.history[0]).toMatchObject({id:`selector-${count}`,day_revision:count});
 expect(pinned.history).toHaveLength(Math.min(count,20));
 expect(pinned.history.filter(v=>v.id==='selector-1')).toHaveLength(1);
 const latest=await readProjectComposition(db.pool,identity,PROJECT,undefined,pinned.date);
 expect(latest.latest?.id).toBe(`selector-${count}`);
 if(count===2)expect(pinned.history).toEqual(latest.history);
 expect(await w.count('runs')).toBe(runs);
});

it('daily history pages beyond twenty revisions and lists unattached analyses',async()=>{
 const {readReadingHistory}=await import('../src/modules/informationDigest/composition/history.js');
 const {readArchivedTheme}=await import('../src/modules/informationDigest/composition/analysis.js');
 await enable();const r=await collect(),briefing=await publish(r);
 await db.pool.query(`INSERT INTO project_reading_compositions(id,space_id,project_id,revision,edition_date,timezone,day_revision,sections_json,rounds_json,reason) SELECT 'history-'||n,$1,$2,n,('2001-01-01'::date+n-1),'UTC',1,'[]','[]','theme_terminal' FROM generate_series(1,25) n`,[SPACE,PROJECT]);
 // Adjacent records inside the same millisecond exercise full PG timestamp precision.
 await db.pool.query("UPDATE project_reading_compositions SET created_at='2026-11-01T02:03:04.123456Z'");
 const entries=[];let cursor:string|undefined;
 do{const page=await readReadingHistory(db.pool,identity,PROJECT,{cursor});entries.push(...page.items);cursor=page.next_cursor??undefined;}while(cursor);
 expect(entries).toHaveLength(26);expect(new Set(entries.map(e=>`${e.kind}:${e.id}`)).size).toBe(26);
 expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({kind:'edition',date:'2001-01-25'}),expect.objectContaining({kind:'theme_analysis',id:briefing})]));
 const today=(await round(r)).execution_json.edition.date;await composeProjectReading(db.pool,SPACE,PROJECT,r);
 expect((await readReadingHistory(db.pool,identity,PROJECT,{date:today})).items.some(e=>e.kind==='theme_analysis')).toBe(false);
 await db.pool.query("UPDATE source_goals SET status='paused' WHERE id=$1",[goalId]);expect((await readArchivedTheme(db.pool,identity,PROJECT,briefing)).visibility).toBe('visible');
 await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);expect((await readArchivedTheme(db.pool,identity,PROJECT,briefing)).visibility).toBe('withheld');
 await expect(readReadingHistory(db.pool,identity,PROJECT,{cursor:'broken'})).rejects.toMatchObject({statusCode:422});
 await expect(readReadingHistory(db.pool,identity,PROJECT,{date:'2026-02-30'})).rejects.toMatchObject({statusCode:422});
 await db.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[PROJECT,MEMBER]);await expect(readReadingHistory(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT,{})).rejects.toMatchObject({statusCode:404});
});
}
