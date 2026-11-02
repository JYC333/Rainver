import {ProposalApplierRegistry,type ProposalApplyContext} from '../src/modules/proposals/applierRegistry.js';
import {registerEvolvableAssetPromotionProposalApplier} from '../src/modules/evolution/assetPromotionProposalApplier.js';
import {withDbTransaction} from '../src/modules/routeUtils/common.js';
import {beforeEach,afterEach,afterAll,beforeAll,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,OWNER,MEMBER,PROJECT,AGENT,PROFILE,HOST,CONNECTION} from './support/briefingFixture.js';
import {readingWorkspace,initializeReading,saveReadingDraft,saveReadingSample} from '../src/modules/prompts/reading/workspace.js';
import {startReadingTrial,readReadingTrial,judgeReadingTrial,cancelReadingTrial,assertReadingTrialRun,registerReadingTrialSettlement} from '../src/modules/prompts/reading/trials.js';
import {PromptRepository} from '../src/modules/prompts/repository.js';
import {proposeReadingMethod,rollbackReadingMethod} from '../src/modules/prompts/reading/commands.js';
import {READING_METHOD_FIXTURE} from '@rainver/protocol';
import {readingMethodOf} from '../src/modules/prompts/reading/runtime.js';
import {MaterialItemProcessingService} from '../src/modules/sources/materialProcessing/items.js';
import {RuntimeContextPolicyRepository} from '../src/modules/policy/runtimeContextPolicyRepository.js';
import {buildServerDist,startWorkerProcess,isPrompted,isFrame,settledCommands,until,type WorkerProcess} from './support/briefingWorkerHarness.js';
import {runFinalizationReconcilerRegistry} from '../src/modules/runs/finalizationReconcilerRegistry.js';
import {EvaluationHarnessService} from '../src/modules/evolution/evaluationHarnessService.js';
import {EvolvableAssetEvaluationRepository} from '../src/modules/evolution/assetEvaluationRepository.js';
const db=useTestDatabase(import.meta.filename,{max:10});const w=briefingWorld(db);const identity={spaceId:SPACE,userId:OWNER};let item:string,home:string;let worker:WorkerProcess|undefined;
const key='reading.project_investigation';
const sample=READING_METHOD_FIXTURE;
beforeAll(async()=>{home=await mkdtemp(join(tmpdir(),'reading-method-test-'));buildServerDist();},600000);
afterEach(async()=>{await worker?.kill();worker=undefined;});
afterAll(async()=>{await rm(home,{recursive:true,force:true});});
beforeEach(async()=>{if(!db.available)return;await w.seed();await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`,[SPACE,OWNER]);await db.pool.query(`DELETE FROM evolvable_assets WHERE asset_key=$1`,[key]);item=await w.material('Synthetic original result');await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic test policy'});registerReadingTrialSettlement();});
async function prepared(){await initializeReading(db.pool,w.config(),identity);const current=await readingWorkspace(db.pool,identity,item,PROJECT);const draft=await saveReadingDraft(db.pool,identity,{item_id:item,project_id:PROJECT,parent_version_id:current.effective_version_id,reason:'Homepage was insufficient',method:current.method+'\nGive concrete integration counterexamples.'});const c=await saveReadingSample(db.pool,identity,item,PROJECT,sample,w.config());return {current,draft,c,request:{item_id:item,project_id:PROJECT,candidate_version_id:String(draft.id),candidate_content_hash:String(draft.content_hash),case_id:String(c.id),agent_id:AGENT,runtime_profile_id:PROFILE}};}
it('GET does not initialize, legacy provenance is unknown, ordinary readers gain no maintenance authority',async()=>{
 const before=await readingWorkspace(db.pool,identity,item,PROJECT);expect(before).toMatchObject({initialized:false,result_provenance:null});expect((await db.pool.query(`SELECT count(*)::int n FROM evolvable_assets WHERE asset_key=$1`,[key])).rows[0].n).toBe(0);
 await expect(initializeReading(db.pool,w.config(),{spaceId:SPACE,userId:MEMBER})).rejects.toMatchObject({statusCode:403});await initializeReading(db.pool,w.config(),identity);expect(await readingWorkspace(db.pool,{spaceId:SPACE,userId:MEMBER},item,PROJECT)).toMatchObject({can_manage:false,versions:[],trials:[]});
});
it('draft cloning leaves production unchanged and rejects a stale effective parent',async()=>{const {current,draft}=await prepared();expect((await readingWorkspace(db.pool,identity,item,PROJECT)).effective_version_id).toBe(current.effective_version_id);await expect(new PromptRepository(db.pool).renderPreview(identity,key,{version_id:draft.id})).resolves.toMatchObject({validation_errors:[]});await expect(saveReadingDraft(db.pool,identity,{item_id:item,project_id:PROJECT,parent_version_id:'wrong',reason:'stale',method:current.method})).rejects.toMatchObject({statusCode:409});});
it('starts exactly two private canonical Runs, closed context, frozen evidence and idempotent double clicks; generic eval cannot fake it',async()=>{const {request,draft}=await prepared();const [a,b]=await Promise.all([startReadingTrial(db.pool,w.config(),identity,request),startReadingTrial(db.pool,w.config(),identity,request)]);expect(a.id).toBe(b.id);await expect(startReadingTrial(db.pool,w.config(),identity,{...request,candidate_content_hash:'0'.repeat(64)})).rejects.toMatchObject({statusCode:409});const runs=(await db.pool.query(`SELECT * FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'reading_method_trial'->>'evaluation_id'=$1`,[a.id])).rows;expect(runs).toHaveLength(2);expect(runs.every(r=>r.visibility==='private'&&r.project_id===null&&r.capabilities_json.length===0)).toBe(true);expect(runs.every(r=>r.prompt.includes(sample.pages[1]!.text))).toBe(true);expect(new Set(runs.map(r=>r.requested_runtime_profile_id))).toEqual(new Set([PROFILE]));for(const run of runs)await assertReadingTrialRun(db.pool,run);const asset=(await db.pool.query(`SELECT id FROM evolvable_assets WHERE asset_key=$1`,[key])).rows[0];await expect(new EvolvableAssetEvaluationRepository(db.pool).recordEvaluationRun(identity,asset.id,String(draft.id),{status:'passed',eval_suite_ref:{},evaluator_version:'reading_method_pair.v1'})).rejects.toMatchObject({statusCode:403});await expect(new EvaluationHarnessService(db.pool).createCase(identity,asset.id,{name:'Forged reading proof',baseline_version_id:a.baseline_version_id,input_json:{kind:'reading_method_sample.v1',pages:sample.pages,authority_proof:{kind:'synthetic'}},baseline_output_json:{},verification_recipe_json:{checks:[{type:'non_empty',path:'summary'}]}})).rejects.toMatchObject({statusCode:403});expect(await new EvaluationHarnessService(db.pool).listCases(identity,asset.id)).toEqual([]);expect(await new EvolvableAssetEvaluationRepository(db.pool).listEvaluationRuns(identity,asset.id)).toEqual([]);});
it('withholds the complete comparison and generic Run after material/context revocation',async()=>{const {request}=await prepared();const trial=await startReadingTrial(db.pool,w.config(),identity,request);await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);expect(await readReadingTrial(db.pool,identity,trial.id)).toMatchObject({visibility:'withheld',baseline:null,candidate:null,reason:null,case_name:''});await expect(assertReadingTrialRun(db.pool,(await w.runs().getRun(SPACE,trial.baseline!.run_id))!)).rejects.toMatchObject({statusCode:403});expect(await w.runs().getVisibleRun(SPACE,OWNER,trial.baseline!.run_id)).toBeNull();});
it('real worker → synthetic ACP Host → canonical settlement completes both recorded Runs without formal content writes',async()=>{
 const {request}=await prepared();const trial=await startReadingTrial(db.pool,w.config(),identity,request);const before=(await db.pool.query(`SELECT content_hash,metadata_json FROM source_items WHERE id=$1`,[item])).rows[0];worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});worker.send({cmd:'policy',prompt:{answer:'# Finding\nBounded retry with idempotency key. Evidence: https://example.org/docs . Integration cost: retain idempotency records. Unknown: retention duration.'}});const done=await until(()=>readReadingTrial(db.pool,identity,trial.id),r=>!['queued','running'].includes(r.status),'paired trial settlement',300);expect(done).toMatchObject({status:'passed',baseline:{status:'succeeded'},candidate:{status:'succeeded'},judgment:null});expect(done.baseline!.text).toContain('idempotency');expect(done.baseline!.cost_usd).toBeNull();expect((await db.pool.query(`SELECT count(*)::int n FROM invocation_deliveries WHERE invocation_id=ANY($1::varchar[])`,[[done.baseline!.run_id,done.candidate!.run_id]])).rows[0].n).toBe(2);expect((await db.pool.query(`SELECT content_hash,metadata_json FROM source_items WHERE id=$1`,[item])).rows[0]).toEqual(before);await judgeReadingTrial(db.pool,identity,trial.id,{judgment:'better',reason:'Synthetic wiring assertion, not semantic quality'});const proposal=await new PromptRepository(db.pool).createPromotionProposal(identity,key,{version_id:trial.candidate_version_id,evaluation_run_ids:[trial.id],scope_type:'project',scope_id:PROJECT,reason:'Reading method review'});expect(proposal.proposal_id).toBeTruthy();const same=await proposeReadingMethod(db.pool,identity,trial.candidate_version_id,trial.id,PROJECT);expect(same.proposal_id).toBe(proposal.proposal_id);await expect(proposeReadingMethod(db.pool,identity,trial.candidate_version_id,trial.id,null)).rejects.toMatchObject({statusCode:409});expect((await readingWorkspace(db.pool,identity,item,PROJECT)).effective_version_id).toBe(trial.baseline_version_id);
 const registry=new ProposalApplierRegistry();registerEvolvableAssetPromotionProposalApplier(registry);
 // Synthetic test approval only, never a running instance proposal.
 await withDbTransaction(db.pool,async tx=>{const p=(await tx.query(`SELECT * FROM proposals WHERE id=$1`,[proposal.proposal_id])).rows[0];await registry.apply({db:tx,config:w.config(),proposal:p as unknown as ProposalApplyContext['proposal'],userId:OWNER});await tx.query(`UPDATE proposals SET status='accepted' WHERE id=$1`,[proposal.proposal_id]);});
 expect((await readingWorkspace(db.pool,identity,item,PROJECT)).effective_version_id).toBe(trial.candidate_version_id);
 // The exact admitted version stays fixed across a rollback; the next Run re-resolves.
 await db.pool.query(`UPDATE source_items SET project_id=$2 WHERE id=$1`,[item,PROJECT]);
 await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json='{"retention_policy":"full_text"}' WHERE id=$1`,[CONNECTION]);
 const service=new MaterialItemProcessingService(db.pool,w.config());const queued=await service.start(identity,item,{agent_id:AGENT,runtime_profile_id:PROFILE});
 const beforeRollback=(await w.runs().getRun(SPACE,queued.run_id!))!;expect(readingMethodOf(beforeRollback)?.version_id).toBe(trial.candidate_version_id);await (await import('../src/modules/prompts/reading/dispatch.js')).assertReadingRunDispatch(db.pool,beforeRollback);
 await expect(rollbackReadingMethod(db.pool,identity,item,PROJECT,'stale-version')).rejects.toMatchObject({statusCode:409});await rollbackReadingMethod(db.pool,identity,item,PROJECT,trial.candidate_version_id);
 expect((await readingWorkspace(db.pool,identity,item,PROJECT)).effective_version_id).toBe(trial.baseline_version_id);
 expect(readingMethodOf((await w.runs().getRun(SPACE,queued.run_id!))!)?.version_id).toBe(trial.candidate_version_id);const nextItem=await w.material('After rollback');await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[nextItem,PROJECT]);const next=await service.start(identity,nextItem,{agent_id:AGENT,runtime_profile_id:PROFILE});expect(readingMethodOf((await w.runs().getRun(SPACE,next.run_id!))!)?.version_id).toBe(trial.baseline_version_id);

},60000);
it('settlement projects failure/cancel once and ignores unrelated or late repeats',async()=>{const {request}=await prepared();const trial=await startReadingTrial(db.pool,w.config(),identity,request);const reconcile=runFinalizationReconcilerRegistry.entries().find(r=>r.key==='reading_method_pair')!;await w.finishRun(trial.baseline!.run_id,'synthetic failure','failed');const candidate=await w.finishRun(trial.candidate!.run_id,'','cancelled');await reconcile.reconcile(db.pool,candidate);await reconcile.reconcile(db.pool,{...candidate,status:'succeeded',output_json:{summary:'STALE_SUCCESS_MUST_NOT_REPLACE_CANCEL'}});expect((await readReadingTrial(db.pool,identity,trial.id)).status).toBe('cancelled');});
it('a real material preparation freezes the deployed method in the Source-owned production Run',async()=>{await initializeReading(db.pool,w.config(),identity);await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json='{"retention_policy":"full_text"}' WHERE id=$1`,[CONNECTION]);const operation=await new MaterialItemProcessingService(db.pool,w.config()).start(identity,item,{agent_id:AGENT,runtime_profile_id:PROFILE});expect(operation.status).toBe('queued');const run=(await w.runs().getRun(SPACE,operation.run_id!))!;expect(readingMethodOf(run)?.version_id).toBe((await readingWorkspace(db.pool,identity,item)).effective_version_id);expect(run.prompt).toContain('Investigate a resource');expect((await db.pool.query(`SELECT retrieval_preferences_json FROM work_context_setups WHERE work_context_scope_id=$1`,[run.id])).rows[0].retrieval_preferences_json).toEqual({enabled:false});});

it('rejects a revoked Source before actual worker Delivery, settles both jobs, and permits one explicit idempotent retry',async()=>{
 const {request}=await prepared();const first=await startReadingTrial(db.pool,w.config(),identity,request);
 await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});worker.send({cmd:'policy',prompt:{answer:'No rejected input should reach this synthetic Host.'}});
 await until(()=>readReadingTrial(db.pool,identity,first.id),t=>!['queued','running'].includes(t.status),'revoked trial terminal state',250);
 expect((await db.pool.query(`SELECT count(*)::int n FROM invocation_deliveries WHERE invocation_id=ANY($1::varchar[])`,[[first.baseline!.run_id,first.candidate!.run_id]])).rows[0].n).toBe(0);
 expect((await db.pool.query(`SELECT status FROM runs WHERE id=ANY($1::varchar[])`,[[first.baseline!.run_id,first.candidate!.run_id]])).rows.every(r=>r.status==='failed')).toBe(true);
 await worker.kill();worker=undefined;
 await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":true,"allow_local_provider_egress":true}' WHERE id=$1`,[CONNECTION]);
 const a=await startReadingTrial(db.pool,w.config(),identity,{...request,retry_of:first.id});const b=await startReadingTrial(db.pool,w.config(),identity,{...request,retry_of:first.id});expect(a.id).not.toBe(first.id);expect(b.id).toBe(a.id);
},60000);

