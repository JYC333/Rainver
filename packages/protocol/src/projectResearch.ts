import { z } from "zod";

/** Public lifecycle vocabulary for the project research orchestration API. */
export const ProjectResearchRunKindSchema = z.enum(["baseline", "historical_backfill", "incremental"]);
export type ProjectResearchRunKind = z.infer<typeof ProjectResearchRunKindSchema>;

export const ProjectResearchHistoryModeSchema = z.enum(["bounded_range", "all_available"]);
export type ProjectResearchHistoryMode = z.infer<typeof ProjectResearchHistoryModeSchema>;

export const ProjectResearchReportDepthSchema = z.enum(["quick", "full"]);
export type ProjectResearchReportDepth = z.infer<typeof ProjectResearchReportDepthSchema>;

export const ProjectResearchOperationStateSchema = z.enum([
  "pending",
  "running",
  "waiting_review",
  "succeeded",
  "failed",
  "skipped",
]);
export type ProjectResearchOperationState = z.infer<typeof ProjectResearchOperationStateSchema>;

export const ProjectResearchCheckpointTypeSchema = z.enum(["screening_gate", "idea_review"]);
export type ProjectResearchCheckpointType = z.infer<typeof ProjectResearchCheckpointTypeSchema>;

export const ProjectResearchExecutionConfigSchema = z.object({
  model_provider_id: z.string().trim().min(1).optional(),
  model_name: z.string().trim().min(1).optional(),
}).strict();
export type ProjectResearchExecutionConfig = z.infer<typeof ProjectResearchExecutionConfigSchema>;

export const ProjectResearchInitialIntakeRequestSchema = z.object({
  query_strategy_id: z.string().uuid(),
  history_mode: ProjectResearchHistoryModeSchema.default("bounded_range"),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  max_items: z.number().int().min(1).max(10_000).default(10_000),
  monitoring_field: z.enum(["submittedDate", "lastUpdatedDate"]).default("submittedDate"),
  schedule: z.literal("daily").default("daily"),
  report_depth: ProjectResearchReportDepthSchema,
  question_refine_skipped: z.boolean(),
  idempotency_key: z.string().trim().min(1).optional(),
  execution: ProjectResearchExecutionConfigSchema.optional(),
}).strict();
export type ProjectResearchInitialIntakeRequest = z.infer<typeof ProjectResearchInitialIntakeRequestSchema>;

export const ProjectResearchQuestionRefinementSchema = z.object({
  assessment: z.object({
    answerable: z.boolean(),
    finer: z.object({
      feasible: z.number().int().min(1).max(5),
      interesting: z.number().int().min(1).max(5),
      novel: z.number().int().min(1).max(5),
      ethical: z.number().int().min(1).max(5),
      relevant: z.number().int().min(1).max(5),
    }).strict(),
    issues: z.array(z.string()),
  }).strict(),
  suggested_questions: z.array(z.string().min(1)).min(1).max(3),
  sub_questions: z.array(z.string().min(1).max(200)).max(10),
  scope: z.object({
    in: z.array(z.string().min(1).max(200)).max(10),
    out: z.array(z.string().min(1).max(200)).max(10),
  }).strict(),
  clarifying_questions: z.array(z.object({
    question: z.string().min(1),
    // Enumerable answers become clickable options in the UI; an open question
    // ships an empty list and the user types the answer.
    options: z.array(z.string().min(1)).max(6),
    allow_multiple: z.boolean(),
  }).strict()).max(3),
}).strict();
export type ProjectResearchQuestionRefinement = z.infer<typeof ProjectResearchQuestionRefinementSchema>;

export const ResearchCitationRefSchema = z.object({
  source_item_id: z.string().min(1).optional(),
  evidence_id: z.string().min(1).optional(),
  object_id: z.string().min(1).optional(),
  doi: z.string().min(1).optional(),
  arxiv_id: z.string().min(1).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "At least one source or evidence reference is required",
});
export type ResearchCitationRef = z.infer<typeof ResearchCitationRefSchema>;

export const ResearchReportV1Schema = z.object({
  schema_version: z.literal("research_report.v1"),
  research_question: z.string().min(1),
  summary: z.string().min(1),
  findings: z.array(z.object({
    claim: z.string().min(1),
    support: z.string().min(1),
    references: z.array(ResearchCitationRefSchema).min(1),
  })),
  limitations: z.array(z.string()),
  sources: z.array(z.object({
    title: z.string().min(1),
    authors: z.array(z.string()),
    year: z.number().int().nullable().optional(),
    references: z.array(ResearchCitationRefSchema).min(1),
    relevance: z.enum(["relevant", "maybe", "not_relevant"]),
    summary: z.string().optional(),
  })),
  ideas: z.array(z.object({
    title: z.string().min(1),
    problem: z.string().min(1),
    novelty: z.string().min(1),
    testability: z.string().min(1),
    references: z.array(ResearchCitationRefSchema).min(1),
  })),
}).strict();
export type ResearchReportV1 = z.infer<typeof ResearchReportV1Schema>;
