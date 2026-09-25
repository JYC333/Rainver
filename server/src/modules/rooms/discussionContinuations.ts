import type { ConversationContinuationRegistry } from "../proposals/continuationRegistry.js";

/**
 * The two system-originated turns a Room discussion dispatches
 * (`discussionService.ts`). Both are domain-event continuations, so they reuse
 * the same serialization, identity, prompt and idempotency path as a person's
 * message and every other continuation.
 *
 * - `agent_mention`: the next wave. The recipients are the Agents addressed in
 *   the previous wave; each is told, in its own segment, who addressed it and
 *   what they said. The instruction below is the hidden transcript row.
 * - `agent_discussion_closing`: the Manager's closing turn, addressed to the
 *   person — agreements, disagreements, next steps, and who did not respond.
 */
export function registerRoomDiscussionContinuations(registry: ConversationContinuationRegistry): void {
  registry.registerEvent("agent_mention", ({ event }) => {
    const round = numberValue(event.payload.round);
    const roundCap = numberValue(event.payload.round_cap);
    const addressed = Array.isArray(event.payload.addressed) ? event.payload.addressed as Array<Record<string, unknown>> : [];
    const lines = addressed.map((entry) => {
      const to = typeof entry.agent_name === "string" ? entry.agent_name : "an Agent";
      const from = Array.isArray(entry.from_names) ? entry.from_names.filter((name) => typeof name === "string").join(", ") : "";
      return from ? `${from} → ${to}` : to;
    });
    return {
      directive: "respond_in_discussion",
      instruction: [
        `[Discussion · round ${round ?? "?"} of ${roundCap ?? "?"}]`,
        lines.length > 0 ? lines.join("\n") : "The discussion continues.",
      ].join("\n"),
      context: {
        discussion_id: typeof event.payload.discussion_id === "string" ? event.payload.discussion_id : null,
        round,
      },
    };
  });

  registry.registerEvent("agent_discussion_closing", ({ event }) => {
    const status = typeof event.payload.status === "string" ? event.payload.status : "converged";
    const reason = typeof event.payload.stop_reason === "string" ? event.payload.stop_reason : null;
    const participants = stringList(event.payload.participant_names);
    const silent = Array.isArray(event.payload.non_responders)
      ? (event.payload.non_responders as Array<Record<string, unknown>>)
        .map((entry) => `- ${String(entry.agent_name ?? "An Agent")}: ${String(entry.reason ?? "did not reply")}`)
      : [];
    const held = stringList(event.payload.held_names);
    return {
      directive: "synthesize_discussion",
      instruction: [
        "[Discussion ended — write the conclusion for the person]",
        `How it ended: ${endingText(status, reason)}.`,
        participants.length > 0 ? `Participants: ${participants.join(", ")}.` : null,
        "Read the discussion above and reply to the person with: what the participants agreed on, where they still disagree and why, the next steps you propose, and who did not respond and why.",
        silent.length > 0 ? `Did not respond:\n${silent.join("\n")}` : null,
        held.length > 0 ? `Addressed but not yet heard, because the discussion stopped: ${held.join(", ")}. Say so; the person can add rounds.` : null,
        "Do not @-address other Agents in this reply. Anything durable — a plan, a decision, a change to the Project — goes through its proposal as always; the person decides.",
      ].filter(Boolean).join("\n"),
      context: { status, stop_reason: reason },
    };
  });
}

function endingText(status: string, reason: string | null): string {
  if (status === "stopped") return "a person stopped it";
  if (status === "cap_reached") {
    if (reason === "spend_cap") return "it reached its spend cap";
    if (reason === "fanout_budget") return "the turn's budget of Agent-triggered turns was spent";
    if (reason === "quota_exhausted") return "a subscription's usage window was exhausted";
    return "it reached its round cap";
  }
  return "nobody addressed anyone in the last round, so it converged";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