it('canonical Source authority locks serialize revocation in either direction, not a timing sleep',async()=>{
 const {request}=await prepared();const pair=await startReadingTrial(db.pool,w.config(),identity,request);const run=(await w.runs().getRun(SPACE,pair.baseline!.run_id))!;
 const {lockReadingRunAuthority}=await import('../src/modules/runtimeContext/index.js');const {waitForLockWaiter}=await import('./support/lockWait.js');
 const a=await db.pool.connect(),b=await db.pool.connect();
 try{
  await a.query('BEGIN');await b.query('BEGIN');await lockReadingRunAuthority(a,run);await assertReadingTrialRun(a,run);
  const writer=b.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);
  await waitForLockWaiter(db.pool);expect((await db.pool.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`)).rows[0].n).toBeGreaterThan(0);
  await a.query('COMMIT');await writer;await b.query('COMMIT');await expect(assertReadingTrialRun(db.pool,run)).rejects.toMatchObject({statusCode:403});
  await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":true,"allow_local_provider_egress":true}' WHERE id=$1`,[CONNECTION]);
  await a.query('BEGIN');await b.query('BEGIN');await b.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);
  const reader=lockReadingRunAuthority(a,run);await waitForLockWaiter(db.pool);await b.query('COMMIT');await reader;await expect(assertReadingTrialRun(a,run)).rejects.toMatchObject({statusCode:403});await a.query('ROLLBACK');
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
});

