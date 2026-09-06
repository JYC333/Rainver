import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

/**
 * A private Inbox pointer for an autonomous persona change made without a
 * Project feed. It carries identifiers and navigation only; the persona text
 * remains on the owner-gated Memory surface (B24A).
 */
export async function recordAgentPersonaRevisionPointer(
  db: Queryable,
  input: {
    spaceId: string;
    ownerUserId: string;
    agentId: string;
    memoryId: string;
    runId: string;
    revision: boolean;
    occurredAt: string;
  },
): Promise<void> {
  const aggregateKey = `agent_persona:${input.memoryId}`.slice(0, 128);
  await db.query(
    `INSERT INTO activity_records (
       id, space_id, source_run_id, user_id, agent_id, activity_type,
       title, content, payload_json, occurred_at, created_at, status, updated_at,
       source_kind, source_trust, visibility, owner_user_id, aggregate_key
     ) VALUES (
       $1, $2, $3, $4, $5, 'system_event',
       $6, $7, $8::jsonb, $9::timestamptz, $9::timestamptz, 'raw', $9::timestamptz,
       'system_event', 'internal_system', 'private', $4, $10
     )
     ON CONFLICT (space_id, aggregate_key) WHERE aggregate_key IS NOT NULL DO NOTHING`,
    [
      randomUUID(),
      input.spaceId,
      input.runId,
      input.ownerUserId,
      input.agentId,
      input.revision ? "Your Agent changed what it has become" : "Your Agent formed its persona",
      input.revision
        ? "Review the change in Agent memory. You can restore the previous version there."
        : "Review the new persona in Agent memory. You can archive it there.",
      JSON.stringify({
        pointer_type: "agent_persona_revision",
        memory_id: input.memoryId,
        agent_id: input.agentId,
        revision: input.revision,
      }),
      input.occurredAt,
      aggregateKey,
    ],
  );
}
