import {sharedHostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import type {HostDaemonFrame,HostServerFrame} from '@rainver/protocol';
import {runSourceGoalTick} from '../src/modules/sources/goals/worker.js';
import {randomUUID} from 'node:crypto';
import {RuntimeContextPolicyRepository} from '../src/modules/policy/runtimeContextPolicyRepository.js';
/** Explicit, paid/subscription-backed smoke. Never runs in the default suite.
 * Uses a disposable real-PG clone and local control plane, plus the machine's
 * existing runtime-native Codex installation/login. No provider secrets copied. */
import {it,expect,vi} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {FastifyInstance} from 'fastify';
import {useTestDatabase} from './support/testDatabase.js';
import {seedCustomSourceWorld,upsertCustomSourceSpacePolicy} from './support/customSourceWorld.js';
import {seedRun,seedServerHost,seedAgentWithVersion,ensureDefaultRuntimeProfile} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {hostsModule} from '../src/modules/hosts/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {PgHostRepository} from '../src/modules/hosts/repository.js';
import {SourceRecipeCreateService} from '../src/modules/sources/sourceRecipes/recipeCreateService.js';
import {SourceRecipeDryRunService} from '../src/modules/sources/sourceRecipes/recipeDryRunService.js';
import {SourceGoalService} from '../src/modules/sources/goals/service.js';
import {SourceGoalExecutor} from '../src/modules/sources/goals/execution.js';
import {queueSourceGoalAgent} from '../src/modules/sources/goals/agent.js';
import {buildRunOrchestration} from '../src/modules/runs/orchestrationFactory.js';
import {outboundGuard} from '../src/modules/sources/outboundUrlSafety.js';
import {fixtureServerGuard} from './support/outboundGuard.js';
const db=useTestDatabase(import.meta.filename);
it.skipIf(process.env.SOURCE_GOAL_AGENT_SMOKE!=='1')('uses the real existing native Profile route to explore and persist a specialized implementation',async ctx=>{
 if(!db.available)return ctx.skip();if(!new URL(db.connectionUri).pathname.startsWith('/rainver_test_'))throw new Error('Live smoke requires an isolated test database');const root=await mkdtemp(join(tmpdir(),'rainver-goal-live-'));let app:FastifyInstance|undefined,daemon:ChildProcess|undefined,upstream:Server|undefined;let log='';let changed=false;let sourceCleanup:(()=>void)|undefined;
 const identity={spaceId:randomUUID(),userId:randomUUID()},agentId=randomUUID(),versionId=randomUUID();
 try{
  await seedCustomSourceWorld(db.pool,identity);await db.pool.query(`UPDATE spaces SET type='personal' WHERE id=$1`,[identity.spaceId]);await upsertCustomSourceSpacePolicy(db.pool,identity.spaceId,{same_envelope_repair_auto_apply:true,default_capture_policy:'archive_original',default_retention_policy:'full_snapshot'});
  await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',identity.spaceId,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Disposable Source goal acceptance policy'});
  await seedAgentWithVersion(db.pool,{space:identity.spaceId,owner:identity.userId,agent:agentId,version:versionId,systemPrompt:'You are a bounded Source configuration agent. Follow the Run instruction and its granted domain actions.',seedDefaultRuntimeProfile:false});
  upstream=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(changed?{observations:{entries:[{id:'robot-001',heading:'Robotics calibration breakthrough',date:'2026-10-26T00:00:00Z',url:`http://127.0.0.1:${(upstream!.address() as {port:number}).port}/robot-001`}]}}:{observations:[{observationId:'robot-001',headline:'Robotics calibration breakthrough',published:'2026-10-26T00:00:00Z',permalink:`http://127.0.0.1:${(upstream!.address() as {port:number}).port}/robot-001`}]}));});await new Promise<void>(r=>upstream!.listen(0,'127.0.0.1',r));const upstreamUrl=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
  vi.spyOn(outboundGuard,'pin').mockImplementation((url,signal)=>{if(url.origin!==upstreamUrl)throw new Error('Fixture only');return fixtureServerGuard.pin(url,signal);});
  const config={...loadConfig({}),databaseUrl:db.connectionUri,rainverHome:root,artifactStorageRoot:join(root,'artifacts'),logLevel:'error'};
  app=buildModuleServer(config,[hostsModule,runsModule,sourcesModule]);const address=await app.listen({host:'127.0.0.1',port:0});config.frontendUrl=address;config.providerProxyExternalBaseUrl=address;
  const hosts=new PgHostRepository(db.pool);const pairing=await hosts.issuePairingCode(identity.userId,'Disposable native smoke Host');if('statusCode'in pairing)throw new Error(pairing.detail);
  const registered=await hosts.registerViaPairingCode(pairing.pairing_code,{platform:'linux',arch:'x64',daemon_version:'0.4.3',environment_kind:'linux_native'});if('statusCode'in registered)throw new Error(registered.detail);
  const hostRoot=join(root,'daemon');await mkdir(hostRoot,{recursive:true});await writeFile(join(hostRoot,'config.json'),JSON.stringify({server_url:address,host_id:registered.host_id,token:registered.token,trust:'trusted',workspaces:{}}),{mode:0o600});
  daemon=spawn(process.execPath,[resolve('../packages/host-daemon/dist/daemon.js')],{env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',RAINVER_HOST_CONFIG_DIR:hostRoot,RAINVER_HOST_ADAPTER_ROOT:process.env.SOURCE_GOAL_ADAPTER_ROOT??join(homedir(),'.local/share/rainver-host/adapters/current')},stdio:['ignore','pipe','pipe']});daemon.stdout?.on('data',b=>log+=b);daemon.stderr?.on('data',b=>log+=b);
  for(let n=0;n<300;n++){const h=(await db.pool.query('SELECT status,capabilities_json FROM hosts WHERE id=$1',[registered.host_id])).rows[0];if(h.status==='online'&&h.capabilities_json?.installations?.codex_cli)break;await new Promise(r=>setTimeout(r,100));}
  const host=(await db.pool.query('SELECT status,capabilities_json FROM hosts WHERE id=$1',[registered.host_id])).rows[0];expect(host.status,log).toBe('online');expect(host.capabilities_json.installations.codex_cli,log).toBeTruthy();
  const profile=await ensureDefaultRuntimeProfile(db.pool,{agent:agentId,space:identity.spaceId,runtimeKey:'codex_cli',executionHostId:registered.host_id,runtimeInstallation:'own',workspaceMode:'managed'});
  const creator=new SourceRecipeCreateService(db.pool,config);const source=await creator.createSource(identity,{name:'Sensor observations JSON',endpoint_url:upstreamUrl+'/observations',fetch_frequency:'manual',source_type:'rss',capture_policy:'archive_original',retention_policy:'full_snapshot'});
  await new SourceRecipeDryRunService(db.pool,config).dryRunRecipeVersion(identity,source.connection.id,{recipe_version_id:source.recipe_version.id,fixture_content:`<rss><channel><item><guid>seed</guid><title>Robotics</title><link>${upstreamUrl}/seed</link><pubDate>Mon, 26 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`});await creator.activateRecipe(identity,source.connection.id,{recipe_version_id:source.recipe_version.id});
  await db.pool.query(`UPDATE source_connections SET consent_json=consent_json || '{"allow_external_model_egress":true}'::jsonb WHERE id=$1`,[source.connection.id]);await db.pool.query(`INSERT INTO settings(id,scope_type,scope_id,settings_key,settings_json,created_at,updated_at) VALUES(gen_random_uuid(),'space',$1,'retrieval.space.settings','{"external_egress_enabled":true}',now(),now())`,[identity.spaceId]);
  const service=new SourceGoalService(db.pool,config,new SourceGoalExecutor(db.pool,config,fixtureServerGuard));const goal=await service.create(identity,{intent:'Follow robotics observation reports. The permitted Source is a specialized observations JSON endpoint; inspect its real schema and generate a dedicated isolated JavaScript implementation because RSS parsing cannot parse it. Source formatting may evolve; retain semantic IDs and content rather than treating a particular JSON layout as a user requirement. It must read IDs, titles, times and links from the source, never hardcode them. Persist a plan through source.goal.write_version. Do not add sources, request permissions, change model, or do unrelated work.',includes:['robotics'],agent_id:agentId,runtime_profile_id:profile,budget:{agent_attempts:1,repair_attempts:2,requests_per_run:4,items_per_source:20,interval_seconds:86400}});
  let queued:{run_id:string},result:{status:string};
  if(process.env.SOURCE_GOAL_CAPTURED_PLAN){const captured=JSON.parse(await readFile(process.env.SOURCE_GOAL_CAPTURED_PLAN,'utf8'));const fixtureRun=randomUUID();await seedRun(db.pool,{id:fixtureRun,space:identity.spaceId,owner:identity.userId,agent:agentId,version:versionId,existingAgent:true});await db.pool.query('UPDATE runs SET instructed_by_user_id=$2,contract_snapshot_json=$3 WHERE id=$1',[fixtureRun,identity.userId,{workflow_input_json:{source_goal:{goal_id:goal.id,purpose:'explore'}}}]);const plan={...captured.generated_plan,sources:captured.generated_plan.sources.map((s:Record<string,unknown>)=>({...s,source_connection_id:source.connection.id,source_channel_id:source.connection.source_channel_id}))};await service.writeVersion(identity,{goal_id:goal.id,expected_revision:0,plan},fixtureRun);queued={run_id:fixtureRun};result={status:'captured_real_generation_replay'};}
  else{queued=await queueSourceGoalAgent(db.pool,config,identity,goal.id,'explore');result=await buildRunOrchestration(config).orchestration.executeRun({run_id:queued.run_id,space_id:identity.spaceId,worker_id:'source-goal-live-smoke',command_source:'internal'});}
  const read=await service.read(identity,goal.id);const report={status:result.status,error:(result as {error_code?:string}).error_code??null,error_detail:(result as {error?:string}).error??null,version_count:read.versions.length,generated_plan:read.versions[0]?.plan_json,run_usage:(await db.pool.query('SELECT model,input_tokens,output_tokens,total_tokens,estimated_cost_usd,cost_accuracy FROM token_usage_events WHERE run_id=$1',[queued.run_id])).rows,steps:(await db.pool.query('SELECT step_type,status,error_type,error_message FROM run_steps WHERE run_id=$1 ORDER BY started_at',[queued.run_id])).rows,route:'codex_cli/runtime_native/own, inherited native model default',model_changed:false,provider_key_copied:false,model_runs_limit:process.env.SOURCE_GOAL_CAPTURED_PLAN?1:2,prior_model_runs:Number(process.env.SOURCE_GOAL_PRIOR_MODEL_RUNS??0),generation_replay:Boolean(process.env.SOURCE_GOAL_CAPTURED_PLAN),explore_duration_seconds:180,upstream:'local fixture',daemon_tail:log.slice(-3000)};
  if(process.env.SOURCE_GOAL_AGENT_EVIDENCE)await writeFile(process.env.SOURCE_GOAL_AGENT_EVIDENCE,JSON.stringify(report,null,2));
  expect(read.versions.length,JSON.stringify(report)).toBeGreaterThan(0);expect(read.versions[0].plan_json.sources[0].implementation.kind).toBe('isolated');
  const sourceHost=randomUUID();await seedServerHost(db.pool,{id:sourceHost});await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"sources_execution":"isolated-v1"}'::jsonb WHERE id=$1`,[sourceHost]);
  const moduleUrl=new URL('../../packages/host-daemon/dist/sourceExecutionChannel.js',import.meta.url).href;const {SourceExecutionChannel}=await import(moduleUrl);
  const channel=new SourceExecutionChannel({root:join(root,'source-os'),node:process.execPath,maxConcurrent:1,enabled:true,bwrap:process.env.SOURCE_EXECUTION_BWRAP,cgroupRoot:process.env.SOURCE_EXECUTION_CGROUP_ROOT},(frame:HostDaemonFrame)=>{if(frame.type==='source_request')sharedHostConnectionRegistry.receiveSourceRequest(sourceHost,frame.execution_id,frame.request);if(frame.type==='source_result')sharedHostConnectionRegistry.receiveSourceResult(sourceHost,frame.execution_id,frame.result);});
  const sink={send:(frame:HostServerFrame)=>channel.handle(frame),close:()=>channel.disconnect()};sharedHostConnectionRegistry.registerConnection(sourceHost,sink,true);sourceCleanup=()=>{sharedHostConnectionRegistry.unregisterConnection(sourceHost,sink,true);channel.disconnect();};
  const preview=await service.preview(identity,goal.id,read.versions[0].id,AbortSignal.timeout(30000));Object.assign(report,{preview});if(process.env.SOURCE_GOAL_AGENT_EVIDENCE)await writeFile(process.env.SOURCE_GOAL_AGENT_EVIDENCE,JSON.stringify(report,null,2));expect(preview.complete,JSON.stringify(preview)).toBe(true);
  await service.start(identity,goal.id,{version_id:read.versions[0].id,preview_id:preview.id,idempotency_key:'live-confirmed'});await runSourceGoalTick(db.pool,config,goal.id,identity.spaceId);
  changed=true;await runSourceGoalTick(db.pool,config,goal.id,identity.spaceId);const binding=(await db.pool.query('SELECT * FROM source_goal_bindings WHERE goal_id=$1',[goal.id])).rows[0];expect(binding.status).toBe('repair_required');
  await db.pool.query(`UPDATE source_goal_bindings SET retry_at=now()-interval '1 second' WHERE id=$1`,[binding.id]);const repair=await queueSourceGoalAgent(db.pool,config,identity,goal.id,'repair',binding.id);const repairResult=await buildRunOrchestration(config).orchestration.executeRun({run_id:repair.run_id,space_id:identity.spaceId,worker_id:'source-goal-live-smoke',command_source:'internal'});
  Object.assign(report,{repair_status:repairResult.status,repair_usage:(await db.pool.query('SELECT model,input_tokens,output_tokens,total_tokens,estimated_cost_usd,cost_accuracy FROM token_usage_events WHERE run_id=$1',[repair.run_id])).rows,repair_records:(await db.pool.query('SELECT status,base_revision,candidate_json,validation_json FROM source_goal_repairs WHERE binding_id=$1',[binding.id])).rows});if(process.env.SOURCE_GOAL_AGENT_EVIDENCE)await writeFile(process.env.SOURCE_GOAL_AGENT_EVIDENCE,JSON.stringify(report,null,2));expect((await db.pool.query('SELECT revision FROM source_goal_bindings WHERE id=$1',[binding.id])).rows[0].revision).toBe(1);

 }finally{sourceCleanup?.();vi.restoreAllMocks();daemon?.kill('SIGTERM');await app?.close();if(upstream)await new Promise<void>(r=>upstream!.close(()=>r()));await rm(root,{recursive:true,force:true});}
},420000);
