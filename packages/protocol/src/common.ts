/**
 * Shared protocol primitives.
 *
 * These are the lowest-level building blocks reused by DTOs, commands and
 * events. They intentionally mirror how the public API serialises values:
 *
 * - **Field naming is snake_case**, matching the JSON the backend emits
 *   (e.g. `space_id`, `created_at`). The protocol package is the wire contract
 *   for the *existing* API, not a re-modelled product surface, so it must parse
 *   real server payloads without a translation layer.
 * - **Coded string fields stay permissive** (`z.string()`), not strict enums, so
 *   the protocol never rejects a status/type/visibility value the server adds
 *   later. Known value sets are exported as `const` arrays + helper guards for
 *   consumers that want them, without constraining the schemas.
 *
 * This module depends only on `zod`. It must never import frontend, backend,
 * database, or runtime code.
 */

import { z } from "zod";

export const RUN_TRIGGER_ORIGIN_VALUES = [
  "manual",
  "automation",
  "autonomous",
  "job",
  "system",
  "delegation",
  // Read-side compatibility values emitted by older/API-derived records.
  "user",
  "api",
  "workflow",
] as const;
export const RunTriggerOriginSchema = z.enum(RUN_TRIGGER_ORIGIN_VALUES);
export type RunTriggerOrigin = z.infer<typeof RunTriggerOriginSchema>;

/** An opaque, server-generated identifier (UUID string in practice). */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/**
 * ISO-8601 datetime string as emitted by the API
 * (e.g. `"2026-06-09T12:00:00.123456+00:00"`). Kept as a permissive string so a
 * valid server timestamp is never rejected; treat it as an instant, not a
 * structurally-validated value.
 */
export const ISODateTimeSchema = z.string();
export type ISODateTime = z.infer<typeof ISODateTimeSchema>;

/**
 * Documented visibility values (see `docs/README.md` / `docs/SPACE_MODEL.md`).
 * Exported for consumers; DTO `visibility` fields stay permissive strings.
 */
export const VISIBILITY_VALUES = [
  "private",
  "space_shared",
  "selected_users",
] as const;
export const CONTENT_ACCESS_LEVEL_VALUES = ["full", "summary"] as const;
export type ContentAccessLevelValue = (typeof CONTENT_ACCESS_LEVEL_VALUES)[number];
export const ContentAccessLevelSchema = z.enum(CONTENT_ACCESS_LEVEL_VALUES);
export type VisibilityValue = (typeof VISIBILITY_VALUES)[number];
export const VisibilitySchema = z.enum(VISIBILITY_VALUES);
export function isVisibility(value: string): value is VisibilityValue {
  return (VISIBILITY_VALUES as readonly string[]).includes(value);
}

/** Documented space-type values (see `docs/SPACE_MODEL.md`). */
export const SPACE_TYPE_VALUES = ["personal", "household", "team"] as const;
export type SpaceTypeValue = (typeof SPACE_TYPE_VALUES)[number];
export function isSpaceType(value: string): value is SpaceTypeValue {
  return (SPACE_TYPE_VALUES as readonly string[]).includes(value);
}

/**
 * Space oversight mode values, strictly increasing read-visibility capability
 * for space owner/admin over other members' otherwise-private content within
 * the same Space. Chosen at Space creation; immutable afterwards. Personal
 * Spaces are forced to `none`. See `.agent/architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`.
 */
export const SPACE_OVERSIGHT_MODE_VALUES = ["none", "summary", "content", "full"] as const;
export type SpaceOversightModeValue = (typeof SPACE_OVERSIGHT_MODE_VALUES)[number];
/** Public protocol name for the immutable Space creation-time mode. */
export type SpaceOversightMode = SpaceOversightModeValue;
export const SpaceOversightModeSchema = z.enum(SPACE_OVERSIGHT_MODE_VALUES);
export function isSpaceOversightMode(value: unknown): value is SpaceOversightModeValue {
  return typeof value === "string" && (SPACE_OVERSIGHT_MODE_VALUES as readonly string[]).includes(value);
}

/**
 * Field names that carry raw secret material in request-only payloads. No
 * response contract may contain them (ADR 0008 response boundary).
 */
export const SECRET_RESPONSE_FIELDS = [
  "api_key",
  "secret_ref",
  "encrypted_key",
  "credential_secret_ref",
] as const;

/** Spread into response object schemas to reject any secret-bearing payload. */
export const SecretResponseGuards = {
  api_key: z.never().optional(),
  secret_ref: z.never().optional(),
  encrypted_key: z.never().optional(),
  credential_secret_ref: z.never().optional(),
};

/** Protocol semantic version. Bump when the contract changes incompatibly. */
export const PROTOCOL_VERSION = "0.0.0" as const;
