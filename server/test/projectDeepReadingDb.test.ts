import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,PROJECT,OWNER,MEMBER,NEWCOMER,AGENT,PROFILE,CONNECTION,HOST} from './support/briefingFixture.js';
import {buildServerDist,startWorkerProcess,isPrompted,isCancelled,isFrame,settledCommands,until,type WorkerProcess} from './support/briefingWorkerHarness.js';
import {syncBuiltinPrompts} from '../src/modules/prompts/builtins.js';
import {favoriteMaterial,favoriteList,startDeepReading,readDeepOperations,cancelDeepReading} from '../src/modules/sources/deepReading/service.js';
import {agentReadingDocument,saveSourceReadingDocument} from '../src/modules/sources/materialProcessing/documents.js';
import {MaterialItemProcessingService,assertItemProcessingDispatch} from '../src/modules/sources/materialProcessing/items.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import {PgRunRepository,type RunRecord} from '../src/modules/runs/repository.js';
import {PgReaderRepository} from '../src/modules/reader/repository.js';
import {PgArtifactRepository} from '../src/modules/artifacts/repository.js';
import {RuntimeContextPolicyRepository} from '../src/modules/policy/runtimeContextPolicyRepository.js';
const db=useTestDatabase(import.meta.filename,{max:6}),w=briefingWorld(db),identity={spaceId:SPACE,userId:OWNER};
let root='',itemId='',originalId='',worker:WorkerProcess|undefined;
const config=()=>({...w.config(),rainverHome:root,artifactStorageRoot:join(root,'artifacts'),sandboxRoot:join(root,'sandbox')});
const selection={agent_id:AGENT,runtime_profile_id:PROFILE};
beforeEach(async()=>{if(!db.available)return;root=await mkdtemp(join(tmpdir(),'deep-reading-'));await w.seed();await syncBuiltinPrompts(db.pool,config().catalogRoot,['reading.project_investigation']);await db.pool.query("UPDATE source_connections SET capture_policy='extract_text',policy_json=policy_json||'{\"retention_policy\":\"full_text\"}'::jsonb WHERE id=$1",[CONNECTION]);itemId=await w.material('Evidence material',{uri:'https://news.test/deep'});await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[itemId,PROJECT]);originalId=(await original('Author original A with stable mechanisms.')).snapshotId;});
afterEach(async()=>{if(worker){await worker.kill();worker=undefined;}if(root)await rm(root,{recursive:true,force:true});});
async function original(text:string){return saveSourceReadingDocument(db.pool,{spaceId:SPACE,itemId,document:{...agentReadingDocument({kind:'article',format:'source_text',syntax:'plain',text,sources:['https://news.test/deep']},'https://news.test/deep'),extraction_method:'plain_text_v1'}});}
async function start(extra:Record<string,unknown>={}){return startDeepReading(db.pool,config(),identity,PROJECT,itemId,{...selection,...extra});}
async function running(id:string){await db.pool.query("UPDATE runs r SET status='running',started_at=now(),runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p),permission_snapshot_json=$2 FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id",[id,{tool_grants:[{action_id:'source.material.submit'},{action_id:'source.material.investigate'}]}]);const run=(await new PgRunRepository(db.pool).getRun(SPACE,id))!;if(run.execution_kind!=='agent')throw new Error('Agent fixture expected');return run;}
async function submit(run:RunRecord,processingId:string,suffix='D',url='https://news.test/deep'){
 if(run.execution_kind!=='agent')throw new Error('Agent Run expected');
 const draft=`Finding ${suffix}: retries need idempotency. The mechanism repeats requests. Durability remains unknown. An alternative is a durable queue. No comparable retained evidence was found. ${url}`,tools=new CliAgentToolTransport(config());
 expect(await tools.call(run,{id:'search',name:'source.material.investigate',arguments:{operation:'search',query:'FixtureNoMatch9287'}})).toMatchObject({ok:true});
 const checked=await tools.call(run,{id:'check',name:'source.material.investigate',arguments:{operation:'check',draft,questions:[{question:'What does retry guarantee?',finding:`Finding ${suffix}: retries need idempotency.`,explanation:'The mechanism repeats requests.',limitations:'Durability remains unknown.',alternative:'An alternative is a durable queue.',evidence_urls:[url]}],historical_comparison:'No comparable retained evidence was found.',remaining_gaps:['Durability'],stop_reason:'Need a controlled experiment.'}});expect(checked).toMatchObject({ok:true});expect(JSON.stringify(checked)).toContain('"ready":true');
 const result=await tools.call(run,{id:'submit',name:'source.material.submit',arguments:{processing_id:processingId,status:'succeeded',items:[{url,title:'Evidence',summary:null,observed_at:new Date().toISOString(),content:{kind:'article',format:'agent_summary',syntax:'plain',text:draft,sources:[url]}}],failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}}});expect(result,JSON.stringify(result)).toMatchObject({ok:true});return draft;
}
async function finish(processingId:string,runId:string,suffix='D'){const run=await running(runId);const draft=await submit(run,processingId,suffix);await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);await new MaterialItemProcessingService(db.pool,config()).reconcileTerminal(run.id);return draft;}
it('favorite and private deep reading are independent, duplicate inputs reuse and another member sees neither request nor favorite',async()=>{
 const before=(await db.pool.query('SELECT content_hash,extracted_artifact_id FROM source_items WHERE id=$1',[itemId])).rows[0];await favoriteMaterial(db.pool,identity,PROJECT,itemId,true);expect((await favoriteList(db.pool,identity,PROJECT)).items).toHaveLength(1);expect(await w.count('runs')).toBe(0);expect((await readDeepOperations(db.pool,identity,PROJECT)).items).toHaveLength(0);
 const op=await start();expect(await start()).toMatchObject({processing_id:op.processing_id,run_id:op.run_id});const draft=await finish(op.processing_id,op.run_id!);await favoriteMaterial(db.pool,identity,PROJECT,itemId,false);expect((await favoriteList(db.pool,identity,PROJECT)).items).toHaveLength(0);const shown=(await readDeepOperations(db.pool,identity,PROJECT,op.processing_id)).items[0];expect(shown.status).toBe('completed');expect(shown.report?.original_snapshot_id).toBe(originalId);expect((await new PgReaderRepository(db.pool,config()).getDocument(identity,'source_snapshot',shown.report!.snapshot_id,{recordOpen:false}))?.plain_text).toBe(draft);
 expect((await db.pool.query('SELECT content_hash,extracted_artifact_id FROM source_items WHERE id=$1',[itemId])).rows[0]).toEqual(before);expect((await db.pool.query('SELECT favorite,read_status,progress_json FROM source_item_user_states WHERE source_item_id=$1 AND user_id=$2',[itemId,OWNER])).rows[0]).toEqual({favorite:false,read_status:'unread',progress_json:{}});expect((await readDeepOperations(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT)).items).toHaveLength(0);expect((await favoriteList(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT)).items).toHaveLength(0);await expect(readDeepOperations(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT,op.processing_id)).rejects.toMatchObject({statusCode:404});await expect(readDeepOperations(db.pool,{spaceId:SPACE,userId:NEWCOMER},PROJECT)).rejects.toMatchObject({statusCode:404});
});
it('a running investigation keeps the exact supplied original after an author update; reruns have independent immutable history',async()=>{
 const op=await start(),run=await running(op.run_id!);expect(run.prompt).toContain('Author original A');await original('Author original B changed while review runs.');await expect(assertItemProcessingDispatch(db.pool,config(),run)).resolves.toBeTruthy();await submit(run,op.processing_id);await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);await new MaterialItemProcessingService(db.pool,config()).reconcileTerminal(run.id);const first=(await readDeepOperations(db.pool,identity,PROJECT,op.processing_id)).items[0];expect(first.report?.original_snapshot_id).toBe(originalId);
 const op2=await start();expect(op2.run_id).not.toBe(run.id);await finish(op2.processing_id,op2.run_id!,'D2');const op3=await start({rerun_of:op2.processing_id});expect(await start({rerun_of:op2.processing_id})).toMatchObject({processing_id:op3.processing_id});await finish(op3.processing_id,op3.run_id!,'D3');const history=await readDeepOperations(db.pool,identity,PROJECT);expect(history.items).toHaveLength(3);expect(new Set(history.items.map(x=>x.report?.snapshot_id)).size).toBe(3);
});
it('Source withdrawal hides reports through operations, generic Run and Artifact/Reader, but owner can cancel without reading inputs',async()=>{
 const op=await start();await finish(op.processing_id,op.run_id!);const report=(await readDeepOperations(db.pool,identity,PROJECT)).items[0].report!;await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);expect((await readDeepOperations(db.pool,identity,PROJECT)).items[0]).toMatchObject({withheld:true,report:null});expect(await new PgRunRepository(db.pool).getVisibleRun(SPACE,OWNER,op.run_id!)).toBeNull();expect(await new PgArtifactRepository(db.pool,config()).getVisible(SPACE,OWNER,report.artifact_id,true)).toBeNull();expect(await new PgReaderRepository(db.pool,config()).getDocument(identity,'source_snapshot',report.snapshot_id,{recordOpen:false})).toBeNull();await db.pool.query("UPDATE source_connections SET capture_policy='extract_text' WHERE id=$1",[CONNECTION]);expect((await readDeepOperations(db.pool,identity,PROJECT)).items[0].report).not.toBeNull();const active=await start({rerun_of:op.processing_id});await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);expect((await cancelDeepReading(db.pool,config(),identity,PROJECT,active.processing_id)).status).toBe('cancelled');
});
it('real jobs worker and synthetic Host Delivery use bound check/submit tools before canonical terminal publication',async()=>{
 await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic deep reading worker'});const op=await start();buildServerDist();worker=await startWorkerProcess({databaseUrl:db.connectionUri,home:root,hostId:HOST});await worker.next(isPrompted(op.run_id!));const run=(await new PgRunRepository(db.pool).getRun(SPACE,op.run_id!))!;await submit(run,op.processing_id);worker.send({cmd:'answer',runId:run.id,text:'Private report submitted with checked evidence.'});const done=await until(()=>readDeepOperations(db.pool,identity,PROJECT,op.processing_id),x=>['completed','failed'].includes(x.items[0].status),'private report canonical settlement',150);expect(done.items[0],JSON.stringify(done)).toMatchObject({status:'completed',withheld:false});expect(done.items[0].report).not.toBeNull();expect((await new PgRunRepository(db.pool).getRun(SPACE,run.id))!.status).toBe('succeeded');expect(Number((await db.pool.query('SELECT count(*) AS n FROM invocation_deliveries WHERE invocation_id=$1',[run.id])).rows[0].n)).toBe(1);
},60000);

