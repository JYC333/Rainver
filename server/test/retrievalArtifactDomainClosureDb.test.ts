import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {AskSpaceDomain,RetrievalBriefResponse,RetrievalObjectType} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {buildModuleServer} from './support/moduleServer.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {artifactsModule} from '../src/modules/artifacts/index.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {RetrievalProjectionService} from '../src/modules/retrieval/projectionService.js';
import {persistRetrievalBriefArtifact} from '../src/modules/retrieval/artifacts/brief.js';
import {RetrievalArtifactWithheld} from '../src/modules/retrieval/artifactRelease.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {inquiryRetrievalRegistry} from '../src/modules/inquiry/retrievalAdapter.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {ContentAccessService} from '../src/modules/contentAccess/service.js';
import {contentDecisionFromDb} from '../src/modules/access/contentAccessQuery.js';
import {assertArtifactReadable} from '../src/modules/reader/repository.js';
import {AskSpaceService} from '../src/modules/askSpace/service.js';
import {insertArtifactRow} from '../src/modules/artifacts/reviewArtifactWriter.js';
import {PgKnowledgeRepository} from '../src/modules/knowledge/repository.js';
import {InquiryIterationService} from '../src/modules/inquiry/iterationService.js';
import {lockActiveProjectForMutation} from '../src/modules/projects/access.js';
import {ProposalApplierRegistry} from '../src/modules/proposals/applierRegistry.js';
import {registerKnowledgeProposalAppliers} from '../src/modules/knowledge/proposalApplier.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
import {withheldReleaseRefs,type ReleaseGroup} from '../src/modules/retrieval/releaseClosure.js';
import {withQueryableTransaction} from '../src/modules/routeUtils/common.js';

const db=useTestDatabase(import.meta.filename,{max:8});
let space:string,owner:string,viewer:string,project:string,thread:string,item:string,app:ReturnType<typeof buildModuleServer>;
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri});
const as=(userId:string)=>__setAuthIdentityForTests({spaceId:space,userId});
const count=async(type?:string)=>Number((await db.pool.query('SELECT count(*)::int AS n FROM artifacts WHERE space_id=$1 AND ($2::text IS NULL OR artifact_type=$2)',[space,type??null])).rows[0].n);
const detail=(id:string)=>app.inject({method:'GET',url:'/api/v1/artifacts/'+id});
const call=(id:string,input:object)=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':randomUUID()}});

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();viewer=randomUUID();project=randomUUID();item=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await seedSpaceMember(db.pool,{space,user:viewer});
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,viewer]);
 thread=String((await new InquiryThreadService(db.pool).createThread({spaceId:space,userId:owner},project,{kind:'question',statement:'Why does the lattice drift?'})).id);
 await new RetrievalProjectionService(db.pool,inquiryRetrievalRegistry).reindexAll(space);
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Lattice note',content:'Viewer lattice body',ownerUserId:viewer,createdByUserId:viewer,projectId:project});
 await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 app=buildModuleServer(config(),[artifactsModule,projectsModule,systemActionsModule]);as(viewer);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

const ref=(object_type:RetrievalObjectType,object_id:string)=>({object_type,object_id,title:'T '+object_id});
const response=(type:RetrievalObjectType,id:string,answer='PRIVATE derived answer')=>({
 brief:{answer,synthesized:true,citations:[ref(type,id)],gap_analysis:{stale:[],thin:[],low_coverage:false,uncited_claims:[],contradictions:[],missing_topics:[]}},
 items:[{...ref(type,id),score:1,matched_fields:['title'],snippet:null}],total:1,
}) as unknown as RetrievalBriefResponse;
const briefInput=(userId:string,type:RetrievalObjectType,id:string)=>({spaceId:space,ownerUserId:userId,query:'lattice',maxResults:5,mode:'lexical' as const,includeTrace:false,surface:type==='inquiry_thread'?'inquiry_brief':type==='project_public_summary'?'project_public_summary_brief':'knowledge_brief',response:response(type,id),egressPolicySnapshot:{external_egress_enabled:false}});
/** The Thread owner keeps full; every other reader is cut to its summary. */
const downgradeThread=()=>new ContentAccessService(db.pool).updatePolicy({spaceId:space,userId:owner},'space_object',thread,{visibility:'space_shared',access_level:'summary',project_id:project,grants:[]});
const DOWNGRADE_SQL="UPDATE space_objects SET visibility='space_shared',access_level='summary',updated_at=now() WHERE space_id=$1 AND id=$2";

