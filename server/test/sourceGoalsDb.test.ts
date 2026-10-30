import {ReadingService} from '../src/modules/informationDigest/readingService.js';
import {requestGoalCheck} from '../src/modules/sources/goals/collectionQueue.js';
import {safeBusinessCursor,validBusinessTime} from '../src/modules/sources/goals/watermark.js';
import {OpenAlexConnectorHandler} from '../src/modules/sources/connectors/academicJson.js';
// Deterministic external Agent submissions against canonical Run/PG state; no model invocation.
import {registerSourceGoalActions} from '../src/modules/sources/goals/actions.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import type {SystemActionExecutor} from '../src/modules/systemActions/gateway.js';
import {sharedHostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import type {HostServerFrame,HostDaemonFrame} from '@rainver/protocol';
import {createServer,type Server} from 'node:http';
import {SourceGoalExecutor} from '../src/modules/sources/goals/execution.js';
import {startMockUpstream} from './support/mockUpstream.js';
import {fixtureServerGuard} from './support/outboundGuard.js';
import {requireGoal} from '../src/modules/sources/goals/access.js';
import {sourceQuotaGroup} from '../src/modules/sources/sourceRequestQuota.js';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {waitForLockWaiter} from './support/lockWait.js';
import type {SourceGoalBindingSpec,SourceGoalPlan} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedCustomSourceWorld,upsertCustomSourceSpacePolicy} from './support/customSourceWorld.js';
import {queueSourceGoalAgent} from '../src/modules/sources/goals/agent.js';
import {seedServerHost,seedProjectMainlineRoom,seedRun} from './support/domainSeeds.js';
import {sourcePolicyEnvelope} from './support/customSourceFixtures.js';
import {loadConfig,type ServerConfig} from '../src/config.js';
import {SourceRecipeCreateService} from '../src/modules/sources/sourceRecipes/recipeCreateService.js';
import {SourceRecipeDryRunService} from '../src/modules/sources/sourceRecipes/recipeDryRunService.js';
import {SourceGoalService,type GoalExecutionPort} from '../src/modules/sources/goals/service.js';
import {SourceGoalRepairService} from '../src/modules/sources/goals/repair.js';
import {runSourceGoalTick,enqueueDueSourceGoals} from '../src/modules/sources/goals/worker.js';
const db=useTestDatabase(import.meta.filename);const identity={spaceId:'goal-space',userId:'goal-owner'};
let config:ServerConfig,root:string,runId:string,service:SourceGoalService,goalId:string,profile:string;
let upstream:Server|undefined;
let specs:SourceGoalBindingSpec[];let data:Record<string,unknown[]>;let fail:string|null;let samplesAllowed=false;
const item=(id:string)=>({external_id:id,title:'Robotics '+id,source_uri:'https://fixture.test/'+id,published_at:'2026-10-26T00:00:00Z',snapshots:[],evidence:[]});
const executor:GoalExecutionPort={async execute(_identity,_goal,spec,cursor){if(fail===spec.source_connection_id)throw new Error('source_network_failed');return {output:{contract_version:'custom_source.handler_output.v1',items:data[spec.source_connection_id]},fixture:{responses:[]},source_kind:spec.reason,cursor:{...cursor,watermark:'2026-10-26T00:00:00Z'},filesRoot:root,envelope:sourcePolicyEnvelope({allowed_network_origins:['https://fixture.test'],retention_policy:samplesAllowed?'full_snapshot':'metadata_only',capture_policy:samplesAllowed?'archive_original':'reference_only'}),cleanup:async()=>{}};}};
beforeEach(async()=>{vi.restoreAllMocks();
 if(!db.available)return;
 await resetTables(db.pool,['source_request_quota_state','spaces','users','source_provider_connectors','source_providers','source_connectors'],{cascade:true});await seedCustomSourceWorld(db.pool,identity);await db.pool.query(`UPDATE spaces SET type='personal' WHERE id=$1`,[identity.spaceId]);
 root=await mkdtemp(join(tmpdir(),'source-goals-test-'));config={...loadConfig({}),databaseUrl:db.connectionUri,rainverHome:root,artifactStorageRoot:join(root,'artifacts')};
 await upsertCustomSourceSpacePolicy(db.pool,identity.spaceId,{default_capture_policy:'reference_only',default_retention_policy:'metadata_only',same_envelope_repair_auto_apply:true});
 runId=randomUUID();await seedRun(db.pool,{id:runId,space:identity.spaceId,owner:identity.userId,agent:'goal-agent',version:'goal-agent-version'});
 profile=(await db.pool.query<{id:string}>(`SELECT id FROM agent_runtime_profiles WHERE agent_id='goal-agent'`)).rows[0].id;
 service=new SourceGoalService(db.pool,config,executor);const goal=await service.create(identity,{intent:'Follow robotics research and industry updates',includes:['robotics'],agent_id:'goal-agent',runtime_profile_id:profile});goalId=goal.id;
 await db.pool.query(`UPDATE runs SET instructed_by_user_id=$2,contract_snapshot_json=$3 WHERE id=$1`,[runId,identity.userId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'explore'}}}]);
 specs=[];data={};fail=null;samplesAllowed=false;
 const creator=new SourceRecipeCreateService(db.pool,config);const dry=new SourceRecipeDryRunService(db.pool,config);
 for(const kind of ['feed','api']){
  const made=await creator.createSource(identity,{name:kind,endpoint_url:'https://fixture.test/'+kind,fetch_frequency:'manual',source_type:'rss',capture_policy:'reference_only',retention_policy:'metadata_only'});
  const cid=made.connection.id;await dry.dryRunRecipeVersion(identity,cid,{recipe_version_id:made.recipe_version.id,fixture_content:`<rss><channel><item><title>Robotics ${kind}</title><guid>${kind}</guid><link>https://fixture.test/${kind}</link><pubDate>Mon, 26 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`});
  await creator.activateRecipe(identity,cid,{recipe_version_id:made.recipe_version.id});
  specs.push({source_connection_id:cid,source_channel_id:made.connection.source_channel_id,reason:kind,supports_history:true,implementation:{kind:'connector'}});data[cid]=[item(kind)];
 }
});
afterEach(async()=>{if(upstream){await new Promise<void>(resolve=>upstream!.close(()=>resolve()));upstream=undefined;}if(root)await rm(root,{recursive:true,force:true});});
const plan=():SourceGoalPlan=>({summary:'Research and industry coverage',sources:specs,limitations:[]});
async function allowSamples(){samplesAllowed=true;await db.pool.query(`UPDATE source_connections SET capture_policy='archive_original',policy_json=jsonb_set(policy_json,'{retention_policy}','"full_snapshot"') WHERE space_id=$1`,[identity.spaceId]);}
async function version(){return service.writeVersion(identity,{goal_id:goalId,expected_revision:0,plan:plan()},runId);}
async function start(){const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);expect(p,JSON.stringify(p.contributions)).toMatchObject({complete:true});await service.follow(identity,goalId,{version_id:v.id,idempotency_key:'first'});return {v,p};}
it('keeps Personal ownership, rejects cross-Space reads and stale/version-forged Agent writes',async ctx=>{
 if(!db.available)return ctx.skip();expect((await service.read(identity,goalId)).goal.project_id).toBeNull();
 await expect(service.read({...identity,spaceId:'other'},goalId)).rejects.toMatchObject({statusCode:404});
 await expect(service.writeVersion(identity,{goal_id:goalId,expected_revision:0,plan:plan()},randomUUID())).rejects.toMatchObject({statusCode:403});
 await version();await expect(version()).rejects.toMatchObject({statusCode:409});
});
it('projects the planning Agent short title into goals and Reading without changing collection intent',async ctx=>{
 if(!db.available)return ctx.skip();
 await service.writeVersion(identity,{goal_id:goalId,expected_revision:0,plan:{...plan(),title:'Robotics'}},runId);
 const detail=await service.read(identity,goalId);
 expect(detail.goal.compatibility_json).toMatchObject({display_title:'Robotics'});
 expect(detail.goal.intent_json.intent).toBe('Follow robotics research and industry updates');
 expect((await service.list(identity)).goals.find(g=>g.id===goalId)?.compatibility_json).toMatchObject({display_title:'Robotics'});
 await service.follow(identity,goalId,{version_id:detail.goal.current_version_id!,idempotency_key:'short-title'});
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');
 const items=(await new ReadingService(db.pool).list(identity,{view:'all',limit:30,topic:goalId,topic_selection:'all'})).items;
 expect(items.length).toBeGreaterThan(0);expect(items[0].topics[0].title).toBe('Robotics');
});
it('reports partial/empty preview without treating HTTP or missing content as success, and never makes it a following gate',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[1].source_connection_id]=[];const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);expect(p.complete).toBe(false);await expect(service.saveSample(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'bad'})).rejects.toMatchObject({statusCode:409});expect(await service.follow(identity,goalId,{version_id:v.id,idempotency_key:'partial'})).toMatchObject({status:'running',activated:true});
});
it('serializes duplicate follow confirmations into one existing scheduler; an expired preview only stops manual save',async ctx=>{
 if(!db.available)return ctx.skip();const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);
 await db.pool.query(`UPDATE source_goal_previews SET expires_at=now()-interval '1 second' WHERE id=$1`,[p.id]);await expect(service.saveSample(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'first'})).rejects.toMatchObject({statusCode:409});
 const a={version_id:v.id,idempotency_key:'same'};const results=await Promise.all([service.follow(identity,goalId,a),service.follow(identity,goalId,a)]);expect(results.map(x=>x.status)).toEqual(['running','running']);
 expect((await db.pool.query(`SELECT count(*)::int AS n FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1`,[goalId])).rows[0].n).toBe(1);
 await Promise.all([enqueueDueSourceGoals(db.pool),enqueueDueSourceGoals(db.pool)]);expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type='source_goal_tick'`)).rows[0].n).toBe(1);
});
it('commits material before watermarks, preserves successful history and excludes active leases',async ctx=>{
 if(!db.available)return ctx.skip();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const before=(await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows;expect(before).toHaveLength(2);expect((await db.pool.query('SELECT metadata_json FROM source_items LIMIT 1')).rows[0].metadata_json).toMatchObject({capture_method:'connection_scan',goal_id:goalId,goal_binding_revision:0});
 data[specs[0].source_connection_id]=[{...item('feed'),title:'Robotics changed history'},item('new')];
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect((await db.pool.query(`SELECT title FROM source_items WHERE source_external_id='feed'`)).rows[0].title).toBe('Robotics feed');
 const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE goal_id=$1 ORDER BY id',[goalId])).rows[0];
 await db.pool.query(`UPDATE source_goal_bindings SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1`,[b.id,randomUUID()]);
 const runs=(await db.pool.query('SELECT count(*)::int AS n FROM source_goal_runs')).rows[0].n;await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect((await db.pool.query('SELECT count(*)::int AS n FROM source_goal_runs')).rows[0].n).toBe(runs+1);
 await db.pool.query(`UPDATE source_goal_bindings SET lease_until=now()-interval '1 second' WHERE id=$1`,[b.id]);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect((await db.pool.query('SELECT lease_token FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].lease_token).toBeNull();
});
it('isolates network/quota recovery from AI repair and records honest gaps',async ctx=>{
 if(!db.available)return ctx.skip();await start();fail=specs[0].source_connection_id;await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const rows=(await db.pool.query('SELECT status,cursor_json,gaps_json,repair_attempts FROM source_goal_bindings ORDER BY status')).rows;expect(rows.map(r=>r.status)).toEqual(['active','cooldown']);const bad=rows.find(r=>r.status==='cooldown')!;expect(bad.cursor_json).toEqual({});expect(bad.gaps_json).toHaveLength(1);expect(bad.repair_attempts).toBe(0);
});
it('validates fixture and live repair, CAS publishes, rolls back and refuses stale candidates',async ctx=>{
 if(!db.available)return ctx.skip();await allowSamples();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE goal_id=$1 ORDER BY id',[goalId])).rows[0];
 await db.pool.query(`UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1`,[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);
 const repairs=new SourceGoalRepairService(db.pool,config,executor);const candidate={binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}};
 await db.pool.query('UPDATE source_goal_bindings SET cursor_json=$2 WHERE id=$1',[b.id,{watermark:'2026-10-26T00:00:00Z',page:'old-implementation'}]);
 const result=await repairs.candidate(identity,goalId,candidate,runId);expect(result.status).toBe('published');
 await expect(repairs.candidate(identity,goalId,candidate,runId)).rejects.toMatchObject({statusCode:409});
 expect((await db.pool.query('SELECT cursor_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].cursor_json).toEqual({watermark:'2026-10-26T00:00:00Z'});await db.pool.query('UPDATE source_goal_bindings SET cursor_json=$2 WHERE id=$1',[b.id,{watermark:'2026-10-26T00:00:00Z',token:'new-implementation'}]);
 expect((await repairs.rollback(identity,goalId,b.id,1)).status).toBe('rolled_back');expect((await db.pool.query('SELECT cursor_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].cursor_json).toEqual({watermark:'2026-10-26T00:00:00Z'});
 await upsertCustomSourceSpacePolicy(db.pool,identity.spaceId,{same_envelope_repair_auto_apply:false});const held=await repairs.candidate(identity,goalId,{...candidate,expected_revision:2},runId);expect(held.status).toBe('validated');expect((await db.pool.query('SELECT status FROM source_goal_repairs WHERE id=$1',[held.repair_id])).rows[0].status).toBe('validated');expect((await repairs.publish(identity,goalId,held.repair_id,false)).status).toBe('published');
});

it('never reuses a preview after a source change, binds the current authority, and refuses revoked membership',async ctx=>{
 if(!db.available)return ctx.skip();const v=await version();await service.preview(identity,goalId,v.id,new AbortController().signal);
 await db.pool.query(`UPDATE source_channels SET endpoint_url='https://fixture.test/changed' WHERE id=$1`,[specs[0].source_channel_id]);
 const followed=await service.follow(identity,goalId,{version_id:v.id,idempotency_key:'changed'});expect(followed.follow.reused_preview_id).toBeNull();
 const changed=(await db.pool.query('SELECT fixture_json FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0].fixture_json;expect(Object.keys(changed).sort()).toEqual(['authority_scope','authority_sha256','confirmed_at']);
 await db.pool.query(`UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2`,[identity.spaceId,identity.userId]);
 await expect(service.read(identity,goalId)).rejects.toMatchObject({statusCode:404});
});
it('commits neither material nor watermark when stopped during a response',async ctx=>{
 if(!db.available)return ctx.skip();await start();let calls=0;
 const stopped:GoalExecutionPort={async execute(...args){calls++;await db.pool.query(`UPDATE source_goals SET status='paused' WHERE id=$1`,[goalId]);return executor.execute(...args);}};
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,stopped);
 expect(calls).toBeGreaterThan(0);expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBe(0);
 expect((await db.pool.query('SELECT cursor_json,lease_token FROM source_goal_bindings')).rows.every(r=>JSON.stringify(r.cursor_json)==='{}'&&r.lease_token===null)).toBe(true);
});
it('keeps successful history through repair CAS, incremental work and gap recovery',async ctx=>{
 if(!db.available)return ctx.skip();await allowSamples();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const before=(await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows;
 const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];
 // This author Run is a deterministic DB fixture, not real Agent generation.
 await db.pool.query(`UPDATE source_goal_bindings SET status='paused',gaps_json=$2 WHERE id=$1`,[b.id,JSON.stringify([{from:{watermark:'2026-10-25T00:00:00Z'},at:'2026-10-26T00:00:00Z',reason:'source_parser_validation_failed',recoverable:true}])]);
 await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);
 expect((await new SourceGoalRepairService(db.pool,config,executor).candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId)).status).toBe('published');
 const order:string[]=[];
 const recovering:GoalExecutionPort={async execute(i,g,s,c,signal){if(s.source_connection_id!==b.source_connection_id)return executor.execute(i,g,s,c,signal);order.push(c.__goal_history?'history':'new');const r=await executor.execute(i,g,s,c,signal);return {...r,output:{contract_version:'custom_source.handler_output.v1',items:[{...item(c.__goal_history?'missed':'latest'),published_at:c.__goal_history?'2026-10-26T00:00:00Z':'2026-10-27T00:00:00Z'}]},cursor:c.__goal_history?{history_window:{...(c.__goal_window as object),exhausted:true}}:{watermark:'2026-10-27T00:00:00Z'}};}};
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,recovering);expect(order).toEqual(['new','history']);
 expect((await db.pool.query('SELECT id,title,content_hash FROM source_items WHERE id=ANY($1::varchar[]) ORDER BY id',[before.map(r=>r.id)])).rows).toEqual(before);
 const recovered=(await db.pool.query('SELECT cursor_json,gaps_json,lease_token FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0];expect(recovered.cursor_json).toMatchObject({watermark:'2026-10-27T00:00:00Z'});expect(recovered.gaps_json[0].status).toBe('covered');expect(recovered.lease_token).toBeNull();expect((await service.read(identity,goalId)).runs.length).toBeGreaterThan(0);
});

async function realExecutorFixture(jsonApi=false,feedCount=1,reverse=false){
 let hits=0;let status=200;let changed=false;
 upstream=createServer((req,res)=>{hits++;if(jsonApi&&(req.url==='/api'||req.url==='/api/detail')){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(changed?{payload:{id:'os-new',title:'Robotics changed',date:'2026-10-27T00:00:00Z',url:`http://127.0.0.1:${(upstream!.address() as {port:number}).port}/api/os-new`},history:{id:'os-missed',title:'Robotics missed',date:'2026-10-26T12:00:00Z',url:`http://127.0.0.1:${(upstream!.address() as {port:number}).port}/api/os-missed`}}:{id:'os-live',title:'Robotics isolated',date:'2026-10-26T00:00:00Z',url:`http://127.0.0.1:${(upstream!.address() as {port:number}).port}/api/os-live`}));return;}res.writeHead(status,{'content-type':'application/rss+xml',...(status===429?{'retry-after':'120'}:{})});const order=Array.from({length:feedCount},(_,n)=>n);if(reverse)order.reverse();res.end(`<rss><channel>${order.map(n=>`<item><guid>${req.url}-${n}</guid><title>Robotics live ${n}</title><link>http://127.0.0.1:${(upstream!.address() as {port:number}).port}${req.url}/article/${n}</link><pubDate>${new Date(Date.parse('2026-10-26T00:00:00Z')+Math.floor(n/10)*1000).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`);});
 await new Promise<void>(resolve=>upstream!.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
 for(const spec of specs){await db.pool.query('UPDATE source_channels SET endpoint_url=$2 WHERE id=$1',[spec.source_channel_id,origin+'/'+spec.reason]);await db.pool.query('UPDATE source_recipe_versions SET policy_envelope_json=$2 WHERE source_connection_id=$1 AND status=\'active\'',[spec.source_connection_id,sourcePolicyEnvelope({allowed_network_origins:[origin],capture_policy:samplesAllowed?'archive_original':'reference_only',retention_policy:samplesAllowed?'full_snapshot':'metadata_only'})]);}
 return {executor:new SourceGoalExecutor(db.pool,config,fixtureServerGuard),hits:()=>hits,status:(s:number)=>{status=s;},changeStructure:()=>{changed=true;}};
}
it('runs real HTTP through the shared persisted account and endpoint quota, without double charging offline fixtures',async ctx=>{
 if(!db.available)return ctx.skip();const f=await realExecutorFixture();const goal=await requireGoal(db.pool,identity,goalId,true);
 const execute=(n:number)=>f.executor.execute(identity,{...goal,execution_scope:randomUUID()},specs[n],{},AbortSignal.timeout(2000));
 const runs=await Promise.all([execute(0),execute(1)]);expect(f.hits()).toBe(2);expect(runs.map(r=>r.source_kind)).toEqual(['feed','feed']);
 const key=sourceQuotaGroup(identity.userId+':mapping-custom-source','account');expect((await db.pool.query('SELECT windows_json FROM source_request_quota_state WHERE group_key=$1',[key])).rows[0].windows_json.day.used).toBe(2);
 const replay=await f.executor.execute(identity,{...goal,execution_scope:randomUUID()},specs[0],{},AbortSignal.timeout(2000),runs[0].fixture);await replay.cleanup();expect(f.hits()).toBe(2);
 for(const r of runs)await r.cleanup();
 f.status(429);await expect(execute(0)).rejects.toThrow('source_quota_exhausted');await expect(execute(1)).rejects.toThrow('source_quota_exhausted');expect(f.hits()).toBe(3);
});
it('refuses revoked Sources and cancelled execution before the physical HTTP send',async ctx=>{
 if(!db.available)return ctx.skip();const f=await realExecutorFixture();const goal=await requireGoal(db.pool,identity,goalId,true);const cancelled=new AbortController();cancelled.abort();
 await expect(f.executor.execute(identity,goal,specs[0],{},cancelled.signal)).rejects.toThrow();expect(f.hits()).toBe(0);
 await db.pool.query(`UPDATE source_connections SET status='paused' WHERE id=$1`,[specs[0].source_connection_id]);await expect(f.executor.execute(identity,goal,specs[0],{},AbortSignal.timeout(2000))).rejects.toThrow();expect(f.hits()).toBe(0);
});
it('queues the existing exact-profile Agent Run once under concurrent exploration requests',async ctx=>{
 if(!db.available)return ctx.skip();const [a,b]=await Promise.all([queueSourceGoalAgent(db.pool,config,identity,goalId,'explore'),queueSourceGoalAgent(db.pool,config,identity,goalId,'explore')]);expect(a.run_id).toBe(b.run_id);
 const queued=(await db.pool.query('SELECT requested_runtime_profile_id,contract_snapshot_json FROM runs WHERE id=$1',[a.run_id])).rows[0];expect(queued.requested_runtime_profile_id).toBe(profile);expect(queued.contract_snapshot_json.workflow_input_json.source_goal.goal_id).toBe(goalId);
 expect((await db.pool.query('SELECT agent_attempts FROM source_goals WHERE id=$1',[goalId])).rows[0].agent_attempts).toBe(1);expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=$1`,[a.run_id])).rows[0].n).toBe(1);
});
it('enforces Project membership separately from Space membership and rejects mismatched source context',async ctx=>{
 if(!db.available)return ctx.skip();await db.pool.query(`UPDATE spaces SET type='team' WHERE id=$1`,[identity.spaceId]);
 await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES('goal-project',$1,$2,'Robotics','active',now(),now())`,[identity.spaceId,identity.userId]);await seedProjectMainlineRoom(db.pool,{space:identity.spaceId,project:'goal-project',owner:identity.userId});
 const projected=await service.create(identity,{intent:'Robotics Project sources',project_id:'goal-project',agent_id:'goal-agent',runtime_profile_id:profile});
 await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES('goal-viewer','Viewer','active','goal-viewer@test.invalid','system',now(),now())`);await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,'goal-viewer','member','active',now(),now())`,[randomUUID(),identity.spaceId]);
 const viewer={spaceId:identity.spaceId,userId:'goal-viewer'};await expect(service.read(viewer,projected.id)).rejects.toMatchObject({statusCode:404});
 await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,'goal-project','goal-viewer','viewer','active',now(),now())`,[randomUUID(),identity.spaceId]);expect((await service.read(viewer,projected.id)).goal.id).toBe(projected.id);
 await expect(service.stop(viewer,projected.id)).rejects.toMatchObject({statusCode:403});
 await db.pool.query('UPDATE runs SET project_id=$2,contract_snapshot_json=$3 WHERE id=$1',[runId,projected.project_id,{workflow_input_json:{source_goal:{goal_id:projected.id,purpose:'explore'}}}]);
 await expect(service.writeVersion(identity,{goal_id:projected.id,expected_revision:0,plan:plan()},runId)).rejects.toMatchObject({statusCode:403});
});
it.skipIf(process.env.SOURCE_GOAL_OS_SMOKE!=='1').for([{archive:true,pages:1},{archive:false,pages:1},{archive:false,pages:2}])('runs an exact SHA handler through actual isolation, bounded repair and materialization (%j)',async({archive,pages},ctx)=>{
 if(!db.available)return ctx.skip();if(archive)await allowSamples();await db.pool.query(`UPDATE source_goals SET budget_json=jsonb_set(budget_json,'{requests_per_run}',$2::jsonb) WHERE id=$1`,[goalId,pages===2?'5':'2']);const f=await realExecutorFixture(true);const hostId=randomUUID();await seedServerHost(db.pool,{id:hostId});await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"sources_execution":"isolated-v1"}'::jsonb WHERE id=$1`,[hostId]);
 const moduleUrl=new URL('../../packages/host-daemon/dist/sourceExecutionChannel.js',import.meta.url).href;
 const {SourceExecutionChannel}=await import(moduleUrl);
 const channel=new SourceExecutionChannel({root:join(root,'host-source'),node:process.execPath,maxConcurrent:1,enabled:true,bwrap:process.env.SOURCE_EXECUTION_BWRAP,cgroupRoot:process.env.SOURCE_EXECUTION_CGROUP_ROOT},(frame:HostDaemonFrame)=>{
  if(frame.type==='source_request')sharedHostConnectionRegistry.receiveSourceRequest(hostId,frame.execution_id,frame.request);
  if(frame.type==='source_result')sharedHostConnectionRegistry.receiveSourceResult(hostId,frame.execution_id,frame.result);
 });
 const sink={send:(frame:HostServerFrame)=>channel.handle(frame),close:()=>channel.disconnect()};sharedHostConnectionRegistry.registerConnection(hostId,sink,true);
 try{
  const endpoint=(await db.pool.query('SELECT endpoint_url FROM source_channels WHERE id=$1',[specs[1].source_channel_id])).rows[0].endpoint_url;
  const code=`export default async ({request})=>{const r=await request(${JSON.stringify(endpoint)});const data=JSON.parse(Buffer.from(r.body_base64,'base64').toString());return {items:[{external_id:data.id,title:data.title,source_uri:${JSON.stringify(endpoint+'/article')},published_at:'2026-10-26T00:00:00Z',snapshots:[],evidence:[]}],cursor:{watermark:'2026-10-26T00:00:00Z'}}}`;
  const spec:SourceGoalBindingSpec={...specs[1],implementation:{kind:'isolated',code,sha256:createHash('sha256').update(code).digest('hex')}};
  specs[1]=spec;service=new SourceGoalService(db.pool,config,f.executor);const {p}=await start();expect(p.contributions.map(c=>'source_kind' in c?c.source_kind:null)).toEqual(['feed','api']);
  await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);expect(f.hits()).toBe(4);expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBe(2);expect((await service.read(identity,goalId)).runs.every(r=>r.status==='succeeded')).toBe(true);
  const history=(await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows;
  f.changeStructure();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);
  const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[spec.source_connection_id])).rows[0];expect(b.status).toBe('repair_required');expect(b.gaps_json).toHaveLength(1);
  await db.pool.query(`UPDATE source_goal_bindings SET retry_at=now()-interval '1 second' WHERE id=$1`,[b.id]);await queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id);
  await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);
  // Test-authored candidate under a fixture author Run. This exercises actual
  // validation/OS execution; it deliberately does not claim model generation.
  if(pages===2){await db.pool.query("UPDATE source_request_quota_state SET windows_json=jsonb_set(windows_json,'{minute,reset}','0') WHERE windows_json ? 'minute'");const g=await requireGoal(db.pool,identity,goalId,true);const inspected=await f.executor.execute(identity,{...g,execution_scope:runId,execution_repair_binding:b.id},spec,{},AbortSignal.timeout(5000),undefined,true);await inspected.cleanup();}
  const trialHits=f.hits();
  const fixed=`export default async ({input,request})=>{let r=await request(input.endpoint_url);${pages===2?"r=await request(input.endpoint_url+'/detail');":''}const body=JSON.parse(Buffer.from(r.body_base64,'base64').toString());const data=input.cursor.__goal_history?body.history:(body.payload||body);return {items:[{external_id:data.id,title:data.title,source_uri:${pages===2?'data.url':"input.endpoint_url+'/'+data.id"},published_at:data.date,snapshots:[],evidence:[]}],cursor:input.cursor.__goal_history?{history_window:{...input.cursor.__goal_window,exhausted:true}}:{watermark:data.date}}}`;
  const repairs=new SourceGoalRepairService(db.pool,config,f.executor);const repairResult=await repairs.candidate(identity,goalId,{binding_id:b.id,expected_revision:b.revision,implementation:{kind:'isolated',code:fixed,sha256:createHash('sha256').update(fixed).digest('hex')}},runId);if(repairResult.status==='validated')await repairs.publish(identity,goalId,repairResult.repair_id);expect(repairResult.status).toBe('published');if(!archive)expect(f.hits()-trialHits).toBe(2*pages);
  if(!archive){
   // The preceding preview, scans and live trial requests consume the
   // real account cap. Expire only its minute window in this test DB;
   // retain day/Run counters to simulate the next normal scheduler minute.
   const state=(await db.pool.query("SELECT sum((windows_json->'day'->>'used')::int)::int n FROM source_request_quota_state WHERE windows_json ? 'minute'")).rows[0].n;expect(state).toBeGreaterThanOrEqual(8);
   await db.pool.query("UPDATE source_request_quota_state SET windows_json=jsonb_set(windows_json,'{minute,reset}','0') WHERE windows_json ? 'minute'");
  }
  await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);
  const recovered=(await db.pool.query('SELECT cursor_json,gaps_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0];expect(recovered.cursor_json.watermark).toBe('2026-10-27T00:00:00Z');expect(recovered.gaps_json[0].status).toBe('covered');
  expect((await db.pool.query('SELECT id,title,content_hash FROM source_items WHERE id=ANY($1::varchar[]) ORDER BY id',[history.map(r=>r.id)])).rows).toEqual(history);
  expect((await db.pool.query('SELECT source_external_id FROM source_items')).rows.map(r=>r.source_external_id)).toEqual(expect.arrayContaining(['os-live','os-new','os-missed']));

 }finally{sharedHostConnectionRegistry.unregisterConnection(hostId,sink,true);channel.disconnect();}
});
it('pauses revoked source authority without invoking AI repair or advancing its cursor',async ctx=>{
 if(!db.available)return ctx.skip();await start();await db.pool.query(`UPDATE source_connections SET status='paused' WHERE id=$1`,[specs[0].source_connection_id]);
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const b=(await db.pool.query('SELECT status,cursor_json,repair_attempts,gaps_json FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];expect(b.status).toBe('paused');expect(b.cursor_json).toEqual({});expect(b.repair_attempts).toBe(0);expect(b.gaps_json[0].reason).toBe('source_authority_revoked');
 expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type='agent_run'`)).rows[0].n).toBe(0);
});

it.for([false,true])('consumes >20 feed rows in multiple bounded batches in either order (reverse=%s), including equal timestamps',async(reverse,ctx)=>{
 if(!db.available)return ctx.skip();const f=await realExecutorFixture(false,45,reverse);service=new SourceGoalService(db.pool,config,f.executor);await start();
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);
 const first=(await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows;expect(first).toHaveLength(40);
 const pending=(await db.pool.query('SELECT cursor_json FROM source_goal_bindings LIMIT 1')).rows[0].cursor_json;expect(pending.remaining_count).toBe(25);expect(pending.watermark).toBeUndefined();
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);
 expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBe(90);
 expect((await db.pool.query('SELECT id,title,content_hash FROM source_items WHERE id=ANY($1::varchar[]) ORDER BY id',[first.map(r=>r.id)])).rows).toEqual(first);
 expect((await db.pool.query('SELECT cursor_json FROM source_goal_bindings')).rows.every(r=>r.cursor_json.remaining_count===0&&r.cursor_json.watermark==='2026-10-26T00:00:04.000Z')).toBe(true);
});
it('keeps the approved plan running while exploring and atomically adopts only a fresh confirmed candidate',async ctx=>{
 if(!db.available)return ctx.skip();const old=await start();await queueSourceGoalAgent(db.pool,config,identity,goalId,'explore');expect((await service.read(identity,goalId)).goal.status).toBe('running');
 const v=await service.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:plan()},runId);expect((await service.read(identity,goalId)).goal.active_version_id).toBe(old.v.id);
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBe(2);
 await service.preview(identity,goalId,v.id,new AbortController().signal);await service.follow(identity,goalId,{version_id:v.id,idempotency_key:'replacement'});expect((await service.read(identity,goalId)).goal.active_version_id).toBe(v.id);
 expect((await db.pool.query(`SELECT count(*)::int AS n FROM scheduler_tasks WHERE task_key=$1 AND task_type='source_goal_tick'`,[goalId])).rows[0].n).toBe(1);
});
it('filters ordinary irrelevant rows independently, without triggering AI repair',async ctx=>{
 if(!db.available)return ctx.skip();await start();data[specs[0].source_connection_id]=[item('wanted'),{...item('unrelated'),title:'Weather today'}];await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 expect((await db.pool.query(`SELECT count(*)::int AS n FROM source_items WHERE source_external_id='unrelated'`)).rows[0].n).toBe(0);expect((await db.pool.query('SELECT repair_attempts,status FROM source_goal_bindings')).rows.every(r=>r.repair_attempts===0&&r.status==='active')).toBe(true);
 data[specs[0].source_connection_id]=[{...item('unrelated'),title:'Weather today'}];await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect((await db.pool.query(`SELECT status FROM source_goal_runs WHERE binding_id=(SELECT id FROM source_goal_bindings WHERE source_connection_id=$1) ORDER BY started_at DESC LIMIT 1`,[specs[0].source_connection_id])).rows[0].status).toBe('insufficient');
});
it('allows a single Source preview and follows without a 500 when preview contributions are missing',async ctx=>{
 if(!db.available)return ctx.skip();specs=specs.slice(0,1);const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);expect(p.complete).toBe(true);
 await db.pool.query(`UPDATE source_goal_previews SET result_json=jsonb_set(result_json,'{contributions}','[]') WHERE id=$1`,[p.id]);expect(await service.follow(identity,goalId,{version_id:v.id,idempotency_key:'bad'})).toMatchObject({status:'running',activated:true});
});
it.for(['source_quota_exhausted','source_timeout','unclassified history failure'])('keeps committed incremental success and its new watermark when history fails: %s',async(code,ctx)=>{
 if(!db.available)return ctx.skip();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];
 await db.pool.query(`UPDATE source_goal_bindings SET gaps_json=$2 WHERE id=$1`,[b.id,JSON.stringify([{from:{watermark:'2026-10-25T00:00:00Z'},at:'2026-10-26T00:00:00Z',reason:'outage',recoverable:true}])]);
 const wrapped:GoalExecutionPort={execute(...args){if(args[3].__goal_history)throw new Error(code);return executor.execute(...args);}};await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,wrapped);
 const after=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0];expect(after.cursor_json.watermark).toBe('2026-10-26T00:00:00Z');expect(after.revision).toBe(0);expect(after.gaps_json).toHaveLength(1);expect(after.gaps_json[0].status).toBe('deferred');expect((await db.pool.query('SELECT status FROM source_goal_runs WHERE binding_id=$1',[b.id])).rows[0].status).toBe('succeeded');
});
it('does not spend active-gap capacity on 70 historical covered gaps and never exposes raw private fixtures',async ctx=>{
 if(!db.available)return ctx.skip();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];await db.pool.query('UPDATE source_goal_bindings SET gaps_json=$2 WHERE id=$1',[b.id,JSON.stringify(Array.from({length:70},()=>({status:'covered',reason:'old'})))]);
 fail=specs[0].source_connection_id;await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);const after=(await db.pool.query('SELECT status,gaps_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0];expect(after.status).toBe('cooldown');expect(after.gaps_json).toHaveLength(71);
 const read=await service.read(identity,goalId);expect(JSON.stringify(read.bindings)).not.toContain('body_base64');expect(read.bindings.every(r=>!r.fixture_json?.fixture)).toBe(true);
});
it('retains a validated candidate on a lease conflict, refreshes its live fixture, and publishes explicitly after release',async ctx=>{
 if(!db.available)return ctx.skip();await allowSamples();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);
 await db.pool.query(`UPDATE source_goal_bindings SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1`,[b.id,randomUUID()]);
 const repairs=new SourceGoalRepairService(db.pool,config,executor);const result=await repairs.candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId);expect(result.status).toBe('validated');expect((await db.pool.query('SELECT status FROM source_goal_repairs WHERE id=$1',[result.repair_id])).rows[0].status).toBe('validated');
 await db.pool.query('UPDATE source_goal_bindings SET lease_token=NULL,lease_until=NULL WHERE id=$1',[b.id]);await repairs.publish(identity,goalId,result.repair_id,false);
 const changed=(await db.pool.query('SELECT fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].fixture_json;expect(changed.output).toMatchObject({contract_version:'custom_source.handler_output.v1',items:data[b.source_connection_id]});expect(changed.previous).toBeTruthy();expect(changed.fixture).toEqual({responses:[]});
});
it('gives four Sources two requests each per declared Run while repeated inspect-like calls cannot reset a Source budget',async ctx=>{
 if(!db.available)return ctx.skip();const creator=new SourceRecipeCreateService(db.pool,config),dry=new SourceRecipeDryRunService(db.pool,config);
 for(const reason of ['third','fourth']){const made=await creator.createSource(identity,{name:reason,endpoint_url:'https://fixture.test/'+reason,fetch_frequency:'manual',source_type:'rss',capture_policy:'reference_only',retention_policy:'metadata_only'});await dry.dryRunRecipeVersion(identity,made.connection.id,{recipe_version_id:made.recipe_version.id,fixture_content:`<rss><channel><item><guid>${reason}</guid><title>Robotics</title><link>https://fixture.test/${reason}</link></item></channel></rss>`});await creator.activateRecipe(identity,made.connection.id,{recipe_version_id:made.recipe_version.id});specs.push({source_connection_id:made.connection.id,source_channel_id:made.connection.source_channel_id,reason,supports_history:false,implementation:{kind:'connector'}});}
 const f=await realExecutorFixture();const g={...await requireGoal(db.pool,identity,goalId,true),execution_scope:randomUUID()};g.budget_json={...g.budget_json,requests_per_run:2};
 const call=async(n:number,scope=g.execution_scope)=>{const r=await f.executor.execute(identity,{...g,execution_scope:scope},specs[n],{},AbortSignal.timeout(2000));await r.cleanup();};
 for(let n=0;n<4;n++)await call(n);expect(f.hits()).toBe(4);await call(0);await expect(call(0)).rejects.toThrow('source_quota_exhausted');expect(f.hits()).toBe(5);await call(0,randomUUID());expect(f.hits()).toBe(6);
});
it('applies metadata-only retention to every preview/read path including nested validation',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[0].source_connection_id]=[{...item('private-body'),excerpt:'UNRETAINED_BODY_MARKER',metadata:{body:'UNRETAINED_BODY_MARKER'}}];const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);expect(JSON.stringify(p)).not.toContain('UNRETAINED_BODY_MARKER');expect(JSON.stringify(p)).not.toContain('body_base64');await service.follow(identity,goalId,{version_id:v.id,idempotency_key:'retention'});await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect(JSON.stringify(await service.read(identity,goalId))).not.toContain('UNRETAINED_BODY_MARKER');
});
it('does not let one user exhaust another account through a shared provider origin',async ctx=>{
 if(!db.available)return ctx.skip();const f=await realExecutorFixture();const first={...await requireGoal(db.pool,identity,goalId,true),execution_scope:randomUUID()};
 for(let n=0;n<10;n++){const r=await f.executor.execute(identity,{...first,execution_scope:randomUUID()},specs[0],{},AbortSignal.timeout(2000));await r.cleanup();}
 await expect(f.executor.execute(identity,{...first,execution_scope:randomUUID()},specs[0],{},AbortSignal.timeout(2000))).rejects.toThrow('source_quota_exhausted');
 const other={spaceId:'account-other-space',userId:'account-other-owner'};await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active','other-account@test.invalid','system',now(),now())`,[other.userId]);await db.pool.query(`INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Other','personal',$2,now(),now())`,[other.spaceId,other.userId]);await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())`,[randomUUID(),other.spaceId,other.userId]);await seedRun(db.pool,{id:randomUUID(),space:other.spaceId,owner:other.userId,agent:'other-account-agent',version:'other-account-version'});
 const profileId=(await db.pool.query(`SELECT id FROM agent_runtime_profiles WHERE agent_id='other-account-agent'`)).rows[0].id;const s=await service.create(other,{intent:'Robotics updates',agent_id:'other-account-agent',runtime_profile_id:profileId});
 const origin=new URL((await db.pool.query('SELECT endpoint_url FROM source_channels WHERE id=$1',[specs[0].source_channel_id])).rows[0].endpoint_url).origin;const creator=new SourceRecipeCreateService(db.pool,config);const made=await creator.createSource(other,{name:'Other Source',endpoint_url:origin+'/other',fetch_frequency:'manual',source_type:'rss',capture_policy:'reference_only',retention_policy:'metadata_only'});await new SourceRecipeDryRunService(db.pool,config).dryRunRecipeVersion(other,made.connection.id,{recipe_version_id:made.recipe_version.id,fixture_content:`<rss><channel><item><guid>other</guid><title>Robotics</title><link>${origin}/other/article</link></item></channel></rss>`});await creator.activateRecipe(other,made.connection.id,{recipe_version_id:made.recipe_version.id});
 const r=await f.executor.execute(other,{...await requireGoal(db.pool,other,s.id,true),execution_scope:randomUUID()},{...specs[0],source_connection_id:made.connection.id,source_channel_id:made.connection.source_channel_id},{},AbortSignal.timeout(2000));await r.cleanup();expect(f.hits()).toBe(11);
});

