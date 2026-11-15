import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {researchModule} from '../src/modules/research/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {fileURLToPath} from 'node:url';
import {syncBuiltinPrompts} from '../src/modules/prompts/builtins.js';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import type {OperationActor} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {resetTables} from './support/resetTables.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {providerTaskTestConfig,seedTestModelProvider} from './support/providerTaskFixture.js';
import {openAiChatResponse} from './support/piAiHttp.js';
import {__setProviderHttpClientForTests} from '../src/modules/providers/invocation/invocation.js';
import {withQueryableTransaction} from '../src/modules/routeUtils/common.js';
import {JobHandlerRegistry,type JobEnvelopeForHandler} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {performJobEffect} from '../src/modules/jobs/effectAuthority.js';
import {ResearchContextRepository} from '../src/modules/projectResearch/question/researchContextRepository.js';
import {ResearchQueryRepository} from '../src/modules/research/queryPlanning/repository.js';
import {requestRunJob,registerResearchEvaluationJob,RESEARCH_EVALUATION_JOB,type ResearchEvaluationInput} from '../src/modules/research/evaluationJob.js';
const db=useTestDatabase(import.meta.url,{max:6});
const space=randomUUID(),user=randomUUID(),project=randomUUID(),identity={spaceId:space,userId:user};
const actor:OperationActor={principal:{kind:'user',id:user},on_behalf_of_user_id:user,agent_id:null,run_id:null,origin:'manual',effective_origin:'manual',root_run_id:null,continuation_hops:0,surface:'web',space_id:space};
const config=()=>providerTaskTestConfig(db.connectionUri,`/tmp/rainver-research-evaluation-${process.pid}`);
afterEach(()=>{__setProviderHttpClientForTests(null);__setAuthIdentityForTests(null);});
beforeEach(async()=>{if(!db.available)return;await resetTables(db.pool,['model_provider_space_grants','model_providers','spaces','users','source_providers','source_connectors'],{cascade:true});await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});});
async function seed(){
 const context=await new ResearchContextRepository(db.pool).create(identity,project,{schema_version:'research_context.v1',objective:'Agent memory evaluation',sub_questions:[],in_scope:['agent memory'],out_of_scope:[],must_have:[],nice_to_have:[],time_window:null,source_scope:{providers:['openalex'],include_web:false}},{assessment:{answerable:true,finer:{feasible:4,interesting:4,novel:4,ethical:4,relevant:4}}});
 const strategy=await new ResearchQueryRepository(db.pool).createStrategy(identity,{projectId:project,researchContextVersionId:context.id,providers:['openalex'],policyVersion:'adaptive-recall.v1',policy:{},executionBudget:{candidate_budget:100,provider_candidate_budget:100}});
 const input:ResearchEvaluationInput={kind:'evaluate',request:{project_id:project,research_context_version_id:context.id,providers:['openalex'],candidate_budget:100}};
 return {strategy,input,context};
}
const request=(id:string,input:ResearchEvaluationInput)=>withQueryableTransaction(db.pool,tx=>requestRunJob(tx,config(),actor,id,input));
async function claim():Promise<JobEnvelopeForHandler>{
 const q=new PgJobQueueRepository(db.pool),j=await q.claimNext('evaluation-test',[RESEARCH_EVALUATION_JOB]);expect(j).not.toBeNull();await q.startJob(j!.id,'evaluation-test');
 return {job_id:j!.id,space_id:space,user_id:user,job_type:RESEARCH_EVALUATION_JOB,worker_id:'evaluation-test',attempts:j!.attempts,max_attempts:j!.max_attempts,payload:j!.payload_json};
}
function handler(effect?:()=>Promise<void>){
 let sends=0;const r=new JobHandlerRegistry();
 registerResearchEvaluationJob(r,config(),{previewGateway:{preview:async()=>performJobEffect(async()=>{sends++;await effect?.();return {providerHitCount:20,accessibleHitCount:20,candidates:[]};})},assessor:{assess:()=>({schema_version:'research_preview_observation.v1',provider_hit_count:20,accessible_hit_count:20,samples:[],relevance_rate:0.8,relevance_lower_bound:0.6,diversity_score:0.7,duplicate_rate:0})}});
 return {run:(j:JobEnvelopeForHandler)=>r.dispatch(j),sends:()=>sends};
}
it('deduplicates admission and settles strategy, Run and exact Job receipt atomically',async()=>{
 const {strategy,input}=await seed(),accepted=await request(strategy.id,input);expect(await request(strategy.id,input)).toEqual(accepted);
 const job=await claim(),h=handler(),out=await h.run(job);expect(h.sends()).toBe(2);expect(out).toMatchObject({strategy:{id:strategy.id,status:'selected'}});
 expect(await new PgJobQueueRepository(db.pool).confirmCompletedJob(job.job_id,out,job.worker_id,job.attempts)).toBe(true);
 expect(accepted.run_id).toBeNull();expect((await db.pool.query('SELECT id FROM runs WHERE space_id=$1',[space])).rowCount).toBe(0);
 expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[space])).rowCount).toBe(1);
});
it('Project withdrawal prevents every send and leaves strategy untouched',async()=>{
 const {strategy,input}=await seed();await request(strategy.id,input);const job=await claim();
 await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[project]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,user]);
 const h=handler();await expect(h.run(job)).rejects.toBeDefined();expect(h.sends()).toBe(0);expect((await new ResearchQueryRepository(db.pool).getStrategy(space,project,strategy.id))?.status).toBe('planning');
});
it('stale claim cannot send, settle or fail the newer attempt',async()=>{
 const {strategy,input}=await seed(),accepted=await request(strategy.id,input),job=await claim();await db.pool.query('UPDATE jobs SET attempts=attempts+1 WHERE id=$1',[job.job_id]);
 const h=handler();await expect(h.run(job)).rejects.toBeDefined();expect(h.sends()).toBe(0);expect(accepted.run_id).toBeNull();
});
it('unknown send refuses replacement intent and publishes no partial strategy',async()=>{
 const {strategy,input}=await seed();await request(strategy.id,input);const job=await claim(),h=handler(async()=>{throw Object.assign(new Error('outcome unknown'),{name:'TimeoutError'});});
 await expect(h.run(job)).rejects.toBeDefined();expect(h.sends()).toBe(1);await expect(request(strategy.id,input)).rejects.toMatchObject({statusCode:409});
 expect((await db.pool.query('SELECT id FROM research_query_attempts WHERE space_id=$1',[space])).rowCount).toBe(0);expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[space])).rowCount).toBe(1);
});
it('late audit failure rolls back attempts, strategy, Run output and Job receipt',async()=>{
 const {strategy,input}=await seed(),accepted=await request(strategy.id,input),job=await claim();let effects=0;
 const h=handler(async()=>{if(++effects!==2)return;await db.pool.query("CREATE FUNCTION reject_evaluation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late evaluation audit failure'; END $$");await db.pool.query('CREATE CONSTRAINT TRIGGER reject_evaluation_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_evaluation_audit()');});
 try{await expect(h.run(job)).rejects.toBeDefined();expect(h.sends()).toBe(2);expect((await db.pool.query('SELECT id FROM research_query_attempts WHERE space_id=$1',[space])).rowCount).toBe(0);expect(accepted.run_id).toBeNull();expect((await new PgJobQueueRepository(db.pool).getJob(job.job_id))?.status).toBe('running');}
 finally{await db.pool.query('DROP TRIGGER reject_evaluation_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION reject_evaluation_audit()');}
 expect((await request(strategy.id,input)).job_id).toBe(job.job_id);const replay=handler();await expect(replay.run(job)).rejects.toBeDefined();expect(replay.sends()).toBe(0);
});
it('proved failure before send permits one replacement Job',async()=>{
 const {strategy,input,context}=await seed(),accepted=await request(strategy.id,input),job=await claim();await db.pool.query("UPDATE project_research_context_versions SET assessment_json='{}'::jsonb WHERE id=$1",[context.id]);
 const h=handler();await expect(h.run(job)).rejects.toBeDefined();expect(h.sends()).toBe(0);expect((await request(strategy.id,input)).job_id).not.toBe(accepted.job_id);
});

