/**
 * Object schema / object kind registry contracts.
 *
 * The registry is a governed per-space layer over fixed retrieval object types.
 * It must never replace `RetrievalObjectTypeSchema` or create canonical rows
 * directly; server routes and proposal appliers own authority.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import { RetrievalObjectTypeSchema } from "./knowledgeRetrieval.js";

const UNSAFE_OBJECT_KIND_CONFIG_KEY_TOKENS = new Set([
  "script",
  "scripts",
  "shell",
  "command",
  "commands",
  "sql",
  "query_sql",
  "regex",
  "regexp",
  "pattern",
  "patterns",
  "provider_tool",
  "provider_tools",
  "tool",
  "tools",
  "executable",
]);

const JsonObjectSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "object schema config must be JSON serializable" });
    return;
  }
  if (serialized.length > 16_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "object schema config is too large" });
    return;
  }
  const violation = objectKindConfigViolation(value, "config", 0);
  if (violation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: violation });
});
const ObjectKindKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

function objectKindConfigViolation(value: unknown, path: string, depth: number): string | null {
  if (depth > 8) return `${path} is too deeply nested`;
  if (Array.isArray(value)) {
    if (value.length > 200) return `${path} has too many array entries`;
    for (let index = 0; index < value.length; index += 1) {
      const violation = objectKindConfigViolation(value[index], `${path}[${index}]`, depth + 1);
      if (violation) return violation;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (unsafeObjectKindConfigKey(key)) {
      return `${path}.${key} is not allowed in object schema config`;
    }
    const violation = objectKindConfigViolation(entry, `${path}.${key}`, depth + 1);
    if (violation) return violation;
  }
  return null;
}

function unsafeObjectKindConfigKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => UNSAFE_OBJECT_KIND_CONFIG_KEY_TOKENS.has(token));
}

function refineObjectKindKeyMatchesBase(
  value: { key: string; base_object_type: SpaceObjectKindBaseObjectType },
  ctx: z.RefinementCtx,
): void {
  const allowed = OBJECT_KIND_KEY_VALUES_BY_BASE_OBJECT_TYPE[value.base_object_type];
  if (!allowed.includes(value.key as never)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["key"],
      message: `object kind key must match the canonical ${value.base_object_type} subtype (${allowed.join(", ")})`,
    });
  }
}

export const SpaceObjectKindStatusSchema = z.enum(["draft", "active", "deprecated", "archived"]);
export type SpaceObjectKindStatus = z.infer<typeof SpaceObjectKindStatusSchema>;

export const SpaceObjectKindBaseObjectTypeSchema = RetrievalObjectTypeSchema;
export type SpaceObjectKindBaseObjectType = z.infer<typeof SpaceObjectKindBaseObjectTypeSchema>;

export const OBJECT_KIND_KEY_VALUES_BY_BASE_OBJECT_TYPE = {
  knowledge_item: ["concept", "lesson", "procedure", "decision", "question", "answer", "summary"],
  note: ["note"],
  source: ["activity_record", "chat_capture", "webpage", "article", "paper", "pdf", "file", "email", "manual_reference", "external_note"],
  claim: ["fact", "hypothesis", "belief", "preference", "commitment", "question", "interpretation", "instruction", "metric", "relationship", "event"],
  memory_entry: ["preference", "semantic", "episodic", "procedural", "project"],
  project_public_summary: ["project_public_summary"],
  source_item: ["external_url", "feed_entry", "activity_record", "artifact", "run_event", "file", "document", "log"],
  extracted_evidence: ["document", "excerpt", "event", "log", "artifact", "claim", "summary"],
  inquiry_thread: ["question", "hypothesis"],
} as const satisfies Record<SpaceObjectKindBaseObjectType, readonly string[]>;

export const OBJECT_SCHEMA_RELATION_TYPE_VALUES = [
  "related_to",
  "explains",
  "depends_on",
  "prerequisite_of",
  "part_of",
  "example_of",
  "applies_to",
  "supports",
  "contradicts",
  "derived_from",
  "summarizes",
  "updates",
  "references",
  "source_for",
  "about",
  "supersedes",
  "refines",
  "same_as",
] as const;

export const SpaceObjectKindRelationHintDirectionSchema = z.enum(["from", "to", "either"]);
export type SpaceObjectKindRelationHintDirection = z.infer<typeof SpaceObjectKindRelationHintDirectionSchema>;

export const SpaceObjectKindRelationHintRelationTypeSchema = z.enum(OBJECT_SCHEMA_RELATION_TYPE_VALUES);
export type SpaceObjectKindRelationHintRelationType = z.infer<typeof SpaceObjectKindRelationHintRelationTypeSchema>;

export const SpaceObjectKindRelationHintRequestSchema = z
  .object({
    endpoint_object_type: SpaceObjectKindBaseObjectTypeSchema,
    endpoint_object_kind_id: IdSchema.nullish(),
    relation_type: SpaceObjectKindRelationHintRelationTypeSchema,
    direction: SpaceObjectKindRelationHintDirectionSchema.default("from"),
    confidence_default: z.number().min(0).max(1).default(0.55),
    required: z.boolean().default(false),
  })
  .strict();
export type SpaceObjectKindRelationHintRequest = z.infer<typeof SpaceObjectKindRelationHintRequestSchema>;

export const SpaceObjectKindOutSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    key: ObjectKindKeySchema,
    label: z.string().min(1),
    description: z.string().nullable(),
    base_object_type: SpaceObjectKindBaseObjectTypeSchema,
    status: SpaceObjectKindStatusSchema,
    version: z.number().int().positive(),
    field_schema: JsonObjectSchema,
    extraction_policy: JsonObjectSchema,
    retrieval_policy: JsonObjectSchema,
    ui_config: JsonObjectSchema,
    relation_hints: z.array(SpaceObjectKindRelationHintRequestSchema.extend({ id: IdSchema })).default([]),
    created_by_user_id: IdSchema.nullish(),
    created_from_proposal_id: IdSchema.nullish(),
    updated_from_proposal_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type SpaceObjectKindOut = z.infer<typeof SpaceObjectKindOutSchema>;

export const SpaceObjectKindPageSchema = z
  .object({
    items: z.array(SpaceObjectKindOutSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    ...SecretResponseGuards,
  })
  .strict();
export type SpaceObjectKindPage = z.infer<typeof SpaceObjectKindPageSchema>;

export const SpaceObjectKindListRequestSchema = z
  .object({
    base_object_type: SpaceObjectKindBaseObjectTypeSchema.optional(),
    status: SpaceObjectKindStatusSchema.optional(),
    limit: z.number().int().positive().max(200).default(50),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
export type SpaceObjectKindListRequest = z.infer<typeof SpaceObjectKindListRequestSchema>;

export const SpaceObjectKindCreateProposalRequestSchema = z
  .object({
    key: ObjectKindKeySchema,
    label: z.string().min(1).max(160),
    description: z.string().max(2000).nullable().optional(),
    base_object_type: SpaceObjectKindBaseObjectTypeSchema,
    status: z.enum(["draft", "active"]).default("active"),
    field_schema: JsonObjectSchema.default({}),
    extraction_policy: JsonObjectSchema.default({}),
    retrieval_policy: JsonObjectSchema.default({}),
    ui_config: JsonObjectSchema.default({}),
    relation_hints: z.array(SpaceObjectKindRelationHintRequestSchema).max(50).default([]),
    rationale: z.string().max(4000).optional(),
  })
  .strict()
  .superRefine(refineObjectKindKeyMatchesBase);
export type SpaceObjectKindCreateProposalRequest = z.infer<typeof SpaceObjectKindCreateProposalRequestSchema>;

export const SpaceObjectKindUpdateProposalRequestSchema = z
  .object({
    label: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
    status: z.literal("active").optional(),
    field_schema: JsonObjectSchema.optional(),
    extraction_policy: JsonObjectSchema.optional(),
    retrieval_policy: JsonObjectSchema.optional(),
    ui_config: JsonObjectSchema.optional(),
    relation_hints: z.array(SpaceObjectKindRelationHintRequestSchema).max(50).optional(),
    rationale: z.string().max(4000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.label !== undefined ||
      value.description !== undefined ||
      value.status !== undefined ||
      value.field_schema !== undefined ||
      value.extraction_policy !== undefined ||
      value.retrieval_policy !== undefined ||
      value.ui_config !== undefined ||
      value.relation_hints !== undefined,
    "at least one object kind field is required",
  );
export type SpaceObjectKindUpdateProposalRequest = z.infer<typeof SpaceObjectKindUpdateProposalRequestSchema>;

export const SpaceObjectKindStatusProposalRequestSchema = z
  .object({
    rationale: z.string().max(4000).optional(),
  })
  .strict();
export type SpaceObjectKindStatusProposalRequest = z.infer<typeof SpaceObjectKindStatusProposalRequestSchema>;

export const ObjectSchemaManifestRelationHintSchema = z
  .object({
    endpoint_object_type: SpaceObjectKindBaseObjectTypeSchema,
    endpoint_object_kind_key: ObjectKindKeySchema.nullish(),
    relation_type: SpaceObjectKindRelationHintRelationTypeSchema,
    direction: SpaceObjectKindRelationHintDirectionSchema.default("from"),
    confidence_default: z.number().min(0).max(1).default(0.55),
    required: z.boolean().default(false),
  })
  .strict();
export type ObjectSchemaManifestRelationHint = z.infer<typeof ObjectSchemaManifestRelationHintSchema>;

export const ObjectSchemaManifestKindSchema = z
  .object({
    key: ObjectKindKeySchema,
    label: z.string().min(1).max(160),
    description: z.string().max(2000).nullable().optional(),
    base_object_type: SpaceObjectKindBaseObjectTypeSchema,
    status: SpaceObjectKindStatusSchema.optional(),
    version: z.number().int().positive().optional(),
    field_schema: JsonObjectSchema.default({}),
    extraction_policy: JsonObjectSchema.default({}),
    retrieval_policy: JsonObjectSchema.default({}),
    ui_config: JsonObjectSchema.default({}),
    relation_hints: z.array(ObjectSchemaManifestRelationHintSchema).max(50).default([]),
  })
  .strict()
  .superRefine(refineObjectKindKeyMatchesBase);
export type ObjectSchemaManifestKind = z.infer<typeof ObjectSchemaManifestKindSchema>;

export const ObjectSchemaExportManifestSchema = z
  .object({
    format: z.literal("agent_space.object_schema.v1"),
    exported_at: ISODateTimeSchema,
    object_schema_version: z.number().int().nonnegative(),
    object_kinds: z.array(ObjectSchemaManifestKindSchema).max(500),
    metadata: JsonObjectSchema.default({}),
    ...SecretResponseGuards,
  })
  .strict();
export type ObjectSchemaExportManifest = z.infer<typeof ObjectSchemaExportManifestSchema>;

export const ObjectSchemaImportRequestSchema = z
  .object({
    manifest: ObjectSchemaExportManifestSchema,
    rationale: z.string().max(4000).optional(),
  })
  .strict();
export type ObjectSchemaImportRequest = z.infer<typeof ObjectSchemaImportRequestSchema>;

export const ObjectSchemaImportResponseSchema = z
  .object({
    created_proposal_count: z.number().int().nonnegative(),
    skipped_count: z.number().int().nonnegative(),
    proposal_ids: z.array(IdSchema),
    skipped: z.array(JsonObjectSchema).default([]),
    warnings: z.array(z.string()).default([]),
    ...SecretResponseGuards,
  })
  .strict();
export type ObjectSchemaImportResponse = z.infer<typeof ObjectSchemaImportResponseSchema>;

export const ObjectSchemaSuggestionScanRequestSchema = z
  .object({
    base_object_types: z.array(SpaceObjectKindBaseObjectTypeSchema).max(6).optional(),
    limit: z.number().int().positive().max(200).default(100),
    persist_artifact: z.boolean().default(true),
    review_scope: z.enum(["private", "space_ops"]).default("private"),
  })
  .strict();
export type ObjectSchemaSuggestionScanRequest = z.infer<typeof ObjectSchemaSuggestionScanRequestSchema>;

export const ObjectSchemaSuggestionFindingSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["missing_object_kind", "deprecated_kind_usage", "unused_active_kind"]),
    base_object_type: SpaceObjectKindBaseObjectTypeSchema,
    object_kind: ObjectKindKeySchema,
    title: z.string(),
    reason: z.string(),
    confidence_tier: z.enum(["high", "medium", "low"]),
    visible_usage_count: z.number().int().nonnegative(),
    proposed_action: z.record(z.unknown()).nullable().default(null),
    evidence_refs: z.array(z.record(z.unknown())).default([]),
    markers: z.record(z.unknown()).default({}),
  })
  .strict();
export type ObjectSchemaSuggestionFinding = z.infer<typeof ObjectSchemaSuggestionFindingSchema>;

export const ObjectSchemaSuggestionReportSchema = z
  .object({
    findings: z.array(ObjectSchemaSuggestionFindingSchema).default([]),
    counts: z.record(z.number()).default({}),
    scanned: z.object({
      visible_usage_rows: z.number().int().nonnegative(),
      registry_rows: z.number().int().nonnegative(),
    }),
    truncated: z.boolean().default(false),
    access_safety: z.object({
      only_visible_usage: z.literal(true),
      raw_content_read: z.literal(false),
      hidden_counts_included: z.literal(false),
      provider_call_performed: z.literal(false),
      canonical_write_performed: z.literal(false),
    }),
  })
  .strict();
export type ObjectSchemaSuggestionReport = z.infer<typeof ObjectSchemaSuggestionReportSchema>;

export const ObjectSchemaSuggestionScanResponseSchema = z
  .object({
    report: ObjectSchemaSuggestionReportSchema,
    finding_count: z.number().int().nonnegative(),
    artifact_id: IdSchema.optional(),
    ...SecretResponseGuards,
  })
  .strict();
export type ObjectSchemaSuggestionScanResponse = z.infer<typeof ObjectSchemaSuggestionScanResponseSchema>;
