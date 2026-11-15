import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,OWNER,AGENT,PROFILE,CONNECTION} from './support/briefingFixture.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {initializeReading} from '../src/modules/prompts/reading/workspace.js';
import {RuntimeContextPolicyRepository} from '../src/modules/policy/runtimeContextPolicyRepository.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';

const db=useTestDatabase(import.meta.filename,{max:8});const w=briefingWorld(db);const identity={spaceId:SPACE,userId:OWNER};
let item:string,app:ReturnType<typeof buildModuleServer>;
const post=(path:string,payload:object,key:string|null=randomUUID())=>app.inject({method:'POST',url:`/api/v1/sources/items/${item}/${path}`,payload,headers:key?{'idempotency-key':key}:{}});
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;
const allowContent=()=>db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json='{"retention_policy":"full_text"}' WHERE id=$1`,[CONNECTION]);

beforeEach(async()=>{
  if(!db.available)return;
  await w.seed();
  await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`,[SPACE,OWNER]);
  await db.pool.query(`DELETE FROM evolvable_assets WHERE asset_key='reading.project_investigation'`);
  item=await w.material('Synthetic original result');
  await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic test policy'});
  await initializeReading(db.pool,w.config(),identity);
  app=buildModuleServer(w.config(),[sourcesModule,systemActionsModule]);
  __setAuthIdentityForTests(identity);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('asks for Source consent, submits one Source-wide storage proposal per policy, and replays it',async ctx=>{
  if(!db.available)return ctx.skip();
  expect((await post('processing/start',{},null)).statusCode).toBe(422);
  const needs=await post('processing/start',{agent_id:AGENT,runtime_profile_id:PROFILE});
  expect(needs.statusCode,needs.body).toBe(200);
  expect(needs.json().data).toMatchObject({id:item,space_id:SPACE,status:'needs_consent',source_id:CONNECTION,can_request_consent:true});
  expect(await rows("SELECT id FROM runs")).toEqual([]);
  const key=randomUUID();
  const first=await post('processing/request_storage',{},key);expect(first.statusCode,first.body).toBe(200);
  const proposal=first.json().data.proposal_id;expect(proposal).toBeTruthy();
  expect((await post('processing/request_storage',{},key)).json().data.proposal_id).toBe(proposal);
  // A new request for the same Source policy reuses the pending proposal instead of adding one.
  expect((await post('processing/request_storage',{})).json().data.proposal_id).toBe(proposal);
  expect(await rows("SELECT id,status FROM proposals WHERE proposal_type='source_material_retention'")).toEqual([{id:proposal,status:'pending'}]);
  // Allowed content needs no proposal; nothing is written.
  await allowContent();
  expect((await post('processing/request_storage',{})).json().data).toEqual({id:item,space_id:SPACE,allowed:true});
});

