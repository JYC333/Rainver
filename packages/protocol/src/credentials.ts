/**
 * CLI credential-channel contracts.
 *
 * These schemas mirror the public `/api/v1/credentials/cli/*` API. CLI login
 * state is the second credential channel under ADR 0008: it is
 * a distinct class from ModelProvider API-key credentials and is never pooled
 * or rotated. Profile paths are storage locations, not secret material; the
 * login files themselves never appear in any response. Contracts only: no
 * broker, no filesystem access, no authority.
 */

import { z } from "zod";
import { IdSchema, SecretResponseGuards } from "./common.js";

export const CLI_LOGIN_METHOD_VALUES = ["cli"] as const;
export type CliLoginMethodValue = (typeof CLI_LOGIN_METHOD_VALUES)[number];
export function isCliLoginMethod(value: string): value is CliLoginMethodValue {
  return (CLI_LOGIN_METHOD_VALUES as readonly string[]).includes(value);
}

/** Credential profile response DTO; response-only and secret-free. */
export const CliCredentialProfileDTOSchema = z
  .object({
    id: IdSchema,
    owner_user_id: IdSchema.nullish(),
    runtime: z.string(),
    name: z.string(),
    source_path: z.string(),
    target_path: z.string(),
    readonly: z.boolean(),
    notes: z.string(),
    network_profile_id: IdSchema.nullish(),
    source_exists: z.boolean(),
    logged_in: z.boolean(),
    file_count: z.number().int(),
    manageable: z.boolean().optional(),
    grant_id: IdSchema.nullish().optional(),
    grant_enabled: z.boolean().optional(),
    is_default: z.boolean().optional(),
    ...SecretResponseGuards,
  })
  .passthrough();

export const CliCredentialAvailableProfileDTOSchema = z
  .object({
    id: IdSchema,
    owner_user_id: IdSchema.nullish(),
    runtime: z.string(),
    name: z.string(),
    target_path: z.string(),
    readonly: z.boolean(),
    notes: z.string(),
    network_profile_id: IdSchema.nullish(),
    source_exists: z.boolean(),
    logged_in: z.boolean(),
    file_count: z.number().int(),
    manageable: z.boolean(),
    grant_id: IdSchema,
    is_default: z.boolean(),
    ...SecretResponseGuards,
  })
  .passthrough();

export const CliCredentialProfileCreateRequestSchema = z.object({
  runtime: z.string().min(1),
  name: z.string().min(1),
  readonly: z.boolean().optional(),
  notes: z.string().optional(),
  network_profile_id: IdSchema.nullish(),
  is_default: z.boolean().optional(),
});

export const CliCredentialSpaceGrantRequestSchema = z.object({
  space_id: IdSchema,
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
  network_profile_id: IdSchema.nullish(),
});

export const CliCredentialSpaceGrantDTOSchema = z
  .object({
    id: IdSchema,
    profile_id: IdSchema,
    space_id: IdSchema,
    owner_user_id: IdSchema,
    granted_by_user_id: IdSchema.nullish(),
    enabled: z.boolean(),
    is_default: z.boolean(),
    network_profile_id: IdSchema.nullish(),
    created_at: z.string(),
    updated_at: z.string(),
    ...SecretResponseGuards,
  })
  .passthrough();

/** Mirror of `POST /credentials/cli/profiles/{id}/detect`. */
export const CliCredentialProfileDetectResponseSchema = z
  .object({
    profile_id: z.string(),
    source_path: z.string(),
    exists: z.boolean(),
    non_empty: z.boolean(),
    logged_in: z.boolean(),
    file_count: z.number().int(),
    target_path: z.string(),
    readonly: z.boolean(),
    network_profile_id: IdSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();

/** Mirror of one `GET /credentials/cli/methods` entry (`list_login_methods`). */
export const CliLoginMethodDTOSchema = z
  .object({
    runtime: z.string(),
    method: z.string(),
    label: z.string(),
    hint_cli: z.string(),
    supports_cli: z.boolean(),
    ...SecretResponseGuards,
  })
  .passthrough();

/** Mirror of one `GET /credentials/cli/status` entry. */
export const CliCredentialStatusDTOSchema = z
  .object({
    runtime: z.string(),
    label: z.string(),
    method: z.string(),
    profile_id: z.string().nullish(),
    network_profile_id: IdSchema.nullish(),
    logged_in: z.boolean(),
    file_count: z.number().int(),
    ...SecretResponseGuards,
  })
  .passthrough();

/**
 * Documented event types on the `GET /credentials/cli/login/stream` SSE
 * stream. The event schema keeps `type` permissive so a server-added event
 * type is never rejected.
 */
export const CLI_LOGIN_EVENT_TYPE_VALUES = [
  "output",
  "error",
  "warning",
  "hint",
  "profile",
  "needs_input",
  "device_auth",
  "synced",
  "done",
] as const;
export type CliLoginEventTypeValue = (typeof CLI_LOGIN_EVENT_TYPE_VALUES)[number];
export function isCliLoginEventType(value: string): value is CliLoginEventTypeValue {
  return (CLI_LOGIN_EVENT_TYPE_VALUES as readonly string[]).includes(value);
}

/** One SSE `data:` payload on the CLI login stream. */
export const CliLoginStreamEventSchema = z
  .object({
    type: z.string().min(1),
    text: z.string().optional(),
    prompt: z.string().optional(),
    url: z.string().optional(),
    code: z.string().optional(),
    expires_in_minutes: z.number().int().optional(),
    profile_id: z.string().optional(),
    exit_code: z.number().int().optional(),
    ...SecretResponseGuards,
  })
  .passthrough();

/** Request body for `POST /credentials/cli/login/input`. */
export const CliLoginInputRequestSchema = z.object({
  input: z.string(),
  profile_id: IdSchema.optional(),
});

export const CliLoginInputResponseSchema = z
  .object({ status: z.literal("sent"), ...SecretResponseGuards })
  .passthrough();

export const CliUsageAutoRefreshSettingsSchema = z
  .object({
    enabled: z.boolean(),
    interval_ms: z.number().int().positive(),
    updated_at: z.string().nullable(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type CliUsageAutoRefreshSettings = z.infer<
  typeof CliUsageAutoRefreshSettingsSchema
>;

export const CliUsageAutoRefreshUpdateRequestSchema = z.object({
  enabled: z.boolean(),
});
