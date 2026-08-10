/**
 * Centralized prompt registry contracts.
 *
 * Prompt assets are a prompt-specific view over the generic evolvable-asset
 * system (`evolvable_assets` / `evolvable_asset_versions`, plus
 * `prompt_deployment_refs` for staging/production labels; asset_type
 * `prompt_template`): named, typed, immutable-by-version prompt content
 * with scoped resolution. Built-in prompt assets are catalog-backed under
 * `catalog/prompts`, with runtime ownership summarized in `.agent/architecture`.
 *
 * This file covers the prompt facade routes: read, immutable version creation,
 * render preview, evaluation evidence, promotion proposal, deployment refs,
 * rollback, and runtime resolution.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";
import { JsonObjectSchema } from "./capabilities.js";

export const PROMPT_TYPES = [
  "chat",
  "text",
  "workflow",
  "retrieval_query",
  "retrieval_rerank",
  "retrieval_synthesis",
  "agent_system",
] as const;
export const PromptTypeSchema = z.enum(PROMPT_TYPES);
export type PromptType = z.infer<typeof PromptTypeSchema>;

export const PROMPT_ASSET_SCOPE_TYPES = [
  "system",
  "space",
  "project",
  "user",
  "agent",
] as const;
export const PromptAssetScopeTypeSchema = z.enum(PROMPT_ASSET_SCOPE_TYPES);
export type PromptAssetScopeType = z.infer<typeof PromptAssetScopeTypeSchema>;

export const PROMPT_VERSION_STATUSES = [
  "draft",
  "candidate",
  "testing",
  "approved",
  "deprecated",
  "archived",
] as const;
export const PromptVersionStatusSchema = z.enum(PROMPT_VERSION_STATUSES);
export type PromptVersionStatus = z.infer<typeof PromptVersionStatusSchema>;

export const PROMPT_VERSION_SOURCES = [
  "built_in",
  "user_authored",
  "evolved",
  "imported",
  "generated",
] as const;
export const PromptVersionSourceSchema = z.enum(PROMPT_VERSION_SOURCES);
export type PromptVersionSource = z.infer<typeof PromptVersionSourceSchema>;

export const PromptMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })
  .strict();
export type PromptMessage = z.infer<typeof PromptMessageSchema>;

export const PromptRenderingEngineSchema = z.enum(["plain"]);
export type PromptRenderingEngine = z.infer<typeof PromptRenderingEngineSchema>;

/** The logical shape stored in `evolvable_asset_versions.content_json` for a prompt version. */
export const PromptAssetContentSchema = z
  .object({
    schema_version: z.literal("prompt_asset.v1"),
    prompt_type: PromptTypeSchema,
    messages: z.array(PromptMessageSchema).min(1).nullish(),
    template: z.string().min(1).nullish(),
    variables_schema: JsonObjectSchema.default({}),
    output_schema: JsonObjectSchema.default({}),
    model_config: JsonObjectSchema.default({}),
    rendering: z
      .object({ engine: PromptRenderingEngineSchema })
      .passthrough()
      .default({ engine: "plain" }),
    safety: z
      .object({
        untrusted_data_delimiters: z.boolean().default(false),
        requires_proposal_for_promotion: z.boolean().default(true),
      })
      .passthrough()
      .default({}),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const hasMessages = Array.isArray(value.messages) && value.messages.length > 0;
    const hasTemplate = typeof value.template === "string" && value.template.trim().length > 0;
    if (hasMessages === hasTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Prompt content must provide exactly one of messages or template",
        path: ["messages"],
      });
    }
  });
export type PromptAssetContent = z.infer<typeof PromptAssetContentSchema>;

export const PromptAssetSummarySchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema.nullable(),
    asset_key: z.string().min(1),
    display_name: z.string().min(1),
    description: z.string().nullable(),
    prompt_type: PromptTypeSchema.nullable(),
    status: z.enum(["active", "disabled", "archived"]),
    owner_scope_type: PromptAssetScopeTypeSchema,
    owner_scope_id: IdSchema.nullable(),
    current_system_version_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .passthrough();
export type PromptAssetSummary = z.infer<typeof PromptAssetSummarySchema>;

export const PromptAssetDetailSchema = PromptAssetSummarySchema.extend({
  metadata_json: JsonObjectSchema,
});
export type PromptAssetDetail = z.infer<typeof PromptAssetDetailSchema>;

export const PromptVersionSchema = z
  .object({
    id: IdSchema,
    asset_id: IdSchema,
    space_id: IdSchema.nullable(),
    scope_type: PromptAssetScopeTypeSchema,
    scope_id: IdSchema.nullable(),
    parent_version_id: IdSchema.nullable(),
    version: z.number().int().positive(),
    status: PromptVersionStatusSchema,
    source: PromptVersionSourceSchema,
    // Deliberately loose, not PromptAssetContentSchema: the underlying
    // evolvable_asset_versions row is asset_type-generic, so a version read
    // back through this facade is not guaranteed to satisfy the strict
    // prompt_asset.v1 shape unless it was written through prompt-aware code
    // (built-in sync, or version creation once that lands). Strict
    // validation happens at write time, not read time.
    content: JsonObjectSchema.nullable(),
    content_hash: z.string().nullable(),
    eval_summary_json: JsonObjectSchema.nullable(),
    promotion_proposal_id: IdSchema.nullable(),
    created_by_user_id: IdSchema.nullable(),
    approved_by_user_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    stale_parent: z.boolean(),
  })
  .passthrough();
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

