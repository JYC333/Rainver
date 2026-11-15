import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {resetTables} from './support/resetTables.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {researchModule} from '../src/modules/research/index.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {ResearchContextRepository} from '../src/modules/projectResearch/question/researchContextRepository.js';
import {ResearchQueryRepository} from '../src/modules/research/queryPlanning/repository.js';
const db=useTestDatabase(import.meta.url,{max:6});
const space=randomUUID(),user=randomUUID(),project=randomUUID(),identity={spaceId:space,userId:user};
let app:ReturnType<typeof buildModuleServer>;
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
 await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});
 const connector=randomUUID(),provider=randomUUID();
 await db.pool.query("INSERT INTO source_connectors(id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at) VALUES($1,'openalex_api','OpenAlex','external_feed','pull','active','{}',now(),now())",[connector]);
 await db.pool.query("INSERT INTO source_providers(id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at) VALUES($1,'openalex','OpenAlex','generic','academic','active','{}',now(),now())",[provider]);
 await db.pool.query("INSERT INTO source_provider_connectors(id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at) VALUES($1,$2,$3,'active',0,'{}',now(),now())",[randomUUID(),provider,connector]);
 __setAuthIdentityForTests(identity);app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[researchModule]);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
async function selected(contextId?:string){
 const context=contextId??(await new ResearchContextRepository(db.pool).create(identity,project,{schema_version:'research_context.v1',objective:'How should agent memory be evaluated?',sub_questions:[],in_scope:[],out_of_scope:[],must_have:[],nice_to_have:[],time_window:null,source_scope:{providers:['openalex'],include_web:false}})).id;
 const repo=new ResearchQueryRepository(db.pool),strategy=await repo.createStrategy(identity,{projectId:project,researchContextVersionId:context,providers:['openalex'],policyVersion:'adaptive-recall.v1',policy:{},executionBudget:{candidate_budget:100}});
 await repo.markStrategyEvaluating(space,strategy.id);
 const attempt=await repo.createAttempt(space,{providerPlanId:strategy.provider_plans[0]!.id,round:0,sequence:1,direction:'initial',semanticQuery:{schema_version:'research_semantic_query.v1',core:[{value:'agent memory',synonyms:[],weight:1}],expansions:[],qualifiers:[],exclusions:[],time_window:null},compiledQuery:{schema_version:'research_compiled_query.v1',provider_key:'openalex',query:{search:'agent memory',per_page:15},fingerprint:'1234567890abcdef1234567890abcdef'}});
 await repo.completeAttempt(space,attempt.id,{score:0.8,decision:'accept',observation:{schema_version:'research_preview_observation.v1',provider_hit_count:20,accessible_hit_count:20,samples:[],relevance_rate:0.8,relevance_lower_bound:0.6,diversity_score:0.7,duplicate_rate:0}});await repo.selectAttempt(space,strategy.provider_plans[0]!.id,attempt.id,{terminalDecision:'accept'});await repo.finalizeStrategy(space,strategy.id);
 return {id:strategy.id,context};
}
const materialize=(id:string,key='materialize')=>app.inject({method:'POST',url:`/api/v1/research/query-strategies/${id}/materialize`,headers:{'idempotency-key':key},payload:{provider_keys:['openalex']}});
const activate=(id:string,key='activate')=>app.inject({method:'POST',url:`/api/v1/research/query-strategies/${id}/activate`,headers:{'idempotency-key':key},payload:{reason:'manual'}});
it('canonical materialization and activation replay create no duplicate effects',async()=>{
 const s=await selected(),first=await materialize(s.id);expect(first.statusCode,first.body).toBe(201);expect(first.json().status).toBe('succeeded');
 expect((await materialize(s.id)).json()).toEqual(first.json());expect((await db.pool.query('SELECT id FROM source_channels WHERE space_id=$1',[space])).rows).toHaveLength(1);
 const active=await activate(s.id);expect(active.statusCode,active.body).toBe(200);expect((await activate(s.id)).json()).toEqual(active.json());
});
it('activation replay cannot switch back after a later materialized strategy',async()=>{
 const a=await selected();expect((await materialize(a.id)).statusCode).toBe(201);const first=await activate(a.id);expect(first.statusCode,first.body).toBe(200);
 const b=await selected(a.context);const second=await materialize(b.id,'second');expect(second.statusCode,second.body).toBe(201);
 expect((await activate(a.id)).json()).toEqual(first.json());
 expect((await db.pool.query('SELECT strategy_id FROM research_query_strategy_activations WHERE space_id=$1 AND deactivated_at IS NULL',[space])).rows).toEqual([{strategy_id:b.id}]);
});
it('withholds both receipts after Project writer revocation',async()=>{
 const s=await selected();expect((await materialize(s.id)).statusCode).toBe(201);expect((await activate(s.id)).statusCode).toBe(200);
 await db.pool.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[project]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,user]);
 expect((await materialize(s.id)).statusCode).toBe(404);expect((await activate(s.id)).statusCode).toBe(404);
});
it('late audit failure rolls back channels, activation and receipt, same key recovers',async()=>{
 const s=await selected();await db.pool.query("CREATE FUNCTION refuse_strategy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_strategy_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_strategy_audit()');
 try{const r=await materialize(s.id);expect(r.statusCode,r.body).toBe(503);expect((await db.pool.query('SELECT id FROM source_channels WHERE space_id=$1',[space])).rows).toHaveLength(0);expect((await db.pool.query('SELECT id FROM research_query_strategy_activations WHERE space_id=$1',[space])).rows).toHaveLength(0);}
 finally{await db.pool.query('DROP TRIGGER refuse_strategy_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_strategy_audit()');}
 expect((await materialize(s.id)).statusCode).toBe(201);
});
it('requires keys and refuses body targets and approval flags',async()=>{
 const s=await selected();for(const payload of [{reason:'manual',strategy_id:s.id},{reason:'manual',approved_by_user:true}])expect((await app.inject({method:'POST',url:`/api/v1/research/query-strategies/${s.id}/activate`,headers:{'idempotency-key':'bad'},payload})).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:`/api/v1/research/query-strategies/${s.id}/activate`,payload:{reason:'manual'}})).statusCode).toBe(422);
});
it('Source withdrawal withholds both old receipts',async()=>{
 const s=await selected();expect((await materialize(s.id)).statusCode).toBe(201);expect((await activate(s.id)).statusCode).toBe(200);
 await db.pool.query('UPDATE source_connections SET deleted_at=now() WHERE space_id=$1',[space]);
 expect((await materialize(s.id)).statusCode).toBe(404);expect((await activate(s.id)).statusCode).toBe(404);
});
it('activation requires a materialized terminal strategy and distinct-key concurrency is serialized',async()=>{
 const s=await selected();expect((await activate(s.id,'premature')).statusCode).toBe(409);expect((await materialize(s.id)).statusCode).toBe(201);
 const responses=await Promise.all([activate(s.id,'one'),activate(s.id,'two')]);
 expect(responses.every(r=>r.statusCode===200||r.statusCode===409)).toBe(true);expect(responses.some(r=>r.statusCode===200)).toBe(true);
 for(let n=0;n<responses.length;n++)if(responses[n]!.statusCode===409)expect((await activate(s.id,n===0?'one':'two')).statusCode).toBe(200);
 expect((await db.pool.query('SELECT id FROM research_query_strategy_activations WHERE space_id=$1',[space])).rows).toHaveLength(1);
});

it('Project fence rechecks a revocation committed while admission waits',async()=>{
 const s=await selected();await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,user]);
 const holder=await db.pool.connect();let result:Awaited<ReturnType<typeof materialize>>|undefined;
 try{await holder.query('BEGIN');const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await holder.query('UPDATE projects SET owner_user_id=NULL WHERE id=$1',[project]);
  const pending=materialize(s.id).then(r=>{result=r;return r;});await waitForBlockedBy(db.pool,pid,{settled:()=>!!result});expect(result).toBeUndefined();await holder.query('COMMIT');expect((await pending).statusCode).toBe(404);
 }finally{await holder.query('ROLLBACK');holder.release();}
});
