import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {SOURCE_RETRIEVAL_JOB} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedCustomSourceWorld} from './support/customSourceWorld.js';
import {seedRun,seedSpaceMember} from './support/domainSeeds.js';
import {sourcePolicyEnvelope} from './support/customSourceFixtures.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig,type ServerConfig} from '../src/config.js';
import {SourceRecipeCreateService} from '../src/modules/sources/sourceRecipes/recipeCreateService.js';
import {SourceRecipeDryRunService} from '../src/modules/sources/sourceRecipes/recipeDryRunService.js';
import {SourceGoalService,type GoalExecutionPort} from '../src/modules/sources/goals/service.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';

/**
 * Plan 5 Goals family: the retained goal-setup / goal control URLs as core
 * commands (explicit key, strict input, identity receipts released under the
 * caller's current authority), the preview as a single-attempt Job, one
 * transaction for a setup message and its queued Run, and cancellation intents.
 */
const db=useTestDatabase(import.meta.filename,{max:8});
const identity={spaceId:'goal-ops-space',userId:'goal-ops-owner'};
let config:ServerConfig,root:string,channelId:string,connectionId:string,author:string,app:ReturnType<typeof buildModuleServer>;
const port:GoalExecutionPort={async execute(){return {output:{contract_version:'custom_source.handler_output.v1',items:[{external_id:'preserved',title:'Robotics update',source_uri:'https://fixture.test/article',published_at:'2026-10-27T00:00:00Z',snapshots:[],evidence:[]}]},fixture:{responses:[]},filesRoot:root,envelope:sourcePolicyEnvelope({allowed_network_origins:['https://fixture.test'],capture_policy:'reference_only',retention_policy:'metadata_only'}),source_kind:'feed',cursor:{watermark:'2026-10-27T00:00:00Z'},cleanup:async()=>{}}}};
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;
const post=(url:string,payload:object,key:string|null=randomUUID())=>app.inject({method:'POST',url:`/api/v1/sources/${url}`,payload,headers:key?{'idempotency-key':key}:{}});

beforeEach(async()=>{
  if(!db.available)return;
  await resetTables(db.pool,['source_request_quota_state','spaces','users','source_provider_connectors','source_providers','source_connectors'],{cascade:true});
  await seedCustomSourceWorld(db.pool,identity);
  await db.pool.query(`UPDATE spaces SET type='personal' WHERE id=$1`,[identity.spaceId]);
  root=await mkdtemp(join(tmpdir(),'goal-ops-'));
  config={...loadConfig({}),databaseUrl:db.connectionUri,rainverHome:root,artifactStorageRoot:root};
  author=randomUUID();
  await seedRun(db.pool,{id:author,space:identity.spaceId,owner:identity.userId,agent:'stage3-agent',version:'stage3-version'});
  const creator=new SourceRecipeCreateService(db.pool,config);
  const source=await creator.createSource(identity,{name:'Existing robotics',source_type:'rss',endpoint_url:'https://fixture.test/feed',fetch_frequency:'daily',capture_policy:'reference_only',retention_policy:'metadata_only'});
  connectionId=source.connection.id;channelId=source.connection.source_channel_id;
  await new SourceRecipeDryRunService(db.pool,config).dryRunRecipeVersion(identity,connectionId,{recipe_version_id:source.recipe_version.id,fixture_content:'<rss><channel><item><guid>preserved</guid><title>Robotics</title><link>https://fixture.test/article</link></item></channel></rss>'});
  await creator.activateRecipe(identity,connectionId,{recipe_version_id:source.recipe_version.id});
  app=buildModuleServer(config,[sourcesModule,systemActionsModule]);
  __setAuthIdentityForTests(identity);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();if(root)await rm(root,{recursive:true,force:true});});

