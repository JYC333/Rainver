import {describe,it,expect} from 'vitest';
import {CodePatchDecisionReceiptSchema} from '../src/proposals.js';
describe('code patch decision receipt',()=>{
 it('carries a pending/compensation state without file content or raw failure text',()=>{
  const receipt={id:'decision',proposal_id:'proposal',phase:'apply',status:'compensation_failed',job_id:'job',error:'code_patch_decision_compensation_failed'};
  expect(CodePatchDecisionReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(CodePatchDecisionReceiptSchema.safeParse({...receipt,effect_json:{secret:'file content'}}).success).toBe(false);
 });
});
