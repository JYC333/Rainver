import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {loadConfig,type ServerConfig} from '../src/config.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {seedCustomSourceWorld} from './support/customSourceWorld.js';
import {CUSTOM_SOURCE_LIST_PIPELINE,TWO_ARTICLE_HTML} from './support/customSourceFixtures.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {resetTables} from './support/resetTables.js';
import {useTestDatabase} from './support/testDatabase.js';
import {claimJobForHandler} from './support/jobClaim.js';

const SPACE='space-a',IDENTITY={spaceId:SPACE,userId:'user-1'},SECRET='PRIVATE-fetch-secret-value';
const db=useTestDatabase(import.meta.filename,{max:8});
let config:ServerConfig,root:string,app:ReturnType<typeof buildModuleServer>;
const send=(method:'POST'|'PUT',url:string,payload:object,key=randomUUID())=>app.inject({method,url:'/api/v1/sources/'+url,payload,headers:{'idempotency-key':key}});
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;
const asMember=async()=>{await seedSpaceMember(db.pool,{space:SPACE,user:'user-2',role:'member'});__setAuthIdentityForTests({spaceId:SPACE,userId:'user-2'});};

beforeEach(async()=>{
  if(!db.available)return;
  await resetTables(db.pool,['jobs','policy_decision_records','proposals','credentials','settings','source_handler_versions','source_handler_runs','spaces','users','source_providers','source_connectors','source_provider_connectors'],{cascade:true});
  await seedCustomSourceWorld(db.pool,IDENTITY);
  root=await mkdtemp(join(tmpdir(),'custom-source-ops-'));
  config={...loadConfig({}),databaseUrl:db.connectionUri,artifactStorageRoot:root,rainverHome:root,customSourceAllowedLanguages:['typescript_node','declarative_pipeline_v1']};
  app=buildModuleServer(config,[sourcesModule,systemActionsModule]);
  __setAuthIdentityForTests(IDENTITY);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();if(root)await rm(root,{recursive:true,force:true});});

it('stores a credential once: no secret in the receipt, request record or audit; same key with another secret is refused',async ctx=>{
  if(!db.available)return ctx.skip();
  const key=randomUUID(),created=await send('POST','custom-source-credentials',{name:'Fixture access',secret:SECRET},key);
  expect(created.statusCode,created.body).toBe(201);
  expect(created.body).not.toContain(SECRET);expect(created.json().data).toMatchObject({name:'Fixture access'});
  expect((await send('POST','custom-source-credentials',{name:'Fixture access',secret:SECRET},key)).json()).toEqual(created.json());
  expect((await send('POST','custom-source-credentials',{name:'Fixture access',secret:'another'},key)).json().error.code).toBe('idempotency_key_reused');
  expect(await rows('SELECT id FROM credentials')).toHaveLength(1);
  for(const table of ['operation_idempotency','policy_decision_records','credentials'])expect(JSON.stringify(await rows(`SELECT * FROM ${table}`))).not.toContain(SECRET);
  await asMember();
  expect((await send('POST','custom-source-credentials',{name:'Other',secret:SECRET})).statusCode).toBe(404);
});

it('drafts, generates and queues a test under current Source management; activation is a cached refusal until tested',async ctx=>{
  if(!db.available)return ctx.skip();
  // Without a Project the access owner places a draft in the person's Personal Space; this world has a Project.
  const project=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,'Project','active',$3,now(),now())",[project,SPACE,IDENTITY.userId]);
  const draftBody={name:'Example Source',endpoint_url:'https://example.com/list',project_id:project,config:{list_selector:'article'}};
  const draftKey=randomUUID(),draft=await send('POST','custom-sources/drafts',draftBody,draftKey);
  expect(draft.statusCode,draft.body).toBe(201);
  const connection=draft.json().data.id;expect(draft.json().data.status).toBe('paused');
  expect((await send('POST','custom-sources/drafts',draftBody,draftKey)).json()).toEqual(draft.json());
  expect((await send('POST','custom-sources/drafts',{...draftBody,credential_ref:{id:'x'}})).statusCode).toBe(422);
  const generated=await send('POST',`custom-sources/${connection}/generate-handler`,{generation_mode:'pipeline',pipeline:CUSTOM_SOURCE_LIST_PIPELINE});
  expect(generated.statusCode,generated.body).toBe(201);const version=generated.json().data.id;
  const early=await send('POST',`custom-sources/${connection}/activate`,{handler_version_id:version});
  expect(early.statusCode).toBe(409);
  const queued=await send('POST',`custom-sources/${connection}/test-handler`,{handler_version_id:version,fixture_html:TWO_ARTICLE_HTML});
  expect(queued.statusCode,queued.body).toBe(202);
  expect((await rows('SELECT payload_json FROM jobs WHERE id=$1',[queued.json().data.job_id]))[0].payload_json).toMatchObject({kind:'custom_test',request:{source_connection_id:connection,handler_version_id:version}});
  expect(await rows('SELECT id FROM source_handler_runs')).toEqual([]);
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');const {registerSourceRetrievalJob}=await import('../src/modules/sources/retrievalOperations.js');
  const registry=new JobHandlerRegistry();registerSourceRetrievalJob(registry,config);
  const job=(await rows('SELECT * FROM jobs WHERE id=$1',[queued.json().data.job_id]))[0];
  const tested=await registry.dispatch(await claimJobForHandler(db.pool,job.id));
  expect(tested).toMatchObject({handler_version_id:version,run_status:'succeeded'});
  const activated=await send('POST',`custom-sources/${connection}/activate`,{handler_version_id:version});
  expect(activated.statusCode,activated.body).toBe(200);expect(['active','pending_approval']).toContain(activated.json().data.status);
  await asMember();
  const bodies:Record<string,object>={'generate-handler':{generation_mode:'pipeline',pipeline:CUSTOM_SOURCE_LIST_PIPELINE},'test-handler':{handler_version_id:version},activate:{handler_version_id:version},repair:{},rollback:{},'bridge-pipeline':{}};
  for(const [path,body] of Object.entries(bodies))expect((await send('POST',`custom-sources/${connection}/${path}`,body)).statusCode,path).toBe(404);
});

it('settings: Space policy only for Space admins, instance runner only for instance admins',async ctx=>{
  if(!db.available)return ctx.skip();
  const updated=await send('PUT','custom-source-settings/space',{allowed_domains:['example.com']});
  expect(updated.statusCode,updated.body).toBe(200);expect(updated.json().data.allowed_domains).toEqual(['example.com']);
  expect((await send('PUT','custom-source-settings/instance',{runner_enabled:false})).statusCode).toBe(404);
  await asMember();
  expect((await send('PUT','custom-source-settings/space',{allowed_domains:[]})).statusCode).toBe(404);
});