it.for(['recipe','isolated'] as const)('selects >cap %s output across batches with equal timestamps without repair or rewriting history',async(kind,ctx)=>{
 if(!db.available)return ctx.skip();await start();const target=specs[0];
 const code='export default async()=>({items:[]})';await db.pool.query('UPDATE source_goal_bindings SET spec_json=$2 WHERE source_connection_id=$1',[target.source_connection_id,{...target,implementation:kind==='isolated'?{kind,code,sha256:createHash('sha256').update(code).digest('hex')}:{kind,recipe:{}}}]);
 // Execution port is deterministic; actual recipe + isolated executors are
 // exercised separately below/the opt-in OS suite. This guards worker handling.
 const many:GoalExecutionPort={async execute(...args){const r=await executor.execute(...args);return args[2].source_connection_id===target.source_connection_id?{...r,output:{contract_version:'custom_source.handler_output.v1',items:Array.from({length:45},(_,n)=>item('bulk-'+n))},cursor:{token:'next-page'}}:r;}};
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,many);const before=(await db.pool.query('SELECT id,title,content_hash FROM source_items WHERE connection_id=$1 ORDER BY id',[target.source_connection_id])).rows;expect(before).toHaveLength(20);
 let b=(await db.pool.query('SELECT cursor_json,status,repair_attempts FROM source_goal_bindings WHERE source_connection_id=$1',[target.source_connection_id])).rows[0];expect(b.cursor_json.remaining_count).toBe(25);expect(b.cursor_json.token).toBeUndefined();expect(b.cursor_json.watermark).toBeUndefined();
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,many);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,many);
 expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items WHERE connection_id=$1',[target.source_connection_id])).rows[0].n).toBe(45);
 b=(await db.pool.query('SELECT cursor_json,status,repair_attempts FROM source_goal_bindings WHERE source_connection_id=$1',[target.source_connection_id])).rows[0];expect(b).toMatchObject({status:'active',repair_attempts:0,cursor_json:{remaining_count:0,token:'next-page',watermark:'2026-10-26T00:00:00Z'}});
 expect((await db.pool.query('SELECT id,title,content_hash FROM source_items WHERE id=ANY($1::varchar[]) ORDER BY id',[before.map(r=>r.id)])).rows).toEqual(before);
});
it('runs a real bounded recipe repeatedly and records its non-pageable truncation as an honest gap',async ctx=>{
 if(!db.available)return ctx.skip();const f=await realExecutorFixture(false,45);const active=(await db.pool.query('SELECT recipe_json FROM source_recipe_versions WHERE source_connection_id=$1 AND status=\'active\'',[specs[0].source_connection_id])).rows[0].recipe_json;
 specs=[{...specs[0],implementation:{kind:'recipe',recipe:active}}];service=new SourceGoalService(db.pool,config,f.executor);await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);
 const b=(await db.pool.query('SELECT cursor_json,gaps_json,status,repair_attempts FROM source_goal_bindings')).rows[0];expect(b).toMatchObject({status:'active',repair_attempts:0,cursor_json:{unrecoverable_remainder:true,coverage:'recipe_truncated'}});expect(b.cursor_json.watermark).toBeUndefined();expect(b.gaps_json).toHaveLength(1);expect(b.gaps_json[0]).toMatchObject({status:'unrecoverable',reason:'source_recipe_truncated'});expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBeGreaterThan(0);
});
it('never persists forbidden raw samples and rejects semantically unsupported transient repair',async ctx=>{
 if(!db.available)return ctx.skip();const marker='FORBIDDEN_RAW_BODY';const privateExecutor:GoalExecutionPort={async execute(...args){return {...await executor.execute(...args),fixture:{responses:[{sequence:1,status:200,content_type:'application/json',body_base64:Buffer.from(JSON.stringify({private:marker})).toString('base64')}]},output:{contract_version:'custom_source.handler_output.v1',cursor:{raw:marker},diagnostics:{warnings:[marker]},items:[{...item('private'),excerpt:marker}]}};}};
 service=new SourceGoalService(db.pool,config,privateExecutor);await start();
 expect(JSON.stringify((await db.pool.query('SELECT result_json FROM source_goal_previews')).rows)).not.toContain(marker);expect(JSON.stringify((await db.pool.query('SELECT result_json FROM source_goal_previews')).rows)).not.toContain('body_base64');
 const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];expect(b.fixture_json.fixture).toBeUndefined();expect(JSON.stringify(b.fixture_json)).not.toContain(marker);
 await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);await expect(new SourceGoalRepairService(db.pool,config,privateExecutor).candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId)).rejects.toThrow('source_repair_validation_insufficient');expect((await db.pool.query("SELECT status,validation_json FROM source_goal_repairs")).rows).toMatchObject([{status:'failed'}]);expect(JSON.stringify((await db.pool.query('SELECT validation_json FROM source_goal_repairs')).rows)).not.toContain(marker);
});
it.for(['expire','delete','downgrade'] as const)('scrubs every raw sample copy on %s without deleting successful items',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();await allowSamples();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);const history=(await db.pool.query('SELECT id,title FROM source_items ORDER BY id')).rows;
 const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];const raw={...b.fixture_json,fixture:{responses:[{sequence:1,status:200,content_type:'text/plain',body_base64:'UkFX'}]},sample_expires_at:mode==='expire'?'2000-01-01T00:00:00Z':new Date(Date.now()+60000).toISOString()};
 await db.pool.query('UPDATE source_goal_bindings SET fixture_json=$2 WHERE id=$1',[b.id,{...raw,previous:raw,failure:raw}]);await db.pool.query(`UPDATE source_goal_previews SET result_json=jsonb_build_object('contributions',jsonb_build_array($2::jsonb)) WHERE goal_id=$1`,[goalId,{...raw,source_connection_id:b.source_connection_id}]);
 await db.pool.query(`INSERT INTO source_goal_repairs(id,space_id,binding_id,base_revision,candidate_json,created_by_run_id,validation_json) VALUES($1,$2,$3,0,$4,$5,$6)`,[randomUUID(),identity.spaceId,b.id,b.spec_json,runId,{live_sample:raw}]);
 if(mode==='delete')await service.stop(identity,goalId,true);else{if(mode==='downgrade')await db.pool.query(`UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','"metadata_only"') WHERE id=$1`,[b.source_connection_id]);const {cleanGoalSamples}=await import('../src/modules/sources/goals/samples.js');await cleanGoalSamples(db.pool,config,goalId);}
 const all=[...(await db.pool.query('SELECT fixture_json FROM source_goal_bindings')).rows,...(await db.pool.query('SELECT result_json FROM source_goal_previews')).rows,...(await db.pool.query('SELECT validation_json FROM source_goal_repairs')).rows];expect(JSON.stringify(all)).not.toContain('body_base64');expect(JSON.stringify(all)).not.toContain('UkFX');expect((await db.pool.query('SELECT id,title FROM source_items ORDER BY id')).rows).toEqual(history);
});
it('resets implementation-specific cursors on exact confirmed version switch and preserves history and gaps',async ctx=>{
 if(!db.available)return ctx.skip();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);const history=(await db.pool.query('SELECT id,title FROM source_items ORDER BY id')).rows;
 await db.pool.query(`UPDATE source_goal_bindings SET cursor_json=$2,gaps_json=$3 WHERE goal_id=$1`,[goalId,{watermark:'2026-10-26T00:00:00Z',token:'OLD_FORMAT',pending_watermark:'2099-01-01T00:00:00Z',remaining_count:1},JSON.stringify([{from:{watermark:'2026-10-25T00:00:00Z',page:'OLD'},cursor:{token:'OLD'},at:'2026-10-26T00:00:00Z',reason:'outage',recoverable:true}])]);
 const v=await service.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:plan()},runId);await service.follow(identity,goalId,{version_id:v.id,idempotency_key:'new-version'});
 const bindings=(await db.pool.query('SELECT cursor_json,gaps_json FROM source_goal_bindings')).rows;for(const b of bindings){expect(b.cursor_json).toEqual({watermark:'2026-10-26T00:00:00Z'});expect(JSON.stringify(b.gaps_json)).not.toContain('OLD');expect(b.gaps_json).toHaveLength(2);}
 const checked:GoalExecutionPort={async execute(...args){expect(args[3]).not.toHaveProperty('token');expect(args[3]).not.toHaveProperty('pending_watermark');const result=await executor.execute(...args);return {...result,output:{contract_version:'custom_source.handler_output.v1',items:[{...item('new-'+args[2].source_connection_id),published_at:'2026-10-27T00:00:00Z'}]},cursor:{new_page:1}};}};await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,checked);expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBe(4);expect((await db.pool.query('SELECT id,title FROM source_items WHERE id=ANY($1::varchar[]) ORDER BY id',[history.map(x=>x.id)])).rows).toEqual(history);
});
it('consumes a real recipe >commit cap across batches without increasing its approved extraction limit',async ctx=>{
 if(!db.available)return ctx.skip();const f=await realExecutorFixture(false,45,true);const recipe=(await db.pool.query('SELECT recipe_json FROM source_recipe_versions WHERE source_connection_id=$1 AND status=\'active\'',[specs[0].source_connection_id])).rows[0].recipe_json;
 // Set the fixture's approved response contract before preview; goal batch20 stays20.
 await db.pool.query(`UPDATE source_recipe_versions SET policy_envelope_json=jsonb_set(policy_envelope_json,'{limits,max_items}','50') WHERE source_connection_id=$1 AND status='active'`,[specs[0].source_connection_id]);specs=[{...specs[0],implementation:{kind:'recipe',recipe}}];service=new SourceGoalService(db.pool,config,f.executor);await start();
 for(let n=0;n<3;n++)await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);
 expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBe(45);const b=(await db.pool.query('SELECT cursor_json,status,repair_attempts FROM source_goal_bindings')).rows[0];expect(b).toMatchObject({status:'active',repair_attempts:0,cursor_json:{remaining_count:0}});
});
it.skipIf(process.env.SOURCE_GOAL_OS_SMOKE!=='1')('selects >cap actual isolated output on the Host across three commits, including equal timestamps',async ctx=>{
 if(!db.available)return ctx.skip();specs=specs.slice(0,1);const f=await realExecutorFixture(false,45,true);const hostId=randomUUID();await seedServerHost(db.pool,{id:hostId});await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"sources_execution":"isolated-v1"}'::jsonb WHERE id=$1`,[hostId]);
 const {SourceExecutionChannel}=await import(new URL('../../packages/host-daemon/dist/sourceExecutionChannel.js',import.meta.url).href);
 const channel=new SourceExecutionChannel({root:join(root,'host-cap'),node:process.execPath,maxConcurrent:1,enabled:true,bwrap:process.env.SOURCE_EXECUTION_BWRAP,cgroupRoot:process.env.SOURCE_EXECUTION_CGROUP_ROOT},(frame:HostDaemonFrame)=>{if(frame.type==='source_request')sharedHostConnectionRegistry.receiveSourceRequest(hostId,frame.execution_id,frame.request);if(frame.type==='source_result')sharedHostConnectionRegistry.receiveSourceResult(hostId,frame.execution_id,frame.result);});
 const sink={send:(frame:HostServerFrame)=>channel.handle(frame),close:()=>channel.disconnect()};sharedHostConnectionRegistry.registerConnection(hostId,sink,true);
 try{const code=`export default async({input,request})=>{const r=await request(input.endpoint_url);const xml=Buffer.from(r.body_base64,'base64').toString('utf8');return {items:[...xml.matchAll(/<item>(.*?)<\\/item>/g)].map(m=>{const t=tag=>m[1].match(new RegExp('<'+tag+'>(.*?)</'+tag+'>'))[1];return {external_id:t('guid'),title:t('title'),source_uri:t('link'),published_at:new Date(t('pubDate')).toISOString(),snapshots:[],evidence:[]}}),cursor:{page:'next'}}}`;
 specs=[{...specs[0],implementation:{kind:'isolated',code,sha256:createHash('sha256').update(code).digest('hex')}}];service=new SourceGoalService(db.pool,config,f.executor);await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);const first=(await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows;expect(first).toHaveLength(20);expect((await db.pool.query('SELECT cursor_json FROM source_goal_bindings')).rows[0].cursor_json).not.toHaveProperty('page');
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,f.executor);expect((await db.pool.query('SELECT count(*)::int AS n FROM source_items')).rows[0].n).toBe(45);expect((await db.pool.query('SELECT repair_attempts,status FROM source_goal_bindings')).rows[0]).toEqual({repair_attempts:0,status:'active'});expect((await db.pool.query('SELECT id,title,content_hash FROM source_items WHERE id=ANY($1::varchar[]) ORDER BY id',[first.map(x=>x.id)])).rows).toEqual(first);
 }finally{sharedHostConnectionRegistry.unregisterConnection(hostId,sink,true);channel.disconnect();}
},30000);
it('does not reintroduce failed implementation continuation in the gap created after automatic rollback',async ctx=>{
 if(!db.available)return ctx.skip();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];
 await db.pool.query(`UPDATE source_goal_bindings SET previous_spec_json=spec_json,cursor_json=$2,gaps_json=$3 WHERE id=$1`,[b.id,{watermark:'2026-10-26T00:00:00Z',token:'FAILED_IMPLEMENTATION'},JSON.stringify([{from:{watermark:'2026-10-25T00:00:00Z',page:'FAILED_IMPLEMENTATION'},cursor:{page:'FAILED_IMPLEMENTATION'},status:'deferred',retry_at:'2099-01-01T00:00:00Z',at:'2026-10-26T00:00:00Z',reason:'outage',recoverable:true}])]);
 const broken:GoalExecutionPort={async execute(...args){if(args[2].source_connection_id===b.source_connection_id)throw new Error('source_parser_failed');return executor.execute(...args);}};await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,broken);
 const after=(await db.pool.query('SELECT cursor_json,gaps_json,revision FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0];expect(after.revision).toBe(1);expect(after.cursor_json).toEqual({watermark:'2026-10-26T00:00:00Z'});expect(after.gaps_json).toHaveLength(2);expect(JSON.stringify(after.gaps_json)).not.toContain('FAILED_IMPLEMENTATION');expect(after.gaps_json[0].from.watermark).toBe('2026-10-25T00:00:00Z');
});

