import {waitForBlockedBy} from './support/lockWait.js';
import {performJobEffect} from '../src/modules/jobs/effectAuthority.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {jobToOut} from '../src/modules/jobs/routes.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {claimJobForHandler} from './support/jobClaim.js';

const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,channel:string,connection:string,item:string,app:ReturnType<typeof buildModuleServer>;
const post=(url:string,payload:object,key:string|null=randomUUID())=>app.inject({method:'POST',url:'/api/v1/sources/'+url,payload,headers:key?{'idempotency-key':key}:{}});
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri});
async function runJob(id:string){
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');const {registerSourceRetrievalJob}=await import('../src/modules/sources/retrievalOperations.js');
  const registry=new JobHandlerRegistry();registerSourceRetrievalJob(registry,config());
  const envelope=await claimJobForHandler(db.pool,id);
  const result=await registry.dispatch(envelope);
  // A repeated delivery under the same live claim replays the stored outcome without searching again.
  expect(await registry.dispatch(envelope)).toEqual(result);
  await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
  return {result,envelope,registry};
}

beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
  space=randomUUID();owner=randomUUID();project=randomUUID();connection=randomUUID();channel=randomUUID();item=randomUUID();
  const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project});
  await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now});
  await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,connection_id,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
    VALUES($1,$2,$3,'space_shared','full',$4,'external_url','Quantum lattice survey','Lattice methods for quantum error correction',now(),now(),'excerpt_saved','summary_only',now(),now())`,[item,space,owner,connection]);
  app=buildModuleServer(config(),[sourcesModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('reindex rebuilds the projection and its embedding intent in one command; only owners/admins may run it',async()=>{
  const key=randomUUID(),done=await post('retrieval/reindex',{},key);
  expect(done.statusCode,done.body).toBe(200);
  const receipt=done.json().data;expect(receipt.space_id).toBe(space);expect(receipt.embedding_backfill_job_id).toBeTruthy();
  expect(await rows("SELECT id FROM jobs WHERE id=$1 AND job_type='retrieval_embedding_backfill'",[receipt.embedding_backfill_job_id])).toHaveLength(1);
  expect((await post('retrieval/reindex',{},key)).json()).toEqual(done.json());
  expect((await post('retrieval/reindex',{},null)).statusCode).toBe(422);
  const member=randomUUID();await seedSpaceMember(db.pool,{space,user:member,role:'member'});
  __setAuthIdentityForTests({spaceId:space,userId:member});
  expect((await post('retrieval/reindex',{})).statusCode).toBe(404);
});

it('search is a single-attempt Job; its result leaves only through the Source reader, under current access',async()=>{
  expect((await post('retrieval/reindex',{})).statusCode).toBe(200);
  const bad=await post('retrieval/search',{query:'quantum',object_types:['note']});
  expect(bad.statusCode).toBe(422);expect(bad.json().error.message).toBe('source retrieval only supports source_item and extracted_evidence');
  const queued=await post('retrieval/search',{query:'quantum lattice',mode:'lexical'});
  expect(queued.statusCode,queued.body).toBe(202);
  const {job_id:jobId}=queued.json().data;
  const [job]=await rows('SELECT job_type,max_attempts,payload_json FROM jobs WHERE id=$1',[jobId]);
  expect(job).toMatchObject({job_type:'source_retrieval_request',max_attempts:1,payload_json:{kind:'search',user_id:owner,request:{query:'quantum lattice',mode:'lexical'}}});
  const read=()=>app.inject({method:'GET',url:`/api/v1/sources/retrieval/requests/${jobId}`});
  expect((await read()).json()).toMatchObject({job_id:jobId,kind:'search',status:'pending',result:null});
  const {envelope,registry}=await runJob(jobId);
  const view=(await read()).json();
  expect(view.status).toBe('completed');expect(view.withheld).toBe(0);
  expect(view.result.items.map((h:{object_id:string})=>h.object_id)).toContain(item);
  // The general Jobs reader never becomes a second content channel.
  expect(jobToOut((await new PgJobQueueRepository(db.pool).getJob(jobId))!).result).toBeNull();
  // After completion the old envelope holds no claim: it neither searches again nor rewrites the receipt.
  const stored=(await rows('SELECT result_json FROM jobs WHERE id=$1',[jobId]))[0].result_json;
  await expect(registry.dispatch(envelope)).rejects.toThrow('no longer owns execution');
  expect((await rows('SELECT result_json FROM jobs WHERE id=$1',[jobId]))[0].result_json).toEqual(stored);
  // Access withdrawn after the search: the hit is withheld, not replayed.
  const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other,role:'member'});
  await db.pool.query("UPDATE source_items SET visibility='private',owner_user_id=$2 WHERE id=$1",[item,other]);
  const after=(await read()).json();expect(after.withheld).toBe(1);expect(after.result.items).toEqual([]);
  // Another member cannot read the request at all.
  __setAuthIdentityForTests({spaceId:space,userId:other});expect((await read()).statusCode).toBe(404);
});

it('query preview spends its quota at admission with the intent, freezes no secret, and refuses an exhausted quota with nothing kept',async()=>{
  const key=randomUUID(),queued=await post('query-preview',{provider_key:'arxiv',query:{mode:'search',search_query:'agent memory'}},key);
  expect(queued.statusCode,queued.body).toBe(202);
  const [job]=await rows('SELECT payload_json FROM jobs WHERE id=$1',[queued.json().data.job_id]);
  expect(job.payload_json).toEqual({kind:'query_preview',user_id:owner,request:{provider_key:'arxiv',query:{mode:'search',search_query:'agent memory'}}});
  expect((await post('query-preview',{provider_key:'arxiv',query:{mode:'search',search_query:'agent memory'}},key)).json()).toEqual(queued.json());
  for(let i=0;i<9;i++)expect((await post('query-preview',{provider_key:'arxiv',query:{mode:'search',search_query:'q'+i}})).statusCode).toBe(202);
  const before=(await rows("SELECT count(*)::int AS n FROM jobs WHERE job_type='source_retrieval_request'"))[0].n;
  const limited=await post('query-preview',{provider_key:'arxiv',query:{mode:'search',search_query:'one more'}});
  expect(limited.statusCode).toBe(429);expect(limited.json().error.metadata.code).toBe('source_preview_quota');
  expect((await rows("SELECT count(*)::int AS n FROM jobs WHERE job_type='source_retrieval_request'"))[0].n).toBe(before);
});

it('a stored search or brief leaves only through the canonical retrieval gate: an archived Connection withholds its hits, and a brief built on them loses its answer and model findings',async()=>{
  expect((await post('retrieval/reindex',{})).statusCode).toBe(200);
  const search=(await post('retrieval/search',{query:'quantum lattice',mode:'lexical'})).json().data.job_id as string;
  await runJob(search);
  // A completed brief request whose stored result rests on the same Source item.
  const queue=new PgJobQueueRepository(db.pool);
  const brief=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,max_attempts:1,payload:{kind:'brief',user_id:owner,request:{query:'quantum'}}});
  await claimJobForHandler(db.pool,brief.id);
  const cited={object_type:'source_item',object_id:item,title:'Quantum lattice survey'};
  expect(await queue.completeJob(brief.id,{brief:{answer:'PRIVATE_ANSWER',synthesized:true,citations:[cited],gap_analysis:{stale:[{...cited,reason:'old'}],thin:[],low_coverage:false,uncited_claims:['PRIVATE_CLAIM'],contradictions:['PRIVATE_CONTRADICTION'],missing_topics:['PRIVATE_TOPIC']}},items:[{...cited,snippet:'PRIVATE_SNIPPET',matched_fields:['title']}],total:1},'test')).toBe(true);
  const read=async(id:string)=>(await app.inject({method:'GET',url:`/api/v1/sources/retrieval/requests/${id}`})).json();
  // While the reader may read the Source, the whole brief is released.
  expect(await read(brief.id)).toMatchObject({withheld:0,result:{brief:{answer:'PRIVATE_ANSWER',citations:[cited],gap_analysis:{uncited_claims:['PRIVATE_CLAIM']}}}});
  // The item's own ACL is untouched; only its Connection is archived after the work ran.
  await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]);
  const searched=await read(search);
  expect(searched).toMatchObject({status:'completed',withheld:1});expect(searched.result.items).toEqual([]);
  const briefed=await read(brief.id);
  expect(briefed).toMatchObject({status:'completed',withheld:1,result:{items:[],brief:{answer:null,synthesized:false,citations:[],gap_analysis:{stale:[],uncited_claims:[],contradictions:[],missing_topics:[]}}}});
  expect(JSON.stringify(briefed)).not.toContain('PRIVATE');
});

it('the Source dispatch fence holds the queue claim: a reclaimed Job never starts external work, and a claim lost during it neither writes a receipt nor repeats the work',async()=>{
  const {executeSourceDispatch,SourceDispatchLeaseLost}=await import('../src/modules/sources/sourceDispatchExecution.js');
  const queue=new PgJobQueueRepository(db.pool),stale=()=>queue.reclaimStuckJobs(600,new Date(Date.now()+3_600_000));
  const claim=async(worker:string)=>{const job=(await queue.claimNext(worker,['source_retrieval_request']))!;expect(await queue.startJob(job.id,worker)).toBe(true);return {job_id:job.id,space_id:job.space_id,user_id:job.user_id,job_type:job.job_type,attempts:job.attempts,max_attempts:job.max_attempts,worker_id:worker,payload:job.payload_json??{}};};
  const result=async(id:string)=>(await rows('SELECT status,result_json FROM jobs WHERE id=$1',[id]))[0];
  let effects=0;
  // Claimed and started, then stalled past the stuck threshold: reclaim exhausts it before its handler begins.
  const single=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,max_attempts:1,payload:{}});
  const late=await claim('worker-a');expect(late.job_id).toBe(single.id);
  await stale();expect((await result(single.id)).status).toBe('failed');
  await expect(executeSourceDispatch(db.pool,late,async()=>{effects++;return {};})).rejects.toBeInstanceOf(SourceDispatchLeaseLost);
  expect(effects).toBe(0);expect((await result(single.id)).result_json).toBeNull();
  // The claim is lost while the external work runs: its late result is not written, and the next claim does not repeat the work.
  const retried=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,max_attempts:2,payload:{}});
  const first=await claim('worker-b');expect(first.job_id).toBe(retried.id);
  await expect(executeSourceDispatch(db.pool,first,async()=>{await performJobEffect(()=>{effects++;});await stale();return {late:true};})).rejects.toBeInstanceOf(SourceDispatchLeaseLost);
  expect(effects).toBe(1);expect(await result(retried.id)).toMatchObject({status:'failed',result_json:{source_dispatch:'started',effect_started:true}});
  expect(await queue.completeJob(retried.id,{late:true},'worker-b')).toBe(false);
  expect(await queue.claimNext('worker-c',['source_retrieval_request'])).toBeNull();
  await expect(executeSourceDispatch(db.pool,first,async()=>{effects++;return {};})).rejects.toBeInstanceOf(SourceDispatchLeaseLost);
  expect(effects).toBe(1);expect((await result(retried.id)).result_json).toEqual({source_dispatch:'started',effect_started:true});
});


it('releases a stored result only after canonical recheck and B11 commit; revocation waits for that same transaction',async()=>{
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other,role:'member'});
 await db.pool.query('UPDATE source_items SET owner_user_id=$2 WHERE id=$1',[item,other]);
 expect((await post('retrieval/reindex',{})).statusCode).toBe(200);
 const job=(await post('retrieval/search',{query:'quantum lattice',mode:'lexical'})).json().data.job_id;
 await runJob(job);
 await db.pool.query('DELETE FROM content_access_logs');
 const holder=await db.pool.connect();let readDone=false,revoked=false;let reading:Promise<unknown>|undefined,revoking:Promise<unknown>|undefined;
 try{
  await holder.query('BEGIN');await holder.query('LOCK TABLE content_access_logs IN SHARE MODE');
  const pid=Number((await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  reading=app.inject({method:'GET',url:`/api/v1/sources/retrieval/requests/${job}`}).then(r=>{expect(r.statusCode,r.body).toBe(200);return r.json();}).finally(()=>{readDone=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>readDone});expect(readDone).toBe(false);
  const reader=Number((await db.pool.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))',[pid])).rows[0].pid);
  revoking=db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]).finally(()=>{revoked=true;});
  await waitForBlockedBy(db.pool,reader,{settled:()=>revoked});expect(revoked).toBe(false);
  await holder.query('COMMIT');
  expect(await reading).toMatchObject({withheld:0,result:{items:[{object_id:item}]}});await revoking;
  expect(await rows('SELECT resource_id FROM content_access_logs WHERE viewer_user_id=$1',[owner])).toContainEqual({resource_id:item});
  const after=await app.inject({method:'GET',url:`/api/v1/sources/retrieval/requests/${job}`});expect(after.json()).toMatchObject({withheld:1,result:{items:[]}});
 }finally{await holder.query('ROLLBACK').catch(()=>undefined);holder.release();await Promise.allSettled([reading,revoking]);}
});

for(const end of ['cancel','reclaim'] as const)it(`start CAS then asynchronous preparation stalls: ${end} revokes the actual effect credential`,async()=>{
 const {executeSourceDispatch,SourceDispatchLeaseLost}=await import('../src/modules/sources/sourceDispatchExecution.js');
 const queue=new PgJobQueueRepository(db.pool);
 const job=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,max_attempts:1,payload:{}});
 const envelope=await claimJobForHandler(db.pool,job.id);
 let resume!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{resume=r;}),ready=new Promise<void>(r=>{entered=r;});let effects=0;
 const work=executeSourceDispatch(db.pool,envelope,async()=>{entered();await gate;return performJobEffect(()=>{effects++;return {sent:true};});});
 const outcome=work.then(()=>null,e=>e);await ready;
 expect((await rows('SELECT result_json FROM jobs WHERE id=$1',[job.id]))[0].result_json).toEqual({source_dispatch:'started'});
 if(end==='cancel')expect(await queue.cancelJob(job.id,null)).toBe(true);else await queue.reclaimStuckJobs(600,new Date(Date.now()+3600000));
 resume();expect(await outcome).toBeInstanceOf(SourceDispatchLeaseLost);expect(effects).toBe(0);
 expect((await rows('SELECT result_json FROM jobs WHERE id=$1',[job.id]))[0].result_json).toEqual({source_dispatch:'started'});
});

it('the Source network boundary consumes the claim after DNS/header/quota preparation, and a lost claim sends zero HTTP requests',async()=>{
 const {executeSourceDispatch}=await import('../src/modules/sources/sourceDispatchExecution.js');
 const {fetchGuarded}=await import('../src/modules/sources/outboundUrlSafety.js');
 const {startMockUpstream}=await import('./support/mockUpstream.js');
 const {fixtureServerGuard}=await import('./support/outboundGuard.js');
 const upstream=await startMockUpstream(),queue=new PgJobQueueRepository(db.pool);
 const job=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,max_attempts:1,payload:{}}),envelope=await claimJobForHandler(db.pool,job.id);
 try{
  const result=executeSourceDispatch(db.pool,envelope,()=>fetchGuarded({url:upstream.baseUrl,maxDownloadBytes:1024,beforeSend:async()=>{
   // A real asynchronous pre-send stage finishes after the claim is exhausted.
   await queue.reclaimStuckJobs(600,new Date(Date.now()+3600000));
  }},fixtureServerGuard) as unknown as Promise<Record<string,unknown>>);
  await expect(result).rejects.toThrow('no longer owns execution');expect(upstream.requests).toHaveLength(0);
 }finally{await upstream.close();}
});

it('multi-Source release uses one ordered closure for reversed hit orders and live canonical lineage',async()=>{
 const secondConnection=randomUUID(),secondItem=randomUUID(),evidence=randomUUID(),snapshot=randomUUID();
 await db.pool.query(`INSERT INTO source_connections(id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at) SELECT $2,space_id,provider_connector_id,owner_user_id,'Second','active',capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at FROM source_connections WHERE id=$1`,[connection,secondConnection]);
 await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,connection_id,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) SELECT $2,space_id,owner_user_id,visibility,access_level,$3,item_type,'Quantum second','Second excerpt',first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at FROM source_items WHERE id=$1`,[item,secondItem,secondConnection]);
 await db.pool.query(`INSERT INTO source_snapshots(id,space_id,owner_user_id,connection_id,source_item_id,snapshot_type,capture_method,trust_level,captured_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'metadata','manual','normal',now(),now(),now())`,[snapshot,space,owner,secondConnection,secondItem]);
 await db.pool.query(`INSERT INTO extracted_evidence(id,space_id,owner_user_id,source_item_id,source_snapshot_id,evidence_type,title,trust_level,extraction_method,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'excerpt','Quantum evidence','normal','manual','candidate',now(),now())`,[evidence,space,owner,item,snapshot]);
 expect((await post('retrieval/reindex',{})).statusCode).toBe(200);
 const refs=[{object_type:'source_item',object_id:secondItem},{object_type:'extracted_evidence',object_id:evidence},{object_type:'source_item',object_id:item}];
 const queue=new PgJobQueueRepository(db.pool),ids:string[]=[];
 for(const hits of [refs,[...refs].reverse()]){
  const job=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,payload:{kind:'search'}});await claimJobForHandler(db.pool,job.id);await queue.completeJob(job.id,{items:hits},'test');ids.push(job.id);
 }
 const read=(id:string)=>app.inject({method:'GET',url:`/api/v1/sources/retrieval/requests/${id}`});
 const both=await Promise.all(ids.map(read));for(const r of both){expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({withheld:0});expect(r.json().result.items).toHaveLength(3);}
 // Even a stale projection that forgets the snapshot's second Source cannot
 // make the Evidence independent of that live Source's policy.
 await db.pool.query("UPDATE retrieval_objects SET source_connection_ids_json=$2 WHERE object_id=$1",[evidence,JSON.stringify([connection])]);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[secondConnection]);
 for(const r of await Promise.all(ids.map(read))){expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({withheld:2,result:{items:[{object_id:item}]}});}
});

