/**
 * Zod schemas — the single source of truth for the protocol's data shapes.
 *
 * Every DTO type in `dto.ts` is derived from a schema here via `z.infer`, so the
 * runtime validator and the compile-time type can never drift apart. Fields are
 * a conservative subset of the public API DTOs: the stable identity, scoping,
 * status, and timestamp fields a TypeScript consumer needs. Names mirror the API JSON
 * shape (snake_case).
 *
 * Depends only on `./common` and `zod`.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, RunTriggerOriginSchema, SpaceOversightModeSchema } from "./common.js";

// ---------------------------------------------------------------------------
// Lightweight references (id + the minimum a UI needs to label the entity)
// ---------------------------------------------------------------------------

export const SpaceRefSchema = z.object({
  id: IdSchema,
  name: z.string(),
  type: z.string(), // personal | family | team (see SPACE_TYPE_VALUES)
  // Older consumers may omit the field; server-produced Space DTOs always
  // include the persisted mode and parsing normalizes legacy payloads to the
  // fail-closed default.
  oversight_mode: SpaceOversightModeSchema.default("none"),
  egress_notifications_enabled: z.boolean(),
});

export const UserRefSchema = z.object({
  id: IdSchema,
  display_name: z.string(),
  email: z.string().nullish(),
});

export const AgentRefSchema = z.object({
  id: IdSchema,
  name: z.string(),
});

export const ProjectFolderRefSchema = z.object({
  id: IdSchema,
  name: z.string(),
});

export const ProjectRefSchema = z.object({
  id: IdSchema,
  name: z.string(),
});

// ---------------------------------------------------------------------------
// Domain DTOs (conservative subsets of the public API models)
// ---------------------------------------------------------------------------

/** Public activity record DTO — the raw-input front door (B9/B12). */
export const ActivityDTOSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  activity_type: z.string(),
  title: z.string().nullish(),
  content: z.string().nullish(),
  source_url: z.string().nullish(),
  user_id: IdSchema.nullish(),
  agent_id: IdSchema.nullish(),
  project_folder_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  status: z.string().nullish(),
  source_kind: z.string().nullish(),
  visibility: z.string(),
  occurred_at: ISODateTimeSchema,
  created_at: ISODateTimeSchema,
});

/** Public proposal DTO — governance review object (B10/B20). */
export const ProposalDTOSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  user_id: IdSchema,
  proposal_type: z.string(),
  status: z.string(),
  risk_level: z.string(),
  visibility: z.string(),
  proposed_title: z.string(),
  proposed_content: z.string(),
  rationale: z.string(),
  project_folder_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  source_activity_id: IdSchema.nullish(),
  resulting_memory_id: IdSchema.nullish(),
  expired: z.boolean(),
  created_at: ISODateTimeSchema,
  decided_at: ISODateTimeSchema.nullish(),
});

/** Public run DTO — the execution spine record. */
export const RunDTOSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  agent_id: IdSchema,
  agent_version_id: IdSchema,
  run_role: z.enum(["execution", "coordinator"]),
  requested_runtime_profile_id: IdSchema.nullish(),
  selected_runtime_profile_id: IdSchema.nullish(),
  runtime_profile_selection_source: z.enum(["explicit", "default"]).nullish(),
  active_route_decision_id: IdSchema.nullish(),
  status: z.string(),
  run_type: z.string(),
  trigger_origin: RunTriggerOriginSchema,
  mode: z.string(),
  project_folder_id: IdSchema.nullish(),
  session_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  parent_run_id: IdSchema.nullish(),
  root_run_id: IdSchema.nullish(),
  run_group_id: IdSchema.nullish(),
  delegation_id: IdSchema.nullish(),
  instructed_by_user_id: IdSchema.nullish(),
  instructed_by_agent_id: IdSchema.nullish(),
  prompt: z.string().nullish(),
  selected_adapter_type: z.string().nullish(),
  capability_id: IdSchema.nullish(),
  capabilities_json: z.array(z.string().min(1)).default([]),
  selected_model_provider_id: IdSchema.nullish(),
  required_sandbox_level: z.string(),
  visibility: z.string(),
  created_at: ISODateTimeSchema,
  started_at: ISODateTimeSchema.nullish(),
  ended_at: ISODateTimeSchema.nullish(),
});

/** Public run event DTO — append-only run evidence record. */
export const RunEventDTOSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  run_id: IdSchema,
  event_index: z.number().int(),
  event_type: z.string(),
  status: z.string(),
  step_id: IdSchema.nullish(),
  actor_id: IdSchema.nullish(),
  summary: z.string().nullish(),
  error_code: z.string().nullish(),
  error_message: z.string().nullish(),
  artifact_id: IdSchema.nullish(),
  proposal_id: IdSchema.nullish(),
  created_at: ISODateTimeSchema,
});

/** Public artifact DTO — persisted run/proposal output. */
export const ArtifactDTOSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  artifact_type: z.string(),
  title: z.string(),
  run_id: IdSchema.nullish(),
  proposal_id: IdSchema.nullish(),
  mime_type: z.string().nullish(),
  exportable: z.boolean(),
  preview: z.boolean(),
  visibility: z.string(),
  project_id: IdSchema.nullish(),
  project_folder_id: IdSchema.nullish(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});

/** Public memory DTO — scoped long-term memory entry. */
export const MemoryDTOSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  scope: z.enum(["user", "project"]),
  type: z.string(),
  status: z.string(),
  visibility: z.string(),
  sensitivity_level: z.string(),
  title: z.string().nullish(),
  content: z.string().nullish(),
  project_id: IdSchema.nullish(),
  subject_user_id: IdSchema.nullish(),
  owner_user_id: IdSchema.nullish(),
  confidence: z.number(),
  importance: z.number(),
  version: z.number().int(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});

/** Public knowledge item DTO — curated knowledge item. */
export const KnowledgeItemDTOSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  knowledge_kind: z.string(),
  title: z.string(),
  content: z.string(),
  status: z.string(),
  visibility: z.string(),
  slug: z.string().nullish(),
  project_folder_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  source_url: z.string().nullish(),
  version: z.number().int(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
