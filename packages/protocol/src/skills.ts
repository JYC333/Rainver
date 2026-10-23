/**
 * Open Skill import contracts.
 *
 * External skill packages are untrusted source material. These schemas describe
 * preview, persistence, and conversion request/response shapes only.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";
import { JsonObjectSchema } from "./capabilities.js";
import { ProposalOutSchema } from "./proposals.js";

export const SkillSourceTypeSchema = z.enum([
  "github",
  "registry",
  "local_workspace",
  "upload",
  "builtin",
]);
export type SkillSourceType = z.infer<typeof SkillSourceTypeSchema>;

export const SkillRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type SkillRiskLevel = z.infer<typeof SkillRiskLevelSchema>;

export const SkillPackageStatusSchema = z.enum([
  "imported",
  "reviewed",
  "rejected",
  "converted",
  "archived",
  "superseded",
]);
export type SkillPackageStatus = z.infer<typeof SkillPackageStatusSchema>;

export const NormalizedSkillResourceSchema = z
  .object({
    path: z.string().min(1),
    kind: z.string().min(1),
    description: z.string().nullish(),
    content_hash: z.string().nullish(),
    content_type: z.string().nullish(),
    byte_length: z.number().int().nonnegative().nullish(),
  })
  .passthrough();
export type NormalizedSkillResource = z.infer<
  typeof NormalizedSkillResourceSchema
>;

export const NormalizedSkillSchema = z
  .object({
    spec_kind: z.string().nullish(),
    spec_version: z.string().nullish(),
    skill_root: z.string().nullish(),
    package_hash: z.string().nullish(),
    diagnostics: z.array(z.string()).optional(),
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.string().min(1),
    license: z.string().nullable(),
    instructions_markdown: z.string(),
    resources: z.array(NormalizedSkillResourceSchema),
    requested_permissions: z.array(z.string()),
    execution_profile: JsonObjectSchema,
    vendor_extensions: JsonObjectSchema,
    trust_analysis: JsonObjectSchema,
  })
  .passthrough();
export type NormalizedSkill = z.infer<typeof NormalizedSkillSchema>;

export const SkillSourceSchema = z
  .object({
    id: IdSchema,
    source_type: SkillSourceTypeSchema,
    url: z.string().nullable(),
    repo: z.string().nullable(),
    path: z.string().nullable(),
    ref: z.string().nullable(),
    commit_sha: z.string().nullable(),
    content_hash: z.string().min(1),
    fetched_at: ISODateTimeSchema,
    metadata_json: JsonObjectSchema,
  })
  .passthrough();
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillPackageFilePreviewSchema = z
  .object({
    path: z.string().min(1),
    kind: z.string().min(1),
    content_hash: z.string().nullish(),
    content_type: z.string().nullish(),
    byte_length: z.number().int().nonnegative().nullish(),
    included: z.boolean(),
    executable: z.boolean(),
    risk_flags_json: JsonObjectSchema,
  })
  .passthrough();
export type SkillPackageFilePreview = z.infer<
  typeof SkillPackageFilePreviewSchema
>;

export const SkillPackageFileSchema = SkillPackageFilePreviewSchema.extend({
  id: IdSchema,
  skill_package_id: IdSchema,
  storage_ref: z.string().nullable(),
  created_at: ISODateTimeSchema,
}).passthrough();
export type SkillPackageFile = z.infer<typeof SkillPackageFileSchema>;

/** The operations a skill package's Review and Convert actions file. */
export const SkillPackageProposalOperationSchema = z.enum(["skill_import_approve", "install_from_skill_package"]);
export type SkillPackageProposalOperation = z.infer<typeof SkillPackageProposalOperationSchema>;

export const SkillPackageSchema = z
  .object({
    id: IdSchema,
    source_id: IdSchema,
    package_name: z.string().min(1),
    version: z.string().nullable(),
    license: z.string().nullable(),
    raw_storage_ref: z.string().nullable(),
    manifest_json: JsonObjectSchema,
    normalized_json: JsonObjectSchema,
    risk_level: SkillRiskLevelSchema,
    status: SkillPackageStatusSchema,
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    // The caller's own still-pending Review or Convert proposal for this
    // package snapshot; asking again returns it instead of filing another.
    pending_proposal: z.object({ id: IdSchema, operation: SkillPackageProposalOperationSchema }).nullable(),
    // Detail read only: `GET /skill-packages/:id` joins the owning Source and
    // the file inventory; the list read returns neither.
    source: SkillSourceSchema.optional(),
    package_files: z.array(SkillPackageFileSchema).optional(),
  })
  .passthrough();
