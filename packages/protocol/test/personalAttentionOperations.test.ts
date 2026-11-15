import {expect,it} from 'vitest';
import {OPERATION_SCHEMA_TABLE,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
const ids=['personal_memory_grant.preview','personal_memory_grant.create','personal_memory_grant.revoke','attention.views.record','attention.read_state.change'] as const;
it.each(ids)('%s is a strict keyed person command with no approval mapping',id=>{
 const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
 expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
 expect(d.idempotency_required).toBe(true);expect(d.allowed_actor_types).toEqual(['user']);
 expect([...d.visibility]).toEqual(['public_api']);expect(d.grantable).toBe(false);
 expect(OPERATION_SCHEMA_TABLE[id].input.safeParse({extra:true}).success).toBe(false);
});
it('grant filters and run scope never admit raw context or extra capability fields',()=>{
 const input={target_space_id:'space',target_run_id:'run',access_mode:'summary_only'};
 const schema=OPERATION_SCHEMA_TABLE['personal_memory_grant.create'].input;
 expect(schema.safeParse(input).success).toBe(true);
 expect(schema.safeParse({...input,memory_filter:{max_items:5,raw:true}}).success).toBe(false);
 expect(schema.safeParse({...input,access_mode:'raw'}).success).toBe(false);
 expect(schema.safeParse({...input,target_agent_id:'agent'}).success).toBe(false);
});
