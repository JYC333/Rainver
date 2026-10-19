import type { Queryable } from "../routeUtils/common.js";

/** Who decides a Memory proposal by identity, when anyone does. */
export type MemoryProposalDecider = { required: true; userId: string | null } | { required: false };

interface MemoryProposalShape {
  space_id: string;
  proposal_type: string;
  payload_json: Record<string, unknown> | null;
  created_by_agent_id?: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The person who alone decides an Agent-scope Memory proposal: the owner of
 * the Agent it is about (ADR 0003 §5). Role never substitutes, so a Space
 * owner or admin cannot change what someone else's Agent has become.
 *
 * Derived from what the canonical applier will actually write, never from a
 * payload claim about scope: a proposal that revises or archives a Memory is
 * about the stored row's scope and Agent; a proposal that creates one is
 * about the scope and Agent the applier reads from the same fields
 * (`applyCreate`). An Agent nobody owns has no persona anyone may decide.
 */
export async function memoryProposalDecider(
  db: Queryable,
  proposal: MemoryProposalShape,
): Promise<MemoryProposalDecider> {
  if (!proposal.proposal_type.startsWith("memory_")) return { required: false };
  const payload = proposal.payload_json ?? {};
  const targetMemoryId = text(payload.target_memory_id);
  let agentId: string | null;
  if (targetMemoryId) {
    const target = await db.query<{ scope_type: string; agent_id: string | null }>(
      `SELECT scope_type, agent_id FROM memory_entries WHERE space_id = $1 AND id = $2 LIMIT 1`,
      [proposal.space_id, targetMemoryId],
    );
    const row = target.rows[0];
    if (!row || row.scope_type !== "agent") return { required: false };
    agentId = row.agent_id;
  } else {
    const scope = text(payload.target_scope) ?? text(payload.scope_type) ?? "user";
    if (scope !== "agent") return { required: false };
    agentId = text(payload.agent_id) ?? proposal.created_by_agent_id ?? null;
  }
  if (!agentId) return { required: true, userId: null };
  const owner = await db.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id FROM agents WHERE space_id = $1 AND id = $2 LIMIT 1`,
    [proposal.space_id, agentId],
  );
  return { required: true, userId: owner.rows[0]?.owner_user_id ?? null };
}