it('uses the same handler for explicit provider retry, preserving its strategy identity',async()=>{
 const {strategy,input}=await seed();await request(strategy.id,input);await handler().run(await claim());
 const retry:ResearchEvaluationInput={kind:'retry',provider_key:'openalex',request:{project_id:project}};
 const accepted=await request(strategy.id,retry);expect(await request(strategy.id,retry)).toEqual(accepted);
 const h=handler(),result=await h.run(await claim());expect(h.sends()).toBe(2);expect(result).toMatchObject({strategy:{id:strategy.id,status:'selected'}});
 expect((await db.pool.query('SELECT round FROM research_query_attempts WHERE space_id=$1 ORDER BY round',[space])).rows.map(r=>r.round)).toEqual([0,1]);
});
it('withdrawal after provider I/O withholds every staged result at settlement',async()=>{
 const {strategy,input}=await seed();await request(strategy.id,input);const job=await claim();let effects=0;
 const h=handler(async()=>{if(++effects!==2)return;await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[project]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,user]);});
 await expect(h.run(job)).rejects.toBeDefined();expect(h.sends()).toBe(2);
 expect((await db.pool.query('SELECT id FROM research_query_attempts WHERE space_id=$1',[space])).rowCount).toBe(0);
 expect((await new ResearchQueryRepository(db.pool).getStrategy(space,project,strategy.id))?.status).toBe('planning');
});

