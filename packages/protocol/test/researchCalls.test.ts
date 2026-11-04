import {describe,expect,it} from "vitest";
import { ResearchOperationMetadataSchema,ResearchCallOptionsSchema,ResearchResultAdoptionSchema,ResearchCallSchema } from "../src/researchCalls.js";
describe('versioned research capability contract',()=>{
 it('rejects body-bearing additions to a metadata envelope',()=>{
  const meta={id:'operation',space_id:'space',project_id:'project',kind:'research',title:'Research invocation',intent_text:null,status:'active',version:1,created_at:'2026-01-01',updated_at:'2026-01-01',created_by_user_id:null,initiating_run_id:null,plan_artifact_id:null,progress_json:{content_withheld:true},content_withheld:true,steps:[],links:[],stop_ref:{operation_id:'operation'}};
  expect(ResearchOperationMetadataSchema.safeParse(meta).success).toBe(true);
  expect(ResearchOperationMetadataSchema.safeParse({...meta,research_call_json:{gap:'private'}}).success).toBe(false);
 });
 it('keeps explicit gap/materials/output expectations separate from execution authority',()=>{
  const input={gap:'Find counterevidence',input_refs:[],output_expectation:'Evidence and limitations'};
  expect(ResearchCallOptionsSchema.parse(input)).toEqual(input);
  expect(ResearchCallOptionsSchema.safeParse({...input,source_owner_approved:true}).success).toBe(false);
 });
 it('requires current version and explicit applicability for adoption, and forbids cognitive writes',()=>{
  const input={expected_version:1,expected_revision:2,idempotency_key:'request',applicability:'limited',reason:'Old snapshot still useful'};
  expect(ResearchResultAdoptionSchema.safeParse(input).success).toBe(true);
  expect(ResearchResultAdoptionSchema.safeParse({...input,applicability:undefined}).success).toBe(false);
  expect(ResearchResultAdoptionSchema.safeParse({...input,answer_state:'answered'}).success).toBe(false);
 });
 it('does not accept an unbound call package',()=>{
  expect(ResearchCallSchema.safeParse({schema_version:'research_call.v1',workflow_id:'w'}).success).toBe(false);
 });
});
