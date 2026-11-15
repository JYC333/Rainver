import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {claimJobForHandler} from './support/jobClaim.js';

const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,channel:string,connection:string,rule:string,item:string,decision:string,app:ReturnType<typeof buildModuleServer>;
const act=(action:string,key=randomUUID(),id=decision)=>app.inject({method:'POST',url:`/api/v1/sources/post-processing/decisions/${id}/actions`,payload:{action},headers:{'idempotency-key':key}});
const runOnce=(payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/sources/post-processing/run-once',payload,headers:{'idempotency-key':key}});
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;

beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
  space=randomUUID();owner=randomUUID();project=randomUUID();connection=randomUUID();channel=randomUUID();item=randomUUID();decision=randomUUID();
  const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project});
  await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now});
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[sourcesModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
  const made=await app.inject({method:'POST',url:`/api/v1/sources/channels/${channel}/post-processing/rules`,payload:{name:'Rule'},headers:{'idempotency-key':randomUUID()}});
  expect(made.statusCode,made.body).toBe(201);rule=made.json().data.id;
  await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,visibility,connection_id,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
    VALUES($1,$2,$3,'space_shared',$4,'external_url','Candidate','Excerpt',now(),now(),'excerpt_saved','summary_only',now(),now())`,[item,space,owner,connection]);
  await db.pool.query(`INSERT INTO source_channel_item_links(id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now(),now())`,[randomUUID(),space,channel,item]);
  const run=randomUUID(),agent=(await rows('SELECT agent_id FROM source_post_processing_rules WHERE id=$1',[rule]))[0].agent_id;
  await db.pool.query(`INSERT INTO source_post_processing_runs(id,space_id,source_channel_id,agent_id,rule_id,trigger_type,status,created_at) VALUES($1,$2,$3,$4,$5,'manual','succeeded',now())`,[run,space,channel,agent,rule]);
  await db.pool.query(`INSERT INTO source_post_processing_item_decisions(id,space_id,source_channel_id,run_id,rule_id,source_item_id,relevance,reason,review_status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'relevant','Matches the goal','pending',now(),now())`,[decision,space,channel,run,rule,item]);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('reviews and creates evidence in the core transaction, routes each action to its own policy, and replays',async()=>{
  const key=randomUUID(),selected=await act('select',key);
  expect(selected.statusCode,selected.body).toBe(200);
  expect(selected.json().data).toEqual({id:decision,space_id:space,review_status:'accepted'});
  expect((await act('select',key)).json()).toEqual(selected.json());
  const evidence=await act('extract_evidence');expect(evidence.statusCode,evidence.body).toBe(200);
  expect(await rows("SELECT title FROM extracted_evidence WHERE source_item_id=$1",[item])).toEqual([{title:'Candidate'}]);
  // One audited decision per invocation (the replay included), under the policy each action always had.
  expect(await rows("SELECT action FROM policy_decision_records WHERE action IN ('source.item_update','source.item_create') ORDER BY created_at")).toEqual([{action:'source.item_update'},{action:'source.item_update'},{action:'source.item_create'}]);
  expect((await act('nonsense')).statusCode).toBe(422);
  expect((await app.inject({method:'POST',url:`/api/v1/sources/post-processing/decisions/${decision}/actions`,payload:{action:'select',decision_id:decision},headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(422);
  // A decision the caller cannot reach is hidden and unchanged.
  expect((await act('dismiss',randomUUID(),randomUUID())).statusCode).toBe(404);
});

it('rerun is a single-attempt worker intent, reused while pending; the worker refuses a changed rule without repeating',async()=>{
  const first=await act('rerun_item');expect(first.statusCode,first.body).toBe(200);
  const receipt=first.json().data;expect(receipt).toMatchObject({id:decision,review_status:'rerun'});expect(receipt.job_ids).toHaveLength(1);
  expect((await act('rerun_item')).json().data.job_ids).toEqual(receipt.job_ids);
  const [job]=await rows("SELECT * FROM jobs WHERE id=$1",[receipt.job_ids[0]]);
  expect(job).toMatchObject({job_type:'source_post_processing_event',max_attempts:1,user_id:owner});
  expect(job.payload_json).toMatchObject({phase:'manual_decision',mode:'rerun_item',decision_id:decision,rule_id:rule});
  expect(await rows("SELECT id FROM source_post_processing_runs")).toHaveLength(1);
  // The rule's configuration changes after admission: the worker refuses before any Agent work.
  await db.pool.query(`UPDATE source_post_processing_rules SET input_config_json='{"max_items":3}'::jsonb WHERE id=$1`,[rule]);
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');const {registerSourcePostProcessingHandler}=await import('../src/modules/sources/postProcessing/job.js');
  const registry=new JobHandlerRegistry();registerSourcePostProcessingHandler(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const envelope=await claimJobForHandler(db.pool,job.id);
  await expect(registry.dispatch(envelope)).rejects.toThrow('Source processing rule changed after dispatch');
  await expect(registry.dispatch(envelope)).rejects.toThrow('outcome unavailable');
  expect(await rows("SELECT id FROM source_post_processing_runs")).toHaveLength(1);
});

it('one-off run admits inputs, freezes the resolved Agent into a Job intent, and caches an invalid request',async()=>{
  const key=randomUUID(),queued=await runOnce({source_item_ids:[item]},key);
  expect(queued.statusCode,queued.body).toBe(202);
  const receipt=queued.json().data;expect(receipt).toMatchObject({space_id:space,status:'pending'});expect(receipt.id).toBe(receipt.job_id);
  const [job]=await rows("SELECT payload_json FROM jobs WHERE id=$1",[receipt.job_id]);
  const agent=(await rows('SELECT agent_id FROM source_post_processing_rules WHERE id=$1',[rule]))[0].agent_id;
  expect(job.payload_json).toMatchObject({phase:'manual_run_once',user_id:owner,request:{source_item_ids:[item],source_channel_id:channel,agent_id:agent,project_id:null}});
  expect((await runOnce({source_item_ids:[item]},key)).json()).toEqual(queued.json());
  expect(await rows("SELECT id FROM source_post_processing_runs")).toHaveLength(1);
  expect((await runOnce({})).statusCode).toBe(422);
  const badKey=randomUUID(),bad=await runOnce({source_item_ids:[randomUUID()]},badKey);
  expect(bad.statusCode).toBe(422);expect(bad.json().error.message).toBe('One-off source post-processing requires inputs from exactly one source');
  expect((await runOnce({source_item_ids:[randomUUID()]},badKey)).statusCode).toBe(422);
  expect(await rows("SELECT id FROM jobs WHERE payload_json->>'phase'='manual_run_once'")).toHaveLength(1);
});