async function seedPlanner(){
 await syncBuiltinPrompts(db.pool,fileURLToPath(new URL('../../catalog',import.meta.url)),['research_query.intent_plan']);
 return seedTestModelProvider(db.pool,{space,owner:user,config:config()});
}
it('binds actual model planning to one bounded Run and settles its trusted attempt',async()=>{
 const {strategy,input}=await seed(),provider=await seedPlanner();
 input.request.execution={model_provider_id:provider,model_name:'test-model'};let sends=0;
 __setProviderHttpClientForTests({fetch:async()=>{sends++;return openAiChatResponse({choices:[{message:{content:JSON.stringify({core:[{value:'agent memory',synonyms:[],weight:1}],expansions:[],qualifiers:[],exclusions:[]})}}],model:'test-model',usage:{}});}});
 const accepted=await request(strategy.id,input);expect(accepted.run_id).not.toBeNull();const out=await handler().run(await claim());expect(out).toMatchObject({strategy:{status:'selected'}});expect(sends).toBe(1);
 const run=(await db.pool.query('SELECT status,agent_id,provider_task_control_id,provider_task_delivery_id,provider_task_snapshot_id FROM runs WHERE id=$1',[accepted.run_id])).rows[0];
 expect(run.status).toBe('succeeded');expect(run.agent_id).toBeNull();for(const field of ['provider_task_control_id','provider_task_delivery_id','provider_task_snapshot_id'])expect(run[field]).not.toBeNull();
});
it('model network ambiguity neither retries its key nor authorizes a replacement Job',async()=>{
 const {strategy,input}=await seed(),provider=await seedPlanner();
 input.request.execution={model_provider_id:provider};let sends=0;
 __setProviderHttpClientForTests({fetch:async()=>{sends++;throw new TypeError('fetch failed');}});
 await request(strategy.id,input);await expect(handler().run(await claim())).rejects.toBeDefined();expect(sends).toBe(1);await expect(request(strategy.id,input)).rejects.toMatchObject({statusCode:409});
});

