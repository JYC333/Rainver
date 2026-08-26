import { createHash } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

/**
 * Shared idempotency helpers for multi-step Project operations (source setup,
 * history-import backfill) whose write span covers more than one durable
 * insert and must be safely retried with the same client-supplied
 * idempotency_key.
 */

export async function advisoryLock(db: Queryable, spaceId: string, kind: string, key: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${spaceId}:${kind}:${key}`]);
}

export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "idempotency_key")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export async function findIdempotentOperation(
  db: Queryable,
  spaceId: string,
  projectId: string,
  kind: string,
  key: string,
): Promise<{ id: string; fingerprint: string } | null> {
  const result = await db.query<{ id: string; fingerprint: string }>(
    `SELECT id, progress_json->'idempotency'->>'fingerprint' AS fingerprint
       FROM project_operations
      WHERE space_id=$1 AND project_id=$2 AND kind=$3 AND progress_json->'idempotency'->>'key'=$4
      ORDER BY created_at LIMIT 1 FOR UPDATE`,
    [spaceId, projectId, kind, key],
  );
  return result.rows[0] ?? null;
}
