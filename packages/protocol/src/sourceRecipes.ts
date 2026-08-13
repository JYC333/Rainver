/**
 * Source Level 2 Source recipe contracts.
 *
 * A Source recipe is the main configurable implementation of an Source
 * `SourceConnection`: a versioned, structured JSON document assembled from a
 * fixed catalog of server-owned primitives, interpreted in-process by trusted
 * platform code. There is no generated or untrusted code anywhere in this
 * model — that is the frozen Level 3 fallback described in
 * `sourceCustomSourceHandlers.ts`. See
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md` for the Level 1/2/3 split.
 *
 * These schemas cover:
 *
 * - The recipe definition (`source.recipe.v1`): a step list drawn from the
 *   primitive catalog plus an output binding.
 * - The primitive catalog names and the registry definition DTO (name,
 *   version, input/output kind, permission declaration).
 * - The versioned recipe DTO persisted in `source_recipe_versions`.
 * - The shared source policy envelope (the fields recipe and generated-handler
 *   fallback have in common — network origins, capture/retention, credential
 *   reference, limits). Selector/step changes live in `recipe_json` and are
 *   never a permission delta; policy review only compares the envelope.
 * - The bounded dry-run result and per-step execution trace.
 * - The `source_runs` product read model. Decision (Phase 2): `source_runs`
 *   starts as a read model over `extraction_jobs` and `source_handler_runs`
 *   (plus recipe dry-run results stored on recipe versions), not a physical
 *   table. It becomes a table only if the union query proves insufficient.
 *
 * Recipe output items reuse `CustomSourceHandlerOutputItemSchema`; both
 * levels materialize through the same server-side contract validator and
 * Source-only materializer.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";
import {
  CUSTOM_SOURCE_CAPTURE_POLICY_VALUES,
  CUSTOM_SOURCE_RETENTION_POLICY_VALUES,
  CustomSourceHandlerOutputItemSchema,
  CustomSourcePolicyLimitsSchema,
} from "./sourceCustomSourceHandlers.js";

const JsonObjectSchema = z.record(z.unknown());

export const SOURCE_RECIPE_CONTRACT_VERSION = "source.recipe.v1";

/** Sentinel `fetch_page.url` meaning "use the connection's primary endpoint" (fixture-overridable in dry-run), never an arbitrary live URL. */
export const SOURCE_RECIPE_PRIMARY_ENDPOINT_URL = "$source.endpoint_url";

/**
 * Fixed primitive catalog. Materialization (`create_source_item`,
 * `create_source_snapshot`, `create_extracted_evidence`) is not a recipe step
 * in v1: the recipe's `output.items_var` binding hands validated items to the
 * shared server-side materializer, which is the only component allowed to
 * write Source rows. A recipe therefore cannot express a write the
 * materializer would not perform.
 */
export const SOURCE_RECIPE_PRIMITIVE_NAMES = [
  "fetch_page",
  "parse_rss",
  "parse_atom",
  "extract_list",
  "extract_single",
  "follow_link",
  "download_asset",
  "paginate",
  "dedupe",
] as const;
export type SourceRecipePrimitiveName = (typeof SOURCE_RECIPE_PRIMITIVE_NAMES)[number];

export const SOURCE_RECIPE_VALUE_KIND_VALUES = ["none", "html", "items"] as const;

/** Network permission a primitive can require: none, only the (pre-fetched) primary endpoint, or live fetches guarded by the envelope's origin allowlist. */
export const SOURCE_RECIPE_NETWORK_ACCESS_VALUES = ["none", "primary_endpoint", "live_fetch"] as const;
export type SourceRecipeNetworkAccess = (typeof SOURCE_RECIPE_NETWORK_ACCESS_VALUES)[number];

/** Registry read model for one primitive: identity, dataflow kinds, and permission declaration. The step parameter schema itself is the corresponding member of `SourceRecipeStepSchema`. */
export const SourceRecipePrimitiveDefinitionDTOSchema = z
  .object({
    name: z.enum(SOURCE_RECIPE_PRIMITIVE_NAMES),
    version: z.number().int().positive(),
    description: z.string(),
    input_kind: z.enum(SOURCE_RECIPE_VALUE_KIND_VALUES),
    output_kind: z.enum(SOURCE_RECIPE_VALUE_KIND_VALUES),
    network_access: z.enum(SOURCE_RECIPE_NETWORK_ACCESS_VALUES),
    writes_files: z.boolean(),
  })
  .passthrough();