export type SkillPackage = z.infer<typeof SkillPackageSchema>;

export const SkillLocalOverlayScopeSchema = z.enum([
  "space",
  "project",
  "project_folder",
  "agent",
  "user",
]);
export type SkillLocalOverlayScope = z.infer<typeof SkillLocalOverlayScopeSchema>;

export const SkillLocalOverlayStatusSchema = z.enum(["active", "archived"]);
export type SkillLocalOverlayStatus = z.infer<typeof SkillLocalOverlayStatusSchema>;

export const SkillLocalOverlayConfigSchema = z
  .object({
    alias: z.string().max(128).nullable().optional(),
    display_name: z.string().max(256).nullable().optional(),
    endpoint_defaults: JsonObjectSchema.default({}),
    credential_ref: z.string().max(256).nullable().optional(),
    default_scope: z.string().max(128).nullable().optional(),
    runtime_preference: z.string().max(128).nullable().optional(),
    user_preferences: JsonObjectSchema.default({}),
  })
  .strict();
export type SkillLocalOverlayConfig = z.infer<typeof SkillLocalOverlayConfigSchema>;

export const SkillLocalOverlaySchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    skill_package_id: IdSchema,
    scope_type: SkillLocalOverlayScopeSchema,
    scope_id: IdSchema.nullable(),
    overlay_json: SkillLocalOverlayConfigSchema,
    status: SkillLocalOverlayStatusSchema,
    created_by_user_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .passthrough();
export type SkillLocalOverlay = z.infer<typeof SkillLocalOverlaySchema>;

export const SkillLocalOverlayUpsertRequestSchema = z
  .object({
    scope_type: SkillLocalOverlayScopeSchema,
    scope_id: IdSchema.nullable().optional(),
    status: SkillLocalOverlayStatusSchema.default("active"),
    overlay_json: SkillLocalOverlayConfigSchema.default({}),
  })
  .strict();
export type SkillLocalOverlayUpsertRequest = z.infer<
  typeof SkillLocalOverlayUpsertRequestSchema
>;

export const SkillLibraryIndexItemSchema = z
  .object({
    skill_package: SkillPackageSchema,
    overlay: SkillLocalOverlaySchema.nullable(),
    effective_name: z.string(),
    effective_alias: z.string().nullable(),
    requested_permissions: z.array(z.string()).default([]),
  })
  .passthrough();
export type SkillLibraryIndexItem = z.infer<typeof SkillLibraryIndexItemSchema>;

export const SkillLibraryIndexResponseSchema = z
  .object({
    items: z.array(SkillLibraryIndexItemSchema),
  })
  .passthrough();
export type SkillLibraryIndexResponse = z.infer<typeof SkillLibraryIndexResponseSchema>;

export const HostSkillCandidateSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(256),
  runtime_key: z.enum(["claude_code", "codex_cli", "opencode"]),
  installation: z.string().min(1).max(128), display_path: z.string().max(2048),
}).strict();
export type HostSkillCandidate = z.infer<typeof HostSkillCandidateSchema>;
export const HostSkillScanSchema = z.object({
  items: z.array(HostSkillCandidateSchema).max(200), truncated: z.boolean(),
  warnings: z.array(z.string().max(256)).max(100),
}).strict();
export type HostSkillScan = z.infer<typeof HostSkillScanSchema>;
export const HostSkillFilesSchema = z.array(z.object({
  path: z.string().min(1).max(1024), content_base64: z.string().max(349528),
}).strict()).min(1).max(200).superRefine((files, context) => {
  if (files.reduce((size, file) => size + file.content_base64.length, 0) > Math.ceil(2 * 1024 * 1024 / 3) * 4 + 200 * 4) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Skill package exceeds the total byte limit" });
  }
});

