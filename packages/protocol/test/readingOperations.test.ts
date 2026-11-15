import { expect, it } from 'vitest';
import { READING_OPERATION_SCHEMAS, SYSTEM_ACTION_REGISTRY } from '../src/index.js';
it('keeps the private preference command strict and human-only without approval or spending', () => {
  const schema=READING_OPERATION_SCHEMAS['reading.preference.set'].input;
  expect(schema.parse({space_id:'space',project_id:'project',show_in_my_reading:true})).toEqual({space_id:'space',project_id:'project',show_in_my_reading:true});
  expect(()=>schema.parse({space_id:'space',project_id:'project',show_in_my_reading:true,user_id:'other'})).toThrow();
  expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='reading.preference.set')).toMatchObject({allowed_actor_types:['user'],side_effects:'durable',idempotency_required:true,proposal_type:null,policy_action:'reading.preference.write',execution:{kind:'command',tx:'core_owned'}});
});
it.each(['reading.favorite.set','reading.project_state.set','reading.personal_state.set'] as const)('%s requires an exact private typed target and human actor',id=>{
 const schema=READING_OPERATION_SCHEMAS[id].input;
 const input={space_id:'space',item_id:'item',...(id==='reading.personal_state.set'?{}:{project_id:'project'}),...(id==='reading.favorite.set'?{favorite:true}:{dismissed:false})};
 expect(schema.parse(input)).toEqual(input);
 expect(()=>schema.parse({...input,user_id:'other'})).toThrow();
 expect(()=>schema.parse({space_id:'space',item_id:'item',project_id:'project'})).toThrow();
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)).toMatchObject({allowed_actor_types:['user'],side_effects:'durable',idempotency_required:true,proposal_type:null,policy_action:'reading.item_state.write',execution:{kind:'command',tx:'core_owned'}});
});
it.each([
 ['reading.composition.retry',{space_id:'space',project_id:'project'}],
 ['reading.deep_read.start',{space_id:'space',project_id:'project',item_id:'item',agent_id:'agent',runtime_profile_id:'profile',retry_of:'operation'}],
 ['reading.deep_read.cancel',{space_id:'space',project_id:'project',operation_id:'operation'}],
 ['reading.annotation.retry',{space_id:'space',episode_id:'episode',connection_id:'connection'}],
] as const)('%s has an explicit keyed human command contract', (id,input)=>{
 const schema=READING_OPERATION_SCHEMAS[id].input;
 expect(schema.parse(input)).toEqual(input);
 expect(()=>schema.parse({...input,user_id:'other'})).toThrow();
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)).toMatchObject({allowed_actor_types:['user'],side_effects:'durable',idempotency_required:true,proposal_type:null,policy_action:id,execution:{kind:'command',tx:'core_owned'}});
});
it('deep-read keeps paired execution and mutually exclusive retry/rerun fields',()=>{
 const input={space_id:'space',project_id:'project',item_id:'item'};
 expect(()=>READING_OPERATION_SCHEMAS['reading.deep_read.start'].input.parse({...input,agent_id:'agent'})).toThrow();
 expect(()=>READING_OPERATION_SCHEMAS['reading.deep_read.start'].input.parse({...input,retry_of:'retry',rerun_of:'rerun'})).toThrow();
});
