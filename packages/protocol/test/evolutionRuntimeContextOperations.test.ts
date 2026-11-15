import {describe,it,expect} from 'vitest';
import {EVOLUTION_OPERATION_SCHEMAS,RUNTIME_CONTEXT_OPERATION_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
describe('Evolution target/signal and Runtime Context operation contracts',()=>{
 it('keeps every command human-only, keyed, ungrantable and strict without an approval mapping',()=>{
  const all={...EVOLUTION_OPERATION_SCHEMAS,...RUNTIME_CONTEXT_OPERATION_SCHEMAS};
  expect(Object.keys(all)).toHaveLength(9);
  for(const [id,s] of Object.entries(all)){
   const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
   expect(d).toMatchObject({allowed_actor_types:['user'],grantable:false,idempotency_required:true,proposal_type:null,gate_class:null,execution:{kind:'command',tx:'core_owned'}});
   expect([...d.visibility]).toEqual(['public_api']);
   expect(s.input.safeParse({unexpected:true}).success).toBe(false);
   // Receipts are identity only.
   expect(s.output.safeParse({space_id:'s',extra:1}).success).toBe(false);
  }
 });
 it('accepts only supported target types, risks and severities, and pins defaults',()=>{
  const create=EVOLUTION_OPERATION_SCHEMAS['evolution.target.create'].input;
  expect(create.parse({target_type:'workflow'})).toMatchObject({risk_level:'medium',status:'active',enabled:true});
  for(const target_type of ['capability','runtime_skill_binding'])expect(create.safeParse({target_type}).success).toBe(false);
  expect(create.safeParse({target_type:'memory',risk_level:'extreme'}).success).toBe(false);
  expect(EVOLUTION_OPERATION_SCHEMAS['evolution.signal.create'].input.safeParse({target_id:'t',signal_type:'x',source_type:'manual',severity:'loud'}).success).toBe(false);
  expect(EVOLUTION_OPERATION_SCHEMAS['evolution.signal.triage'].input.safeParse({signal_id:'s',triage_status:'closed'}).success).toBe(false);
 });
});