async function hold(write:(holder:PoolClient)=>Promise<unknown>){
 const holder=await db.pool.connect();await holder.query('BEGIN');
 const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await write(holder);
 return {pid,client:holder,query:(sql:string,args:unknown[])=>holder.query(sql,args),commit:()=>holder.query('COMMIT'),release:async()=>{await holder.query('ROLLBACK').catch(()=>{});holder.release();}};
}
/** Run `racing` while a real writer's uncommitted change is held; commit only once `racing` waits on it. */
async function interleave<T>(write:(holder:PoolClient)=>Promise<unknown>,racing:()=>Promise<T>):Promise<PromiseSettledResult<T>>{
 const h=await hold(write);
 try{
  let done=false;const running=racing().finally(()=>{done=true;});
  await waitForBlockedBy(db.pool,h.pid,{settled:()=>done});
  expect(done,'the settlement must wait on the uncommitted writer').toBe(false);
  await h.commit();
  return (await Promise.allSettled([running]))[0]!;
 }finally{await h.release();}
}
const expectWithheld=(settled:PromiseSettledResult<unknown>)=>{expect(settled.status).toBe('rejected');expect((settled as PromiseRejectedResult).reason).toBeInstanceOf(RetrievalArtifactWithheld);};
async function publishSummary(){
 as(owner);
 expect((await call('project.public_summary.save',{project_id:project,summary_text:'PRIVATE public summary',topics:['lattice'],highlights:['drift']})).statusCode).toBe(200);
 const r=await call('project.public_summary.publish',{project_id:project,draft_version:1});expect(r.statusCode,r.body).toBe(200);
}

