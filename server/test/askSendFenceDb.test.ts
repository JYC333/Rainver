import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {seedArxivSourceChain,seedRelevantCorpusItem} from './support/researchSeeds.js';
import {providerTaskTestConfig,seedTestModelProvider} from './support/providerTaskFixture.js';
import {openAiChatResponse} from './support/piAiHttp.js';
import {claimJobForHandler} from './support/jobClaim.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {executeSourceDispatch} from '../src/modules/sources/sourceDispatchExecution.js';
import {createAskSendAuthority} from '../src/modules/askSpace/sendAuthority.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {resolveProviderCommandStore} from '../src/modules/providers/commands/store.js';
import {completeProviderText,completeProviderEmbedding,completeProviderRerank,__setProviderHttpClientForTests} from '../src/modules/providers/invocation/invocation.js';
import {CONTENT_RETRIEVAL_JOB} from '@rainver/protocol';
const db=useTestDatabase(import.meta.url,{max:6});
let space:string,user:string,project:string,item:string,connection:string,provider:string,sends:number;
const config=()=>providerTaskTestConfig(db.connectionUri,`/tmp/rainver-ask-send-${process.pid}`);
beforeEach(async()=>{
 await resetTables(db.pool,['model_provider_space_grants','model_providers','spaces','users','source_providers','source_connectors'],{cascade:true});
 space=randomUUID();user=randomUUID();project=randomUUID();item=randomUUID();connection=randomUUID();sends=0;
 await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});
 await seedArxivSourceChain(db.pool,{space,owner:user,connector:randomUUID(),connection,channel:randomUUID(),now:new Date().toISOString()});
 const source=await seedRelevantCorpusItem(db.pool,{space,owner:user,project});
 await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[source.sourceItemId,connection]);
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Fence payload',content:'Current canonical body',ownerUserId:user,createdByUserId:user,projectId:project});
 await db.pool.query("INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'knowledge',$3,'source_item',$4,now())",[randomUUID(),space,item,source.sourceItemId]);
 provider=await seedTestModelProvider(db.pool,{space,owner:user,config:config()});
 __setProviderHttpClientForTests({fetch:async()=>{sends++;return openAiChatResponse({choices:[{message:{content:'answer'}}],model:'test-model',usage:{}});}});
});
afterEach(()=>__setProviderHttpClientForTests(null));
async function setup(){
 const authority=createAskSendAuthority(db.pool,{spaceId:space,userId:user});
 const adapter=knowledgeRetrievalRegistry.adapterFor('knowledge_item')!;
 const candidate=await adapter.revalidate(db.pool,space,'knowledge_item',item,user);
 const canonical=await adapter.loadCanonical(db.pool,space,'knowledge_item',item);
 const guard=authority.forRegistry(knowledgeRetrievalRegistry)([{objectType:'knowledge_item',objectId:item,...candidate!,sourceConnectionIds:canonical!.sourceConnectionIds}]);
 const job=await new PgJobQueueRepository(db.pool).enqueue({space_id:space,user_id:user,job_type:CONTENT_RETRIEVAL_JOB,max_attempts:1,payload:{operation:'ask_space.think',user_id:user}});
 const envelope=await claimJobForHandler(db.pool,job.id);
 const send=(authorizeSend=guard)=>completeProviderText(resolveProviderCommandStore(config()),space,{provider_id:provider,system:'Answer only from the authorized context.',user:'payload',single_attempt:true,spend:{kind:'person',user_id:user},metering:{subject_user_id:user},egressPolicy:{externalEgressEnabled:true,authorizeSend}});
 return {authority,envelope,send};
}
it.each(['consent','audience','content','provenance'] as const)('checks current %s before the next physical send, including combined synthesis',async kind=>{
 const {authority,envelope,send}=await setup();
 await executeSourceDispatch(db.pool,envelope,async()=>{
  await send();expect(sends).toBe(1);
  if(kind==='consent')await db.pool.query("UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_external_model_egress}','false') WHERE id=$1",[connection]);
  if(kind==='audience'){const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET owner_user_id=$2,created_by_user_id=$2,access_level='summary' WHERE id=$1",[item,peer]);}
  if(kind==='content')await db.pool.query("UPDATE knowledge_items SET content='changed',plain_text='changed' WHERE object_id=$1",[item]);
  if(kind==='provenance')await db.pool.query('DELETE FROM provenance_links WHERE target_id=$1',[item]);
  await expect(send(authority.combined())).rejects.toBeDefined();expect(sends).toBe(1);
  return {};
 });
});
it('rejects a stale claim before SDK fetch and preserves the unknown start fence',async()=>{
 const {envelope,send}=await setup();
 await expect(executeSourceDispatch(db.pool,envelope,async()=>{
  await db.pool.query('UPDATE jobs SET attempts=attempts+1 WHERE id=$1',[envelope.job_id]);
  await expect(send()).rejects.toBeDefined();return {};
 })).rejects.toBeDefined();
 expect(sends).toBe(0);
 expect((await db.pool.query('SELECT result_json FROM jobs WHERE id=$1',[envelope.job_id])).rows[0].result_json).toEqual({source_dispatch:'started'});
});
it('an unknown physical send is never automatically resent on another dispatch',async()=>{
 const {envelope,send}=await setup();__setProviderHttpClientForTests({fetch:async()=>{sends++;throw new TypeError('unknown network outcome');}});
 await expect(executeSourceDispatch(db.pool,envelope,async()=>{await send();return {};})).rejects.toBeDefined();
 await expect(executeSourceDispatch(db.pool,envelope,async()=>{await send();return {};})).rejects.toThrow('will not be repeated');
 expect(sends).toBe(1);
 expect((await db.pool.query('SELECT result_json FROM jobs WHERE id=$1',[envelope.job_id])).rows[0].result_json).toEqual({source_dispatch:'started',effect_started:true});
});
it('query-only auxiliary sends also recheck the current claim and active audience',async()=>{
 const {authority,envelope,send}=await setup();
 await expect(executeSourceDispatch(db.pool,envelope,async()=>{
  await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,user]);
  await send(authority.query);return {};
 })).rejects.toBeDefined();expect(sends).toBe(0);
});

it.each(['embedding','native rerank'] as const)('checks current consent at every physical %s send',async kind=>{
 const {authority,envelope}=await setup();
 if(kind==='native rerank')await db.pool.query("UPDATE model_providers SET provider_type='zeroentropy',default_model='zerank-2' WHERE id=$1",[provider]);
 __setProviderHttpClientForTests({fetch:async()=>{sends++;return new Response(JSON.stringify(kind==='embedding'?{data:[{embedding:[1,0]}],model:'test-model',usage:{}}:{results:[{index:0,relevance_score:1}]}),{status:200,headers:{'content-type':'application/json'}});}});
 const common={provider_id:provider,single_attempt:true as const,spend:{kind:'person' as const,user_id:user},metering:{subject_user_id:user},egressPolicy:{externalEgressEnabled:true,authorizeSend:authority.combined()}};
 const send=()=>kind==='embedding'?completeProviderEmbedding(resolveProviderCommandStore(config()),space,{...common,inputs:['payload'],dimensions:2}):completeProviderRerank(resolveProviderCommandStore(config()),space,{...common,query:'payload',documents:['body']});
 await executeSourceDispatch(db.pool,envelope,async()=>{
  await send();expect(sends).toBe(1);
  await db.pool.query("UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_external_model_egress}','false') WHERE id=$1",[connection]);
  await expect(send()).rejects.toBeDefined();expect(sends).toBe(1);return {};
 });
});