/** A mapped Monitor with one written plan, through the retained legacy URL. */
async function mappedPlan(){
  const mapped=await post('goal-setup/legacy',{channel_id:channelId});
  expect(mapped.statusCode,mapped.body).toBe(200);
  const goal=mapped.json().data.goal_id as string;
  await db.pool.query('UPDATE runs SET instructed_by_user_id=$2,contract_snapshot_json=$3 WHERE id=$1',[author,identity.userId,{workflow_input_json:{source_goal:{goal_id:goal,purpose:'explore'}}}]);
  const version=await new SourceGoalService(db.pool,config,port).writeVersion(identity,{goal_id:goal,expected_revision:0,plan:{title:'Robotics',summary:'Preserve this source',sources:[{source_connection_id:connectionId,source_channel_id:channelId,reason:'Existing robotics source',supports_history:false,implementation:{kind:'connector'}}],limitations:[]}},author);
  return {goal,version:version.id};
}

it('maps a Monitor through the retained URL: explicit key, dry run writes nothing, replay is the same receipt, others are hidden',async ctx=>{
  if(!db.available)return ctx.skip();
  expect((await post('goal-setup/legacy',{channel_id:channelId},null)).statusCode).toBe(422);
  expect((await post('goal-setup/legacy',{channel_id:channelId,extra:true})).statusCode).toBe(422);
  const dry=await post('goal-setup/legacy',{channel_id:channelId,dry_run:true});
  expect(dry.statusCode,dry.body).toBe(200);
  expect(dry.json().data).toMatchObject({id:channelId,space_id:identity.spaceId,goal_id:null,created:false,dry_run:true,source_connection_id:connectionId});
  expect(await rows('SELECT id FROM source_goals')).toEqual([]);
  const key=randomUUID();
  const first=await post('goal-setup/legacy',{channel_id:channelId},key);
  expect(first.json().data).toMatchObject({id:channelId,created:true,dry_run:false});
  const replay=await post('goal-setup/legacy',{channel_id:channelId},key);
  expect(replay.json()).toEqual(first.json());
  expect(await rows('SELECT count(*)::int AS n FROM source_goals')).toEqual([{n:1}]);
  __setAuthIdentityForTests({...identity,userId:'goal-ops-other'});
  expect((await post('goal-setup/legacy',{channel_id:channelId})).statusCode).toBe(404);
});

it('queues the preview as a single-attempt Job, refuses a second in flight, and a Job after a pause stores nothing',async ctx=>{
  if(!db.available)return ctx.skip();
  const {goal,version}=await mappedPlan();
  const queued=await post(`goals/${goal}/preview`,{version_id:version});
  expect(queued.statusCode,queued.body).toBe(202);
  const receipt=queued.json().data;
  expect(receipt).toMatchObject({id:goal,space_id:identity.spaceId,status:'pending'});
  expect(await rows('SELECT id,status FROM source_goal_previews')).toEqual([{id:receipt.preview_id,status:'running'}]);
  expect(await rows('SELECT job_type,max_attempts,payload_json FROM jobs WHERE id=$1',[receipt.job_id])).toEqual([{job_type:SOURCE_RETRIEVAL_JOB,max_attempts:1,payload_json:{kind:'goal_preview',user_id:identity.userId,request:{goal_id:goal,preview_id:receipt.preview_id}}}]);
  const busy=await post(`goals/${goal}/preview`,{version_id:version});
  expect(busy.statusCode,busy.body).toBe(409);
  expect(busy.json().error.metadata).toEqual({code:'source_goal_preview_in_progress'});
  // The Job body repeats admission under current authority; a paused goal stores nothing.
  expect((await post(`goals/${goal}/pause`,{version_id:null})).json().data).toEqual({id:goal,space_id:identity.spaceId,status:'paused'});
  const service=new SourceGoalService(db.pool,config,port);
  expect(await service.runPreview(identity,goal,receipt.preview_id,AbortSignal.timeout(10000))).toEqual({preview_id:receipt.preview_id,status:'stale'});
  expect(await rows('SELECT status FROM source_goal_previews WHERE id=$1',[receipt.preview_id])).toEqual([{status:'stale'}]);
});

