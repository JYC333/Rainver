import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {evolutionModule} from '../src/modules/evolution/index.js';
import {promptsModule} from '../src/modules/prompts/index.js';
import {policyModule} from '../src/modules/policy/index.js';
import {runtimeContextModule} from '../src/modules/runtimeContext/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {lockEvolutionAssets} from '../src/modules/evolution/assetLocks.js';
import {EvolutionRepository} from '../src/modules/evolution/repository.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {runBuiltInSeeds} from '../src/db/seeds.js';

const db=useTestDatabase(import.meta.filename);
const CATALOG_ROOT=join(process.cwd(),'..','catalog');
let team:string,other:string,owner:string,member:string,outsider:string,app:ReturnType<typeof buildModuleServer>;
const as=(spaceId:string,userId:string)=>__setAuthIdentityForTests({spaceId,userId});
const call=(id:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
const rest=(method:'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:object,key:string|null=randomUUID())=>app.inject({method,url,...(payload?{payload}:{}),headers:key?{'idempotency-key':key}:{}});
const one=async(sql:string,params:unknown[])=>(await db.pool.query(sql,params)).rows[0];
const promptContent={schema_version:'prompt_asset.v1',prompt_type:'text',template:'Hello {name}'};

beforeEach(async()=>{
 // Built-in Evolution strategies come from the boot seed, not migrations.
 await runBuiltInSeeds(db.pool,{info:()=>{}},CATALOG_ROOT);
 team=randomUUID();other=randomUUID();owner=randomUUID();member=randomUUID();outsider=randomUUID();
 for(const s of [team,other])await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'S','team',now(),now())",[s]);
 await seedSpaceMember(db.pool,{space:team,user:owner,role:'owner'});
 await seedSpaceMember(db.pool,{space:team,user:member,role:'member'});
 await seedSpaceMember(db.pool,{space:other,user:outsider,role:'owner'});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:`/tmp/rainver-evolution-asset-ops-${process.pid}`}),[evolutionModule,promptsModule,policyModule,runtimeContextModule,systemActionsModule]);
 as(team,owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

async function createAsset(input:object={asset_type:'agent_config',asset_key:`config.${randomUUID()}`,display_name:'Flow'}){
 const res=await rest('POST','/api/v1/evolution/assets',input);expect(res.statusCode,res.body).toBe(201);return res.json().data.asset_id as string;
}
const workflow={instructions:'Review carefully'};

it('creates assets and moves draft versions forward under strict keyed commands with identity receipts and live replay authority',async()=>{
 const key=randomUUID(),input={asset_type:'prompt_template',asset_key:'team.greeting',display_name:'Greeting',metadata_json:{prompt_type:'text'}};
 const created=await rest('POST','/api/v1/evolution/assets',input,key);expect(created.statusCode,created.body).toBe(201);
 expect(Object.keys(created.json().data).sort()).toEqual(['asset_id','space_id']);
 const asset=created.json().data.asset_id;
 expect((await call('evolution.asset.create',input,key)).json().data).toEqual(created.json().data);
 expect((await call('evolution.asset.create',{...input,display_name:'Other'},key)).statusCode).toBe(422);
 const dup=await call('evolution.asset.create',input);expect(dup.statusCode).toBe(409);expect(dup.json().error.message).toBe('asset_key is already in use in this space');
 for(const bad of [{...input,asset_type:'skill'},{...input,space_id:other},{...input,asset_key:''}])expect((await call('evolution.asset.create',bad)).statusCode).toBe(422);
 // Prompt versions through the prompt facade; the body may not restate the URL's key.
 expect((await rest('POST','/api/v1/prompts/assets/team.greeting/versions',{asset_key:'x',content_json:promptContent})).statusCode).toBe(422);
 const version=await rest('POST','/api/v1/prompts/assets/team.greeting/versions',{content_json:promptContent});expect(version.statusCode,version.body).toBe(201);
 const versionId=version.json().data.version_id;expect(version.json().data).toEqual({space_id:team,asset_key:'team.greeting',version_id:versionId});
 const edited=await rest('PATCH',`/api/v1/evolution/assets/${asset}/versions/${versionId}`,{content_json:{...promptContent,template:'Hi {name}'}});expect(edited.statusCode,edited.body).toBe(200);
 expect((await one('SELECT content_json->>\'template\' AS t,status FROM evolvable_asset_versions WHERE id=$1',[versionId]))).toEqual({t:'Hi {name}',status:'draft'});
 const approve=await call('evolution.asset.version.transition',{asset_id:asset,version_id:versionId,status:'approved'});expect(approve.statusCode).toBe(422);
 expect(approve.json().error.message).toContain('promotion proposal flow');
 expect((await rest('POST',`/api/v1/evolution/assets/${asset}/versions/${versionId}/transition`,{status:'candidate'})).statusCode).toBe(200);
 const late=await call('evolution.asset.version.update',{asset_id:asset,version_id:versionId,content_json:promptContent});expect(late.statusCode).toBe(422);
 // Render preview and resolution are queries: no key, nothing written.
 const preview=await app.inject({method:'POST',url:'/api/v1/prompts/assets/team.greeting/render-preview',payload:{version_id:versionId,variables:{name:'Ada'}}});
 expect(preview.statusCode,preview.body).toBe(200);expect(preview.json().data).toMatchObject({rendered_text:'Hi Ada',validation_errors:[]});
 // A member without Space write authority over the asset scope is hidden; a former owner's replay too.
 as(team,member);expect((await call('evolution.asset.version.transition',{asset_id:asset,version_id:versionId,status:'testing'})).statusCode).toBe(404);
 as(team,outsider);expect((await call('evolution.asset.create',input,key)).statusCode).toBe(404);
 as(team,owner);await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[team,owner]);
 expect((await call('evolution.asset.create',input,key)).statusCode).toBe(404);
});

