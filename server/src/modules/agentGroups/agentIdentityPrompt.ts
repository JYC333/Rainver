import type { Queryable } from "../routeUtils/common.js";
import { listAgentMemoryForDispatch } from "../memory/agentMemoryDelivery.js";

/**
 * What an Agent is told about itself before it is told what to do.
 *
 * Three things, with three different authors and three different reaches
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §4):
 *
 * - **Role** — `agents.role_instruction`, the owner's own setting, wherever
 *   this Agent runs. Rendered first, because it is what the person asked for
 *   and everything below is what the Agent made of it.
 * - **Persona** — one entry the Agent wrote about itself, delivered
 *   everywhere, which is why it is free of Project facts by rule.
 * - **Notes** — what it learned in a Room, delivered only where that Room's
 *   audience already reached. The subset test runs inside the Memory module's
 *   own candidate query; nothing here reads `memory_entries`.
 *
 * This is **prompt content**, not server-brokered Runtime Context: it creates
 * no Delivery, no snapshot and no checkpoint, in keeping with how the
 * host-bound path already sends a conversation's own history
 * ([`modules/rooms.md`](../../../../.agent/modules/rooms.md)).
 *
 * Sent on every turn rather than only on a fresh session. A vendor session
 * outlives many turns, and an Agent whose persona was revised — or whose Room
 * roster changed what it may be told — would otherwise go on acting as
 * whoever it was when the session started. The budget below is what keeps
 * that affordable.
 */
const NOTE_BUDGET_CHARS = 3000;

/**
 * A persona is written by the Agent itself and, on an unattended Run, applied
 * without anyone deciding it (ADR 0003 §5). Nothing caps what it may say, so
 * nothing but this caps what every turn of every Room then carries. Truncated
 * rather than dropped: an Agent with a runaway persona should still know who
 * it is, and the owner sees the whole of it on the Memory page.
 */
const PERSONA_BUDGET_CHARS = 2000;

export interface AgentIdentityPromptInput {
  spaceId: string;
  agentId: string;
  /** The Room this turn speaks in, or null for a direct chat. */
  roomId: string | null;
  /** The direct chat's person, which is the audience there. */
  directUserId?: string | null;
}

export async function renderAgentIdentityPrompt(
  db: Queryable,
  input: AgentIdentityPromptInput,
): Promise<string | null> {
  const [role, memory] = await Promise.all([
    db.query<{ role_instruction: string | null }>(
      `SELECT role_instruction FROM agents WHERE id = $1 AND space_id = $2`,
      [input.agentId, input.spaceId],
    ),
    listAgentMemoryForDispatch(db, {
      spaceId: input.spaceId,
      agentId: input.agentId,
      roomId: input.roomId,
      directUserId: input.directUserId ?? null,
    }),
  ]);

  const sections: string[] = [];
  const roleInstruction = role.rows[0]?.role_instruction?.trim();
  if (roleInstruction) sections.push(`[Your role, set by the person who owns you]\n${roleInstruction}`);

  const persona = memory.find((entry) => entry.memory_type === "persona");
  if (persona) {
    sections.push(`[What you have learned about yourself]\n${clamp(persona.content.trim(), PERSONA_BUDGET_CHARS)}`);
  }

  // Newest first, and truncated by dropping the oldest: what an Agent learned
  // most recently is what it is most likely to need, and a block cut off
  // mid-sentence is worse than one that stops.
  const notes: string[] = [];
  let used = 0;
  for (const entry of memory) {
    if (entry.memory_type === "persona") continue;
    const line = `- ${entry.content.trim()}`;
    // Skip, not stop. One oversized note at the head of a newest-first list
    // would otherwise starve every shorter note behind it and leave the
    // section empty — an Agent that cannot tell "I learned nothing here" from
    // "the budget ran out on the first line".
    if (used + line.length > NOTE_BUDGET_CHARS) continue;
    used += line.length;
    notes.push(line);
  }
  if (notes.length > 0) {
    sections.push(
      `[What you learned here before]\n${notes.join("\n")}`,
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/** Cuts at a whole word where it can, so a clamped section does not end mid-token. */
function clamp(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const cut = value.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > budget * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
