import { z } from "zod";
import { DigestLocalDateSchema } from "./informationDigests.js";
import { ISODateTimeSchema, IdSchema } from "./common.js";

/**
 * Information briefings: a versioned synthesis over a scope's frozen input
 * manifest (Project now; personal scope shares the same contract).
 *
 * The model returns `information_briefing.v1`. Every visible unit names the
 * manifest references it depends on (`S…` material, `C…` context); the server
 * validates them against the manifest and re-checks them for the current
 * audience on every read. A structurally valid briefing is not a verified one:
 * validation proves the references exist, not that they support the text.
 */

export const BRIEFING_PROTOCOL_VERSION = "information_briefing.v1" as const;

export const BriefingScopeTypeSchema = z.enum(["project", "personal"]);
export type BriefingScopeType = z.infer<typeof BriefingScopeTypeSchema>;

/** `manual`: an explicit current-cutoff request. `daily`: the scope's sealed day. `backfill`: a sealed day built later. */
export const BriefingKindSchema = z.enum(["manual", "daily", "backfill"]);
export type BriefingKind = z.infer<typeof BriefingKindSchema>;

export const BriefingStatusSchema = z.enum(["queued", "ready", "failed", "blocked", "cancelled"]);
export type BriefingStatus = z.infer<typeof BriefingStatusSchema>;

/** `briefing`: model synthesis. `no_new_material`: nothing new since the previous briefing. `no_material`: nothing analysable in scope. */
export const BriefingOutcomeSchema = z.enum(["briefing", "no_new_material", "no_material"]);
export type BriefingOutcome = z.infer<typeof BriefingOutcomeSchema>;

/**
 * How an input relates to the previous briefing of the same scope. Server
 * derived, never model chosen. `newly_found`: older material first seen now,
 * never presented as a new publication. `background`: already briefed and
 * unchanged, re-sent (re-authorized) only as comparison or to reassess impact
 * after the Project context changed; never news.
 */
export const BriefingDeltaClassSchema = z.enum([
  "baseline", "new_publication", "newly_found", "revised", "evidenced_change", "unknown_time", "background",
]);
export type BriefingDeltaClass = z.infer<typeof BriefingDeltaClassSchema>;

const RefKeySchema = z.string().regex(/^[SC]\d{1,3}$/);
const Text = (max: number) => z.string().trim().min(1).max(max);

export const BriefingStatementSchema = z.object({
  kind: z.enum(["fact", "inference", "open_question"]),
  text: Text(600),
  refs: z.array(RefKeySchema).max(12),
}).strict();

export const BriefingHighlightOutputSchema = z.object({
  title: Text(160),
  what_changed: Text(600),
  /** `baseline` only in a first briefing; `new`/`update` must cite matching new inputs; `ongoing` is not news. */
  novelty: z.enum(["baseline", "new", "update", "ongoing"]),
  importance: z.enum(["high", "medium", "low"]),
  why_it_matters: Text(600),
  impact: z.object({
    assessment: z.enum(["affects", "insufficient_context"]),
    text: Text(600),
    context_refs: z.array(RefKeySchema).max(8),
  }).strict(),
  suggested_action: z.enum(["act", "watch", "none"]),
  statements: z.array(BriefingStatementSchema).min(1).max(8),
  /** Conflicting reports kept visible rather than merged away. */
  contradictions: Text(600).nullable().optional(),
  refs: z.array(RefKeySchema).min(1).max(16),
}).strict();

export const BriefingModelOutputSchema = z.object({
  schema: z.literal(BRIEFING_PROTOCOL_VERSION),
  overview: z.object({ text: Text(1200), refs: z.array(RefKeySchema).min(1).max(24) }).strict(),
  highlights: z.array(BriefingHighlightOutputSchema).max(8),
  open_questions: z.array(z.object({ text: Text(400), refs: z.array(RefKeySchema).min(1).max(8) }).strict()).max(6).default([]),
}).strict();
export type BriefingModelOutput = z.infer<typeof BriefingModelOutputSchema>;

export const BriefingCoverageSchema = z.object({
  /** Window searched: `[since, cutoff]`; `since` is null for a baseline's bounded window start. */
  since: ISODateTimeSchema.nullable(),
  cutoff: ISODateTimeSchema,
  candidates: z.number().int().nonnegative(),
  included: z.number().int().nonnegative(),
  merged_duplicates: z.number().int().nonnegative(),
  not_ready: z.number().int().nonnegative(),
  truncated: z.number().int().nonnegative(),
  egress_refused: z.number().int().nonnegative(),
  not_shared_with_audience: z.number().int().nonnegative(),
  /** Previously pending items (not ready, truncated, refused) evaluated again. */
  carried_from_previous: z.number().int().nonnegative(),
  /** Already in the previous version unchanged: context, not news. */
  unchanged_since_previous: z.number().int().nonnegative(),
  /** Unchanged, previously briefed material re-sent only as comparison background. */
  background: z.number().int().nonnegative(),
  /** The Project goal/constraints/tasks changed since the previous briefing. */
  context_changed: z.boolean(),
  /** True only when nothing was left out for any of the reasons above. */
  complete: z.boolean(),
}).strict();
export type BriefingCoverage = z.infer<typeof BriefingCoverageSchema>;