import {randomUUID} from 'node:crypto';
import {seedProjectMainlineRoom} from './support/domainSeeds.js';
import {assertReadingRunDispatch} from '../src/modules/prompts/reading/dispatch.js';
import {lockReadingRunAuthority} from '../src/modules/runtimeContext/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
it('global material has distinct private operations per Project and requires an explicit legitimate Following selection',async()=>{
 await db.pool.query('UPDATE source_items SET project_id=NULL WHERE id=$1',[itemId]);const secondProject=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other project','active',now(),now())",[secondProject,SPACE,OWNER]);await seedProjectMainlineRoom(db.pool,{space:SPACE,project:secondProject,owner:OWNER});
 const a=await start(),b=await startDeepReading(db.pool,config(),identity,secondProject,itemId,selection);expect(a.processing_id).not.toBe(b.processing_id);expect((await readDeepOperations(db.pool,identity,PROJECT)).items.map(r=>r.id)).toEqual([a.processing_id]);expect((await readDeepOperations(db.pool,identity,secondProject)).items.map(r=>r.id)).toEqual([b.processing_id]);await expect(readDeepOperations(db.pool,identity,PROJECT,b.processing_id)).rejects.toMatchObject({statusCode:404});await expect(startDeepReading(db.pool,config(),{spaceId:randomUUID(),userId:OWNER},PROJECT,itemId,selection)).rejects.toMatchObject({statusCode:404});await expect(start({following:{goal_id:randomUUID(),version_id:randomUUID(),connection_id:CONNECTION}})).rejects.toMatchObject({statusCode:409});
 const refs=[];
 for(const purpose of ['Understand mechanism','Challenge failure modes']){const goal=randomUUID(),version=randomUUID(),binding=randomUUID(),audit=randomUUID();await db.pool.query("INSERT INTO source_goals(id,space_id,project_id,owner_user_id,intent_json,budget_json,status,active_version_id) VALUES($1,$2,$3,$4,$5,'{}','running',$6)",[goal,SPACE,PROJECT,OWNER,{intent:purpose},version]);await db.pool.query('INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_user_id) VALUES($1,$2,$3,1,$4,$5)',[version,SPACE,goal,{summary:purpose,analysis_brief:purpose,sources:[],limitations:[]},OWNER]);await db.pool.query('INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json) VALUES($1,$2,$3,$4,$5)',[binding,SPACE,goal,CONNECTION,{}]);await db.pool.query("INSERT INTO source_goal_runs(id,space_id,goal_id,binding_id,version_id,status) VALUES($1,$2,$3,$4,$5,'succeeded')",[audit,SPACE,goal,binding,version]);await db.pool.query('INSERT INTO source_goal_items(id,space_id,goal_id,source_item_id,source_connection_id,binding_id,version_id,first_goal_run_id,last_goal_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)',[randomUUID(),SPACE,goal,itemId,CONNECTION,binding,version,audit]);refs.push({goal_id:goal,version_id:version,connection_id:CONNECTION});}
 const {deepReadingPurposes}=await import('../src/modules/sources/deepReading/service.js');const countBefore=await w.count('runs');expect((await deepReadingPurposes(db.pool,identity,PROJECT,itemId)).choices).toHaveLength(2);expect((await deepReadingPurposes(db.pool,identity,secondProject,itemId)).choices).toHaveLength(0);await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);expect((await deepReadingPurposes(db.pool,identity,PROJECT,itemId)).choices).toHaveLength(0);await db.pool.query("UPDATE source_connections SET capture_policy='extract_text' WHERE id=$1",[CONNECTION]);expect(await w.count('runs')).toBe(countBefore);
 const p=await start({following:refs[0]}),q=await start({following:refs[1]});expect(p.run_id).not.toBe(q.run_id);expect((await readDeepOperations(db.pool,identity,PROJECT,p.processing_id)).items[0].purpose_label).toBe('Understand mechanism');await db.pool.query('UPDATE source_goals SET intent_json=$2 WHERE id=$1',[refs[0].goal_id,{intent:'A later renamed purpose'}]);expect((await readDeepOperations(db.pool,identity,PROJECT,p.processing_id)).items[0].purpose_label).toBe('Understand mechanism');await db.pool.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);expect((await readDeepOperations(db.pool,identity,PROJECT,p.processing_id)).items[0]).toMatchObject({withheld:true,purpose_label:null,title:null,execution:null});await db.pool.query("UPDATE source_connections SET capture_policy='extract_text' WHERE id=$1",[CONNECTION]);const run=(await new PgRunRepository(db.pool).getRun(SPACE,p.run_id!))!;expect(run.prompt).toContain('Understand mechanism');expect(run.prompt).not.toContain('Challenge failure modes');await favoriteMaterial(db.pool,identity,PROJECT,itemId,true);expect((await favoriteList(db.pool,identity,PROJECT)).items).toHaveLength(1);
});
it('cancellation waits for the canonical Host ACK; retry and rerun are bounded, late old submissions cannot publish',async()=>{
 await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic cancel/retry'});
 const op=await start();buildServerDist();worker=await startWorkerProcess({databaseUrl:db.connectionUri,home:root,hostId:HOST});await worker.next(isPrompted(op.run_id!));const old=(await new PgRunRepository(db.pool).getRun(SPACE,op.run_id!))!;
 worker.send({cmd:'cancel_deep',operationId:op.processing_id,projectId:PROJECT,spaceId:SPACE,userId:OWNER});expect(['cancelling','cancelled']).toContain(((await worker.next(isCancelled)).result as {status:string}).status);await until(()=>new PgRunRepository(db.pool).getRun(SPACE,old.id),r=>r?.status==='cancelled','canonical cancel ACK',150);await worker.stop();worker=undefined;
 const retry=await start({retry_of:op.processing_id});expect(await start({retry_of:op.processing_id})).toMatchObject({processing_id:retry.processing_id});expect(retry.run_id).not.toBe(old.id);const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');await expect(submitMaterialResults(config(),old,{})).rejects.toMatchObject({statusCode:403});await finish(retry.processing_id,retry.run_id!);const third=await start({rerun_of:retry.processing_id});await finish(third.processing_id,third.run_id!,'D3');await expect(start({rerun_of:third.processing_id})).rejects.toMatchObject({statusCode:409});expect(await w.count('runs')).toBe(3);
},60000);
it('HTTP favorites/list/read are private pure reads and explicit actions; disabled/foreign execution never silently falls back',async()=>{
 const app=buildModuleServer(config(),[sourcesModule]);__setAuthIdentityForTests(identity);
 try{const base=`/api/v1/spaces/${SPACE}/projects/${PROJECT}/reading`;expect((await app.inject({method:'POST',url:`${base}/items/${itemId}/favorite`,payload:{favorite:true}})).statusCode).toBe(200);expect((await app.inject({method:'GET',url:`${base}/favorites`})).json().items).toHaveLength(1);expect((await app.inject({method:'GET',url:`${base}/deep-reads`})).json().items).toHaveLength(0);expect(await w.count('runs')).toBe(0);const started=await app.inject({method:'POST',url:`${base}/items/${itemId}/deep-reads`,payload:selection});expect(started.statusCode,started.body).toBe(200);const op=started.json();expect((await app.inject({method:'GET',url:`${base}/deep-reads/${op.processing_id}`})).json().items[0]).toMatchObject({id:op.processing_id,status:'queued'});expect(await w.count('runs')).toBe(1);await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[PROFILE]);await expect(start()).rejects.toMatchObject({statusCode:403});expect(await w.count('runs')).toBe(1);__setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});expect((await app.inject({method:'GET',url:`${base}/deep-reads/${op.processing_id}`})).statusCode).toBe(404);}finally{__setAuthIdentityForTests(null);await app.close();}
});
it('physical Delivery authority holds the Source while publication is authorized; revoked Source rejects before consumption',async()=>{
 const op=await start(),run=await running(op.run_id!);const holder=await db.pool.connect(),revoker=await db.pool.connect();let writing:Promise<unknown>|undefined;
 try{await holder.query('BEGIN');await revoker.query('BEGIN');const hp=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,rp=(await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await lockReadingRunAuthority(holder,run);await assertReadingRunDispatch(holder,run);writing=revoker.query("UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1",[CONNECTION]);expect(await until(async()=>Boolean((await db.pool.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[rp,hp])).rows[0].blocked),Boolean,'deep Source fence',40)).toBe(true);await holder.query('COMMIT');await writing;await revoker.query('COMMIT');await expect(assertReadingRunDispatch(db.pool,run)).rejects.toMatchObject({statusCode:403});}finally{await holder.query('ROLLBACK');holder.release();if(writing)await writing;await revoker.query('ROLLBACK');revoker.release();}
});

