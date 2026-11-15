import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {loadConfig,type ServerConfig} from '../src/config.js';
import {SourceRecipeCreateService} from '../src/modules/sources/sourceRecipes/recipeCreateService.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {seedCustomSourceWorld,upsertCustomSourceSpacePolicy} from './support/customSourceWorld.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {resetTables} from './support/resetTables.js';
import {useTestDatabase} from './support/testDatabase.js';
import {claimJobForHandler} from './support/jobClaim.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';

const SPACE='space-a',IDENTITY={spaceId:SPACE,userId:'user-1'};
const RSS=`<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><item><title>One</title><link>/one</link><guid>g1</guid><description>First</description></item><item><title>Two</title><link>/two</link><guid>g2</guid><description>Second</description></item></channel></rss>`;
const db=useTestDatabase(import.meta.filename,{max:8});
let config:ServerConfig,root:string,app:ReturnType<typeof buildModuleServer>;
const post=(url:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/sources/source-recipes/'+url,payload,headers:{'idempotency-key':key}});
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;
async function runJob(id:string){
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');const {registerSourceRetrievalJob}=await import('../src/modules/sources/retrievalOperations.js');
  const registry=new JobHandlerRegistry();registerSourceRetrievalJob(registry,config);
  const result=await registry.dispatch(await claimJobForHandler(db.pool,id));
  await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
  return result;
}
async function recipeSource(){
  const service=new SourceRecipeCreateService(db.pool,config);
  const plan=await service.planSource(IDENTITY,{name:'Recipe Feed',endpoint_url:'https://feeds.example.test/feed.xml',fetch_frequency:'hourly',capture_policy:'extract_text',fixture_content:RSS});
  return service.createSource(IDENTITY,{name:'Recipe Feed',endpoint_url:'https://feeds.example.test/feed.xml',fetch_frequency:'hourly',capture_policy:'extract_text',recipe:plan.recipe});
}

beforeEach(async()=>{
  if(!db.available)return;
  await resetTables(db.pool,['jobs','policy_decision_records','proposals','spaces','users','source_providers','source_connectors','source_provider_connectors'],{cascade:true});
  await seedCustomSourceWorld(db.pool,IDENTITY);
  root=await mkdtemp(join(tmpdir(),'source-recipe-ops-'));
  config={...loadConfig({}),databaseUrl:db.connectionUri,artifactStorageRoot:root};
  app=buildModuleServer(config,[sourcesModule,systemActionsModule]);
  __setAuthIdentityForTests(IDENTITY);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();if(root)await rm(root,{recursive:true,force:true});});

it('planning is a single-attempt Job admitted under the creator/domain policy; its plan is read through the request reader',async ctx=>{
  if(!db.available)return ctx.skip();
  const denied=await post('plan',{endpoint_url:'not a url'});expect(denied.statusCode).toBe(422);
  const queued=await post('plan',{name:'Recipe Feed',endpoint_url:'https://feeds.example.test/feed.xml',capture_policy:'extract_text',fixture_content:RSS});
  expect(queued.statusCode,queued.body).toBe(202);
  const jobId=queued.json().data.job_id;
  expect((await rows('SELECT payload_json FROM jobs WHERE id=$1',[jobId]))[0].payload_json).toMatchObject({kind:'recipe_plan',user_id:IDENTITY.userId});
  await runJob(jobId);
  const view=(await app.inject({method:'GET',url:`/api/v1/sources/retrieval/requests/${jobId}`})).json();
  expect(view).toMatchObject({kind:'recipe_plan',status:'completed',result:{source_type:'rss'}});
});

it('dry-run requires current management, records its outcome through the fenced writer, and activation is a cached refusal until it passes',async ctx=>{
  if(!db.available)return ctx.skip();
  const created=await recipeSource(),connection=created.connection.id,version=created.recipe_version.id;
  const early=await post(`${connection}/activate`,{recipe_version_id:version});
  expect(early.statusCode).toBe(409);expect(early.json().error.message).toBe('Recipe version must pass a dry-run before activation');
  const member='user-2';await seedSpaceMember(db.pool,{space:SPACE,user:member,role:'member'});
  __setAuthIdentityForTests({spaceId:SPACE,userId:member});
  expect((await post(`${connection}/dry-run`,{recipe_version_id:version,fixture_content:RSS})).statusCode).toBe(404);
  expect((await post(`${connection}/activate`,{recipe_version_id:version})).statusCode).toBe(404);
  __setAuthIdentityForTests(IDENTITY);
  const queued=await post(`${connection}/dry-run`,{recipe_version_id:version,fixture_content:RSS});
  expect(queued.statusCode,queued.body).toBe(202);
  expect(await runJob(queued.json().data.job_id)).toEqual({recipe_version_id:version,source_connection_id:connection,dry_run_status:'succeeded',item_count:2});
  expect((await rows("SELECT status,test_result_json->>'status' AS result FROM source_recipe_versions WHERE id=$1",[version]))[0]).toEqual({status:'draft',result:'succeeded'});
  const key=randomUUID(),activated=await post(`${connection}/activate`,{recipe_version_id:version},key);
  expect(activated.statusCode,activated.body).toBe(200);
  expect(activated.json().data).toMatchObject({id:connection,space_id:SPACE,recipe_version_id:version});
  expect(['active','pending_approval']).toContain(activated.json().data.status);
  expect((await post(`${connection}/activate`,{recipe_version_id:version},key)).json()).toEqual(activated.json());
});

it('planning outside the Space Custom Source domain policy is a cached refusal and queues nothing',async ctx=>{
  if(!db.available)return ctx.skip();
  await upsertCustomSourceSpacePolicy(db.pool,SPACE,{allowed_domains:['allowed.example.test']});
  const key=randomUUID(),body={name:'Recipe Feed',endpoint_url:'https://feeds.example.test/feed.xml',fixture_content:RSS};
  const refused=await post('plan',body,key);
  expect(refused.statusCode).toBe(422);expect(refused.json().error.message).toBe('Domain not allowed by Space Custom Source policy: feeds.example.test');
  // The cached refusal replays under the new request id.
  const replay=await post('plan',body,key);expect(replay.statusCode).toBe(422);expect({...replay.json().error,request_id:null}).toEqual({...refused.json().error,request_id:null});
  expect(await rows('SELECT id FROM jobs')).toEqual([]);
});
