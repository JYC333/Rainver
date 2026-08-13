/**
 * Identity introspection contract for server modules.
 *
 * Contract for `GET /api/v1/auth/introspect`. The server owns
 * session-cookie identity, Google OAuth, and the current feature-gated API-key
 * routes; DB-persisted API-key storage is still deferred until the canonical
 * schema grows that table. The response carries identifiers only — never token,
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