it.each(['claude_code','codex_cli','opencode'])('private investigation preserves explicit %s runtime and advertised model/mode selections',async runtime=>{
 const options=[{id:'model',type:'select',category:'model',name:'Model',current_value:'fixture-a',options:[{value:'fixture-a',name:'A'},{value:'fixture-b',name:'B'}]},{id:'mode',type:'select',category:'mode',name:'Mode',current_value:'review',options:[{value:'review',name:'Review'}]}];
 await db.pool.query('UPDATE agent_runtime_profiles SET runtime_key=$2 WHERE id=$1',[PROFILE,runtime]);await db.pool.query('UPDATE hosts SET capabilities_json=$2 WHERE id=$1',[HOST,{runtimes:[runtime],versions:{[runtime]:'fixture'},installations:{[runtime]:[{id:'own',version:'fixture',logged_in:true,options:{session_available:true,config_options:options},health_check_protocol:'acp'}]}}]);
 const session_config=[{id:'model',type:'select',category:'model',value:'fixture-b'},{id:'mode',type:'select',category:'mode',value:'review'}];const op=await start({session_config});const run=await running(op.run_id!);expect(run.runtime_key).toBe(runtime);expect(run.requested_runtime_profile_id).toBe(PROFILE);expect((run.model_override_json as {acp_session_config:unknown}).acp_session_config).toEqual(session_config);await expect(assertItemProcessingDispatch(db.pool,config(),run)).resolves.toBeTruthy();
 const tools=(await new CliAgentToolTransport(config()).list(run)).map(t=>t.name);expect(tools).toEqual(expect.arrayContaining(['source.material.submit','source.material.investigate']));expect(tools).not.toContain('source.item_update');expect(tools).not.toContain('agent.delegate');
});
it('API-bound OpenCode keeps its authorized local model destination without fallback to a native external model',async()=>{
 const provider=randomUUID();await db.pool.query("INSERT INTO model_providers(id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at) VALUES($1,$2,$3,'Synthetic local','openai','http://127.0.0.1:11434/v1','llama3',true,'{}','{\"deployment\":\"trusted_local\",\"openai_compatible_base_url\":\"http://127.0.0.1:11434/v1\"}',now(),now())",[provider,SPACE,OWNER]);await db.pool.query('INSERT INTO model_provider_space_grants(id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at) VALUES($1,$2,$3,$4,$4,true,false,now(),now())',[randomUUID(),provider,SPACE,OWNER]);
 await db.pool.query("UPDATE agent_runtime_profiles SET runtime_key='opencode',backend_mode='model_provider',model_provider_id=$2,model_name='llama3' WHERE id=$1",[PROFILE,provider]);await db.pool.query('UPDATE hosts SET capabilities_json=$2 WHERE id=$1',[HOST,{runtimes:['opencode'],versions:{opencode:'fixture'},installations:{opencode:[{id:'own',version:'fixture',logged_in:true,options:{session_available:true,config_options:[]},health_check_protocol:'acp'}]}}]);await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allow_external_model_egress":false,"allow_local_provider_egress":true}' WHERE id=$1`,[CONNECTION]);const op=await start(),run=await running(op.run_id!);await db.pool.query("UPDATE runs SET model_provider_id=$2 WHERE id=$1",[run.id,provider]);const bound=(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!;await expect(assertItemProcessingDispatch(db.pool,config(),bound)).resolves.toBeTruthy();await db.pool.query('UPDATE model_provider_space_grants SET enabled=false WHERE provider_id=$1',[provider]);await expect(assertItemProcessingDispatch(db.pool,config(),bound)).rejects.toBeTruthy();expect(await w.count('runs')).toBe(1);
});