it.for(['metadata_only','reference_only','extract_text','expired'] as const)('admits bounded repair without retaining raw calibration (%s)',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();if(mode==='expired')await allowSamples();
 if(mode==='metadata_only')await db.pool.query(`UPDATE source_connections SET capture_policy='archive_original' WHERE id=$1`,[specs[0].source_connection_id]);
 if(mode==='reference_only')await db.pool.query(`UPDATE source_connections SET policy_json=jsonb_set(policy_json,'{retention_policy}','"full_snapshot"') WHERE id=$1`,[specs[0].source_connection_id]);
 if(mode==='extract_text')await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json=jsonb_set(policy_json,'{retention_policy}','"full_text"') WHERE id=$1`,[specs[0].source_connection_id]);
 await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const history=(await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows;

 if(mode==='expired')await db.pool.query(`UPDATE source_goal_bindings SET fixture_json=jsonb_set(fixture_json,'{sample_expires_at}','"2000-01-01T00:00:00Z"') WHERE source_connection_id=$1`,[specs[0].source_connection_id]);
 data[specs[0].source_connection_id]=[{broken:'changed structure'}];const before=(await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n;
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];expect(b).toMatchObject({status:'repair_required',repair_attempts:0});expect(b.fixture_json.fixture).toBeUndefined();
 await db.pool.query("UPDATE source_goal_bindings SET retry_at=now()-interval '1 second' WHERE id=$1",[b.id]);
 const [admitted,duplicate]=await Promise.all([queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id),queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id)]);expect(duplicate.run_id).toBe(admitted.run_id);
 expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(before+1);expect((await db.pool.query('SELECT repair_attempts FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].repair_attempts).toBe(1);expect((await db.pool.query('SELECT agent_attempts FROM source_goals WHERE id=$1',[goalId])).rows[0].agent_attempts).toBe(0);
 expect((await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows).toEqual(history);expect((await db.pool.query('SELECT fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].fixture_json.fixture).toBeUndefined();
});
it.for(['policy','expiry'] as const)('rechecks archive authority after admission and falls back to transient checks on %s loss',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();await allowSamples();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query(`UPDATE source_goal_bindings SET status='repair_required' WHERE id=$1`,[b.id]);
 const [admitted,duplicate]=await Promise.all([queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id),queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id)]);expect(duplicate.run_id).toBe(admitted.run_id);await db.pool.query(`UPDATE runs r SET status='running',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[admitted.run_id]);expect((await db.pool.query('SELECT repair_attempts,status FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toEqual({repair_attempts:1,status:'repairing'});
 if(mode==='policy')await db.pool.query(`UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','"metadata_only"') WHERE id=$1`,[b.source_connection_id]);else await db.pool.query(`UPDATE source_goal_bindings SET fixture_json=jsonb_set(fixture_json,'{sample_expires_at}','"2000-01-01T00:00:00Z"') WHERE id=$1`,[b.id]);let calls=0;const noProbe:GoalExecutionPort={async execute(...args){calls++;return executor.execute(...args);}};
 const candidate=new SourceGoalRepairService(db.pool,config,noProbe).candidate(identity,goalId,{binding_id:b.id,expected_revision:b.revision,implementation:{kind:'connector'}},admitted.run_id);
 if(mode==='policy'){await expect(candidate).rejects.toMatchObject({statusCode:409,responseBody:{error:'source_authority_revoked'}});expect(calls).toBe(0);}else{await expect(candidate).rejects.toThrow('source_repair_validation_insufficient');expect(calls).toBe(1);expect((await db.pool.query('SELECT fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].fixture_json.fixture).toBeUndefined();}
});
it.for(['policy','retention_disabled'] as const)('re-reads stored calibration before admission after %s changed',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();await allowSamples();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];expect(b.fixture_json.fixture).toBeDefined();await db.pool.query(`UPDATE source_goal_bindings SET status='repair_required' WHERE id=$1`,[b.id]);
 if(mode==='policy')await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text' WHERE id=$1`,[b.source_connection_id]);else config={...config,customSourceArtifactRetentionEnabled:false};
 const before=(await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n;
 if(mode==='policy'){await expect(queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id)).rejects.toMatchObject({statusCode:409,responseBody:{error:'source_authority_revoked'}});expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(before);}else{await queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id);const current=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0];expect(current).toMatchObject({status:'repairing',repair_attempts:1});expect(current.fixture_json.fixture).toBeUndefined();}
});
it('allows explicitly authorized re-planning after calibration failure without resuming or resetting repair',async ctx=>{
 if(!db.available)return ctx.skip();const first=await start();data[specs[0].source_connection_id]=[{broken:true}];await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];expect(b.status).toBe('repair_required');await db.pool.query("UPDATE source_goal_bindings SET status='paused' WHERE id=$1",[b.id]);expect((await db.pool.query(`SELECT count(*)::int n FROM jobs WHERE job_type='agent_run'`)).rows[0].n).toBe(0);
 const exploration=await queueSourceGoalAgent(db.pool,config,identity,goalId,'explore');await db.pool.query(`UPDATE runs r SET status='running',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[exploration.run_id]);
 const v=await service.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:{...plan(),sources:[specs[1]]}},exploration.run_id);expect((await db.pool.query('SELECT status,repair_attempts FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toEqual({status:'paused',repair_attempts:0});expect((await db.pool.query('SELECT active_version_id,agent_attempts FROM source_goals WHERE id=$1',[goalId])).rows[0]).toEqual({active_version_id:first.v.id,agent_attempts:1});
 expect((await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id).toBe(first.v.id);await service.follow(identity,goalId,{version_id:v.id,idempotency_key:'explicit-confirm'});expect((await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id).toBe(v.id);
});
it.for(['disabled','fingerprint'] as const)('isolates calibration authority %s and does not repeat failed work',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();await allowSamples();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];await db.pool.query(`UPDATE source_goal_bindings SET status='repair_required' WHERE id=$1`,[b.id]);
 if(mode==='disabled')await db.pool.query(`UPDATE source_connections SET status='paused' WHERE id=$1`,[b.source_connection_id]);else await db.pool.query(`UPDATE source_channels SET endpoint_url=endpoint_url||'?scope=changed' WHERE id=$1`,[specs[0].source_channel_id]);
 const calls:string[]=[];const port:GoalExecutionPort={async execute(...args){calls.push(args[2].source_connection_id);return executor.execute(...args);}};
 for(let n=0;n<3;n++)await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,port);
 expect(calls).not.toContain(b.source_connection_id);expect(calls).toHaveLength(3);expect((await db.pool.query('SELECT status,repair_attempts,fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toMatchObject({status:'paused',repair_attempts:0,fixture_json:{repair_block_reason:'source_authority_revoked'}});expect((await db.pool.query(`SELECT count(*)::int n FROM source_goal_runs WHERE binding_id=$1`,[b.id])).rows[0].n).toBe(0);expect((await db.pool.query(`SELECT count(*)::int n FROM jobs WHERE job_type='agent_run'`)).rows[0].n).toBe(0);
});
it('preserves unknown calibration database faults instead of relabelling them as revocation',async ctx=>{
 if(!db.available)return ctx.skip();await allowSamples();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query(`UPDATE source_goal_bindings SET status='repair_required' WHERE id=$1`,[b.id]);const {checkRepairCalibration}=await import('../src/modules/sources/goals/calibration.js');const failure=new Error('fixture database transport failure');
 const database={async query<Row>(sql:string,args?:readonly unknown[]){if(sql.includes('SELECT sc.*,ch.id AS channel_id'))throw failure;const result=await db.pool.query(sql,args?[...args]:undefined);return {rows:result.rows as Row[],rowCount:result.rowCount};}};
 await expect(checkRepairCalibration(database,config,identity,await requireGoal(db.pool,identity,goalId,true),b.id,true)).rejects.toBe(failure);expect((await db.pool.query('SELECT status,fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toMatchObject({status:'repair_required'});expect((await db.pool.query('SELECT fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].fixture_json.repair_block_reason).toBeUndefined();
});

/** Test-authored parser port: the separate opt-in test below uses actual
 * Host isolation and physical HTTP. This port makes negative cases deterministic. */
function transientPort(mode:'good'|'constant'|'swapped'|'unsupported'='good',sourceUri='https://fixture.test/live-new'){
 let physical=0,offline=0;const marker='NEVER_PERSIST_SOURCE_BODY';
 const current={id:'live-new',title:'Robotics new item',date:'2026-10-27T00:00:00Z',url:sourceUri,description:marker};
 const fixture={responses:[{sequence:1,status:200,content_type:mode==='unsupported'?'text/plain':'application/json',final_url:'https://fixture.test/api',body_base64:Buffer.from(mode==='unsupported'?marker:JSON.stringify({entries:[current]})).toString('base64')}]};
 const port:GoalExecutionPort={async execute(...args){const saved=args[5] as typeof fixture|undefined;const inspect=args[6];if(saved)offline++;else physical++;const response=(saved??fixture).responses[0];const row=mode==='constant'?current:mode==='unsupported'?current:JSON.parse(Buffer.from(response.body_base64,'base64').toString()).entries[0];const result=await executor.execute(...args);
 return {...result,fixture:saved??fixture,output:{contract_version:'custom_source.handler_output.v1',items:inspect?[]:[{external_id:mode==='swapped'?row.title:row.id,title:mode==='swapped'?row.id:row.title,source_uri:row.url,published_at:row.date,excerpt:marker,snapshots:[],evidence:[]}],cursor:{private:marker}}};}};
 return {port,physical:()=>physical,offline:()=>offline,marker};
}
it('validates nonarchive repair with independent synthetic/live trials, persists proof only and leaves history/watermark unchanged',async ctx=>{
 if(!db.available)return ctx.skip();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);const history=(await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows;const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];
 await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);const port=transientPort();const repairs=new SourceGoalRepairService(db.pool,config,port.port);
 expect((await repairs.candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId)).status).toBe('published');expect(port.physical()).toBe(2);expect(port.offline()).toBe(2);
 const changed=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0];expect(changed).toMatchObject({revision:1,status:'active',cursor_json:{watermark:b.cursor_json.watermark},fixture_json:{transient_validation:{mode:'ephemeral_v1',synthetic_checks:2,live_checks:2}}});expect(changed.fixture_json.fixture).toBeUndefined();expect(changed.fixture_json.output).toBeUndefined();
 expect((await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows).toEqual(history);const durable=JSON.stringify((await db.pool.query('SELECT validation_json FROM source_goal_repairs')).rows);expect(durable).not.toContain(port.marker);expect(durable).not.toContain('body_base64');expect(durable).not.toContain('Robotics new item');expect((await repairs.rollback(identity,goalId,b.id,1)).status).toBe('rolled_back');
});
it.for(['constant','swapped','unsupported'] as const)('refuses %s transient evidence without materializing, publishing or advancing watermarks',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);const port=transientPort(mode);
 await expect(new SourceGoalRepairService(db.pool,config,port.port).candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId)).rejects.toThrow('source_repair_validation_insufficient');expect(port.physical()).toBe(1);expect((await db.pool.query('SELECT revision,cursor_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toEqual({revision:0,cursor_json:{}});expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);expect(JSON.stringify((await db.pool.query('SELECT validation_json FROM source_goal_repairs')).rows)).not.toContain(port.marker);
});
it('refuses expired transient proof and implementation substitution at publication without repeating spend',async ctx=>{
 if(!db.available)return ctx.skip();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);await upsertCustomSourceSpacePolicy(db.pool,identity.spaceId,{same_envelope_repair_auto_apply:false});const port=transientPort();const repairs=new SourceGoalRepairService(db.pool,config,port.port);const held=await repairs.candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId);expect(held.status).toBe('validated');
 const saved=(await db.pool.query('SELECT validation_json FROM source_goal_repairs WHERE id=$1',[held.repair_id])).rows[0].validation_json;await db.pool.query(`UPDATE source_goal_repairs SET validation_json=jsonb_set(validation_json,'{live_sample,transient_validation,expires_at}','"2000-01-01T00:00:00Z"') WHERE id=$1`,[held.repair_id]);await expect(repairs.publish(identity,goalId,held.repair_id,false)).rejects.toMatchObject({statusCode:409});
 saved.live_sample.transient_validation.implementation_sha256='0'.repeat(64);await db.pool.query('UPDATE source_goal_repairs SET validation_json=$2 WHERE id=$1',[held.repair_id,saved]);await expect(repairs.publish(identity,goalId,held.repair_id,false)).rejects.toMatchObject({statusCode:409});expect(port.physical()).toBe(2);expect((await db.pool.query('SELECT revision FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].revision).toBe(0);
});

it('keeps repair read/inspect tool results free of raw response values in the actual registered actions',async ctx=>{
 if(!db.available)return ctx.skip();await db.pool.query(`UPDATE source_connections SET consent_json=consent_json || '{"allow_external_model_egress":true}'::jsonb WHERE space_id=$1`,[identity.spaceId]);await db.pool.query(`INSERT INTO settings(id,scope_type,scope_id,settings_key,settings_json,created_at,updated_at) VALUES(gen_random_uuid(),'space',$1,'retrieval.space.settings','{"external_egress_enabled":true}',now(),now())`,[identity.spaceId]);await start();await service.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:{...plan(),intent_snapshot:{intent:'DRAFT_UNAPPROVED_INTENT',includes:['astronomy'],excludes:[]}}},runId);const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);const run=(await new PgRunRepository(db.pool).getRun(identity.spaceId,runId))!;
 const response={sequence:1,status:200,content_type:'application/json',body_base64:Buffer.from(JSON.stringify({entries:[{id:'PRIVATE_ID',title:'PRIVATE_TITLE',date:'2026-10-27T00:00:00Z',url:'https://fixture.test/PRIVATE_URL',description:'PRIVATE_BODY'}]})).toString('base64')};
 const mocked=vi.spyOn(SourceGoalExecutor.prototype,'execute').mockImplementation(async(...args)=>({...await executor.execute(...args),fixture:{responses:[response]}}));
 try{const actions=new Map<import('@rainver/protocol').SystemActionId,SystemActionExecutor>();registerSourceGoalActions(actions,config,run);
  const call=async(name:'source.goal.read'|'source.goal.inspect',input:unknown)=>actions.get(name)!(input,{} as Parameters<SystemActionExecutor>[1]);const read=await call('source.goal.read',{goal_id:goalId});expect(JSON.stringify(read)).not.toContain('Robotics feed');expect(JSON.stringify(read)).not.toContain('Robotics api');expect(JSON.stringify(read)).not.toContain('DRAFT_UNAPPROVED_INTENT');expect(JSON.stringify(read)).toContain('Follow robotics research and industry updates');
  const inspected=await call('source.goal.inspect',{goal_id:goalId,source_connection_id:b.spec_json.source_connection_id,source_channel_id:b.spec_json.source_channel_id});const wire=JSON.stringify(inspected);expect(wire).not.toContain('PRIVATE');const synthetic=(inspected as {modelResult:{result:{synthetic_fixture:{responses:Array<{body_base64:string}>}}}}).modelResult.result.synthetic_fixture;expect(Buffer.from(synthetic.responses[0].body_base64,'base64').toString()).not.toContain('PRIVATE');
 }finally{mocked.mockRestore();}
});
it('retries a rate-limited validation candidate once after cooldown, without another model Run or repair attempt',async ctx=>{
 if(!db.available)return ctx.skip();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query("UPDATE source_goal_bindings SET status='repair_required' WHERE id=$1",[b.id]);const admitted=await queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id);await db.pool.query(`UPDATE runs r SET status='running',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[admitted.run_id]);
 const port=transientPort();let throttled=true;const limited:GoalExecutionPort={async execute(...args){if(throttled)throw new Error('source_quota_exhausted');return port.port.execute(...args);}};const repairs=new SourceGoalRepairService(db.pool,config,limited);const before=(await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n;const pending=await repairs.candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},admitted.run_id);expect(pending.status).toBe('pending');
 await repairs.retryPending(identity,goalId);expect(port.physical()).toBe(0);await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[admitted.run_id]);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect((await db.pool.query('SELECT status FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0].status).toBe('repairing');
 throttled=false;await db.pool.query("UPDATE source_goal_bindings SET retry_at=now()-interval '1 second' WHERE id=$1",[b.id]);await Promise.all([repairs.retryPending(identity,goalId),repairs.retryPending(identity,goalId)]);expect((await db.pool.query('SELECT status FROM source_goal_repairs WHERE id=$1',[pending.repair_id])).rows[0].status).toBe('published');expect(port.physical()).toBe(2);expect((await db.pool.query('SELECT repair_attempts,revision FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toEqual({repair_attempts:1,revision:1});expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(before);expect((await db.pool.query('SELECT count(*)::int n FROM source_items WHERE connection_id=$1',[b.source_connection_id])).rows[0].n).toBe(0);
});

it('refuses a live candidate that changes an existing URI stable ID, preserving committed history',async ctx=>{
 if(!db.available)return ctx.skip();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);const history=(await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows;const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE source_connection_id=$1',[specs[0].source_connection_id])).rows[0];await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);const port=transientPort('good','https://fixture.test/feed');
 await expect(new SourceGoalRepairService(db.pool,config,port.port).candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId)).rejects.toThrow('source_repair_stable_identity_drift');expect(port.physical()).toBe(1);expect((await db.pool.query('SELECT id,title,content_hash FROM source_items ORDER BY id')).rows).toEqual(history);expect((await db.pool.query('SELECT revision,cursor_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toEqual({revision:0,cursor_json:b.cursor_json});
});
it('pauses only the affected source after bounded semantic validation failures, without requesting archive retention',async ctx=>{
 if(!db.available)return ctx.skip();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query("UPDATE source_goal_bindings SET repair_attempts=2,status='repairing',retry_at=now()+interval '1 minute' WHERE id=$1",[b.id]);await db.pool.query('UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);const port=transientPort('constant');await expect(new SourceGoalRepairService(db.pool,config,port.port).candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId)).rejects.toThrow('source_repair_validation_insufficient');expect((await db.pool.query('SELECT status,retry_at,fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toMatchObject({status:'paused',retry_at:null,fixture_json:{repair_block_reason:'source_repair_validation_insufficient'}});expect((await db.pool.query('SELECT status FROM source_goal_bindings WHERE goal_id=$1 AND id<>$2',[goalId,b.id])).rows[0].status).toBe('active');expect((await db.pool.query('SELECT capture_policy FROM source_connections WHERE id=$1',[b.source_connection_id])).rows[0].capture_policy).toBe('reference_only');expect(JSON.stringify(await service.read(identity,goalId))).not.toContain(port.marker);
});
it('stops the actual request channel for cancelled repair Runs and scope changes between validation steps',async ctx=>{
 if(!db.available)return ctx.skip();const f=await realExecutorFixture();service=new SourceGoalService(db.pool,config,f.executor);await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query('UPDATE runs SET status=\'cancelled\',contract_snapshot_json=$2 WHERE id=$1',[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'repair',binding_id:b.id}}}]);const goal=await requireGoal(db.pool,identity,goalId,true);const before=f.hits();await expect(f.executor.execute(identity,{...goal,execution_scope:runId,execution_repair_binding:b.id},b.spec_json,{},AbortSignal.timeout(1000),undefined,true)).rejects.toMatchObject({statusCode:403});expect(f.hits()).toBe(before);
 await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[runId]);let changed=false;const port:GoalExecutionPort={async execute(...args){const result=await f.executor.execute(...args);if(!changed){changed=true;await db.pool.query("UPDATE source_channels SET endpoint_url=endpoint_url||'?changed=1' WHERE id=$1",[b.spec_json.source_channel_id]);}return result;}};
 await expect(new SourceGoalRepairService(db.pool,config,port).candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},runId)).rejects.toThrow('source_authority_revoked');expect(f.hits()).toBe(before+1);expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);expect((await db.pool.query('SELECT revision,cursor_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toEqual({revision:0,cursor_json:{}});
});
it('expires deferred validation instead of renewing a Run budget or generating another repair',async ctx=>{
 if(!db.available)return ctx.skip();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query("UPDATE source_goal_bindings SET status='repair_required' WHERE id=$1",[b.id]);const admitted=await queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id);await db.pool.query(`UPDATE runs r SET status='running',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[admitted.run_id]);const port:GoalExecutionPort={async execute(){throw new Error('source_network_failed');}};const repairs=new SourceGoalRepairService(db.pool,config,port);const pending=await repairs.candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},admitted.run_id);expect(pending.status).toBe('pending');
 await db.pool.query(`UPDATE source_goal_repairs SET validation_json=jsonb_set(validation_json,'{retry_expires_at}','"2000-01-01T00:00:00Z"') WHERE id=$1`,[pending.repair_id]);const before=(await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n;await repairs.retryPending(identity,goalId);expect((await db.pool.query('SELECT status,repair_attempts,fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toMatchObject({status:'paused',repair_attempts:1,fixture_json:{repair_block_reason:'source_repair_validation_insufficient'}});expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(before);
});
it.for(['cancelled','source_revoked'] as const)('classifies a deferred repair %s without a misleading retry time',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();await start();const b=(await db.pool.query('SELECT * FROM source_goal_bindings LIMIT 1')).rows[0];await db.pool.query("UPDATE source_goal_bindings SET status='repair_required' WHERE id=$1",[b.id]);const admitted=await queueSourceGoalAgent(db.pool,config,identity,goalId,'repair',b.id);await db.pool.query(`UPDATE runs r SET status='running',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[admitted.run_id]);let probes=0;const port:GoalExecutionPort={async execute(){probes++;throw new Error('source_network_failed');}};const repairs=new SourceGoalRepairService(db.pool,config,port);expect((await repairs.candidate(identity,goalId,{binding_id:b.id,expected_revision:0,implementation:{kind:'connector'}},admitted.run_id)).status).toBe('pending');
 if(mode==='cancelled')await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1",[admitted.run_id]);else await db.pool.query("UPDATE source_connections SET status='paused' WHERE id=$1",[b.source_connection_id]);await db.pool.query("UPDATE source_goal_bindings SET retry_at=now()-interval '1 second' WHERE id=$1",[b.id]);await repairs.retryPending(identity,goalId);
 expect((await db.pool.query('SELECT status,retry_at,repair_attempts,fixture_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0]).toMatchObject({status:'paused',retry_at:null,repair_attempts:1,fixture_json:{repair_block_reason:mode==='cancelled'?'source_repair_validation_insufficient':'source_authority_revoked'}});expect(probes).toBe(1);
});

it('uses canonical built-in search queries and metadata provenance without inventing publication dates',async ctx=>{
 if(!db.available)return ctx.skip();await db.pool.query("UPDATE source_connectors SET connector_key='openalex_api' WHERE id='connector-custom-source'");const {SourceChannelService}=await import('../src/modules/sources/channels/sourceChannelService.js');const ch=await new SourceChannelService(db.pool,config).create(identity,{provider_key:'custom_source',query:{search:'robotics',per_page:2},_force_create:true,name:'Robotics search',fetch_frequency:'manual'});const spec:SourceGoalBindingSpec={source_connection_id:String(ch.source_connection_id),source_channel_id:String(ch.id),reason:'Research search',supports_history:false,implementation:{kind:'connector'}};
 const {requireGoalSource,goalSourceFingerprint}=await import('../src/modules/sources/goals/access.js');const goal=await requireGoal(db.pool,identity,goalId,true);const source=await requireGoalSource(db.pool,config,identity,goal,spec);expect(source.provider_query_json).toMatchObject({search:'robotics'});expect((await db.pool.query('SELECT provider_query_json FROM source_channels WHERE id=$1',[ch.id])).rows[0].provider_query_json).toBeNull();
 const fixture={responses:[{sequence:1,status:200,content_type:'application/json',final_url:'https://api.openalex.org/works',headers:{},body_base64:Buffer.from(JSON.stringify({results:[{id:'https://openalex.org/W123',title:'Robotics systems',primary_location:{landing_page_url:'https://papers.test/robotics'}}],meta:{next_cursor:null}})).toString('base64')}]};
 const real=new SourceGoalExecutor(db.pool,config);const port:GoalExecutionPort={execute:(i,g,s,c,signal)=>real.execute(i,g,s,c,signal,fixture)};const searchService=new SourceGoalService(db.pool,config,port);const version=await searchService.writeVersion(identity,{goal_id:goalId,expected_revision:0,plan:{summary:'Robotics search',sources:[spec],limitations:['Publication date may be unknown.']}},runId);const preview=await searchService.preview(identity,goalId,version.id,AbortSignal.timeout(2000));expect(preview.complete,JSON.stringify(preview.contributions)).toBe(true);expect(preview.contributions[0].output?.items[0].published_at).toBeNull();expect(preview.contributions[0].output?.items[0].source_uri).toBe('https://papers.test/robotics');
 await searchService.follow(identity,goalId,{version_id:version.id,idempotency_key:'search-start'});await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,port);expect((await db.pool.query('SELECT source_uri FROM source_items WHERE connection_id=$1',[spec.source_connection_id])).rows).toEqual([{source_uri:'https://papers.test/robotics'}]);
 const captured=await real.execute(identity,goal,spec,{},AbortSignal.timeout(2000),fixture);expect((captured.envelope as {allowed_network_origins:string[]}).allowed_network_origins).toEqual(['https://api.openalex.org']);await captured.cleanup();const original=goalSourceFingerprint(source);await db.pool.query("UPDATE source_search_specs SET compiled_provider_query_json=jsonb_set(compiled_provider_query_json,'{search}','\"different scope\"') WHERE source_channel_id=$1",[ch.id]);expect(goalSourceFingerprint(await requireGoalSource(db.pool,config,identity,goal,spec))).not.toBe(original);
});
it('reports missing Brave credentials before network or quota consumption',async ctx=>{
 if(!db.available)return ctx.skip();await db.pool.query("UPDATE source_connectors SET connector_key='brave_web_search_api' WHERE id='connector-custom-source'");const {SourceChannelService}=await import('../src/modules/sources/channels/sourceChannelService.js');const ch=await new SourceChannelService(db.pool,config).create(identity,{provider_key:'custom_source',query:{q:'robotics'},fetch_frequency:'manual'});const goal=await requireGoal(db.pool,identity,goalId,true);await expect(new SourceGoalExecutor(db.pool,config).execute(identity,goal,{source_connection_id:String(ch.source_connection_id),source_channel_id:String(ch.id),reason:'Web search',supports_history:false,implementation:{kind:'connector'}},{},AbortSignal.timeout(1000))).rejects.toThrow('source_credential_decision_required');expect((await db.pool.query('SELECT count(*)::int n FROM source_request_quota_state')).rows[0].n).toBe(0);
});
it('recovers an in-flight preview as empty pending data and refuses a second reservation',async ctx=>{
 if(!db.available)return ctx.skip();const v=await version();await db.pool.query("INSERT INTO source_goal_previews(id,space_id,goal_id,version_id,status,result_json,expires_at) VALUES($1,$2,$3,$4,'running','{}',now()+interval '15 minutes')",[randomUUID(),identity.spaceId,goalId,v.id]);const detail=await service.read(identity,goalId);expect(detail.previews[0].result_json.contributions).toEqual([]);await expect(service.preview(identity,goalId,v.id,AbortSignal.timeout(1000))).rejects.toMatchObject({statusCode:409});expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_previews WHERE goal_id=$1',[goalId])).rows[0].n).toBe(1);
});

async function nativePlan(){
 const {seedNativeSearchCatalog}=await import('../src/modules/sources/catalog/nativeSearchCatalog.js');await seedNativeSearchCatalog(db.pool);const host=randomUUID();await seedServerHost(db.pool,{id:host});await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_key='claude_code',execution_host_id=$2,workspace_mode='managed',runtime_installation='own' WHERE id=$1`,[profile,host]);
 await db.pool.query("UPDATE hosts SET kind='remote',environment_kind='linux_native',owner_user_id=$2,capabilities_json=$3,last_heartbeat_at=now() WHERE id=$1",[host,identity.userId,{runtimes:['claude_code'],versions:{claude_code:'fixture'},installations:{claude_code:[{id:'own',version:'fixture',logged_in:true,options:{session_available:true,config_options:[]},health_check_protocol:'acp'}]}}]);
 const real=new SourceGoalService(db.pool,config,new SourceGoalExecutor(db.pool,config));const v=await real.writeVersion(identity,{goal_id:goalId,expected_revision:0,plan:{summary:'Native robotics search',sources:[{reason:'Search through selected Agent',implementation:{kind:'agent_search',query:'robotics research'},supports_history:false}],limitations:['Native search capability/usage unknown until trial']}},runId);return {real,v};
}
async function submitted(run:string,items=[{url:'https://evidence.test/robotics',title:'Robotics actual search result'}],extra:Record<string,unknown>={}){
 await db.pool.query(`UPDATE runs r SET status='running',started_at=now(),runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[run]);
 const r=(await new PgRunRepository(db.pool).getRun(identity.spaceId,run))!;if(r.execution_kind!=='agent')throw new Error('Expected Agent Run');
 const c=(r.contract_snapshot_json as {workflow_input_json:{source_goal:{goal_id:string;version_id:string;collection_id:string}}}).workflow_input_json.source_goal;
 return {run:r,input:{processing_id:c.collection_id,status:'succeeded',failure:null,items:items.map(i=>({...i,summary:null,observed_at:new Date().toISOString()})),coverage:{truncated:false,exhaustive:false,limitations:[]},...extra}};
}
async function finishNative(run:string,proof=true,items=[{url:'https://evidence.test/robotics',title:'Robotics actual search result'}]){
 if(proof){const s=await submitted(run,items);const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const accepted=await new CliAgentToolTransport(config).call(s.run,{id:'fixture-submit',name:'source.material.submit',arguments:s.input});expect(accepted).toMatchObject({ok:true});}
 await db.pool.query(`UPDATE runs r SET status='succeeded',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p),output_json=$2 FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[run,{schema_version:'run_output.v1',status:'succeeded',summary:'Fixture Agent completion, not a real model call',result:{output_text:JSON.stringify({items})},outputs:[]}]);
}
it('native search previews asynchronously through canonical Run, restores and materializes only explicitly submitted results',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();const p=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));expect(p.complete).toBe(false);let read=await real.read(identity,goalId);expect(read.previews[0].status).toBe('running');expect(read.native_runs).toHaveLength(1);expect(read.agent_runs.some(r=>r.id===read.native_runs[0].id)).toBe(false);const run=read.native_runs[0].id;expect((await db.pool.query('SELECT count(*)::int n FROM source_request_quota_state')).rows[0].n).toBe(0);
 await finishNative(run);read=await real.read(identity,goalId);expect(read.previews[0].status).toBe('ready');await freshCheckOnly();const followed=await real.follow(identity,goalId,{version_id:v.id,idempotency_key:'confirmed'});expect(followed.follow.reused_preview_id).toBeNull();
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));read=await real.read(identity,goalId);const live=read.native_runs.find(r=>r.id!==run)!;expect(live.status).toBe('queued');expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);await finishNative(live.id);await real.read(identity,goalId);expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);
 await real.read(identity,goalId);expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);
});
it('native search fails closed without the bound action submission; chat text cannot satisfy the preview',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));let read=await real.read(identity,goalId);await finishNative(read.native_runs[0].id,false);read=await real.read(identity,goalId);expect(read.previews[0].status).toBe('partial');expect(read.previews[0].result_json.contributions[0].error).toBe('source_material_submission_missing');expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);
});
it('API preflight refuses missing credential before saving an executable version',async ctx=>{
 if(!db.available)return ctx.skip();await db.pool.query(`UPDATE source_connectors SET connector_key='brave_web_search_api' WHERE id=(SELECT connector_id FROM source_provider_connectors WHERE id=(SELECT provider_connector_id FROM source_connections WHERE id=$1))`,[specs[0].source_connection_id]);await expect(version()).rejects.toMatchObject({statusCode:409,responseBody:{error:'source_credential_decision_required'}});expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_versions')).rows[0].n).toBe(0);expect((await db.pool.query('SELECT count(*)::int n FROM source_request_quota_state')).rows[0].n).toBe(0);
});
it.for(['cancelled','stale','profile_changed','revoked'] as const)('native preview rejects %s completion without fallback or materialization',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));let read=await real.read(identity,goalId);const run=read.native_runs[0].id;
 if(mode==='cancelled')await db.pool.query(`UPDATE runs SET status='cancelled' WHERE id=$1`,[run]);else{await finishNative(run);if(mode==='stale')await db.pool.query(`UPDATE source_goals SET current_version_id=NULL WHERE id=$1`,[goalId]);if(mode==='profile_changed')await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_config_json='{"changed":true}' WHERE id=$1`,[profile]);if(mode==='revoked')await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=(SELECT result_json->'spec'->>'source_connection_id' FROM source_goal_runs WHERE result_json->>'native_run_id'=$1)`,[run]);}
 read=await real.read(identity,goalId);expect(read.previews[0].status).toBe('partial');expect(read.native_runs[0].phase).toBe(mode==='cancelled'?'cancelled':'failed');await real.read(identity,goalId);expect(read.native_runs).toHaveLength(1);expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);await expect(real.read({...identity,spaceId:'another-space'},goalId)).rejects.toMatchObject({statusCode:404});
});
it('native scheduled execution refuses budget/setup without entering automatic AI repair',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));let read=await real.read(identity,goalId);await finishNative(read.native_runs[0].id);await real.read(identity,goalId);await freshCheckOnly();await real.follow(identity,goalId,{version_id:v.id,idempotency_key:'native-start'});await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[profile]);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));const b=(await db.pool.query('SELECT status,repair_attempts FROM source_goal_bindings')).rows[0];expect(b).toEqual({status:'paused',repair_attempts:0});read=await real.read(identity,goalId);expect(read.native_runs).toHaveLength(1);expect((await db.pool.query(`SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='repair'`)).rows[0].n).toBe(0);
});
it('native dispatch rechecks actual Source and rejects ordinary chat collector identities',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const read=await real.read(identity,goalId);const repo=new PgRunRepository(db.pool);const run=(await repo.getRun(identity.spaceId,read.native_runs[0].id))!;const {assertNativeCollectionDispatch}=await import('../src/modules/sources/goals/nativeDispatch.js');await assertNativeCollectionDispatch(config,run);const context=run.contract_snapshot_json as {workflow_input_json:{source_goal:{collection_id:string}}};
 await expect(assertNativeCollectionDispatch(config,{...run,id:runId})).rejects.toMatchObject({statusCode:403});await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=(SELECT result_json->'spec'->>'source_connection_id' FROM source_goal_runs WHERE id=$1)`,[context.workflow_input_json.source_goal.collection_id]);await expect(assertNativeCollectionDispatch(config,run)).rejects.toMatchObject({statusCode:403});expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);
});
it('a new native draft cannot change the active collection filters or consume its result',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));let read=await real.read(identity,goalId);await finishNative(read.native_runs[0].id);await real.read(identity,goalId);await freshCheckOnly();await real.follow(identity,goalId,{version_id:v.id,idempotency_key:'active'});await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));read=await real.read(identity,goalId);const pending=read.native_runs.find(r=>r.status==='queued')!;
 await db.pool.query('UPDATE source_goals SET intent_json=$2 WHERE id=$1',[goalId,{intent:'Follow climate',includes:['climate'],excludes:[]}]);await real.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:{summary:'Unconfirmed climate draft',sources:[{reason:'Climate native',implementation:{kind:'agent_search',query:'climate research'},supports_history:false}],limitations:[]}},runId);await db.pool.query("UPDATE source_goals SET compatibility_json=compatibility_json||jsonb_build_object('search_path','api') WHERE id=$1",[goalId]);await finishNative(pending.id);await real.read(identity,goalId);expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);expect((await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id).toBe(v.id);
});
it('native accepted-output recovery reclaims its lease and never re-runs the model or duplicates history',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));let read=await real.read(identity,goalId);await finishNative(read.native_runs[0].id);await real.read(identity,goalId);await freshCheckOnly();await real.follow(identity,goalId,{version_id:v.id,idempotency_key:'recover'});await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));read=await real.read(identity,goalId);await finishNative(read.native_runs.find(r=>r.status==='queued')!.id);
 await db.pool.query(`ALTER TABLE source_items ADD CONSTRAINT native_fixture_write_failure CHECK(title<>'Robotics actual search result')`);
 try{await expect(real.read(identity,goalId)).rejects.toThrow();expect((await db.pool.query('SELECT cursor_json FROM source_goal_bindings')).rows[0].cursor_json).toEqual({});expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);}finally{await db.pool.query('ALTER TABLE source_items DROP CONSTRAINT native_fixture_write_failure');}
 const recovered=new SourceGoalService(db.pool,config,new SourceGoalExecutor(db.pool,config));await Promise.all([recovered.read(identity,goalId),real.read(identity,goalId)]);expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);expect((await db.pool.query('SELECT cursor_json FROM source_goal_bindings')).rows[0].cursor_json.last_collected_at).toBeTruthy();expect((await db.pool.query(`SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='collect'`)).rows[0].n).toBe(2);
});
it('API search cannot silently replace Agent-native selection or use a model credential as a search key',async ctx=>{
 if(!db.available)return ctx.skip();specs=specs.slice(0,1);await db.pool.query(`UPDATE source_connectors SET connector_key='brave_web_search_api' WHERE id=(SELECT connector_id FROM source_provider_connectors WHERE id=(SELECT provider_connector_id FROM source_connections WHERE id=$1))`,[specs[0].source_connection_id]);await db.pool.query(`UPDATE source_goals SET compatibility_json='{"search_path":"agent"}' WHERE id=$1`,[goalId]);await expect(version()).rejects.toMatchObject({responseBody:{error:'source_search_path_confirmation_required'}});
 await db.pool.query(`UPDATE source_goals SET compatibility_json='{"search_path":"api"}' WHERE id=$1`,[goalId]);await upsertCustomSourceSpacePolicy(db.pool,identity.spaceId,{credentialed_sources_allowed:true});const credential=randomUUID();await db.pool.query(`INSERT INTO credentials(id,space_id,owner_user_id,name,credential_type,secret_ref,scopes_json,metadata_json,created_at,updated_at) VALUES($1,$2,$3,'Fixture model credential','model_provider_api_key','fixture:model-not-search','{}','{}',now(),now())`,[credential,identity.spaceId,identity.userId]);await db.pool.query('UPDATE source_connections SET credential_id=$2 WHERE id=$1',[specs[0].source_connection_id,credential]);await expect(version()).rejects.toMatchObject({responseBody:{error:'source_credential_decision_required'}});expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_versions')).rows[0].n).toBe(0);expect((await db.pool.query('SELECT count(*)::int n FROM source_request_quota_state')).rows[0].n).toBe(0);
});
/** Scheduled-collection tests confirm without a reusable preview so the first
 * check is a fresh native collection rather than the preview bootstrap. */