it('runs the preview Job body to a stored result read through the goal reader, then follows with an identity receipt',async ctx=>{
  if(!db.available)return ctx.skip();
  const {goal,version}=await mappedPlan();
  const receipt=(await post(`goals/${goal}/preview`,{version_id:version})).json().data;
  const service=new SourceGoalService(db.pool,config,port);
  expect(await service.runPreview(identity,goal,receipt.preview_id,AbortSignal.timeout(10000))).toEqual({preview_id:receipt.preview_id,status:'ready'});
  const detail=await app.inject({method:'GET',url:`/api/v1/sources/goals/${goal}`});
  expect(detail.json().previews[0]).toMatchObject({id:receipt.preview_id,status:'ready'});
  const followKey=randomUUID();
  const followed=await post(`goals/${goal}/follow`,{version_id:version,idempotency_key:'start'},followKey);
  expect(followed.statusCode,followed.body).toBe(200);
  expect(followed.json().data).toEqual({id:goal,space_id:identity.spaceId,status:'running',activated:true,prepare:false});
  // A replay is released only to the goal's current manager.
  await seedSpaceMember(db.pool,{space:identity.spaceId,user:'goal-ops-heir'});
  await db.pool.query('UPDATE source_goals SET owner_user_id=$2 WHERE id=$1',[goal,'goal-ops-heir']);
  expect((await post(`goals/${goal}/follow`,{version_id:version,idempotency_key:'start'},followKey)).statusCode).toBe(404);
});

it('pause and delete write the Run cancellation intent in the command and keep the deleted receipt replayable',async ctx=>{
  if(!db.available)return ctx.skip();
  const {goal}=await mappedPlan();
  const planning=randomUUID();
  await seedRun(db.pool,{id:planning,space:identity.spaceId,owner:identity.userId,agent:'stage3-agent',version:'stage3-version',existingAgent:true});
  await db.pool.query(`UPDATE runs SET status='queued',contract_snapshot_json=$2 WHERE id=$1`,[planning,{workflow_input_json:{source_goal:{goal_id:goal,purpose:'explore'}}}]);
  const paused=await post(`goals/${goal}/pause`,{});
  expect(paused.statusCode,paused.body).toBe(200);
  expect(['cancelling','cancelled']).toContain((await rows('SELECT status FROM runs WHERE id=$1',[planning]))[0].status);
  const key=randomUUID();
  const deleted=await post(`goals/${goal}/delete`,{},key);
  expect(deleted.json().data).toEqual({id:goal,space_id:identity.spaceId,status:'deleted'});
  expect((await post(`goals/${goal}/delete`,{},key)).json()).toEqual(deleted.json());
  expect((await post(`goals/${goal}/delete`,{})).statusCode).toBe(404);
});

it('creates a topic with a placement receipt, and a setup message commits with its queued Run or not at all',async ctx=>{
  if(!db.available)return ctx.skip();
  const begun=await post('goal-setup/begin',{search_path:'api',intent:'Follow robotics updates'});
  expect(begun.statusCode,begun.body).toBe(201);
  const created=begun.json().data;
  expect(created).toMatchObject({space_id:identity.spaceId,follow_activated:false});
  const goal=(await rows('SELECT id,runtime_profile_id FROM source_goals WHERE id=$1',[created.id]))[0];
  await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[goal.runtime_profile_id]);
  const refused=await post('goal-setup/message',{goal_id:goal.id,content:'Follow robotics updates',idempotency_key:'m1'});
  expect(refused.statusCode,refused.body).toBe(409);
  expect(refused.json().error.metadata).toEqual({code:'source_goal_execution_setup_required'});
  expect(await rows('SELECT id FROM messages')).toEqual([]);
  expect(await rows("SELECT id FROM jobs WHERE job_type='agent_run'")).toEqual([]);
  await db.pool.query('UPDATE agent_runtime_profiles SET enabled=true,is_default=true WHERE id=$1',[goal.runtime_profile_id]);
  const sent=await post('goal-setup/message',{goal_id:goal.id,content:'Follow robotics updates',idempotency_key:'m1'});
  expect(sent.statusCode,sent.body).toBe(200);
  const message=sent.json().data;
  expect(message).toMatchObject({id:goal.id,space_id:identity.spaceId});
  expect(await rows("SELECT payload_json->>'run_id' AS run FROM jobs WHERE job_type='agent_run'")).toEqual([{run:message.run_id}]);
  expect(await rows("SELECT run_id FROM messages WHERE role='user'")).toEqual([{run_id:message.run_id}]);
  // The domain message key still deduplicates under a new transport key.
  expect((await post('goal-setup/message',{goal_id:goal.id,content:'Follow robotics updates',idempotency_key:'m1'})).json().data.run_id).toBe(message.run_id);
});