it('a Project viewer with their own executable identity may investigate without writing shared Source content',async()=>{
 const agent=randomUUID(),version=randomUUID(),profile=randomUUID(),host=randomUUID();
 await db.pool.query(`INSERT INTO hosts SELECT (jsonb_populate_record(null::hosts,to_jsonb(h)||jsonb_build_object('id',$2::text,'owner_user_id',$3::text))).* FROM hosts h WHERE id=$1`,[HOST,host,MEMBER]);
 await db.pool.query(`INSERT INTO agents SELECT (jsonb_populate_record(null::agents,to_jsonb(a)||jsonb_build_object('id',$2::text,'owner_user_id',$3::text,'current_version_id',null))).* FROM agents a WHERE id=$1`,[AGENT,agent,MEMBER]);
 await db.pool.query(`INSERT INTO agent_versions SELECT (jsonb_populate_record(null::agent_versions,to_jsonb(v)||jsonb_build_object('id',$2::text,'agent_id',$3::text))).* FROM agent_versions v WHERE agent_id=$1`,[AGENT,version,agent]);await db.pool.query('UPDATE agents SET current_version_id=$2 WHERE id=$1',[agent,version]);
 await db.pool.query(`INSERT INTO agent_runtime_profiles SELECT (jsonb_populate_record(null::agent_runtime_profiles,to_jsonb(p)||jsonb_build_object('id',$2::text,'agent_id',$3::text,'execution_host_id',$4::text))).* FROM agent_runtime_profiles p WHERE id=$1`,[PROFILE,profile,agent,host]);
 const op=await startDeepReading(db.pool,config(),{spaceId:SPACE,userId:MEMBER},PROJECT,itemId,{agent_id:agent,runtime_profile_id:profile});expect(op.run_id).toBeTruthy();await finish(op.processing_id,op.run_id!,'Viewer');expect((await readDeepOperations(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT,op.processing_id)).items[0].report).not.toBeNull();await favoriteMaterial(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT,itemId,true);expect((await favoriteList(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT)).items).toHaveLength(1);expect((await readDeepOperations(db.pool,identity,PROJECT)).items).toHaveLength(0);await expect(start({agent_id:agent,runtime_profile_id:profile})).rejects.toMatchObject({statusCode:403});
});

