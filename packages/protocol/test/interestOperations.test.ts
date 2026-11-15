import {expect,it} from 'vitest';
import {INTEREST_OPERATION_SCHEMAS} from '../src/interestOperations.js';
import {SYSTEM_ACTION_REGISTRY} from '../src/systemActions.js';
it('exposes exactly eight strict human-only keyed commands without approval mappings',()=>{
 expect(Object.keys(INTEREST_OPERATION_SCHEMAS)).toHaveLength(8);
 for(const id of Object.keys(INTEREST_OPERATION_SCHEMAS)) {
  const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
  expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
  expect(d.idempotency_required).toBe(true);
  expect(d.allowed_actor_types).toEqual(['user']);
  expect(d.proposal_type).toBeNull();
  expect(d.visibility).not.toContain('agent_tool');
 }
});
it('rejects owner spoofing, unbounded history and nonnumeric settings',()=>{
 expect(INTEREST_OPERATION_SCHEMAS['interest.topic.create'].input.safeParse({space_id:'space',label:'A',domain_key:'software_engineering',user_id:'other'}).success).toBe(false);
 expect(INTEREST_OPERATION_SCHEMAS['interest.history.backfill'].input.safeParse({space_id:'space',limit:501}).success).toBe(false);
 expect(INTEREST_OPERATION_SCHEMAS['interest.settings.update'].input.safeParse({space_id:'space',interest_slots:'4'}).success).toBe(false);
 expect(INTEREST_OPERATION_SCHEMAS['interest.settings.update'].input.safeParse({space_id:'space'}).success).toBe(false);
 expect(INTEREST_OPERATION_SCHEMAS['interest.history.backfill'].input.parse({space_id:'space'}).limit).toBe(500);
});