export type SourceRecipePrimitiveDefinitionDTO = z.infer<
  typeof SourceRecipePrimitiveDefinitionDTOSchema
>;

// --- Recipe step schemas (one per primitive) ---

export const SourceRecipeSelectorSchema = z
  .object({
    css_class: z.string().min(1),
  })
  .passthrough();
export type SourceRecipeSelector = z.infer<typeof SourceRecipeSelectorSchema>;

export const SourceRecipeNextPageSchema = z.discriminatedUnion("mode", [
  z
    .object({ mode: z.literal("query_param"), param: z.string().min(1), start_page: z.number().int().min(2) })
    .passthrough(),
  z.object({ mode: z.literal("link_rel_next") }).passthrough(),
]);
export type SourceRecipeNextPage = z.infer<typeof SourceRecipeNextPageSchema>;

export interface SourceRecipeFetchPageStep {
  type: "fetch_page";
  /** `SOURCE_RECIPE_PRIMARY_ENDPOINT_URL` or a literal absolute HTTP(S) URL (live fetch, origin-guarded). */
  url: string;
  bind: string;
}
export interface SourceRecipeParseRssStep {
  type: "parse_rss";
  input: string;
  bind: string;
  max_items?: number;
}
export interface SourceRecipeParseAtomStep {
  type: "parse_atom";
  input: string;
  bind: string;
  max_items?: number;
}
export interface SourceRecipeExtractListStep {
  type: "extract_list";
  input: string;
  selector: SourceRecipeSelector;
  bind: string;
  max_items?: number;
}
export interface SourceRecipeExtractSingleStep {
  type: "extract_single";
  input: string;
  bind: string;
}
export interface SourceRecipeFollowLinkStep {
  type: "follow_link";
  /** Name of an items-kind variable; each item's own `source_uri` is fetched (bounded by `max_follow`) and merged into that item. */
  items_var: string;
  max_follow: number;
}
export interface SourceRecipeDownloadAssetStep {
  type: "download_asset";
  /** Name of an items-kind variable; each item's own `source_uri` is downloaded and stored as a snapshot. */
  items_var: string;
  mime_allowlist?: string[];
}
export interface SourceRecipePaginateStep {
  type: "paginate";
  /** Name of an html-kind variable already bound by an earlier `fetch_page` (page 1). */
  input: string;
  max_pages: number;
  next_page: SourceRecipeNextPage;
  /** Re-run for each subsequent page; must not itself contain a nested `paginate` step. */
  steps: SourceRecipeStep[];
  /** Name of the items-kind variable `steps` binds one page's extraction to. */
  page_items_var: string;
  /** Merged items-kind variable across every page. */
  bind: string;
}
export interface SourceRecipeDedupeStep {
  type: "dedupe";
  input: string;
  bind: string;
  /** Duplicate key; defaults to `external_id`. */
  by?: "external_id" | "source_uri";
}
export type SourceRecipeStep =
  | SourceRecipeFetchPageStep
  | SourceRecipeParseRssStep
  | SourceRecipeParseAtomStep
  | SourceRecipeExtractListStep
  | SourceRecipeExtractSingleStep
  | SourceRecipeFollowLinkStep
  | SourceRecipeDownloadAssetStep
  | SourceRecipePaginateStep
  | SourceRecipeDedupeStep;

const recipeFetchPageStepSchema = z
  .object({ type: z.literal("fetch_page"), url: z.string().min(1), bind: z.string().min(1) })
  .passthrough();
const recipeParseRssStepSchema = z
  .object({
    type: z.literal("parse_rss"),
    input: z.string().min(1),
    bind: z.string().min(1),
    max_items: z.number().int().positive().optional(),
  })
  .passthrough();
const recipeParseAtomStepSchema = z
  .object({
    type: z.literal("parse_atom"),
    input: z.string().min(1),
    bind: z.string().min(1),
    max_items: z.number().int().positive().optional(),
  })
  .passthrough();