it('pins only an approved version, archives by exact scope, and serializes on the canonical asset lock until commit',async()=>{
 const asset=await createAsset();
 const made=await call('evolution.asset.version.create',{asset_id:asset,content_json:workflow});expect(made.statusCode,made.body).toBe(201);
 const version=made.json().data.version_id;
 const early=await rest('PUT',`/api/v1/evolution/assets/${asset}/pins/space/${team}`,{version_id:version});expect(early.statusCode).toBe(422);expect(early.json().error.message).toBe('Only an approved version can be pinned');
 await db.pool.query("UPDATE evolvable_asset_versions SET status='approved' WHERE id=$1",[version]);
 // A promotion/rollback holding the asset lock delays the pin until it commits.
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');await lockEvolutionAssets(holder,[asset]);
  const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const pending=rest('PUT',`/api/v1/evolution/assets/${asset}/pins/space/${team}`,{version_id:version,reason:'baseline'});
  await waitForBlockedBy(db.pool,pid);
  await holder.query("UPDATE evolvable_asset_versions SET status='deprecated' WHERE id=$1",[version]);
  await holder.query('COMMIT');
  const res=await pending;expect(res.statusCode).toBe(422);expect(res.json().error.message).toBe('Only an approved version can be pinned');
 }finally{holder.release();}
 await db.pool.query("UPDATE evolvable_asset_versions SET status='approved' WHERE id=$1",[version]);
 const pinned=await rest('PUT',`/api/v1/evolution/assets/${asset}/pins/space/${team}`,{version_id:version});expect(pinned.statusCode,pinned.body).toBe(200);
 expect(pinned.json().data).toMatchObject({space_id:team,asset_id:asset,scope_type:'space',scope_id:team});
 expect((await rest('PUT',`/api/v1/evolution/assets/${asset}/pins/system/x`,{version_id:version})).statusCode).toBe(422);
 const removed=await rest('DELETE',`/api/v1/evolution/assets/${asset}/pins/space/${team}`);expect(removed.statusCode,removed.body).toBe(200);
 expect((await one("SELECT count(*)::int n FROM evolvable_asset_pins WHERE asset_id=$1 AND status='active'",[asset])).n).toBe(0);
 const resolved=await app.inject({method:'POST',url:`/api/v1/evolution/assets/${asset}/resolve`,payload:{}});expect(resolved.statusCode,resolved.body).toBe(200);
 expect(resolved.json().data).toMatchObject({assetId:asset,versionId:version});
});

