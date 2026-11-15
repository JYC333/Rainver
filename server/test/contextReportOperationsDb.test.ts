import {releaseContextReport} from '../src/modules/retrieval/contextReports.js';
import {MemoryMaintenanceJobCreateRequestSchema} from '@rainver/protocol';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {buildModuleServer} from './support/moduleServer.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {memoryModule} from '../src/modules/memory/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {artifactsModule} from '../src/modules/artifacts/index.js';
import {contextOpsModule} from '../src/modules/contextOps/index.js';
import {assertArtifactReadable} from '../src/modules/reader/repository.js';
import {createClaimCandidatePacketFromArtifacts} from '../src/modules/knowledge/claimCandidatePackets.js';
import {insertArtifactRow} from '../src/modules/artifacts/reviewArtifactWriter.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {proposalsModule,__setProposalIdentityForTests} from '../src/modules/proposals/index.js';
import {loadConfig} from '../src/config.js';


import {registerContentRetrievalJob} from '../src/modules/retrieval/contentRequests.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {claimJobForHandler} from './support/jobClaim.js';
import {jobToOut} from '../src/modules/jobs/routes.js';
import {seedSourceConnection} from './support/reviewPacketDatabase.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {RetrievalProjectionService} from '../src/modules/retrieval/projectionService.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {contentDecisionFromDb} from '../src/modules/access/contentAccessQuery.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,item:string,app:ReturnType<typeof buildModuleServer>;
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri});
const call=(operation:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+operation,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();item=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Lattice PRIVATE title',content:'Quantum lattice PRIVATE body',ownerUserId:owner,createdByUserId:owner,projectId:project});
 app=buildModuleServer(config(),[knowledgeModule,memoryModule,systemActionsModule,artifactsModule,contextOpsModule,proposalsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});__setProposalIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);__setProposalIdentityForTests(null);await app?.close();});
