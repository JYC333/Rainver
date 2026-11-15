import {expect,it} from 'vitest';
import {DIGEST_OPERATION_SCHEMAS} from '../src/digestOperations.js';
const schema=DIGEST_OPERATION_SCHEMAS['digest.serendipity.feedback'];
it('accepts every existing feedback and rejects caller identity injection',()=>{
 for(const feedback of ['interesting','neutral','never'])expect(schema.input.parse({space_id:'space',item_id:'item',feedback}).feedback).toBe(feedback);
 for(const extra of [{user_id:'other'},{owner_user_id:'other'},{domain_key:'sports'}])expect(schema.input.safeParse({space_id:'space',item_id:'item',feedback:'never',...extra}).success).toBe(false);
 expect(schema.input.safeParse({space_id:'space',item_id:'item',feedback:'unknown'}).success).toBe(false);
});
it('keeps settings strict while retaining explicit legal Agent and Profile selection',()=>{
 const input={space_id:'space',daily_enabled:true,agent_id:'agent',runtime_profile_id:'profile'};
 expect(DIGEST_OPERATION_SCHEMAS['briefing.personal.settings.set'].input.parse(input)).toEqual(input);
 expect(DIGEST_OPERATION_SCHEMAS['briefing.project.settings.set'].input.parse({...input,project_id:'project'})).toMatchObject(input);
 for(const extra of [{user_id:'other'},{owner_user_id:'other'},{enabled:true}])expect(DIGEST_OPERATION_SCHEMAS['briefing.personal.settings.set'].input.safeParse({...input,...extra}).success).toBe(false);
});
it('cancellation admits only its scope and briefing, never caller-selected Run or claim',()=>{
 for(const id of ['briefing.personal.cancel','briefing.project.cancel'] as const){
  const input={space_id:'space',briefing_id:'briefing',...(id==='briefing.project.cancel'?{project_id:'project'}:{})};
  expect(DIGEST_OPERATION_SCHEMAS[id].input.safeParse(input).success).toBe(true);
  for(const extra of [{run_id:'run'},{user_id:'person'},{attempt:2},{claim_id:'claim'}])expect(DIGEST_OPERATION_SCHEMAS[id].input.safeParse({...input,...extra}).success).toBe(false);
 }
});

it('personal generation retains legal execution selection and forbids host authority injection',()=>{
 const input={space_id:'space',agent_id:'agent',runtime_profile_id:'profile',date:'2026-01-01'};
 const schema=DIGEST_OPERATION_SCHEMAS['briefing.personal.request'].input;
 expect(schema.parse(input)).toEqual(input);
 for(const extra of [{user_id:'other'},{run_id:'run'},{attempt:2},{cutoff:'2020-01-01'}])expect(schema.safeParse({...input,...extra}).success).toBe(false);
});

it('backfill inputs retain the date and scope and refuse Job or principal selection',()=>{
 for(const id of ['digest.personal.backfill','digest.project.backfill'] as const){
  const schema=DIGEST_OPERATION_SCHEMAS[id].input;
  const input={space_id:'space',date:'2026-01-01',...(id==='digest.project.backfill'?{project_id:'project'}:{})};
  expect(schema.parse(input)).toEqual(input);
  for(const extra of [{job_id:'job'},{user_id:'other'},{worker_id:'worker'},{attempts:1}])expect(schema.safeParse({...input,...extra}).success).toBe(false);
 }
});
it('highlight DTOs retain numeric path indices but reject authority fields and coercion surprises',()=>{
 for(const id of ['briefing.personal.follow_up','briefing.project.follow_up','briefing.personal.adoption.preview','briefing.project.adoption.preview','briefing.personal.adoption.confirm','briefing.project.adoption.confirm'] as const){
  const base={space_id:'space',briefing_id:'briefing',index:0,...(id.includes('.project.')?{project_id:'project'}:{}),...(id.endsWith('.confirm')?{preview_hash:'a'.repeat(64)}:{})};
  const schema=DIGEST_OPERATION_SCHEMAS[id].input;
  expect(schema.parse({...base,index:'2'}).index).toBe(2);
  for(const index of [true,null,-1,33,'bad',0.5])expect(schema.safeParse({...base,index}).success).toBe(false);
  for(const extra of [{user_id:'other'},{task_id:'task'},{visibility:'space_shared'}])expect(schema.safeParse({...base,...extra}).success).toBe(false);
 }
});