it('reads pending terminal native work and expired samples without any domain write; lifecycle maintenance still recovers them',async()=>{
 const {goal,version}=await mappedPlan(),preview=randomUUID(),collection=randomUUID();
 const contribution={source_connection_id:connectionId,status:'succeeded',capture_policy:'archive_original',retention_policy:'full_snapshot',sample_expires_at:'2020-01-01T00:00:00Z',fixture:{responses:[{content_type:'text/html',status:200,body_base64:Buffer.from('private raw calibration').toString('base64')}]},output:{contract_version:'custom_source.handler_output.v1',items:[{external_id:'sample',title:'Robotics',excerpt:'expired private body',source_uri:'https://fixture.test/sample',snapshots:[],evidence:[]}]}};
 await db.pool.query("INSERT INTO source_goal_previews(id,space_id,goal_id,version_id,status,result_json,expires_at) VALUES($1,$2,$3,$4,'running',$5,now()+interval '15 minutes')",[preview,identity.spaceId,goal,version,{contributions:[contribution]}]);
 await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[author]);
 await db.pool.query("INSERT INTO source_goal_runs(id,space_id,goal_id,version_id,status,result_json) VALUES($1,$2,$3,$4,'queued',$5)",[collection,identity.spaceId,goal,version,{native_run_id:author,preview_id:preview,spec:{source_connection_id:connectionId,source_channel_id:channelId}}]);
 const tables=['source_goals','source_goal_bindings','source_goal_previews','source_goal_runs','source_goal_repairs','source_items','source_snapshots','source_extracted_evidence','scheduler_tasks','runs','run_events','jobs'];
 // A real database refusal catches hidden write calls, including no-op updates.
 await db.pool.query("CREATE FUNCTION forbid_goal_get_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'GET tried a domain write'; END $$");
 const existing:string[]=[];
 try{
  for(const table of tables){
   if(!(await db.pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name)continue;
   await db.pool.query(`CREATE TRIGGER forbid_goal_get_write BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION forbid_goal_get_write()`);existing.push(table);
  }
  await new SourceGoalService(db.pool,config,port).read(identity,goal);
  for(let n=0;n<2;n++){
   const response=await app.inject({method:'GET',url:`/api/v1/sources/goals/${goal}`});
   expect(response.statusCode,response.body).toBe(200);
   expect(response.body).not.toContain('expired private body');
   expect(response.body).not.toContain('private raw calibration');
   expect(response.json().runs).toEqual(expect.arrayContaining([expect.objectContaining({id:collection,status:'queued'})]));
  }
  expect((await rows('SELECT result_json FROM source_goal_previews WHERE id=$1',[preview]))[0].result_json.contributions[0]).toEqual(contribution);
 }finally{
  for(const table of existing)await db.pool.query(`DROP TRIGGER forbid_goal_get_write ON ${table}`);
  await db.pool.query('DROP FUNCTION forbid_goal_get_write()');
 }
 const {enqueueDueSourceGoals}=await import('../src/modules/sources/goals/worker.js');
 await enqueueDueSourceGoals(db.pool,config);
 expect((await rows('SELECT status FROM source_goal_runs WHERE id=$1',[collection]))[0].status).toBe('failed');
 const {pruneSupersededCustomSourceHandlerArtifacts}=await import('../src/modules/sources/customSources/customSourceArtifactRetention.js');
 await pruneSupersededCustomSourceHandlerArtifacts(db.pool,config);
 const persisted=(await rows('SELECT result_json FROM source_goal_previews WHERE id=$1',[preview]))[0].result_json;
 expect(JSON.stringify(persisted)).not.toContain('expired private body');
});