it('queues strict report intents once with content-free receipts and one attempt',async()=>{
 for(const op of ['knowledge.maintenance.scan','knowledge.eval.diagnostics.report','knowledge.claim.contradictions.scan','knowledge.relation.discovery.scan','knowledge.object_schema.suggestions.scan','memory.maintenance.scan','memory.maintenance.job.create','memory.consolidation.run']){
  const key=randomUUID(),first=await call(op,{},key);expect(first.statusCode,first.body).toBe(202);expect((await call(op,{},key)).json()).toEqual(first.json());expect(first.body).not.toContain('PRIVATE');
 }
 expect((await db.pool.query('SELECT id FROM jobs')).rows).toHaveLength(8);
 expect((await call('memory.maintenance.scan',{persist_report:false,create_packet:true})).statusCode).toBe(422);
});
it('executes reports in the existing Job and releases no body through generic Jobs',async()=>{
 for(const [op,domain] of [['knowledge.claim.contradictions.scan','knowledge'],['memory.maintenance.scan','memory'],['memory.consolidation.run','memory']] as const){
  const first=await call(op,{});expect(first.statusCode,first.body).toBe(202);const id=first.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const claim=await claimJobForHandler(db.pool,id),result=await registry.dispatch(claim);expect(await registry.dispatch(claim)).toEqual(result);await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
  const view=await app.inject({method:'GET',url:`/api/v1/${domain}/retrieval/requests/${id}`});expect(view.statusCode,view.body).toBe(200);expect(view.json().status).toBe('completed');expect(view.json().result,view.body).not.toBeNull();expect(jobToOut((await new PgJobQueueRepository(db.pool).getJob(id))!).result).toBeNull();
 }
});
it('withholds the whole old report including counts after summary demotion',async()=>{
 const value={report:{findings:[{from_claim:{claim_id:item,title:'PRIVATE'}}],counts:{sensitive_count:1}}};
 expect((await releaseContextReport(db.pool,{spaceId:space,userId:owner},'knowledge.claim.contradictions.scan',{},value)).result).toEqual(value);
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});await db.pool.query("UPDATE space_objects SET access_level='summary',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[item,other]);
 expect(await releaseContextReport(db.pool,{spaceId:space,userId:owner},'knowledge.claim.contradictions.scan',{},value)).toEqual({result:null,withheld:1});
});
it('refuses execution after role withdrawal before writing an Artifact',async()=>{
 const first=await call('knowledge.claim.contradictions.scan',{});expect(first.statusCode,first.body).toBe(202);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 const registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());await expect(registry.dispatch(await claimJobForHandler(db.pool,first.json().data.job_id))).rejects.toThrow('Report not found');expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
});
it('keeps unavailable Memory access-log and invalid advisory trajectory requests refused',async()=>{
 expect((await app.inject({method:'GET',url:'/api/v1/memory/access-logs'})).statusCode).toBe(404);
 expect((await app.inject({method:'GET',url:'/api/v1/knowledge/claims/trajectory'})).statusCode).toBe(422);
});
it('checks scan opt-in, Space-wide review scope and unsupported provider flags before enqueue',async()=>{
 expect((await call('knowledge.claim.contradictions.scan',{llm_judge_enabled:true})).statusCode).toBe(422);
 expect((await call('knowledge.relation.discovery.scan',{llm_extraction_enabled:true})).statusCode).toBe(422);
 expect((await call('knowledge.eval.diagnostics.report',{review_scope:'space_ops'})).statusCode).toBe(404);
 await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 expect((await call('knowledge.eval.report',{})).statusCode).toBe(404);
 expect((await call('memory.maintenance.scan',{})).statusCode).toBe(404);
 const {updateSpaceRetrievalSettings}=await import('../src/modules/retrieval/settings.js');await updateSpaceRetrievalSettings(db.pool,space,{context_ops_scan_mode:'members'});
 expect((await call('memory.maintenance.scan',{})).statusCode).toBe(202);
});
it('creates only private report and packet identities, with no active Memory writes',async()=>{
 const {insertMemoryEntry}=await import('./support/memoryFixtures.js');const memory=randomUUID();await insertMemoryEntry(db.pool,space,{id:memory,owner_user_id:owner,subject_user_id:owner,title:'PRIVATE thin Memory',content:'x',namespace:'test',created_by:'user:'+owner});
 const first=await call('memory.maintenance.scan',{persist_report:true,create_packet:true,thin_content_chars:80});expect(first.statusCode,first.body).toBe(202);
 const id=first.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const result=await registry.dispatch(await claimJobForHandler(db.pool,id));await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
 const view=await app.inject({method:'GET',url:'/api/v1/memory/retrieval/requests/'+id});expect(view.statusCode,view.body).toBe(200);expect(view.json().result).toMatchObject({artifact_id:expect.any(String),proposal_id:expect.any(String)});
 const row=(await db.pool.query('SELECT visibility FROM artifacts WHERE id=$1',[view.json().result.artifact_id])).rows[0];expect(row.visibility).toBe('private');expect((await db.pool.query('SELECT content FROM memory_entries WHERE id=$1',[memory])).rows[0].content).toBe('x');
});
it('runs the retained report variants and one owned maintenance Job page through current readers',async()=>{
 let sourceArtifact:string|undefined,maintenanceJob:string|undefined;
 for(const [op,body,domain] of [
  ['knowledge.maintenance.scan',{persist_report:true},'knowledge'],
  ['knowledge.eval.report',{source:'test',counts:{queries:2}},'knowledge'],
  ['knowledge.eval.calibration.record',{decisions:[{mechanic:'autocut',decision:'defer',access_safety_proof:'No ranking change'}]},'knowledge'],
  ['knowledge.eval.diagnostics.report',{create_packet:true},'knowledge'],
  ['knowledge.relation.discovery.scan',{},'knowledge'],
  ['knowledge.object_schema.suggestions.scan',{},'knowledge'],
  ['memory.maintenance.job.create',{persist_report:true},'memory'],
 ] as const){
  const admitted=await call(op,body);expect(admitted.statusCode,admitted.body).toBe(202);const id=admitted.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const result=await registry.dispatch(await claimJobForHandler(db.pool,id));await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
  const view=await app.inject({method:'GET',url:`/api/v1/${domain}/retrieval/requests/${id}`});expect(view.statusCode,view.body).toBe(200);expect(view.json().result,view.body).not.toBeNull();if(op==='knowledge.maintenance.scan')sourceArtifact=view.json().result.artifact_id;if(op==='memory.maintenance.job.create')maintenanceJob=view.json().result.id;
 }
 for(const [op,body,domain] of [['knowledge.claim.candidate_packet.create',{source_artifact_ids:[sourceArtifact]},'knowledge'],['memory.maintenance.job.run',{job_id:maintenanceJob},'memory']] as const){
  const admitted=await call(op,body);expect(admitted.statusCode,admitted.body).toBe(202);const id=admitted.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const result=await registry.dispatch(await claimJobForHandler(db.pool,id));await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');const view=await app.inject({method:'GET',url:`/api/v1/${domain}/retrieval/requests/${id}`});expect(view.statusCode,view.body).toBe(200);expect(view.json().result,view.body).not.toBeNull();
 }
});
it('refuses running another person’s shared maintenance Job as its owner',async()=>{
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});const {createMemoryMaintenanceJob}=await import('../src/modules/memory/maintenanceJobs.js');const job=await createMemoryMaintenanceJob(db.pool,{spaceId:space,ownerUserId:other,request:MemoryMaintenanceJobCreateRequestSchema.parse({})});
 expect((await call('memory.maintenance.job.run',{job_id:job.id})).statusCode).toBe(404);
});
it('rolls back report persistence with a refused packet and does not execute a cancelled claim',async()=>{
 const {insertMemoryEntry}=await import('./support/memoryFixtures.js');await insertMemoryEntry(db.pool,space,{id:randomUUID(),owner_user_id:owner,subject_user_id:owner,title:'Thin',content:'x',namespace:'test',created_by:'user:'+owner});
 await db.pool.query("CREATE FUNCTION refuse_context_packet() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.proposal_type='memory_maintenance_packet' THEN RAISE EXCEPTION 'packet persistence refused'; END IF; RETURN NEW; END $$");
 await db.pool.query('CREATE TRIGGER refuse_context_packet BEFORE INSERT ON proposals FOR EACH ROW EXECUTE FUNCTION refuse_context_packet()');
 try{
  const admitted=await call('memory.maintenance.scan',{persist_report:true,create_packet:true});expect(admitted.statusCode,admitted.body).toBe(202);const registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());await expect(registry.dispatch(await claimJobForHandler(db.pool,admitted.json().data.job_id))).rejects.toThrow('packet persistence refused');
  expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);expect((await db.pool.query('SELECT id FROM proposals')).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER refuse_context_packet ON proposals');await db.pool.query('DROP FUNCTION refuse_context_packet()');}
 const next=await call('knowledge.eval.report',{}),id=next.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const claim=await claimJobForHandler(db.pool,id);await db.pool.query("UPDATE jobs SET status='cancelled' WHERE id=$1",[id]);await expect(registry.dispatch(claim)).rejects.toThrow('no longer owns');expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
});
describe('report poll release applies the canonical Source policy gate',()=>{
 let connection:string;
 const consent=(admins:boolean)=>({schema_version:1,owner_user_id:sourceOwner,allowed_reader_user_ids:[],allowed_agent_ids:[],allow_space_admins:admins});
 let sourceOwner:string;
 const CONSENT_SQL='UPDATE source_connections SET consent_json=$2::jsonb WHERE id=$1';
 beforeEach(async()=>{
  sourceOwner=randomUUID();connection=randomUUID();const sourceItem=randomUUID();
  await seedSpaceMember(db.pool,{space,user:sourceOwner});
  await seedSourceConnection(db.pool,{id:connection,space,owner:sourceOwner,consent:consent(true),policy:{schema_version:1,source_egress_class:'internal_only'}});
  await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,connection_id,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared','full',$4,'external_url','Source',now(),now(),'excerpt_saved','summary_only',now(),now())",[sourceItem,space,sourceOwner,connection]);
  await db.pool.query("INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'knowledge',$3,'source_item',$4,now())",[randomUUID(),space,item,sourceItem]);
  await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 });
 /** A real maintenance scan whose finding names the Source-derived item. */
 async function scanned(){
  const admitted=await call('knowledge.maintenance.scan',{});expect(admitted.statusCode,admitted.body).toBe(202);
  const id=admitted.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());
  await new PgJobQueueRepository(db.pool).completeJob(id,await registry.dispatch(await claimJobForHandler(db.pool,id)),'test');
  const poll=()=>app.inject({method:'GET',url:'/api/v1/knowledge/retrieval/requests/'+id});
  const view=await poll();expect(view.statusCode,view.body).toBe(200);expect(view.body).toContain('Lattice PRIVATE title');
  return poll;
 }
 const expectWithheld=(body:string,json:{result:unknown})=>{expect(json.result).toBeNull();expect(body).not.toContain('PRIVATE');expect(body).not.toContain(item);};
 it('withholds the whole report once the Source read consent is withdrawn, though the Knowledge root stays full',async()=>{
  const poll=await scanned();
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
  expect(await contentDecisionFromDb(db.pool,{spaceId:space,userId:owner},'space_object',item)).toBe('full');
  const view=await poll();expect(view.statusCode).toBe(200);expectWithheld(view.body,view.json());
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(true))]);
  expect((await poll()).body).toContain('Lattice PRIVATE title');
 });
 it('withholds the report when the withdrawal commits while the poll waits on the closure',async()=>{
  const poll=await scanned();
  const holder=await db.pool.connect();
  try{
   await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   await holder.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
   let done=false;const running=poll().finally(()=>{done=true;});
   await waitForBlockedBy(db.pool,pid,{settled:()=>done});
   expect(done,'the poll must wait on the uncommitted withdrawal').toBe(false);
   await holder.query('COMMIT');
   const view=await running;expect(view.statusCode).toBe(200);expectWithheld(view.body,view.json());
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
 });

 // A persisted report is the same derived body as its poll result: every
 // Artifact and Context Ops exit passes the same current closure.
 async function persisted(op:'knowledge.maintenance.scan'|'memory.maintenance.scan',body:object){
  const admitted=await call(op,{persist_report:true,create_packet:true,...body});expect(admitted.statusCode,admitted.body).toBe(202);
  const id=admitted.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());
  await new PgJobQueueRepository(db.pool).completeJob(id,await registry.dispatch(await claimJobForHandler(db.pool,id)),'test');
  const artifact=String((await db.pool.query('SELECT id FROM artifacts WHERE artifact_type=$1 ORDER BY created_at DESC LIMIT 1',[op==='knowledge.maintenance.scan'?'retrieval_maintenance_report':'memory_maintenance_report'])).rows[0].id);
  return {artifact,poll:()=>app.inject({method:'GET',url:`/api/v1/${op.split('.')[0]}/retrieval/requests/${id}`})};
 }
 const identity=()=>({spaceId:space,userId:owner});
 const exits=async(artifact:string)=>({
  detail:await app.inject({method:'GET',url:'/api/v1/artifacts/'+artifact}),
  list:await app.inject({method:'GET',url:'/api/v1/artifacts'}),
  exported:await app.inject({method:'GET',url:'/api/v1/artifacts/'+artifact+'/export'}),
  summary:await app.inject({method:'GET',url:'/api/v1/context-ops/summary'}),
  drill:await app.inject({method:'GET',url:'/api/v1/context-ops/drilldown?section=maintenance_reports'}),
  decision:await contentDecisionFromDb(db.pool,identity(),'artifact',artifact),
  reader:await assertArtifactReadable(db.pool,identity(),artifact,'gone').then(()=>'readable',(e:{statusCode?:number})=>e.statusCode),
 });
 async function expectReleased(artifact:string,secret:string){
  const e=await exits(artifact);
  expect(e.detail.statusCode).toBe(200);expect(e.detail.body).toContain(secret);expect(e.detail.json().title).toMatch(/findings/);
  expect(e.list.body).toContain(secret);expect(e.exported.statusCode).toBe(200);expect(e.exported.body).toContain(secret);
  expect(e.decision).toBe('full');expect(e.reader).toBe('readable');
  expect(Object.keys(e.summary.json().maintenance.finding_counts).length,e.summary.body).toBeGreaterThan(0);
  expect(e.summary.json().maintenance.recent_packets[0].title).toMatch(/findings/);
  const row=e.drill.json().artifacts.find((a:{artifact_id:string})=>a.artifact_id===artifact);expect(row.finding_count).toBeGreaterThan(0);expect(row.title).toMatch(/findings/);
 }
 async function expectWithheldEverywhere(artifact:string,secrets:string[]){
  const e=await exits(artifact);
  expect(e.detail.statusCode).toBe(200);expect(e.detail.json()).toMatchObject({id:artifact,content:null,metadata_json:null,exportable:false,access_level:'summary'});
  for(const body of [e.detail.body,e.list.body,e.summary.body,e.drill.body])for(const secret of [...secrets,'findings'])expect(body).not.toContain(secret);
  expect(e.list.json().items.find((a:{id:string})=>a.id===artifact)).toMatchObject({metadata_json:null,exportable:false});
  expect(e.exported.statusCode).toBe(404);expect(e.decision).toBe('deny');expect(e.reader).toBe(404);
  expect(e.summary.json().maintenance.finding_counts).toEqual({});
  const row=e.drill.json().artifacts.find((a:{artifact_id:string})=>a.artifact_id===artifact);expect(row).toMatchObject({finding_count:null,diagnostic_codes:[]});
 }
 it('withholds a persisted maintenance report at every Artifact, Reader and Context Ops exit once Source consent is withdrawn, and releases it again',async()=>{
  const {artifact,poll}=await persisted('knowledge.maintenance.scan',{});
  await expectReleased(artifact,'Lattice PRIVATE title');
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
  expect(await contentDecisionFromDb(db.pool,identity(),'space_object',item)).toBe('full');
  expect((await poll()).json().result).toBeNull();
  await expectWithheldEverywhere(artifact,['PRIVATE',item]);
  // A withheld report cannot seed a Claim Candidate Packet either.
  await expect(createClaimCandidatePacketFromArtifacts(db.pool,{spaceId:space,ownerUserId:owner,request:{source_artifact_ids:[artifact],max_candidates:5,review_scope:'private',promote_private_sources_to_space_ops:false}})).rejects.toMatchObject({statusCode:404});
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(true))]);
  await expectReleased(artifact,'Lattice PRIVATE title');
 });
 it('withholds a persisted Memory maintenance report whose Memory derives from the withdrawn Source',async()=>{
  const {insertMemoryEntry}=await import('./support/memoryFixtures.js');const memory=randomUUID();
  await insertMemoryEntry(db.pool,space,{id:memory,owner_user_id:owner,subject_user_id:owner,title:'Memory PRIVATE thin',content:'x',namespace:'test',created_by:'user:'+owner});
  const sourceItem=String((await db.pool.query('SELECT id FROM source_items WHERE connection_id=$1',[connection])).rows[0].id);
  await db.pool.query("INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'memory',$3,'source_item',$4,now())",[randomUUID(),space,memory,sourceItem]);
  const {artifact}=await persisted('memory.maintenance.scan',{thin_content_chars:80});
  const before=await app.inject({method:'GET',url:'/api/v1/artifacts/'+artifact});expect(before.body).toContain('Memory PRIVATE thin');
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
  const after=await app.inject({method:'GET',url:'/api/v1/artifacts/'+artifact});
  expect(after.json()).toMatchObject({content:null,metadata_json:null,title:'Memory maintenance report'});expect(after.body).not.toContain('PRIVATE');expect(after.body).not.toContain(memory);
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',artifact)).toBe('deny');
 });
 it('withholds a persisted report when the withdrawal commits while the Artifact read waits on the closure',async()=>{
  const {artifact}=await persisted('knowledge.maintenance.scan',{});
  const holder=await db.pool.connect();
  try{
   await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   await holder.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
   let done=false;const running=app.inject({method:'GET',url:'/api/v1/artifacts/'+artifact}).finally(()=>{done=true;});
   await waitForBlockedBy(db.pool,pid,{settled:()=>done});
   expect(done,'the read must wait on the uncommitted withdrawal').toBe(false);
   await holder.query('COMMIT');
   const view=await running;expect(view.json()).toMatchObject({content:null,metadata_json:null});expect(view.body).not.toContain('PRIVATE');
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
 });
 it('fails closed on a stored maintenance report whose findings name no checkable objects, and withholds a report after its author loses Context Ops scan authority',async()=>{
  const legacy=await insertArtifactRow(db.pool,{spaceId:space,ownerUserId:owner,artifactType:'retrieval_maintenance_report',title:'Retrieval Maintenance Report: 1 findings',content:'{"findings":[{"kind":"thin","title":"Legacy PRIVATE"}]}',metadata:{findings:[{kind:'thin',title:'Legacy PRIVATE'}],counts:{thin:1}},canonicalFormat:'retrieval_maintenance_report.v1',visibility:'private',runId:null,createdAt:new Date().toISOString()});
  const legacyView=await app.inject({method:'GET',url:'/api/v1/artifacts/'+legacy});expect(legacyView.json()).toMatchObject({content:null,metadata_json:null});expect(legacyView.body).not.toContain('PRIVATE');
  const {artifact}=await persisted('knowledge.maintenance.scan',{});
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  const view=await app.inject({method:'GET',url:'/api/v1/artifacts/'+artifact});expect(view.json()).toMatchObject({content:null,metadata_json:null});expect(view.body).not.toContain('PRIVATE');
 });
 it('aggregates a released diagnostics report in Context Ops and drops its codes once the reader loses Context Ops scan authority',async()=>{
  // A diagnostics report recording a complete, legitimately empty dependency
  // closure is released; the same body without the closure contract (an
  // older record) fails closed rather than being read as "no dependencies".
  const diag=await insertArtifactRow(db.pool,{spaceId:space,ownerUserId:owner,artifactType:'retrieval_eval_report',title:'Diagnostics',content:'{}',metadata:{source:'product_diagnostic',suite:'retrieval_quality_feedback_loop',review_scope:'private',diagnostic_codes:['low_coverage'],metrics:{recall_delta:-0.2},dependency_closure:{version:1},source_artifact_ids:[]},canonicalFormat:'retrieval_eval_report.v1',visibility:'private',runId:null,createdAt:new Date().toISOString()});
  const legacy=await insertArtifactRow(db.pool,{spaceId:space,ownerUserId:owner,artifactType:'retrieval_eval_report',title:'Diagnostics',content:'{}',metadata:{source:'product_diagnostic',suite:'retrieval_quality_feedback_loop',review_scope:'private',diagnostic_codes:['legacy_code'],metrics:{recall_delta:-0.2}},canonicalFormat:'retrieval_eval_report.v1',visibility:'private',runId:null,createdAt:new Date(Date.now()-60_000).toISOString()});
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',legacy)).toBe('deny');
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+legacy})).json()).toMatchObject({metadata_json:null,content:null});
  const read=async()=>({summary:(await app.inject({method:'GET',url:'/api/v1/context-ops/summary'})).json(),drill:(await app.inject({method:'GET',url:'/api/v1/context-ops/drilldown?section=diagnostics_reports'})).json()});
  const released=await read();
  expect(released.summary.diagnostics).toMatchObject({diagnostic_code_counts:{low_coverage:1},trend_metric_deltas:{recall_delta:-0.2}});
  expect(released.drill.artifacts.find((a:{artifact_id:string})=>a.artifact_id===diag)).toMatchObject({diagnostic_codes:['low_coverage']});
  expect(JSON.stringify(released)).not.toContain('legacy_code');
  // The demoted member no longer passes the Context Ops route, so read the service as that member.
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  const {ContextOpsService}=await import('../src/modules/contextOps/service.js');
  const withheld=await new ContextOpsService(db.pool).getSummary({spaceId:space,userId:owner,windowDays:30,limit:10});
  expect(withheld.diagnostics).toMatchObject({recent_report_count:2,diagnostic_code_counts:{},trend_metric_deltas:{}});
 });

 // Producers that aggregate: the stored body must record every contributing
 // object and intermediate report, so a later withdrawal reaches it.
 async function runReport(op:string,body:object){
  const admitted=await call(op,body);expect(admitted.statusCode,admitted.body).toBe(202);
  const id=admitted.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());
  await new PgJobQueueRepository(db.pool).completeJob(id,await registry.dispatch(await claimJobForHandler(db.pool,id)),'test');
  return ()=>app.inject({method:'GET',url:'/api/v1/knowledge/retrieval/requests/'+id});
 }
 const latest=async(type:string)=>String((await db.pool.query('SELECT id FROM artifacts WHERE artifact_type=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[type])).rows[0].id);
 const latestProposal=async(type:string)=>String((await db.pool.query('SELECT id FROM proposals WHERE proposal_type=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[type])).rows[0].id);
 it('withholds a persisted diagnostics report, its packet Proposal and every exit once a contributing maintenance report loses its Source consent, and refuses accepting the packet',async()=>{
  await persisted('knowledge.maintenance.scan',{});
  const maintenance=await latest('retrieval_maintenance_report');
  const poll=await runReport('knowledge.eval.diagnostics.report',{create_packet:true});
  const diag=await latest('retrieval_eval_report'),packet=await latestProposal('retrieval_diagnostics_packet');
  const view=async()=>({
   detail:await app.inject({method:'GET',url:'/api/v1/artifacts/'+diag}),
   list:await app.inject({method:'GET',url:'/api/v1/artifacts'}),
   exported:await app.inject({method:'GET',url:'/api/v1/artifacts/'+diag+'/export'}),
   drill:await app.inject({method:'GET',url:'/api/v1/context-ops/drilldown?section=diagnostics_reports'}),
   summary:await app.inject({method:'GET',url:'/api/v1/context-ops/summary'}),
   proposal:await app.inject({method:'GET',url:'/api/v1/proposals/'+packet}),
   proposals:await app.inject({method:'GET',url:'/api/v1/proposals?status=pending'}),
   poll:await poll(),
   decision:await contentDecisionFromDb(db.pool,identity(),'artifact',diag),
   reader:await assertArtifactReadable(db.pool,identity(),diag,'gone').then(()=>'readable',(e:{statusCode?:number})=>e.statusCode),
  });
  const before=await view();
  expect(before.detail.json().metadata_json.source_artifact_ids).toContain(maintenance);
  expect(before.detail.body).toContain('maintenance_findings_present');
  expect(before.proposal.json().proposed_content).toContain('maintenance_findings_present');
  expect(before.proposals.body).toContain('maintenance_findings_present');
  expect(before.poll.json().result.diagnostic_codes).toContain('maintenance_findings_present');
  expect(before.decision).toBe('full');expect(before.reader).toBe('readable');
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
  const after=await view();
  for(const body of [after.detail.body,after.list.body,after.exported.body,after.drill.body,after.summary.body,after.proposal.body,after.proposals.body,after.poll.body])expect(body).not.toContain('maintenance_findings_present');
  expect(after.detail.json()).toMatchObject({content:null,metadata_json:null,exportable:false});
  expect(after.exported.statusCode).toBe(404);expect(after.poll.json().result).toBeNull();
  expect(after.decision).toBe('deny');expect(after.reader).toBe(404);
  expect(after.proposal.json()).toMatchObject({id:packet,status:'pending',proposed_content:'',proposed_title:'Retrieval diagnostics packet'});
  const accept=await app.inject({method:'POST',url:'/api/v1/proposals/'+packet+'/accept',headers:{'idempotency-key':randomUUID()}});
  expect(accept.statusCode,accept.body).toBe(409);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[packet])).rows[0].status).toBe('pending');
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(true))]);
  const again=await view();
  expect(again.detail.body).toContain('maintenance_findings_present');expect(again.proposal.json().proposed_content).toContain('maintenance_findings_present');
  expect((await app.inject({method:'POST',url:'/api/v1/proposals/'+packet+'/accept',headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(200);
 });
 it('records the Source-derived objects behind each schema suggestion and withholds the persisted report once their consent is withdrawn; an unused-kind report with no dependencies stays released',async()=>{
  // A fresh Space registers no object kinds: the item's own kind is a missing profile.
  const kind=String((await db.pool.query('SELECT knowledge_kind FROM knowledge_items WHERE object_id=$1',[item])).rows[0].knowledge_kind);
  const poll=await runReport('knowledge.object_schema.suggestions.scan',{base_object_types:['knowledge_item']});
  const report=await latest('object_schema_suggestion_report');
  const before=await app.inject({method:'GET',url:'/api/v1/artifacts/'+report});
  const finding=before.json().metadata_json.findings.find((f:{object_profile:string})=>f.object_profile===kind);
  expect(finding).toMatchObject({kind:'missing_object_profile',visible_usage_count:1,evidence_refs:[{object_type:'knowledge_item',object_id:item}]});
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
  const after=await app.inject({method:'GET',url:'/api/v1/artifacts/'+report});
  expect(after.json()).toMatchObject({content:null,metadata_json:null,title:'Object schema suggestion report'});
  expect(after.body).not.toContain('missing_object_profile');expect((await poll()).json().result).toBeNull();
  // Legitimately empty: the only observed rows are gone from this person's
  // view, so the new report names no object and is released whole.
  await runReport('knowledge.object_schema.suggestions.scan',{base_object_types:['knowledge_item']});
  const empty=await latest('object_schema_suggestion_report');
  const emptyView=await app.inject({method:'GET',url:'/api/v1/artifacts/'+empty});
  expect(emptyView.json().metadata_json).toMatchObject({dependency_closure:{version:1},findings:[]});expect(emptyView.json().title).toBe('Object schema suggestions (0)');
  // A stored usage finding without its object closure (an older record) fails closed.
  const legacy=await insertArtifactRow(db.pool,{spaceId:space,ownerUserId:owner,artifactType:'object_schema_suggestion_report',title:'Object schema suggestions (1)',content:'{}',metadata:{review_scope:'private',findings:[{kind:'missing_object_profile',object_profile:'legacy_kind',visible_usage_count:3,evidence_refs:[]}]},canonicalFormat:'object_schema_suggestion_report.v1',visibility:'private',runId:null,createdAt:new Date().toISOString()});
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',legacy)).toBe('deny');
 });
 it('withholds a review packet Proposal whose report is withheld while the read waits on the uncommitted withdrawal',async()=>{
  await persisted('knowledge.maintenance.scan',{});
  const packet=await latestProposal('retrieval_maintenance_packet');
  expect((await app.inject({method:'GET',url:'/api/v1/proposals/'+packet})).json().proposed_title).toMatch(/\d+ findings/);
  const holder=await db.pool.connect();
  try{
   await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   await holder.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
   let done=false;const running=app.inject({method:'GET',url:'/api/v1/proposals/'+packet}).finally(()=>{done=true;});
   await waitForBlockedBy(db.pool,pid,{settled:()=>done});
   expect(done,'the Proposal read must wait on the uncommitted withdrawal').toBe(false);
   await holder.query('COMMIT');
   const view=await running;expect(view.statusCode).toBe(200);
   expect(view.json()).toMatchObject({id:packet,status:'pending',proposed_title:'Retrieval maintenance packet',proposed_content:'',rationale:''});expect(view.body).not.toContain('PRIVATE');expect(view.body).not.toMatch(/\d+ findings/);
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
 });
 it('releases an observation report by its recorded contributing reports: withdrawn once a counted maintenance report is withheld, legitimately empty released, unstamped fails closed',async()=>{
  await persisted('knowledge.maintenance.scan',{});
  const maintenance=await latest('retrieval_maintenance_report');
  const observation=(sources:string[]|undefined)=>insertArtifactRow(db.pool,{spaceId:space,ownerUserId:owner,artifactType:'context_observation_report',title:'Context Observation Report',content:'{}',metadata:{kind:'context_observation_report',observations:[{severity:'yellow',summary:'2 maintenance finding(s), 1 pending review packet(s).'}],...(sources?{source_artifact_ids:sources,dependency_closure:{version:1}}:{})},canonicalFormat:'context_observation_report.v1',visibility:'private',runId:null,createdAt:new Date().toISOString()});
  const counted=await observation([maintenance]),empty=await observation([]),legacy=await observation(undefined);
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',counted)).toBe('full');
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',empty)).toBe('full');
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',legacy)).toBe('deny');
  await db.pool.query(CONSENT_SQL,[connection,JSON.stringify(consent(false))]);
  const view=await app.inject({method:'GET',url:'/api/v1/artifacts/'+counted});
  expect(view.json()).toMatchObject({metadata_json:null,content:null});expect(view.body).not.toContain('maintenance finding');
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',empty)).toBe('full');
 });
 it('names the frozen report dependencies of packets and their generated children; a packet without its report cannot be checked',async()=>{
  const {proposalReportDependencies}=await import('../src/modules/retrieval/proposalReportDependencies.js');
  expect(proposalReportDependencies('retrieval_maintenance_packet',{report_artifact_id:'r1'})).toEqual({artifactIds:['r1'],malformed:false});
  expect(proposalReportDependencies('retrieval_diagnostics_packet',{})).toEqual({artifactIds:[],malformed:true});
  expect(proposalReportDependencies('object_relation_create',{source_maintenance_report_artifact_id:'r2',provenance_entries:[{source_type:'artifact',source_id:'r2',source_trust:'derived_review'},{source_type:'proposal',source_id:'p1',source_trust:'derived_review'}]})).toEqual({artifactIds:['r2'],malformed:false});
  expect(proposalReportDependencies('claim_create',{source_candidate_packet_artifact_id:'c1'})).toEqual({artifactIds:['c1'],malformed:false});
  expect(proposalReportDependencies('memory_create',{proposed_content:'x'})).toBeNull();
 });
 it('fails closed on a cycle of report Artifacts that name each other instead of recursing',async()=>{
  const a=randomUUID(),b=randomUUID();
  const row=(id:string,other:string)=>insertArtifactRow(db.pool,{id,spaceId:space,ownerUserId:owner,artifactType:'retrieval_calibration_decision',title:'Calibration',content:'{}',metadata:{review_scope:'private',decisions:[],evidence_artifacts:[{artifact_id:other}]},canonicalFormat:'retrieval_calibration_decision.v1',visibility:'private',runId:null,createdAt:new Date().toISOString()});
  await row(a,b);await row(b,a);
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',a)).toBe('deny');
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+b})).json()).toMatchObject({metadata_json:null});
 });
});
