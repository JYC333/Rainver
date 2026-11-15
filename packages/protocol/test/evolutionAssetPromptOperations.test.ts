import {describe,it,expect} from 'vitest';
import {EVOLUTION_ASSET_OPERATION_SCHEMAS,EVOLUTION_ASSET_QUERY_IDS,PROMPT_OPERATION_SCHEMAS,PROMPT_QUERY_IDS,RUNTIME_CONTEXT_REQUEST_OPERATION_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
const all={...EVOLUTION_ASSET_OPERATION_SCHEMAS,...PROMPT_OPERATION_SCHEMAS,...RUNTIME_CONTEXT_REQUEST_OPERATION_SCHEMAS};
const queries=new Set<string>([...EVOLUTION_ASSET_QUERY_IDS,...PROMPT_QUERY_IDS,'runtime_context.policy.resolve']);
const proposals:Record<string,string>={'evolution.asset.promotion.propose':'proposal','prompt.promotion.propose':'proposal','reading_method.promotion.propose':'proposal','evolution.workflow.save':'conditional_proposal'};
describe('Evolution asset, prompt, Reading Method and Runtime Context request contracts',()=>{
 it('registers 35 human-only, ungrantable entries: keyed commands or unkeyed read-only queries',()=>{
  expect(Object.keys(all)).toHaveLength(35);
  for(const [id,s] of Object.entries(all)){
   const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
   expect(d,id).toMatchObject({allowed_actor_types:['user'],grantable:false,execution:{kind:queries.has(id)?'query':'command',tx:'core_owned'}});
   expect([...d.visibility]).toEqual(['public_api']);
   expect(d.idempotency_required).toBe(!queries.has(id));
   expect(d.side_effects).toBe(queries.has(id)?'none':proposals[id]??'durable');
   if(proposals[id])expect(d).toMatchObject({gate_class:'self_modification',proposal_type:id==='evolution.workflow.save'?'workflow_save':'evolvable_asset_version_promote'});
   else expect(d).toMatchObject({gate_class:null,proposal_type:null});
   expect(s.input.safeParse({unexpected:true}).success,id).toBe(false);
   if(!queries.has(id))expect(s.output.safeParse({space_id:'s',extra:1}).success,id).toBe(false);
  }
 });
 it('keeps lifecycle, scope and Run inputs closed to values the owners define',()=>{
  const t=EVOLUTION_ASSET_OPERATION_SCHEMAS['evolution.asset.version.transition'].input;
  expect(t.safeParse({asset_id:'a',version_id:'v',status:'published'}).success).toBe(false);
  expect(EVOLUTION_ASSET_OPERATION_SCHEMAS['evolution.asset.pin.set'].input.safeParse({asset_id:'a',scope_type:'system',scope_id:'s',version_id:'v'}).success).toBe(false);
  expect(EVOLUTION_ASSET_OPERATION_SCHEMAS['evolution.bundle.create'].input.safeParse({title:'t',proposal_ids:Array.from({length:51},(_,i)=>`p${i}`)}).success).toBe(false);
  const run=EVOLUTION_ASSET_OPERATION_SCHEMAS['evolution.target.run'].output;
  expect(run.safeParse({space_id:'s',status:'not_selected',target_id:'t',selector_decision_id:'d',reason:'No strategy'}).success).toBe(true);
  expect(run.safeParse({space_id:'s',status:'not_selected',target_id:'t',selector_decision_id:'d',reason:'No strategy',run_id:'r'}).success).toBe(false);
  expect(PROMPT_OPERATION_SCHEMAS['reading_method.trial.judge'].input.safeParse({trial_id:'t',judgment:'great',reason:'x'}).success).toBe(false);
  expect(PROMPT_OPERATION_SCHEMAS['reading_method.generation.start'].input.safeParse({source_kind:'logs',parent_version_id:'v',parent_content_hash:'0'.repeat(64),description:'x'}).success).toBe(false);
 });
});