const formalRequest=(app:ReturnType<typeof buildModuleServer>,input:ResearchEvaluationInput,key='formal-evaluation')=>app.inject({method:'POST',url:'/api/v1/research/query-strategies/evaluate',headers:{'idempotency-key':key},payload:input.request});
it('formal evaluation accepts one Job, replays, executes and releases only its typed result',async()=>{
 const {input}=await seed();__setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]);
 try{
  const response=await formalRequest(app,input);expect(response.statusCode,response.body).toBe(202);
  const accepted=response.json().data;expect(accepted.run_id).toBeNull();expect((await formalRequest(app,input)).json()).toEqual(response.json());
  const pending=await app.inject({method:'GET',url:`/api/v1/research/query-evaluations/${accepted.job_id}`});expect(pending.statusCode,pending.body).toBe(200);expect(pending.json()).toMatchObject({status:'queued',result:null});
  const h=handler();await h.run(await claim());expect(h.sends()).toBe(2);
  const result=await app.inject({method:'GET',url:`/api/v1/research/query-evaluations/${accepted.job_id}`});expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({status:'succeeded',strategy_id:accepted.strategy_id,result:{strategy:{id:accepted.strategy_id,status:'selected'}}});
  await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[project]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,user]);
  expect((await formalRequest(app,input)).statusCode).toBe(404);expect((await app.inject({method:'GET',url:`/api/v1/research/query-evaluations/${accepted.job_id}`})).statusCode).toBe(404);
 }finally{await app.close();}
});
it('formal initial admission rejects inherited context withdrawal before creating a strategy',async()=>{
 const {input,context}=await seed(),other=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Inherited','active',now(),now())",[other,space,user]);
 const inherited=await new ResearchContextRepository(db.pool).create(identity,other,context.context);
 await db.pool.query('UPDATE project_research_context_versions SET provenance_json=$2::jsonb WHERE id=$1',[context.id,JSON.stringify({inherited_context_id:inherited.id})]);
 await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[other]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,user]);
 __setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]);
 try{const r=await formalRequest(app,input);expect(r.statusCode,r.body).toBe(404);expect((await db.pool.query('SELECT id FROM research_query_strategies WHERE space_id=$1',[space])).rowCount).toBe(1);expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[space])).rowCount).toBe(0);}finally{await app.close();}
});
it('formal late audit failure rolls back the fresh strategy, Job and receipt',async()=>{
 const {input}=await seed();__setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]);
 await db.pool.query("CREATE FUNCTION reject_formal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");await db.pool.query('CREATE CONSTRAINT TRIGGER reject_formal_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_formal_audit()');
 try{const r=await formalRequest(app,input);expect(r.statusCode,r.body).toBe(503);expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[space])).rowCount).toBe(0);expect((await db.pool.query('SELECT id FROM research_query_strategies WHERE space_id=$1',[space])).rowCount).toBe(1);}
 finally{await db.pool.query('DROP TRIGGER reject_formal_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION reject_formal_audit()');await app.close();}
});
it('cross-strategy fresh keys cannot bypass unknown sends for the same context intent',async()=>{
 const {strategy,input,context}=await seed();await request(strategy.id,input);const h=handler(async()=>{throw new TypeError('unknown send');});await expect(h.run(await claim())).rejects.toBeDefined();expect(h.sends()).toBe(1);
 const next=await new ResearchQueryRepository(db.pool).createStrategy(identity,{projectId:project,researchContextVersionId:context.id,providers:['openalex'],policyVersion:'adaptive-recall.v1',policy:{},executionBudget:{candidate_budget:100,provider_candidate_budget:100}});
 await expect(request(next.id,input)).rejects.toMatchObject({statusCode:409});
 __setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]);try{const r=await formalRequest(app,input,'new-key');expect(r.statusCode,r.body).toBe(409);expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[space])).rowCount).toBe(1);expect((await db.pool.query('SELECT id FROM research_query_strategies WHERE space_id=$1',[space])).rowCount).toBe(2);}finally{await app.close();}
});
it('formal provider retry uses the same queued owner and preserves strategy identity',async()=>{
 const {strategy,input}=await seed();await request(strategy.id,input);await handler().run(await claim());__setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]);
 try{const response=await app.inject({method:'POST',url:`/api/v1/research/query-strategies/${strategy.id}/providers/openalex/retry`,headers:{'idempotency-key':'formal-retry'},payload:{project_id:project}});expect(response.statusCode,response.body).toBe(202);expect(response.json().data.strategy_id).toBe(strategy.id);const h=handler();await h.run(await claim());expect(h.sends()).toBe(2);const result=await app.inject({method:'GET',url:`/api/v1/research/query-evaluations/${response.json().data.job_id}`});expect(result.json()).toMatchObject({status:'succeeded',result:{strategy:{id:strategy.id,status:'selected'}}});}finally{await app.close();}
});
it('formal business replay with a fresh key reuses the completed strategy without creating another version',async()=>{
 const {input}=await seed();__setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]);
 try{
  const first=await formalRequest(app,input);expect(first.statusCode,first.body).toBe(202);await handler().run(await claim());
  const next=await formalRequest(app,input,'another-key');expect(next.statusCode,next.body).toBe(202);expect(next.json().data).toMatchObject({job_id:first.json().data.job_id,strategy_id:first.json().data.strategy_id,status:'succeeded'});
  expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[space])).rowCount).toBe(1);expect((await db.pool.query('SELECT id FROM research_query_strategies WHERE space_id=$1',[space])).rowCount).toBe(2);
 }finally{await app.close();}
});
it('formal result consumers recheck inherited authority on strategy lists and attempt pages',async()=>{
 const {strategy,input,context}=await seed(),other=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Inherited','active',now(),now())",[other,space,user]);
 const inherited=await new ResearchContextRepository(db.pool).create(identity,other,context.context);
 await db.pool.query('UPDATE project_research_context_versions SET provenance_json=$2::jsonb WHERE id=$1',[context.id,JSON.stringify({inherited_context_id:inherited.id})]);
 await request(strategy.id,input);await handler().run(await claim());__setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]);
 const list=()=>app.inject({method:'GET',url:`/api/v1/projects/${project}/research/query-strategies`});
 const attempts=()=>app.inject({method:'GET',url:`/api/v1/research/query-strategies/${strategy.id}/providers/openalex/attempts?project_id=${project}`});
 try{
  expect((await list()).statusCode).toBe(200);expect((await attempts()).statusCode).toBe(200);
  await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[other]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,user]);
  expect([403,404]).toContain((await list()).statusCode);expect([403,404]).toContain((await attempts()).statusCode);
 }finally{await app.close();}
});

