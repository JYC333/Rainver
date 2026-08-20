import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

// ---------------------------------------------------------------------------
// Project public summary contracts
//
// The Project Public Summary is the deliberately sanitized, space-public
// discovery layer for a project (see PROJECTS.md / SECURITY_AND_ACCESS_BOUNDARIES.md).
// It is intentionally separate from concrete project memory: it carries only
// high-level redacted fields and pointer-only source refs. These contracts are
// the wire shape for the `/api/v1/projects/.../public-summary*` routes.
// ---------------------------------------------------------------------------

export const ProjectPublicSummaryReviewStatusSchema = z.enum([
  "draft",
  "approved",
  "archived",
]);

/** Pointer-only provenance ref. Must never embed raw source content. */
export const ProjectPublicSummarySourceRefSchema = z
  .object({
    source_type: z.string().min(1),
    source_id: z.string().min(1),
    label: z.string().optional(),
    trust_level: z.string().optional(),
  })
  .passthrough();

export const ProjectPublicSummarySchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    project_id: IdSchema,
    project_name: z.string(),
    summary_text: z.string(),
    topics: z.array(z.string()).default([]),
    highlights: z.array(z.string()).default([]),
    source_refs: z.array(z.record(z.unknown())).default([]),
    redaction_version: z.string(),
    review_status: ProjectPublicSummaryReviewStatusSchema,
    updated_by_user_id: IdSchema.nullable(),
    generated_by_run_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();

export const ProjectPublicSummaryListResponseSchema = z
  .object({
    items: z.array(ProjectPublicSummarySchema).default([]),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    ...SecretResponseGuards,
  })
  .passthrough();

/**
 * PUT body. A bare write stages a `draft`; `review_status` other than `draft`
 * is a publish/unpublish action and is gated to project-owner-level authority
 * server-side. Legacy `*_json` aliases are accepted and pass through.
 */
export const ProjectPublicSummaryUpsertRequestSchema = z
  .object({
    summary_text: z.string().trim().min(1).max(4000),
    topics: z.array(z.string()).optional(),
    highlights: z.array(z.string()).optional(),
    source_refs: z.array(ProjectPublicSummarySourceRefSchema).optional(),
    review_status: ProjectPublicSummaryReviewStatusSchema.optional(),
    redaction_version: z.string().optional(),
    generated_by_run_id: IdSchema.optional(),
  })
  .passthrough();
export type ProjectPublicSummaryUpsertRequest = z.infer<
  typeof ProjectPublicSummaryUpsertRequestSchema
>;

/** POST .../public-summary/draft body. All fields optional. */
export const ProjectPublicSummaryDraftRequestSchema = z
  .object({
    model_provider_id: IdSchema.optional(),
    provider_id: IdSchema.optional(),
    model: z.string().optional(),
    max_tokens: z.number().int().positive().max(8000).optional(),
    generated_by_run_id: IdSchema.optional(),
  })
  .passthrough();
export type ProjectPublicSummaryDraftRequest = z.infer<
  typeof ProjectPublicSummaryDraftRequestSchema
>;

// ---------------------------------------------------------------------------
// Project Kernel contracts: Project Brief, Primary Mode, Attention, and
// Overview. See `.agent/architecture/PROJECTS.md` and ADR 0011.
// ---------------------------------------------------------------------------

// One classification axis, valued by how work advances rather than by subject
// matter. `inquiry` and `decision` were absorbed into `research`: asking is how
// research starts and deciding is where it ends, and both remain entities with
// their own Areas that a Project of any Mode can hold.
export const ProjectPrimaryModeSchema = z.enum([
  "research",
  "delivery",
  "operations",
  "learning",
]);
export type ProjectPrimaryMode = z.infer<typeof ProjectPrimaryModeSchema>;

export const ProjectBriefVersionSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    project_id: IdSchema,
    version: z.string(),
    goal: z.string().nullable(),
    scope_included: z.string().nullable(),
    scope_excluded: z.string().nullable(),
    success_definition: z.string().nullable(),
    constraints: z.string().nullable(),
    assumptions: z.string().nullable(),
    project_status: z.string().trim().min(1),
    current_focus: z.string().nullable(),
    confirmed_decisions: z.array(z.string()),
    primary_mode: ProjectPrimaryModeSchema,
    workspace_identity: z.record(z.unknown()),
    workspace_boundary: z.record(z.unknown()),
    source_refs: z.array(z.record(z.unknown())),
    status: z.enum(["draft", "in_review", "published", "archived"]),
    reviewed_by_user_id: IdSchema.nullable(),
    reviewed_at: ISODateTimeSchema.nullable(),
    published_by_user_id: IdSchema.nullable(),
    published_at: ISODateTimeSchema.nullable(),
    created_by_user_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
  })
  .strict();
