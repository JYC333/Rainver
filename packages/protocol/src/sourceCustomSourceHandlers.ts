/**
 * Source Custom Source handler contracts.
 *
 * Custom Source extends the Source `SourceConnection` model with generated,
 * source-specific handler versions and handler runs. See
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md` for the product
 * boundary. These schemas cover:
 *
 * - The handler version / handler run wire DTOs (server-owned persistence).
 * - The policy envelope shape attached to each handler version.
 * - The server-owned handler input/output sandbox contract
 *   (`custom_source.handler_input.v1` / `custom_source.handler_output.v1`)
 *   that generated handler code reads and writes.
 * - The Space/Instance Custom Source settings read model.
 *
 * Handler output is untrusted until the server validates it against
 * `CustomSourceHandlerOutputSchema`; only the server materializer may turn
 * validated output into Source rows and artifacts.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";

const JsonObjectSchema = z.record(z.unknown());

export const CUSTOM_SOURCE_HANDLER_KIND_VALUES = ["built_in", "generated_custom"] as const;

/**
 * Level 3 generated-handler language identifiers. `typescript_node` is the
 * generated-code fallback. `declarative_pipeline_v1` remains for advanced or
 * historical handler versions and can be explicitly bridged into Level 2
 * Source Recipes; normal source creation should write `source_recipe_versions`
 * instead of new pipeline-as-handler rows. See
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md`.
 */
export const CUSTOM_SOURCE_HANDLER_LANGUAGE_VALUES = ["typescript_node", "declarative_pipeline_v1"] as const;

export const CUSTOM_SOURCE_HANDLER_VERSION_STATUS_VALUES = [
  "draft",
  "test_failed",
  "pending_approval",
  "active",
  "superseded",
  "disabled",
] as const;

export const CUSTOM_SOURCE_HANDLER_RUN_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "validation_failed",
  "blocked",
] as const;

export const CUSTOM_SOURCE_REPAIR_STATUS_VALUES = [
  "ok",
  "repair_required",
  "repair_pending",
  "disabled",
] as const;

export const CUSTOM_SOURCE_HANDLER_RUN_MODE_VALUES = ["scan", "test"] as const;

export const CUSTOM_SOURCE_CREATOR_ROLE_VALUES = ["owner", "admin", "reviewer", "member"] as const;
export type CustomSourceCreatorRole = (typeof CUSTOM_SOURCE_CREATOR_ROLE_VALUES)[number];

export const CUSTOM_SOURCE_CAPTURE_POLICY_VALUES = [
  "reference_only",
  "extract_text",
  "archive_original",
] as const;
export type CustomSourceCapturePolicy = (typeof CUSTOM_SOURCE_CAPTURE_POLICY_VALUES)[number];

export const CUSTOM_SOURCE_RETENTION_POLICY_VALUES = [
  "metadata_only",
  "summary_only",
  "full_text",
  "full_snapshot",
  "archived",
] as const;
export type CustomSourceRetentionPolicy = (typeof CUSTOM_SOURCE_RETENTION_POLICY_VALUES)[number];

/** Resource/output limits enforced by the runner and the contract validator. */
export const CustomSourcePolicyLimitsSchema = z
  .object({
    timeout_ms: z.number().int().positive(),
    max_download_bytes: z.number().int().positive(),
    max_output_bytes: z.number().int().positive(),
    max_files: z.number().int().positive(),
    max_items: z.number().int().positive(),
    max_evidence_items: z.number().int().positive(),
    log_max_bytes: z.number().int().positive(),
  })
  .passthrough();
export type CustomSourcePolicyLimits = z.infer<typeof CustomSourcePolicyLimitsSchema>;

/**
 * Policy envelope attached to every handler version. Activation/repair rules
 * compare a new envelope against the active approved envelope; see
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md#policy-envelope`.
 */
export const CustomSourcePolicyEnvelopeSchema = z
  .object({
    allowed_network_origins: z.array(z.string()),
    capture_policy: z.enum(CUSTOM_SOURCE_CAPTURE_POLICY_VALUES),
    retention_policy: z.enum(CUSTOM_SOURCE_RETENTION_POLICY_VALUES),
    credential_ref: z.string().nullish(),
    language: z.enum(CUSTOM_SOURCE_HANDLER_LANGUAGE_VALUES),
    browser_automation_enabled: z.boolean().default(false),
    shell_enabled: z.boolean().default(false),
    dependency_installation_enabled: z.boolean().default(false),
    log_redaction_enabled: z.boolean().default(true),
    limits: CustomSourcePolicyLimitsSchema,
  })
  .passthrough();