const recipeExtractListStepSchema = z
  .object({
    type: z.literal("extract_list"),
    input: z.string().min(1),
    selector: SourceRecipeSelectorSchema,
    bind: z.string().min(1),
    max_items: z.number().int().positive().optional(),
  })
  .passthrough();
const recipeExtractSingleStepSchema = z
  .object({ type: z.literal("extract_single"), input: z.string().min(1), bind: z.string().min(1) })
  .passthrough();
const recipeFollowLinkStepSchema = z
  .object({
    type: z.literal("follow_link"),
    items_var: z.string().min(1),
    max_follow: z.number().int().nonnegative(),
  })
  .passthrough();
const recipeDownloadAssetStepSchema = z
  .object({
    type: z.literal("download_asset"),
    items_var: z.string().min(1),
    mime_allowlist: z.array(z.string()).optional(),
  })
  .passthrough();
const recipeDedupeStepSchema = z
  .object({
    type: z.literal("dedupe"),
    input: z.string().min(1),
    bind: z.string().min(1),
    by: z.enum(["external_id", "source_uri"]).optional(),
  })
  .passthrough();

// `paginate.steps` is the only recursive edge — same `z.lazy` idiom as
// `CustomSourcePipelineStepSchema` (sourceCustomSourceHandlers.ts).
const recipePaginateStepSchema = z
  .object({
    type: z.literal("paginate"),
    input: z.string().min(1),
    max_pages: z.number().int().positive(),
    next_page: SourceRecipeNextPageSchema,
    steps: z.lazy(() => z.array(SourceRecipeStepSchema)),
    page_items_var: z.string().min(1),
    bind: z.string().min(1),
  })
  .passthrough();

export const SourceRecipeStepSchema: z.ZodType<SourceRecipeStep> = z.discriminatedUnion("type", [
  recipeFetchPageStepSchema,
  recipeParseRssStepSchema,
  recipeParseAtomStepSchema,
  recipeExtractListStepSchema,
  recipeExtractSingleStepSchema,
  recipeFollowLinkStepSchema,
  recipeDownloadAssetStepSchema,
  recipePaginateStepSchema,
  recipeDedupeStepSchema,
]);

/** `paginate.steps` must not itself contain a `paginate` step at any depth — rejected at validation time, not discovered at execution time. */
function findNestedPaginatePaths(
  steps: SourceRecipeStep[],
  allowPaginateHere: boolean,
  path: (string | number)[],
): (string | number)[][] {
  const found: (string | number)[][] = [];
  steps.forEach((step, index) => {
    if (step.type !== "paginate") return;
    const stepPath = [...path, index];
    if (!allowPaginateHere) found.push([...stepPath, "type"]);
    found.push(...findNestedPaginatePaths(step.steps, false, [...stepPath, "steps"]));
  });
  return found;
}

export const SourceRecipeDefinitionSchema = z
  .object({
    recipe_version: z.literal(SOURCE_RECIPE_CONTRACT_VERSION),
    steps: z.array(SourceRecipeStepSchema).min(1),
    output: z.object({ items_var: z.string().min(1) }).passthrough(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const path of findNestedPaginatePaths(value.steps, true, ["steps"])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a paginate step must not be nested inside another paginate step's steps",
        path,
      });
    }
  });
export type SourceRecipeDefinition = z.infer<typeof SourceRecipeDefinitionSchema>;

// --- Shared source policy envelope ---

/**
 * The policy fields shared by the Level 2 recipe path and the Level 3
 * generated-handler fallback. `CustomSourcePolicyEnvelopeSchema` is a
 * structural superset (it adds `language` and the browser/shell/dependency
 * capability flags, which are structurally impossible for a recipe — an
 * in-process step interpreter has no shell or dynamic-code surface).
 *
 * Policy review compares only this envelope: a recipe step/selector change
 * with an identical envelope is never a permission delta; a new network
 * origin, credential reference, broader capture/retention, or larger limit is.
 */
