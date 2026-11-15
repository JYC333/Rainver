import {expect,it} from 'vitest';
import {CONTENT_RETRIEVAL_OPERATION_SCHEMAS as schemas,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
it('keeps keyed human content/report and Think requests strict, with identity-only output schemas',()=>{
 expect(Object.keys(schemas)).toHaveLength(21);
 for(const [id,s] of Object.entries(schemas)){
  expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)).toMatchObject({allowed_actor_types:['user'],grantable:false,idempotency_required:true,execution:{kind:'command',tx:'core_owned'}});
  expect(s.input.safeParse({query:'hello',space_id:'untrusted'}).success).toBe(false);
 }
});
it('rejects invalid modes, empty briefs, invalid types and oversized create-safety requests at admission',()=>{
 expect(schemas['knowledge.retrieval.search.request'].input.safeParse({query:'alpha',object_types:['not_a_type']}).success).toBe(false);
 expect(schemas['knowledge.retrieval.search.request'].input.safeParse({query:'alpha',mode:'turbo'}).success).toBe(false);
 expect(schemas['knowledge.retrieval.brief.request'].input.safeParse({query:''}).success).toBe(false);
 expect(schemas['knowledge.retrieval.brief.request'].input.safeParse({query:'alpha',mode:'turbo'}).success).toBe(false);
 expect(schemas['knowledge.create_safety.request'].input.safeParse({object_type:'knowledge_item',title:'Alpha',max_results:500}).success).toBe(false);
});