it('Host capacity waiting carries the Source credential to actual launch; reclaim while queued sends no late frame',async()=>{
 const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');
 const {executeSourceDispatch}=await import('../src/modules/sources/sourceDispatchExecution.js');
 const registry=new HostConnectionRegistry(),sent:Record<string,unknown>[]=[];
 registry.registerConnection('host-test',{send:frame=>{sent.push(frame as Record<string,unknown>);},close:()=>undefined});
 const occupying=registry.dispatchLaunch('host-test','occupying',{argv:['fixture']},undefined,undefined,undefined,1);
 const queue=new PgJobQueueRepository(db.pool),job=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,max_attempts:1,payload:{}}),env=await claimJobForHandler(db.pool,job.id);
 const work=executeSourceDispatch(db.pool,env,async()=>await registry.dispatchLaunch('host-test','late',{argv:['fixture']},undefined,undefined,undefined,1) as unknown as Record<string,unknown>);
 const outcome=work.then(()=>null,e=>e);
 // Allow the start CAS to finish; the Host queue has no DB writes of its own.
 const {vi}=await import('vitest');await vi.waitUntil(async()=>(await rows('SELECT result_json FROM jobs WHERE id=$1',[job.id]))[0].result_json?.source_dispatch==='started');
 await queue.reclaimStuckJobs(600,new Date(Date.now()+3600000));
 registry.receiveComplete('host-test','occupying',{exit_code:0,timed_out:false,error:null},String(sent[0].launch_id));await occupying;
 expect(await outcome).toMatchObject({name:'JobEffectLeaseLost'});expect(sent.filter(f=>f.type==='launch')).toHaveLength(1);
});