it('queues one Run + operation + Job intent, reuses the active one, caches a refusal, and cancels with an intent',async ctx=>{
  if(!db.available)return ctx.skip();
  await allowContent();
  const key=randomUUID();
  const started=await post('processing/start',{agent_id:AGENT,runtime_profile_id:PROFILE},key);
  expect(started.statusCode,started.body).toBe(200);
  const receipt=started.json().data;expect(receipt).toMatchObject({id:item,space_id:SPACE,status:'queued'});
  expect(await rows("SELECT id,status FROM runs")).toEqual([{id:receipt.run_id,status:'queued'}]);
  expect(await rows("SELECT id,status FROM extraction_jobs WHERE metadata_json->>'material_processing'='true'")).toEqual([{id:receipt.processing_id,status:'pending'}]);
  expect(await rows("SELECT payload_json->>'run_id' AS run FROM jobs WHERE job_type='agent_run'")).toEqual([{run:receipt.run_id}]);
  const replay=await post('processing/start',{agent_id:AGENT,runtime_profile_id:PROFILE},key);
  expect(replay.json().data).toEqual(receipt);
  expect((await post('processing/start',{agent_id:AGENT,runtime_profile_id:PROFILE},key.replace(/.$/,'0'))).json().data).toMatchObject({status:'queued',processing_id:receipt.processing_id});
  expect(await rows("SELECT id FROM runs")).toHaveLength(1);
  // A different execution selection while one is active is a cached refusal.
  const other=randomUUID(),refused=await post('processing/start',{agent_id:other,runtime_profile_id:randomUUID()},other);
  expect(refused.statusCode).toBe(409);expect(refused.json().error.message).toBe('A different material execution selection is already active');
  expect((await post('processing/start',{agent_id:other,runtime_profile_id:randomUUID()},other)).statusCode).toBe(422);
  // A non-writer cannot cancel and changes nothing.
  const reader=randomUUID();await seedSpaceMember(db.pool,{space:SPACE,user:reader,role:'member'});
  __setAuthIdentityForTests({spaceId:SPACE,userId:reader});
  expect((await post('processing/cancel',{})).statusCode).toBe(404);
  __setAuthIdentityForTests(identity);
  expect(await rows("SELECT status FROM extraction_jobs WHERE id=$1",[receipt.processing_id])).toEqual([{status:'pending'}]);
  const cancelKey=randomUUID(),cancelled=await post('processing/cancel',{},cancelKey);
  expect(cancelled.statusCode,cancelled.body).toBe(200);
  expect(cancelled.json().data).toEqual({id:item,space_id:SPACE,status:'cancelled',processing_id:receipt.processing_id,run_id:receipt.run_id,cancel_requested:true});
  expect(await rows("SELECT status,error_code FROM extraction_jobs WHERE id=$1",[receipt.processing_id])).toEqual([{status:'failed',error_code:'source_material_cancelled'}]);
  expect(['cancelling','cancelled']).toContain((await rows("SELECT status FROM runs WHERE id=$1",[receipt.run_id]))[0].status);
  expect((await post('processing/cancel',{},cancelKey)).json().data).toEqual(cancelled.json().data);
  // A later cancel without active work reports the settled state and requests nothing.
  expect((await post('processing/cancel',{})).json().data).toMatchObject({status:'cancelled'});
  expect((await post('processing/cancel',{})).json().data.cancel_requested).toBeUndefined();
});

it('refuses a stale Markdown choice with its structured code and guards the processing-state read',async ctx=>{
  if(!db.available)return ctx.skip();
  await allowContent();
  const stale=await post('reading-syntax',{syntax:'markdown',artifact_id:randomUUID(),source_snapshot_id:null});
  expect(stale.statusCode).toBe(409);expect(stale.json().error.metadata).toEqual({code:'reading_version_changed'});
  expect((await post('reading-syntax',{syntax:'markdown',artifact_id:randomUUID(),source_snapshot_id:null,source_item_id:item})).statusCode).toBe(422);
  const read=(headers:Record<string,string>)=>app.inject({method:'GET',url:`/api/v1/sources/items/${item}/processing`,headers});
  expect((await read({'sec-fetch-site':'cross-site'})).statusCode).toBe(403);
  const own=await read({'sec-fetch-site':'same-origin'});expect(own.statusCode,own.body).toBe(200);expect(own.json()).toEqual({status:'idle'});
});


it.each(['overdue','terminal'] as const)('polling %s work never cancels, settles or publishes material',async kind=>{
  await allowContent();
  const start=await post('processing/start',{agent_id:AGENT,runtime_profile_id:PROFILE});
  expect(start.statusCode,start.body).toBe(200);
  const {run_id,processing_id}=start.json().data;
  await db.pool.query("UPDATE runs r SET status=$2,started_at=now()-interval '1 hour',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id",[run_id,kind==='overdue'?'running':'failed']);
  const before=await rows('SELECT status,metadata_json,error_code,xmin::text AS version FROM extraction_jobs WHERE id=$1',[processing_id]);
  const sourceBefore=await rows('SELECT content_hash,xmin::text AS version FROM source_items WHERE id=$1',[item]);
  const read=await app.inject({method:'GET',url:`/api/v1/sources/items/${item}/processing`,headers:{'sec-fetch-site':'same-origin'}});
  expect(read.statusCode,read.body).toBe(200);
  expect(read.json()).toMatchObject({processing_id,run_id,status:kind==='overdue'?'running':'failed'});
  expect(await rows('SELECT status,metadata_json,error_code,xmin::text AS version FROM extraction_jobs WHERE id=$1',[processing_id])).toEqual(before);
  expect(await rows('SELECT content_hash,xmin::text AS version FROM source_items WHERE id=$1',[item])).toEqual(sourceBefore);
  expect(await rows('SELECT status FROM runs WHERE id=$1',[run_id])).toEqual([{status:kind==='overdue'?'running':'failed'}]);
});