it('D and explicit D2 preserve the original document hash, annotation identity and private progress',async()=>{
 const {PgAnnotationRepository}=await import('../src/modules/reader/repository.js');const {ReaderPositionStore}=await import('../src/modules/reader/positions.js');
 const reader=new PgReaderRepository(db.pool,config()),annotations=new PgAnnotationRepository(db.pool),positions=new ReaderPositionStore(db.pool,config());const doc=(await reader.getDocument(identity,'source_item',itemId,{recordOpen:false}))!;
 const ann=await annotations.createAnnotation(identity,{document_type:'source_item',document_id:itemId,annotation_type:'highlight',quote_text:'Author original A',anchor_json:{schema_version:1,quote_text:'Author original A',text_range:{start:0,end:17,unit:'utf16'},before_context:'',after_context:' with stable mechanisms.'}});
 await positions.write(identity,'source_item',itemId,{content_hash:doc.content_hash,structure_hash:doc.structure_hash,current:{anchor:{block_index:0,pm_pos:1,text_offset:0,quote:'Author original A',before_context:''},progress:0.5},dwelled:true,client_at:new Date().toISOString()});await favoriteMaterial(db.pool,identity,PROJECT,itemId,true);
 const before=(await db.pool.query('SELECT content_hash,reading_body_hash,reading_body_revision,extracted_artifact_id FROM source_items WHERE id=$1',[itemId])).rows[0],position=await positions.get(identity,'source_item',itemId);
 const d=await start();await finish(d.processing_id,d.run_id!);const d2=await start({rerun_of:d.processing_id});await finish(d2.processing_id,d2.run_id!,'D2');
 expect((await db.pool.query('SELECT content_hash,reading_body_hash,reading_body_revision,extracted_artifact_id FROM source_items WHERE id=$1',[itemId])).rows[0]).toEqual(before);expect(await positions.get(identity,'source_item',itemId)).toEqual(position);expect((await annotations.listAnnotations(identity,'source_item',itemId)).map(a=>a.id)).toContain(ann.id);expect((await readDeepOperations(db.pool,identity,PROJECT)).items.every(o=>o.report?.original_snapshot_id===originalId)).toBe(true);
 const stateBefore=(await db.pool.query('SELECT row_to_json(s) AS value FROM source_item_user_states s WHERE source_item_id=$1',[itemId])).rows;
 await readDeepOperations(db.pool,identity,PROJECT);await favoriteList(db.pool,identity,PROJECT);expect((await db.pool.query('SELECT row_to_json(s) AS value FROM source_item_user_states s WHERE source_item_id=$1',[itemId])).rows).toEqual(stateBefore);
});

it('favorite does not require an HTTP preparation URL and never starts investigation',async()=>{
 await db.pool.query('UPDATE source_items SET source_uri=NULL WHERE id=$1',[itemId]);await favoriteMaterial(db.pool,identity,PROJECT,itemId,true);expect((await favoriteList(db.pool,identity,PROJECT)).items[0].item_id).toBe(itemId);expect(await w.count('runs')).toBe(0);await expect(start()).rejects.toMatchObject({statusCode:422});
});
it('real worker rejects extra adapter artifacts rather than creating an unguarded report or falsely completing deep reading',async()=>{
 await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic output boundary'});const before=await w.count('artifacts'),op=await start();buildServerDist();worker=await startWorkerProcess({databaseUrl:db.connectionUri,home:root,hostId:HOST});await worker.next(isPrompted(op.run_id!));const run=(await new PgRunRepository(db.pool).getRun(SPACE,op.run_id!))!;await submit(run,op.processing_id);worker.send({cmd:'policy',adapterOutput:{artifacts:[{artifact_type:'markdown',title:'Not authorized',content:'SOURCE_PRIVATE_SENTINEL'}]}});worker.send({cmd:'answer',runId:run.id,text:'An attempted extra output.'});const done=await until(()=>readDeepOperations(db.pool,identity,PROJECT,op.processing_id),r=>r.items[0].status==='failed','extra output fails closed',150);expect(done.items[0].report).toBeNull();expect(await w.count('artifacts')).toBe(before);expect(['degraded','failed']).toContain((await new PgRunRepository(db.pool).getRun(SPACE,run.id))!.status);
},60000);

