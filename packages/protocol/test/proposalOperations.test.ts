import {expect,it} from 'vitest';
import {OPERATION_SCHEMA_TABLE} from '../src/operations.js';
import {SYSTEM_ACTION_REGISTRY} from '../src/systemActions.js';

it('keeps Bundle rollback and rejection outside the member approval policy action',()=>{
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='evolution.bundle.rollback')?.policy_action).toBe('proposal.rollback');
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='evolution.bundle.reject')?.policy_action).toBe('proposal.reject');
});
it('keeps consent strict and excludes caller authority from business input',()=>{
 const schema=OPERATION_SCHEMA_TABLE['proposal.egress.approve'].input;
 expect(schema.safeParse({proposal_id:'proposal',grant_id:'grant'}).success).toBe(true);
 for(const field of ['user_id','space_id','approver_user_id','status','unexpected'])expect(schema.safeParse({proposal_id:'proposal',[field]:'injected'}).success).toBe(false);
});

it('keeps rejection input strict and disallows accepting or selecting authority',()=>{
 const schema=OPERATION_SCHEMA_TABLE['proposal.reject'].input;
 expect(schema.safeParse({proposal_id:'proposal'}).success).toBe(true);
 for(const field of ['user_id','space_id','decision','allow_bundle_member_decision'])expect(schema.safeParse({proposal_id:'proposal',[field]:'injected'}).success).toBe(false);
});

it('keeps accept, rollback and Bundle authority out of their strict inputs',()=>{
 for(const [id,input] of [
  ['proposal.accept',{proposal_id:'proposal',confirm_incomplete_patch:true}],
  ['proposal.rollback',{proposal_id:'proposal'}],
  ['evolution.bundle.approve',{bundle_id:'bundle',proposal_ids:['proposal']}],
  ['evolution.bundle.reject',{bundle_id:'bundle',proposal_ids:['proposal']}],
  ['evolution.bundle.decide',{bundle_id:'bundle',decisions:[{proposal_id:'proposal',decision:'approve'}]}],
  ['evolution.bundle.rollback',{bundle_id:'bundle'}],
 ] as const){
  const schema=OPERATION_SCHEMA_TABLE[id].input;
  expect(schema.safeParse(input).success).toBe(true);
  for(const key of ['user_id','space_id','requester','allow_bundle_member_decision'])expect(schema.safeParse({...input,[key]:'injected'}).success).toBe(false);
 }
});
