import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {CONTENT_RETRIEVAL_JOB,type RetrievalBriefResponse,type RetrievalExplainResponse} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {buildModuleServer} from './support/moduleServer.js';
import {claimJobForHandler} from './support/jobClaim.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {artifactsModule} from '../src/modules/artifacts/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {RetrievalProjectionService} from '../src/modules/retrieval/projectionService.js';
import {persistRetrievalBriefArtifact} from '../src/modules/retrieval/artifacts/brief.js';
import {persistRetrievalExplainReportArtifact} from '../src/modules/retrieval/artifacts/explain.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {registerContentRetrievalJob} from '../src/modules/retrieval/contentRequests.js';
import {RetrievalArtifactWithheld} from '../src/modules/retrieval/artifactRelease.js';
import {contentDecisionFromDb} from '../src/modules/access/contentAccessQuery.js';
import {assertArtifactReadable} from '../src/modules/reader/repository.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {JobEffectLeaseLost} from '../src/modules/jobs/effectAuthority.js';
import {runKnowledgeReport} from '../src/modules/knowledge/reportWork.js';
import {insertArtifactRow} from '../src/modules/artifacts/reviewArtifactWriter.js';
import {ContextOpsService} from '../src/modules/contextOps/service.js';

const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,item:string,app:ReturnType<typeof buildModuleServer>;
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri});
const identity=()=>({spaceId:space,userId:owner});
const artifacts=async()=>Number((await db.pool.query('SELECT count(*)::int AS n FROM artifacts WHERE space_id=$1',[space])).rows[0].n);
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();item=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Lattice title',content:'Quantum lattice body',ownerUserId:owner,createdByUserId:owner,projectId:project});
 await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 app=buildModuleServer(config(),[knowledgeModule,artifactsModule,systemActionsModule]);__setAuthIdentityForTests(identity());
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

const briefResponse=()=>({
 brief:{answer:'PRIVATE derived answer',synthesized:true,citations:[{object_type:'knowledge_item',object_id:item,title:'Lattice title'}],gap_analysis:{stale:[],thin:[],low_coverage:false,uncited_claims:['PRIVATE gap'],contradictions:[],missing_topics:[]}},
 items:[{object_type:'knowledge_item',object_id:item,title:'Lattice title',score:1,matched_fields:['title'],snippet:null}],total:1,
}) as unknown as RetrievalBriefResponse;
const briefInput=()=>({spaceId:space,ownerUserId:owner,query:'quantum',maxResults:5,mode:'lexical' as const,includeTrace:false,surface:'knowledge_brief',response:briefResponse(),egressPolicySnapshot:{external_egress_enabled:false}});
const explainInput=()=>({spaceId:space,ownerUserId:owner,query:'quantum',maxResults:5,response:{target:{object_type:'knowledge_item',object_id:item,title:'Lattice title',visible:true,returned:true},match:{matched_fields:['title']},trace:{},diagnostic_codes:['target_returned']} as unknown as RetrievalExplainResponse});
/** Demote the item to another member's summary-only object (the canonical root decision). */
const demote=async(q:{query:(sql:string,args:unknown[])=>Promise<unknown>})=>{const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});await q.query("UPDATE space_objects SET access_level='summary',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[item,other]);};
/** Run `racing` while `holder` keeps an uncommitted write; commit only once `racing` waits on it. */
async function interleave<T>(write:(holder:import('pg').PoolClient)=>Promise<unknown>,racing:()=>Promise<T>):Promise<PromiseSettledResult<T>>{
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  await write(holder);
  let done=false;const running=racing().finally(()=>{done=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>done});
  expect(done,'the settlement must wait on the uncommitted writer').toBe(false);
  await holder.query('COMMIT');
  return (await Promise.allSettled([running]))[0]!;
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
}

describe('retrieval-derived Artifact settlement after provider I/O',()=>{
 it('writes nothing when the Job claim is lost between provider return and the Artifact INSERT',async()=>{
  const queued=await new PgJobQueueRepository(db.pool).enqueue({job_type:CONTENT_RETRIEVAL_JOB,space_id:space,user_id:owner,max_attempts:1,payload:{}});
  const job=await claimJobForHandler(db.pool,queued.id);
  const settled=await interleave(h=>h.query("UPDATE jobs SET status='failed' WHERE id=$1",[job.job_id]),()=>persistRetrievalBriefArtifact(db.pool,briefInput(),job));
  expect(settled.status).toBe('rejected');expect((settled as PromiseRejectedResult).reason).toBeInstanceOf(JobEffectLeaseLost);
  expect(await artifacts()).toBe(0);
 });
 it('writes nothing when a contributing object is demoted while the Brief settles',async()=>{
  const settled=await interleave(demote,()=>persistRetrievalBriefArtifact(db.pool,briefInput()));
  expect(settled.status).toBe('rejected');expect((settled as PromiseRejectedResult).reason).toBeInstanceOf(RetrievalArtifactWithheld);
  expect(await artifacts()).toBe(0);
 });
 it('rechecks the current maintenance role for an Explain report inside the settlement',async()=>{
  const settled=await interleave(h=>h.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]),()=>persistRetrievalExplainReportArtifact(db.pool,explainInput()));
  expect(settled.status).toBe('rejected');expect((settled as PromiseRejectedResult).reason).toBeInstanceOf(RetrievalArtifactWithheld);
  expect(await artifacts()).toBe(0);
 });
 it('still persists through the real worker while authority holds, under its claim',async()=>{
  const admitted=await app.inject({method:'POST',url:'/api/v1/actions/knowledge.retrieval.brief.request',payload:{query:'quantum',mode:'lexical',persist_artifact:true},headers:{'idempotency-key':randomUUID()}});
  expect(admitted.statusCode,admitted.body).toBe(202);const id=admitted.json().data.job_id;
  const registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const result=await registry.dispatch(await claimJobForHandler(db.pool,id));
  expect(result).toMatchObject({value:{artifact_id:expect.any(String)}});expect(await artifacts()).toBe(1);
 });
});

