import { z } from "zod";
export const ProblemMethodVersionSchema = z.literal("problem_solving.v1");
export const ProblemStageSchema = z.enum(["frame", "plan", "act", "verify", "conclude"]);
export const PROBLEM_STAGES = ProblemStageSchema.options;
export const ProblemWorkKindSchema = z.enum(["select_method", "record_work", "invoke_research", "link_task", "reference_result", "assess_result", "close_round"]);
export const ProblemPrimaryIntentSchema = z.object({
  stage: ProblemStageSchema,
  work_kind: ProblemWorkKindSchema.exclude(["close_round"]),
  reason: z.string().trim().min(1).max(4000)
}).strict();
const command = {
  method_version: z.literal("problem_solving.v1"),
  expected_version: z.number().int().positive(),
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: z.string().min(1).max(128)
};
export const ProblemReferenceSchema=z.object({type:z.enum(["note","inquiry_thread","task","artifact"]),id:z.string().min(1).max(128)}).strict();
export type ProblemReference=z.infer<typeof ProblemReferenceSchema>;
export const ProblemWorkFieldsSchema = z.object({
  ...command,
  ...ProblemPrimaryIntentSchema.shape,
  selection_kind: z.enum(["select", "skip", "return"]).optional(),
  skipped_stages: z.array(ProblemStageSchema).max(5).default([]),
  input_refs: z.array(ProblemReferenceSchema).max(20).default([]),
  output_refs: z.array(ProblemReferenceSchema).max(20).default([])
}).strict();
export function validateProblemWorkSelection(v: Pick<z.infer<typeof ProblemWorkFieldsSchema>, "selection_kind" | "work_kind" | "skipped_stages">, ctx: z.RefinementCtx): void {
  if (v.selection_kind && v.work_kind !== "select_method") ctx.addIssue({
    code: "custom",
    message: "selection_kind requires select_method"
  });
  if (v.selection_kind === "skip" && !v.skipped_stages.length) ctx.addIssue({
    code: "custom",
    message: "skip must identify skipped stages"
  });
  if (v.skipped_stages.length && v.selection_kind !== "skip") ctx.addIssue({
    code: "custom",
    message: "skipped stages require skip intent"
  });
}
export const ProblemWorkRequestSchema = ProblemWorkFieldsSchema.superRefine(validateProblemWorkSelection);
export const ProblemCloseRoundRequestSchema = z.object({
  ...command,
  summary: z.string().trim().min(1).max(4000),
  input_refs: z.array(ProblemReferenceSchema).max(20).default([]),
  next_focus: ProblemPrimaryIntentSchema.nullable().optional(),
  start_next_primary: ProblemPrimaryIntentSchema.optional()
}).strict();
export const ProblemProjectionSchema = z.object({
  can_write:z.boolean().optional(),
  method_version: z.literal("problem_solving.v1"),
  thread_id: z.string(),
  version: z.number().int(),
  revision: z.number().int(),
  round_number: z.number().int().positive(),
  round_start_ref: z.object({
    kind: z.enum(["thread", "round_closeout"]),
    id: z.string()
  }),
  current_focus: z.object({
    step_id: z.string(),
    method_version: ProblemMethodVersionSchema,
    stage: ProblemStageSchema.nullable(),
    work_kind: z.string()
  }).nullable(),
  stages: z.array(z.object({
    stage: ProblemStageSchema,
    label: z.string(),
    purpose: z.string(),
    worked: z.boolean(),
    has_outputs: z.boolean(),
    running: z.boolean()
  })),
  next_step_cursor: z.number().int().positive().nullable(),
  next_closeout_cursor: z.number().int().positive().nullable(),
  steps: z.array(z.record(z.unknown())),
  closeouts: z.array(z.record(z.unknown()))
});
export type ProblemWorkRequest = z.infer<typeof ProblemWorkRequestSchema>;
export type ProblemCloseRoundRequest = z.infer<typeof ProblemCloseRoundRequestSchema>;
export type ProblemStage = z.infer<typeof ProblemStageSchema>;

/** Versioned method semantics, shared by server, Agent and workspace consumers. */
export const PROBLEM_STAGE_DEFINITIONS: Record<ProblemStage, {
  label: string;
  purpose: string;
}> = {
  frame: {
    label: "明确问题",
    purpose: "State the problem, boundaries, success criteria and gaps."
  },
  plan: {
    label: "制定方案",
    purpose: "Compare methods and record choices, sequence, budget and authorization needs."
  },
  act: {
    label: "采取行动",
    purpose: "Reference real actions, Tasks, experiments or Research calls."
  },
  verify: {
    label: "检验判断",
    purpose: "Assess results, applicability, counterevidence and unresolved gaps."
  },
  conclude: {
    label: "总结本轮",
    purpose: "Record what changed or stayed, close this round and state next intent."
  }
};