it('formal evaluation rereads Source consent before admission, receipt replay and result release',async()=>{
 const {input}=await seed(),connection=randomUUID();
 await seedArxivSourceChain(db.pool,{space,owner:user,connector:randomUUID(),connection,channel:randomUUID(),now:new Date().toISOString()});
 const source=(await db.pool.query('SELECT provider_id FROM source_provider_connectors WHERE id=(SELECT provider_connector_id FROM source_connections WHERE id=$1)',[connection])).rows[0];
 await db.pool.query("UPDATE source_providers SET provider_key='openalex' WHERE id=$1",[source.provider_id]);
 __setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]);
 const consent=(await db.pool.query('SELECT consent_json FROM source_connections WHERE id=$1',[connection])).rows[0].consent_json;
 try{
  await db.pool.query("UPDATE source_connections SET consent_json='{}'::jsonb WHERE id=$1",[connection]);
  expect((await formalRequest(app,input,'withdrawn')).statusCode).toBe(404);expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[space])).rowCount).toBe(0);
  await db.pool.query('UPDATE source_connections SET consent_json=$2::jsonb WHERE id=$1',[connection,JSON.stringify(consent)]);
  const first=await formalRequest(app,input);expect(first.statusCode,first.body).toBe(202);await handler().run(await claim());
  await db.pool.query("UPDATE source_connections SET consent_json='{}'::jsonb WHERE id=$1",[connection]);
  expect((await formalRequest(app,input)).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:`/api/v1/research/query-evaluations/${first.json().data.job_id}`})).statusCode).toBe(404);
 }finally{await app.close();}
});

it('formal result waits for the actual Source consent writer and refuses the committed withdrawal',async()=>{
 const {input}=await seed(),connection=randomUUID();
 await seedArxivSourceChain(db.pool,{space,owner:user,connector:randomUUID(),connection,channel:randomUUID(),now:new Date().toISOString()});
 const source=(await db.pool.query('SELECT provider_id FROM source_provider_connectors WHERE id=(SELECT provider_connector_id FROM source_connections WHERE id=$1)',[connection])).rows[0];
 await db.pool.query("UPDATE source_providers SET provider_key='openalex' WHERE id=$1",[source.provider_id]);
 __setAuthIdentityForTests(identity);const app=buildModuleServer(config(),[researchModule]),writer=await db.pool.connect();
 try{
  const first=await formalRequest(app,input);expect(first.statusCode,first.body).toBe(202);await handler().run(await claim());
  await writer.query('BEGIN');const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await writer.query("UPDATE source_connections SET consent_json='{}'::jsonb WHERE id=$1",[connection]);
  let settled=false;const read=app.inject({method:'GET',url:`/api/v1/research/query-evaluations/${first.json().data.job_id}`}).then(r=>{settled=true;return r;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>settled});expect(settled).toBe(false);
  await writer.query('COMMIT');expect((await read).statusCode).toBe(404);
 }finally{await writer.query('ROLLBACK');writer.release();await app.close();}
});