it('a failed rerun keeps the last successful report readable and needs an explicit bounded retry',async()=>{
 const first=await start();await finish(first.processing_id,first.run_id!);const originalReport=(await readDeepOperations(db.pool,identity,PROJECT,first.processing_id)).items[0].report!;await expect(start({retry_of:first.processing_id})).rejects.toMatchObject({statusCode:409});
 const second=await start({rerun_of:first.processing_id});await running(second.run_id!);await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[second.run_id]);await new MaterialItemProcessingService(db.pool,config()).reconcileTerminal(second.run_id!);
 const failed=(await readDeepOperations(db.pool,identity,PROJECT,second.processing_id)).items[0];expect(failed).toMatchObject({status:'failed',report:null});expect((await readDeepOperations(db.pool,identity,PROJECT,first.processing_id)).items[0].report).toEqual(originalReport);expect(await start()).toMatchObject({processing_id:second.processing_id});const retry=await start({retry_of:second.processing_id});await finish(retry.processing_id,retry.run_id!,'Recovered');expect((await readDeepOperations(db.pool,identity,PROJECT)).items[0].status).toBe('completed');expect(await w.count('runs')).toBe(3);
});
it('historical private output survives execution-config drift but not actual Project access withdrawal',async()=>{
 const op=await start();await finish(op.processing_id,op.run_id!);const report=(await readDeepOperations(db.pool,identity,PROJECT)).items[0].report!;
 await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_config_json=runtime_config_json||'{"fixture_note":"ordinary drift"}' WHERE id=$1`,[PROFILE]);expect((await readDeepOperations(db.pool,identity,PROJECT)).items[0].report).toEqual(report);expect(await new PgRunRepository(db.pool).getVisibleRun(SPACE,OWNER,op.run_id!)).not.toBeNull();
 const active=await start();await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[PROJECT,MEMBER]);await expect(readDeepOperations(db.pool,identity,PROJECT)).rejects.toMatchObject({statusCode:404});expect(await new PgRunRepository(db.pool).getVisibleRun(SPACE,OWNER,op.run_id!)).toBeNull();expect(await new PgArtifactRepository(db.pool,config()).getVisible(SPACE,OWNER,report.artifact_id,true)).toBeNull();expect(await new PgReaderRepository(db.pool,config()).getDocument(identity,'source_snapshot',report.snapshot_id,{recordOpen:false})).toBeNull();await expect(cancelDeepReading(db.pool,config(),identity,PROJECT,active.processing_id)).resolves.toMatchObject({id:active.processing_id});await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[PROJECT,OWNER]);expect((await readDeepOperations(db.pool,identity,PROJECT,op.processing_id)).items[0].report).not.toBeNull();
});

it('historical reads use live permissions rather than Source configuration equality, while queued execution still requires frozen authority',async()=>{
 const op=await start();await finish(op.processing_id,op.run_id!);const report=(await readDeepOperations(db.pool,identity,PROJECT)).items[0].report!;const queued=await start({rerun_of:op.processing_id});
 await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||jsonb_build_object('allowed_reader_user_ids',jsonb_build_array($2::text)) WHERE id=$1`,[CONNECTION,NEWCOMER]);
 expect((await readDeepOperations(db.pool,identity,PROJECT,op.processing_id)).items[0]).toMatchObject({withheld:false,report});expect(await new PgRunRepository(db.pool).getVisibleRun(SPACE,OWNER,op.run_id!)).not.toBeNull();await expect(assertItemProcessingDispatch(db.pool,config(),(await new PgRunRepository(db.pool).getRun(SPACE,queued.run_id!))!)).rejects.toMatchObject({statusCode:403});
});

it('missing deterministic original stays unknown and source_text cannot be submitted as an investigation',async()=>{
 itemId=await w.material('No retained author original',{uri:'https://news.test/unretained'});
 await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[itemId,PROJECT]);
 const before=(await db.pool.query('SELECT content_hash,extracted_artifact_id FROM source_items WHERE id=$1',[itemId])).rows[0];
 const op=await start(),run=await running(op.run_id!);
 expect(run.prompt).toContain('unknown/not retained');
 if(run.execution_kind!=='agent')throw new Error('Agent Run expected');
 const rejected=await new CliAgentToolTransport(config()).call(run,{id:'not-original',name:'source.material.submit',arguments:{processing_id:op.processing_id,status:'succeeded',items:[{url:'https://news.test/unretained',title:'Claimed original',summary:null,observed_at:new Date().toISOString(),content:{kind:'article',format:'source_text',syntax:'plain',text:'Not deterministic author text',sources:['https://news.test/unretained']}}],failure:null,coverage:{truncated:false,exhaustive:false,limitations:[]}}});
 expect(rejected).toMatchObject({ok:false});
 expect(JSON.stringify(rejected)).toContain('An investigation report must be agent_summary');
 await submit(run,op.processing_id,'Unknown original','https://news.test/unretained');
 await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);
 await new MaterialItemProcessingService(db.pool,config()).reconcileTerminal(run.id);
 const shown=(await readDeepOperations(db.pool,identity,PROJECT,op.processing_id)).items[0];
 expect(shown).toMatchObject({status:'completed',original:null,report:{original_snapshot_id:null}});
 const snapshot=(await db.pool.query('SELECT reading_role,snapshot_type,metadata_json FROM source_snapshots WHERE id=$1',[shown.report!.snapshot_id])).rows[0];
 expect(snapshot).toMatchObject({reading_role:'analysis',snapshot_type:'summary',metadata_json:{original_availability:'unknown',reading_content_format:'agent_summary',result_provenance:'agent_provided_unverified'}});
 expect((await db.pool.query('SELECT content_hash,extracted_artifact_id FROM source_items WHERE id=$1',[itemId])).rows[0]).toEqual(before);
});

it('private status never escapes through generic Source jobs, including submitted but unsettled reports',async()=>{
 const {PgSourcesRepository}=await import('../src/modules/sources/repository.js');const repo=new PgSourcesRepository(db.pool,config());
 const op=await start(),run=await running(op.run_id!),draft=await submit(run,op.processing_id,'PRIVATE_SENTINEL');
 const filters={status:null,sourceItemId:itemId,connectionId:null,jobType:null,limit:25,offset:0};
 for(const userId of [MEMBER,NEWCOMER]){
  if(userId===NEWCOMER){await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[SPACE,userId]);await w.subscribe(userId,new Date().toISOString());await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),SPACE,PROJECT,userId]);}
  expect(await repo.getItem({spaceId:SPACE,userId},itemId)).not.toBeNull();
  const listed=await repo.listJobs({spaceId:SPACE,userId},filters);expect(listed.items).toEqual([]);expect(listed.total).toBe(0);
  await expect(repo.runJob({spaceId:SPACE,userId},op.processing_id)).rejects.toMatchObject({statusCode:404});
 }
 await expect(repo.runJob(identity,op.processing_id)).rejects.toMatchObject({statusCode:409}); // coordinator-owned active jobs cannot be manually driven
 for(const safe of [await repo.listJobs(identity,filters)]){
  expect(JSON.stringify(safe)).not.toContain('material_submission');expect(JSON.stringify(safe)).not.toContain('investigation');expect(JSON.stringify(safe)).not.toContain(draft);
 }
 const stored=(await db.pool.query('SELECT metadata_json FROM extraction_jobs WHERE id=$1',[op.processing_id])).rows[0].metadata_json;expect(stored.material_submission).toBeTruthy();expect(stored.investigation).toBeTruthy();
 await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);await new MaterialItemProcessingService(db.pool,config()).reconcileTerminal(run.id);expect((await readDeepOperations(db.pool,identity,PROJECT,op.processing_id)).items[0].report).not.toBeNull();
 // Legacy non-deep material payloads are internal too, without hiding their ordinary status.
 await db.pool.query("UPDATE extraction_jobs SET metadata_json=(metadata_json-'deep_project')||$2::jsonb WHERE id=$1",[op.processing_id,{material_submission:{text:'LEGACY_PRIVATE'},investigation:{draft:'LEGACY_PRIVATE'}}]);
 for(const safe of [await repo.listJobs(identity,filters),await repo.runJob(identity,op.processing_id)])expect(JSON.stringify(safe)).not.toContain('LEGACY_PRIVATE');
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[CONNECTION]);expect((await repo.listJobs(identity,filters)).total).toBe(0);
});

