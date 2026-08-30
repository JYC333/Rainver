import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

/** The provider/model summary returned with an Agent runtime profile. */
export const AgentRuntimeProfileModelSchema = z.object({
  provider_id: IdSchema.nullable(),
  provider_name: z.string().nullable(),
  provider_type: z.string().nullable(),
  model: z.string().nullable(),
}).strict();
export type AgentRuntimeProfileModel = z.infer<typeof AgentRuntimeProfileModelSchema>;

/** Wire response for an Agent runtime profile, including optional host binding. */
export const AgentRuntimeProfileOutSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  agent_id: IdSchema,
  name: z.string().trim().min(1),
  adapter_type: z.string().trim().min(1),
  execution_host_id: IdSchema.nullable(),
  workspace_location_id: IdSchema.nullable(),
  workspace_mode: z.enum(["location", "managed"]).nullable(),
  runtime_installation: z.string().trim().min(1).max(64).nullable(),
  model: AgentRuntimeProfileModelSchema.nullable(),
  runtime_config_json: z.record(z.unknown()),
  runtime_policy_json: z.record(z.unknown()),
  enabled: z.boolean(),
  is_default: z.boolean(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type AgentRuntimeProfileOut = z.infer<typeof AgentRuntimeProfileOutSchema>;

/** POST body for creating an Agent runtime profile. */
export const AgentRuntimeProfileCreateBodySchema = z.object({
  name: z.string().trim().min(1),
  adapter_type: z.string().trim().min(1),
  execution_host_id: IdSchema.nullish(),
  workspace_location_id: IdSchema.nullish(),
  workspace_mode: z.enum(["location", "managed"]).nullish(),
  runtime_installation: z.string().trim().min(1).max(64).nullish(),
  model_provider_id: IdSchema.nullish(),
  model_name: z.string().trim().min(1).nullish(),
  runtime_config_json: z.record(z.unknown()).nullish(),
  runtime_policy_json: z.record(z.unknown()).nullish(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
}).strict();
export type AgentRuntimeProfileCreateBody = z.infer<typeof AgentRuntimeProfileCreateBodySchema>;

/** PATCH body for updating an Agent runtime profile. */
export const AgentRuntimeProfileUpdateBodySchema = AgentRuntimeProfileCreateBodySchema.partial();
export type AgentRuntimeProfileUpdateBody = z.infer<typeof AgentRuntimeProfileUpdateBodySchema>;
