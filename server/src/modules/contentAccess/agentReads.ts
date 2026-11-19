import { randomUUID } from "node:crypto";
import type { AgentDataRead } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";

/** Bounded identifiers only; the log never stores content. */
export const AGENT_READ_MAX_IDS = 100;

/**
 * Same-owner Agent read attribution (ADR 0030). B11's `content_access_logs`
 * keeps recording only cross-person reads; this separate log records reads an
 * Agent Run made on its instructing person's behalf, keyed to that owner, so
 * the owner can see which Runs read which entries and revoke the consent that
 * allowed it. Callers must write it inside the transaction that releases the
 * read result (a failure withholds the result).
 */
export async function recordAgentDataRead(db: Queryable, entry: {
  spaceId: string;
  ownerUserId: string;
  runId: string;
  agentId: string | null;
  actionId: string;
  resourceType: string;
  resourceIds: readonly string[];
  dataClass: "non_sensitive" | "personal" | "sensitive";
  grantId: string | null;
}): Promise<void> {
  const ids = [...new Set(entry.resourceIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128))].sort().slice(0, AGENT_READ_MAX_IDS);
  await db.query(
    `INSERT INTO agent_data_read_logs (id, space_id, owner_user_id, run_id, agent_id, action_id, resource_type, resource_ids_json, data_class, grant_id, accessed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,now())`,
    [randomUUID(), entry.spaceId, entry.ownerUserId, entry.runId, entry.agentId, entry.actionId, entry.resourceType, JSON.stringify(ids), entry.dataClass, entry.grantId],
  );
}

/** Ids of returned rows: `id` of the object itself and of `items[]`, nothing nested and never values. */
export function resultResourceIds(output: unknown): string[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const value = output as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof value.id === "string") ids.push(value.id);
  if (Array.isArray(value.items)) for (const item of value.items) if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") ids.push((item as { id: string }).id);
  return ids;
}

export async function listAgentDataReads(db: Queryable, input: { spaceId: string; ownerUserId: string; runId?: string; limit: number }): Promise<{ items: AgentDataRead[]; has_more: boolean }> {
  const rows = (await db.query<{ id: string; run_id: string; agent_id: string | null; action_id: string; resource_type: string; resource_ids_json: unknown; data_class: AgentDataRead["data_class"]; grant_id: string | null; accessed_at: Date | string }>(
    `SELECT id, run_id, agent_id, action_id, resource_type, resource_ids_json, data_class, grant_id, accessed_at
       FROM agent_data_read_logs
      WHERE space_id=$1 AND owner_user_id=$2 AND ($3::varchar IS NULL OR run_id=$3)
      ORDER BY accessed_at DESC, id DESC LIMIT $4`,
    [input.spaceId, input.ownerUserId, input.runId ?? null, input.limit + 1],
  )).rows;
  return {
    items: rows.slice(0, input.limit).map((row) => ({
      id: row.id, run_id: row.run_id, agent_id: row.agent_id, action_id: row.action_id, resource_type: row.resource_type,
      resource_ids: Array.isArray(row.resource_ids_json) ? row.resource_ids_json.map(String) : [],
      data_class: row.data_class, grant_id: row.grant_id, accessed_at: new Date(row.accessed_at).toISOString(),
    })),
    has_more: rows.length > input.limit,
  };
}