const SkillImportSourceSchema = z.union([
  z.object({ url: z.string().min(1), source_type: z.literal("github").optional() }).strict(),
  z.object({ source_type: z.literal("upload"), files: z.array(z.object({
    path: z.string().min(1).max(1024), content_base64: z.string().max(349528),
  }).strict()).min(1).max(200) }).strict(),
  z.object({ source_type: z.literal("upload"), archive_base64: z.string().min(1).max(4194304) }).strict(),
  z.object({ source_type: z.literal("local_workspace"), host_id: IdSchema,
    skill_id: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
export const SkillImportPreviewRequestSchema = SkillImportSourceSchema;
export type SkillImportPreviewRequest = z.infer<typeof SkillImportPreviewRequestSchema>;

export const SkillImportPreviewResponseSchema = z
  .object({
    source: SkillSourceSchema.omit({
      id: true,
      fetched_at: true,
    }).partial(),
    normalized_skill: NormalizedSkillSchema,
    package_root: z.string(),
    package_hash: z.string().min(1),
    package_files: z.array(SkillPackageFilePreviewSchema),
    risk_level: SkillRiskLevelSchema,
    requested_permissions: z.array(z.string()),
    files_detected: z.array(z.string()),
    warnings: z.array(z.string()),
    persistable: z.boolean(),
  })
  .passthrough();
export type SkillImportPreviewResponse = z.infer<
  typeof SkillImportPreviewResponseSchema
>;

const previewHash = { package_hash: z.string().min(1) };
export const SkillImportRequestSchema = z.union([
  SkillImportSourceSchema.options[0].extend(previewHash),
  SkillImportSourceSchema.options[1].extend(previewHash),
  SkillImportSourceSchema.options[2].extend(previewHash),
  SkillImportSourceSchema.options[3].extend(previewHash),
]);
export type SkillImportRequest = z.infer<typeof SkillImportRequestSchema>;

export const SkillBindingRequestSchema = z.object({
  scope_type: z.enum(["space", "project", "agent", "user"]),
  scope_id: IdSchema.nullable().optional(),
  enabled: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if ((value.scope_type === "space") !== !value.scope_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Scope id must match the binding scope" });
  }
});
export type SkillBindingRequest = z.infer<typeof SkillBindingRequestSchema>;

export const SkillBindingSchema = z.object({
  id: IdSchema, space_id: IdSchema, skill_package_id: IdSchema,
  project_id: IdSchema.nullable(), agent_id: IdSchema.nullable(), user_id: IdSchema.nullable(),
  enabled: z.boolean(), proposal_id: IdSchema,
});
export type SkillBinding = z.infer<typeof SkillBindingSchema>;

export const SkillPackageContentSchema = z.object({
  skill_package_id: IdSchema, package_hash: z.string().regex(/^[a-f0-9]{64}$/),
  package_name: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1).max(1024), content_base64: z.string().max(349528),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean(),
  }).strict()).min(1).max(200),
}).strict();
export type SkillPackageContent = z.infer<typeof SkillPackageContentSchema>;

export const SkillConvertToCapabilityRequestSchema = z.object({
  capability_id: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  // Conversion produces a disabled draft. Supplying a project enablement is
  // rejected: enablement goes through proposal review (ADR 0009).
  enable_for_project_id: IdSchema.nullish(),
  create_runtime_bindings: z.boolean().default(true),
});

/**
 * Review request body. An optional enabling `binding` folds the first scope
 * binding into the review, so one approval reviews and enables the package.
 * Project scope is not offered here: a review changes the Space, so it is
 * decided at Space level, while a Project binding is its Project's to decide.
 */
export const SkillReviewProposalRequestSchema = z.object({
  binding: SkillBindingRequestSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.binding && (!value.binding.enabled || value.binding.scope_type === "project")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["binding"], message: "Review can only enable the Space, user or Agent scope" });
  }
});
export type SkillReviewProposalRequest = z.infer<typeof SkillReviewProposalRequestSchema>;

export const SkillImportApprovalProposalResponseSchema = ProposalOutSchema;
export type SkillImportApprovalProposalResponse = z.infer<
  typeof SkillImportApprovalProposalResponseSchema
>;

export const SkillConvertToCapabilityResponseSchema = ProposalOutSchema;
export type SkillConvertToCapabilityResponse = z.infer<
  typeof SkillConvertToCapabilityResponseSchema
>;