export const SourcePolicyEnvelopeSchema = z
  .object({
    allowed_network_origins: z.array(z.string()),
    capture_policy: z.enum(CUSTOM_SOURCE_CAPTURE_POLICY_VALUES),
    retention_policy: z.enum(CUSTOM_SOURCE_RETENTION_POLICY_VALUES),
    credential_ref: z.string().nullish(),
    log_redaction_enabled: z.boolean().default(true),
    limits: CustomSourcePolicyLimitsSchema,
  })
  .passthrough();
export type SourcePolicyEnvelope = z.infer<typeof SourcePolicyEnvelopeSchema>;

// --- Recipe versions (`source_recipe_versions`) ---

export const SOURCE_RECIPE_VERSION_STATUS_VALUES = [
  "draft",
  "test_failed",
  "pending_approval",
  "active",
  "superseded",
  "disabled",
] as const;
export type SourceRecipeVersionStatus = (typeof SOURCE_RECIPE_VERSION_STATUS_VALUES)[number];

export const SourceRecipeVersionDTOSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    source_connection_id: IdSchema,
    version_number: z.number().int().positive(),
    recipe_json: SourceRecipeDefinitionSchema,
    policy_envelope_json: SourcePolicyEnvelopeSchema,
    /** Primitive name -> registry version the recipe was validated against. */
    primitive_versions_json: z.record(z.number().int().positive()).nullish(),
    status: z.enum(SOURCE_RECIPE_VERSION_STATUS_VALUES),
    created_by_user_id: IdSchema.nullish(),
    proposal_id: IdSchema.nullish(),
    /** Latest dry-run result (`SourceRecipeDryRunResultSchema`) recorded against this version. */
    test_result_json: JsonObjectSchema.nullish(),
    created_at: ISODateTimeSchema,
    activated_at: ISODateTimeSchema.nullish(),
    superseded_at: ISODateTimeSchema.nullish(),
  })
  .passthrough();

// --- Dry-run result and step trace ---

export const SOURCE_RECIPE_STEP_TRACE_STATUS_VALUES = ["succeeded", "failed", "skipped"] as const;
export type SourceRecipeStepTraceStatus = (typeof SOURCE_RECIPE_STEP_TRACE_STATUS_VALUES)[number];

export const SourceRecipeStepTraceSchema = z
  .object({
    /** Position in the recipe, e.g. `steps[1]` or `steps[2].steps[0]` (inside paginate). */
    step_path: z.string(),
    primitive: z.enum(SOURCE_RECIPE_PRIMITIVE_NAMES),
    status: z.enum(SOURCE_RECIPE_STEP_TRACE_STATUS_VALUES),
    detail: z.string().nullish(),
    item_count: z.number().int().nonnegative().nullish(),
    fetched_url: z.string().nullish(),
    duration_ms: z.number().int().nonnegative(),
  })
  .passthrough();
export type SourceRecipeStepTrace = z.infer<typeof SourceRecipeStepTraceSchema>;

export const SOURCE_RECIPE_DRY_RUN_STATUS_VALUES = ["succeeded", "failed", "validation_failed"] as const;
export type SourceRecipeDryRunStatus = (typeof SOURCE_RECIPE_DRY_RUN_STATUS_VALUES)[number];

/**
 * Result of a bounded, side-effect-free dry-run of a draft recipe. Dry-runs
 * never write active Source outputs; `sample_items` is a bounded preview of
 * what a live run would materialize. The envelope is echoed back so network,
 * credential, retention, and output limits are visible in the preview.
 */
export const SourceRecipeDryRunResultSchema = z
  .object({
    status: z.enum(SOURCE_RECIPE_DRY_RUN_STATUS_VALUES),
    item_count: z.number().int().nonnegative(),
    sample_items: z.array(CustomSourceHandlerOutputItemSchema),
    followed_urls: z.array(z.string()),
    skipped_urls: z.array(z.string()),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
    step_traces: z.array(SourceRecipeStepTraceSchema),
    policy_envelope: SourcePolicyEnvelopeSchema,
    started_at: ISODateTimeSchema,
    completed_at: ISODateTimeSchema,
  })
  .passthrough();
export type SourceRecipeDryRunResult = z.infer<typeof SourceRecipeDryRunResultSchema>;

// --- Source runs product read model ---

export const SOURCE_RUN_KIND_VALUES = ["scan", "dry_run", "test", "manual_url", "extract", "other"] as const;
export type SourceRunKind = (typeof SOURCE_RUN_KIND_VALUES)[number];