export type CustomSourcePolicyEnvelope = z.infer<typeof CustomSourcePolicyEnvelopeSchema>;

// --- Declarative pipeline definition (`language: "declarative_pipeline_v1"`) ---
//
// A compatibility catalog of steps interpreted by trusted, server-owned
// platform code (`customSourcePipelineInterpreter.ts`) — never generated or
// executed code. A handler version's `manifest_json.pipeline` holds one of
// these; `recipeFromPipelineDefinition` wraps it as a Level 2 recipe for the
// explicit bridge path. See `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md`.

export const CUSTOM_SOURCE_PIPELINE_VERSION = "custom_source.pipeline.v1";

/** Sentinel `fetch_page.url` meaning "use the already-fetched/fixture-overridable primary endpoint HTML," never a live secondary fetch. */
export const CUSTOM_SOURCE_PIPELINE_PRIMARY_ENDPOINT_URL = "$source.endpoint_url";

export const CustomSourcePipelineSelectorSchema = z
  .object({
    css_class: z.string().min(1),
  })
  .passthrough();
export type CustomSourcePipelineSelector = z.infer<typeof CustomSourcePipelineSelectorSchema>;

export const CustomSourcePipelineNextPageSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("query_param"), param: z.string().min(1), start_page: z.number().int().min(2) }).passthrough(),
  z.object({ mode: z.literal("link_rel_next") }).passthrough(),
]);
export type CustomSourcePipelineNextPage = z.infer<typeof CustomSourcePipelineNextPageSchema>;

export interface CustomSourcePipelineFetchPageStep {
  type: "fetch_page";
  /** `CUSTOM_SOURCE_PIPELINE_PRIMARY_ENDPOINT_URL` or a literal absolute HTTP(S) URL. */
  url: string;
  bind: string;
}
export interface CustomSourcePipelineExtractListStep {
  type: "extract_list";
  input: string;
  selector: CustomSourcePipelineSelector;
  bind: string;
  max_items?: number;
}
export interface CustomSourcePipelineExtractSingleStep {
  type: "extract_single";
  input: string;
  bind: string;
}
export interface CustomSourcePipelineFollowLinkStep {
  type: "follow_link";
  /** Name of an items-kind variable; each item's own `source_uri` is fetched (bounded by `max_follow`) and merged into that item. */
  items_var: string;
  max_follow: number;
}
export interface CustomSourcePipelineDownloadAssetStep {
  type: "download_asset";
  /** Name of an items-kind variable; each item's own `source_uri` is downloaded and stored as a snapshot. */
  items_var: string;
  mime_allowlist?: string[];
}
export interface CustomSourcePipelinePaginateStep {
  type: "paginate";
  /** Name of an html-kind variable already bound by an earlier `fetch_page` (page 1). */
  input: string;
  max_pages: number;
  next_page: CustomSourcePipelineNextPage;
  /** Re-run for each subsequent page; must not itself contain a nested `paginate` step. */
  steps: CustomSourcePipelineStep[];
  /** Name of the items-kind variable `steps` binds one page's extraction to. */
  page_items_var: string;
  /** Merged items-kind variable across every page. */
  bind: string;
}
export type CustomSourcePipelineStep =
  | CustomSourcePipelineFetchPageStep
  | CustomSourcePipelineExtractListStep
  | CustomSourcePipelineExtractSingleStep
  | CustomSourcePipelineFollowLinkStep
  | CustomSourcePipelineDownloadAssetStep
  | CustomSourcePipelinePaginateStep;

const pipelineFetchPageStepSchema = z
  .object({ type: z.literal("fetch_page"), url: z.string().min(1), bind: z.string().min(1) })
  .passthrough();
const pipelineExtractListStepSchema = z
  .object({
    type: z.literal("extract_list"),
    input: z.string().min(1),
    selector: CustomSourcePipelineSelectorSchema,
    bind: z.string().min(1),
    max_items: z.number().int().positive().optional(),
  })
  .passthrough();
const pipelineExtractSingleStepSchema = z
  .object({ type: z.literal("extract_single"), input: z.string().min(1), bind: z.string().min(1) })
  .passthrough();
const pipelineFollowLinkStepSchema = z
  .object({
    type: z.literal("follow_link"),
    items_var: z.string().min(1),
    max_follow: z.number().int().nonnegative(),
  })
  .passthrough();