describe('retrieval-derived Artifact exits follow current contributing authority',()=>{
 it('withholds the whole Brief body and metadata from list, detail, export, the access decision and the Reader after a demotion',async()=>{
  const id=await persistRetrievalBriefArtifact(db.pool,briefInput());
  const detail=await app.inject({method:'GET',url:'/api/v1/artifacts/'+id});expect(detail.statusCode,detail.body).toBe(200);expect(detail.body).toContain('PRIVATE derived answer');
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+id+'/export'})).statusCode).toBe(200);
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',id)).toBe('full');
  await demote(db.pool);
  const withheld=await app.inject({method:'GET',url:'/api/v1/artifacts/'+id});expect(withheld.statusCode).toBe(200);
  expect(withheld.json()).toMatchObject({id,content:null,metadata_json:null,exportable:false,access_level:'summary'});expect(withheld.body).not.toContain('PRIVATE');
  const list=await app.inject({method:'GET',url:'/api/v1/artifacts?artifact_type=retrieval_brief'});expect(list.json().items).toMatchObject([{id,metadata_json:null}]);expect(list.body).not.toContain('PRIVATE');
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+id+'/export'})).statusCode).toBe(404);
  expect(await contentDecisionFromDb(db.pool,identity(),'artifact',id)).toBe('deny');
  await expect(assertArtifactReadable(db.pool,identity(),id,'gone')).rejects.toMatchObject({statusCode:404});
 });
 it('withholds an old Brief after its Source consent is withdrawn and an Explain report after the role is lost',async()=>{
  const {seedArxivSourceChain}=await import('./support/researchSeeds.js');const connection=randomUUID(),source=randomUUID();
  await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel:randomUUID(),space,owner,now:new Date().toISOString()});
  await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,connection_id,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared','full',$4,'external_url','Source',now(),now(),'excerpt_saved','summary_only',now(),now())",[source,space,owner,connection]);
  await db.pool.query("INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'knowledge',$3,'source_item',$4,now())",[randomUUID(),space,item,source]);
  const brief=await persistRetrievalBriefArtifact(db.pool,briefInput()),explain=await persistRetrievalExplainReportArtifact(db.pool,explainInput());
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+explain})).json().metadata_json).toMatchObject({target:{object_id:item}});
  await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]);
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+brief})).json()).toMatchObject({content:null,metadata_json:null});
  await db.pool.query("UPDATE source_connections SET status='active' WHERE id=$1",[connection]);
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+explain})).json().metadata_json).not.toBeNull();
  const explainCodes=async()=>(await new ContextOpsService(db.pool).getDrilldown({spaceId:space,userId:owner,section:'explain_reports',limit:5,registry:knowledgeRetrievalRegistry,includeAllSources:false})).artifacts.map(a=>a.diagnostic_codes);
  expect(await explainCodes()).toEqual([['target_returned']]);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+explain})).json()).toMatchObject({content:null,metadata_json:null});
  expect(await explainCodes()).toEqual([[]]);
 });
 it('refuses a demoted Brief as a claim-candidate source and keeps unrelated Artifacts unaffected',async()=>{
  const id=await persistRetrievalBriefArtifact(db.pool,briefInput());
  await expect(runKnowledgeReport(db.pool,identity(),'knowledge.claim.candidate_packet.create',{source_artifact_ids:[id],max_candidates:1})).resolves.toBeTruthy();
  const plain=await insertArtifactRow(db.pool,{spaceId:space,ownerUserId:owner,artifactType:'summary',title:'Plain',content:'plain body',metadata:{item_refs:[{object_type:'knowledge_item',object_id:item}]},canonicalFormat:'test.v1',visibility:'private'});
  await demote(db.pool);
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+plain})).json()).toMatchObject({content:'plain body'});
  const proposals=async()=>Number((await db.pool.query("SELECT count(*)::int AS n FROM proposals WHERE space_id=$1",[space])).rows[0].n);
  const before=await proposals();
  await expect(runKnowledgeReport(db.pool,identity(),'knowledge.claim.candidate_packet.create',{source_artifact_ids:[id]})).rejects.toMatchObject({statusCode:404});
  expect(await proposals()).toBe(before);
 });
});