describe('Inquiry-derived Artifacts need the Thread content in full',()=>{
 it('withholds a full-saved Brief whole once the Thread is cut to its summary, while the Thread stays summary-readable',async()=>{
  const id=await persistRetrievalBriefArtifact(db.pool,briefInput(viewer,'inquiry_thread',thread));
  expect((await detail(id)).body).toContain('PRIVATE derived answer');
  await downgradeThread();
  expect(await contentDecisionFromDb(db.pool,{spaceId:space,userId:viewer},'space_object',thread)).toBe('summary');
  const r=await detail(id);expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({id,content:null,metadata_json:null,exportable:false});expect(r.body).not.toContain('PRIVATE');
  expect((await app.inject({method:'GET',url:'/api/v1/artifacts/'+id+'/export'})).statusCode).toBe(404);
  expect(await contentDecisionFromDb(db.pool,{spaceId:space,userId:viewer},'artifact',id)).toBe('deny');
  await expect(assertArtifactReadable(db.pool,{spaceId:space,userId:viewer},id,'gone')).rejects.toMatchObject({statusCode:404});
 });
 it('settles nothing when the Thread is cut to summary while the Brief settles',async()=>{
  expectWithheld(await interleave(h=>h.query(DOWNGRADE_SQL,[space,thread]),()=>persistRetrievalBriefArtifact(db.pool,briefInput(viewer,'inquiry_thread',thread))));
  expect(await count()).toBe(0);
 });
 it('settles nothing when the reader leaves the Thread\'s Project while the Brief settles',async()=>{
  expectWithheld(await interleave(async h=>{await h.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR NO KEY UPDATE',[project,space]);await h.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,viewer]);},()=>persistRetrievalBriefArtifact(db.pool,briefInput(viewer,'inquiry_thread',thread))));
  expect(await count()).toBe(0);
 });
});

describe('the shared release closure takes every real domain writer\'s lock order',()=>{
 const doc=(text:string)=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
 const viewerId=()=>({spaceId:space,userId:viewer});
 let note:string;
 beforeEach(async()=>{
  const repository=new PgKnowledgeRepository(db.pool);
  const created=await repository.createNote(viewerId(),{title:'Lattice jot',primary_project_id:project}) as {id:string;version:number};
  note=created.id;
  await repository.updateNote(viewerId(),note,{content_json:doc('Viewer lattice jot body'),expect_version:created.version});
  await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 });
 const noteVersion=async()=>Number((await db.pool.query('SELECT version FROM notes WHERE object_id=$1',[note])).rows[0].version);
 /** The writer's own first lock, held so the release is proven to wait on it. */
 const NOTE_ROOT_SQL="SELECT id FROM space_objects WHERE space_id=$1 AND id=$2 AND object_type='note' FOR UPDATE";
 const KNOWLEDGE_ROOT_SQL='SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE';
 const knowledgeUpdate=async()=>{
  const payload={operation:'update',target_item_id:item,title:'Lattice note',content:'Viewer lattice body v2'};
  const row=await insertProposalRow(db.pool,{spaceId:space,proposalType:'knowledge_update',title:'Update lattice',payload,rationale:'lock order',createdByUserId:viewer,ownerUserId:viewer,visibility:'space_shared'});
  const registry=new ProposalApplierRegistry();registerKnowledgeProposalAppliers(registry);
  return (h:PoolClient)=>registry.apply({config:config(),db:h,proposal:{id:row.id,space_id:space,proposal_type:'knowledge_update',title:'Update lattice',payload_json:payload,project_folder_id:null,visibility:'space_shared',created_by_user_id:viewer,owner_user_id:viewer,project_id:null},userId:viewer});
 };
 /** Hold `first` (the writer's first lock), start `racing`, prove it waits,
  * then run the rest of the REAL writer in the same transaction and commit. */
 async function across<T>(first:(h:PoolClient)=>Promise<unknown>,rest:(h:PoolClient)=>Promise<unknown>,racing:()=>Promise<T>):Promise<PromiseSettledResult<T>>{
  let client!:PoolClient;const h=await hold(async w=>{client=w;await w.query("SET LOCAL lock_timeout='5s'");await first(w);});
  try{
   let done=false;const running=racing().finally(()=>{done=true;});
   await waitForBlockedBy(db.pool,h.pid,{settled:()=>done});
   expect(done,'the release must wait on the writer\'s first lock').toBe(false);
   await rest(client);await h.commit();
   return (await Promise.allSettled([running]))[0]!;
  }finally{await h.release();}
 }
 it('settles a Note Brief across a real Note save (root, then notes row)',async()=>{
  const before=await noteVersion();
  const settled=await across(h=>h.query(NOTE_ROOT_SQL,[space,note]),h=>new PgKnowledgeRepository(h).updateNote(viewerId(),note,{content_json:doc('Saved while settling'),expect_version:before}),()=>persistRetrievalBriefArtifact(db.pool,briefInput(viewer,'note',note)));
  expect(settled).toMatchObject({status:'fulfilled',value:expect.any(String)});
  expect(await noteVersion()).toBe(before+1);
 });
 it('settles a Note Brief across a real Note rollback (root, then notes row)',async()=>{
  const before=await noteVersion();
  const settled=await across(h=>h.query(NOTE_ROOT_SQL,[space,note]),h=>new PgKnowledgeRepository(h).rollbackNote(viewerId(),note,before-1,before),()=>persistRetrievalBriefArtifact(db.pool,briefInput(viewer,'note',note)));
  expect(settled).toMatchObject({status:'fulfilled',value:expect.any(String)});
  expect(await noteVersion()).toBe(before+1);
 });
 it('settles a Knowledge Brief across the real Knowledge update applier (root, then extension) and withholds the superseded head',async()=>{
  const apply=await knowledgeUpdate();
  expectWithheld(await across(h=>h.query(KNOWLEDGE_ROOT_SQL,[space,[item]]),apply,()=>persistRetrievalBriefArtifact(db.pool,briefInput(viewer,'knowledge_item',item))));
  expect((await db.pool.query('SELECT status FROM knowledge_items WHERE object_id=$1',[item])).rows[0].status).toBe('superseded');
  expect(await count()).toBe(0);
 });
 it('settles an Inquiry Brief across a real Thread revision (Project FOR UPDATE, Thread, then root)',async()=>{
  const settled=await across(h=>lockActiveProjectForMutation(h,space,project),h=>new InquiryIterationService(h).reviseDefinition({spaceId:space,userId:owner},project,thread,{revision_kind:'wording_only',new_statement:'Why does the lattice drift today?'}),()=>persistRetrievalBriefArtifact(db.pool,briefInput(viewer,'inquiry_thread',thread)));
  expect(settled).toMatchObject({status:'fulfilled',value:expect.any(String)});
 });
 it('releases mixed Inquiry/Knowledge/Note contributions, given in reverse order, across all three real writers at once',async()=>{
  const apply=await knowledgeUpdate();
  const writers=await Promise.all([
   hold(async w=>{await w.query("SET LOCAL lock_timeout='5s'");await lockActiveProjectForMutation(w,space,project);}),
   hold(async w=>{await w.query("SET LOCAL lock_timeout='5s'");await w.query(KNOWLEDGE_ROOT_SQL,[space,[item]]);}),
   hold(async w=>{await w.query("SET LOCAL lock_timeout='5s'");await w.query(NOTE_ROOT_SQL,[space,note]);}),
  ]);
  const clients=writers.map(w=>w.client);
  try{
   let done=false;
   const groups:ReleaseGroup[]=[
    {registry:knowledgeRetrievalRegistry,refs:[{object_type:'note',object_id:note},{object_type:'knowledge_item',object_id:item}]},
    {registry:inquiryRetrievalRegistry,refs:[{object_type:'inquiry_thread',object_id:thread}]},
   ];
   const running=withQueryableTransaction(db.pool,tx=>withheldReleaseRefs(tx,viewerId(),groups.reverse(),null)).finally(()=>{done=true;});
   const before=await noteVersion();
   // Inquiry: the release waits on the Thread's Project before any Thread or root.
   await waitForBlockedBy(db.pool,writers[0]!.pid,{settled:()=>done});expect(done).toBe(false);
   await new InquiryIterationService(clients[0]!).reviseDefinition({spaceId:space,userId:owner},project,thread,{revision_kind:'wording_only',new_statement:'Why does the lattice drift now?'});await writers[0]!.commit();
   // Knowledge and Note: the release now waits on a root, holding no extension row.
   await vi.waitUntil(async()=>done||(await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=$1 AND (pg_blocking_pids(pid) && $2::int[])',['Lock',[writers[1]!.pid,writers[2]!.pid]])).rowCount,{timeout:10_000,interval:20});
   expect(done).toBe(false);
   await apply(clients[1]!);await new PgKnowledgeRepository(clients[2]!).updateNote(viewerId(),note,{content_json:doc('Saved in the mix'),expect_version:before});
   await writers[1]!.commit();await writers[2]!.commit();
   // Thread and Note stay releasable; the superseded Knowledge head is not.
   await expect(running).resolves.toBe(1);
  }finally{for(const w of writers)await w.release();}
 });
});

describe('Project-summary-derived Artifacts lock the publication, its Project and its Source lineage',()=>{
 it('settles nothing when the publication is revoked while the Brief settles, and withholds an old Brief after revoke',async()=>{
  await publishSummary();
  const old=await persistRetrievalBriefArtifact(db.pool,briefInput(owner,'project_public_summary',project));
  expectWithheld(await interleave(async h=>{await h.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR UPDATE',[project,space]);await h.query('DELETE FROM project_public_summary_publications WHERE space_id=$1 AND project_id=$2',[space,project]);},()=>persistRetrievalBriefArtifact(db.pool,briefInput(owner,'project_public_summary',project))));
  expect(await count()).toBe(1);
  expect((await detail(old)).json()).toMatchObject({content:null,metadata_json:null});
 });
 it('settles nothing when the summary\'s Source consent is withdrawn while the Brief settles',async()=>{
  await publishSummary();
  const {seedArxivSourceChain}=await import('./support/researchSeeds.js');const connection=randomUUID();
  await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel:randomUUID(),space,owner,now:new Date().toISOString()});
  await db.pool.query('UPDATE project_public_summary_publications SET source_refs_json=$3::jsonb WHERE space_id=$1 AND project_id=$2',[space,project,JSON.stringify([{source_type:'source_connection',source_id:connection}])]);
  const old=await persistRetrievalBriefArtifact(db.pool,briefInput(owner,'project_public_summary',project));
  expectWithheld(await interleave(h=>h.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]),()=>persistRetrievalBriefArtifact(db.pool,briefInput(owner,'project_public_summary',project))));
  expect(await count()).toBe(1);
  expect((await detail(old)).json()).toMatchObject({content:null,metadata_json:null});
 });
});

describe('Ask Space session aggregates follow their complete contribution closure',()=>{
 const think=(deps:ConstructorParameters<typeof AskSpaceService>[2])=>new AskSpaceService(db.pool,config(),{canRunActions:async()=>false,...deps}).think({spaceId:space,userId:viewer,query:'lattice',domains:['knowledge','inquiry'],persist:true,combine:true});
 const domainBrief=async({domain}:{domain:AskSpaceDomain})=>domain==='inquiry'?response('inquiry_thread',thread,'PRIVATE inquiry answer'):response('knowledge_item',item,'Viewer knowledge answer');
 /** The Inquiry domain answers but its own Brief fails to save: it still feeds the combined answer. */
 const failInquiryBrief:typeof persistRetrievalBriefArtifact=(q,input,job)=>input.surface==='inquiry_brief'?Promise.reject(new Error('brief storage failure')):persistRetrievalBriefArtifact(q,input,job);

 it('withholds the whole session after a contributing source of a failed-to-save domain is cut, keeping the other Brief',async()=>{
  const result=await think({runDomainBrief:domainBrief,persistBrief:failInquiryBrief,runCombinedSynthesis:async()=>({answer:'PRIVATE combined answer'} as never)});
  expect(result.domains.find(d=>d.domain==='inquiry')).toMatchObject({artifact_error:'retrieval_brief_persist_failed'});
  const session=result.session_artifact_id!,knowledge=result.domains.find(d=>d.domain==='knowledge')!.artifact_id!;
  expect(session).toBeTruthy();expect((await detail(session)).body).toContain('PRIVATE combined answer');
  await downgradeThread();
  const r=await detail(session);expect(r.json()).toMatchObject({id:session,content:null,metadata_json:null,exportable:false});expect(r.body).not.toContain('PRIVATE');
  expect(await contentDecisionFromDb(db.pool,{spaceId:space,userId:viewer},'artifact',session)).toBe('deny');
  expect((await detail(knowledge)).body).toContain('Viewer knowledge answer');
 });
 it('writes no session when a contributor is cut during the combined synthesis, waiting on the uncommitted writer',async()=>{
  let held:Awaited<ReturnType<typeof hold>>|undefined;let release!:()=>void;const synthesized=new Promise<void>(r=>{release=r;});
  try{
   let done=false;
   const running=think({runDomainBrief:domainBrief,runCombinedSynthesis:async()=>{held=await hold(h=>h.query(DOWNGRADE_SQL,[space,thread]));release();return {answer:'PRIVATE combined answer'} as never;}}).finally(()=>{done=true;});
   await synthesized;await waitForBlockedBy(db.pool,held!.pid,{settled:()=>done});
   expect(done,'the session settlement must wait on the uncommitted writer').toBe(false);
   await held!.commit();
   const result=await running;
   expect(result.session_artifact_id).toBeUndefined();expect(result.session_artifact_error).toBe('ask_space_session_withheld');
   expect(await count('ask_space_session')).toBe(0);expect(await count('retrieval_brief')).toBe(2);
  }finally{await held?.release();}
 });
 it('fails closed on a session whose contribution closure cannot be resolved',async()=>{
  const write=(metadata:Record<string,unknown>)=>insertArtifactRow(db.pool,{spaceId:space,ownerUserId:viewer,artifactType:'ask_space_session',title:'Ask Space',content:'PRIVATE session body',metadata,canonicalFormat:'ask_space_session.v1',visibility:'private'});
  const contributions=[{domain:'knowledge',refs:[{object_type:'knowledge_item',object_id:item}]}];
  const legit=await write({brief_artifact_refs:[],contributions});
  expect((await detail(legit)).body).toContain('PRIVATE session body');
  const legacy=await write({brief_artifact_refs:[],provenance:[{domain:'knowledge',object_type:'knowledge_item',object_id:item}]});
  const missingBrief=await write({brief_artifact_refs:[{domain:'knowledge',artifact_id:randomUUID()}],contributions});
  const wrongDomain=await write({brief_artifact_refs:[],contributions:[{domain:'inquiry',refs:[{object_type:'knowledge_item',object_id:item}]}]});
  for(const id of [legacy,missingBrief,wrongDomain])expect((await detail(id)).json(),id).toMatchObject({content:null,metadata_json:null});
 });
});
