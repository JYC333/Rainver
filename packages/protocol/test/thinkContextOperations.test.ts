import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {OPERATION_SCHEMA_TABLE,SYSTEM_ACTION_REGISTRY,AskSpaceRequestResultSchema} from '../src/index.js';
it('registers the three strict keyed human commands with preserved defaults and no Agent grant',()=>{
 for(const id of ['ask_space.think','context_ops.review_cycle.run','context_ops.observations.scan'] as const){
  expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)).toMatchObject({allowed_actor_types:['user'],grantable:false,idempotency_required:true,execution:{kind:'command',tx:'core_owned'}});
  const input=id==='ask_space.think'?{query:'Question'}:{};
  expect(OPERATION_SCHEMA_TABLE[id].input.safeParse(input).success).toBe(true);
  expect(OPERATION_SCHEMA_TABLE[id].input.safeParse({...input,user_id:randomUUID()}).success).toBe(false);
 }
 expect(OPERATION_SCHEMA_TABLE['context_ops.review_cycle.run'].input.parse({})).toMatchObject({review_scope:'private',create_packets:true,include_memory_maintenance:true});
 expect(OPERATION_SCHEMA_TABLE['context_ops.observations.scan'].input.parse({})).toMatchObject({window_days:1,persist_report:true});
});
it('keeps Think async acceptance free of answer content and validates the withheld result contract',()=>{
 const id=randomUUID();
 expect(OPERATION_SCHEMA_TABLE['ask_space.think'].output.parse({id,job_id:id,space_id:randomUUID(),status:'pending'})).toMatchObject({job_id:id});
 expect(OPERATION_SCHEMA_TABLE['ask_space.think'].output.safeParse({id,job_id:id,space_id:randomUUID(),status:'pending',answer:'private'}).success).toBe(false);
 expect(AskSpaceRequestResultSchema.parse({job_id:id,status:'completed',result:null,withheld:1})).toMatchObject({result:null,withheld:1});
});