it('a stale Source credential cannot transfer execution to a new durable Job',async()=>{
 const {executeSourceDispatch}=await import('../src/modules/sources/sourceDispatchExecution.js');
 const queue=new PgJobQueueRepository(db.pool),job=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,max_attempts:1,payload:{}}),env=await claimJobForHandler(db.pool,job.id);
 const work=executeSourceDispatch(db.pool,env,async()=>{
  await queue.reclaimStuckJobs(600,new Date(Date.now()+3600000));
  await queue.enqueue({job_type:'agent_run',space_id:space,user_id:owner,payload:{run_id:'never-queued'}});return {};
 });
 await expect(work).rejects.toThrow('no longer owns execution');expect(await rows("SELECT id FROM jobs WHERE payload_json->>'run_id'='never-queued'")).toEqual([]);
});

for(const kind of ['embedding','rerank','chat'] as const)it(`provider ${kind} consumes the claim at HTTP after asynchronous target resolution, not at handler start`,async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {seedTestModelProvider}=await import('./support/providerTaskFixture.js');
 const {resolveProviderCommandStore}=await import('../src/modules/providers/commands/store.js');
 const {completeProviderEmbedding,completeProviderRerank,completeProviderChat,__setProviderHttpClientForTests,__setNetworkRetryDelayForTests}=await import('../src/modules/providers/invocation/invocation.js');
 const {executeSourceDispatch}=await import('../src/modules/sources/sourceDispatchExecution.js');
 const {vi}=await import('vitest');
 const root=await mkdtemp(join(tmpdir(),'source-effect-provider-')),cfg={...config(),rainverHome:root};let requests=0,targets=0;
 const queue=new PgJobQueueRepository(db.pool),job=await queue.enqueue({job_type:'source_retrieval_request',space_id:space,user_id:owner,max_attempts:1,payload:{}}),env=await claimJobForHandler(db.pool,job.id);
 try{
  const provider=await seedTestModelProvider(db.pool,{space,owner,config:cfg});
  // Rerank's commodity endpoint is explicit; the other two use OpenAI shapes.
  if(kind==='rerank')await db.pool.query("UPDATE model_providers SET provider_type='cohere' WHERE id=$1",[provider]);
  const store=resolveProviderCommandStore(cfg),load=store.getInvocationTarget.bind(store);
  const target=vi.spyOn(store,'getInvocationTarget').mockImplementation(async(...args)=>{const result=await load(...args);targets++;await queue.reclaimStuckJobs(600,new Date(Date.now()+3600000));return result;});
  __setProviderHttpClientForTests({fetch:async()=>{requests++;throw new Error('must not send');}});__setNetworkRetryDelayForTests(async()=>undefined);
  const input={provider_id:provider,model:'test-model',spend:{kind:'person' as const,user_id:owner},metering:{subject_user_id:owner}};
  try{
   await expect(executeSourceDispatch(db.pool,env,async()=>({out:kind==='embedding'?await completeProviderEmbedding(store,space,{...input,inputs:['quantum']}):kind==='rerank'?await completeProviderRerank(store,space,{...input,query:'quantum',documents:['quantum']}):await completeProviderChat(store,space,{...input,messages:[{role:'user',content:'quantum'}]})}))).rejects.toThrow(/no longer owns execution/);
   expect(targets).toBeGreaterThan(0);expect(requests).toBe(0);
  }finally{target.mockRestore();}
 }finally{__setProviderHttpClientForTests(null);__setNetworkRetryDelayForTests(null);await rm(root,{recursive:true,force:true});}
});