const pipelineDownloadAssetStepSchema = z
  .object({
    type: z.literal("download_asset"),
    items_var: z.string().min(1),
    mime_allowlist: z.array(z.string()).optional(),
  })
  .passthrough();

// `paginate.steps` is the only recursive edge. `z.discriminatedUnion` requires
// every member to be a real `ZodObject` (not a `ZodLazy` wrapper), so only the
// `steps` field — not the whole paginate step schema — is wrapped in
// `z.lazy()`; the explicit `CustomSourcePipelineStepSchema` type annotation
// below breaks the otherwise-circular type inference between the two consts
// (see the `JsonValueSchema` pattern in `runOrchestration.ts` for the same
// `z.lazy` idiom applied to a non-discriminated recursive type).
const pipelinePaginateStepSchema = z
  .object({
    type: z.literal("paginate"),
    input: z.string().min(1),
    max_pages: z.number().int().positive(),
    next_page: CustomSourcePipelineNextPageSchema,
    steps: z.lazy(() => z.array(CustomSourcePipelineStepSchema)),
    page_items_var: z.string().min(1),
    bind: z.string().min(1),
  })
  .passthrough();

export const CustomSourcePipelineStepSchema: z.ZodType<CustomSourcePipelineStep> = z.discriminatedUnion("type", [
  pipelineFetchPageStepSchema,
  pipelineExtractListStepSchema,
  pipelineExtractSingleStepSchema,
  pipelineFollowLinkStepSchema,
  pipelineDownloadAssetStepSchema,
  pipelinePaginateStepSchema,
]);

/** `paginate.steps` must not itself contain a `paginate` step, at any depth — see the `paginate.steps` doc comment above. Enforced here (not just documented) so an invalid pipeline is rejected at generation time, not discovered later at execution time. */
function findNestedPaginateStepPaths(
  steps: CustomSourcePipelineStep[],
  allowPaginateHere: boolean,
  path: (string | number)[],
): (string | number)[][] {
  const found: (string | number)[][] = [];
  steps.forEach((step, index) => {
    if (step.type !== "paginate") return;
    const stepPath = [...path, index];
    if (!allowPaginateHere) found.push([...stepPath, "type"]);
    found.push(...findNestedPaginateStepPaths(step.steps, false, [...stepPath, "steps"]));
  });
  return found;
}

export const CustomSourcePipelineDefinitionSchema = z
  .object({
    pipeline_version: z.literal(CUSTOM_SOURCE_PIPELINE_VERSION),
    steps: z.array(CustomSourcePipelineStepSchema).min(1),
    output: z.object({ items_var: z.string().min(1) }).passthrough(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const path of findNestedPaginateStepPaths(value.steps, true, ["steps"])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a paginate step must not be nested inside another paginate step's steps",
        path,
      });
    }
  });
export type CustomSourcePipelineDefinition = z.infer<typeof CustomSourcePipelineDefinitionSchema>;

export const CustomSourceHandlerVersionDTOSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    source_connection_id: IdSchema,
    version_number: z.number().int().positive(),
    language: z.enum(CUSTOM_SOURCE_HANDLER_LANGUAGE_VALUES),
    entrypoint: z.string(),
    handler_artifact_id: IdSchema.nullish(),
    manifest_json: JsonObjectSchema,
    input_schema_json: JsonObjectSchema.nullish(),
    output_schema_json: JsonObjectSchema.nullish(),
    policy_envelope_json: CustomSourcePolicyEnvelopeSchema,
    requested_capabilities_json: JsonObjectSchema.nullish(),
    checksum: z.string(),
    status: z.enum(CUSTOM_SOURCE_HANDLER_VERSION_STATUS_VALUES),
    created_by_user_id: IdSchema.nullish(),
    created_by_run_id: IdSchema.nullish(),
    proposal_id: IdSchema.nullish(),
    test_result_json: JsonObjectSchema.nullish(),
    created_at: ISODateTimeSchema,
    activated_at: ISODateTimeSchema.nullish(),
    superseded_at: ISODateTimeSchema.nullish(),
  })
  .passthrough();

export const CustomSourceHandlerRunDTOSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    source_connection_id: IdSchema,
    handler_version_id: IdSchema,
    extraction_job_id: IdSchema.nullish(),
    status: z.enum(CUSTOM_SOURCE_HANDLER_RUN_STATUS_VALUES),
    input_artifact_id: IdSchema.nullish(),
    output_artifact_id: IdSchema.nullish(),
    logs_artifact_id: IdSchema.nullish(),
    failure_class: z.string().nullish(),
    failure_detail_json: JsonObjectSchema.nullish(),
    validation_result_json: JsonObjectSchema.nullish(),
    resource_usage_json: JsonObjectSchema.nullish(),
    created_at: ISODateTimeSchema,
    started_at: ISODateTimeSchema.nullish(),
    completed_at: ISODateTimeSchema.nullish(),
  })
  .passthrough();