it('post-processing extraction never adopts a private deep job and ordinary null metadata still deduplicates',async()=>{
 const {PgSourcePostProcessingRepository}=await import('../src/modules/sources/postProcessing/repository.js');
 const {CHANNEL}=await import('./support/briefingFixture.js');
 const repo=new PgSourcePostProcessingRepository(db.pool);
 itemId=await w.material('Missing original for post-processing',{uri:'https://news.test/missing-original'});
 await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[itemId,PROJECT]);
 const op=await start();
 expect((await new PgRunRepository(db.pool).getRun(SPACE,op.run_id!))!.prompt).toContain('unknown/not retained');
 expect(Number((await db.pool.query('SELECT count(*) n FROM source_snapshots WHERE source_item_id=$1',[itemId])).rows[0].n)).toBe(0);
 const privateBefore=(await db.pool.query('SELECT metadata_json::text AS json FROM extraction_jobs WHERE id=$1',[op.processing_id])).rows[0].json;
 const connection=(await db.pool.query<import('../src/modules/sources/sourceRepositoryRows.js').SourceConnectionRow>('SELECT * FROM source_connections WHERE id=$1',[CONNECTION])).rows[0];
 const shared=await repo.createRun({spaceId:SPACE,ruleId:null,sourceChannelId:CHANNEL,agentId:AGENT,projectId:PROJECT,triggeredByUserId:OWNER,triggerType:'manual',inputItemIds:[itemId],inputEvidenceIds:[],cursorBefore:null,cursorAfter:null});
 const followup=(marker:string)=>({phase:'deep_analysis',source_post_processing_run_id:shared.id,source_post_processing_rule_id:'fixture-rule',triggered_by_user_id:OWNER,trigger_type:'manual',marker});
 const queue=(marker:string)=>repo.queueFullTextExtractionForItems({spaceId:SPACE,connection,itemIds:[itemId],metadata:{source:'source_post_processing',source_post_processing_followups:[followup(marker)]}});
 const ids=await queue('first');expect(ids).toHaveLength(1);expect(ids).not.toContain(op.processing_id);
 await repo.appendRunOutputJobIds(SPACE,shared.id,ids);
 expect((await db.pool.query('SELECT output_job_ids_json FROM source_post_processing_runs WHERE id=$1',[shared.id])).rows[0].output_job_ids_json).toEqual(ids);
 expect((await db.pool.query('SELECT metadata_json::text AS json FROM extraction_jobs WHERE id=$1',[op.processing_id])).rows[0].json).toBe(privateBefore);
 const ordinary=(await db.pool.query('SELECT status,metadata_json FROM extraction_jobs WHERE id=$1',[ids[0]])).rows[0];expect(ordinary.status).toBe('pending');expect(ordinary.metadata_json.source_post_processing_followups).toEqual([followup('first')]);expect(ordinary.metadata_json).not.toHaveProperty('deep_project');
 await db.pool.query('UPDATE extraction_jobs SET metadata_json=NULL WHERE id=$1',[ids[0]]);
 expect(await queue('second')).toEqual(ids);expect(await queue('third')).toEqual(ids);
 expect((await db.pool.query('SELECT metadata_json FROM extraction_jobs WHERE id=$1',[ids[0]])).rows[0].metadata_json.source_post_processing_followups).toEqual([followup('second'),followup('third')]);
 expect(Number((await db.pool.query("SELECT count(*) n FROM extraction_jobs WHERE source_item_id=$1 AND NOT COALESCE(metadata_json ? 'deep_project',false)",[itemId])).rows[0].n)).toBe(1);
 expect((await db.pool.query('SELECT metadata_json::text AS json FROM extraction_jobs WHERE id=$1',[op.processing_id])).rows[0].json).toBe(privateBefore);
 await expect(repo.queueFullTextExtractionForItems({spaceId:SPACE,connection:{...connection,capture_policy:'reference_only',policy_json:{retention_policy:'metadata_only'}},itemIds:[itemId],metadata:{}})).rejects.toMatchObject({statusCode:403});
});

it('Project Reading favorites are server-filtered private pages and exact analysis opens only for its owner',async()=>{
 const {ReadingService}=await import('../src/modules/informationDigest/readingService.js');const {ReaderSourceVersions}=await import('../src/modules/reader/sourceVersions.js');
 const reading=new ReadingService(db.pool);await favoriteMaterial(db.pool,identity,PROJECT,itemId,true);
 const own=await reading.list(identity,{view:'all',favorite:'only',limit:1},PROJECT);expect(own.total).toBe(1);expect(own.items[0]).toMatchObject({source_item_id:itemId,favorite:true});
 expect((await reading.list({spaceId:SPACE,userId:MEMBER},{view:'all',favorite:'only'},PROJECT)).total).toBe(0);
 const second=await w.material('Another favorite',{uri:'https://news.test/another-favorite'});await favoriteMaterial(db.pool,identity,PROJECT,second,true);const first=await reading.list(identity,{view:'all',favorite:'only',limit:1},PROJECT);expect(first.total).toBe(2);expect(first.next_cursor).toBeTruthy();const next=await reading.list(identity,{view:'all',favorite:'only',limit:1,cursor:first.next_cursor!},PROJECT);expect(next.items[0].source_item_id).not.toBe(first.items[0].source_item_id);await expect(reading.list(identity,{view:'all',cursor:first.next_cursor!},PROJECT)).rejects.toMatchObject({statusCode:422});await favoriteMaterial(db.pool,identity,PROJECT,second,false);
 const op=await start();await finish(op.processing_id,op.run_id!);const report=(await readDeepOperations(db.pool,identity,PROJECT,op.processing_id)).items[0].report!;
 const {projectReadingRecords}=await import('../src/modules/reader/readingRecords.js');await original('A later original A2');const exact=await projectReadingRecords(db.pool,identity,itemId,0,PROJECT,report.snapshot_id);expect(exact.items).toHaveLength(1);expect(exact.items[0].original_snapshot_id).toBe(originalId);expect(exact.original?.snapshot_id).not.toBe(originalId);expect((await projectReadingRecords(db.pool,{spaceId:SPACE,userId:MEMBER},itemId,0,PROJECT,report.snapshot_id)).items).toHaveLength(0);await expect(projectReadingRecords(db.pool,identity,itemId,25,PROJECT,report.snapshot_id)).rejects.toMatchObject({statusCode:422});const versions=new ReaderSourceVersions(db.pool,config());expect((await versions.get(identity,itemId,report.snapshot_id)).plain_text).toContain('Finding D');await expect(versions.get({spaceId:SPACE,userId:MEMBER},itemId,report.snapshot_id)).rejects.toMatchObject({statusCode:404});
 await favoriteMaterial(db.pool,identity,PROJECT,itemId,false);expect((await reading.list(identity,{view:'all',favorite:'only'},PROJECT)).total).toBe(0);expect((await readDeepOperations(db.pool,identity,PROJECT,op.processing_id)).items[0].report).not.toBeNull();
});


