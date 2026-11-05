/**
 * Identity introspection contract for server modules.
 *
 * Contract for `GET /api/v1/auth/introspect`. The server owns
 * session-cookie identity, Google OAuth, and the current feature-gated API-key
 * routes; DB-persisted API-key storage is disabled. There is no `api_keys`
 * table. The response carries identifiers only — never token,
 * session, or key material.
 */

import { z } from "zod";
import { IdSchema, SecretResponseGuards } from "./common.js";

export const IdentityIntrospectionResponseSchema = z
  .object({
    space_id: IdSchema,
    user_id: IdSchema,
    // Session/token material must never ride along on this port.
    session_id: z.never().optional(),
    token: z.never().optional(),
    ...SecretResponseGuards,
  })
  .passthrough();

/** Instance invitations admit an account; they grant no shared-Space or admin role. */
export const InstanceInvitationCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(256),
}).strict();
export const InstanceInvitationResponseSchema = z.object({
  id: IdSchema,
  invited_email: z.string().email(),
  token: z.string().min(1),
  expires_at: z.string().datetime(),
}).strict();
export type InstanceInvitationResponse = z.infer<typeof InstanceInvitationResponseSchema>;