export const BriefingEvidenceSchema = z.object({
  key: RefKeySchema,
  source_item_id: IdSchema,
  title: z.string(),
  source_domain: z.string().nullable(),
  occurred_at: ISODateTimeSchema.nullable(),
  delta_class: BriefingDeltaClassSchema,
  /** Agent-provided material nobody verified independently. */
  unverified: z.boolean(),
  lenses: z.array(z.object({ kind: z.enum(["following", "monitoring", "corpus"]), label: z.string() }).strict()),
}).strict();
export type BriefingEvidence = z.infer<typeof BriefingEvidenceSchema>;

export const BriefingContextRefSchema = z.object({
  key: RefKeySchema,
  kind: z.enum(["project_goal", "project_scope", "project_success", "project_constraints", "project_focus", "task"]),
  label: z.string(),
}).strict();
export type BriefingContextRef = z.infer<typeof BriefingContextRefSchema>;

export const BriefingHighlightSchema = BriefingHighlightOutputSchema.extend({
  /** Distinct source domains it cites. A count of domains, not of independent confirmation: one report syndicated or reposted can span several. */
  source_domains: z.number().int().nonnegative(),
  /** Some fact here rests only on unverified material. */
  rests_on_unverified: z.boolean(),
});
export type BriefingHighlight = z.infer<typeof BriefingHighlightSchema>;

export const BriefingSummarySchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  kind: BriefingKindSchema,
  status: BriefingStatusSchema,
  outcome: BriefingOutcomeSchema.nullable(),
  comparison: z.enum(["baseline", "delta"]),
  period_date: DigestLocalDateSchema.nullable(),
  cutoff_at: ISODateTimeSchema,
  created_at: ISODateTimeSchema,
  completed_at: ISODateTimeSchema.nullable(),
  /** When a later request last found this version still current (bookkeeping; not an input). */
  checked_at: ISODateTimeSchema.nullable(),
  error_code: z.string().nullable(),
}).strict();
export type BriefingSummary = z.infer<typeof BriefingSummarySchema>;

export const BriefingSchema = BriefingSummarySchema.extend({
  scope_type: BriefingScopeTypeSchema,
  previous_briefing_id: IdSchema.nullable(),
  /** Run progress while queued: the canonical Run's status. */
  run_status: z.string().nullable(),
  coverage: BriefingCoverageSchema,
  /** `withheld`: the overview depends on something this audience can no longer read. */
  visibility: z.enum(["visible", "partial", "withheld"]),
  hidden_units: z.number().int().nonnegative(),
  overview: z.object({ text: z.string(), refs: z.array(RefKeySchema) }).nullable(),
  highlights: z.array(BriefingHighlightSchema),
  open_questions: z.array(z.object({ text: z.string(), refs: z.array(RefKeySchema) })),
  evidence: z.array(BriefingEvidenceSchema),
  context: z.array(BriefingContextRefSchema),
  /** The project context changed after this briefing was made. */
  context_outdated: z.boolean(),
}).strict();
export type Briefing = z.infer<typeof BriefingSchema>;

export const BriefingOverviewResponseSchema = z.object({
  can_generate: z.boolean(),
  daily_enabled: z.boolean(),
  /** The newest version of any status, including a "nothing new" check or a failure. */
  latest: BriefingSchema.nullable(),
  /** The newest version with a published briefing, so a later "nothing new" never hides the last real content. */
  latest_briefing: BriefingSchema.nullable(),
  history: z.array(BriefingSummarySchema),
}).strict();
export type BriefingOverviewResponse = z.infer<typeof BriefingOverviewResponseSchema>;

export const BriefingGenerateRequestSchema = z.object({
  agent_id: IdSchema.optional(),
  runtime_profile_id: IdSchema.optional(),
  /** A sealed digest day to brief later (backfill); omitted = current cut-off now. */
  date: DigestLocalDateSchema.optional(),
}).strict();
export type BriefingGenerateRequest = z.infer<typeof BriefingGenerateRequestSchema>;

export const BriefingGenerateResponseSchema = z.object({
  created: z.boolean(),
  briefing: BriefingSchema,
}).strict();
export type BriefingGenerateResponse = z.infer<typeof BriefingGenerateResponseSchema>;

/** Daily briefings run as the writer who enables them, on their own Agent. */
export const BriefingSettingsRequestSchema = z.object({
  daily_enabled: z.boolean(),
  agent_id: IdSchema.optional(),
  runtime_profile_id: IdSchema.optional(),
}).strict();
export type BriefingSettingsRequest = z.infer<typeof BriefingSettingsRequestSchema>;