async function freshCheckOnly(){await db.pool.query("UPDATE source_goal_previews SET expires_at=now()-interval '1 second' WHERE goal_id=$1",[goalId]);}
async function readyNative(){const n=await nativePlan();await n.real.preview(identity,goalId,n.v.id,AbortSignal.timeout(10000));let d=await n.real.read(identity,goalId);await finishNative(d.native_runs[0].id);d=await n.real.read(identity,goalId);await freshCheckOnly();await n.real.follow(identity,goalId,{version_id:n.v.id,idempotency_key:'native-confirm'});return n;}
async function nativeTick(real:SourceGoalService){await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));return (await real.read(identity,goalId)).native_runs.find(r=>r.status==='queued')!.id;}
it('native normal empty polling remains active and commits no fabricated item',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const run=await nativeTick(real);await finishNative(run,true,[]);await real.read(identity,goalId);expect((await db.pool.query('SELECT status,failures,retry_at FROM source_goal_bindings')).rows[0]).toEqual({status:'active',failures:0,retry_at:null});expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);
});
it('native user cancellation pauses without retry; explicit resume has no cooldown',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await readyNative();const run=await nativeTick(real);await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1",[run]);await real.read(identity,goalId);expect((await db.pool.query('SELECT status,retry_at FROM source_goal_bindings')).rows[0]).toEqual({status:'paused',retry_at:null});const count=(await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n;await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(count);await real.stop(identity,goalId);await real.resume(identity,goalId,v.id);expect((await db.pool.query('SELECT status,retry_at FROM source_goal_bindings')).rows[0]).toEqual({status:'active',retry_at:null});
});
it.for(['waiting_for_review','waiting_for_dependency'])('native %s deadline prevents silent renewed spend',async(status,ctx)=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const run=await nativeTick(real);await db.pool.query('UPDATE runs SET status=$2,runtime_profile_id=$3,runtime_profile_selection_source=$4,runtime_key=$5,runtime_profile_snapshot_json=$6 WHERE id=$1',[run,status,profile,'explicit','claude_code',{}]);await db.pool.query("UPDATE runs SET started_at=now()-interval '601 seconds' WHERE id=$1",[run]);await real.read(identity,goalId);expect((await db.pool.query('SELECT status,retry_at,fixture_json FROM source_goal_bindings')).rows[0]).toMatchObject({status:'paused',retry_at:null,fixture_json:{collection_error:'source_native_deadline_exceeded'}});
});
it('native failures stop after three attempts and clear paused retry time',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();for(let i=1;i<=3;i++){await db.pool.query("UPDATE source_goal_bindings SET retry_at=NULL WHERE status='cooldown'");const run=await nativeTick(real);await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[run]);await real.read(identity,goalId);expect((await db.pool.query('SELECT failures FROM source_goal_bindings')).rows[0].failures).toBe(i);}expect((await db.pool.query('SELECT status,retry_at FROM source_goal_bindings')).rows[0]).toEqual({status:'paused',retry_at:null});
});
it('native resume ignores removed sources but refuses a changed current Profile',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await readyNative();await db.pool.query("INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json,status) VALUES($1,$2,$3,$4,$5,'paused')",[randomUUID(),identity.spaceId,goalId,specs[0].source_connection_id,specs[0]]);await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[specs[0].source_connection_id]);await real.stop(identity,goalId);await real.resume(identity,goalId,v.id);await real.stop(identity,goalId);await db.pool.query('UPDATE agent_runtime_profiles SET runtime_config_json=$2 WHERE id=$1',[profile,{changed:true}]);await expect(real.resume(identity,goalId,v.id)).rejects.toThrow('source_native_route_changed');
});
it('native preview excluded origins yield insufficient coverage',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await db.pool.query('UPDATE source_goal_versions SET plan_json=plan_json||$2::jsonb WHERE id=$1',[v.id,{filters:{includes:[],excludes:[],excluded_origins:['https://evidence.test']}}]);await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));let d=await real.read(identity,goalId);await finishNative(d.native_runs[0].id);d=await real.read(identity,goalId);expect(d.previews[0].result_json.contributions[0]).toMatchObject({status:'insufficient',selection:{selected_count:0,filtered_count:1}});
});
it('native draft stays paused without subscriptions; archived metadata is recreated',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();const c=(await real.read(identity,goalId)).versions[0].plan_json.sources[0];expect((await db.pool.query('SELECT status FROM source_connections WHERE id=$1',[c.source_connection_id])).rows[0].status).toBe('paused');expect((await db.pool.query('SELECT 1 FROM source_channel_user_subscriptions WHERE source_channel_id=$1',[c.source_channel_id])).rows).toHaveLength(0);await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[c.source_connection_id]);const {bindNativeSource}=await import('../src/modules/sources/goals/nativeSearch.js');const fresh=await bindNativeSource(db.pool,config,identity,await requireGoal(db.pool,identity,goalId,true),{reason:'Fresh draft',implementation:{kind:'agent_search',query:'robotics research'},supports_history:false});expect(fresh.source_connection_id).not.toBe(c.source_connection_id);
});
it('materialization recovery preserves the actual Profile refusal instead of stale result',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const run=await nativeTick(real);await finishNative(run);await db.pool.query("ALTER TABLE source_items ADD CONSTRAINT native_fixture_recovery_failure CHECK(title<>'Robotics actual search result')");try{await expect(real.read(identity,goalId)).rejects.toThrow();}finally{await db.pool.query('ALTER TABLE source_items DROP CONSTRAINT native_fixture_recovery_failure');}await db.pool.query('UPDATE agent_runtime_profiles SET runtime_config_json=$2 WHERE id=$1',[profile,{changed:true}]);await real.read(identity,goalId);expect((await db.pool.query("SELECT result_json->>'error' error FROM source_goal_runs WHERE result_json->>'native_run_id'=$1",[run])).rows[0].error).toBe('source_native_route_changed');expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(0);
});
it('native cancelled goal pause resumed before settlement does not become a one hour cooldown',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await readyNative();const run=await nativeTick(real);await real.stop(identity,goalId);await real.resume(identity,goalId,v.id);await real.read(identity,goalId);expect((await db.pool.query('SELECT status,retry_at FROM source_goal_bindings')).rows[0]).toEqual({status:'active',retry_at:null});expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0].status).toBe('cancelled');
});
it('queue congestion does not consume the dispatched execution deadline or pause collection',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const run=await nativeTick(real);await db.pool.query("UPDATE source_goal_runs SET started_at=now()-interval '1 hour' WHERE result_json->>'native_run_id'=$1",[run]);await real.read(identity,goalId);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0].status).toBe('queued');expect((await db.pool.query('SELECT status FROM source_goal_bindings')).rows[0].status).toBe('collecting');
});
it('successful native recovery clears the previous collection error',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const bad=await nativeTick(real);await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[bad]);await real.read(identity,goalId);await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL');const good=await nativeTick(real);await finishNative(good);await real.read(identity,goalId);expect((await db.pool.query('SELECT failures,fixture_json FROM source_goal_bindings')).rows[0]).toMatchObject({failures:0});expect((await db.pool.query('SELECT fixture_json FROM source_goal_bindings')).rows[0].fixture_json).not.toHaveProperty('collection_error');
});
it('old revision cancellation settlement cannot pause a newly collecting binding',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const old=await nativeTick(real);await db.pool.query("UPDATE source_goal_bindings SET revision=revision+1,status='collecting'");await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1",[old]);await Promise.all([real.read(identity,goalId),real.read(identity,goalId)]);expect((await db.pool.query('SELECT status,revision,failures FROM source_goal_bindings')).rows[0]).toMatchObject({status:'collecting',revision:1,failures:0});
});
it('old accepted revision recovery cannot pause a replacement collecting revision',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const run=await nativeTick(real);await finishNative(run);await db.pool.query("ALTER TABLE source_items ADD CONSTRAINT native_old_revision_failure CHECK(title<>'Robotics actual search result')");try{await expect(real.read(identity,goalId)).rejects.toThrow();}finally{await db.pool.query('ALTER TABLE source_items DROP CONSTRAINT native_old_revision_failure');}await db.pool.query("UPDATE source_goal_bindings SET revision=revision+1,status='collecting',lease_token=NULL,lease_until=NULL");await Promise.all([real.read(identity,goalId),real.read(identity,goalId)]);expect((await db.pool.query('SELECT status,revision,failures FROM source_goal_bindings')).rows[0]).toMatchObject({status:'collecting',revision:1,failures:0});
});
it('conversation refinement can queue behind an active collector without pausing or changing its plan',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const native=await nativeTick(real);const before=(await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id;await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[runId]);const {SourceGoalConversation}=await import('../src/modules/sources/goals/conversation.js');await new SourceGoalConversation(db.pool,config).send(identity,goalId,{content:'Give research more emphasis',idempotency_key:'collector-draft',search_path:'api'});expect((await db.pool.query('SELECT status FROM source_goal_bindings')).rows[0].status).toBe('collecting');await finishNative(native);await real.read(identity,goalId);expect((await db.pool.query('SELECT active_version_id,status FROM source_goals WHERE id=$1',[goalId])).rows[0]).toMatchObject({active_version_id:before,status:'running'});expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);
});
it('manual staging failure rolls back all Start/ownership/subscription state and same key can retry',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();const preview=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const d=await real.read(identity,goalId);await finishNative(d.native_runs[0].id);await real.read(identity,goalId);const snapshot=async()=>{const result:Record<string,unknown>={};for(const table of ['source_goals','source_goal_bindings','scheduler_tasks','source_connections','source_channels','source_channel_user_subscriptions'])result[table]=(await db.pool.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY id`)).rows;return result};const before=await snapshot();await db.pool.query("ALTER TABLE source_goal_runs ADD CONSTRAINT reject_manual_stage CHECK(NOT(result_json ? 'manual_preview_id'))");const input={version_id:v.id,preview_id:preview.id,idempotency_key:'atomic-manual'};try{await expect(real.saveSample(identity,goalId,input)).rejects.toThrow();expect(await snapshot()).toEqual(before);expect((await db.pool.query("SELECT count(*)::int n FROM source_goal_runs WHERE result_json ? 'manual_preview_id'")).rows[0].n).toBe(0);}finally{await db.pool.query('ALTER TABLE source_goal_runs DROP CONSTRAINT reject_manual_stage');}await real.saveSample(identity,goalId,input);expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);expect((await db.pool.query('SELECT status FROM source_goals WHERE id=$1',[goalId])).rows[0].status).toBe('paused');
});

it('collect grants only the submit action and renders the same permission in Work Skill',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const read=await real.read(identity,goalId);const s=await submitted(read.native_runs[0].id);const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const transport=new CliAgentToolTransport(config);expect((await transport.list(s.run)).map(t=>t.name)).toEqual(['source.material.submit']);expect(await transport.call(s.run,{id:'not-granted',name:'source.goal.write_version',arguments:{}})).toMatchObject({ok:false,error_code:'system_action_not_granted'});const {workSkillOptionsForRun}=await import('../src/modules/runs/runWorkSurface.js');const {renderWorkSkill}=await import('../src/modules/skills/workSkill.js');expect(workSkillOptionsForRun(s.run).domainActions).toEqual(['source.material.submit']);expect(renderWorkSkill(workSkillOptionsForRun(s.run))).toContain('NOT independently verified');
});
it('corrects invalid schema in the same Run, bounds attempts and persists no summary under reference policy',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const d=await real.read(identity,goalId);const s=await submitted(d.native_runs[0].id);const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const t=new CliAgentToolTransport(config);expect(await t.call(s.run,{id:'bad',name:'source.material.submit',arguments:{...s.input,items:[{...s.input.items[0],url:'javascript:alert(1)'}]}})).toMatchObject({ok:false,error_code:'source_material_submission_invalid',error:expect.stringContaining('items.0.url')});const withSummary=s.input;expect(await t.call(s.run,{id:'fixed',name:'source.material.submit',arguments:withSummary})).toMatchObject({ok:true,result:{recorded:true}});expect(await t.call(s.run,{id:'same-response-lost',name:'source.material.submit',arguments:withSummary})).toMatchObject({ok:true,result:{duplicate:true}});const audit=(await db.pool.query("SELECT result_json FROM source_goal_runs WHERE result_json->>'native_run_id'=$1",[s.run.id])).rows[0].result_json;expect(audit.submission_attempts).toBe(2);expect(JSON.stringify(audit)).not.toContain('PRIVATE SOURCE SUMMARY');expect(audit.result_provenance).toBe('agent_provided_unverified');await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[s.run.id]);const result=await real.read(identity,goalId);expect(result.previews[0].status).toBe('ready');expect(result.previews[0].result_json.contributions[0].coverage).toMatchObject({verification:'agent_provided_unverified',exhaustive:false});expect((await db.pool.query("SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='collect'")).rows[0].n).toBe(1);
});
it('three malformed submissions exhaust only same-Run corrections without another paid Run',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const t=new CliAgentToolTransport(config);for(let i=0;i<3;i++)expect(await t.call(s.run,{id:'bad-'+i,name:'source.material.submit',arguments:{}})).toMatchObject({ok:false,error_code:'source_material_submission_invalid'});expect(await t.call(s.run,{id:'late-correction',name:'source.material.submit',arguments:s.input})).toMatchObject({ok:false,error:expect.stringContaining('source_material_submission_limit')});expect((await db.pool.query("SELECT (result_json->>'submission_attempts')::int n FROM source_goal_runs WHERE result_json->>'native_run_id'=$1",[s.run.id])).rows[0].n).toBe(3);expect((await db.pool.query("SELECT count(*)::int n FROM jobs WHERE payload_json->>'run_id'=$1",[s.run.id])).rows[0].n).toBe(1);
});
it.for(['cancelled','deadline','profile','source','version','grant'] as const)('submission reauthorizes %s before durable acceptance',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);if(mode==='cancelled')await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1",[s.run.id]);if(mode==='deadline')await db.pool.query("UPDATE runs SET started_at=now()-interval '601 seconds' WHERE id=$1",[s.run.id]);if(mode==='profile')await db.pool.query("UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1",[profile]);if(mode==='source')await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=(SELECT result_json->'spec'->>'source_connection_id' FROM source_goal_runs WHERE result_json->>'native_run_id'=$1)",[s.run.id]);if(mode==='version')await db.pool.query('UPDATE source_goals SET current_version_id=NULL WHERE id=$1',[goalId]);if(mode==='grant')await db.pool.query("UPDATE runs SET permission_snapshot_json='{}' WHERE id=$1",[s.run.id]);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');await expect(submitMaterialResults(config,s.run,s.input)).rejects.toThrow();expect((await db.pool.query("SELECT result_json ? 'search_submission' has FROM source_goal_runs WHERE result_json->>'native_run_id'=$1",[s.run.id])).rows[0].has).toBe(false);
});
it('reported search failure and actual zero results remain distinct',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id,[],{status:'failed',failure:{code:'unavailable',message:'No search tool in selected configuration'}});const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');await submitMaterialResults(config,s.run,s.input);await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[s.run.id]);const d=await real.read(identity,goalId);expect(d.previews[0].result_json.contributions[0]).toMatchObject({status:'failed',error:'source_material_unavailable'});expect(d.previews[0].status).toBe('partial');
});
it('server caps and deduplicates submitted links, reports coverage, and saves the validated sample atomically',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await db.pool.query("UPDATE source_goals SET budget_json=jsonb_set(budget_json,'{items_per_source}','5') WHERE id=$1",[goalId]);const p=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const d=await real.read(identity,goalId);const items=Array.from({length:15},(_,i)=>({url:'https://evidence.test/'+i,title:'Robotics '+i}));await finishNative(d.native_runs[0].id,true,[...items,items[0]]);const ready=await real.read(identity,goalId);const c=ready.previews[0].result_json.contributions[0];expect(c.output.items.map((i:{source_uri:string})=>i.source_uri)).toEqual(items.slice(0,5).map(i=>i.url));expect(c.coverage).toMatchObject({observed_items:16,unique_items:15,returned_items:5,truncated:true,exhaustive:false});await real.saveSample(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'manual'});expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(5);expect((await db.pool.query("SELECT count(*)::int n FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1 AND status='active'",[goalId])).rows[0].n).toBe(0);
});
it('accepted corrected fields survive only validation degradation, not permission refusals',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const d=await real.read(identity,goalId);await finishNative(d.native_runs[0].id);const id=d.native_runs[0].id;await new PgRunRepository(db.pool).appendRunEvent({run_id:id,space_id:identity.spaceId,event_type:'action_completed',status:'failed',error_code:'source_material_submission_invalid',metadata_json:{action_id:'source.material.submit'}});await db.pool.query("UPDATE runs SET status='degraded' WHERE id=$1",[id]);expect((await real.read(identity,goalId)).previews[0].status).toBe('ready');
});
it.for(['opencode','codex_cli','claude_code'])('Agent submission remains runtime-neutral and preserves explicit %s routing',async(runtime,ctx)=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await db.pool.query("UPDATE agent_runtime_profiles SET runtime_key=$2 WHERE id=$1",[profile,runtime]);await db.pool.query("UPDATE hosts SET capabilities_json=$2 WHERE id=(SELECT execution_host_id FROM agent_runtime_profiles WHERE id=$1)",[profile,{runtimes:[runtime],versions:{[runtime]:'fixture'},installations:{[runtime]:[{id:'own',version:'fixture',logged_in:true,options:{session_available:true,config_options:[]},health_check_protocol:'acp'}]}}]);const v=await real.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:{summary:'New selected runtime plan',sources:[{reason:'Selected runtime',implementation:{kind:'agent_search',query:'robotics research'},supports_history:false}],limitations:[]}},runId);await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);expect(s.run.requested_runtime_profile_id).toBe(profile);expect(s.run.runtime_key).toBe(runtime);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');expect(await submitMaterialResults(config,s.run,s.input)).toMatchObject({recorded:true,verification:'agent_provided_unverified'});
});
it('rejects a degraded collection with an unrelated permission refusal even after submission',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const id=(await real.read(identity,goalId)).native_runs[0].id;await finishNative(id);await new PgRunRepository(db.pool).appendRunEvent({run_id:id,space_id:identity.spaceId,event_type:'action_completed',status:'failed',error_code:'system_action_not_granted',metadata_json:{action_id:'task.create'}});await db.pool.query("UPDATE runs SET status='degraded' WHERE id=$1",[id]);expect((await real.read(identity,goalId)).previews[0].status).toBe('partial');
});
it('a manually saved result has one progress Run, can explicitly preview again and never activates a schedule',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();const first=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));await finishNative((await real.read(identity,goalId)).native_runs[0].id);await real.read(identity,goalId);await real.saveSample(identity,goalId,{version_id:v.id,preview_id:first.id,idempotency_key:'first-manual'});expect((await real.read(identity,goalId)).native_runs).toHaveLength(1);const second=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const pending=(await real.read(identity,goalId)).native_runs.find(r=>r.status==='queued')!;await finishNative(pending.id,true,[{url:'https://evidence.test/new',title:'Robotics new'}]);await real.read(identity,goalId);await real.saveSample(identity,goalId,{version_id:v.id,preview_id:second.id,idempotency_key:'second-manual'});expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(2);expect((await real.read(identity,goalId)).native_runs).toHaveLength(2);expect((await db.pool.query("SELECT count(*)::int n FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1 AND status='active'",[goalId])).rows[0].n).toBe(0);
});
it.for(['ids','already_recorded'] as const)('M1: accepted submission settles after same-Run %s corrections without new spend',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const id=(await real.read(identity,goalId)).native_runs[0].id;const s=await submitted(id);const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const t=new CliAgentToolTransport(config);
 if(mode==='ids'){const wrong=await t.call(s.run,{id:'wrong-context',name:'source.material.submit',arguments:{...s.input,processing_id:'typo-processing'}});expect(wrong).toMatchObject({ok:false,error_code:'source_material_submission_invalid',error:expect.stringContaining('processing_id')});}
 expect(await t.call(s.run,{id:'accepted',name:'source.material.submit',arguments:s.input})).toMatchObject({ok:true});
 if(mode==='already_recorded'){expect(await t.call(s.run,{id:'different-later',name:'source.material.submit',arguments:{...s.input,items:[]}})).toMatchObject({ok:false,error_code:'source_material_submission_already_recorded'});await new PgRunRepository(db.pool).appendRunEvent({run_id:id,space_id:identity.spaceId,event_type:'action_completed',status:'failed',error_code:'source_material_submission_limit',metadata_json:{action_id:'source.material.submit'}});}
 await db.pool.query("UPDATE runs SET status='degraded' WHERE id=$1",[id]);const final=await real.read(identity,goalId);expect(final.previews[0].status,JSON.stringify({result:final.previews[0].result_json,events:(await db.pool.query("SELECT error_code,metadata_json FROM run_events WHERE run_id=$1 AND status='failed'",[id])).rows})).toBe('ready');expect((await db.pool.query("SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='collect'")).rows[0].n).toBe(1);
});
it('L3: metadata-only summary is rejected before persistence and is correctable to null',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await db.pool.query("UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','\"metadata_only\"') WHERE provider_connector_id='00000000-0000-4000-8000-00000000d009'");await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const t=new CliAgentToolTransport(config);const bad=await t.call(s.run,{id:'summary',name:'source.material.submit',arguments:{...s.input,items:[{...s.input.items[0],summary:'PAGE BODY SHOULD NEVER BE SUBMITTED'}]}});expect(bad).toMatchObject({ok:false,error_code:'source_material_submission_invalid',error:expect.stringContaining('summary')});expect(await t.call(s.run,{id:'fixed',name:'source.material.submit',arguments:s.input})).toMatchObject({ok:true});expect(JSON.stringify((await db.pool.query('SELECT result_json FROM source_goal_runs WHERE goal_id=$1',[goalId])).rows)).not.toContain('PAGE BODY SHOULD NEVER BE SUBMITTED');
});
it('M2: real materialization carries metadata-only provenance into Reading and Reader without body',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await db.pool.query("UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','\"metadata_only\"') WHERE provider_connector_id='00000000-0000-4000-8000-00000000d009'");const p=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));await finishNative((await real.read(identity,goalId)).native_runs[0].id);await real.read(identity,goalId);await real.saveSample(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'provenance'});const item=(await db.pool.query('SELECT id,excerpt,metadata_json FROM source_items')).rows[0];expect(item).toMatchObject({excerpt:null,metadata_json:{result_provenance:'agent_provided_unverified'}});const {PgReaderRepository}=await import('../src/modules/reader/repository.js');const doc=await new PgReaderRepository(db.pool,config).getDocument(identity,'source_item',item.id);expect(doc).toMatchObject({result_provenance:'agent_provided_unverified',plain_text:'',retention_policy:'metadata_only'});const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const page=await new ReadingService(db.pool).list(identity,{view:'all',limit:30});expect(page.items.find(i=>i.source_item_id===item.id)).toMatchObject({result_provenance:'agent_provided_unverified'});
});
it.for(['other_action','authority'] as const)('M1: accepted sample never masks actual %s refusal',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const t=new CliAgentToolTransport(config);expect(await t.call(s.run,{id:'accepted',name:'source.material.submit',arguments:s.input})).toMatchObject({ok:true});if(mode==='authority')await db.pool.query("UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1",[profile]);const denied=await t.call(s.run,{id:'real-denial',name:mode==='authority'?'source.material.submit':'task.create',arguments:mode==='authority'?s.input:{title:'Not granted'}});expect(denied).toMatchObject({ok:false});expect((await db.pool.query("SELECT count(*)::int n FROM run_events WHERE run_id=$1 AND status='failed' AND event_type='action_completed'",[s.run.id])).rows[0].n).toBeGreaterThan(0);await db.pool.query("UPDATE runs SET status='degraded' WHERE id=$1",[s.run.id]);expect((await real.read(identity,goalId)).previews[0].status).toBe('partial');
});
it.for(['personal','project'] as const)('followed %s intake reaches pending without recommendations and retains access and reading state',async(scope,ctx)=>{
 if(!db.available)return ctx.skip();let projectId:string|undefined;
 if(scope==='project'){
  projectId='goal-reading-project';await db.pool.query("UPDATE spaces SET type='team' WHERE id=$1",[identity.spaceId]);
  await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Robotics','active',now(),now())",[projectId,identity.spaceId,identity.userId]);
  await seedProjectMainlineRoom(db.pool,{space:identity.spaceId,project:projectId,owner:identity.userId});
  const g=await service.create(identity,{intent:'Follow robotics research',project_id:projectId,agent_id:'goal-agent',runtime_profile_id:profile});goalId=g.id;
  await db.pool.query('UPDATE runs SET project_id=$2,contract_snapshot_json=$3 WHERE id=$1',[runId,projectId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'explore'}}}]);
 }
 const {real,v}=await nativePlan();const preview=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));
 await finishNative((await real.read(identity,goalId)).native_runs[0].id);await real.read(identity,goalId);
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);
 expect((await reading.list(identity,{view:'pending',limit:30},projectId)).items).toHaveLength(0);
 await real.saveSample(identity,goalId,{version_id:v.id,preview_id:preview.id,idempotency_key:'reading-intake'});
 const pending=await reading.list(identity,{view:'pending',limit:30},projectId);expect(pending.items).toHaveLength(1);const saved=pending.items[0];
 expect(saved).toMatchObject({result_provenance:'agent_provided_unverified',summary:null,contributions:[]});
 expect((await db.pool.query('SELECT count(*)::int n FROM information_digest_items')).rows[0].n).toBe(0);
 expect((await db.pool.query('SELECT count(*)::int n FROM source_item_annotations')).rows[0].n).toBe(0);
 if(projectId){expect((await reading.list(identity,{view:'pending',limit:30})).items).toHaveLength(0);const {ReadingPreferences}=await import('../src/modules/informationDigest/readingPreferences.js');await new ReadingPreferences(db.pool).set(identity,projectId,true);expect((await reading.list(identity,{view:'pending',limit:30})).items.map(i=>i.key)).toEqual([saved.key]);expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId})).items.map(i=>i.key)).toEqual([saved.key]);expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId},projectId)).items[0].topics).toEqual([{goal_id:goalId,selection_status:'unjudged',selection_reason:null,judged_by:null,delivery_kind:'baseline',new_in_latest_collection:true,change_evidence_url:null,title:'Follow robotics research',project_id:projectId??null}]);await expect(reading.list({...identity,userId:'outsider'},{view:'pending',limit:30,topic:goalId})).rejects.toMatchObject({statusCode:404});}
 await reading.state(identity,saved.source_item_id,{dismissed:true},projectId);expect((await reading.list(identity,{view:'pending',limit:30},projectId)).items).toHaveLength(0);
 await reading.state(identity,saved.source_item_id,{dismissed:false,read_status:'read'},projectId);expect((await reading.list(identity,{view:'pending',limit:30},projectId)).items).toHaveLength(0);expect((await reading.list(identity,{view:'read',limit:30},projectId)).items.map(i=>i.key)).toEqual([saved.key]);
 await reading.state(identity,saved.source_item_id,{read_status:'unread'},projectId);
 const stored=(await db.pool.query('SELECT metadata_json,connection_id FROM source_items WHERE id=$1',[saved.source_item_id])).rows[0];
 // Eligibility is the server-recorded goal membership, never item metadata.
 await db.pool.query("UPDATE source_items SET metadata_json=jsonb_set(metadata_json,'{goal_run_id}','\"forged-audit\"') WHERE id=$1",[saved.source_item_id]);expect((await reading.list(identity,{view:'pending',limit:30},projectId)).items).toHaveLength(1);
 const membership=(await db.pool.query('SELECT * FROM source_goal_items WHERE source_item_id=$1',[saved.source_item_id])).rows;expect(membership).toHaveLength(1);expect(membership[0]).toMatchObject({goal_id:goalId,version_id:v.id,delivery_kind:'baseline',...(projectId?{selection_status:'unjudged',selection_source:'collection',judged_by:null}:{selection_status:'important',selection_source:'topic_judgment',judged_by:'topic_rules'})});
 await db.pool.query('DELETE FROM source_goal_items WHERE source_item_id=$1',[saved.source_item_id]);await db.pool.query('UPDATE source_items SET metadata_json=$2 WHERE id=$1',[saved.source_item_id,stored.metadata_json]);expect((await reading.list(identity,{view:'pending',limit:30},projectId)).items).toHaveLength(0);
 await db.pool.query(`INSERT INTO source_goal_items SELECT * FROM jsonb_populate_record(NULL::source_goal_items,$1::jsonb)`,[membership[0]]);expect((await reading.list(identity,{view:'pending',limit:30},projectId)).items).toHaveLength(1);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[stored.connection_id]);expect((await reading.list(identity,{view:'pending',limit:30},projectId)).items).toHaveLength(0);
});
it.for(['article','repository'] as const)('Agent %s content survives real submission, manual recovery and Reader without body truncation',async(kind,ctx)=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();const preview=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);
 const text='Robotics material read from the linked documentation. '.repeat(90)+'\n\n<script>literal, not HTML</script>';
 const content={kind,format:kind==='repository'?'agent_summary':'source_text',syntax:'plain' as const,text,sources:['https://search.test/README']};
 const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const t=new CliAgentToolTransport(config);
 const result=await t.call(s.run,{id:'readable',name:'source.material.submit',arguments:{...s.input,items:[{...s.input.items[0],summary:'Robotics capabilities relevant to the goal',content}]}});expect(result).toMatchObject({ok:true});
 await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[s.run.id]);expect((await real.read(identity,goalId)).previews[0].status).toBe('ready');
 await real.saveSample(identity,goalId,{version_id:v.id,preview_id:preview.id,idempotency_key:'readable-content'});
 const item=(await db.pool.query('SELECT * FROM source_items')).rows[0];expect(item).toMatchObject({content_state:'content_saved',retention_policy:'full_text',excerpt:'Robotics capabilities relevant to the goal'});expect(item.metadata_json).not.toHaveProperty('reading_info');
 const {PgReaderRepository}=await import('../src/modules/reader/repository.js');const doc=await new PgReaderRepository(db.pool,config).getDocument(identity,'source_item',item.id);expect(doc).toMatchObject({plain_text:text,result_provenance:'agent_provided_unverified',reading_info:{kind,format:content.format,sources:content.sources}});expect(JSON.stringify(doc?.content_json)).toContain('<script>literal, not HTML</script>');
 const snapshots=await db.pool.query('SELECT * FROM source_snapshots WHERE source_item_id=$1',[item.id]);expect(snapshots.rows).toHaveLength(1);expect(snapshots.rows[0].snapshot_type).toBe('extracted');
 await real.read(identity,goalId);expect((await db.pool.query('SELECT count(*)::int n FROM source_snapshots')).rows[0].n).toBe(1);
});
it('Source metadata-only policy denies Agent bodies before persistence without widening existing consent',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await db.pool.query("UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','\"metadata_only\"') WHERE provider_connector_id='00000000-0000-4000-8000-00000000d009'");await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');
 await expect(submitMaterialResults(config,s.run,{...s.input,items:[{...s.input.items[0],content:{kind:'article',format:'source_text',syntax:'plain',text:'UNRETAINED_BODY',sources:['https://example.test']}}]})).rejects.toThrow('Source policy');
 expect(JSON.stringify((await db.pool.query('SELECT result_json FROM source_goal_runs')).rows)).not.toContain('UNRETAINED_BODY');expect(await submitMaterialResults(config,s.run,s.input)).toMatchObject({recorded:true});
});
it('completed Agent body transport copies are scrubbed while saved Reader content remains available',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();const preview=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');await submitMaterialResults(config,s.run,{...s.input,items:[{...s.input.items[0],summary:'Robotics overview',content:{kind:'repository',format:'agent_summary',syntax:'plain',text:'README_READING_CONTENT robotics',sources:['https://example.test/README']}}]});await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[s.run.id]);await real.read(identity,goalId);await real.saveSample(identity,goalId,{version_id:v.id,preview_id:preview.id,idempotency_key:'scrub-body'});
 const {cleanGoalSamples}=await import('../src/modules/sources/goals/samples.js');await cleanGoalSamples(db.pool,config,goalId);const audits=await db.pool.query('SELECT result_json FROM source_goal_runs WHERE goal_id=$1',[goalId]);for(const audit of audits.rows){expect(audit.result_json).not.toHaveProperty('search_submission');expect(audit.result_json).not.toHaveProperty('accepted_output');}
 const item=(await db.pool.query('SELECT id FROM source_items')).rows[0];const {PgReaderRepository}=await import('../src/modules/reader/repository.js');expect(await new PgReaderRepository(db.pool,config).getDocument(identity,'source_item',item.id)).toMatchObject({plain_text:'README_READING_CONTENT robotics'});
});
it('later Agent reading enriches an existing link without duplicating it or replacing a saved body',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();const first=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));await finishNative((await real.read(identity,goalId)).native_runs[0].id);await real.read(identity,goalId);await real.saveSample(identity,goalId,{version_id:v.id,preview_id:first.id,idempotency_key:'link-only'});const original=(await db.pool.query('SELECT id FROM source_items')).rows[0];
 for(const [n,text] of ['First readable robotics document','Different later text that must not replace the saved body'].entries()){
  const preview=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const pending=(await real.read(identity,goalId)).native_runs.find(r=>r.status==='queued')!;const s=await submitted(pending.id);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');await submitMaterialResults(config,s.run,{...s.input,items:[{...s.input.items[0],content:{kind:'article',format:'source_text',syntax:'plain',text,sources:[s.input.items[0].url]}}]});await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[s.run.id]);await real.read(identity,goalId);await real.saveSample(identity,goalId,{version_id:v.id,preview_id:preview.id,idempotency_key:'enrich-'+n});
 }
 expect((await db.pool.query('SELECT id FROM source_items')).rows).toEqual([original]);expect((await db.pool.query('SELECT count(*)::int n FROM source_snapshots')).rows[0].n).toBe(1);const {PgReaderRepository}=await import('../src/modules/reader/repository.js');expect(await new PgReaderRepository(db.pool,config).getDocument(identity,'source_item',original.id)).toMatchObject({plain_text:'First readable robotics document'});
});
async function savedMaterialForProcessing(){
 const {real,v}=await nativePlan();const preview=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));await finishNative((await real.read(identity,goalId)).native_runs[0].id);await real.read(identity,goalId);await real.saveSample(identity,goalId,{version_id:v.id,preview_id:preview.id,idempotency_key:'old-saved-material'});return (await db.pool.query('SELECT * FROM source_items')).rows[0];
}
async function runningMaterial(runId:string){
 await db.pool.query("UPDATE runs r SET status='running',started_at=now(),runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id",[runId]);const run=(await new PgRunRepository(db.pool).getRun(identity.spaceId,runId))!;if(run.execution_kind!=='agent')throw new Error('Expected Agent fixture Run');return run;
}
it('existing links use the same granted material submission and writer without another search or item',async ctx=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();const {MaterialItemProcessingService}=await import('../src/modules/sources/materialProcessing/items.js');const service=new MaterialItemProcessingService(db.pool,config);const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);await reading.state(identity,item.id,{read_status:'read'});const queued=await service.start(identity,item.id);expect(queued).toMatchObject({status:'queued'});expect(await service.start(identity,item.id)).toMatchObject({processing_id:queued.processing_id});
 const run=await runningMaterial(queued.run_id!);expect(run.requested_runtime_profile_id).toBe(profile);const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');const t=new CliAgentToolTransport(config);expect((await t.list(run)).map(a=>a.name)).toEqual(['source.material.submit']);
 expect(await t.call(run,{id:'bad',name:'source.material.submit',arguments:{processing_id:'wrong'}})).toMatchObject({ok:false,error_code:'source_material_submission_invalid'});
 const input={processing_id:queued.processing_id,status:'succeeded',items:[{url:item.source_uri,title:item.title,summary:'Robotics repository overview',observed_at:new Date().toISOString(),content:{kind:'repository',format:'agent_summary',syntax:'plain',text:'A readable robotics README summary',sources:[item.source_uri]}}],failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}};
 // The syntax of the text must be declared: an undeclared one is refused on that field, for correction in this Run.
 const undeclared={...input,items:[{...input.items[0],content:{...input.items[0].content,syntax:undefined}}]};
 expect(await t.call(run,{id:'undeclared',name:'source.material.submit',arguments:JSON.parse(JSON.stringify(undeclared))})).toMatchObject({ok:false,error_code:'source_material_submission_invalid',error:expect.stringContaining('items.0.content.syntax')});
 expect(await t.call(run,{id:'correct',name:'source.material.submit',arguments:input})).toMatchObject({ok:true});expect(await t.call(run,{id:'repeat',name:'source.material.submit',arguments:input})).toMatchObject({ok:true,result:{duplicate:true}});await db.pool.query("UPDATE runs SET status='degraded' WHERE id=$1",[run.id]);expect(await service.read(identity,item.id)).toMatchObject({status:'succeeded'});
 const {PgReaderRepository}=await import('../src/modules/reader/repository.js');expect(await new PgReaderRepository(db.pool,config).getDocument(identity,'source_item',item.id)).toMatchObject({plain_text:'A readable robotics README summary',reading_info:{kind:'repository',format:'agent_summary'}});expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);expect((await db.pool.query('SELECT metadata_json FROM extraction_jobs WHERE id=$1',[queued.processing_id])).rows[0].metadata_json).not.toHaveProperty('material_submission');expect((await reading.list(identity,{view:'read',limit:30})).items.map(i=>i.source_item_id)).toEqual([item.id]);
});
it('legacy link retention uses one Source-owner proposal and never auto-widens permission',async ctx=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();await db.pool.query("UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','\"metadata_only\"') WHERE id=$1",[item.connection_id]);const {MaterialItemProcessingService}=await import('../src/modules/sources/materialProcessing/items.js');const service=new MaterialItemProcessingService(db.pool,config);const before=(await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n;expect(await service.start(identity,item.id)).toMatchObject({status:'needs_consent',source_id:item.connection_id});expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(before);
 const {proposeMaterialStorage}=await import('../src/modules/sources/materialProcessing/consent.js');const proposal=await proposeMaterialStorage(db.pool,identity,item.id);expect(proposal.proposal_id).toBeTruthy();expect(await service.start(identity,item.id)).toMatchObject({status:'needs_consent'});const {PgProposalApplyService}=await import('../src/modules/proposals/applyService.js');await PgProposalApplyService.fromConfig(config).accept(String(proposal.proposal_id),identity);expect(await service.start(identity,item.id)).toMatchObject({status:'queued'});
});
it.for(['source','item','cancelled'] as const)('existing material refuses %s drift without saving submitted text',async(mode,ctx)=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();const {MaterialItemProcessingService}=await import('../src/modules/sources/materialProcessing/items.js');const service=new MaterialItemProcessingService(db.pool,config);const queued=await service.start(identity,item.id);const run=await runningMaterial(queued.run_id!);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');await submitMaterialResults(config,run,{processing_id:queued.processing_id,status:'succeeded',items:[{url:item.source_uri,title:item.title,summary:null,observed_at:new Date().toISOString(),content:{kind:'article',format:'source_text',syntax:'plain',text:'Must not be saved after drift',sources:[item.source_uri]}}],failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}});
 if(mode==='source')await db.pool.query("UPDATE source_connections SET policy_json=jsonb_set(policy_json,'{retention_policy}','\"metadata_only\"') WHERE id=$1",[item.connection_id]);if(mode==='item')await db.pool.query("UPDATE source_items SET content_hash='newer-body-version' WHERE id=$1",[item.id]);await db.pool.query('UPDATE runs SET status=$2 WHERE id=$1',[run.id,mode==='cancelled'?'cancelled':'succeeded']);await service.reconcile(run.id);expect(await service.read(identity,item.id)).toMatchObject({status:mode==='cancelled'?'cancelled':'failed'});expect((await db.pool.query('SELECT count(*)::int n FROM source_snapshots WHERE source_item_id=$1',[item.id])).rows[0].n).toBe(0);
});
it('unbound old links choose the existing default OpenCode Agent without borrowing the managed Room Assistant',async ctx=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();await db.pool.query("UPDATE source_items SET metadata_json=metadata_json-'goal_id' WHERE id=$1",[item.id]);await db.pool.query("UPDATE agent_runtime_profiles SET runtime_key='opencode' WHERE id=$1",[profile]);await db.pool.query("UPDATE hosts SET capabilities_json=$2 WHERE id=(SELECT execution_host_id FROM agent_runtime_profiles WHERE id=$1)",[profile,{runtimes:['opencode'],versions:{opencode:'fixture'},installations:{opencode:[{id:'own',version:'fixture',logged_in:true,options:{session_available:true,config_options:[]},health_check_protocol:'acp'}]}}]);const {MaterialItemProcessingService}=await import('../src/modules/sources/materialProcessing/items.js');const service=new MaterialItemProcessingService(db.pool,config);const queued=await service.start(identity,item.id);const run=(await new PgRunRepository(db.pool).getRun(identity.spaceId,queued.run_id!))!;expect(run.requested_runtime_profile_id).toBe(profile);expect(run.agent_id).toBe('goal-agent');expect((await db.pool.query('SELECT runtime_key FROM agent_runtime_profiles WHERE id=$1',[run.requested_runtime_profile_id])).rows[0].runtime_key).toBe('opencode');await expect(service.start(identity,item.id,{agent_id:'different-agent',runtime_profile_id:profile})).rejects.toThrow('different material execution');
});
it('shared document writer saves a canonical Reader artifact and body',async ctx=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();const {agentReadingDocument,saveSourceReadingDocument}=await import('../src/modules/sources/materialProcessing/documents.js');const doc=agentReadingDocument({kind:'article',format:'source_text',text:'Robotics article body',sources:[item.source_uri]},item.source_uri);await saveSourceReadingDocument(db.pool,{spaceId:identity.spaceId,itemId:item.id,document:doc,agentProvided:true});expect((await db.pool.query('SELECT content_state FROM source_items WHERE id=$1',[item.id])).rows[0].content_state).toBe('content_saved');
});
it('material processing accepts a truthful failed read without requiring fabricated content',async ctx=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();const {MaterialItemProcessingService}=await import('../src/modules/sources/materialProcessing/items.js');const service=new MaterialItemProcessingService(db.pool,config);const queued=await service.start(identity,item.id);const run=await runningMaterial(queued.run_id!);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');expect(await submitMaterialResults(config,run,{processing_id:queued.processing_id,status:'failed',items:[],failure:{code:'permission_denied',message:'The resource denied access'},coverage:{truncated:false,exhaustive:false,limitations:[]}})).toMatchObject({recorded:true});await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);expect(await service.read(identity,item.id)).toMatchObject({status:'failed',error:'source_material_permission_denied'});expect((await db.pool.query('SELECT count(*)::int n FROM source_snapshots WHERE source_item_id=$1',[item.id])).rows[0].n).toBe(0);
});
it('a stale Source storage decision cannot overwrite newer owner policy',async ctx=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();await db.pool.query("UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','\"metadata_only\"') WHERE id=$1",[item.connection_id]);const {proposeMaterialStorage}=await import('../src/modules/sources/materialProcessing/consent.js');const proposal=await proposeMaterialStorage(db.pool,identity,item.id);await db.pool.query("UPDATE source_connections SET policy_json=policy_json||'{\"policy_revision\":2}'::jsonb WHERE id=$1",[item.connection_id]);const {PgProposalApplyService}=await import('../src/modules/proposals/applyService.js');await expect(PgProposalApplyService.fromConfig(config).accept(String(proposal.proposal_id),identity)).rejects.toThrow('policy changed');expect((await db.pool.query('SELECT policy_json FROM source_connections WHERE id=$1',[item.connection_id])).rows[0].policy_json.retention_policy).toBe('metadata_only');
});
it('cancelling a queued material operation preserves the original item and prevents late submission',async ctx=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();const {MaterialItemProcessingService}=await import('../src/modules/sources/materialProcessing/items.js');const service=new MaterialItemProcessingService(db.pool,config);const queued=await service.start(identity,item.id);expect(await service.cancel(identity,item.id)).toMatchObject({status:'cancelled'});const run=(await new PgRunRepository(db.pool).getRun(identity.spaceId,queued.run_id!))!;const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');await expect(submitMaterialResults(config,run,{})).rejects.toThrow();expect((await db.pool.query('SELECT content_state FROM source_items WHERE id=$1',[item.id])).rows[0].content_state).toBe('metadata_only');
});
it.for(['html','pdf_text','pdf_snapshot'] as const)('ordinary %s extraction uses the shared real document writer',async(kind,ctx)=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();const {simplePdfBytes}=await import('./fixtures/simplePdf.js');const upstream=await startMockUpstream((_request,response)=>{response.writeHead(200,{'content-type':kind==='html'?'text/html':kind==='pdf_text'?'text/plain':'application/pdf'});response.end(kind==='html'?'<html><body><article><h1>Robotics extracted article</h1><p>Article text.</p><img src="/image.png"></article></body></html>':simplePdfBytes('Robotics PDF body'));});
 try{const url=upstream.baseUrl+'/article';await db.pool.query('UPDATE source_items SET source_uri=$2,canonical_uri=$2 WHERE id=$1',[item.id,url]);if(kind==='pdf_snapshot')await db.pool.query("UPDATE source_connections SET capture_policy='archive_original',policy_json=jsonb_set(policy_json,'{retention_policy}','\"full_snapshot\"') WHERE id=$1",[item.connection_id]);const jobId=randomUUID();await db.pool.query("INSERT INTO extraction_jobs(id,space_id,connection_id,source_item_id,job_type,status,metadata_json,created_at) VALUES($1,$2,$3,$4,$5,'pending','{}'::jsonb,now())",[jobId,identity.spaceId,item.connection_id,item.id,kind==='pdf_snapshot'?'snapshot':'extract_text']);const {SourceExtractionWorker}=await import('../src/modules/sources/extractionWorker.js');const result=await new SourceExtractionWorker(db.pool,config,fixtureServerGuard).runPendingJob(jobId,identity.spaceId);expect(result.status).toBe('succeeded');const {PgReaderRepository}=await import('../src/modules/reader/repository.js');const doc=await new PgReaderRepository(db.pool,config).getDocument(identity,'source_item',item.id);expect(doc?.plain_text).toContain(kind==='html'?'Article text.':'Robotics PDF body');const artifacts=(await db.pool.query("SELECT content,storage_path,mime_type FROM artifacts WHERE id=(SELECT extracted_artifact_id FROM source_items WHERE id=$1)",[item.id])).rows;expect(artifacts).toHaveLength(1);expect(JSON.parse(artifacts[0].content).extraction_method).toBe(kind==='html'?'structured_html_v1':'pdf_text_v1');if(kind!=='html')expect((await db.pool.query("SELECT count(*)::int n FROM source_snapshots WHERE source_item_id=$1 AND snapshot_type='raw'",[item.id])).rows[0].n).toBe(1);
 }finally{await upstream.close();}
});

it('accepts saved material after three minutes under its admitted ten-minute Run budget',async ctx=>{
 if(!db.available)return ctx.skip();const item=await savedMaterialForProcessing();const {MaterialItemProcessingService}=await import('../src/modules/sources/materialProcessing/items.js');const service=new MaterialItemProcessingService(db.pool,config);const queued=await service.start(identity,item.id);const run=await runningMaterial(queued.run_id!);expect(run.contract_snapshot_json).toMatchObject({max_duration_seconds:600});await db.pool.query("UPDATE runs SET started_at=now()-interval '301 seconds' WHERE id=$1",[run.id]);expect(await service.read(identity,item.id)).toMatchObject({status:'running'});const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');expect(await submitMaterialResults(config,run,{processing_id:queued.processing_id,status:'succeeded',items:[{url:item.source_uri,title:item.title,summary:null,observed_at:new Date().toISOString(),content:{kind:'article',format:'source_text',syntax:'plain',text:'Robotics readable after five minutes',sources:[item.source_uri]}}],failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}})).toMatchObject({recorded:true});await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);expect(await service.read(identity,item.id)).toMatchObject({status:'succeeded'});
});
it('keeps an in-progress search alive after three minutes and accepts its submission',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);expect(s.run.contract_snapshot_json).toMatchObject({max_duration_seconds:600});await db.pool.query("UPDATE runs SET started_at=now()-interval '301 seconds' WHERE id=$1",[s.run.id]);await real.read(identity,goalId);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[s.run.id])).rows[0].status).toBe('running');const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');expect(await submitMaterialResults(config,s.run,s.input)).toMatchObject({recorded:true});
});
it('submission respects an explicitly tighter admitted Run budget',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const s=await submitted((await real.read(identity,goalId)).native_runs[0].id);await db.pool.query("UPDATE runs SET started_at=now()-interval '31 seconds',contract_snapshot_json=jsonb_set(contract_snapshot_json,'{max_duration_seconds}','30'::jsonb) WHERE id=$1",[s.run.id]);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');await expect(submitMaterialResults(config,s.run,s.input)).rejects.toThrow('source_material_submission_inactive');
});
// ── Topic following, phase 1: one confirmation, lifecycle and membership ──
const tick=()=>runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
const followState=async()=>(await service.read(identity,goalId)).goal.follow_state!;
async function secondGoalRun(goal:string){const run=randomUUID();await seedRun(db.pool,{id:run,space:identity.spaceId,owner:identity.userId,agent:'goal-agent',version:'goal-agent-version',existingAgent:true});await db.pool.query(`UPDATE runs SET instructed_by_user_id=$2,contract_snapshot_json=$3 WHERE id=$1`,[run,identity.userId,{workflow_input_json:{source_goal:{goal_id:goal,purpose:'explore'}}}]);return run;}
it('one follow confirmation activates the current plan without a manual preview and records server-held membership',async ctx=>{
 if(!db.available)return ctx.skip();const v=await version();
 const followed=await service.follow(identity,goalId,{idempotency_key:'topic-1',interval_seconds:43200,items_per_source:10});
 expect(followed).toMatchObject({activated:true,status:'running',follow:{version_id:null,activated_version_id:v.id,interval_seconds:43200,items_per_source:10,reused_preview_id:null}});
 expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_previews')).rows[0].n).toBe(0);
 const goal=(await db.pool.query('SELECT status,active_version_id,budget_json,follow_json FROM source_goals WHERE id=$1',[goalId])).rows[0];expect(goal).toMatchObject({status:'running',active_version_id:v.id,budget_json:{interval_seconds:43200,items_per_source:10}});
 const bindings=(await db.pool.query('SELECT status,fixture_json FROM source_goal_bindings ORDER BY source_connection_id')).rows;expect(bindings).toHaveLength(2);for(const b of bindings)expect(b).toMatchObject({status:'active',fixture_json:{authority_sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}});
 const task=(await db.pool.query(`SELECT status,next_run_at FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1`,[goalId])).rows[0];expect(task.status).toBe('active');expect(Date.parse(task.next_run_at)).toBeLessThanOrEqual(Date.now()+1000);
 expect(await followState()).toMatchObject({intent:'following',phase:'first_collection',health:'ok',results:{items_total:0,last_outcome:'never'}});
 await tick();
 const members=(await db.pool.query('SELECT gi.*,i.connection_id FROM source_goal_items gi JOIN source_items i ON i.id=gi.source_item_id ORDER BY gi.source_connection_id')).rows;expect(members).toHaveLength(2);
 for(const m of members)expect(m).toMatchObject({goal_id:goalId,version_id:v.id,source_connection_id:m.connection_id,selection_status:'important',selection_source:'topic_judgment',judged_by:'topic_rules',delivery_kind:'baseline',agent_run_id:null});
 const audits=(await db.pool.query(`SELECT id FROM source_goal_runs WHERE goal_id=$1 AND status='succeeded'`,[goalId])).rows.map(r=>r.id);expect(members.map(m=>m.first_goal_run_id).sort()).toEqual(audits.sort());
 let state=await followState();expect(state).toMatchObject({phase:'scheduled',health:'ok',results:{items_total:2,unjudged_total:0,important_total:2,baseline_total:2,last_outcome:'new_items',last_new_items:2}});expect(state.results.next_check_at).toBeTruthy();expect(state.results.last_success_at).toBeTruthy();
 await db.pool.query(`UPDATE source_goal_bindings SET retry_at=NULL`);await tick();
 state=await followState();expect(state.results).toMatchObject({items_total:2,last_outcome:'no_new',last_new_items:0});
 expect((await db.pool.query('SELECT count(DISTINCT last_goal_run_id)::int n FROM source_goal_items')).rows[0].n).toBe(2);
});
it('follow is idempotent per key, rejects a changed replay and serializes concurrent confirmations into one activation',async ctx=>{
 if(!db.available)return ctx.skip();await version();
 const [a,b]=await Promise.all([service.follow(identity,goalId,{idempotency_key:'race-a'}),service.follow(identity,goalId,{idempotency_key:'race-b'})]);
 expect([a.activated,b.activated].filter(Boolean)).toHaveLength(1);
 expect((await db.pool.query('SELECT max(revision)::int r FROM source_goal_bindings')).rows[0].r).toBe(0);
 const key=(await db.pool.query(`SELECT follow_json->>'idempotency_key' k FROM source_goals WHERE id=$1`,[goalId])).rows[0].k;
 expect(await service.follow(identity,goalId,{idempotency_key:key})).toMatchObject({activated:false});
 await expect(service.follow(identity,goalId,{idempotency_key:key,interval_seconds:7200})).rejects.toMatchObject({statusCode:409,responseBody:{error:'source_goal_follow_key_changed'}});
 expect((await db.pool.query('SELECT max(revision)::int r FROM source_goal_bindings')).rows[0].r).toBe(0);
 await expect(service.follow({...identity,userId:'stranger'},goalId,{idempotency_key:'x'})).rejects.toMatchObject({statusCode:404});
});
it('a later plan stays a draft until confirmed; follow pins only the current plan and empty preview never blocks following',async ctx=>{
 if(!db.available)return ctx.skip();const v1=await version();
 data[specs[0].source_connection_id]=[];data[specs[1].source_connection_id]=[];const p=await service.preview(identity,goalId,v1.id,new AbortController().signal);expect(p.complete).toBe(false);
 await service.follow(identity,goalId,{idempotency_key:'empty-ok'});expect((await db.pool.query('SELECT status,active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0]).toEqual({status:'running',active_version_id:v1.id});
 const v2=await service.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:{...plan(),sources:specs.slice(0,1),summary:'Narrower draft'}},runId);
 expect((await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id).toBe(v1.id);expect((await followState()).pending_adjustment).toBe(true);
 await expect(service.follow(identity,goalId,{idempotency_key:'stale',version_id:v1.id})).rejects.toMatchObject({statusCode:409});
 await service.follow(identity,goalId,{idempotency_key:'adjust',version_id:v2.id});
 expect((await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id).toBe(v2.id);
 expect((await db.pool.query('SELECT source_connection_id,status FROM source_goal_bindings ORDER BY status')).rows.map(r=>r.status)).toEqual(['active','paused']);expect((await followState()).pending_adjustment).toBe(false);
 await service.stop(identity,goalId);await expect(service.follow(identity,goalId,{idempotency_key:'revive'})).rejects.toMatchObject({responseBody:{error:'source_goal_paused_resume_required'}});
});
it('a confirmation before any plan persists and activates the first plan the bound planning Run writes',async ctx=>{
 if(!db.available)return ctx.skip();
 const pending=await service.follow(identity,goalId,{idempotency_key:'before-plan',interval_seconds:7200});expect(pending).toMatchObject({activated:false,prepare:true});
 const stored=(await db.pool.query('SELECT status,active_version_id,follow_json FROM source_goals WHERE id=$1',[goalId])).rows[0];expect(stored.active_version_id).toBeNull();expect(stored.follow_json).toMatchObject({confirmed_by_user_id:identity.userId,interval_seconds:7200,activated_version_id:null});
 expect((await followState()).intent).toBe('following');expect(['preparing','blocked','waiting_for_permission']).toContain((await followState()).phase);
 const v=await version();
 expect((await db.pool.query('SELECT status,active_version_id,follow_json FROM source_goals WHERE id=$1',[goalId])).rows[0]).toMatchObject({status:'running',active_version_id:v.id,follow_json:{activated_version_id:v.id,last_error:null}});
 const v2=await service.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:{...plan(),summary:'Later draft'}},runId);
 expect((await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id).toBe(v.id);expect(v2.id).not.toBe(v.id);
});
it('a refused first-plan activation is recorded without failing the planning write',async ctx=>{
 if(!db.available)return ctx.skip();await service.follow(identity,goalId,{idempotency_key:'blocked'});
 // The plan asks for faster collection than the confirmed budget allows.
 const v=await service.writeVersion(identity,{goal_id:goalId,expected_revision:0,plan:{...plan(),interval_seconds:3600}},runId);expect(v.id).toBeTruthy();
 const g=(await db.pool.query('SELECT status,active_version_id,current_version_id,follow_json FROM source_goals WHERE id=$1',[goalId])).rows[0];
 expect(g).toMatchObject({active_version_id:null,current_version_id:v.id});expect(g.follow_json.last_error).toBe('source_goal_activation_refused');
 expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_bindings')).rows[0].n).toBe(0);expect((await followState()).phase).toBe('blocked');
});
it('partial source failure stays visible and a revoked source reports needed permission, never "no new items"',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'health'});
 fail=specs[0].source_connection_id;await tick();
 let state=await followState();expect(state.health).toBe('partial');expect(state.results.last_outcome).toBe('partial');expect(state.sources.map(s=>s.health).sort()).toEqual(['backoff','ok']);
 fail=null;await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`,[specs[1].source_connection_id]);await db.pool.query(`UPDATE source_goal_bindings SET retry_at=NULL,status='active'`);await tick();
 state=await followState();expect(state.health).toBe('needs_permission');expect(state.phase).toBe('waiting_for_permission');expect(state.results.last_outcome).not.toBe('no_new');
 expect(state.sources.find(s=>s.source_connection_id===specs[1].source_connection_id)).toMatchObject({health:'needs_permission',error:'source_authority_revoked',attention:'access',resolvable_by:'source_owner'});
});
it('following reuses a fresh Agent-search preview as the first batch without a second paid collection',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();const p=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const previewRun=(await real.read(identity,goalId)).native_runs[0].id;await finishNative(previewRun);await real.read(identity,goalId);
 const followed=await real.follow(identity,goalId,{idempotency_key:'reuse'});expect(followed.follow).toMatchObject({reused_preview_id:p.id,activated_version_id:v.id});
 expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);
 expect((await db.pool.query('SELECT agent_run_id,version_id FROM source_goal_items')).rows).toEqual([{agent_run_id:previewRun,version_id:v.id}]);
 const binding=(await db.pool.query('SELECT status,retry_at FROM source_goal_bindings')).rows[0];expect(binding.status).toBe('active');expect(Date.parse(binding.retry_at)).toBeGreaterThan(Date.now()+3600_000);
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));
 expect((await db.pool.query(`SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='collect'`)).rows[0].n).toBe(1);
 expect((await real.read(identity,goalId)).native_runs.map(r=>r.id)).toEqual([previewRun]);
 const state=(await real.read(identity,goalId)).goal.follow_state!;expect(state).toMatchObject({phase:'scheduled',results:{items_total:1,last_outcome:'new_items'}});
});
it('one material belongs to several topics; Reading filters by visible topic, selection and pages without leaking another owner',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'topic-a'});await tick();const first=goalId;
 // A different Source reporting the same canonical link: one SourceItem, two topics.
 const creator=new SourceRecipeCreateService(db.pool,config);const dry=new SourceRecipeDryRunService(db.pool,config);
 const made=await creator.createSource(identity,{name:'mirror',endpoint_url:'https://fixture.test/mirror',fetch_frequency:'manual',source_type:'rss',capture_policy:'reference_only',retention_policy:'metadata_only'});
 await dry.dryRunRecipeVersion(identity,made.connection.id,{recipe_version_id:made.recipe_version.id,fixture_content:`<rss><channel><item><title>Robotics mirror</title><guid>mirror</guid><link>https://fixture.test/feed</link><pubDate>Mon, 26 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`});await creator.activateRecipe(identity,made.connection.id,{recipe_version_id:made.recipe_version.id});
 const mirror={source_connection_id:made.connection.id,source_channel_id:made.connection.source_channel_id,reason:'mirror',supports_history:true,implementation:{kind:'connector' as const}};data[mirror.source_connection_id]=[{...item('mirror'),source_uri:'https://fixture.test/feed'}];
 const other=await service.create(identity,{intent:'Follow industry robotics',agent_id:'goal-agent',runtime_profile_id:profile,creation_key:'second'});const otherRun=await secondGoalRun(other.id);
 await service.writeVersion(identity,{goal_id:other.id,expected_revision:0,plan:{...plan(),sources:[mirror]}},otherRun);await service.follow(identity,other.id,{idempotency_key:'topic-b'});
 goalId=other.id;await tick();goalId=first;
 const shared=(await db.pool.query(`SELECT source_item_id,array_agg(goal_id ORDER BY goal_id) goals FROM source_goal_items GROUP BY source_item_id HAVING count(*)>1`)).rows;expect(shared).toHaveLength(1);expect(shared[0].goals.sort()).toEqual([first,other.id].sort());
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);
 const all=await reading.list(identity,{view:'pending',limit:30});expect(all.items).toHaveLength(2);
 const sharedItem=all.items.find(i=>i.source_item_ids.includes(shared[0].source_item_id))!;expect(sharedItem.topics.map(t=>t.goal_id).sort()).toEqual([first,other.id].sort());// Different topics judge the same material differently: A's include term matches, B has none.
 expect(sharedItem.topics.find(t=>t.goal_id===first)).toMatchObject({selection_status:'important',judged_by:'topic_rules'});expect(sharedItem.topics.find(t=>t.goal_id===other.id)).toMatchObject({selection_status:'unjudged',judged_by:null,selection_reason:null});
 expect((await reading.list(identity,{view:'pending',limit:30,topic:other.id})).items.map(i=>i.key)).toEqual([sharedItem.key]);
 expect((await reading.list(identity,{view:'pending',limit:30,topic:first})).total).toBe(2);
 expect((await reading.list(identity,{view:'pending',limit:30,topic:first,topic_selection:'important'})).total).toBe(2);
 await db.pool.query(`UPDATE source_goal_items SET selection_status='not_selected',selection_reason='Off topic',selection_source='topic_judgment' WHERE goal_id=$1 AND source_item_id<>$2`,[first,shared[0].source_item_id]);
 const important=await reading.list(identity,{view:'pending',limit:30,topic:first,topic_selection:'important'});expect(important.items.map(i=>i.key)).toEqual([sharedItem.key]);expect(important.items[0].topics.find(t=>t.goal_id===first)).toEqual({goal_id:first,project_id:null,title:'Follow robotics research and industry updates',selection_status:'important',selection_reason:'Title mentions the topic term "robotics"',judged_by:'topic_rules',delivery_kind:'baseline',new_in_latest_collection:true,change_evidence_url:null});
 const page=await reading.list(identity,{view:'pending',limit:1,topic:first});expect(page.items).toHaveLength(1);expect(page.next_cursor).toBeTruthy();expect(page.total).toBe(2);
 const next=await reading.list(identity,{view:'pending',limit:1,topic:first,cursor:page.next_cursor!});expect(next.items[0].key).not.toBe(page.items[0].key);
 await expect(reading.list(identity,{view:'pending',limit:1,topic:other.id,cursor:page.next_cursor!})).rejects.toMatchObject({statusCode:422});
 await expect(reading.list({...identity,userId:'another-owner'},{view:'pending',limit:30,topic:first})).rejects.toMatchObject({statusCode:404});
 await expect(reading.list(identity,{view:'pending',limit:30,topic:'missing-goal'})).rejects.toMatchObject({statusCode:404});
 await service.stop(identity,other.id,true);expect((await reading.list(identity,{view:'pending',limit:30})).items.find(i=>i.key===sharedItem.key)!.topics.map(t=>t.goal_id)).toEqual([first]);
 await expect(reading.list(identity,{view:'pending',limit:30,topic:other.id})).rejects.toMatchObject({statusCode:404});
});
// ── Phase-1 review fixes (Codex probes kept with their original assertions) ──
it('REVIEW: saved follow intent can recover the commit-before-enqueue crash window',async ctx=>{
 if(!db.available)return ctx.skip();await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[runId]);
 const host=randomUUID();await seedServerHost(db.pool,{id:host});await db.pool.query("UPDATE agent_runtime_profiles SET runtime_key='claude_code',execution_host_id=$2,workspace_mode='managed',runtime_installation='own' WHERE id=$1",[profile,host]);await db.pool.query("UPDATE hosts SET kind='remote',environment_kind='linux_native',owner_user_id=$2,capabilities_json=$3,last_heartbeat_at=now() WHERE id=$1",[host,identity.userId,{runtimes:['claude_code'],versions:{claude_code:'fixture'},installations:{claude_code:[{id:'own',version:'fixture',logged_in:true,options:{session_available:true,config_options:[]},health_check_protocol:'acp'}]}}]);
 const g=(await db.pool.query('SELECT budget_json FROM source_goals WHERE id=$1',[goalId])).rows[0];
 await db.pool.query('UPDATE source_goals SET follow_json=$2 WHERE id=$1',[goalId,{confirmed_at:new Date().toISOString(),confirmed_by_user_id:identity.userId,idempotency_key:'crash-window',version_id:null,interval_seconds:g.budget_json.interval_seconds,requests_per_run:g.budget_json.requests_per_run,items_per_source:g.budget_json.items_per_source,activated_version_id:null,reused_preview_id:null,last_error:null}]);
 await service.follow(identity,goalId,{idempotency_key:'crash-window'});
 const n=(await db.pool.query("SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$1 AND status='queued'",[goalId])).rows[0].n;
 // Positive control: the exact same ready execution route can queue preparation
 // when a new key reaches the preparation path; no model is dispatched.
 await service.follow(identity,goalId,{idempotency_key:'positive-control-new-key'});
 expect((await db.pool.query("SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$1 AND status='queued'",[goalId])).rows[0].n).toBe(1);
 expect(n).toBe(1);
});
it('REVIEW: deleted historical source does not hide an owned followed topic detail',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'read-deleted'});await tick();await db.pool.query("UPDATE source_connections SET deleted_at=now(),status='archived' WHERE id=$1",[specs[0].source_connection_id]);await expect(service.read(identity,goalId)).resolves.toHaveProperty('goal.id',goalId);
});
it('REVIEW: another channel on the same connection still records already collected material for its own topic',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'first-topic'});await tick();const first=goalId;
 const {SourceChannelService}=await import('../src/modules/sources/channels/sourceChannelService.js');const ch=await new SourceChannelService(db.pool,config).create(identity,{provider_key:'custom_source',source_connection_id:specs[0].source_connection_id,endpoint_url:'https://fixture.test/alternate',fetch_frequency:'manual',name:'Alternate topic channel'});
 const other=await service.create(identity,{intent:'Other robotics',agent_id:'goal-agent',runtime_profile_id:profile});const author=await secondGoalRun(other.id);await service.writeVersion(identity,{goal_id:other.id,expected_revision:0,plan:{summary:'Other topic',sources:[{...specs[0],source_channel_id:ch.id}],limitations:[]}},author);await service.follow(identity,other.id,{idempotency_key:'other'});goalId=other.id;await tick();goalId=first;
 expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_items WHERE goal_id=$1',[other.id])).rows[0].n).toBe(1);
});
it('REVIEW: Agent Profile revocation is a blocked setup state for the owner, not a Source permission',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'profile-health'});await db.pool.query("UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1",[profile]);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));const state=(await real.read(identity,goalId)).goal.follow_state;
 // A disabled Agent Profile is execution setup the topic owner fixes, not a Source permission; never "no updates".
 expect(state?.sources[0]).toMatchObject({attention:'setup',resolvable_by:'you'});expect(state?.phase).toBe('blocked');expect(state?.blocked_reason).toBeTruthy();
});
it('REVIEW: a delayed old activation must not cancel the newly active version collection',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'old-activation'});
 const v2=await real.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:{summary:'Second robotics plan',sources:[{reason:'new source scope',implementation:{kind:'agent_search',query:'robotics updates'},supports_history:false}],limitations:[]}},runId);await real.follow(identity,goalId,{idempotency_key:'new-activation',version_id:v2.id});await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));const current=(await real.read(identity,goalId)).native_runs.find(r=>r.status==='queued')!;expect(current).toBeTruthy();
 const {cancelSupersededCollections}=await import('../src/modules/sources/goals/activation.js');await cancelSupersededCollections(db.pool,config,identity,goalId,v.id);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[current.id])).rows[0].status).toBe('queued');
});
it('stale cleanup leaves a running current-version collection alone; the current version still cancels an older one',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'v1'});
 const old=await nativeTick(real);
 const v2=await real.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:{summary:'Second plan',sources:[{reason:'new scope',implementation:{kind:'agent_search',query:'robotics updates'},supports_history:false}],limitations:[]}},runId);
 // Activate V2 without its own trailing cleanup, then run V2's collection.
 await withSourceGoalLock(async tx=>{const {activateGoalVersion}=await import('../src/modules/sources/goals/activation.js');const g=(await tx.query('SELECT * FROM source_goals WHERE id=$1',[goalId])).rows[0];await activateGoalVersion(tx,config,identity,g,{versionId:v2.id,mode:'continuous',key:'v2',requirePreview:false,reusePreview:true});});
 await db.pool.query(`UPDATE runs r SET status='running',started_at=now(),runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[old]);
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));
 const current=(await real.read(identity,goalId)).native_runs.find(r=>r.id!==old&&r.status==='queued')!;await db.pool.query(`UPDATE runs r SET status='running',started_at=now(),runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[current.id]);
 const {cancelSupersededCollections}=await import('../src/modules/sources/goals/activation.js');
 await cancelSupersededCollections(db.pool,config,identity,goalId,v.id);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[current.id])).rows[0].status).toBe('running');
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[old])).rows[0].status).toBe('running');
 await cancelSupersededCollections(db.pool,config,identity,goalId,v2.id);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[current.id])).rows[0].status).toBe('running');
 expect(['cancelling','cancelled']).toContain((await db.pool.query('SELECT status FROM runs WHERE id=$1',[old])).rows[0].status);
});
async function withSourceGoalLock(fn:(tx:import('pg').PoolClient)=>Promise<void>){const client=await db.pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM source_goals WHERE id=$1 FOR UPDATE',[goalId]);await fn(client);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
it('a second topic on another channel of the same connection keeps existing material, refreshes its own repeats and never rewrites read state',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'first-topic'});await tick();const first=goalId;
 const item=(await db.pool.query('SELECT id FROM source_items WHERE connection_id=$1',[specs[0].source_connection_id])).rows[0].id;
 await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,read_origin,created_at,updated_at) VALUES($1,$2,$3,$4,'read','library',now(),now())`,[randomUUID(),identity.spaceId,item,identity.userId]);
 const before=(await db.pool.query('SELECT title,content_hash,updated_at FROM source_items WHERE id=$1',[item])).rows[0];
 const {SourceChannelService}=await import('../src/modules/sources/channels/sourceChannelService.js');const ch=await new SourceChannelService(db.pool,config).create(identity,{provider_key:'custom_source',source_connection_id:specs[0].source_connection_id,endpoint_url:'https://fixture.test/alternate',fetch_frequency:'manual',name:'Alternate topic channel'});
 const other=await service.create(identity,{intent:'Other robotics',agent_id:'goal-agent',runtime_profile_id:profile,creation_key:'other-channel'});const author=await secondGoalRun(other.id);await service.writeVersion(identity,{goal_id:other.id,expected_revision:0,plan:{summary:'Other topic',sources:[{...specs[0],source_channel_id:ch.id}],limitations:[]}},author);await service.follow(identity,other.id,{idempotency_key:'other'});
 goalId=other.id;await tick();
 const m1=(await db.pool.query('SELECT source_item_id,first_goal_run_id,last_goal_run_id FROM source_goal_items WHERE goal_id=$1',[other.id])).rows;expect(m1).toEqual([expect.objectContaining({source_item_id:item})]);
 await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[other.id]);await tick();goalId=first;
 const m2=(await db.pool.query('SELECT first_goal_run_id,last_goal_run_id FROM source_goal_items WHERE goal_id=$1',[other.id])).rows[0];expect(m2.first_goal_run_id).toBe(m1[0].first_goal_run_id);expect(m2.last_goal_run_id).not.toBe(m1[0].first_goal_run_id);
 expect((await db.pool.query('SELECT count(*)::int n FROM source_items WHERE connection_id=$1',[specs[0].source_connection_id])).rows[0].n).toBe(1);
 expect((await db.pool.query('SELECT title,content_hash,updated_at FROM source_items WHERE id=$1',[item])).rows[0]).toEqual(before);
 expect((await db.pool.query('SELECT read_status FROM source_item_user_states WHERE source_item_id=$1',[item])).rows[0].read_status).toBe('read');
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const read=await new ReadingService(db.pool).list(identity,{view:'read',limit:30,topic:other.id});expect(read.items.map(i=>i.source_item_ids).flat()).toContain(item);
 goalId=other.id;expect((await followState()).results).toMatchObject({items_total:1,last_outcome:'no_new'});goalId=first;
});
it('replayed follow keys recover preparation once under concurrency and after a fixed refusal, without a second attempt charge',async ctx=>{
 if(!db.available)return ctx.skip();await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[runId]);
 await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[profile]);
 const refused=await service.follow(identity,goalId,{idempotency_key:'prep'});expect(refused.follow.last_error).toBe('source_goal_execution_setup_required');
 const explore=()=>db.pool.query("SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$1 AND contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='explore' AND status='queued'",[goalId]).then(r=>r.rows[0].n);
 expect(await explore()).toBe(0);expect((await db.pool.query('SELECT agent_attempts FROM source_goals WHERE id=$1',[goalId])).rows[0].agent_attempts).toBe(0);
 expect((await followState()).phase).toBe('blocked');
 await db.pool.query('UPDATE agent_runtime_profiles SET enabled=true,is_default=true WHERE id=$1',[profile]);
 await Promise.all([service.follow(identity,goalId,{idempotency_key:'prep'}),service.follow(identity,goalId,{idempotency_key:'prep'}),service.follow(identity,goalId,{idempotency_key:'prep'})]);
 expect(await explore()).toBe(1);expect((await db.pool.query('SELECT agent_attempts FROM source_goals WHERE id=$1',[goalId])).rows[0].agent_attempts).toBe(1);
 expect((await db.pool.query(`SELECT count(*)::int n FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id' IN (SELECT id FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'goal_id'=$1)`,[goalId])).rows[0].n).toBe(1);
 expect((await db.pool.query(`SELECT follow_json->>'last_error' e FROM source_goals WHERE id=$1`,[goalId])).rows[0].e).toBeNull();
});
it('a deleted source keeps the topic in list and detail, redacts that source content and shows it needs permission',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'redact'});await tick();
 await db.pool.query("UPDATE source_connections SET deleted_at=now(),status='archived' WHERE id=$1",[specs[0].source_connection_id]);
 expect((await service.list(identity)).goals.map(g=>g.id)).toContain(goalId);
 const d=await service.read(identity,goalId);
 const hidden=d.bindings.find((b:{source_connection_id:string})=>b.source_connection_id===specs[0].source_connection_id) as Record<string,unknown>;
 expect(hidden).toMatchObject({unavailable:true,collection_error:'source_unavailable'});expect(hidden).not.toHaveProperty('spec_json');expect(hidden).not.toHaveProperty('fixture_json');expect(hidden).not.toHaveProperty('cursor_json');
 const healthy=d.bindings.find((b:{source_connection_id:string})=>b.source_connection_id===specs[1].source_connection_id) as Record<string,unknown>;expect(healthy).toHaveProperty('spec_json');
 const plan=d.versions[0] as {plan_json:{sources:{source_connection_id:string}[]};unavailable_sources?:string[]};expect(plan.plan_json.sources.map(s=>s.source_connection_id)).toEqual([specs[1].source_connection_id]);expect(plan.unavailable_sources).toEqual([specs[0].source_connection_id]);
 expect(d.runs.filter((r:{binding_id:string|null;result_json:unknown})=>r.binding_id===hidden.id).every((r:{result_json:unknown})=>r.result_json===null)).toBe(true);
 const state=d.goal.follow_state!;expect(state.health).toBe('needs_permission');expect(state.sources.find(s=>s.source_connection_id===specs[0].source_connection_id)).toMatchObject({health:'needs_permission',error:'source_unavailable'});expect(state.sources.find(s=>s.source_connection_id===specs[1].source_connection_id)?.health).toBe('ok');
 await expect(service.read({...identity,userId:'stranger'},goalId)).rejects.toMatchObject({statusCode:404});
});
it('the shipped 0006 backfill restores only provable memberships, is idempotent and leaves reading state untouched',async ctx=>{
 if(!db.available)return ctx.skip();const v=await version();await service.follow(identity,goalId,{idempotency_key:'backfill'});await tick();
 const {readFileSync}=await import('node:fs');const migration=readFileSync(new URL('../migrations/0006_following_and_reader.sql',import.meta.url),'utf8');
 const statements=[...migration.matchAll(/INSERT INTO "source_goal_items"[\s\S]*?ON CONFLICT \("goal_id","source_item_id"\) DO NOTHING;/g)];expect(statements).toHaveLength(1);const sql=statements[0][0];
 const items=(await db.pool.query('SELECT id,connection_id FROM source_items ORDER BY connection_id')).rows;expect(items).toHaveLength(2);
 await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,read_origin,created_at,updated_at) VALUES($1,$2,$3,$4,'read','library',now(),now())`,[randomUUID(),identity.spaceId,items[0].id,identity.userId]);
 const states=async()=>(await db.pool.query('SELECT source_item_id,read_status,read_origin,updated_at FROM source_item_user_states ORDER BY id')).rows;const statesBefore=await states();
 const expected=(await db.pool.query('SELECT goal_id,source_item_id,binding_id,version_id,first_goal_run_id FROM source_goal_items ORDER BY source_item_id')).rows;
 // Negatives: copies of a real item whose metadata claims this goal but whose proof fails.
 const own=expected.find(e=>e.source_item_id===items[0].id)!;const audit=own.first_goal_run_id;const failedAudit=randomUUID();await db.pool.query(`INSERT INTO source_goal_runs(id,space_id,goal_id,binding_id,version_id,status) VALUES($1,$2,$3,$4,$5,'failed')`,[failedAudit,identity.spaceId,goalId,own.binding_id,v.id]);
 const forge=async(name:string,patch:{run?:string;connection?:string;project?:string;owner?:string;goal?:string})=>{const id=randomUUID();await db.pool.query(`INSERT INTO source_items SELECT (jsonb_populate_record(i, jsonb_build_object('id',$2::text,'source_external_id',$3::text,'source_uri','https://fixture.test/'||$3,'canonical_uri','https://fixture.test/'||$3,'connection_id',COALESCE($5::text,i.connection_id),'project_id',$6::text,'owner_user_id',COALESCE($7::text,i.owner_user_id),'metadata_json',i.metadata_json||jsonb_build_object('goal_run_id',$4::text,'goal_id',COALESCE($8::text,i.metadata_json->>'goal_id'))))).* FROM source_items i WHERE i.id=$1`,[items[0].id,id,name,patch.run??audit,patch.connection??null,patch.project??null,patch.owner??null,patch.goal??null]);return id;};
 await db.pool.query("INSERT INTO users(id,email,display_name,registration_source,status,created_at,updated_at) VALUES('other-owner','other-owner@test','Other','system','active',now(),now()) ON CONFLICT DO NOTHING");
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES('backfill-project',$1,$2,'Other scope','active',now(),now())",[identity.spaceId,identity.userId]);await seedProjectMainlineRoom(db.pool,{space:identity.spaceId,project:'backfill-project',owner:identity.userId});
 await forge('wrong-scope',{project:'backfill-project'});
 await forge('forged-audit',{run:'no-such-audit'});await forge('failed-audit',{run:failedAudit});await forge('wrong-connection',{connection:items[1].connection_id});await forge('wrong-owner',{owner:'other-owner'});await forge('wrong-goal',{goal:randomUUID()});
 await db.pool.query('DELETE FROM source_goal_items');
 await db.pool.query(sql);await db.pool.query(sql);
 expect((await db.pool.query('SELECT goal_id,source_item_id,binding_id,version_id,first_goal_run_id FROM source_goal_items ORDER BY source_item_id')).rows).toEqual(expected);
 expect((await db.pool.query(`SELECT count(*)::int n FROM source_goal_items WHERE selection_status<>'unjudged' OR selection_reason IS NOT NULL`)).rows[0].n).toBe(0);
 expect(await states()).toEqual(statesBefore);
});
// ── P1-2 batch boundary: stored materials beyond one batch still join the topic ──
async function secondTopicOnSameConnection(cap:number){
 const {SourceChannelService}=await import('../src/modules/sources/channels/sourceChannelService.js');const ch=await new SourceChannelService(db.pool,config).create(identity,{provider_key:'custom_source',source_connection_id:specs[0].source_connection_id,endpoint_url:'https://fixture.test/alternate',fetch_frequency:'manual',name:'Alternate topic channel'});
 const other=await service.create(identity,{intent:'Other robotics',agent_id:'goal-agent',runtime_profile_id:profile,creation_key:'batch-'+cap});const author=await secondGoalRun(other.id);
 await service.writeVersion(identity,{goal_id:other.id,expected_revision:0,plan:{summary:'Other topic',sources:[{...specs[0],source_channel_id:ch.id}],limitations:[]}},author);await service.follow(identity,other.id,{idempotency_key:'batch-'+cap,items_per_source:cap});return other.id;
}
const otherTick=async(other:string)=>{const first=goalId;goalId=other;await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[other]);try{await tick();}finally{goalId=first;}};
const membersOf=async(goal:string)=>(await db.pool.query('SELECT source_item_id,first_goal_run_id FROM source_goal_items WHERE goal_id=$1 ORDER BY source_item_id',[goal])).rows;
const cursorOf=async(goal:string)=>(await db.pool.query('SELECT cursor_json FROM source_goal_bindings WHERE goal_id=$1 AND source_connection_id=$2',[goal,specs[0].source_connection_id])).rows[0].cursor_json;
it('stored materials beyond the per-run cap join a second topic over later checks; the page stays pending until all are recorded',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[0].source_connection_id]=[item('a'),item('b'),item('c')];await version();await service.follow(identity,goalId,{idempotency_key:'first-many'});await tick();
 const stored=(await db.pool.query('SELECT id,title,content_hash,updated_at FROM source_items WHERE connection_id=$1 ORDER BY id',[specs[0].source_connection_id])).rows;expect(stored).toHaveLength(3);
 await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,read_origin,created_at,updated_at) VALUES($1,$2,$3,$4,'read','library',now(),now())`,[randomUUID(),identity.spaceId,stored[2].id,identity.userId]);
 const other=await secondTopicOnSameConnection(2);
 await otherTick(other);expect(await membersOf(other)).toHaveLength(2);expect(await cursorOf(other)).toMatchObject({remaining_count:1,coverage:'pending_page'});
 await otherTick(other);const all=await membersOf(other);expect(all.map(m=>m.source_item_id)).toEqual(stored.map(s=>s.id));const done=await cursorOf(other);expect(done).toMatchObject({remaining_count:0,coverage:'page_consumed'});expect(Date.parse(done.watermark)).toBe(Date.parse('2026-10-26T00:00:00Z'));
 await otherTick(other);const again=await membersOf(other);expect(again).toEqual(all);
 expect((await db.pool.query('SELECT id,title,content_hash,updated_at FROM source_items WHERE connection_id=$1 ORDER BY id',[specs[0].source_connection_id])).rows).toEqual(stored);
 expect((await db.pool.query('SELECT read_status FROM source_item_user_states WHERE source_item_id=$1',[stored[2].id])).rows[0].read_status).toBe('read');
 expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_items WHERE goal_id=$1 AND source_connection_id=$2',[goalId,specs[0].source_connection_id])).rows[0].n).toBe(3);
});
it('new candidates and unrecorded stored members share one bounded batch in source order without losing the watermark',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[0].source_connection_id]=[item('a'),item('b'),item('c')];await version();await service.follow(identity,goalId,{idempotency_key:'first-mixed'});await tick();
 const other=await secondTopicOnSameConnection(2);await otherTick(other);expect(await membersOf(other)).toHaveLength(2);
 data[specs[0].source_connection_id]=[item('a'),item('b'),item('c'),{...item('d'),published_at:'2026-10-27T00:00:00Z'}];
 await otherTick(other);
 expect((await membersOf(other))).toHaveLength(4);expect((await db.pool.query('SELECT count(*)::int n FROM source_items WHERE connection_id=$1',[specs[0].source_connection_id])).rows[0].n).toBe(4);
 expect(await cursorOf(other)).toMatchObject({remaining_count:0,coverage:'page_consumed',watermark:'2026-10-27T00:00:00Z'});
 const state=await (async()=>{const first=goalId;goalId=other;try{return await followState();}finally{goalId=first;}})();expect(state.results.items_total).toBe(4);
});
it('an interrupted membership batch keeps the page pending and a later check completes it without rewriting stored material',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[0].source_connection_id]=[item('a'),item('b'),item('c')];await version();await service.follow(identity,goalId,{idempotency_key:'first-restart'});await tick();
 const stored=(await db.pool.query('SELECT id,title,content_hash,updated_at FROM source_items WHERE connection_id=$1 ORDER BY id',[specs[0].source_connection_id])).rows;
 const other=await secondTopicOnSameConnection(2);await otherTick(other);const firstBatch=await membersOf(other);expect(firstBatch).toHaveLength(2);const pending=await cursorOf(other);
 const last=stored.find(s=>!firstBatch.some(m=>m.source_item_id===s.id))!;
 await db.pool.query(`ALTER TABLE source_goal_items ADD CONSTRAINT review_member_write_failure CHECK(NOT(goal_id='${other}' AND source_item_id='${last.id}'))`);
 try{await otherTick(other);expect(await membersOf(other)).toEqual(firstBatch);expect(await cursorOf(other)).toEqual(pending);}
 finally{await db.pool.query('ALTER TABLE source_goal_items DROP CONSTRAINT review_member_write_failure');}
 // A fresh executor/service stands in for a restarted worker.
 await db.pool.query('UPDATE source_goal_bindings SET status=$2,retry_at=NULL,lease_token=NULL,lease_until=NULL WHERE goal_id=$1',[other,'active']);
 const first=goalId;goalId=other;try{await runSourceGoalTick(db.pool,config,other,identity.spaceId,executor);}finally{goalId=first;}
 expect((await membersOf(other)).map(m=>m.source_item_id)).toEqual(stored.map(s=>s.id));expect(await cursorOf(other)).toMatchObject({remaining_count:0,coverage:'page_consumed'});
 expect((await db.pool.query('SELECT id,title,content_hash,updated_at FROM source_items WHERE connection_id=$1 ORDER BY id',[specs[0].source_connection_id])).rows).toEqual(stored);
});
// ── P1-2 tombstones: deleted rows suppress re-materialization but are not member work ──
const rowsOf=async()=>(await db.pool.query('SELECT id,source_external_id,title,content_hash,deleted_at FROM source_items WHERE connection_id=$1 ORDER BY source_external_id',[specs[0].source_connection_id])).rows;
it('deleted, recorded, unrecorded and new materials: tombstones take no batch and valid members still complete the page',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[0].source_connection_id]=[item('a'),item('b'),item('c'),item('d')];await version();await service.follow(identity,goalId,{idempotency_key:'tomb-first'});await tick();
 const other=await secondTopicOnSameConnection(2);await otherTick(other);
 const byExt=Object.fromEntries((await rowsOf()).map(r=>[r.source_external_id,r.id]));expect((await membersOf(other)).map(m=>m.source_item_id).sort()).toEqual([byExt.a,byExt.b].sort());
 await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,read_origin,created_at,updated_at) VALUES($1,$2,$3,$4,'read','library',now(),now())`,[randomUUID(),identity.spaceId,byExt.b,identity.userId]);
 await db.pool.query('UPDATE source_items SET deleted_at=now() WHERE id=ANY($1::varchar[])',[[byExt.a,byExt.c]]);const before=await rowsOf();
 data[specs[0].source_connection_id]=[item('a'),item('b'),item('c'),item('d'),{...item('e'),published_at:'2026-10-27T00:00:00Z'}];
 await otherTick(other);
 const after=await rowsOf();expect(after.filter(r=>r.source_external_id!=='e')).toEqual(before);expect(after.find(r=>r.source_external_id==='e')!.deleted_at).toBeNull();
 expect((await membersOf(other)).map(m=>m.source_item_id).sort()).toEqual([byExt.a,byExt.b,byExt.d,after.find(r=>r.source_external_id==='e')!.id].sort());
 expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_items WHERE goal_id=$1 AND source_item_id=$2',[other,byExt.c])).rows[0].n).toBe(0);
 const done=await cursorOf(other);expect(done).toMatchObject({remaining_count:0,coverage:'page_consumed'});expect(Date.parse(done.watermark)).toBe(Date.parse('2026-10-27T00:00:00Z'));
 expect((await db.pool.query('SELECT read_status FROM source_item_user_states WHERE source_item_id=$1',[byExt.b])).rows[0].read_status).toBe('read');
});
it('a page of only tombstones finishes without fake pending progress, new rows, members or watermark',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[0].source_connection_id]=[item('a'),item('b'),item('c')];await version();await service.follow(identity,goalId,{idempotency_key:'tomb-all'});await tick();
 await db.pool.query('UPDATE source_items SET deleted_at=now() WHERE connection_id=$1',[specs[0].source_connection_id]);const before=await rowsOf();
 const other=await secondTopicOnSameConnection(2);
 for(let i=0;i<2;i++)await otherTick(other);
 expect(await rowsOf()).toEqual(before);expect(await membersOf(other)).toEqual([]);
 const cursor=await cursorOf(other);expect(cursor).toMatchObject({remaining_count:0,coverage:'page_consumed'});expect(cursor.watermark??null).toBeNull();expect(cursor.pending_watermark??null).toBeNull();
 const first=goalId;goalId=other;try{expect((await followState()).results).toMatchObject({items_total:0,last_outcome:'no_new'});}finally{goalId=first;}
});
// ── Topic following, phase 2: freshness, judgment and owner feedback ──
const membership=async(goal:string)=>Object.fromEntries((await db.pool.query<{source_uri:string;selection_status:string;selection_reason:string|null;judged_by:string|null;delivery_kind:string;change_evidence_url:string|null;occurred_at:string|null}>(`SELECT i.source_uri,gi.selection_status,gi.selection_reason,gi.judged_by,gi.delivery_kind,gi.change_evidence_url,i.occurred_at FROM source_goal_items gi JOIN source_items i ON i.id=gi.source_item_id WHERE gi.goal_id=$1`,[goal])).rows.map(r=>[r.source_uri,r]));
const collectRuns=async()=>(await db.pool.query(`SELECT count(*)::int n FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'source_goal'->>'purpose'='collect'`)).rows[0].n;
it('a followed Agent topic keeps a baseline, then separates stated new publications, cited changes and unknown freshness, with judgments and every candidate kept',async ctx=>{
 if(!db.available)return ctx.skip();await db.pool.query(`UPDATE source_goals SET intent_json=jsonb_set(intent_json,'{includes}','[]') WHERE id=$1`,[goalId]);
 const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'p2-native'});
 const u=(p:string)=>'https://evidence.test/'+p;
 await finishNative(await nativeTick(real),true,[
  {url:u('lab'),title:'Robotics lab opens',published_at:'2026-10-20T00:00:00Z',topic_judgment:{importance:'important',reason:'Primary topic news'}},
  {url:u('garden'),title:'Gardening crossover',topic_judgment:{importance:'not_selected',reason:'Only loosely related'}},
  {url:u('repo'),title:'Robotics toolkit repository'},
 ] as never);await real.read(identity,goalId);
 let m=await membership(goalId);
 expect(m[u('lab')]).toMatchObject({selection_status:'important',selection_reason:'Primary topic news',judged_by:'collection_agent',delivery_kind:'baseline'});
 expect(m[u('garden')]).toMatchObject({selection_status:'not_selected',judged_by:'collection_agent',delivery_kind:'baseline'});
 expect(m[u('repo')]).toMatchObject({selection_status:'unjudged',judged_by:null,delivery_kind:'baseline',occurred_at:null});
 expect(Date.parse(String(m[u('lab')].occurred_at))).toBe(Date.parse('2026-10-20T00:00:00Z'));
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);
 expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId,topic_selection:'important'})).items.map(i=>i.title)).toEqual(['Robotics lab opens']);
 expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId})).total).toBe(3);
 await finishNative(await nativeTick(real),true,[
  {url:u('repo'),title:'Robotics toolkit repository'},
  {url:u('paper'),title:'New robotics paper',published_at:'2026-10-25T00:00:00Z',topic_judgment:{importance:'important',reason:'New result'}},
  {url:u('release'),title:'Toolkit 2.0 released',change:{kind:'release',evidence_url:u('release/notes')}},
  {url:u('undated'),title:'Robotics overview page'},
  {url:u('old'),title:'Older robotics essay',published_at:'2026-10-01T00:00:00Z'},
 ] as never);await real.read(identity,goalId);
 m=await membership(goalId);
 expect(m[u('repo')].delivery_kind).toBe('baseline');
 expect(m[u('paper')]).toMatchObject({delivery_kind:'new_publication',selection_status:'important'});
 expect(m[u('release')]).toMatchObject({delivery_kind:'evidenced_change',change_evidence_url:u('release/notes')});
 expect(m[u('undated')]).toMatchObject({delivery_kind:'unknown_freshness',occurred_at:null});
 expect(m[u('old')].delivery_kind).toBe('unknown_freshness');
 // The Agent reports that judging failed through the same bound action.
 const late=await nativeTick(real);const s3=await submitted(late,[{url:u('late'),title:'Late robotics note'}],{judgment_failure:{message:'Judging timed out'}});
 const {CliAgentToolTransport}=await import('../src/modules/runs/cliToolTransport.js');expect(await new CliAgentToolTransport(config).call(s3.run,{id:'late-submit',name:'source.material.submit',arguments:s3.input})).toMatchObject({ok:true});
 await db.pool.query(`UPDATE runs r SET status='succeeded',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p),output_json=$2 FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[late,{schema_version:'run_output.v1',status:'succeeded',summary:'Fixture Agent completion, not a real model call',result:{output_text:'done'},outputs:[]}]);
 await real.read(identity,goalId);m=await membership(goalId);
 expect(m[u('late')]).toMatchObject({selection_status:'judgment_failed',selection_reason:'Judging timed out',delivery_kind:'unknown_freshness'});
 expect(await collectRuns()).toBe(3);
 const state=(await real.read(identity,goalId)).goal.follow_state!;
 expect(state.results).toMatchObject({items_total:8,important_total:2,not_selected_total:1,judgment_failed_total:1,baseline_total:3,new_publication_total:1,evidenced_change_total:1,unknown_freshness_total:3});
 const topics=(await reading.list(identity,{view:'pending',limit:30,topic:goalId})).items.find(i=>i.title==='Toolkit 2.0 released')!.topics[0];expect(topics).toMatchObject({delivery_kind:'evidenced_change',selection_status:'unjudged'});
});
it('structured sources use deterministic topic rules; owner feedback only tightens, applies once, keeps data and governs later judgments',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'p2-api'});await tick();
 let m=await membership(goalId);for(const r of Object.values(m))expect(r).toMatchObject({selection_status:'important',judged_by:'topic_rules',delivery_kind:'baseline'});
 await expect(service.feedback(identity,goalId,{kind:'slow_down',idempotency_key:'faster',interval_seconds:3600})).rejects.toMatchObject({responseBody:{error:'source_goal_feedback_requires_confirmation'}});
 const r1=await service.feedback(identity,goalId,{kind:'exclude_term',idempotency_key:'no-api',term:'api'});expect(r1).toMatchObject({applied:true,affected:1});
 expect(await service.feedback(identity,goalId,{kind:'exclude_term',idempotency_key:'no-api',term:'api'})).toMatchObject({applied:false,duplicate:true});
 m=await membership(goalId);expect(m['https://fixture.test/api']).toMatchObject({selection_status:'not_selected',judged_by:'owner',selection_reason:'Excluded by your feedback: "api"'});expect(m['https://fixture.test/feed'].selection_status).toBe('important');
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);
 expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId,topic_selection:'important'})).total).toBe(1);expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId})).total).toBe(2);
 data[specs[1].source_connection_id]=[item('api'),item('api-two')];data[specs[0].source_connection_id]=[item('feed'),{...item('feed-two'),published_at:'2026-10-27T00:00:00Z'}];
 await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL');await tick();m=await membership(goalId);
 expect(m['https://fixture.test/api-two']).toMatchObject({selection_status:'not_selected',judged_by:'owner'});
 expect(m['https://fixture.test/api'].judged_by).toBe('owner');
 expect(m['https://fixture.test/feed-two']).toMatchObject({selection_status:'important',delivery_kind:'new_publication'});
 const feedItem=(await db.pool.query(`SELECT id FROM source_items WHERE source_uri='https://fixture.test/feed'`)).rows[0].id;
 await service.feedback(identity,goalId,{kind:'not_relevant',idempotency_key:'feed-off',source_item_id:feedItem});expect((await membership(goalId))['https://fixture.test/feed']).toMatchObject({selection_status:'not_selected',judged_by:'owner',selection_reason:'Marked not relevant by you'});
 await expect(service.feedback(identity,goalId,{kind:'not_relevant',idempotency_key:'foreign',source_item_id:'not-a-member'})).rejects.toMatchObject({statusCode:404});
 await service.feedback(identity,goalId,{kind:'exclude_origin',idempotency_key:'origin',origin:'https://fixture.test/anything'});expect(Object.values(await membership(goalId)).every(r=>r.selection_status==='not_selected')).toBe(true);
 const slow=await service.feedback(identity,goalId,{kind:'slow_down',idempotency_key:'slower',interval_seconds:172800});expect(slow.applied).toBe(true);
 expect((await db.pool.query('SELECT budget_json,follow_json FROM source_goals WHERE id=$1',[goalId])).rows[0]).toMatchObject({budget_json:{interval_seconds:172800},follow_json:{rules:{excluded_origins:['https://fixture.test'],excluded_terms:['api']}}});
 expect(Date.parse((await db.pool.query(`SELECT next_run_at FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1`,[goalId])).rows[0].next_run_at)).toBeGreaterThan(Date.now()+86400_000);
 expect(await service.follow(identity,goalId,{idempotency_key:'p2-api'})).toMatchObject({activated:false});
 await expect(service.feedback({...identity,userId:'stranger'},goalId,{kind:'exclude_term',idempotency_key:'x',term:'x'})).rejects.toMatchObject({statusCode:404});
 expect((await db.pool.query('SELECT count(*)::int n FROM source_items WHERE deleted_at IS NULL')).rows[0].n).toBe(4);
});
it('feedback requires a confirmed follow and never activates or widens anything',async ctx=>{
 if(!db.available)return ctx.skip();await version();
 await expect(service.feedback(identity,goalId,{kind:'exclude_term',idempotency_key:'early',term:'x'})).rejects.toMatchObject({responseBody:{error:'source_goal_feedback_requires_follow'}});
 expect((await db.pool.query('SELECT status,active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0]).toMatchObject({active_version_id:null});
 const {SourceGoalFeedbackRequestSchema}=await import('@rainver/protocol');expect(SourceGoalFeedbackRequestSchema.safeParse({kind:'speed_up',idempotency_key:'k'}).success).toBe(false);
});
it('a reused preview keeps the Agent judgment for the first followed batch without another Run',async ctx=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));const previewRun=(await real.read(identity,goalId)).native_runs[0].id;
 await finishNative(previewRun,true,[{url:'https://evidence.test/robotics',title:'Robotics actual search result',topic_judgment:{importance:'not_selected',reason:'Duplicate coverage'}}] as never);await real.read(identity,goalId);
 await real.follow(identity,goalId,{idempotency_key:'reuse-judged'});
 expect(Object.values(await membership(goalId))).toEqual([expect.objectContaining({selection_status:'not_selected',selection_reason:'Duplicate coverage',judged_by:'collection_agent',delivery_kind:'baseline'})]);
 expect(await collectRuns()).toBe(1);
});
// ── Phase-2 review fixes: change history, baseline window, publication time ──
const changesOf=async(goal:string)=>(await db.pool.query('SELECT source_item_id,change_kind,evidence_url,delivery_kind,selection_status,judged_by,goal_run_id,agent_run_id FROM source_goal_item_changes WHERE goal_id=$1 ORDER BY detected_at,id',[goal])).rows;
it('a stable material records each newly cited change once per topic, keeps owner feedback first and never rewrites saved history',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();
 // Topic B follows an API Source that stores the same canonical link first.
 const b=await service.create(identity,{intent:'Industry feed',agent_id:'goal-agent',runtime_profile_id:profile,creation_key:'iso-b'});const bRun=await secondGoalRun(b.id);
 await service.writeVersion(identity,{goal_id:b.id,expected_revision:0,plan:{summary:'Feed',sources:specs.slice(0,1),limitations:[]}},bRun);await service.follow(identity,b.id,{idempotency_key:'iso-b'});
 const first=goalId;goalId=b.id;await tick();goalId=first;
 const url='https://fixture.test/feed';await real.follow(identity,goalId,{idempotency_key:'changes'});
 await finishNative(await nativeTick(real),true,[{url,title:'Robotics feed'}]);await real.read(identity,goalId);
 const item=(await db.pool.query('SELECT id,content_state,excerpt,reading_body_revision FROM source_items WHERE source_uri=$1',[url])).rows[0];
 await finishNative(await nativeTick(real),true,[{url,title:'Robotics feed'}]);await real.read(identity,goalId);
 expect(await changesOf(goalId)).toEqual([]);expect((await membership(goalId))[url].delivery_kind).toBe('baseline');
 await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,read_origin,created_at,updated_at) VALUES($1,$2,$3,$4,'read','library',now(),now())`,[randomUUID(),identity.spaceId,item.id,identity.userId]);
 const r3=await nativeTick(real);await finishNative(r3,true,[{url,title:'Robotics feed v2',change:{kind:'update',evidence_url:'https://fixture.test/feed/changelog-1'},topic_judgment:{importance:'important',reason:'Major update'}}] as never);await real.read(identity,goalId);
 let changes=await changesOf(goalId);expect(changes).toEqual([expect.objectContaining({source_item_id:item.id,change_kind:'update',evidence_url:'https://fixture.test/feed/changelog-1',delivery_kind:'evidenced_change',selection_status:'important',judged_by:'collection_agent',agent_run_id:r3})]);
 expect((await membership(goalId))[url]).toMatchObject({delivery_kind:'evidenced_change',change_evidence_url:'https://fixture.test/feed/changelog-1',selection_status:'important',judged_by:'collection_agent'});
 await finishNative(await nativeTick(real),true,[{url,title:'Robotics feed v2',change:{kind:'update',evidence_url:'https://fixture.test/feed/changelog-1'}}] as never);await real.read(identity,goalId);
 expect(await changesOf(goalId)).toHaveLength(1);
 await finishNative(await nativeTick(real),true,[{url,title:'Robotics feed v3',change:{kind:'release',evidence_url:'https://fixture.test/feed/changelog-2'},topic_judgment:{importance:'not_selected',reason:'Minor fix'}}] as never);await real.read(identity,goalId);
 changes=await changesOf(goalId);expect(changes.map(c=>[c.evidence_url,c.selection_status])).toEqual([['https://fixture.test/feed/changelog-1','important'],['https://fixture.test/feed/changelog-2','not_selected']]);
 expect((await membership(goalId))[url]).toMatchObject({change_evidence_url:'https://fixture.test/feed/changelog-2',selection_status:'not_selected'});
 await service.feedback(identity,goalId,{kind:'not_relevant',idempotency_key:'owner-off',source_item_id:item.id});
 await finishNative(await nativeTick(real),true,[{url,title:'Robotics feed v4',change:{kind:'update',evidence_url:'https://fixture.test/feed/changelog-3'},topic_judgment:{importance:'important',reason:'Agent likes it'}}] as never);await real.read(identity,goalId);
 expect((await changesOf(goalId)).at(-1)).toMatchObject({evidence_url:'https://fixture.test/feed/changelog-3',selection_status:'not_selected',judged_by:'owner'});
 expect((await membership(goalId))[url]).toMatchObject({selection_status:'not_selected',judged_by:'owner',change_evidence_url:'https://fixture.test/feed/changelog-3'});
 expect((await db.pool.query('SELECT count(*)::int n FROM source_items WHERE source_uri=$1',[url])).rows[0].n).toBe(1);
 // No saved body or reading revision is rewritten (canonical metadata refresh is the materializer's existing behavior).
 expect((await db.pool.query('SELECT id,content_state,excerpt,reading_body_revision FROM source_items WHERE id=$1',[item.id])).rows[0]).toEqual(item);
 expect((await db.pool.query('SELECT read_status FROM source_item_user_states WHERE source_item_id=$1',[item.id])).rows[0].read_status).toBe('read');
 // Topic B shares the material but not A's change history or judgments.
 expect(await changesOf(b.id)).toEqual([]);expect((await membership(b.id))[url]).toMatchObject({delivery_kind:'baseline'});
 const detail=await real.read(identity,goalId);expect(detail.changes!.map(c=>c.evidence_url)).toEqual(['https://fixture.test/feed/changelog-3','https://fixture.test/feed/changelog-2','https://fixture.test/feed/changelog-1']);expect(detail.goal.follow_state!.results.changes_total).toBe(3);
});
it('a first collection spanning bounded batches stays baseline through failure and recovery; later and older bindings are not baseline',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[0].source_connection_id]=[item('a'),item('b'),item('c')];await version();await service.follow(identity,goalId,{idempotency_key:'window',items_per_source:2});
 const window=async()=>(await db.pool.query('SELECT cursor_json FROM source_goal_bindings WHERE goal_id=$1 AND source_connection_id=$2',[goalId,specs[0].source_connection_id])).rows[0].cursor_json;
 await tick();expect(await window()).toMatchObject({baseline_window:'open',coverage:'pending_page'});
 const firstBatch=(await db.pool.query('SELECT source_item_id FROM source_goal_items WHERE goal_id=$1 AND source_connection_id=$2',[goalId,specs[0].source_connection_id])).rows.map(r=>r.source_item_id);expect(firstBatch).toHaveLength(2);
 await db.pool.query(`ALTER TABLE source_goal_items ADD CONSTRAINT review_window_failure CHECK(NOT(goal_id='${goalId}' AND source_item_id<>ALL(ARRAY['${firstBatch.join("','")}']::varchar[]) AND source_connection_id='${specs[0].source_connection_id}'))`);
 data[specs[0].source_connection_id]=[item('c'),item('b'),item('a')];
 try{await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL,status=$2 WHERE goal_id=$1',[goalId,'active']);await tick();expect(await window()).toMatchObject({baseline_window:'open'});}
 finally{await db.pool.query('ALTER TABLE source_goal_items DROP CONSTRAINT review_window_failure');}
 await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL,status=$2,lease_token=NULL,lease_until=NULL WHERE goal_id=$1',[goalId,'active']);await tick();
 const rows=(await db.pool.query('SELECT delivery_kind FROM source_goal_items WHERE goal_id=$1 AND source_connection_id=$2',[goalId,specs[0].source_connection_id])).rows;expect(rows).toHaveLength(3);expect(rows.every(r=>r.delivery_kind==='baseline')).toBe(true);
 expect(await window()).toMatchObject({baseline_window:'complete',coverage:'page_consumed'});
 data[specs[0].source_connection_id]=[item('a'),item('b'),item('c'),{...item('d'),published_at:'2026-10-27T00:00:00Z'}];await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL');await tick();
 expect((await membership(goalId))['https://fixture.test/d'].delivery_kind).toBe('new_publication');
 // A binding that predates the window flag and already succeeded is not baseline.
 await db.pool.query(`UPDATE source_goal_bindings SET cursor_json=cursor_json-'baseline_window',retry_at=NULL WHERE goal_id=$1 AND source_connection_id=$2`,[goalId,specs[1].source_connection_id]);
 data[specs[1].source_connection_id]=[item('api'),{...item('api-late'),published_at:'2026-10-28T00:00:00Z'}];await tick();
 expect((await membership(goalId))['https://fixture.test/api'].delivery_kind).toBe('baseline');expect((await membership(goalId))['https://fixture.test/api-late'].delivery_kind).toBe('new_publication');
});
it('new publication requires a valid stated time strictly after the committed watermark; Agent labels never bypass it',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'times'});const u=(p:string)=>'https://evidence.test/'+p;
 await finishNative(await nativeTick(real),true,[{url:u('w'),title:'Robotics watermark',published_at:'2026-10-25T00:00:00Z'}] as never);await real.read(identity,goalId);
 const label={change:{kind:'new_publication',evidence_url:u('claim')}};
 await finishNative(await nativeTick(real),true,[
  {url:u('older'),title:'Robotics older',published_at:'2020-01-01T00:00:00Z',...label},
  {url:u('equal'),title:'Robotics equal',published_at:'2026-10-25T00:00:00Z',...label},
  {url:u('later'),title:'Robotics later',published_at:'2026-10-26T00:00:00Z'},
  {url:u('undated'),title:'Robotics undated',...label},
  {url:u('future'),title:'Robotics future',published_at:'2099-01-01T00:00:00Z',...label},
  {url:u('release'),title:'Robotics release',published_at:'2020-01-01T00:00:00Z',change:{kind:'release',evidence_url:u('release/notes')}},
 ] as never);await real.read(identity,goalId);const m=await membership(goalId);
 expect(Object.fromEntries(['older','equal','later','undated','future','release'].map(k=>[k,m[u(k)].delivery_kind]))).toEqual({older:'unknown_freshness',equal:'unknown_freshness',later:'new_publication',undated:'unknown_freshness',future:'unknown_freshness',release:'evidenced_change'});
 expect(m[u('future')].occurred_at).toBeNull();
});
it('without a committed watermark a dated later item stays unknown freshness',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'no-mark'});const u=(p:string)=>'https://evidence.test/'+p;
 await finishNative(await nativeTick(real),true,[{url:u('first'),title:'Robotics first'}] as never);await real.read(identity,goalId);
 await finishNative(await nativeTick(real),true,[{url:u('dated'),title:'Robotics dated',published_at:'2026-10-26T00:00:00Z',change:{kind:'new_publication',evidence_url:u('dated')}}] as never);await real.read(identity,goalId);
 expect((await membership(goalId))[u('dated')].delivery_kind).toBe('unknown_freshness');
});
it('a feedback key replayed with a different payload is refused',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'fb'});
 await service.feedback(identity,goalId,{kind:'exclude_term',idempotency_key:'k1',term:'ads'});
 expect(await service.feedback(identity,goalId,{kind:'exclude_term',idempotency_key:'k1',term:'ads'})).toMatchObject({duplicate:true});
 await expect(service.feedback(identity,goalId,{kind:'exclude_term',idempotency_key:'k1',term:'other'})).rejects.toMatchObject({responseBody:{error:'source_goal_feedback_key_changed'}});
 expect((await db.pool.query(`SELECT follow_json->'rules'->'excluded_terms' t FROM source_goals WHERE id=$1`,[goalId])).rows[0].t).toEqual(['ads']);
});
// ── F2 upstream pagination: the first-collection window spans explicit pages ──
const pagedPort=(pages:Record<string,{items:ReturnType<typeof item>[];next:Record<string,unknown>}>):GoalExecutionPort=>({async execute(i,g,s,c,signal){const r=await executor.execute(i,g,s,c,signal);if(s.source_connection_id!==specs[0].source_connection_id)return r;const page=pages[String(c.cursor??'first')]??pages.first;return {...r,output:{contract_version:'custom_source.handler_output.v1',items:page.items},cursor:page.next};}});
const pagedTick=async(port:GoalExecutionPort)=>{await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[goalId]);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,port);};
const feedCursor=async()=>(await db.pool.query('SELECT cursor_json FROM source_goal_bindings WHERE goal_id=$1 AND source_connection_id=$2',[goalId,specs[0].source_connection_id])).rows[0].cursor_json;
const feedDelivery=async()=>Object.fromEntries((await db.pool.query(`SELECT i.source_uri,gi.delivery_kind FROM source_goal_items gi JOIN source_items i ON i.id=gi.source_item_id WHERE gi.goal_id=$1 AND gi.source_connection_id=$2`,[goalId,specs[0].source_connection_id])).rows.map(r=>[r.source_uri.replace('https://fixture.test/',''),r.delivery_kind]));
const dated=(id:string,at:string)=>({...item(id),published_at:at});
it('explicit upstream pages, each within or beyond the batch cap, stay one baseline window; a later check is incremental',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'pages',items_per_source:2});
 const port=pagedPort({first:{items:[dated('p1a','2026-10-24T00:00:00Z'),dated('p1b','2026-10-24T00:00:00Z'),dated('p1c','2026-10-24T00:00:00Z')],next:{cursor:'page-2'}},'page-2':{items:[dated('p2a','2026-10-25T00:00:00Z')],next:{cursor:null}}});
 await pagedTick(port);expect(await feedCursor()).toMatchObject({baseline_window:'open',coverage:'pending_page'});
 await pagedTick(port);expect(await feedCursor()).toMatchObject({baseline_window:'open',baseline_pages:1,cursor:'page-2'});
 await pagedTick(port);expect(await feedCursor()).toMatchObject({baseline_window:'complete'});expect(await feedCursor()).not.toHaveProperty('baseline_pages');
 expect(await feedDelivery()).toEqual({p1a:'baseline',p1b:'baseline',p1c:'baseline',p2a:'baseline'});
 const later=pagedPort({first:{items:[dated('new','2026-10-27T00:00:00Z'),dated('p1a','2026-10-24T00:00:00Z')],next:{cursor:null}}});
 await db.pool.query(`UPDATE source_goal_bindings SET cursor_json=cursor_json-'cursor' WHERE goal_id=$1`,[goalId]);await pagedTick(later);
 expect((await feedDelivery()).new).toBe('new_publication');
});
it('a failed later page keeps the window and its continuation; a cursor reset mid-window keeps baseline until the upstream ends',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'page-fail',items_per_source:5});
 const port=pagedPort({first:{items:[dated('f1','2026-10-24T00:00:00Z')],next:{cursor:'page-2'}},'page-2':{items:[dated('f2','2026-10-26T00:00:00Z')],next:{cursor:null}}});
 await pagedTick(port);const afterFirst=await feedCursor();expect(afterFirst).toMatchObject({baseline_window:'open',baseline_pages:1,cursor:'page-2'});
 // Page 2's write fails: the whole batch (items, membership, cursor, window) rolls back.
 await db.pool.query(`ALTER TABLE source_items ADD CONSTRAINT review_page_failure CHECK(source_uri<>'https://fixture.test/f2')`);
 try{await db.pool.query('UPDATE source_goal_bindings SET status=$2 WHERE goal_id=$1',[goalId,'active']);await pagedTick(port);expect(await feedCursor()).toEqual(afterFirst);expect(await feedDelivery()).toEqual({f1:'baseline'});}
 finally{await db.pool.query('ALTER TABLE source_items DROP CONSTRAINT review_page_failure');}
 // A cursor reset (as on a version switch) drops the continuation but keeps the window.
 const {GOAL_CURSOR_RESET_SQL}=await import('../src/modules/sources/goals/selection.js');await db.pool.query(`UPDATE source_goal_bindings SET ${GOAL_CURSOR_RESET_SQL},status='active',lease_token=NULL,lease_until=NULL WHERE goal_id=$1`,[goalId]);
 expect(await feedCursor()).toMatchObject({baseline_window:'open',baseline_pages:1});expect(await feedCursor()).not.toHaveProperty('cursor');
 await pagedTick(port);await pagedTick(port);
 expect(await feedDelivery()).toEqual({f1:'baseline',f2:'baseline'});expect(await feedCursor()).toMatchObject({baseline_window:'complete'});
});
it('a provider that always offers another page closes the window at the bound; an unknown cursor shape is one page',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'bound',items_per_source:5});
 const {BASELINE_MAX_PAGES}=await import('../src/modules/sources/goals/selection.js');
 const endless:GoalExecutionPort={async execute(i,g,s,c,signal){const r=await executor.execute(i,g,s,c,signal);if(s.source_connection_id!==specs[0].source_connection_id)return r;const n=Number(String(c.cursor??'p0').slice(1));return {...r,output:{contract_version:'custom_source.handler_output.v1',items:[dated('e'+n,'2026-10-24T00:00:00Z')]},cursor:{cursor:'p'+(n+1)}};}};
 for(let i=0;i<BASELINE_MAX_PAGES+1;i++)await pagedTick(endless);
 const d=await feedDelivery();expect(Object.values(d).filter(k=>k==='baseline')).toHaveLength(BASELINE_MAX_PAGES);expect(d['e'+BASELINE_MAX_PAGES]).toBe('unknown_freshness');
 await db.pool.query(`UPDATE source_goal_bindings SET cursor_json='{}'::jsonb,last_success_at=NULL WHERE goal_id=$1 AND source_connection_id=$2`,[goalId,specs[0].source_connection_id]);
 const opaque=pagedPort({first:{items:[dated('o1','2026-10-24T00:00:00Z')],next:{token:'whatever'}}});await pagedTick(opaque);
 expect(await feedCursor()).toMatchObject({baseline_window:'complete'});
});
it('follow_state separates queued from running collection; manual save stays optional and never follows',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await readyNative();const native=await nativeTick(real);
 expect((await real.read(identity,goalId)).goal.follow_state).toMatchObject({phase:'first_collection',collections:{queued:1,running:0}});
 await db.pool.query(`UPDATE runs r SET status='running',runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`,[native]);
 expect((await real.read(identity,goalId)).goal.follow_state).toMatchObject({phase:'first_collection',collections:{queued:0,running:1}});
 await finishNative(native);const settled=(await real.read(identity,goalId)).goal.follow_state;expect(settled?.collections).toEqual({queued:0,running:0});expect(settled?.results.last_outcome).toBe('new_items');
 // Continuous following has one entry (follow); manual save is a separate,
 // preview-bound action that refuses non-Agent plans and continuous options.
 const {SourceGoalSaveSampleSchema}=await import('@rainver/protocol');expect(SourceGoalSaveSampleSchema.safeParse({version_id:goalId,preview_id:goalId,idempotency_key:'k',execution_mode:'continuous'}).success).toBe(false);
 expect('start' in real).toBe(false);
});
it('manual save refuses a non-Agent plan without activating it',async ctx=>{
 if(!db.available)return ctx.skip();const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);
 await expect(service.saveSample(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'connector-save'})).rejects.toMatchObject({statusCode:409});
 expect((await db.pool.query('SELECT active_version_id,status FROM source_goals WHERE id=$1',[goalId])).rows[0]).toMatchObject({active_version_id:null});expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_bindings')).rows[0].n).toBe(0);
});
it.for(['paused','running'] as const)('a manual-save topic (%s) converts to continuous following through one confirmation',async(state,ctx)=>{
 if(!db.available)return ctx.skip();const {real,v}=await nativePlan();const p=await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));await finishNative((await real.read(identity,goalId)).native_runs[0].id);await real.read(identity,goalId);
 await real.saveSample(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'manual-first'});expect((await db.pool.query("SELECT compatibility_json->>'execution_mode' mode FROM source_goals WHERE id=$1",[goalId])).rows[0].mode).toBe('manual');
 // 'running' is the short manual-staging window before settlement pauses the goal.
 if(state==='running')await db.pool.query("UPDATE source_goals SET status='running' WHERE id=$1",[goalId]);
 const followed=await real.follow(identity,goalId,{idempotency_key:'convert-'+state});expect(followed).toMatchObject({activated:true,status:'running'});
 expect((await db.pool.query("SELECT status,compatibility_json->>'execution_mode' mode FROM source_goals WHERE id=$1",[goalId])).rows[0]).toEqual({status:'running',mode:'continuous'});
 expect((await db.pool.query("SELECT status FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1",[goalId])).rows[0].status).toBe('active');
 expect((await db.pool.query('SELECT count(*)::int n FROM source_items')).rows[0].n).toBe(1);
});

// Holistic contract regressions: real PostgreSQL, deterministic external Agent submissions.
it('HOLISTIC: changes of a canonical shared material obey its actual source ACL',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();const other=await service.create(identity,{intent:'Robotics feed',agent_id:'goal-agent',runtime_profile_id:profile,creation_key:'original-source'});const author=await secondGoalRun(other.id);await service.writeVersion(identity,{goal_id:other.id,expected_revision:0,plan:{summary:'Original feed',sources:specs.slice(0,1),limitations:[]}},author);await service.follow(identity,other.id,{idempotency_key:'original-source'});const current=goalId;goalId=other.id;await tick();goalId=current;
 const url='https://fixture.test/feed';await real.follow(identity,goalId,{idempotency_key:'shared-copy'});await finishNative(await nativeTick(real),true,[{url,title:'Robotics shared article'}]);await real.read(identity,goalId);
 await finishNative(await nativeTick(real),true,[{url,title:'Robotics updated article',change:{kind:'update',evidence_url:'https://fixture.test/restricted-change'},topic_judgment:{importance:'important',reason:'Restricted source update reason'}}] as never);await real.read(identity,goalId);expect(await changesOf(goalId)).toHaveLength(1);
 const item=(await db.pool.query('SELECT id,connection_id FROM source_items WHERE source_uri=$1',[url])).rows[0];expect(item.connection_id).toBe(specs[0].source_connection_id);
 await db.pool.query("UPDATE source_connections SET deleted_at=now(),status='archived' WHERE id=$1",[item.connection_id]);
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');expect((await new ReadingService(db.pool).list(identity,{view:'all',limit:30,topic:goalId})).total).toBe(0);
 const detail=await real.read(identity,goalId);expect(detail.bindings.every((b:any)=>b.unavailable!==true)).toBe(true);expect(detail.changes).toEqual([]);
});
it('HOLISTIC: a newly cited same-URL change is delivered to pending Reading without erasing old read state',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'read-update'});const url='https://evidence.test/robotics';await finishNative(await nativeTick(real),true,[{url,title:'Robotics project',topic_judgment:{importance:'important',reason:'Core robotics'}}] as never);await real.read(identity,goalId);
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);const first=(await reading.list(identity,{view:'pending',limit:30,topic:goalId})).items[0];await reading.state(identity,first.source_item_id,{read_status:'read'});expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId})).total).toBe(0);
 await finishNative(await nativeTick(real),true,[{url,title:'Robotics project',change:{kind:'release',evidence_url:'https://evidence.test/releases/v2'},topic_judgment:{importance:'important',reason:'New important release'}}] as never);await real.read(identity,goalId);expect(await changesOf(goalId)).toHaveLength(1);expect((await db.pool.query('SELECT read_status FROM source_item_user_states WHERE source_item_id=$1',[first.source_item_id])).rows[0].read_status).toBe('read');expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId,topic_selection:'important'})).total).toBe(1);
});
it('HOLISTIC: a genuine new change is not summarized as no-new in the topic check result',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'outcome'});const url='https://evidence.test/robotics';await finishNative(await nativeTick(real),true,[{url,title:'Robotics project'}]);await real.read(identity,goalId);await finishNative(await nativeTick(real),true,[{url,title:'Robotics project',change:{kind:'release',evidence_url:'https://evidence.test/releases/v2'}}] as never);const d=await real.read(identity,goalId);expect(d.changes).toHaveLength(1);expect(d.goal.follow_state?.results.last_outcome).not.toBe('no_new');
});
it('HOLISTIC: future stated API dates do not poison the committed watermark and subsequent real news',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'future-api'});await tick();data[specs[0].source_connection_id]=[item('feed'),{...item('future'),published_at:'2099-01-01T00:00:00Z'}];await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[goalId]);await tick();data[specs[0].source_connection_id]=[item('feed'),{...item('future'),published_at:'2099-01-01T00:00:00Z'},{...item('real-new'),published_at:'2026-10-27T00:00:00Z'}];await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[goalId]);await tick();expect((await membership(goalId))['https://fixture.test/future'].delivery_kind).toBe('unknown_freshness');expect((await membership(goalId))['https://fixture.test/real-new'].delivery_kind).toBe('new_publication');
});
it('HOLISTIC: initial upstream pages combined with commit caps remain baseline and finish',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'pages-cap',items_per_source:2});const port:GoalExecutionPort={async execute(i,g,s,c,signal){if(s.source_connection_id!==specs[0].source_connection_id)return executor.execute(i,g,s,c,signal);const r=await executor.execute(i,g,s,c,signal);const second=c.cursor==='page-2';return {...r,output:{contract_version:'custom_source.handler_output.v1',items:[1,2,3].map(n=>({...item((second?'b':'a')+n),published_at:second?'2026-10-26T00:00:00Z':'2026-10-25T00:00:00Z'}))},cursor:{cursor:second?null:'page-2'}};}};for(let n=0;n<4;n++){await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[goalId]);await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,port);}const rows=(await db.pool.query('SELECT gi.delivery_kind FROM source_goal_items gi WHERE gi.goal_id=$1 AND gi.source_connection_id=$2',[goalId,specs[0].source_connection_id])).rows;expect(rows).toHaveLength(6);expect(rows.every(r=>r.delivery_kind==='baseline')).toBe(true);expect((await cursorOf(goalId)).baseline_window).toBe('complete');
});

it('change deliveries acknowledge exact v2, replay once, deliver v3, paginate and keep old reading, annotations and body',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'delivery-rounds'});const url='https://evidence.test/robotics';
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);
 await finishNative(await nativeTick(real),true,[{url,title:'Robotics stable'}]);await real.read(identity,goalId);const original=(await reading.list(identity,{view:'pending',limit:30,topic:goalId})).items[0];await reading.state(identity,original.source_item_id,{read_status:'read'});
 const before=(await db.pool.query('SELECT title,excerpt,content_hash,reading_body_revision FROM source_items WHERE id=$1',[original.source_item_id])).rows[0];
 const annotationId=randomUUID();await db.pool.query("INSERT INTO reader_annotations(id,space_id,document_type,document_id,annotation_type,quote_text,anchor_json,created_by_user_id,owner_user_id,created_at,updated_at) VALUES($1,$2,'source_item',$3,'highlight','Old quote','{}',$4,$4,now(),now())",[annotationId,identity.spaceId,original.source_item_id,identity.userId]);const annotation=(await db.pool.query('SELECT * FROM reader_annotations WHERE id=$1',[annotationId])).rows[0];
 const change=(e:string)=>[{url,title:'Robotics stable',change:{kind:'release',evidence_url:'https://evidence.test/'+e},topic_judgment:{importance:'important',reason:'A release'}}];
 await finishNative(await nativeTick(real),true,change('v2') as never);let d=await real.read(identity,goalId);expect(d.goal.follow_state?.results).toMatchObject({last_new_items:0,last_new_changes:1,last_outcome:'new_items'});
 let pending=await reading.list(identity,{view:'pending',limit:30,topic:goalId});expect(pending.items).toHaveLength(1);const v2=pending.items[0].topic_change!;expect(v2).toMatchObject({goal_id:goalId,evidence_url:'https://evidence.test/v2'});
 await reading.state(identity,original.source_item_id,{read_status:'read',topic_change_id:v2.id});expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId})).total).toBe(0);
 await finishNative(await nativeTick(real),true,change('v2') as never);await real.read(identity,goalId);expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId})).total).toBe(0);
 await finishNative(await nativeTick(real),true,change('v3') as never);await real.read(identity,goalId);pending=await reading.list(identity,{view:'pending',limit:30,topic:goalId});expect(pending.items).toHaveLength(1);expect(pending.items[0].topic_change?.id).not.toBe(v2.id);
 // An old Reader retry acknowledges only v2, never the newer delivery.
 await reading.state(identity,original.source_item_id,{read_status:'read',topic_change_id:v2.id});expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId})).total).toBe(1);
 const first=await reading.list(identity,{view:'all',limit:1,topic:goalId});expect(first.items[0].topic_change?.evidence_url).toBe('https://evidence.test/v3');expect(first.next_cursor).toBeTruthy();const second=await reading.list(identity,{view:'all',limit:1,topic:goalId,cursor:first.next_cursor!});expect(second.items[0].topic_change?.id).toBe(v2.id);
 expect((await db.pool.query('SELECT title,excerpt,content_hash,reading_body_revision FROM source_items WHERE id=$1',[original.source_item_id])).rows[0]).toEqual(before);expect((await db.pool.query('SELECT read_status FROM source_item_user_states WHERE source_item_id=$1',[original.source_item_id])).rows[0].read_status).toBe('read');
 expect((await db.pool.query('SELECT * FROM reader_annotations WHERE id=$1',[annotationId])).rows[0]).toEqual(annotation);
 await expect(reading.state({...identity,userId:'stranger'},original.source_item_id,{topic_change_id:v2.id,read_status:'read'})).rejects.toMatchObject({statusCode:404});
});

it('Project change deliveries have independent per-user acknowledgements and recheck source summary and Project revocation',async ctx=>{
 if(!db.available)return ctx.skip();const project=randomUUID();await db.pool.query("UPDATE spaces SET type='team' WHERE id=$1",[identity.spaceId]);await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Change project','active',now(),now())",[project,identity.spaceId,identity.userId]);await seedProjectMainlineRoom(db.pool,{space:identity.spaceId,project,owner:identity.userId});await db.pool.query('UPDATE source_goals SET project_id=$2 WHERE id=$1',[goalId,project]);await db.pool.query('UPDATE runs SET project_id=$2 WHERE id=$1',[runId,project]);
 const viewer={...identity,userId:'change-viewer'};await db.pool.query("INSERT INTO users(id,email,display_name,registration_source,status,created_at,updated_at) VALUES($1,'change-viewer@test','Reader','system','active',now(),now())",[viewer.userId]);await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())",[randomUUID(),identity.spaceId,viewer.userId]);await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),identity.spaceId,project,viewer.userId]);
 const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'project-changes'});const url='https://evidence.test/project-robotics';await finishNative(await nativeTick(real),true,[{url,title:'Robotics shared'}]);await real.read(identity,goalId);await finishNative(await nativeTick(real),true,[{url,title:'Robotics shared',change:{kind:'update',evidence_url:'https://evidence.test/project-update'}}] as never);await real.read(identity,goalId);
 const source=(await db.pool.query('SELECT source_connection_id FROM source_goal_bindings WHERE goal_id=$1',[goalId])).rows[0].source_connection_id;
 await db.pool.query("UPDATE source_connections SET visibility='space_shared',consent_json=consent_json||jsonb_build_object('allowed_reader_user_ids',jsonb_build_array($2::text)) WHERE id=$1",[source,viewer.userId]);await db.pool.query("UPDATE source_items SET visibility='space_shared' WHERE connection_id=$1",[source]);
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);const a=(await reading.list(identity,{view:'pending',limit:30,topic:goalId},project)).items.find(i=>i.topic_change)!;const b=(await reading.list(viewer,{view:'pending',limit:30,topic:goalId},project)).items.find(i=>i.topic_change)!;expect(b.topic_change?.id).toBe(a.topic_change?.id);
 await reading.state(identity,a.source_item_id,{topic_change_id:a.topic_change!.id,read_status:'read'},project);expect((await reading.list(viewer,{view:'pending',limit:30,topic:goalId},project)).items.some(i=>i.topic_change?.id===a.topic_change!.id)).toBe(true);
 // Summary-only content admits metadata, never derived change reason/evidence.
 await db.pool.query("UPDATE source_items SET access_level='summary' WHERE id=$1",[a.source_item_id]);expect((await real.read(viewer,goalId)).changes).toEqual([]);expect((await reading.list(viewer,{view:'all',limit:30,topic:goalId},project)).items.some(i=>i.topic_change)).toBe(false);await expect(reading.state(viewer,a.source_item_id,{topic_change_id:b.topic_change!.id,read_status:'read'},project)).rejects.toMatchObject({statusCode:404});
 await db.pool.query("UPDATE source_items SET access_level='full' WHERE id=$1",[a.source_item_id]);await db.pool.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",[project,viewer.userId]);await expect(reading.list(viewer,{view:'all',limit:30,topic:goalId},project)).rejects.toMatchObject({statusCode:404});await expect(reading.state(viewer,a.source_item_id,{topic_change_id:b.topic_change!.id,read_status:'read'},project)).rejects.toMatchObject({statusCode:404});
});

it('a poisoned persisted watermark is recovered before execution with a truthful gap and no lost success history',async ctx=>{
 if(!db.available)return ctx.skip();await version();await service.follow(identity,goalId,{idempotency_key:'recover-watermark'});await tick();const cid=specs[0].source_connection_id;const b=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE goal_id=$1 AND source_connection_id=$2',[goalId,cid])).rows[0];const old=(await db.pool.query('SELECT id,title,reading_body_revision FROM source_items WHERE connection_id=$1',[cid])).rows;
 await db.pool.query("UPDATE source_goal_bindings SET cursor_json=$2,retry_at=NULL WHERE id=$1",[b.id,{watermark:'2099-01-01T00:00:00Z',pending_watermark:'2099-02-01T00:00:00Z',cursor:'poisoned-provider-token',baseline_window:'complete'}]);data[cid]=[item('feed'),{...item('recovered-new'),published_at:'2026-10-27T00:00:00Z'}];const seen:Record<string,unknown>[]=[];const check:GoalExecutionPort={async execute(i,g,s,c,signal){if(s.source_connection_id===cid){seen.push(c);expect(c.watermark).toBe('2026-10-26T00:00:00Z');expect(c.cursor).not.toBe('poisoned-provider-token');}return executor.execute(i,g,s,c,signal);}};
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,check);expect(seen.length).toBeGreaterThan(0);expect((await membership(goalId))['https://fixture.test/recovered-new'].delivery_kind).toBe('new_publication');const after=(await db.pool.query('SELECT cursor_json,gaps_json FROM source_goal_bindings WHERE id=$1',[b.id])).rows[0];expect(after.cursor_json.watermark).toBe('2026-10-27T00:00:00Z');expect(after.gaps_json).toEqual(expect.arrayContaining([expect.objectContaining({reason:'source_watermark_recovered',retired_cursor:expect.objectContaining({watermark:'2099-01-01T00:00:00Z'})})]));expect((await db.pool.query('SELECT id,title,reading_body_revision FROM source_items WHERE id=ANY($1::varchar[])',[old.map(r=>r.id)])).rows).toEqual(old);
});

it('two topics sharing one canonical URL acknowledge changes independently and never mutate stored content',async ctx=>{
 if(!db.available)return ctx.skip();const url='https://evidence.test/two-topic-robotics';const originalGoal=goalId;const one=await nativePlan();await one.real.follow(identity,goalId,{idempotency_key:'topic-one'});await finishNative(await nativeTick(one.real),true,[{url,title:'Robotics common'}]);await one.real.read(identity,goalId);await finishNative(await nativeTick(one.real),true,[{url,title:'Robotics common',change:{kind:'update',evidence_url:'https://evidence.test/shared-change'}}] as never);await one.real.read(identity,goalId);
 const other=await service.create(identity,{intent:'Follow robotics releases',agent_id:'goal-agent',runtime_profile_id:profile});goalId=other.id;await db.pool.query("UPDATE runs SET contract_snapshot_json=$2 WHERE id=$1",[runId,{workflow_input_json:{source_goal:{goal_id:goalId,purpose:'explore'}}}]);await db.pool.query("UPDATE hosts SET name=id WHERE owner_user_id=$1",[identity.userId]);const two=await nativePlan();await two.real.follow(identity,goalId,{idempotency_key:'topic-two'});await finishNative(await nativeTick(two.real),true,[{url,title:'Robotics common'}]);await two.real.read(identity,goalId);await finishNative(await nativeTick(two.real),true,[{url,title:'Robotics common',change:{kind:'update',evidence_url:'https://evidence.test/shared-change'}}] as never);await two.real.read(identity,goalId);
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);const a=(await reading.list(identity,{view:'pending',limit:30,topic:originalGoal})).items.find(i=>i.topic_change)!;const b=(await reading.list(identity,{view:'pending',limit:30,topic:goalId})).items.find(i=>i.topic_change)!;expect(a.source_item_id).toBe(b.source_item_id);expect(a.topic_change?.id).not.toBe(b.topic_change?.id);
 await reading.state(identity,a.source_item_id,{topic_change_id:a.topic_change!.id,read_status:'read'});expect((await reading.list(identity,{view:'pending',limit:30,topic:originalGoal})).items.some(i=>i.topic_change)).toBe(false);expect((await reading.list(identity,{view:'pending',limit:30,topic:goalId})).items.some(i=>i.topic_change)).toBe(true);
 expect((await db.pool.query('SELECT count(*)::int n FROM source_items WHERE source_uri=$1',[url])).rows[0].n).toBe(1);
});

it('change delivery, membership and cursor roll back together; retry consumes accepted output once without another Agent Run',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'change-rollback'});const url='https://evidence.test/transaction-robotics';await finishNative(await nativeTick(real),true,[{url,title:'Robotics atomic'}]);await real.read(identity,goalId);const before=(await db.pool.query('SELECT cursor_json FROM source_goal_bindings WHERE goal_id=$1',[goalId])).rows[0].cursor_json;
 const next=await nativeTick(real);await finishNative(next,true,[{url,title:'Robotics atomic',change:{kind:'update',evidence_url:'https://evidence.test/atomic-v2'}}] as never);const runs=(await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n;
 await db.pool.query("ALTER TABLE source_goal_item_changes ADD CONSTRAINT holistic_change_failure CHECK(evidence_url<>'https://evidence.test/atomic-v2')");try{await expect(real.read(identity,goalId)).rejects.toThrow();expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_item_changes')).rows[0].n).toBe(0);expect((await db.pool.query('SELECT cursor_json FROM source_goal_bindings WHERE goal_id=$1',[goalId])).rows[0].cursor_json).toEqual(before);}finally{await db.pool.query('ALTER TABLE source_goal_item_changes DROP CONSTRAINT holistic_change_failure');}
 await real.read(identity,goalId);await real.read(identity,goalId);expect((await db.pool.query('SELECT count(*)::int n FROM source_goal_item_changes WHERE delivered_at IS NOT NULL')).rows[0].n).toBe(1);expect((await db.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(runs);
});

it('unreadable change prefixes are filtered before the history limit and visible counts use the actual item',async ctx=>{
 if(!db.available)return ctx.skip();const {real}=await nativePlan();await real.follow(identity,goalId,{idempotency_key:'history-window-acl'});const urls=['https://evidence.test/hidden-robotics','https://evidence.test/visible-robotics'];await finishNative(await nativeTick(real),true,urls.map(url=>({url,title:'Robotics history'})));await real.read(identity,goalId);await finishNative(await nativeTick(real),true,urls.map((url,n)=>({url,title:'Robotics history',change:{kind:'update',evidence_url:'https://evidence.test/update-'+n}})) as never);await real.read(identity,goalId);
 const hidden=(await db.pool.query('SELECT id FROM source_items WHERE source_uri=$1',[urls[0]])).rows[0].id;await db.pool.query(`INSERT INTO source_goal_item_changes(id,space_id,goal_id,source_item_id,change_kind,evidence_url,delivery_kind,goal_run_id,binding_id,version_id,selection_status,detected_at,delivered_at) SELECT gen_random_uuid()::text,c.space_id,c.goal_id,c.source_item_id,c.change_kind,'https://evidence.test/hidden-prefix-'||n,c.delivery_kind,c.goal_run_id,c.binding_id,c.version_id,c.selection_status,now()+make_interval(secs=>n),now() FROM source_goal_item_changes c CROSS JOIN generate_series(1,60) n WHERE c.source_item_id=$1`,[hidden]);
 await db.pool.query('UPDATE source_items SET deleted_at=now() WHERE id=$1',[hidden]);const detail=await real.read(identity,goalId);expect(detail.changes).toHaveLength(1);expect(detail.changes[0].evidence_url).toBe('https://evidence.test/update-1');expect(detail.goal.follow_state?.results).toMatchObject({items_total:1,changes_total:1});
 const visible=detail.changes[0];await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=(SELECT source_connection_id FROM source_goal_bindings WHERE goal_id=$1)",[goalId]);
 const unavailable=await real.read(identity,goalId);expect(unavailable.changes).toEqual([]);expect(unavailable.goal.follow_state?.results.changes_total).toBe(0);
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const reading=new ReadingService(db.pool);expect((await reading.list(identity,{view:'all',limit:30,topic:goalId})).items.some(i=>i.topic_change)).toBe(false);await expect(reading.state(identity,visible.source_item_id,{topic_change_id:visible.id,read_status:'read'})).rejects.toMatchObject({statusCode:404});
});

it('future and malformed source dates cannot reach the real connector publication query or history window',()=>{
 const future=new Date(Date.now()+365*86400000).toISOString();
 for(const value of [future,'not-a-date',null,42,'999999-01-01','2026-02-30','1','2026-13-01'])expect(validBusinessTime(value)).toBe(false);
 const old={watermark:future,pending_watermark:future,last_published_at:future,last_collected_at:future,cursor:'valid-page',baseline_window:'open',__goal_window:{since:future,until:new Date().toISOString()}};
 const safe=safeBusinessCursor(old);expect(safe).not.toHaveProperty('watermark');expect(safe).not.toHaveProperty('pending_watermark');expect(safe.cursor).toBe('valid-page');expect(safe.__goal_window).not.toHaveProperty('since');expect(old.watermark).toBe(future);
 const request=new OpenAlexConnectorHandler().buildScanRequest({endpoint_url:null,compiled_query:{}},{...safe,last_published_at:safe.watermark??safe.last_published_at});expect(request.url).not.toContain(future.slice(0,10));expect(new URL(request.url).searchParams.get('filter')).toBeNull();
 expect(safeBusinessCursor({watermark:null,pending_watermark:null,cursor:'pending-page'})).toEqual({watermark:null,pending_watermark:null,cursor:'pending-page'});
 const valid=new Date(Date.now()-86400000).toISOString();expect(safeBusinessCursor({watermark:valid,pending_watermark:valid})).toEqual({watermark:valid,pending_watermark:valid});
});

// ── A followed topic whose Source changed (reported case) ────────────────────
// The owner allowed full text to be saved for materials of the Source a
// following topic uses (an accepted source_material_retention proposal). That
// changed the Source's capture/retention policy, which the binding's authority
// covers, so the next collection refused with source_authority_revoked and the
// binding paused. These tests reproduce it through the real flows and the
// owner's exact re-confirmation.
async function topicWithChangedSource(){
 const n=await nativePlan();
 const spec=((await db.pool.query('SELECT plan_json FROM source_goal_versions WHERE id=$1',[n.v.id])).rows[0].plan_json as {sources:SourceGoalBindingSpec[]}).sources[0];
 // The topic is confirmed while its Source keeps links only (as in the report).
 await db.pool.query(`UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(COALESCE(policy_json,'{}'::jsonb),'{retention_policy}','"metadata_only"') WHERE id=$1`,[spec.source_connection_id]);
 await n.real.preview(identity,goalId,n.v.id,AbortSignal.timeout(10000));let d=await n.real.read(identity,goalId);await finishNative(d.native_runs[0].id);d=await n.real.read(identity,goalId);await freshCheckOnly();
 await n.real.follow(identity,goalId,{version_id:n.v.id,idempotency_key:'changed-source'});
 // A scheduled collection under the confirmed authority succeeds.
 const run=await nativeTick(n.real);await finishNative(run);await n.real.read(identity,goalId);
 const b=(await db.pool.query('SELECT id,source_connection_id,revision,status,fixture_json FROM source_goal_bindings WHERE goal_id=$1',[goalId])).rows[0];
 expect(b.status).toBe('active');
 // The owner allows saved text for one of its materials: the real proposal, accepted.
 const item=(await db.pool.query('SELECT id FROM source_items WHERE connection_id=$1 ORDER BY created_at LIMIT 1',[b.source_connection_id])).rows[0];
 const {proposeMaterialStorage}=await import('../src/modules/sources/materialProcessing/consent.js');
 const proposal=await proposeMaterialStorage(db.pool,identity,item.id);
 const {PgProposalApplyService}=await import('../src/modules/proposals/applyService.js');
 await PgProposalApplyService.fromConfig(config).accept(String(proposal.proposal_id),identity);
 // The next scheduled collection refuses under the changed Source and pauses the binding.
 await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[goalId]);
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));
 return {...n,binding:(await db.pool.query('SELECT id,source_connection_id,revision,status,fixture_json FROM source_goal_bindings WHERE goal_id=$1',[goalId])).rows[0]};
}

it('REPORTED: allowing saved text for a topic\'s Source pauses its binding as a Source change the owner can see and confirm', async ctx=>{
 if(!db.available)return ctx.skip();
 const {real,binding}=await topicWithChangedSource();
 expect(binding).toMatchObject({status:'paused',fixture_json:{collection_error:'source_authority_revoked'}});
 // List and detail say the same: the Source changed and the owner can confirm; not a generic permission request.
 const detail=(await real.read(identity,goalId)).goal.follow_state!;
 const listed=(await real.list(identity)).goals.find(g=>g.id===goalId)!.follow_state!;
 for(const state of [detail,listed]){
  expect(state).toMatchObject({health:'needs_permission',phase:'waiting_for_permission'});
  expect(state.sources[0]).toMatchObject({attention:'source_changed',resolvable_by:'you',error:'source_authority_revoked'});
 }
 const {readBindingReconfirmation,confirmBindingSource}=await import('../src/modules/sources/goals/reconfirm.js');
 const view=await readBindingReconfirmation(db.pool,config,identity,goalId,binding.id);
 expect(view).toMatchObject({resolvable_by:'you',binding_revision:binding.revision,current:{capture_policy:'extract_text',retention_policy:'full_text',source_status:'active',channel_status:'active',uses_credential:false}});
 // Confirmed since scopes are recorded: what changed is named.
 expect(view.changed).toEqual(expect.arrayContaining(['capture_policy','retention_policy','policy']));
 expect(view.related_changes.map(c=>c.kind)).toEqual(['source_material_retention']);
 // A forged or stale confirmation changes nothing.
 await expect(confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision+5,authority:view.authority!})).rejects.toMatchObject({statusCode:409,responseBody:{error:'source_binding_changed'}});
 await expect(confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:'0'.repeat(64)})).rejects.toMatchObject({statusCode:409,responseBody:{error:'source_scope_changed'}});
 expect((await db.pool.query('SELECT status FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].status).toBe('paused');
 // The owner confirms exactly what was shown; a retried request returns the same result.
 const done=await confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:view.authority!});
 expect(done).toMatchObject({status:'active',binding_revision:binding.revision+1});
 expect(await confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:view.authority!})).toMatchObject({status:'active',binding_revision:binding.revision+1});
 const after=(await db.pool.query('SELECT status,revision,fixture_json FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0];
 expect(after.fixture_json).not.toHaveProperty('collection_error');
 expect(after.fixture_json).toMatchObject({authority_sha256:view.authority,reconfirmed_by:identity.userId,authority_scope:{capture_policy:'extract_text',retention_policy:'full_text'}});
 expect((await real.read(identity,goalId)).goal.follow_state!.sources[0]).toMatchObject({health:'ok',attention:null});
 // The next collection runs under the confirmed state instead of refusing again.
 await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE goal_id=$1',[goalId]);
 const next=await nativeTick(real);expect(next).toBeTruthy();
 expect((await db.pool.query('SELECT status,fixture_json FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].fixture_json).not.toHaveProperty('collection_error');
});

it('REPORTED: a binding confirmed before scopes were recorded is explained by what happened to its Source, and nothing re-authorizes it by itself', async ctx=>{
 if(!db.available)return ctx.skip();
 const {real,binding}=await topicWithChangedSource();
 // As the running instance's binding: no recorded scope.
 await db.pool.query(`UPDATE source_goal_bindings SET fixture_json=fixture_json-'authority_scope'-'confirmed_at' WHERE id=$1`,[binding.id]);
 const {readBindingReconfirmation}=await import('../src/modules/sources/goals/reconfirm.js');
 const view=await readBindingReconfirmation(db.pool,config,identity,goalId,binding.id);
 expect(view.changed).toBeNull();
 expect(view.related_changes.map(c=>c.kind)).toEqual(['source_material_retention']);
 // Reading the topic, listing it and ticking leave it paused: no silent refresh of the authority.
 await real.read(identity,goalId);await real.list(identity);
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));
 const still=(await db.pool.query('SELECT status,fixture_json FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0];
 expect(still.status).toBe('paused');expect(still.fixture_json.authority_sha256).toBe(binding.fixture_json.authority_sha256);
 // Resume (meant for a paused topic) does not bypass it either.
 await expect(real.resume(identity,goalId,(await real.read(identity,goalId)).goal.active_version_id!)).resolves.toMatchObject({status:'running'});
 expect((await db.pool.query('SELECT status FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].status).toBe('paused');
});

it('REPORTED: only the topic owner confirms, under every Source gate, and two confirmations apply once', async ctx=>{
 if(!db.available)return ctx.skip();
 const {binding}=await topicWithChangedSource();
 const {readBindingReconfirmation,confirmBindingSource}=await import('../src/modules/sources/goals/reconfirm.js');
 const view=await readBindingReconfirmation(db.pool,config,identity,goalId,binding.id);
 // Concurrent confirmations: one takes effect; the other sees it applied (idempotent) or refuses; never two revisions.
 const both=await Promise.allSettled([1,2].map(()=>confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:view.authority!})));
 expect(both.some(r=>r.status==='fulfilled')).toBe(true);
 expect((await db.pool.query('SELECT revision FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].revision).toBe(binding.revision+1);
});

/** Runs `at` inside the confirmation's own transaction just before it updates the binding (its Source locks held). */
function pausingBeforeBindingUpdate(at:()=>Promise<void>){
 return new Proxy(db.pool,{get(target,prop){
  if(prop==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(c,k){
   if(k==='query')return async(...args:unknown[])=>{if(typeof args[0]==='string'&&args[0].includes("UPDATE source_goal_bindings SET status='active',retry_at=NULL"))await at();return (c.query as (...a:unknown[])=>unknown)(...args);};
   const v=Reflect.get(c,k);return typeof v==='function'?v.bind(c):v;}});};
  const v=Reflect.get(target,prop);return typeof v==='function'?v.bind(target):v;}});
}
const revertSource=`UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','"metadata_only"') WHERE id=$1`;

