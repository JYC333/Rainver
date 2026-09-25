import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";

/**
 * The event table is deliberately JSONB, but callers must not turn it into a
 * free-form logging sink. Only these small, non-secret facts are accepted.
 */
export const AUTH_EVENT_DETAIL_KEYS = [
  "action",
  "degraded_dependency",
  "email_domain",
  "invitation_id",
  "provider",
  "reason_code",
  "registration_source",
  "retry_after_seconds",
  "route",
  "session_count",
  "subject_state",
] as const;

type AuthEventDetailKey = (typeof AUTH_EVENT_DETAIL_KEYS)[number];
type AuthEventDetailValue = string | number | boolean;

const allowedKeys = new Set<string>(AUTH_EVENT_DETAIL_KEYS);

/** Strip unknown keys, structured values, and oversized values before JSONB persistence. */
export function sanitizeAuthEventDetails(
  input: Record<string, unknown> | null | undefined,
): Partial<Record<AuthEventDetailKey, AuthEventDetailValue>> {
  const output: Partial<Record<AuthEventDetailKey, AuthEventDetailValue>> = {};
  if (!input) return output;
  for (const [key, value] of Object.entries(input)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === "string") {
      if (value.length <= 256) output[key as AuthEventDetailKey] = value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) output[key as AuthEventDetailKey] = value;
    } else if (typeof value === "boolean") {
      output[key as AuthEventDetailKey] = value;
    }
  }
  return output;
}

export async function recordAuthSecurityEvent(
  pool: Pool,
  input: {
    eventType: string;
    outcome: "success" | "failure" | "throttled" | "degraded";
    actorUserId?: string | null;
    subjectUserId?: string | null;
    requestId?: string | null;
    sourceIp?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO auth_security_events
       (id, actor_user_id, subject_user_id, event_type, outcome, request_id, source_ip, details_json, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
    [
      randomUUID(),
      input.actorUserId ?? null,
      input.subjectUserId ?? null,
      input.eventType.slice(0, 64),
      input.outcome,
      input.requestId?.slice(0, 128) ?? null,
      input.sourceIp?.slice(0, 128) ?? null,
      JSON.stringify(sanitizeAuthEventDetails(input.details)),
    ],
  );
}
