import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,beforeEach,afterEach,afterAll,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectResearchModule} from '../src/modules/projectResearch/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {loadConfig,type ServerConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {resolveProviderCommandStore} from '../src/modules/providers/commands/store.js';
import {__setProviderHttpClientForTests} from '../src/modules/providers/invocation/invocation.js';
import {openAiChatResponse} from './support/piAiHttp.js';
import {buildJobHandlerRegistry} from '../src/modules/jobs/workerRuntime.js';
import {ProjectResearchAreaService} from '../src/modules/projectResearch/areaService.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,user:string,project:string,provider:string,root:string,config:ServerConfig,app:ReturnType<typeof buildModuleServer>;
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'rainver-adhoc-operation-'));});
afterAll(async()=>{await rm(root,{recursive:true,force:true});});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','model_providers','source_connectors','source_providers'],{cascade:true});space=randomUUID();user=randomUUID();project=randomUUID();provider=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});
 await db.pool.query("INSERT INTO model_providers(id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at) VALUES($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,now(),now())",[provider,space,user]);
 await db.pool.query('INSERT INTO model_provider_space_grants(id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at) VALUES($1,$2,$3,$4,$4,true,true,now(),now())',[randomUUID(),provider,space,user]);
 config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:root,SERVER_DEBUG:'false'});await resolveProviderCommandStore(config).addPoolCredential(space,user,provider,{api_key:'test-adhoc-key'});
 app=buildModuleServer(config,[projectResearchModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:user});
});
afterEach(async()=>{__setAuthIdentityForTests(null);__setProviderHttpClientForTests(null);await app?.close();});
const body=()=>({project_id:project,prompt:'PRIVATE request',section_key:'understanding',execution:{model_provider_id:provider}});
const call=(input:object=body(),key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/research.ask_ai',payload:input,headers:{'idempotency-key':key}});
const perform=(run:string)=>buildJobHandlerRegistry(config).dispatch({job_id:randomUUID(),space_id:space,user_id:user,job_type:'provider_task_run',attempts:1,max_attempts:1,worker_id:'test-worker',payload:{run_id:run}});
function answer(){return openAiChatResponse({choices:[{message:{content:JSON.stringify({notebook_update:{ops:[{op:'append',index:null,count:null,markdown:'Completed analysis'}],refs:[]}})}}],model:'test-model',usage:{}});}
it('queues one private ProviderTask/Job atomically across formal and generic calls, then the real worker publishes once',async()=>{
 let invocations=0;__setProviderHttpClientForTests({fetch:async()=>{invocations++;return answer();}});const key=randomUUID(),input=body(),{project_id:_,...formalBody}=input;void _;
 const first=await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/ask-ai`,payload:formalBody,headers:{'idempotency-key':key}});expect(first.statusCode,first.body).toBe(201);expect(first.body).not.toContain('PRIVATE');expect(invocations).toBe(0);
 expect((await call(input,key)).json()).toEqual(first.json());expect((await call({...input,prompt:'Changed'},key)).statusCode).toBe(422);const receipt=first.json().data;
 expect((await db.pool.query('SELECT execution_kind,visibility,status FROM runs WHERE id=$1',[receipt.run_id])).rows).toEqual([{execution_kind:'provider_task',visibility:'private',status:'queued'}]);expect((await db.pool.query("SELECT id FROM jobs WHERE payload_json->>'run_id'=$1",[receipt.run_id])).rows).toHaveLength(1);
 await perform(receipt.run_id);expect(invocations).toBe(1);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[receipt.run_id])).rows).toEqual([{status:'succeeded'}]);expect((await db.pool.query('SELECT id FROM note_revisions WHERE created_by_run_id=$1',[receipt.run_id])).rows).toHaveLength(1);
 expect((await call(input,key)).json()).toEqual(first.json());expect((await db.pool.query('SELECT id FROM runs WHERE space_id=$1',[space])).rows).toHaveLength(1);
});
it.each(['jobs','policy_decision_records'])('rolls notebook initialization, Run, required Job and receipt back on %s failure',async table=>{
 await db.pool.query("CREATE FUNCTION refuse_adhoc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE storage failure'; END $$");await db.pool.query(`CREATE TRIGGER refuse_adhoc BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_adhoc()`);
 try{const result=await call();expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(result.body).not.toContain('PRIVATE');for(const table of ['runs','notes','note_collections','operation_idempotency'])expect((await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`,[space])).rows).toEqual([]);}
 finally{await db.pool.query(`DROP TRIGGER refuse_adhoc ON ${table}`);await db.pool.query('DROP FUNCTION refuse_adhoc()');}
});
it('rechecks current Project state before provider dispatch without consuming model work',async()=>{
 let invoked=0;__setProviderHttpClientForTests({fetch:async()=>{invoked++;return answer();}});const queued=await call();expect(queued.statusCode,queued.body).toBe(201);const run=queued.json().data.run_id;await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);await expect(perform(run)).rejects.toThrow();expect(invoked).toBe(0);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows).toEqual([{status:'failed'}]);expect((await db.pool.query('SELECT id FROM note_revisions WHERE created_by_run_id=$1',[run])).rows).toEqual([]);
});
it('retains the original mutation-free reserved-role refusal and serializes concurrent keyed admission',async()=>{
 const service=new ProjectResearchAreaService(db.pool,config),area=await service.initializeArea({spaceId:space,userId:user},project),note=area.notes[0]!.id,peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[note,peer]);const denied=await call();expect(denied.statusCode,denied.body).toBe(404);expect((await db.pool.query('SELECT id FROM runs WHERE space_id=$1',[space])).rows).toEqual([]);
 await db.pool.query("UPDATE space_objects SET visibility='space_shared',owner_user_id=$2 WHERE id=$1",[note,user]);
 const holder=await db.pool.connect();try{await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);const key=randomUUID(),pending=call(body(),key);await waitForLockWaiter(db.pool);const busy=await call(body(),key);expect(busy.statusCode,busy.body).toBe(409);expect(busy.json().error.code).toBe('idempotency_in_progress');await holder.query('COMMIT');expect((await pending).statusCode).toBe(201);}finally{await holder.query('ROLLBACK');holder.release();}
});
it('keeps the existing daily Research ceiling as a safe nonretryable 429 without storing a failed request',async()=>{
 const runs=new PgRunRepository(db.pool);for(let i=0;i<20;i++)await runs.createQueuedProviderTaskRun({space_id:space,user_id:user,trigger_origin:'manual',run_type:'agent',task:'project_research_adhoc_analyze',prompt:'Earlier authorized request',project_id:project,capability_id:'research.adhoc_analyze'});
 const key=randomUUID(),result=await call(body(),key);expect(result.statusCode,result.body).toBe(429);expect(result.json().error).toMatchObject({code:'operation_limit_exceeded',retryable:false,metadata:{code:'research_daily_limit',limit:20}});expect((await db.pool.query('SELECT id FROM runs WHERE space_id=$1',[space])).rows).toHaveLength(20);expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE idempotency_key=$1',[key])).rows).toEqual([]);expect((await db.pool.query('SELECT object_id FROM notes WHERE space_id=$1',[space])).rows).toEqual([]);
});
async function material(visibility='private',connection:string|null=null){const source=randomUUID(),corpus=randomUUID();await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,connection_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'feed_entry','PRIVATE material','PRIVATE excerpt',now(),now(),'excerpt_saved','summary_only',now(),now())",[source,space,user,connection,visibility]);await db.pool.query("INSERT INTO project_corpus_items(id,space_id,project_id,source_item_id,role,status,triage_status,read_status,created_at,updated_at) VALUES($1,$2,$3,$4,'candidate','active','included','unread',now(),now())",[corpus,space,project,source]);await db.pool.query('INSERT INTO project_corpus_item_sources(id,corpus_item_id,space_id,project_id,source_item_id,created_at) VALUES($1,$2,$3,$4,$5,now())',[randomUUID(),corpus,space,project,source]);return source;}
it('refuses to widen a private Source excerpt into a shared Note and rolls its new notebook back',async()=>{
 const source=await material(),peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,peer]);const result=await call({...body(),source_item_ids:[source]});expect(result.statusCode,result.body).toBe(404);expect(result.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM runs WHERE space_id=$1',[space])).rows).toEqual([]);expect((await db.pool.query('SELECT object_id FROM notes WHERE space_id=$1',[space])).rows).toEqual([]);
});
it('applies the original Source egress gate to the fixed ProviderTask destination before enqueue',async()=>{
 const connection=randomUUID();await seedArxivSourceChain(db.pool,{space,owner:user,connection,channel:randomUUID(),connector:randomUUID(),now:new Date().toISOString()});await db.pool.query("UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_external_model_egress}','false'::jsonb),policy_json=$2::jsonb WHERE id=$1",[connection,JSON.stringify({schema_version:1,source_egress_class:'internal_only'})]);const source=await material('space_shared',connection),result=await call({...body(),source_item_ids:[source]});expect(result.statusCode,result.body).toBe(404);expect((await db.pool.query('SELECT id FROM runs WHERE space_id=$1',[space])).rows).toEqual([]);
});
it('rechecks Source consent after the provider answers and rolls publication back when consent was withdrawn',async()=>{
 const connection=randomUUID();await seedArxivSourceChain(db.pool,{space,owner:user,connection,channel:randomUUID(),connector:randomUUID(),now:new Date().toISOString()});const source=await material('space_shared',connection);
 const queued=await call({...body(),source_item_ids:[source]});expect(queued.statusCode,queued.body).toBe(201);const run=queued.json().data.run_id;let invocations=0;
 __setProviderHttpClientForTests({fetch:async()=>{invocations++;await db.pool.query("UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_external_model_egress}','false'::jsonb),policy_json=$2::jsonb WHERE id=$1",[connection,JSON.stringify({schema_version:1,source_egress_class:'internal_only'})]);return answer();}});
 expect(await perform(run)).toMatchObject({status:'failed',error_code:'bounded_provider_task_failed'});expect(invocations).toBe(1);expect((await db.pool.query('SELECT id FROM note_revisions WHERE created_by_run_id=$1',[run])).rows).toEqual([]);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows).toEqual([{status:'failed'}]);
});
it('returns an uncached safe 503 and rolls admission back when mandatory Source read auditing fails',async()=>{
 const source=await material('space_shared'),peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query('UPDATE source_items SET owner_user_id=$2 WHERE id=$1',[source,peer]);
 await db.pool.query("CREATE FUNCTION refuse_adhoc_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE content-read failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_adhoc_read BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION refuse_adhoc_read()');
 try{const result=await call({...body(),source_item_ids:[source]});expect(result.statusCode,result.body).toBe(503);expect(result.json().error).toMatchObject({code:'operation_audit_unavailable',retryable:true});expect(result.body).not.toContain('PRIVATE');for(const table of ['runs','notes','operation_idempotency'])expect((await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`,[space])).rows).toEqual([]);}
 finally{await db.pool.query('DROP TRIGGER refuse_adhoc_read ON content_access_logs');await db.pool.query('DROP FUNCTION refuse_adhoc_read()');}
});
