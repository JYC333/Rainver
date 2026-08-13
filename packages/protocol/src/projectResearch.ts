import { z } from "zod";
import { RESEARCH_QUESTION_MAX_LENGTH } from "./researchDiscovery.js";

/** Public lifecycle vocabulary for the project research orchestration API. */
export const ProjectResearchRunKindSchema = z.enum(["baseline", "historical_backfill", "incremental"]);

export const ProjectResearchHistoryModeSchema = z.enum(["bounded_range", "all_available"]);

export const ProjectResearchReportDepthSchema = z.enum(["quick", "full"]);

export const ProjectResearchOperationStateSchema = z.enum([
  "pending",
  "running",
  "waiting_review",
  "succeeded",
  "failed",
  "skipped",
]);

export const ProjectResearchCheckpointTypeSchema = z.enum(["screening_gate", "idea_review"]);

export const ProjectResearchExecutionConfigSchema = z.object({
  model_provider_id: z.string().trim().min(1).optional(),
  model_name: z.string().trim().min(1).optional(),
}).strict();

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

export const ProjectResearchQuestionRefinementSchema = z.object({
  reply: z.string().min(1),
  recommended_question: z.string().min(1).max(RESEARCH_QUESTION_MAX_LENGTH),
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
  suggested_questions: z.array(z.string().min(1).max(RESEARCH_QUESTION_MAX_LENGTH)).min(1).max(3),
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
/** The model's own output. The refine service stamps the context version onto
 * it afterwards, which is why that field lives on the Result below and not
 * here: this schema also validates what the model returned. */
export type ProjectResearchQuestionRefinement = z.infer<typeof ProjectResearchQuestionRefinementSchema>;

export const ProjectResearchQuestionRefinementResultSchema = ProjectResearchQuestionRefinementSchema.extend({
  research_context_version_id: z.string().min(1),
}).strict();
export type ProjectResearchQuestionRefinementResult = z.infer<
  typeof ProjectResearchQuestionRefinementResultSchema
>;

/**
 * A confirmed research context, projected from the owning ResearchContextVersion
 * by the refine service. `confirm` answers with the refinement Result plus this.
 */
export const ProjectResearchQuestionAssessmentConfirmationSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  question: z.string().min(1),
  assessment: ProjectResearchQuestionRefinementSchema.shape.assessment,
  scope: z.object({
    in: z.array(z.string()),
    out: z.array(z.string()),
  }).strict(),
  sub_questions: z.array(z.string()),
  manually_adjusted: z.boolean(),
  created_at: z.string().min(1),
}).strict();
export type ProjectResearchQuestionAssessmentConfirmation = z.infer<
  typeof ProjectResearchQuestionAssessmentConfirmationSchema
>;

export const ProjectResearchQuestionAssessmentConfirmationResponseSchema =
  ProjectResearchQuestionRefinementResultSchema.extend({
    confirmation: ProjectResearchQuestionAssessmentConfirmationSchema,
  }).strict();
export type ProjectResearchQuestionAssessmentConfirmationResponse = z.infer<
  typeof ProjectResearchQuestionAssessmentConfirmationResponseSchema
>;

export const ProjectResearchQuestionAssessmentMessageSchema = z.object({
  id: z.string().min(1),
  turn_index: z.number().int().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
  status: z.enum(["pending", "complete", "failed"]),
  processing_events: z.array(z.object({
    stage: z.literal("subquestion_repair"),
    status: z.enum(["detected", "running", "completed", "failed"]),
    message: z.string().min(1),
    created_at: z.string(),
  }).strict()).optional(),
  created_by_user_id: z.string().nullable(),
  created_at: z.string(),
}).strict();

export const ProjectResearchQuestionAssessmentSessionSchema = z.object({
  id: z.string().min(1),
  thread_id: z.string().min(1),
  recommended_question: z.string().nullable(),
  latest_refinement: ProjectResearchQuestionRefinementResultSchema.nullable(),
  assessment_baseline: ProjectResearchQuestionRefinementResultSchema.nullable(),
  research_context_version_id: z.string().nullable(),
  messages: z.array(ProjectResearchQuestionAssessmentMessageSchema),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const ProjectResearchQuestionRefinementResponseSchema = ProjectResearchQuestionRefinementResultSchema.extend({
  assessment_session: ProjectResearchQuestionAssessmentSessionSchema,
}).strict();

export type ProjectResearchQuestionAssessmentMessage = z.infer<typeof ProjectResearchQuestionAssessmentMessageSchema>;
export type ProjectResearchQuestionAssessmentSession = z.infer<typeof ProjectResearchQuestionAssessmentSessionSchema>;
export type ProjectResearchQuestionRefinementResponse = z.infer<typeof ProjectResearchQuestionRefinementResponseSchema>;

export const ResearchCitationRefSchema = z.object({
  source_item_id: z.string().min(1).optional(),
  evidence_id: z.string().min(1).optional(),
  object_id: z.string().min(1).optional(),
  doi: z.string().min(1).optional(),
  arxiv_id: z.string().min(1).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "At least one source or evidence reference is required",
});

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
