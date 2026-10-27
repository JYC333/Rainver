import {registerSourceGoalActions} from '../src/modules/sources/goals/actions.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import type {SystemActionExecutor} from '../src/modules/systemActions/gateway.js';
import {sharedHostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import type {HostServerFrame,HostDaemonFrame} from '@rainver/protocol';
import {createServer,type Server} from 'node:http';
import {SourceGoalExecutor} from '../src/modules/sources/goals/execution.js';
import {fixtureServerGuard} from './support/outboundGuard.js';
import {requireGoal} from '../src/modules/sources/goals/access.js';
import {sourceQuotaGroup} from '../src/modules/sources/sourceRequestQuota.js';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
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
beforeEach(async()=>{
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
async function start(){const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);expect(p,JSON.stringify(p.contributions)).toMatchObject({complete:true});await service.start(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'first'});return {v,p};}
it('keeps Personal ownership, rejects cross-Space reads and stale/version-forged Agent writes',async ctx=>{
 if(!db.available)return ctx.skip();expect((await service.read(identity,goalId)).goal.project_id).toBeNull();
 await expect(service.read({...identity,spaceId:'other'},goalId)).rejects.toMatchObject({statusCode:404});
 await expect(service.writeVersion(identity,{goal_id:goalId,expected_revision:0,plan:plan()},randomUUID())).rejects.toMatchObject({statusCode:403});
 await version();await expect(version()).rejects.toMatchObject({statusCode:409});
});
it('reports partial/empty preview without treating HTTP or missing content as success',async ctx=>{
 if(!db.available)return ctx.skip();data[specs[1].source_connection_id]=[];const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);expect(p.complete).toBe(false);await expect(service.start(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'bad'})).rejects.toMatchObject({statusCode:409});
});
it('serializes duplicate starts into one existing scheduler and rejects expired previews',async ctx=>{
 if(!db.available)return ctx.skip();const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);
 await db.pool.query(`UPDATE source_goal_previews SET expires_at=now()-interval '1 second' WHERE id=$1`,[p.id]);await expect(service.start(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'first'})).rejects.toMatchObject({statusCode:409});
 const fresh=await service.preview(identity,goalId,v.id,new AbortController().signal);const a={version_id:v.id,preview_id:fresh.id,idempotency_key:'same'};const results=await Promise.all([service.start(identity,goalId,a),service.start(identity,goalId,a)]);expect(results.map(x=>x.status)).toEqual(['running','running']);
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

it('invalidates preview on source changes and refuses revoked membership before dispatch',async ctx=>{
 if(!db.available)return ctx.skip();const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);
 await db.pool.query(`UPDATE source_channels SET endpoint_url='https://fixture.test/changed' WHERE id=$1`,[specs[0].source_channel_id]);
 await expect(service.start(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'changed'})).rejects.toMatchObject({statusCode:409});
 expect((await db.pool.query('SELECT count(*)::int AS n FROM source_goal_bindings')).rows[0].n).toBe(0);
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
 const p=await service.preview(identity,goalId,v.id,new AbortController().signal);await service.start(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'replacement'});expect((await service.read(identity,goalId)).goal.active_version_id).toBe(v.id);
 expect((await db.pool.query(`SELECT count(*)::int AS n FROM scheduler_tasks WHERE task_key=$1 AND task_type='source_goal_tick'`,[goalId])).rows[0].n).toBe(1);
});
it('filters ordinary irrelevant rows independently, without triggering AI repair',async ctx=>{
 if(!db.available)return ctx.skip();await start();data[specs[0].source_connection_id]=[item('wanted'),{...item('unrelated'),title:'Weather today'}];await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);
 expect((await db.pool.query(`SELECT count(*)::int AS n FROM source_items WHERE source_external_id='unrelated'`)).rows[0].n).toBe(0);expect((await db.pool.query('SELECT repair_attempts,status FROM source_goal_bindings')).rows.every(r=>r.repair_attempts===0&&r.status==='active')).toBe(true);
 data[specs[0].source_connection_id]=[{...item('unrelated'),title:'Weather today'}];await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect((await db.pool.query(`SELECT status FROM source_goal_runs WHERE binding_id=(SELECT id FROM source_goal_bindings WHERE source_connection_id=$1) ORDER BY started_at DESC LIMIT 1`,[specs[0].source_connection_id])).rows[0].status).toBe('insufficient');
});
it('allows a single Source preview/start and rejects missing preview contributions without a 500',async ctx=>{
 if(!db.available)return ctx.skip();specs=specs.slice(0,1);const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);expect(p.complete).toBe(true);
 await db.pool.query(`UPDATE source_goal_previews SET result_json=jsonb_set(result_json,'{contributions}','[]') WHERE id=$1`,[p.id]);await expect(service.start(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'bad'})).rejects.toMatchObject({statusCode:409});
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
 if(!db.available)return ctx.skip();data[specs[0].source_connection_id]=[{...item('private-body'),excerpt:'UNRETAINED_BODY_MARKER',metadata:{body:'UNRETAINED_BODY_MARKER'}}];const v=await version();const p=await service.preview(identity,goalId,v.id,new AbortController().signal);expect(JSON.stringify(p)).not.toContain('UNRETAINED_BODY_MARKER');expect(JSON.stringify(p)).not.toContain('body_base64');await service.start(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'retention'});await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);expect(JSON.stringify(await service.read(identity,goalId))).not.toContain('UNRETAINED_BODY_MARKER');
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
 if(!db.available)return ctx.skip();const old=await start();await runSourceGoalTick(db.pool,config,goalId,identity.spaceId,executor);const history=(await db.pool.query('SELECT id,title FROM source_items ORDER BY id')).rows;
 await db.pool.query(`UPDATE source_goal_bindings SET cursor_json=$2,gaps_json=$3 WHERE goal_id=$1`,[goalId,{watermark:'2026-10-26T00:00:00Z',token:'OLD_FORMAT',pending_watermark:'2099-01-01T00:00:00Z',remaining_count:1},JSON.stringify([{from:{watermark:'2026-10-25T00:00:00Z',page:'OLD'},cursor:{token:'OLD'},at:'2026-10-26T00:00:00Z',reason:'outage',recoverable:true}])]);
 const v=await service.writeVersion(identity,{goal_id:goalId,expected_revision:1,plan:plan()},runId);await expect(service.start(identity,goalId,{version_id:v.id,preview_id:old.p.id,idempotency_key:'stale'})).rejects.toMatchObject({statusCode:409});const p=await service.preview(identity,goalId,v.id,new AbortController().signal);await service.start(identity,goalId,{version_id:v.id,preview_id:p.id,idempotency_key:'new-version'});
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
 await expect(service.start(identity,goalId,{version_id:v.id,preview_id:first.p.id,idempotency_key:'old'})).rejects.toMatchObject({statusCode:409});const fresh=await service.preview(identity,goalId,v.id,AbortSignal.timeout(10000));expect((await db.pool.query('SELECT active_version_id FROM source_goals WHERE id=$1',[goalId])).rows[0].active_version_id).toBe(first.v.id);await service.start(identity,goalId,{version_id:v.id,preview_id:fresh.id,idempotency_key:'explicit-confirm'});
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
