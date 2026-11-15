import {ResearchQueryEvaluationAcceptedJobSchema} from '../src/researchDiscovery.js';
import {expect,it} from 'vitest';
import {OPERATION_SCHEMA_TABLE,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
const strategy_id='11111111-1111-4111-8111-111111111111';
it.each(['research.strategy.activate','research.strategy.materialize','research.strategy.evaluate','research.strategy.retry'] as const)('%s stays strict, keyed and human-only without approval mapping',id=>{
 const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
 expect(d.execution).toEqual({kind:'command',tx:'core_owned'});expect(d.idempotency_required).toBe(true);
 expect(d.allowed_actor_types).toEqual(['user']);expect([...d.visibility]).toEqual(['public_api']);expect(d.grantable).toBe(false);expect(d.proposal_type).toBeNull();
 const input=id==='research.strategy.evaluate'?{project_id:strategy_id,research_context_version_id:strategy_id,providers:['openalex'],candidate_budget:100}:id==='research.strategy.retry'?{project_id:strategy_id,strategy_id,provider_key:'openalex'}:id==='research.strategy.activate'?{strategy_id,reason:'manual'}:{strategy_id,provider_keys:['openalex']};
 expect(OPERATION_SCHEMA_TABLE[id].input.safeParse(input).success).toBe(true);
 for(const field of ['user_id','space_id','approved_by_user','run_id'])expect(d.input_schema.safeParse({...input,[field]:'untrusted'}).success).toBe(false);
});

it('validates queued evaluation receipts without fabricating a model Run',()=>{
 const input={job_id:'11111111-1111-4111-8111-111111111111',strategy_id:'22222222-2222-4222-8222-222222222222',run_id:null,status:'queued'};
 expect(ResearchQueryEvaluationAcceptedJobSchema.parse(input)).toEqual(input);
 expect(ResearchQueryEvaluationAcceptedJobSchema.safeParse({...input,approved_by_user:true}).success).toBe(false);
 expect(ResearchQueryEvaluationAcceptedJobSchema.safeParse({...input,run_id:'unknown'}).success).toBe(false);
});
