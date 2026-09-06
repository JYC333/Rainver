import type { Pool } from "../../db/pool.js";
import { AGENT_SCOPE_MEMORY_TYPES, PERSONA_MEMORY_TYPE } from "./memoryApplyRepository.js";

/**
 * What the policy layer needs to know about a memory write that it cannot read
 * off the action alone.
 *
 * `memory.write` is in `ORIGIN_GATED_PROJECT_WRITES`, so an unattended Run's
 * memory write is `require_approval` — which is right for everything except
 * the one write [ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md)
 * §5 inverts, and which [ADR 0017](../../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md)
 * §1–§2 name as their single exception: an Agent's persona. Its origin test
 * runs the other way round because a persona is delivered in every Room the
 * Agent sits in, so a person in a turn must not carry that reach, while an
 * Agent concluding something about itself outside anyone's turn is bounded by
 * the notification and the one-step restore.
 *
 * Resolved **here**, from the tool input for a create and from the target row
 * for a revision — never from anything a prompt asserted about itself, and
 * never by widening the exemption to `memory.write` as a whole, which would
 * relax the origin boundary for every other memory write with it.
 */
export async function memoryPolicyContext(
  db: Pool,
  actionId: string,
  spaceId: string,
  agentId: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  if (actionId !== "memory.remember" && actionId !== "memory.revise") return {};
  const memoryType = await resolveMemoryType(db, actionId, spaceId, agentId, input);
  if (!memoryType) return {};
  return {
    // The registry action is the coarser `memory.write`; retain the concrete
    // system action so the persona exception cannot be activated for another
    // caller that happens to copy the boolean below.
    memory_action_id: actionId,
    memory_type: memoryType,
    // Audit only: no rule keys on it. It is in the recorded decision so a
    // person reading why a memory write was allowed can see which scope it
    // landed in without joining back to the row.
    memory_scope: AGENT_SCOPE_MEMORY_TYPES.has(memoryType) ? "agent" : "user",
    // The one key the exemption turns on (ADR 0017's Consequences bullet):
    // `ruleUnattendedProjectWrite` reads this and nothing wider.
    memory_persona_write: memoryType === PERSONA_MEMORY_TYPE,
  };
}

async function resolveMemoryType(
  db: Pool,
  actionId: string,
  spaceId: string,
  agentId: string,
  input: unknown,
): Promise<string | null> {
  const command = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (actionId === "memory.remember") {
    return typeof command.memory_type === "string" ? command.memory_type : "semantic";
  }
  const memoryId = typeof command.memory_id === "string" ? command.memory_id : null;
  if (!memoryId) return null;
  // The row's own type, and only for an entry this Agent owns: a revision
  // names an id, and an id is the one thing a prompt can invent. An entry that
  // is not this Agent's is not a persona write whatever it says.
  const row = await db.query<{ memory_type: string }>(
    `SELECT memory_type FROM memory_entries
      WHERE id = $1 AND space_id = $2 AND scope_type = 'agent' AND agent_id = $3
        AND status = 'active' AND deleted_at IS NULL`,
    [memoryId, spaceId, agentId],
  );
  return row.rows[0]?.memory_type ?? null;
}