export type ProjectBriefVersion = z.infer<typeof ProjectBriefVersionSchema>;

export const ProjectBriefVersionWriteRequestSchema = ProjectBriefVersionSchema.pick({
  goal: true,
  scope_included: true,
  scope_excluded: true,
  success_definition: true,
  constraints: true,
  assumptions: true,
  confirmed_decisions: true,
  workspace_identity: true,
  workspace_boundary: true,
  source_refs: true,
}).partial().strict();

export const ProjectInstructionVersionSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  project_id: IdSchema,
  version: z.string(),
  title: z.string(),
  instruction_text: z.string(),
  status: z.enum(["draft", "in_review", "published", "archived"]),
  reviewed_by_user_id: IdSchema.nullable(),
  reviewed_at: ISODateTimeSchema.nullable(),
  published_by_user_id: IdSchema.nullable(),
  published_at: ISODateTimeSchema.nullable(),
  created_by_user_id: IdSchema,
  created_at: ISODateTimeSchema,
}).strict();
export type ProjectInstructionVersion = z.infer<typeof ProjectInstructionVersionSchema>;

export const ProjectInstructionVersionWriteRequestSchema = z.object({
  title: z.string().trim().min(1).max(256),
  instruction_text: z.string().trim().min(1).max(50_000),
}).strict();

export const ProjectModeTransitionSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    project_id: IdSchema,
    from_mode: ProjectPrimaryModeSchema.nullable(),
    to_mode: ProjectPrimaryModeSchema,
    reason: z.string().nullable(),
    trigger_ref: z.string().nullable(),
    confirmed_by_user_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
  })
  .passthrough();

export const ProjectAttentionSeveritySchema = z.enum(["low", "normal", "high", "critical"]);
export type ProjectAttentionSeverity = z.infer<typeof ProjectAttentionSeveritySchema>;

export const ProjectAttentionItemSchema = z
  .object({
    id: z.string(),
    project_id: IdSchema,
    area_kind: z.string(),
    source_type: z.string(),
    source_id: z.string(),
    severity: ProjectAttentionSeveritySchema,
    title: z.string(),
    summary: z.string().nullable(),
    reason: z.string().nullable(),
    due_at: ISODateTimeSchema.nullable(),
    blocking_refs: z.array(z.string()).default([]),
    action_descriptors: z.array(z.object({ label: z.string(), href: z.string() })).default([]),
    href: z.string(),
    user_state: z
      .object({
        seen_at: ISODateTimeSchema.nullable(),
        snoozed_until: ISODateTimeSchema.nullable(),
        pinned_at: ISODateTimeSchema.nullable(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
export type ProjectAttentionItem = z.infer<typeof ProjectAttentionItemSchema>;

export const ModeOverviewProjectionSchema = z
  .object({
    mode: ProjectPrimaryModeSchema,
    current_state_summary: z.string(),
    progress_indicators: z
      .array(
        z.object({
          metric: z.string(),
          value: z.number(),
          trend: z.enum(["up", "down", "flat"]).optional(),
        }),
      )
      .default([]),
    focus_set: z.array(z.object({ id: z.string(), label: z.string(), href: z.string() })).default([]),
    next_actions: z
      .array(z.object({ id: z.string(), label: z.string(), href: z.string(), kind: z.string() }))
      .default([]),
  })
  .passthrough();
export type ModeOverviewProjection = z.infer<typeof ModeOverviewProjectionSchema>;

export const ProjectOverviewResponseSchema = z
  .object({
    project: z
      .object({
        id: IdSchema,
        name: z.string(),
        primary_mode: ProjectPrimaryModeSchema,
        status: z.string(),
      })
      .passthrough(),
    brief: ProjectBriefVersionSchema.nullable(),
    definition_status: z.object({
      status: z.enum(["initialized", "needs_definition"]),
      basis: z.enum(["published_brief_goal", "missing_published_brief_goal"]),
      goal_or_problem: z.string().nullable(),
    }).strict(),
    mode_projection: ModeOverviewProjectionSchema,
    available_modes: z.array(ProjectPrimaryModeSchema),
    attention: z.array(ProjectAttentionItemSchema),
    setup_checklist: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        status: z.enum(["ready", "missing"]),
        required: z.boolean(),
        href: z.string(),
        detail: z.string(),
      }),
    ),
    // How much of each kind of thing the Project holds, and the way into the
    // Area that owns it. Never a list of Areas: every navigation Area stays
    // reachable whatever this contains.
    entity_summaries: z.array(
      z.object({
        entity_type: z.string(),
        label: z.string(),
        detail: z.string(),
        href: z.string(),
        count: z.number(),
        status: z.enum(["ok", "attention", "blocked"]),
      }),
    ),
  })
  .passthrough();
