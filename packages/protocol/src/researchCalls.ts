import { z } from "zod";
import { ProblemReferenceSchema, ProblemStageSchema } from "./problemEngine.js";
/** Logical identity is the existing initial Operation; attempts remain its executions. */
export const ResearchCallSchema = z.object({
  schema_version:z.literal("research_call.v1"), operation_id:z.string(), workflow_id:z.string(),
  thread_id:z.string(), thread_version:z.number().int().positive(), problem_revision:z.number().int().nonnegative(),
  round_number:z.number().int().positive(), round_start_id:z.string().nullable(), step_id:z.string(), source_step_id:z.string().nullable(),
  position_hash:z.string(),stage:ProblemStageSchema, gap:z.string().min(1).max(4000), input_refs:z.array(ProblemReferenceSchema).max(20),
  output_expectation:z.string().max(4000), scope:z.record(z.unknown()), requested_by_user_id:z.string(), requested_by_run_id:z.string().nullable(),
}).strict();
export type ResearchCall = z.infer<typeof ResearchCallSchema>;
export const ResearchResultSchema=z.object({
 schema_version:z.literal("research_result.v1"), call:ResearchCallSchema,
 attempt:z.number().int().positive(), execution_id:z.string().nullable(), status:z.enum(["draft","active","waiting_review","completed","failed","cancelled"]),
 applicability:z.enum(["current_snapshot","requires_assessment"]), findings:z.array(z.object({report_id:z.string(),artifact_id:z.string(),summary:z.string(),claims:z.array(z.object({claim:z.string(),support:z.string(),references:z.array(z.record(z.unknown()))})),truncated:z.boolean()})),
 evidence_refs:z.array(ProblemReferenceSchema), limitations:z.array(z.string()), unresolved_gaps:z.array(z.string()),
 usage:z.record(z.unknown()),diagnostics:z.record(z.unknown()),partial:z.boolean(),
}).strict();
export const ResearchResultAdoptionSchema=z.object({
 expected_version:z.number().int().positive(),expected_revision:z.number().int().nonnegative(),idempotency_key:z.string().min(1).max(128),
 applicability:z.enum(["applicable","limited","not_applicable"]),reason:z.string().trim().min(1).max(1800),
 counterevidence:z.string().max(900).default(""),remaining_gaps:z.string().max(900).default(""),
}).strict();

export const ResearchCallOptionsSchema=z.object({
 gap:z.string().trim().min(1).max(4000), input_refs:z.array(ProblemReferenceSchema).max(20).default([]),
 output_expectation:z.string().trim().min(1).max(4000), stage:ProblemStageSchema.optional(),
 expected_version:z.number().int().positive().optional(),expected_revision:z.number().int().nonnegative().optional(),
}).strict();

/** Source-free envelope; adding any body/cache field is a contract violation. */
export const ResearchOperationMetadataSchema=z.object({
 id:z.string(),space_id:z.string(),project_id:z.string(),kind:z.literal('research'),title:z.literal('Research invocation'),
 intent_text:z.null(),status:z.enum(['draft','active','waiting_review','completed','failed','cancelled']),version:z.number().int().positive(),
 created_at:z.string(),updated_at:z.string(),created_by_user_id:z.null(),initiating_run_id:z.null(),plan_artifact_id:z.null(),
 progress_json:z.object({content_withheld:z.literal(true)}).strict(),content_withheld:z.literal(true),steps:z.tuple([]),links:z.tuple([]),stop_ref:z.object({operation_id:z.string()}).strict(),
}).strict();