export const PromptVersionCreateRequestSchema = z
  .object({
    scope_type: PromptAssetScopeTypeSchema.optional(),
    scope_id: IdSchema.nullish(),
    parent_version_id: IdSchema.nullish(),
    source: PromptVersionSourceSchema.optional(),
    content_ref: z.string().nullish(),
    content_hash: z.string().nullish(),
    content_json: PromptAssetContentSchema,
  })
  .strict();
export type PromptVersionCreateRequest = z.infer<typeof PromptVersionCreateRequestSchema>;

export const PromptDeploymentRefSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema.nullable(),
    asset_id: IdSchema,
    scope_type: PromptAssetScopeTypeSchema,
    scope_id: IdSchema.nullable(),
    label: z.string().min(1),
    version_id: IdSchema,
    status: z.enum(["active", "archived"]),
    promoted_by_user_id: IdSchema.nullable(),
    promoted_from_proposal_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .passthrough();
export type PromptDeploymentRef = z.infer<typeof PromptDeploymentRefSchema>;

export const PromptRenderPreviewRequestSchema = z
  .object({
    version_id: IdSchema.nullish(),
    content_json: PromptAssetContentSchema.optional(),
    variables: JsonObjectSchema.optional(),
  })
  .strict();
export type PromptRenderPreviewRequest = z.infer<typeof PromptRenderPreviewRequestSchema>;

export const PromptRenderPreviewResultSchema = z
  .object({
    asset_key: z.string().min(1),
    version_id: IdSchema.nullable(),
    rendered_messages: z.array(PromptMessageSchema).nullable(),
    rendered_text: z.string().nullable(),
    validation_warnings: z.array(z.string()),
    validation_errors: z.array(z.string()),
  })
  .passthrough();
export type PromptRenderPreviewResult = z.infer<typeof PromptRenderPreviewResultSchema>;

export const PromptEvaluationRequestSchema = z
  .object({
    version_id: IdSchema,
    eval_suite_ref: JsonObjectSchema,
    evaluator_version: z.string().min(1),
    status: z.enum(["queued", "running", "passed", "failed", "blocked", "cancelled"]).optional(),
    baseline_version_id: IdSchema.nullish(),
    run_id: IdSchema.nullish(),
    model_provider_ref: JsonObjectSchema.nullish(),
    metrics: JsonObjectSchema.optional(),
    blockers: z.array(z.unknown()).optional(),
    output_artifact_id: IdSchema.nullish(),
    report_artifact_id: IdSchema.nullish(),
  })
  .strict();
export type PromptEvaluationRequest = z.infer<typeof PromptEvaluationRequestSchema>;

export const PromptEvaluationResultSchema = z
  .object({
    id: IdSchema,
    asset_id: IdSchema,
    candidate_version_id: IdSchema,
    baseline_version_id: IdSchema.nullable(),
    run_id: IdSchema.nullable(),
    eval_suite_ref: JsonObjectSchema,
    evaluator_version: z.string(),
    status: z.string(),
    metrics: JsonObjectSchema,
    blockers: z.array(z.unknown()),
    output_artifact_id: IdSchema.nullable(),
    report_artifact_id: IdSchema.nullable(),
    created_by_user_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .passthrough();
export type PromptEvaluationResult = z.infer<typeof PromptEvaluationResultSchema>;

export const PromptPromotionRequestSchema = z
  .object({
    version_id: IdSchema,
    label: z.string().min(1).default("production"),
    scope_type: PromptAssetScopeTypeSchema.default("space"),
    scope_id: IdSchema.nullish(),
    deprecate_previous: z.boolean().optional(),
    evaluation_run_ids: z.array(IdSchema).optional(),
    reason: z.string().nullish(),
  })
  .strict();
export type PromptPromotionRequest = z.infer<typeof PromptPromotionRequestSchema>;

export const PromptRollbackRequestSchema = z
  .object({
    label: z.string().min(1).default("production"),
    scope_type: PromptAssetScopeTypeSchema.default("space"),
    scope_id: IdSchema.nullish(),
    version_id: IdSchema.nullish(),
  })
  .strict();
export type PromptRollbackRequest = z.infer<typeof PromptRollbackRequestSchema>;

export const PromptResolveRequestSchema = z
  .object({
    project_id: IdSchema.nullish(),
    agent_id: IdSchema.nullish(),
    explicit_version_id: IdSchema.nullish(),
    allow_user_pin: z.boolean().optional(),
    label: z.string().nullish(),
    variables: JsonObjectSchema.optional(),
  })
  .strict();
export type PromptResolveRequest = z.infer<typeof PromptResolveRequestSchema>;

export const PromptResolveResultSchema = z
  .object({
    asset_key: z.string().min(1),
    version_id: IdSchema,
    content_hash: z.string().nullable(),
    scope_type: PromptAssetScopeTypeSchema.nullable(),
    scope_id: IdSchema.nullable(),
    resolution_trace: z.array(z.string()),
    fallback_reason: z.string().nullable(),
    rendered_messages: z.array(PromptMessageSchema).nullable(),
    rendered_text: z.string().nullable(),
    rendered_hash: z.string().nullable(),
    validation_warnings: z.array(z.string()),
    validation_errors: z.array(z.string()),
  })
  .passthrough();
export type PromptResolveResult = z.infer<typeof PromptResolveResultSchema>;