it('REVIEW T1: a Source change committed before the confirmation reads it is refused (409), the binding stays paused', async ctx=>{
 if(!db.available)return ctx.skip();
 const {binding}=await topicWithChangedSource();
 const {readBindingReconfirmation,confirmBindingSource}=await import('../src/modules/sources/goals/reconfirm.js');
 const view=await readBindingReconfirmation(db.pool,config,identity,goalId,binding.id);
 // The Source write holds its row; the confirmation must wait for it rather than read around it.
 const writer=await db.pool.connect();
 try{
  await writer.query('BEGIN');await writer.query(revertSource,[binding.source_connection_id]);
  let settled=false;const confirming=confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:view.authority!}).finally(()=>{settled=true;});
  confirming.catch(()=>{});
  await waitForLockWaiter(db.pool,{settled:()=>settled});expect(settled).toBe(false);
  await writer.query('COMMIT');
  await expect(confirming).rejects.toMatchObject({statusCode:409,responseBody:{error:'source_scope_changed'}});
 }finally{writer.release();}
 expect((await db.pool.query('SELECT status,revision,fixture_json FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0]).toMatchObject({status:'paused',revision:binding.revision,fixture_json:{authority_sha256:binding.fixture_json.authority_sha256}});
});

it('REVIEW T1: a Source change arriving while the confirmation holds its locks waits for it, then is a new change the next collection refuses', async ctx=>{
 if(!db.available)return ctx.skip();
 const {binding}=await topicWithChangedSource();
 const {readBindingReconfirmation,confirmBindingSource}=await import('../src/modules/sources/goals/reconfirm.js');
 const {goalSourceFingerprint,goalSourceRow}=await import('../src/modules/sources/goals/access.js');
 const view=await readBindingReconfirmation(db.pool,config,identity,goalId,binding.id);
 let change:Promise<unknown>|undefined;let changed=false;
 const pool=pausingBeforeBindingUpdate(async()=>{
  change=db.pool.query(revertSource,[binding.source_connection_id]).then(r=>{changed=true;return r;});
  // The Source write is blocked by the confirmation's Source lock, not committed around it.
  await waitForLockWaiter(db.pool,{settled:()=>changed});expect(changed).toBe(false);
 });
 const done=await confirmBindingSource(pool as never,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:view.authority!});
 expect(done).toMatchObject({status:'active',binding_revision:binding.revision+1});
 await change;expect(changed).toBe(true);
 // What was confirmed is exactly the state that was current when it committed; the later write is a new change.
 const b=(await db.pool.query('SELECT spec_json,fixture_json FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0];
 expect(b.fixture_json.authority_sha256).toBe(view.authority);
 expect(goalSourceFingerprint((await goalSourceRow(db.pool,identity.spaceId,b.spec_json))!)).not.toBe(view.authority);
 await db.pool.query('UPDATE source_goal_bindings SET retry_at=NULL WHERE id=$1',[binding.id]);
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));
 expect((await db.pool.query('SELECT status,fixture_json FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0]).toMatchObject({status:'paused',fixture_json:{collection_error:'source_authority_revoked'}});
 // A repeat of the confirmation that took effect changes nothing.
 await expect(confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:view.authority!})).rejects.toMatchObject({statusCode:409});
 expect((await db.pool.query('SELECT revision FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].revision).toBe(binding.revision+1);
});

it('REPORTED: a Source changed back to its confirmed state is still a decision for the owner, not a dead end', async ctx=>{
 if(!db.available)return ctx.skip();
 const {real,binding}=await topicWithChangedSource();
 await db.pool.query(`UPDATE source_connections SET capture_policy='reference_only',policy_json=jsonb_set(policy_json,'{retention_policy}','"metadata_only"') WHERE id=$1`,[binding.source_connection_id]);
 expect((await real.read(identity,goalId)).goal.follow_state!.sources[0]).toMatchObject({attention:'source_changed',resolvable_by:'you',health:'needs_permission'});
 const {readBindingReconfirmation,confirmBindingSource}=await import('../src/modules/sources/goals/reconfirm.js');
 const view=await readBindingReconfirmation(db.pool,config,identity,goalId,binding.id);
 expect(view).toMatchObject({resolvable_by:'you',changed:[],authority:binding.fixture_json.authority_sha256});
 // Still only by the owner's explicit confirmation; a tick does not resume it.
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,new SourceGoalExecutor(db.pool,config));
 expect((await db.pool.query('SELECT status FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].status).toBe('paused');
 await expect(confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:view.authority!})).resolves.toMatchObject({status:'active'});
});

it('REPORTED: a Source no longer the topic owner\'s is not confirmable here, and says who must act', async ctx=>{
 if(!db.available)return ctx.skip();
 const {real,binding}=await topicWithChangedSource();
 const other=randomUUID();
 await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
 await db.pool.query('UPDATE source_connections SET owner_user_id=$2 WHERE id=$1',[binding.source_connection_id,other]);
 expect((await real.read(identity,goalId)).goal.follow_state!.sources[0]).toMatchObject({attention:'access',resolvable_by:'source_owner'});
 const {readBindingReconfirmation,confirmBindingSource}=await import('../src/modules/sources/goals/reconfirm.js');
 const view=await readBindingReconfirmation(db.pool,config,identity,goalId,binding.id);
 expect(view).toMatchObject({resolvable_by:'source_access',authority:null,current:null});
 await expect(confirmBindingSource(db.pool,config,identity,goalId,binding.id,{binding_revision:binding.revision,authority:'f'.repeat(64)})).rejects.toBeTruthy();
 expect((await db.pool.query('SELECT status FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].status).toBe('paused');
});

it('names a usage limit as a limit, not as a permission request', async ctx=>{
 if(!db.available)return ctx.skip();
 const {real,binding}=await topicWithChangedSource();
 await db.pool.query(`UPDATE source_goal_bindings SET fixture_json=fixture_json||'{"collection_error":"source_native_budget_exhausted"}'::jsonb WHERE id=$1`,[binding.id]);
 const state=(await real.read(identity,goalId)).goal.follow_state!;
 expect(state.sources[0]).toMatchObject({attention:'budget',health:'failing',resolvable_by:'you'});
 expect(state.health).not.toBe('needs_permission');expect(state.phase).toBe('blocked');expect(state.blocked_reason).toBe('source_native_budget_exhausted');
});

it('REPORTED: another member cannot read or confirm someone else\'s topic binding', async ctx=>{
 if(!db.available)return ctx.skip();
 const {binding}=await topicWithChangedSource();
 const other=randomUUID();
 await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Member','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
 await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`,[randomUUID(),identity.spaceId,other]);
 const member={spaceId:identity.spaceId,userId:other};
 const {readBindingReconfirmation,confirmBindingSource}=await import('../src/modules/sources/goals/reconfirm.js');
 await expect(readBindingReconfirmation(db.pool,config,member,goalId,binding.id)).rejects.toMatchObject({statusCode:404});
 await expect(confirmBindingSource(db.pool,config,member,goalId,binding.id,{binding_revision:binding.revision,authority:'f'.repeat(64)})).rejects.toMatchObject({statusCode:404});
 expect((await db.pool.query('SELECT status FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].status).toBe('paused');
});


it('settlement projects only its named native Run and never issues deadline cancellation', async ctx => {
 if(!db.available)return ctx.skip();
 const {real,v}=await nativePlan();
 await real.preview(identity,goalId,v.id,AbortSignal.timeout(10000));
 const native=(await real.read(identity,goalId)).native_runs[0].id;
 await submitted(native);
 await db.pool.query("UPDATE runs SET started_at=now()-interval '1 hour' WHERE id=$1",[native]);
 const {reconcileNativeSearch}=await import('../src/modules/sources/goals/nativeSearchResults.js');
 // Another Run's settlement must not expire or consume this active collection.
 await reconcileNativeSearch(db.pool,config,goalId,randomUUID());
 // Its own nonterminal projection is also a no-op, even past its deadline.
 await reconcileNativeSearch(db.pool,config,goalId,native);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[native])).rows[0].status).toBe('running');
 expect((await db.pool.query("SELECT status FROM source_goal_runs WHERE result_json->>'native_run_id'=$1",[native])).rows[0].status).toBe('queued');
 // The ordinary read/tick path still enforces that deadline outside settlement.
 await reconcileNativeSearch(db.pool,config,goalId);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[native])).rows[0].status).toBe('cancelled');
});

it('material terminal projection cannot recursively cancel an overdue active Run', async ctx => {
 if(!db.available)return ctx.skip();
 const item=await savedMaterialForProcessing();
 const {MaterialItemProcessingService}=await import('../src/modules/sources/materialProcessing/items.js');
 const service=new MaterialItemProcessingService(db.pool,config);
 const operation=await service.start(identity,item.id);
 await runningMaterial(operation.run_id!);
 await db.pool.query("UPDATE runs SET started_at=now()-interval '1 hour' WHERE id=$1",[operation.run_id]);
 await service.reconcileTerminal(operation.run_id!);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[operation.run_id])).rows[0].status).toBe('running');
 await service.reconcile(operation.run_id!);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[operation.run_id])).rows[0].status).toBe('cancelled');
 expect((await db.pool.query('SELECT error_code FROM extraction_jobs WHERE id=$1',[operation.processing_id])).rows[0].error_code).toBe('source_material_deadline_exceeded');
});


it('queues one manual check under concurrent clicks, exposes it, and keeps the automatic cadence',async ctx=>{
 if(!db.available)return ctx.skip();const {v}=await start();
 const schedule=(await db.pool.query("SELECT next_run_at,last_run_at FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1",[goalId])).rows[0];
 const results=await Promise.all([requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id}),requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id})]);
 expect(results.map(r=>r.status).sort()).toEqual(['in_progress','queued']);expect(results[0].job_id).toBe(results[1].job_id);
 expect((await db.pool.query("SELECT count(*)::int n FROM jobs WHERE job_type='source_goal_tick' AND payload_json->>'goal_id'=$1",[goalId])).rows[0].n).toBe(1);
 expect((await db.pool.query("SELECT next_run_at,last_run_at FROM scheduler_tasks WHERE task_type='source_goal_tick' AND task_key=$1",[goalId])).rows[0]).toEqual(schedule);
 expect((await service.read(identity,goalId)).goal.follow_state.collections.queued).toBe(1);
 await Promise.all([enqueueDueSourceGoals(db.pool),enqueueDueSourceGoals(db.pool)]);
 expect((await db.pool.query("SELECT count(*)::int n FROM jobs WHERE job_type='source_goal_tick' AND payload_json->>'goal_id'=$1",[goalId])).rows[0].n).toBe(1);
 expect(await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor,'older-version')).toMatchObject({status:'superseded'});
 data[specs[0].source_connection_id].push(item('manual-new'));
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 expect((await db.pool.query("SELECT title FROM source_items WHERE source_uri='https://fixture.test/manual-new'")).rows[0]?.title).toBe('Robotics manual-new');
});
it('refuses manual checks for stale plans, other owners/Spaces and stopped goals without queuing',async ctx=>{
 if(!db.available)return ctx.skip();const {v}=await start();
 await expect(requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:'stale'})).rejects.toMatchObject({statusCode:409});
 await expect(requestGoalCheck(db.pool,config,{...identity,userId:'not-owner'},goalId,{expected_version_id:v.id})).rejects.toMatchObject({statusCode:404});
 await expect(requestGoalCheck(db.pool,config,{...identity,spaceId:'not-space'},goalId,{expected_version_id:v.id})).rejects.toMatchObject({statusCode:404});
 await service.stop(identity,goalId);await expect(requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id})).rejects.toMatchObject({statusCode:409});
 expect((await db.pool.query("SELECT count(*)::int n FROM jobs WHERE job_type='source_goal_tick'")).rows[0].n).toBe(0);
});
it('manual checks preserve source cooldowns, pauses and authority fingerprints',async ctx=>{
 if(!db.available)return ctx.skip();const {v}=await start();
 await db.pool.query("UPDATE source_goal_bindings SET status='cooldown',retry_at=now()+interval '1 hour' WHERE goal_id=$1",[goalId]);
 await expect(requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id})).rejects.toMatchObject({statusCode:409});
 await db.pool.query("UPDATE source_goal_bindings SET status='active',retry_at=NULL,fixture_json=fixture_json||'{\"authority_sha256\":\"changed\"}'::jsonb WHERE goal_id=$1",[goalId]);
 await expect(requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id})).rejects.toMatchObject({statusCode:409});
 expect((await db.pool.query("SELECT count(*)::int n FROM jobs WHERE job_type='source_goal_tick'")).rows[0].n).toBe(0);
});
it('reuses an asynchronous native collection instead of issuing another tick',async ctx=>{
 if(!db.available)return ctx.skip();const {v}=await start();
 await db.pool.query("UPDATE source_goal_bindings SET status='collecting',lease_until=now()+interval '1 minute' WHERE goal_id=$1",[goalId]);
 expect(await requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id})).toMatchObject({status:'in_progress'});
 expect((await db.pool.query("SELECT count(*)::int n FROM jobs WHERE job_type='source_goal_tick'")).rows[0].n).toBe(0);
});
it('manual legacy following checks reuse the original channel scan without transferring its scheduler',async ctx=>{
 if(!db.available)return ctx.skip();const {mapLegacyGoal}=await import('../src/modules/sources/goals/compatibility.js');
 const mapped=await mapLegacyGoal(db.pool,identity,specs[0].source_channel_id!);
 const result=await requestGoalCheck(db.pool,config,identity,mapped.goal.id,{expected_version_id:null});expect(result.status).toBe('queued');
 expect((await requestGoalCheck(db.pool,config,identity,mapped.goal.id,{expected_version_id:null})).status).toBe('in_progress');
 expect((await db.pool.query("SELECT count(*)::int n FROM extraction_jobs WHERE metadata_json->>'source_channel_id'=$1 AND status='pending'",[specs[0].source_channel_id])).rows[0].n).toBe(1);
 expect((await db.pool.query('SELECT compatibility_json FROM source_goals WHERE id=$1',[mapped.goal.id])).rows[0].compatibility_json.scheduler_owner).toBe('legacy');
});

it('does not let expired binding leases and abandoned audits starve the recovery tick',async ctx=>{
 if(!db.available)return ctx.skip();const {v}=await start();const binding=(await db.pool.query('SELECT id FROM source_goal_bindings WHERE goal_id=$1 LIMIT 1',[goalId])).rows[0];
 await db.pool.query("UPDATE source_goal_bindings SET lease_token='abandoned',lease_until=now()-interval '1 minute' WHERE id=$1",[binding.id]);
 await db.pool.query("INSERT INTO source_goal_runs(id,space_id,goal_id,binding_id,version_id,status) VALUES($1,$2,$3,$4,$5,'running')",[randomUUID(),identity.spaceId,goalId,binding.id,v.id]);
 expect(await requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id})).toMatchObject({status:'queued'});
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 expect((await db.pool.query('SELECT lease_token FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].lease_token).toBeNull();
 expect((await db.pool.query("SELECT count(*)::int n FROM source_goal_runs WHERE binding_id=$1 AND status='running'",[binding.id])).rows[0].n).toBe(0);
});

it('waits for a live native Run but permits reconciliation after its terminal result',async ctx=>{
 if(!db.available)return ctx.skip();const {v}=await start();const binding=(await db.pool.query('SELECT id FROM source_goal_bindings WHERE goal_id=$1 LIMIT 1',[goalId])).rows[0];
 await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[runId]);
 await db.pool.query("UPDATE source_goal_bindings SET status='collecting',lease_until=NULL WHERE id=$1",[binding.id]);
 await db.pool.query("INSERT INTO source_goal_runs(id,space_id,goal_id,binding_id,version_id,status,result_json) VALUES($1,$2,$3,$4,$5,'queued',$6)",[randomUUID(),identity.spaceId,goalId,binding.id,v.id,{native_run_id:runId}]);
 expect(await requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id})).toMatchObject({status:'in_progress'});
 await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[runId]);
 expect(await requestGoalCheck(db.pool,config,identity,goalId,{expected_version_id:v.id})).toMatchObject({status:'queued'});
});


it('marks actual first membership in the latest finished source check, independently of publication freshness',async ctx=>{
 if(!db.available)return ctx.skip();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 data[specs[0].source_connection_id].push(item('arrival'));
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const reading=new ReadingService(db.pool);const list=()=>reading.list(identity,{view:'all',limit:30,topic:goalId,topic_selection:'all'});
 let page=await list();const added=page.items.find(i=>i.title==='Robotics arrival')!;expect(added).toBeDefined();
 const link=added.topics.find(t=>t.goal_id===goalId)!;expect(link.new_in_latest_collection).toBe(true);expect(link.delivery_kind).not.toBe('new_publication');
 expect(page.items.filter(i=>i.title!=='Robotics arrival').every(i=>!i.topics.find(t=>t.goal_id===goalId)?.new_in_latest_collection)).toBe(true);
 // Merely reading/refreshing does not clear a collection fact or set read state.
 expect((await list()).items.find(i=>i.source_item_id===added.source_item_id)?.read_status).toBe('unread');
 const general=await reading.list(identity,{view:'all',limit:30});expect(general.items.find(i=>i.source_item_id===added.source_item_id)?.topics.find(t=>t.goal_id===goalId)?.new_in_latest_collection).toBe(true);
 // A repeated or empty check is not a fresh arrival, even while still unread.
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);page=await list();
 expect(page.items.every(i=>i.topics.every(t=>!t.new_in_latest_collection))).toBe(true);
});
it('retains the last finished arrival while a check is running, but not after a failed latest check',async ctx=>{
 if(!db.available)return ctx.skip();await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);data[specs[0].source_connection_id].push(item('arrival'));
 await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 const binding=(await db.pool.query('SELECT id FROM source_goal_bindings WHERE goal_id=$1 AND source_connection_id=$2',[goalId,specs[0].source_connection_id])).rows[0];
 const version=(await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id;
 // Keep fixture audit boundaries strictly before the JS-millisecond page cutoff.
 await db.pool.query("UPDATE source_goal_runs SET started_at=started_at-interval '1 day',ended_at=ended_at-interval '1 day' WHERE goal_id=$1",[goalId]);
 const pending=randomUUID();await db.pool.query("INSERT INTO source_goal_runs(id,space_id,goal_id,binding_id,version_id,status,started_at) VALUES($1,$2,$3,$4,$5,'running',now()-interval '1 hour')",[pending,identity.spaceId,goalId,binding.id,version]);
 const reading=new ReadingService(db.pool);const arrival=async()=>(await reading.list(identity,{view:'all',limit:30,topic:goalId})).items.find(i=>i.title==='Robotics arrival')!.topics.find(t=>t.goal_id===goalId)!;
 expect((await arrival()).new_in_latest_collection).toBe(true);
 await db.pool.query("UPDATE source_goal_runs SET status='failed',ended_at=now()-interval '59 minutes' WHERE id=$1",[pending]);
 expect((await arrival()).new_in_latest_collection).not.toBe(true);
});
