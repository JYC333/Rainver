import {expect,it} from 'vitest';
import {CROSS_SPACE_RETRIEVAL_OPERATION_SCHEMAS,OPERATION_SCHEMA_TABLE,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
const bodies={
 'personal.retrieval.search':{query:'quantum',resource_types:['knowledge_item'],max_results:7},
 'personal.retrieval.resolve':{pointer_ids:['pointer']},
 'personal.retrieval.summary.store':{pointer_ids:['pointer'],summary:'summary'},
 'personal.retrieval.egress.disclose':{pointer_ids:['pointer','second']},
 'personal.retrieval.fused.store':{pointer_ids:['pointer','second'],disclosure_id:'disclosure',conclusion:'conclusion'},
} as const;
it.each(Object.keys(bodies) as (keyof typeof bodies)[])('%s preserves actual fields and strictly binds a keyed human command',id=>{
 const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
 expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
 expect(d.idempotency_required).toBe(true);expect(d.allowed_actor_types).toEqual(['user']);
 expect([...d.visibility]).toEqual(['public_api']);expect(d.grantable).toBe(false);
 expect(OPERATION_SCHEMA_TABLE[id]).toBe(CROSS_SPACE_RETRIEVAL_OPERATION_SCHEMAS[id]);
 expect(d.input_schema.parse(bodies[id])).toEqual(bodies[id]);
 expect(d.input_schema.safeParse({...bodies[id],space_id:'browsed'}).success).toBe(false);
});
it('keeps unique bounded pointers and the disclosure requirement',()=>{
 expect(OPERATION_SCHEMA_TABLE['personal.retrieval.resolve'].input.safeParse({pointer_ids:['same','same']}).success).toBe(false);
 expect(OPERATION_SCHEMA_TABLE['personal.retrieval.fused.store'].input.safeParse({pointer_ids:['one','two'],conclusion:'x'}).success).toBe(false);
});