export const SOURCE_RUN_IMPLEMENTATION_VALUES = ["built_in", "recipe", "generated_handler"] as const;
export type SourceRunImplementation = (typeof SOURCE_RUN_IMPLEMENTATION_VALUES)[number];

export const SOURCE_RUN_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "validation_failed",
  "blocked",
  "skipped",
] as const;
export type SourceRunStatus = (typeof SOURCE_RUN_STATUS_VALUES)[number];

/**
 * Product-level run history for one Source connection. A read model, not a
 * table: rows are projected from `extraction_jobs` (built-in scans and
 * follow-up jobs), `source_handler_runs` (Level 3 handler runs), and recipe
 * dry-run results. `id` is synthetic and stable per underlying row (e.g.
 * `job:<id>`, `handler_run:<id>`, `recipe_dry_run:<version_id>`).
 */
export const SourceRunSummaryDTOSchema = z
  .object({
    id: z.string(),
    space_id: IdSchema,
    source_connection_id: IdSchema,
    run_kind: z.enum(SOURCE_RUN_KIND_VALUES),
    implementation: z.enum(SOURCE_RUN_IMPLEMENTATION_VALUES),
    status: z.enum(SOURCE_RUN_STATUS_VALUES),
    items_created: z.number().int().nonnegative().nullish(),
    error: z.string().nullish(),
    extraction_job_id: IdSchema.nullish(),
    handler_run_id: IdSchema.nullish(),
    recipe_version_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    started_at: ISODateTimeSchema.nullish(),
    completed_at: ISODateTimeSchema.nullish(),
  })
  .passthrough();
export type SourceRunSummaryDTO = z.infer<typeof SourceRunSummaryDTOSchema>;

export const PROJECT_SOURCE_DELIVERY_SCOPE_VALUES = [
  "project_members",
  "source_subscribers",
] as const;

export const SOURCE_HEALTH_STATUS_VALUES = [
  "healthy",
  "running",
  "attention",
  "failing",
  "paused",
] as const;

export const ProjectSourceBindingDTOSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    project_id: IdSchema,
    source_connection_id: IdSchema,
    binding_key: z.string(),
    status: z.enum(["active", "paused", "archived"]),
    priority: z.number().int(),
    delivery_scope: z.enum(PROJECT_SOURCE_DELIVERY_SCOPE_VALUES),
    collection_notifications_enabled: z.boolean(),
    filters_json: z.record(z.unknown()),
    routing_policy_json: z.record(z.unknown()),
    extraction_policy_json: z.record(z.unknown()),
    created_by_user_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .passthrough();

export const ProjectSourceItemDTOSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    project_id: IdSchema,
    project_source_binding_id: IdSchema,
    source_connection_id: IdSchema.nullish(),
    source_item_id: IdSchema,
    status: z.enum(["active", "archived"]),
    matched_at: ISODateTimeSchema,
    match_reason: z.string().nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    item: z.record(z.unknown()),
  })
  .passthrough();

export const SourceHealthDTOSchema = z
  .object({
    binding_id: IdSchema.nullish(),
    project_id: IdSchema.nullish(),
    source_connection_id: IdSchema,
    source_name: z.string(),
    status: z.enum(SOURCE_HEALTH_STATUS_VALUES),
    last_success_at: ISODateTimeSchema.nullish(),
    last_failure_at: ISODateTimeSchema.nullish(),
    last_error: z.string().nullish(),
    next_run_at: ISODateTimeSchema.nullish(),
    queued_jobs: z.number().int().nonnegative(),
    running_jobs: z.number().int().nonnegative(),
    recent_new_items: z.number().int().nonnegative(),
    consecutive_failures: z.number().int().nonnegative(),
  })
  .passthrough();

export const ProjectSourceSummaryDTOSchema = z
  .object({
    project_id: IdSchema,
    bound_source_count: z.number().int().nonnegative(),
    today_new_items: z.number().int().nonnegative(),
    health_counts: z.record(z.number().int().nonnegative()),
    recent_items: z.array(ProjectSourceItemDTOSchema),
  })
  .passthrough();