export const CustomSourcePendingProposalDTOSchema = z
  .object({
    proposal_id: IdSchema,
    proposal_type: z.string(),
    created_at: ISODateTimeSchema,
  })
  .passthrough();

export const CustomSourceHandlerSummaryDTOSchema = z
  .object({
    active_handler_version: CustomSourceHandlerVersionDTOSchema.nullable(),
    latest_handler_run: CustomSourceHandlerRunDTOSchema.nullable(),
    repair_status: z.enum(CUSTOM_SOURCE_REPAIR_STATUS_VALUES),
    recent_run_status_counts: z.record(z.number().int().nonnegative()),
    pending_proposals: z.array(CustomSourcePendingProposalDTOSchema),
  })
  .passthrough();

// --- Handler sandbox contract (server-owned input.json / output.json) ---

export const CUSTOM_SOURCE_HANDLER_INPUT_CONTRACT_VERSION = "custom_source.handler_input.v1";
export const CUSTOM_SOURCE_HANDLER_OUTPUT_CONTRACT_VERSION = "custom_source.handler_output.v1";

export const CustomSourceHandlerInputSchema = z
  .object({
    contract_version: z.literal(CUSTOM_SOURCE_HANDLER_INPUT_CONTRACT_VERSION),
    run: z
      .object({
        mode: z.enum(CUSTOM_SOURCE_HANDLER_RUN_MODE_VALUES),
        job_id: z.string(),
        connection_id: IdSchema,
        handler_version_id: IdSchema,
        started_at: ISODateTimeSchema,
      })
      .passthrough(),
    source: z
      .object({
        name: z.string(),
        endpoint_url: z.string().nullish(),
        config: JsonObjectSchema,
        cursor: JsonObjectSchema.nullish(),
      })
      .passthrough(),
    policy: z
      .object({
        allowed_network_origins: z.array(z.string()),
        capture_policy: z.enum(CUSTOM_SOURCE_CAPTURE_POLICY_VALUES),
        retention_policy: z.enum(CUSTOM_SOURCE_RETENTION_POLICY_VALUES),
        credential_ref: z.string().nullish(),
        limits: CustomSourcePolicyLimitsSchema,
      })
      .passthrough(),
  })
  .passthrough();
export type CustomSourceHandlerInput = z.infer<typeof CustomSourceHandlerInputSchema>;

const CustomSourceHandlerOutputSnapshotSchema = z
  .object({
    snapshot_type: z.string(),
    file_path: z.string(),
    mime_type: z.string(),
  })
  .passthrough();

const CustomSourceHandlerOutputEvidenceSchema = z
  .object({
    evidence_type: z.string(),
    title: z.string(),
    content_excerpt: z.string().nullish(),
    confidence: z.number().min(0).max(1).nullish(),
  })
  .passthrough();

/**
 * One produced source item. Shared output shape across implementation levels:
 * Level 3 generated/template handlers emit these via `output.json`, and Level 2
 * recipe execution (`sourceRecipes.ts`) produces the same shape, so the
 * server-side contract validator and Source materializer are shared.
 */
export const CustomSourceHandlerOutputItemSchema = z
  .object({
    external_id: z.string(),
    title: z.string(),
    source_uri: z.string(),
    published_at: ISODateTimeSchema.nullish(),
    author: z.string().nullish(),
    excerpt: z.string().nullish(),
    metadata: JsonObjectSchema.nullish(),
    snapshots: z.array(CustomSourceHandlerOutputSnapshotSchema).default([]),
    evidence: z.array(CustomSourceHandlerOutputEvidenceSchema).default([]),
  })
  .passthrough();

export const CustomSourceHandlerOutputSchema = z
  .object({
    contract_version: z.literal(CUSTOM_SOURCE_HANDLER_OUTPUT_CONTRACT_VERSION),
    cursor: JsonObjectSchema.nullish(),
    items: z.array(CustomSourceHandlerOutputItemSchema).default([]),
    diagnostics: z
      .object({
        warnings: z.array(z.string()).default([]),
      })
      .passthrough()
      .default({ warnings: [] }),
  })
  .passthrough();