it('records evaluations, files the promotion Proposal for the canonical applier, and bundles pending Proposals once',async()=>{
 const asset=await createAsset();
 const base=(await call('evolution.asset.version.create',{asset_id:asset,content_json:workflow})).json().data.version_id;
 await db.pool.query("UPDATE evolvable_asset_versions SET status='approved' WHERE id=$1",[base]);
 const candidate=(await call('evolution.asset.version.create',{asset_id:asset,parent_version_id:base,content_json:{instructions:'Review more carefully'}})).json().data.version_id;
 const caseRes=await rest('POST',`/api/v1/evolution/assets/${asset}/evaluation-cases`,{name:'Case',verification_recipe_json:{checks:[{type:'non_empty',path:'summary'}]},baseline_version_id:base,baseline_output_json:{summary:'ok'}});
 expect(caseRes.statusCode,caseRes.body).toBe(201);expect(Object.keys(caseRes.json().data).sort()).toEqual(['asset_id','case_id','space_id']);
 const draftEval=await call('evolution.asset.evaluation.record',{asset_id:asset,version_id:candidate,eval_suite_ref:{kind:'manual'},evaluator_version:'manual.v1'});
 expect(draftEval.statusCode).toBe(422);expect(draftEval.json().error.message).toBe('Only a candidate or testing version can record an evaluation run');
 await call('evolution.asset.version.transition',{asset_id:asset,version_id:candidate,status:'candidate'});
 // The Evaluation Engine pass is only the Job's to write.
 expect((await call('evolution.asset.evaluation.record',{asset_id:asset,version_id:candidate,eval_suite_ref:{kind:'evaluation_case'},evaluator_version:'verification_engine.v1',status:'passed'})).statusCode).toBe(404);
 const evaluation=await rest('POST',`/api/v1/evolution/assets/${asset}/versions/${candidate}/evaluate`,{eval_suite_ref:{kind:'manual'},evaluator_version:'manual.v1',status:'passed'});
 expect(evaluation.statusCode,evaluation.body).toBe(201);
 expect((await one('SELECT status FROM evolvable_asset_versions WHERE id=$1',[candidate])).status).toBe('testing');
 const hiddenRun=await call('evolution.asset.evaluation.execute',{asset_id:asset,version_id:candidate,case_id:caseRes.json().data.case_id,candidate_run_id:randomUUID()});expect(hiddenRun.statusCode).toBe(404);
 const key=randomUUID(),propose={target_scope_type:'space',evaluation_run_ids:[evaluation.json().data.evaluation_run_id],reason:'Better'};
 const proposed=await rest('POST',`/api/v1/evolution/assets/${asset}/versions/${candidate}/promote-proposal`,propose,key);expect(proposed.statusCode,proposed.body).toBe(201);
 const proposal=proposed.json().data.proposal_id;expect(proposed.json().data).toEqual({space_id:team,proposal_id:proposal,status:'pending',proposal_type:'evolvable_asset_version_promote'});
 expect((await rest('POST',`/api/v1/evolution/assets/${asset}/versions/${candidate}/promote-proposal`,propose,key)).json().data.proposal_id).toBe(proposal);
 expect((await one("SELECT count(*)::int n FROM proposals WHERE space_id=$1 AND proposal_type='evolvable_asset_version_promote'",[team])).n).toBe(1);
 // The version itself is untouched: only the canonical applier promotes.
 expect((await one('SELECT status FROM evolvable_asset_versions WHERE id=$1',[candidate])).status).toBe('testing');
 const bundled=await rest('POST','/api/v1/evolution/bundles',{title:'Review',proposal_ids:[proposal]});expect(bundled.statusCode,bundled.body).toBe(201);
 expect((await one('SELECT status FROM evolution_bundles WHERE id=$1',[bundled.json().data.bundle_id])).status).toBe('pending_review');
 const twice=await call('evolution.bundle.create',{title:'Again',proposal_ids:[proposal]});expect(twice.statusCode).toBe(409);
 expect((await call('evolution.bundle.create',{title:'None',proposal_ids:[]})).statusCode).toBe(422);
 as(team,outsider);expect((await call('evolution.bundle.create',{title:'X',proposal_ids:[proposal]})).statusCode).toBe(404);
});

async function seedAgent(space:string,user:string){
 const agent=randomUUID(),version=randomUUID();
 await db.pool.query(`INSERT INTO agents(id,space_id,owner_user_id,name,status,created_at,updated_at,visibility) VALUES($1,$2,$3,'Evolver','active',now(),now(),'space_shared')`,[agent,space,user]);
 await db.pool.query(`INSERT INTO agent_versions(id,agent_id,space_id,version_label,system_prompt,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,created_at) VALUES($1,$2,$3,'v1','Review.','{}','{}','[]','{}',now())`,[version,agent,space]);
 await db.pool.query('UPDATE agents SET current_version_id=$2 WHERE id=$1',[agent,version]);
 await db.pool.query(`INSERT INTO agent_runtime_profiles(id,space_id,agent_id,name,runtime_key,backend_mode,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at) VALUES($1,$2,$3,'Default','opencode','runtime_native','{}','{}',true,true,now(),now())`,[randomUUID(),space,agent]);
 return agent;
}