it('refuses arbitrary pasted Source content, admits exact retained excerpts, and withholds the case and pair when that artifact is withdrawn',async()=>{
 await initializeReading(db.pool,w.config(),identity);
 await expect(saveReadingSample(db.pool,identity,item,PROJECT,{name:'Not retained',pages:[{url:'https://example.org',text:'Private unrelated pasted page'},{url:'https://example.org/docs',text:'Private unrelated docs'}]},w.config())).rejects.toMatchObject({statusCode:403});
 await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json='{"retention_policy":"full_text"}' WHERE id=$1`,[CONNECTION]);
 const {agentReadingDocument,agentReadingMetadata,saveSourceReadingDocument}=await import('../src/modules/sources/materialProcessing/documents.js');
 const uri=(await db.pool.query('SELECT source_uri FROM source_items WHERE id=$1',[item])).rows[0].source_uri;
 const content={kind:'article' as const,format:'source_text' as const,syntax:'plain' as const,text:'Retained homepage paragraph. Retained docs mechanism and limitation.',sources:[uri,'https://example.org/docs']};
 await withDbTransaction(db.pool,tx=>saveSourceReadingDocument(tx,{spaceId:SPACE,itemId:item,document:agentReadingDocument(content,uri),agentProvided:true,metadata:agentReadingMetadata(content)}));
 const current=await readingWorkspace(db.pool,identity,item,PROJECT);
 const draft=await saveReadingDraft(db.pool,identity,{item_id:item,project_id:PROJECT,parent_version_id:current.effective_version_id,reason:'Inspect retained evidence',method:current.method+'\nExplain limitations explicitly.'});
 const retained=await saveReadingSample(db.pool,identity,item,PROJECT,{name:'Exact retained excerpts',pages:[{url:uri,text:'Retained homepage paragraph.'},{url:'https://example.org/docs',text:'Retained docs mechanism and limitation.'}]},w.config());
 const pair=await startReadingTrial(db.pool,w.config(),identity,{item_id:item,project_id:PROJECT,candidate_version_id:String(draft.id),candidate_content_hash:String(draft.content_hash),case_id:String(retained.id),agent_id:AGENT,runtime_profile_id:PROFILE});expect(pair.visibility).toBe('visible');worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});worker.send({cmd:'policy',prompt:{answer:'Retained mechanism and limitation, supported by https://example.org/docs .'}});expect((await until(()=>readReadingTrial(db.pool,identity,pair.id),r=>!['queued','running'].includes(r.status),'retained comparison Delivery',250)).status).toBe('passed');await worker.kill();worker=undefined;
 const artifact=(await db.pool.query('SELECT extracted_artifact_id FROM source_items WHERE id=$1',[item])).rows[0].extracted_artifact_id;
 await db.pool.query("UPDATE artifacts SET access_level='summary' WHERE id=$1",[artifact]);
 expect(await readReadingTrial(db.pool,identity,pair.id)).toMatchObject({visibility:'withheld',baseline:null,candidate:null,case_name:''});
 expect((await readingWorkspace(db.pool,identity,item,PROJECT)).cases).toEqual([]);
});

it('a killed worker recovers the original attempt, releases the pair and ignores its late Host completion',async()=>{
 const {request}=await prepared();const pair=await startReadingTrial(db.pool,w.config(),identity,request);const runId=pair.baseline!.run_id;
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});const old=await worker.next(isPrompted(runId));await worker.kill();worker=undefined;
 // Only the persisted lease clock is accelerated; execution and recovery are real worker processes.
 await db.pool.query(`UPDATE jobs SET heartbeat_at=now()-interval '11 minutes',updated_at=now()-interval '11 minutes' WHERE payload_json->>'run_id'=$1`,[runId]);
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});worker.send({cmd:'policy',prompt:{answer:'Synthetic retained comparison output with a limitation.'},terminate:'ack'});
 expect((await worker.next(isFrame('terminate',runId))).frame.launch_id).toBe(old.launchId);
 const ended=await until(()=>readReadingTrial(db.pool,identity,pair.id),r=>!['queued','running'].includes(r.status),'orphaned pair projection',250);
 expect(ended.status).toBe('failed');expect((await w.runs().getRun(SPACE,runId))?.status).toBe('orphaned');
 worker.send({cmd:'complete',runId,launchId:old.launchId,exitCode:0});await settledCommands(worker);
 expect((await readReadingTrial(db.pool,identity,pair.id)).status).toBe('failed');
 expect((await w.runs().getRun(SPACE,runId))?.status).toBe('orphaned');
 // Explicit retry is a new bounded pair, not an infinite background re-run.
 const again=await startReadingTrial(db.pool,w.config(),identity,{...request,retry_of:pair.id});expect(again.id).not.toBe(pair.id);
 expect((await until(()=>readReadingTrial(db.pool,identity,again.id),r=>!['queued','running'].includes(r.status),'explicit retry result',250)).status).toBe('passed');
},60000);

it('the owner can stop queued comparison Runs after input or maintenance authority is withdrawn, without returning the private text',async()=>{
 const {request}=await prepared();const pair=await startReadingTrial(db.pool,w.config(),identity,request);
 await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);
 await db.pool.query(`UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2`,[SPACE,OWNER]);
 const stopped=await cancelReadingTrial(db.pool,w.config(),identity,pair.id);expect(stopped).toMatchObject({status:'cancelled',visibility:'withheld',baseline:null,candidate:null,reason:null});
 expect((await db.pool.query('SELECT status FROM runs WHERE id=ANY($1::varchar[])',[[pair.baseline!.run_id,pair.candidate!.run_id]])).rows.every(r=>r.status==='cancelled')).toBe(true);
 await expect(cancelReadingTrial(db.pool,w.config(),{spaceId:SPACE,userId:MEMBER},pair.id)).rejects.toMatchObject({statusCode:404});
});
