import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {CONTENT_RETRIEVAL_JOB} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {buildModuleServer} from './support/moduleServer.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {memoryModule} from '../src/modules/memory/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {RetrievalProjectionService} from '../src/modules/retrieval/index.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {registerContentRetrievalJob,releaseContentRequest} from '../src/modules/retrieval/contentRequests.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {claimJobForHandler} from './support/jobClaim.js';
import {jobToOut} from '../src/modules/jobs/routes.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,item:string,app:ReturnType<typeof buildModuleServer>;
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri});
const call=(operation:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+operation,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();item=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Lattice PRIVATE title',content:'Quantum lattice PRIVATE body',ownerUserId:owner,createdByUserId:owner,projectId:project});
 await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 app=buildModuleServer(config(),[knowledgeModule,memoryModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('admits all eight strict request contracts with identity-only replay receipts and one-attempt Job intents',async()=>{
 for(const [id,body] of [
  ['knowledge.retrieval.search.request',{query:'quantum'}],['knowledge.retrieval.brief.request',{query:'quantum'}],['knowledge.retrieval.explain.request',{query:'quantum',object_type:'knowledge_item',object_id:item}],['knowledge.create_safety.request',{object_type:'knowledge_item',title:'Lattice'}],
  ['memory.search.request',{query:'quantum'}],['memory.retrieval.search.request',{query:'quantum'}],['memory.retrieval.brief.request',{query:'quantum'}],['memory.create_safety.request',{object_type:'memory_entry',title:'Lattice'}],
 ] as const){const key=randomUUID(),first=await call(id,body,key);expect(first.statusCode,first.body).toBe(202);expect(first.json().data).toMatchObject({space_id:space,status:'pending'});expect(first.body).not.toContain('quantum');expect((await call(id,body,key)).json()).toEqual(first.json());}
 const jobs=(await db.pool.query('SELECT job_type,max_attempts FROM jobs')).rows;expect(jobs).toHaveLength(8);expect(jobs.every(j=>j.job_type===CONTENT_RETRIEVAL_JOB&&j.max_attempts===1)).toBe(true);
 expect((await call('memory.retrieval.search.request',{query:'x',object_types:['note']})).statusCode).toBe(422);
});
it('executes search outside admission, never repeats a settled attempt, and releases only through its current-access reader',async()=>{
 const key=randomUUID(),first=await app.inject({method:'POST',url:'/api/v1/knowledge/search',payload:{query:'quantum',mode:'lexical'},headers:{'idempotency-key':key}});
 expect(first.statusCode,first.body).toBe(202);const id=first.json().data.job_id;
 const registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const envelope=await claimJobForHandler(db.pool,id),result=await registry.dispatch(envelope);
 expect(await registry.dispatch(envelope)).toEqual(result);await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
 const view=await app.inject({method:'GET',url:'/api/v1/knowledge/retrieval/requests/'+id});expect(view.statusCode,view.body).toBe(200);expect(view.body).toContain('Lattice');
 const job=(await new PgJobQueueRepository(db.pool).getJob(id))!;expect(jobToOut(job).result).toBeNull();
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});await db.pool.query("UPDATE space_objects SET access_level='summary',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[item,other]);
 const withheld=await app.inject({method:'GET',url:'/api/v1/knowledge/retrieval/requests/'+id});expect(withheld.json()).toMatchObject({status:'completed',result:null,withheld:1});expect(withheld.body).not.toContain('PRIVATE');
});
it('withholds every old synthesis and provenance field on summary/none access, under current effective access',async()=>{
 const value={items:[{object_type:'knowledge_item',object_id:item,title:'PRIVATE'}],brief:{answer:'PRIVATE synthesis',citations:[{object_type:'knowledge_item',object_id:item}],gap_analysis:{contradictions:['PRIVATE provenance']}}};
 const identity={spaceId:space,userId:owner};expect((await releaseContentRequest(db.pool,identity,'knowledge.retrieval.brief.request',value)).withheld).toBe(0);
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});await db.pool.query("UPDATE space_objects SET access_level='summary',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[item,other]);expect(await releaseContentRequest(db.pool,identity,'knowledge.retrieval.brief.request',value)).toEqual({result:null,withheld:1});
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET access_level='full',visibility='private',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[item,peer]);
 expect(await releaseContentRequest(db.pool,identity,'knowledge.retrieval.brief.request',value)).toEqual({result:null,withheld:1});
});
it('refuses explain admission and result access after losing the maintenance role',async()=>{
 const first=await call('knowledge.retrieval.explain.request',{query:'quantum',object_type:'knowledge_item',object_id:item});expect(first.statusCode,first.body).toBe(202);
 await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 expect((await call('knowledge.retrieval.explain.request',{query:'quantum',object_type:'knowledge_item',object_id:item})).statusCode).toBe(404);
 expect((await app.inject({method:'GET',url:'/api/v1/knowledge/retrieval/requests/'+first.json().data.job_id})).statusCode).toBe(404);
});
it('persists the explain Artifact through the worker with safe diagnostic metadata and no private body in the receipt',async()=>{
 const admitted=await call('knowledge.retrieval.explain.request',{query:'Lattice PRIVATE title',object_type:'knowledge_item',object_id:item,mode:'exact',persist_artifact:true});expect(admitted.statusCode,admitted.body).toBe(202);
 const id=admitted.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const result=await registry.dispatch(await claimJobForHandler(db.pool,id));await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
 const response=await app.inject({method:'GET',url:'/api/v1/knowledge/retrieval/requests/'+id});expect(response.statusCode,response.body).toBe(200);expect(response.json().result).toMatchObject({target:{object_id:item,title:'Lattice PRIVATE title'},artifact_id:expect.any(String)});
 const artifact=(await db.pool.query('SELECT metadata_json FROM artifacts WHERE id=$1',[response.json().result.artifact_id])).rows[0];expect(artifact.metadata_json).toMatchObject({access_safety:{target_revalidated:true,content_included:false,snippets_included:false,dropped_candidate_ids_included:false}});expect(JSON.stringify(artifact.metadata_json)).not.toContain('PRIVATE body');
});
it('retains ordinary Memory search shape through the worker and rereads current content instead of returning an old version',async()=>{
 const {insertMemoryEntry}=await import('./support/memoryFixtures.js');const memory=randomUUID();await insertMemoryEntry(db.pool,space,{id:memory,owner_user_id:owner,subject_user_id:owner,title:'Quantum Memory',content:'PRIVATE Memory',namespace:'test',created_by:'user:'+owner});
 const admitted=await call('memory.search.request',{query:'Quantum'});expect(admitted.statusCode,admitted.body).toBe(202);
 const id=admitted.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());const result=await registry.dispatch(await claimJobForHandler(db.pool,id));await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
 const view=await app.inject({method:'GET',url:'/api/v1/memory/retrieval/requests/'+id});expect(view.statusCode,view.body).toBe(200);expect(view.json().result).toMatchObject([{id:memory,content:'PRIVATE Memory'}]);
 await db.pool.query("UPDATE memory_entries SET status='archived' WHERE id=$1",[memory]);
 const withdrawn=await app.inject({method:'GET',url:'/api/v1/memory/retrieval/requests/'+id});expect(withdrawn.body).not.toContain('PRIVATE Memory');expect(withdrawn.json().result).toBeNull();
 expect((await call('memory.search.request',{query:'Quantum',space_id:randomUUID()})).statusCode).toBe(422);
});
it('pins the canonical root before release and observes a demotion committed while waiting',async()=>{
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});await db.pool.query('UPDATE space_objects SET owner_user_id=$2,created_by_user_id=$2 WHERE id=$1',[item,other]);
 const holder=await db.pool.connect();await holder.query('BEGIN');
 try{
  const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  await holder.query("UPDATE space_objects SET access_level='summary' WHERE id=$1",[item]);
  const releasing=releaseContentRequest(db.pool,{spaceId:space,userId:owner},'knowledge.retrieval.brief.request',{items:[{object_type:'knowledge_item',object_id:item,title:'PRIVATE'}],brief:{answer:'PRIVATE answer'}});
  const {waitForBlockedBy}=await import('./support/lockWait.js');await waitForBlockedBy(db.pool,pid);
  await holder.query('COMMIT');expect(await releasing).toEqual({result:null,withheld:1});
 }finally{await holder.query('ROLLBACK');holder.release();}
});
it('locks canonical provenance and refuses an old result after its Source consent is withdrawn',async()=>{
 const {seedArxivSourceChain}=await import('./support/researchSeeds.js');const connection=randomUUID(),channel=randomUUID(),source=randomUUID();
 await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now:new Date().toISOString()});
 await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,connection_id,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared','full',$4,'external_url','Source',now(),now(),'excerpt_saved','summary_only',now(),now())",[source,space,owner,connection]);
 await db.pool.query("INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'knowledge',$3,'source_item',$4,now())",[randomUUID(),space,item,source]);
 const result={items:[{object_type:'knowledge_item',object_id:item,title:'PRIVATE'}]};
 expect((await releaseContentRequest(db.pool,{spaceId:space,userId:owner},'knowledge.retrieval.search.request',result)).withheld).toBe(0);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]);
 expect(await releaseContentRequest(db.pool,{spaceId:space,userId:owner},'knowledge.retrieval.search.request',result)).toEqual({result:null,withheld:1});
});
