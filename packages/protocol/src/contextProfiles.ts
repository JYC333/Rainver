/**
 * Context profile and routing-manifest contracts.
 *
 * These schemas describe DB-authoritative context configuration.
 * Runtime vendor files remain generated adapter artifacts.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

export const ContextProfileScopeSchema = z.enum([
  "space",
  "project",
  "project_folder",
  "agent",
  "user",
]);
export type ContextProfileScope = z.infer<typeof ContextProfileScopeSchema>;

export const ContextProfileStatusSchema = z.enum(["active", "archived"]);
export type ContextProfileStatus = z.infer<typeof ContextProfileStatusSchema>;

export const ContextRoutingRuleSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    path_glob: z.string().min(1).max(512),
    module_id: z.string().min(1).max(128).optional(),
    agent_doc_paths: z.array(z.string().min(1).max(512)).default([]),
    context_bundle_id: z.string().min(1).max(128).optional(),
    priority: z.number().int().min(0).max(10_000).default(100),
  })
  .strict();
export type ContextRoutingRule = z.infer<typeof ContextRoutingRuleSchema>;

export const ContextRoutingManifestSchema = z
  .object({
    version: z.number().int().positive().default(1),
    rules: z.array(ContextRoutingRuleSchema).default([]),
    default_agent_doc_paths: z.array(z.string().min(1).max(512)).default([]),
  })
  .strict();
export type ContextRoutingManifest = z.infer<typeof ContextRoutingManifestSchema>;

export const ContextPackSchema = z
  .object({
    title: z.string().max(256).optional(),
    startup_protocol: z.string().max(20_000).optional(),
    skill_index_enabled: z.boolean().default(true),
    observation_policy: z.enum(["disabled", "manual", "scheduled"]).default("manual"),
    notes: z.string().max(20_000).optional(),
  })
  .passthrough();
export type ContextPack = z.infer<typeof ContextPackSchema>;

export const ContextProfileSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    scope_type: ContextProfileScopeSchema,
    scope_id: IdSchema.nullable(),
    status: ContextProfileStatusSchema,
    version: z.number().int().positive(),
    context_pack_json: ContextPackSchema,
    routing_manifest_json: ContextRoutingManifestSchema,
    created_by_user_id: IdSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type ContextProfile = z.infer<typeof ContextProfileSchema>;

export const ContextProfileListResponseSchema = z
  .object({
    items: z.array(ContextProfileSchema),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextProfileListResponse = z.infer<typeof ContextProfileListResponseSchema>;

export const ContextProfileUpsertRequestSchema = z
  .object({
    scope_type: ContextProfileScopeSchema,
    scope_id: IdSchema.nullable().optional(),
    status: ContextProfileStatusSchema.default("active"),
    version: z.number().int().positive().default(1),
    context_pack_json: ContextPackSchema.default({}),
    routing_manifest_json: ContextRoutingManifestSchema.default({}),
  })
  .strict();
export type ContextProfileUpsertRequest = z.infer<typeof ContextProfileUpsertRequestSchema>;

export const ContextRoutingUpdateRequestSchema = z
  .object({
    context_pack_json: ContextPackSchema.default({}),
    routing_manifest_json: ContextRoutingManifestSchema,
  })
  .strict();
export type ContextRoutingUpdateRequest = z.infer<typeof ContextRoutingUpdateRequestSchema>;

export const ContextEffectiveRoutingResponseSchema = z
  .object({
    project_folder_id: IdSchema,
    profiles: z.array(ContextProfileSchema),
    effective_manifest: ContextRoutingManifestSchema,
    selected_agent_doc_paths: z.array(z.string()),
    ...SecretResponseGuards,
  })
  .strict();
export type ContextEffectiveRoutingResponse = z.infer<
  typeof ContextEffectiveRoutingResponseSchema
>;
