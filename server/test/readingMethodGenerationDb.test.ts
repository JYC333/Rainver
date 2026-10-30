import {randomUUID} from 'node:crypto';
import {READING_METHOD_FIXTURE} from '@rainver/protocol';
import {saveReadingSample} from '../src/modules/prompts/reading/workspace.js';
import {startReadingTrial,readReadingTrial,assertReadingTrialRun,judgeReadingTrial,registerReadingTrialSettlement} from '../src/modules/prompts/reading/trials.js';
import {resolvePrompt} from '../src/modules/prompts/resolver.js';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,OWNER,MEMBER,PROJECT,AGENT,PROFILE,HOST,CONNECTION} from './support/briefingFixture.js';
import {buildServerDist,startWorkerProcess,isPrompted,isFrame,settledCommands,until,type WorkerProcess} from './support/briefingWorkerHarness.js';
import {RuntimeContextPolicyRepository} from '../src/modules/policy/runtimeContextPolicyRepository.js';
import {initializeReading,readingWorkspace,saveReadingDraft} from '../src/modules/prompts/reading/workspace.js';
import {startReadingGeneration,readReadingGeneration,cancelReadingGeneration,registerReadingGenerationSettlement} from '../src/modules/prompts/reading/generation.js';
import {assertGenerationDispatch} from '../src/modules/prompts/reading/generationAuthority.js';
import {runFinalizationReconcilerRegistry} from '../src/modules/runs/finalizationReconcilerRegistry.js';
import {PromptRepository} from '../src/modules/prompts/repository.js';
import {EvolvableAssetRepository} from '../src/modules/evolution/assetRepository.js';
import {canonicalRunOutput} from '../src/modules/runs/orchestrationResults.js';
import {withDbTransaction} from '../src/modules/routeUtils/common.js';
const db=useTestDatabase(import.meta.filename,{max:10}),w=briefingWorld(db),identity={spaceId:SPACE,userId:OWNER};
let item:string,home:string,worker:WorkerProcess|undefined;
const key='reading.project_investigation';
const result={schema:'reading_method_revision.v1',method:'Investigate specific capabilities using primary documentation and actual API examples. Explain mechanisms, evidence, project fit, adaptation costs and unknowns. Never invent a fetched page.',summary:'Ask for primary documentation rather than a homepage paraphrase.',changes:['Follow relevant primary documentation and concrete examples.','Distinguish evidence and unknowns.']};
beforeAll(async()=>{home=await mkdtemp(join(tmpdir(),'reading-generation-'));buildServerDist();},600000);
afterEach(async()=>{await worker?.kill();worker=undefined;});
afterAll(async()=>{await rm(home,{recursive:true,force:true});});
beforeEach(async()=>{if(!db.available)return;await w.seed();await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`,[SPACE,OWNER]);await db.pool.query(`DELETE FROM evolvable_assets WHERE asset_key=$1`,[key]);item=await w.material('PRIVATE_ARTICLE_MUST_NOT_ENTER_GENERATION');await initializeReading(db.pool,w.config(),identity);await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic generation policy'});registerReadingGenerationSettlement();registerReadingTrialSettlement();});
async function request(){const current=await readingWorkspace(db.pool,identity,item,PROJECT);return {source_kind:'description' as const,item_id:item,project_id:PROJECT,parent_version_id:current.effective_version_id!,parent_content_hash:current.effective_content_hash!,description:'The result only paraphrased the homepage; inspect primary docs and evidence.',agent_id:AGENT,runtime_profile_id:PROFILE};}
async function settle(id:string,output:unknown=result){
 const r=await w.finishRun(id,JSON.stringify(output),'succeeded');
 await db.pool.query('UPDATE runs SET output_json=$2::jsonb WHERE id=$1',[id,JSON.stringify(canonicalRunOutput({success:true,outputText:JSON.stringify(output),outputJson:{},structuredSchema:'reading_method_revision.v1'}))]);
 const run=(await w.runs().getRun(SPACE,r.id))!;
 const rec=runFinalizationReconcilerRegistry.entries().find(e=>e.key==='reading_method_generation')!;await rec.reconcile(db.pool,run);return run;
}
async function approveTestProposal(id:string){
 const {ProposalApplierRegistry}=await import('../src/modules/proposals/applierRegistry.js');const {registerEvolvableAssetPromotionProposalApplier}=await import('../src/modules/evolution/assetPromotionProposalApplier.js');const registry=new ProposalApplierRegistry();registerEvolvableAssetPromotionProposalApplier(registry);
 // Only an isolated test proposal is decided here, never a product-instance proposal.
 await withDbTransaction(db.pool,async tx=>{const proposal=(await tx.query(`SELECT * FROM proposals WHERE id=$1`,[id])).rows[0]!;await registry.apply({db:tx,config:w.config(),proposal:proposal as unknown as import('../src/modules/proposals/applierRegistry.js').ProposalApplyContext['proposal'],userId:OWNER});await tx.query(`UPDATE proposals SET status='accepted' WHERE id=$1`,[id]);});
}
it('strict description input rejects log channels and ordinary readers; GET creates no Runs',async()=>{
 const input=await request();await expect(startReadingGeneration(db.pool,identity,{...input,log_ids:['private-run']})).rejects.toMatchObject({statusCode:422});await expect(startReadingGeneration(db.pool,{spaceId:SPACE,userId:MEMBER},input)).rejects.toMatchObject({statusCode:403});expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(0);
});
it('freezes the effective method and description, closes Project injection, creates one private Run/job and reuses concurrent clicks',async()=>{
 const input=await request();const [a,b]=await Promise.all([startReadingGeneration(db.pool,identity,input),startReadingGeneration(db.pool,identity,input)]);expect(a.id).toBe(b.id);const run=(await w.runs().getRun(SPACE,a.id))!;expect(run).toMatchObject({visibility:'private',project_id:null,capabilities_json:[],trigger_origin:'manual'});expect(run.prompt).toContain(input.description);expect(run.prompt).not.toContain('PRIVATE_ARTICLE');expect(run.prompt).not.toContain('warehouse picking');expect((await db.pool.query(`SELECT project_id,retrieval_preferences_json,pinned_refs_json FROM work_context_setups WHERE work_context_scope_id=$1`,[a.id])).rows[0]).toMatchObject({project_id:null,retrieval_preferences_json:{enabled:false},pinned_refs_json:[]});expect((await db.pool.query(`SELECT max_attempts FROM jobs WHERE payload_json->>'run_id'=$1`,[a.id])).rows).toEqual([{max_attempts:1}]);await expect(startReadingGeneration(db.pool,identity,{...input,description:'A different revision while the first is queued'})).rejects.toMatchObject({statusCode:409});await expect(startReadingGeneration(db.pool,identity,{...input,parent_content_hash:'0'.repeat(64)})).rejects.toMatchObject({statusCode:409});await assertGenerationDispatch(db.pool,run);
});
it('real worker/ACP/Delivery/canonical settlement creates an unenabled draft with its actual Run provenance; manual tweak is an immutable child',async()=>{
 const input=await request(),g=await startReadingGeneration(db.pool,identity,input);
 const before=(await db.pool.query(`SELECT content_hash,metadata_json FROM source_items WHERE id=$1`,[item])).rows[0];
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});worker.send({cmd:'policy',prompt:{answer:JSON.stringify(result)}});
 const done=await until(()=>readReadingGeneration(db.pool,identity,g.id),v=>!['queued','running','settling'].includes(v.status),'generation settlement',300);
 expect(done).toMatchObject({status:'ready',method:result.method,summary:result.summary,cost_usd:null});expect(done.candidate_version_id).toBeTruthy();
 expect((await db.pool.query(`SELECT count(*)::int n FROM invocation_deliveries WHERE invocation_id=$1`,[g.id])).rows[0].n).toBe(1);
 const context=await readingWorkspace(db.pool,identity,item,PROJECT);expect(context.effective_version_id).toBe(input.parent_version_id);expect(context.generations?.[0]?.id).toBe(g.id);expect(context.trials).toEqual([]);
 const v=(await db.pool.query('SELECT * FROM evolvable_asset_versions WHERE id=$1',[done.candidate_version_id])).rows[0];expect(v).toMatchObject({status:'draft',source:'generated',parent_version_id:input.parent_version_id});expect(v.content_json.reading_generation.origin_run_id).toBe(g.id);expect(JSON.stringify(v.content_json)).not.toContain(input.description);expect(JSON.stringify(v.content_json)).not.toContain(result.summary);
 await expect(new EvolvableAssetRepository(db.pool).updateVersionContent(identity,v.asset_id,v.id,{content_json:v.content_json})).rejects.toMatchObject({statusCode:409});
 const child=await saveReadingDraft(db.pool,identity,{item_id:item,project_id:PROJECT,parent_version_id:v.id,reason:'Manual follow-up',method:result.method+' Explain a counterexample.'});expect(child.parent_version_id).toBe(v.id);expect((await db.pool.query(`SELECT content_json FROM evolvable_asset_versions WHERE id=$1`,[child.id])).rows[0].content_json.reading_generation.origin_run_id).toBe(g.id);
 const rec=runFinalizationReconcilerRegistry.entries().find(e=>e.key==='reading_method_generation')!;await rec.reconcile(db.pool,(await w.runs().getRun(SPACE,g.id))!);expect((await db.pool.query(`SELECT count(*)::int n FROM evolvable_asset_versions WHERE content_json->'reading_generation'->>'origin_run_id'=$1`,[g.id])).rows[0].n).toBe(2); // original + explicit manual child, no duplicate settlement version
 expect((await db.pool.query(`SELECT content_hash,metadata_json FROM source_items WHERE id=$1`,[item])).rows[0]).toEqual(before);
 expect((await db.pool.query(`SELECT count(*)::int n FROM proposals`)).rows[0].n).toBe(0);
 const sample=await saveReadingSample(db.pool,identity,item,PROJECT,READING_METHOD_FIXTURE,w.config());
 worker.send({cmd:'policy',prompt:{answer:'# Synthetic mechanism\nUse documented retries and state unknowns. This is wiring, not semantic acceptance.'}});
 const pair=await startReadingTrial(db.pool,w.config(),identity,{item_id:item,project_id:PROJECT,candidate_version_id:v.id,candidate_content_hash:v.content_hash,case_id:String(sample.id),agent_id:AGENT,runtime_profile_id:PROFILE});
 const compared=await until(()=>readReadingTrial(db.pool,identity,pair.id),p=>!['queued','running'].includes(p.status),'generated candidate comparison',300);expect(compared.status).toBe('passed');
 await judgeReadingTrial(db.pool,identity,pair.id,{judgment:'same',reason:'Synthetic compatibility assertion; not model quality.'});
 const {proposeReadingMethod,rollbackReadingMethod}=await import('../src/modules/prompts/reading/commands.js');const proposed=await proposeReadingMethod(db.pool,identity,v.id,pair.id,PROJECT);
 await approveTestProposal(String(proposed.proposal_id));
 expect((await readingWorkspace(db.pool,identity,item,PROJECT)).effective_version_id).toBe(v.id);
 await rollbackReadingMethod(db.pool,identity,item,PROJECT,v.id);expect((await readingWorkspace(db.pool,identity,item,PROJECT)).effective_version_id).toBe(input.parent_version_id);
},60000);
it('revocation before real dispatch produces zero accepted Delivery, no candidate, and an explicit idempotent retry after permission restoration',async()=>{
 const input=await request(),g=await startReadingGeneration(db.pool,identity,input);
 await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});worker.send({cmd:'policy',prompt:{answer:JSON.stringify(result)}});
 await until(()=>w.runs().getRun(SPACE,g.id),v=>v?.status==='failed','revoked generation failed',250);expect((await db.pool.query(`SELECT count(*)::int n FROM invocation_deliveries WHERE invocation_id=$1`,[g.id])).rows[0].n).toBe(0);expect(await readReadingGeneration(db.pool,identity,g.id)).toMatchObject({visibility:'withheld',description:null,method:null,summary:null});expect(await w.runs().getVisibleRun(SPACE,OWNER,g.id)).toBeNull();await worker.kill();worker=undefined;
 await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":true,"allow_local_provider_egress":true}' WHERE id=$1`,[CONNECTION]);
 const retry=await startReadingGeneration(db.pool,identity,{...input,retry_of:g.id});expect(retry.id).not.toBe(g.id);expect((await startReadingGeneration(db.pool,identity,{...input,retry_of:g.id})).id).toBe(retry.id);
},60000);
it('a canonical promotion of a different baseline blocks old generation dispatch and late settlement',async()=>{
 const input=await request(),g=await startReadingGeneration(db.pool,identity,input),run=(await w.runs().getRun(SPACE,g.id))!;
 const base=await readingWorkspace(db.pool,identity,item,PROJECT);
 const draft=await saveReadingDraft(db.pool,identity,{item_id:item,project_id:PROJECT,parent_version_id:base.effective_version_id,reason:'Independent method revision',method:base.method+' Explain primary documentation limitations.'});
 const sample=await saveReadingSample(db.pool,identity,item,PROJECT,READING_METHOD_FIXTURE,w.config());
 const pair=await startReadingTrial(db.pool,w.config(),identity,{item_id:item,project_id:PROJECT,candidate_version_id:String(draft.id),candidate_content_hash:String(draft.content_hash),case_id:String(sample.id),agent_id:AGENT,runtime_profile_id:PROFILE});
 // Terminal fixtures isolate publication ordering. The real worker/Delivery path is tested separately above.
 await w.finishRun(pair.baseline!.run_id,'Synthetic baseline');const finished=await w.finishRun(pair.candidate!.run_id,'Synthetic candidate');await runFinalizationReconcilerRegistry.entries().find(e=>e.key==='reading_method_pair')!.reconcile(db.pool,finished);
 await judgeReadingTrial(db.pool,identity,pair.id,{judgment:'same',reason:'Synthetic publication ordering, not semantic quality.'});
 const {proposeReadingMethod}=await import('../src/modules/prompts/reading/commands.js');const proposed=await proposeReadingMethod(db.pool,identity,String(draft.id),pair.id,PROJECT);await approveTestProposal(String(proposed.proposal_id));
 expect((await readingWorkspace(db.pool,identity,item,PROJECT)).effective_version_id).toBe(draft.id);
 await settle(g.id);expect(await readReadingGeneration(db.pool,identity,g.id)).toMatchObject({status:'blocked',candidate_version_id:null});await expect(assertGenerationDispatch(db.pool,run)).rejects.toMatchObject({statusCode:409});
});
it('invalid model output and cancellation cannot register successful drafts; explicit retry is bounded',async()=>{
 const input=await request();const first=await startReadingGeneration(db.pool,identity,input);await settle(first.id,{...result,method:'too short'});expect(await readReadingGeneration(db.pool,identity,first.id)).toMatchObject({status:'failed',candidate_version_id:null});
 const retry=await startReadingGeneration(db.pool,identity,{...input,retry_of:first.id});expect((await cancelReadingGeneration(db.pool,w.config(),identity,retry.id)).status).toBe('cancelled');
 const rec=runFinalizationReconcilerRegistry.entries().find(e=>e.key==='reading_method_generation')!;await rec.reconcile(db.pool,{...(await w.runs().getRun(SPACE,retry.id))!,status:'succeeded',output_json:{summary:JSON.stringify(result)}});expect((await readReadingGeneration(db.pool,identity,retry.id)).status).toBe('cancelled');
 const third=await startReadingGeneration(db.pool,identity,{...input,retry_of:retry.id});await cancelReadingGeneration(db.pool,w.config(),identity,third.id);await expect(startReadingGeneration(db.pool,identity,{...input,retry_of:third.id})).rejects.toMatchObject({statusCode:429});
});
it('generated versions and their manual descendants are private through generic version/render/Run APIs and withheld after Source revocation',async()=>{
 const g=await startReadingGeneration(db.pool,identity,await request());await settle(g.id);const view=await readReadingGeneration(db.pool,identity,g.id);
 const repo=new PromptRepository(db.pool);await expect(repo.renderPreview({spaceId:SPACE,userId:MEMBER},key,{version_id:view.candidate_version_id})).rejects.toMatchObject({statusCode:404});expect(await w.runs().getVisibleRun(SPACE,MEMBER,g.id)).toBeNull();await expect(readReadingGeneration(db.pool,{spaceId:SPACE,userId:MEMBER},g.id)).rejects.toMatchObject({statusCode:404});
 await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);expect(await readReadingGeneration(db.pool,identity,g.id)).toMatchObject({visibility:'withheld',method:null,summary:null,changes:[]});expect((await repo.listVersions(identity,key)).some(v=>v.id===view.candidate_version_id)).toBe(false);await expect(repo.renderPreview(identity,key,{version_id:view.candidate_version_id})).rejects.toMatchObject({statusCode:404});
});
it('private generated strategy provenance remains authorized when compared against a different consenting Source',async()=>{
 const g=await startReadingGeneration(db.pool,identity,await request());await settle(g.id);const generated=await readReadingGeneration(db.pool,identity,g.id);
 const connection=randomUUID(),channel=randomUUID();await w.addSource(connection,channel,'Second consenting Source',{allow_external_model_egress:true,allow_local_provider_egress:true});const other=await w.material('A different comparison sample',{connection,channel});
 const sample=await saveReadingSample(db.pool,identity,other,PROJECT,READING_METHOD_FIXTURE,w.config());
 const candidate=(await readingWorkspace(db.pool,identity,item,PROJECT)).versions.find(v=>v.id===generated.candidate_version_id)!;
 const pair=await startReadingTrial(db.pool,w.config(),identity,{item_id:other,project_id:PROJECT,candidate_version_id:candidate.id,candidate_content_hash:candidate.content_hash,case_id:String(sample.id),agent_id:AGENT,runtime_profile_id:PROFILE});expect(pair.visibility).toBe('visible');
 await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);
 expect(await readReadingTrial(db.pool,identity,pair.id)).toMatchObject({visibility:'withheld',baseline:null,candidate:null});await expect(assertReadingTrialRun(db.pool,(await w.runs().getRun(SPACE,pair.baseline!.run_id))!)).rejects.toMatchObject({statusCode:403});
});
it('staging resolution cannot disclose a private candidate to another maintainer; approving publishes only strategy, not private feedback',async()=>{
 const g=await startReadingGeneration(db.pool,identity,await request());await settle(g.id);const view=await readReadingGeneration(db.pool,identity,g.id);const repo=new PromptRepository(db.pool);
 const asset=(await db.pool.query(`SELECT id FROM evolvable_assets WHERE asset_key=$1`,[key])).rows[0];await new EvolvableAssetRepository(db.pool).transitionVersionStatus(identity,asset.id,view.candidate_version_id!,{status:'candidate'});
 await repo.setDeployment(identity,key,'staging',{version_id:view.candidate_version_id,scope_type:'project',scope_id:PROJECT});
 await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`,[SPACE,MEMBER]);
 await expect(resolvePrompt(db.pool,{spaceId:SPACE,userId:MEMBER,assetKey:key,projectId:PROJECT,label:'staging'})).rejects.toMatchObject({statusCode:404});
 // Isolated row-state publication fixture checks projection only. Actual proposal/approval gate is exercised by readingMethodDb.
 await db.pool.query(`UPDATE evolvable_asset_versions SET status='approved' WHERE id=$1`,[view.candidate_version_id]);
 const publicMethod=await repo.renderPreview({spaceId:SPACE,userId:MEMBER},key,{version_id:view.candidate_version_id});expect(publicMethod.rendered_text).toBe(result.method);expect(JSON.stringify((await repo.listVersions({spaceId:SPACE,userId:MEMBER},key)).find(v=>v.id===view.candidate_version_id))).not.toContain(result.summary);await expect(readReadingGeneration(db.pool,{spaceId:SPACE,userId:MEMBER},g.id)).rejects.toMatchObject({statusCode:404});
});
it('the real worker restart settles its orphaned generation and rejects a late Host reply; only an explicit new generation may retry',async()=>{
 const input=await request(),g=await startReadingGeneration(db.pool,identity,input);
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});const old=await worker.next(isPrompted(g.id));await worker.kill();worker=undefined;
 await db.pool.query(`UPDATE jobs SET heartbeat_at=now()-interval '11 minutes',updated_at=now()-interval '11 minutes' WHERE payload_json->>'run_id'=$1`,[g.id]);
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});worker.send({cmd:'policy',prompt:{answer:JSON.stringify(result)},terminate:'ack'});expect((await worker.next(isFrame('terminate',g.id))).frame.launch_id).toBe(old.launchId);
 const ended=await until(()=>readReadingGeneration(db.pool,identity,g.id),v=>v.status==='orphaned','orphaned generation',250);expect(ended.candidate_version_id).toBeNull();worker.send({cmd:'complete',runId:g.id,launchId:old.launchId,exitCode:0});await settledCommands(worker);expect((await readReadingGeneration(db.pool,identity,g.id)).candidate_version_id).toBeNull();
 const retry=await startReadingGeneration(db.pool,identity,{...input,retry_of:g.id});expect(retry.id).not.toBe(g.id);expect((await until(()=>readReadingGeneration(db.pool,identity,retry.id),v=>v.status==='ready','explicit generation retry',250)).candidate_version_id).toBeTruthy();expect((await startReadingGeneration(db.pool,identity,input)).id).toBe(retry.id);
},60000);
it('canonical Source locks fence current authority in both transaction orderings',async()=>{
 const g=await startReadingGeneration(db.pool,identity,await request()),run=(await w.runs().getRun(SPACE,g.id))!;
 const {lockReadingRunAuthority}=await import('../src/modules/runtimeContext/index.js'),{waitForLockWaiter}=await import('./support/lockWait.js');const a=await db.pool.connect(),b=await db.pool.connect();
 try{
  await a.query('BEGIN');await b.query('BEGIN');await lockReadingRunAuthority(a,run);await assertGenerationDispatch(a,run);
  const writer=b.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);await waitForLockWaiter(db.pool);await a.query('COMMIT');await writer;await b.query('COMMIT');await expect(assertGenerationDispatch(db.pool,run)).rejects.toMatchObject({statusCode:403});
  await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":true,"allow_local_provider_egress":true}' WHERE id=$1`,[CONNECTION]);
  await a.query('BEGIN');await b.query('BEGIN');await b.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}' WHERE id=$1`,[CONNECTION]);const reader=lockReadingRunAuthority(a,run);await waitForLockWaiter(db.pool);await b.query('COMMIT');await reader;await expect(assertGenerationDispatch(a,run)).rejects.toMatchObject({statusCode:403});await a.query('ROLLBACK');
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
});
it('model-supplied artifacts, proposals and delegation do not become side effects of generation',async()=>{
 const g=await startReadingGeneration(db.pool,identity,await request());const run=(await w.runs().getRun(SPACE,g.id))!;
 const {RunMaterializationService}=await import('../src/modules/runs/materializationService.js');const {adapterFailureEnvelope}=await import('../src/modules/runs/orchestrationResults.js');const service=new RunMaterializationService(w.config(),db.pool);
 const envelope={...adapterFailureEnvelope(run,'synthetic','Synthetic boundary'),success:true,output_text:JSON.stringify(result),output_json:{artifacts:[{name:'Injected artifact',content:'Must not persist'}],proposed_changes:[{proposal_type:'memory_create',payload:{content:'Must not create'}}]},produced_artifact_paths:[{path:'/synthetic/should-not-be-read.txt'}]};
 const materialized=await service.materializeAdapterResult({run,adapterResult:envelope});expect(materialized.items).toEqual([]);expect(materialized.errors).toHaveLength(1);
 await settle(g.id,{...result,proposed_changes:[{proposal_type:'follow_up_task'}]});expect((await readReadingGeneration(db.pool,identity,g.id)).candidate_version_id).toBeNull();expect((await db.pool.query('SELECT count(*)::int n FROM proposals')).rows[0].n).toBe(0);
 const end=(await w.runs().getRun(SPACE,g.id))!;await service.finalizeRun(end);expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(1);
});
it('catalog retirement closes generation settlement without a draft, while owned cancellation survives maintenance revocation',async()=>{
 const first=await startReadingGeneration(db.pool,identity,await request());await db.pool.query(`UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2`,[SPACE,OWNER]);expect((await cancelReadingGeneration(db.pool,w.config(),identity,first.id)).status).toBe('cancelled');
 await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`,[SPACE,OWNER]);const input=await request();const next=await startReadingGeneration(db.pool,identity,{...input,retry_of:first.id});
 await db.pool.query(`UPDATE evolvable_assets SET status='archived' WHERE asset_key=$1`,[key]);await settle(next.id);expect((await readReadingGeneration(db.pool,identity,next.id)).visibility).toBe('withheld');expect((await db.pool.query(`SELECT count(*)::int n FROM evolvable_asset_versions WHERE content_json->'reading_generation'->>'origin_run_id'=$1`,[next.id])).rows[0].n).toBe(0);
});
it('refused adapter side effects produce real degraded status without a draft, then explicit bounded retry completes normally',async()=>{
 const input=await request(),g=await startReadingGeneration(db.pool,identity,input);
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home,hostId:HOST});
 worker.send({cmd:'policy',prompt:{answer:JSON.stringify(result)},adapterOutput:{artifacts:[{name:'forbidden',content:'must not persist'}],proposed_changes:[{proposal_type:'memory_create',payload:{content:'must not persist'}}],activities:[{summary:'must not persist'}]}});
 const degraded=await until(()=>readReadingGeneration(db.pool,identity,g.id),v=>v.status==='degraded','actual orchestration degraded',300);
 expect(degraded).toMatchObject({candidate_version_id:null,method:null,description:input.description});
 const original=(await w.runs().getRun(SPACE,g.id))!;expect(original.status).toBe('degraded');expect(original.output_json).toHaveProperty('result.structured_output.method',result.method);
 expect((await db.pool.query(`SELECT count(*)::int n FROM proposals`)).rows[0].n).toBe(0);expect((await db.pool.query(`SELECT count(*)::int n FROM artifacts WHERE run_id=$1`,[g.id])).rows[0].n).toBe(0);
 expect((await startReadingGeneration(db.pool,identity,input)).id).toBe(g.id);
 worker.send({cmd:'policy',adapterOutput:null});await settledCommands(worker);
 const [retry,duplicate]=await Promise.all([startReadingGeneration(db.pool,identity,{...input,retry_of:g.id}),startReadingGeneration(db.pool,identity,{...input,retry_of:g.id})]);expect(retry.id).not.toBe(g.id);expect(duplicate.id).toBe(retry.id);
 const ready=await until(()=>readReadingGeneration(db.pool,identity,retry.id),v=>v.status==='ready','successful degraded retry',300);expect(ready.method).toBe(result.method);expect((await startReadingGeneration(db.pool,identity,input)).id).toBe(retry.id);
 await runFinalizationReconcilerRegistry.entries().find(e=>e.key==='reading_method_generation')!.reconcile(db.pool,{...original,status:'succeeded'});
 expect((await readReadingGeneration(db.pool,identity,g.id)).candidate_version_id).toBeNull();expect((await readReadingGeneration(db.pool,identity,retry.id)).candidate_version_id).toBe(ready.candidate_version_id);
 expect((await db.pool.query(`SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json' ? 'reading_method_generation'`)).rows[0].n).toBe(2);
},60000);
it('degraded retry still requires a terminal generation of this item and consumes the three-per-day allowance',async()=>{
 const input=await request();let g=await startReadingGeneration(db.pool,identity,input);
 await expect(startReadingGeneration(db.pool,identity,{...input,retry_of:g.id})).rejects.toMatchObject({statusCode:409});
 for(let n=0;n<3;n++){
  await w.finishRun(g.id,JSON.stringify(result),'degraded');
  if(n===0){const other=await w.material('Other item');await expect(startReadingGeneration(db.pool,identity,{...input,item_id:other,retry_of:g.id})).rejects.toMatchObject({statusCode:409});}
  if(n<2)g=await startReadingGeneration(db.pool,identity,{...input,retry_of:g.id});
 }
 expect((await startReadingGeneration(db.pool,identity,input)).id).toBe(g.id);
 await expect(startReadingGeneration(db.pool,identity,{...input,retry_of:g.id})).rejects.toMatchObject({statusCode:429});
});