it('queues the Evolution Run with its Job instead of executing it, and keeps a not-selected decision recorded',async()=>{
 const agent=await seedAgent(team,owner),target=randomUUID();
 await db.pool.query(`INSERT INTO evolution_targets(id,space_id,target_type,risk_level,status,enabled,engine_policy_json,metadata_json,created_at,updated_at) VALUES($1,$2,'system','medium','active',true,'{"max_strategy_risk":"medium"}',$3,now(),now())`,[target,team,JSON.stringify({agent_id:agent})]);
 await db.pool.query(`INSERT INTO evolution_signals(id,space_id,target_id,signal_type,source_type,severity,summary,payload_json,created_at) VALUES($1,$2,$3,'runtime_failure','manual','medium','Failed','{}',now())`,[randomUUID(),team,target]);
 const key=randomUUID(),res=await rest('POST',`/api/v1/evolution/targets/${target}/run`,{mode:'dry_run'},key);expect(res.statusCode,res.body).toBe(202);
 const out=res.json().data;expect(out).toMatchObject({space_id:team,status:'queued',target_id:target,selected_strategy_key:'repair.runtime_failure'});
 expect(await one('SELECT status,run_type FROM runs WHERE id=$1',[out.run_id])).toEqual({status:'queued',run_type:'evolution'});
 expect(await one("SELECT job_type,status,payload_json->>'run_id' AS run FROM jobs WHERE id=$1",[out.job_id])).toEqual({job_type:'agent_run',status:'pending',run:out.run_id});
 expect((await rest('POST',`/api/v1/evolution/targets/${target}/run`,{mode:'dry_run'},key)).json().data).toEqual(out);
 expect((await call('evolution.target.run',{target_id:target,mode:'live'})).statusCode).toBe(422);
 const bare=randomUUID();await db.pool.query(`INSERT INTO agents(id,space_id,owner_user_id,name,status,created_at,updated_at,visibility) VALUES($1,$2,$3,'Bare','active',now(),now(),'space_shared')`,[bare,team,owner]);
 const noVersion=await call('evolution.target.run',{target_id:target,agent_id:bare});expect(noVersion.statusCode).toBe(422);expect(noVersion.json().error.message).toContain('has no current version');
 // No active strategy: the receipt points at the recorded selector decision; no Run or Job exists for it.
 const before=(await one("SELECT count(*)::int n FROM runs WHERE space_id=$1",[team])).n;
 const active=(await db.pool.query<{id:string}>("UPDATE evolution_strategy_assets SET status='archived' WHERE status='active' RETURNING id")).rows.map(r=>r.id);
 try{
  const miss=await call('evolution.target.run',{target_id:target});expect(miss.statusCode,miss.body).toBe(202);
  expect(miss.json().data).toMatchObject({status:'not_selected',target_id:target});
  expect(await one('SELECT run_id,target_id FROM evolution_selector_decisions WHERE id=$1',[miss.json().data.selector_decision_id])).toEqual({run_id:null,target_id:target});
  expect((await one("SELECT count(*)::int n FROM runs WHERE space_id=$1",[team])).n).toBe(before);
 }finally{await db.pool.query("UPDATE evolution_strategy_assets SET status='active' WHERE id=ANY($1::varchar[])",[active]);}
 as(team,outsider);expect((await call('evolution.target.run',{target_id:target})).statusCode).toBe(404);
});