it('private deep reading survives a killed worker via canonical recovery, explicit retry and cancel ACK without a read reconciliation',async()=>{
 await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
 await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic private worker recovery'});
 const beforeArtifacts=await w.count('artifacts'),beforeOriginal=(await db.pool.query('SELECT content_hash,extracted_artifact_id FROM source_items WHERE id=$1',[itemId])).rows[0];
 const op=await start();buildServerDist();
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home:root,hostId:HOST});
 const launch=await worker.next(isPrompted(op.run_id!));
 const old=(await new PgRunRepository(db.pool).getRun(SPACE,op.run_id!))!;
 await submit(old,op.processing_id,'Unpublished old attempt');
 await worker.kill();worker=undefined;
 expect((await new PgRunRepository(db.pool).getRun(SPACE,old.id))!.status).toBe('running');
 // The process really died. Only its persisted lease is accelerated, not production policy.
 await db.pool.query("UPDATE jobs SET heartbeat_at=now()-interval '11 minutes',updated_at=now()-interval '11 minutes' WHERE payload_json->>'run_id'=$1",[old.id]);
 worker=await startWorkerProcess({databaseUrl:db.connectionUri,home:root,hostId:HOST});
 expect((await worker.next(isFrame('terminate',old.id))).frame.launch_id).toBe(launch.launchId);
 // Observe raw durable state: neither GET nor a hand-invoked terminal reconciler can finish it.
 expect((await until(()=>db.pool.query('SELECT status FROM extraction_jobs WHERE id=$1',[op.processing_id]),r=>r.rows[0].status==='failed','private orphan domain settlement',150)).rows[0].status).toBe('failed');
 expect((await new PgRunRepository(db.pool).getRun(SPACE,old.id))!.status).toBe('orphaned');
 expect(await w.count('artifacts')).toBe(beforeArtifacts);
 const retry=await start({retry_of:op.processing_id});
 expect(await start({retry_of:op.processing_id})).toMatchObject({processing_id:retry.processing_id,run_id:retry.run_id});
 expect(retry.run_id).not.toBe(old.id);await worker.next(isPrompted(retry.run_id!));
 const current=(await new PgRunRepository(db.pool).getRun(SPACE,retry.run_id!))!;
 await submit(current,retry.processing_id,'Recovered private report');
 worker.send({cmd:'answer',runId:current.id,text:'Checked report submitted.'});
 await until(()=>db.pool.query('SELECT status FROM extraction_jobs WHERE id=$1',[retry.processing_id]),r=>r.rows[0].status==='succeeded','private retry durable publication',150);
 const visible=(await readDeepOperations(db.pool,identity,PROJECT)).items;
 expect(visible.filter(r=>r.report)).toHaveLength(1);expect(visible.find(r=>r.id===retry.processing_id)).toMatchObject({status:'completed',report:{original_snapshot_id:originalId}});
 expect(await w.count('artifacts')).toBe(beforeArtifacts+1);
 const snapshotIds=(await db.pool.query("SELECT id FROM source_snapshots WHERE reading_role='analysis' AND source_item_id=$1",[itemId])).rows;
 expect(snapshotIds).toHaveLength(1);
 const {submitMaterialResults}=await import('../src/modules/sources/materialProcessing/submission.js');
 await expect(submitMaterialResults(config(),old,{})).rejects.toMatchObject({statusCode:403});
 worker.send({cmd:'complete',runId:old.id,launchId:launch.launchId,exitCode:0});await settledCommands(worker);
 expect((await db.pool.query("SELECT id FROM source_snapshots WHERE reading_role='analysis' AND source_item_id=$1",[itemId])).rows).toEqual(snapshotIds);
 const third=await start({rerun_of:retry.processing_id});await worker.next(isPrompted(third.run_id!));
 worker.send({cmd:'cancel_deep',operationId:third.processing_id,projectId:PROJECT,spaceId:SPACE,userId:OWNER});await worker.next(isCancelled);
 await until(()=>db.pool.query('SELECT status,error_code FROM extraction_jobs WHERE id=$1',[third.processing_id]),r=>r.rows[0].status==='failed'&&r.rows[0].error_code==='source_material_cancelled','private cancellation ACK settlement',150);
 expect((await new PgRunRepository(db.pool).getRun(SPACE,third.run_id!))!.status).toBe('cancelled');
 expect((await readDeepOperations(db.pool,identity,PROJECT,third.processing_id)).items[0].status).toBe('cancelled');
 await expect(start({retry_of:third.processing_id})).rejects.toMatchObject({statusCode:409});
 expect(await w.count('runs')).toBe(3);expect(await w.count('artifacts')).toBe(beforeArtifacts+1);
 expect((await db.pool.query('SELECT content_hash,extracted_artifact_id FROM source_items WHERE id=$1',[itemId])).rows[0]).toEqual(beforeOriginal);
 expect((await readDeepOperations(db.pool,{spaceId:SPACE,userId:MEMBER},PROJECT)).items).toEqual([]);
 await worker.stop();worker=undefined;
},60000);