export type CustomSourceHandlerOutput = z.infer<typeof CustomSourceHandlerOutputSchema>;

// --- Settings read model (Space product policy / Instance runner safety) ---

export const CustomSourceSpacePolicyDTOSchema = z
  .object({
    space_id: IdSchema,
    creator_roles: z.array(z.enum(CUSTOM_SOURCE_CREATOR_ROLE_VALUES)),
    default_capture_policy: z.enum(CUSTOM_SOURCE_CAPTURE_POLICY_VALUES),
    default_retention_policy: z.enum(CUSTOM_SOURCE_RETENTION_POLICY_VALUES),
    allowed_domains: z.array(z.string()),
    download_bytes_max: z.number().int().min(1024).max(104857600),
    credentialed_sources_allowed: z.boolean(),
    same_envelope_repair_auto_apply: z.boolean(),
    // Nullish: a space with no configured row yet gets system defaults with
    // no real created_at/updated_at, rather than a fabricated timestamp or a
    // failed read. See PgCustomSourceHandlerRepository.getSettings.
    created_at: ISODateTimeSchema.nullish(),
    updated_at: ISODateTimeSchema.nullish(),
  })
  .passthrough();

export const CustomSourceSpacePolicyUpdateSchema = z
  .object({
    creator_roles: z.array(z.enum(CUSTOM_SOURCE_CREATOR_ROLE_VALUES)).min(1).optional(),
    default_capture_policy: z.enum(CUSTOM_SOURCE_CAPTURE_POLICY_VALUES).optional(),
    default_retention_policy: z.enum(CUSTOM_SOURCE_RETENTION_POLICY_VALUES).optional(),
    allowed_domains: z.array(z.string().trim().min(1)).max(200).optional(),
    download_bytes_max: z.number().int().min(1024).max(104857600).optional(),
    credentialed_sources_allowed: z.boolean().optional(),
    same_envelope_repair_auto_apply: z.boolean().optional(),
  })
  .strict();
export type CustomSourceSpacePolicyUpdate = z.infer<typeof CustomSourceSpacePolicyUpdateSchema>;

export const CustomSourceInstanceRunnerSettingsDTOSchema = z
  .object({
    runner_enabled: z.boolean(),
    allowed_languages: z.array(z.enum(CUSTOM_SOURCE_HANDLER_LANGUAGE_VALUES)),
    network_hard_deny_rules: z.array(z.string()),
    timeout_ms_max: z.number().int().positive(),
    output_bytes_max: z.number().int().positive(),
    log_bytes_max: z.number().int().positive(),
    max_files: z.number().int().positive(),
    browser_automation_available: z.boolean(),
    shell_available: z.boolean(),
    dependency_installation_available: z.boolean(),
    generate_rate_limit_per_hour: z.number().int().positive(),
    artifact_retention_enabled: z.boolean(),
    artifact_retention_days: z.number().int().positive(),
  })
  .passthrough();

export const CustomSourceInstanceRunnerSettingsUpdateSchema = z
  .object({
    runner_enabled: z.boolean().optional(),
  })
  .strict();
export type CustomSourceInstanceRunnerSettingsUpdate = z.infer<
  typeof CustomSourceInstanceRunnerSettingsUpdateSchema
>;

export const CustomSourceSettingsDTOSchema = z
  .object({
    space: CustomSourceSpacePolicyDTOSchema,
    instance: CustomSourceInstanceRunnerSettingsDTOSchema,
  })
  .passthrough();

// --- Custom Source credential channel (Phase 10) ---
//
// A third credential class alongside ModelProvider API keys and CLI login
// state (`.agent/architecture/CREDENTIAL_STORAGE.md`). The plaintext secret
// is never returned by any DTO — only non-secret request-shaping metadata
// (which header to inject it as). `credential_ref` on the policy envelope
// holds this credential's `id`, not the secret itself; only the trusted
// fetch layer ever resolves the actual value.

export const CustomSourceCredentialDTOSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    owner_user_id: IdSchema.nullish(),
    name: z.string(),
    header_name: z.string(),
    header_value_prefix: z.string(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .passthrough();
export type CustomSourceCredentialDTO = z.infer<typeof CustomSourceCredentialDTOSchema>;

export const CustomSourceCredentialCreateSchema = z
  .object({
    name: z.string().min(1).max(256),
    secret: z.string().min(1),
    header_name: z.string().min(1).max(256).optional(),
    header_value_prefix: z.string().max(256).optional(),
  })
  .strict();