it.each([['disable',{enabled:false}],['archive',{status:'archived'}]] as const)('holds the target from its first runnable read to commit, so a concurrent %s is seen or waits for the committed Run, decision and Job',async(_label,change)=>{
 const agent=await seedAgent(team,owner),target=randomUUID(),identity={spaceId:team,userId:owner};
 await db.pool.query(`INSERT INTO evolution_targets(id,space_id,target_type,risk_level,status,enabled,engine_policy_json,metadata_json,created_at,updated_at) VALUES($1,$2,'system','medium','active',true,'{"max_strategy_risk":"medium"}',$3,now(),now())`,[target,team,JSON.stringify({agent_id:agent})]);
 await db.pool.query(`INSERT INTO evolution_signals(id,space_id,target_id,signal_type,source_type,severity,summary,payload_json,created_at) VALUES($1,$2,$3,'runtime_failure','manual','medium','Failed','{}',now())`,[randomUUID(),team,target]);
 const counts=async()=>({runs:(await one("SELECT count(*)::int n FROM runs WHERE space_id=$1 AND run_type='evolution'",[team])).n,jobs:(await one("SELECT count(*)::int n FROM jobs WHERE space_id=$1 AND job_type='agent_run'",[team])).n,decisions:(await one('SELECT count(*)::int n FROM evolution_selector_decisions WHERE target_id=$1',[target])).n});
 const state=()=>one('SELECT status,enabled FROM evolution_targets WHERE id=$1',[target]);
 const restore=()=>db.pool.query("UPDATE evolution_targets SET status='active',enabled=true WHERE id=$1",[target]);
 const holder=await db.pool.connect();
 try{
  // The target writer changes it first: the REST start waits on the target, then refuses and writes nothing.
  await holder.query('BEGIN');
  await new EvolutionRepository(holder).updateTarget(identity,target,change);
  const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const before=await counts();
  let settled=false;
  const start=rest('POST',`/api/v1/evolution/targets/${target}/run`,{mode:'dry_run'}).finally(()=>{settled=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
  expect(settled).toBe(false);
  await holder.query('COMMIT');
  const refused=await start;expect([404,409],refused.body).toContain(refused.statusCode);
  expect(await counts()).toEqual(before);
  await restore();
  // The REST start goes first; this connection holds the strategy row it
  // updates later in the same operation transaction, so the start stops
  // mid-transaction holding the target. This order shows the committed Run,
  // decision and Job precede the change end to end; it does not by itself
  // isolate the share lock: the start's signal and decision inserts already
  // key-share the target row by foreign key. The order above does — without
  // `lockTargetForRun` the start reads the stale target and queues a Run.
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM evolution_strategy_assets FOR SHARE');
  const startedPid=pid;
  settled=false;
  const queued=rest('POST',`/api/v1/evolution/targets/${target}/run`,{mode:'dry_run'}).finally(()=>{settled=true;});
  await waitForBlockedBy(db.pool,startedPid,{settled:()=>settled});
  expect(settled).toBe(false);
  // The REST target writer now waits on the start's target lock, not on this connection.
  let changed=false;
  const write=rest('PATCH',`/api/v1/evolution/targets/${target}`,change).finally(()=>{changed=true;});
  await vi.waitUntil(async()=>(await db.pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND NOT ($1::int = ANY(pg_blocking_pids(pid)))`,[startedPid])).rowCount===1,{timeout:10_000,interval:20});
  expect(changed).toBe(false);
  expect(await state()).toEqual({status:'active',enabled:true});
  await holder.query('COMMIT');
  const accepted=await queued;expect(accepted.statusCode,accepted.body).toBe(202);
  const out=accepted.json().data as {status:string;run_id:string;job_id:string;selector_decision_id:string};
  expect(out.status).toBe('queued');
  expect((await write).statusCode).toBe(200);
  // The Run, its decision and its Job were committed by the start before the change.
  expect(await one('SELECT status,run_type FROM runs WHERE id=$1',[out.run_id])).toEqual({status:'queued',run_type:'evolution'});
  expect(await one('SELECT job_type FROM jobs WHERE id=$1',[out.job_id])).toEqual({job_type:'agent_run'});
  expect(await one('SELECT target_id FROM evolution_selector_decisions WHERE id=$1',[out.selector_decision_id])).toEqual({target_id:target});
  expect(await state()).toMatchObject(change);
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
});

it('resolves Runtime Context Policy as a query and queues a turn preview whose reader releases nothing to others',async()=>{
 const resolved=await app.inject({method:'POST',url:'/api/v1/runtime-context/policies/resolve',payload:{}});expect(resolved.statusCode,resolved.body).toBe(200);
 expect(resolved.json().data).toHaveProperty('resolution_hash');
 expect((await app.inject({method:'POST',url:'/api/v1/runtime-context/policies/resolve',payload:{unknown:true}})).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:'/api/v1/runtime-context/preview',payload:{},headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(422);
 const turn={work_context_scope_id:randomUUID(),expected_setup_version:1,current_message_ref:{type:'message',id:randomUUID()},invocation_purpose:'preview'};
 expect((await rest('POST','/api/v1/runtime-context/preview',turn)).statusCode).toBe(404);
 expect((await one("SELECT count(*)::int n FROM jobs WHERE space_id=$1 AND job_type='runtime_context_preview'",[team])).n).toBe(0);
 // A queued request is the requester's alone; its reader withholds nothing it never computed.
 const job=randomUUID();await db.pool.query(`INSERT INTO jobs(id,space_id,user_id,job_type,status,priority,payload_json,attempts,max_attempts,created_at,updated_at) VALUES($1,$2,$3,'runtime_context_preview','pending',0,'{}',0,1,now(),now())`,[job,team,owner]);
 const pending=await app.inject({method:'GET',url:`/api/v1/runtime-context/preview-requests/${job}`});expect(pending.json()).toEqual({job_id:job,status:'pending',result:null,withheld:0});
 as(team,member);expect((await app.inject({method:'GET',url:`/api/v1/runtime-context/preview-requests/${job}`})).statusCode).toBe(404);
});
