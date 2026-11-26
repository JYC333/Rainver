import { createHash } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import { renderAgentIdentityPrompt } from "./agentIdentityPrompt.js";
import {
  ACTION_RESULT_REPORTING_POLICY,
  ASK_THE_PERSON_POLICY,
  CONCLUSION_ACTION_POLICY,
  DURABLE_ACTION_CLAIM_POLICY,
  IDENTIFIER_POLICY,
  ACTION_FAILURE_RECOVERY_POLICY,
  PLAN_ACTION_POLICY,
  PROJECT_DEFINITION_ACTION_POLICY,
  PROPOSAL_DECISION_POLICY,
  QUESTION_DECOMPOSITION_ACTION_POLICY,
  RESEARCH_EXECUTION_POLICY,
} from "../systemActions/conversationPolicy.js";

/**
 * What a Room turn's vendor session must hold before it is told anything
 * else: the Agent's identity block (`agentIdentityPrompt.ts`) and the Room's
 * execution rules. It changes rarely — a persona revision, a roster change
 * that alters which notes may be delivered, a rules edit — while the task and
 * the message window change every turn.
 *
 * So it is sent when it changes, never on every turn. Do not re-send it every
 * turn: a resumed session grows by one copy per turn, and the vendor cannot
 * cache a repeat. The thread keeps the digest of what its live session last received
 * (`host_threads.identity_digest`), and that digest is written only by the
 * terminal outcome of a Run that carried the block and completed
 * (`PgHostThreadRepository.recordRunOutcome`). A dispatch that never reached
 * the runtime therefore never marks the block sent, which would silently
 * withhold the Agent's identity — the worse failure.
 */
interface RoomStandingContext {
  text: string;
  digest: string;
}

export function roomExecutionRules(): string {
  return [
    "[Room execution rules]",
    IDENTIFIER_POLICY,
    ACTION_FAILURE_RECOVERY_POLICY,
    DURABLE_ACTION_CLAIM_POLICY,
    PROJECT_DEFINITION_ACTION_POLICY,
    PLAN_ACTION_POLICY,
    QUESTION_DECOMPOSITION_ACTION_POLICY,
    CONCLUSION_ACTION_POLICY,
    RESEARCH_EXECUTION_POLICY,
    PROPOSAL_DECISION_POLICY,
    ACTION_RESULT_REPORTING_POLICY,
    ASK_THE_PERSON_POLICY,
  ].join("\n");
}

export async function renderRoomStandingContext(
  db: Queryable,
  /**
   * `sessionId`: the conversation this turn speaks in. Its audience can be
   * narrower than the Room's (`room_conversation_audiences`), and notes are
   * delivered against the audience actually present.
   */
  input: { spaceId: string; agentId: string; roomId: string; sessionId?: string | null; review?: boolean },
): Promise<RoomStandingContext> {
  const identity = await renderAgentIdentityPrompt(db, input);
  const rules = input.review ? [
    "[Room code review rules]",
    "Review the assigned version and report actionable findings with evidence and verification limits. Preserve the authorized workspace, audience, and approval boundaries. Follow relevant repository rules; use the supplied changes and document sections to focus a follow-up review.",
    "When you have the prior review in this session, reuse readings of unchanged sources and revisit files or document sections that changed or affect a finding.",
    IDENTIFIER_POLICY,
    ACTION_FAILURE_RECOVERY_POLICY,
    DURABLE_ACTION_CLAIM_POLICY,
    ASK_THE_PERSON_POLICY,
  ].join("\n") : roomExecutionRules();
  const text = [identity, rules].filter(Boolean).join("\n\n");
  return { text, digest: createHash("sha256").update(text).digest("hex") };
}

/**
 * Whether this turn's prompt must carry the standing context: always into a
 * vendor session that is not being resumed (a fresh or reset one holds
 * nothing), and into a resumed one only when what it last received differs.
 */
export function standingContextRequired(input: {
  resumingVendorSession: boolean;
  threadDigest: string | null;
  digest: string;
}): boolean {
  return !input.resumingVendorSession || input.threadDigest !== input.digest;
}
