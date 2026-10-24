import type { MessageOut } from "@rainver/protocol";
import { estimateModelTokens, fitTextToTokenBudget } from "../usage/modelCatalog.js";

/**
 * The Room tail an API-provider Run is given: the uncaptured recent messages
 * within a fixed budget. A vendor CLI Run gets none of this — its session
 * holds the conversation — and nothing summarizes the rest: an Agent writes a
 * summary only when a person asks for one (`agentGroups/sessionHandoff.ts`).
 */
export const ROOM_RECENT_TOKEN_BUDGET = 6_000;
/** The budget a thread reference's carried text is clipped to. */
export const ROOM_SUMMARY_TOKEN_BUDGET = 2_000;

type RoomTokenEstimator = (text: string) => number;

export interface RoomContextBudgets {
  recent: number;
}

export const ROOM_CONTEXT_FLOOR_BUDGETS: RoomContextBudgets = { recent: ROOM_RECENT_TOKEN_BUDGET };

interface RoomConversationContext {
  recent_messages: MessageOut[];
  recent_token_estimate: number;
  message_refs: string[];
  trace: Record<string, unknown>;
}

/** The recent tail before the current message, newest messages kept first within the budget. */
export function assembleRoomConversationContext(input: {
  messages: readonly MessageOut[];
  currentMessage: MessageOut;
  budgets?: RoomContextBudgets;
  estimateTokens?: RoomTokenEstimator;
}): RoomConversationContext | null {
  const estimate = input.estimateTokens ?? estimateModelTokens;
  const budgets = input.budgets ?? ROOM_CONTEXT_FLOOR_BUDGETS;
  const history = input.messages
    .filter((message) => message.id !== input.currentMessage.id)
    .filter((message) => message.content.trim().length > 0);
  const recent = selectRecent(history, budgets.recent, estimate);
  if (recent.messages.length === 0) return null;
  return {
    recent_messages: recent.messages,
    recent_token_estimate: recent.token_estimate,
    message_refs: recent.messages.map((message) => message.id),
    trace: {
      version: "room_conversation_context.v1",
      recent_message_ids: recent.messages.map((message) => message.id),
      recent_token_estimate: recent.token_estimate,
    },
  };
}

/** Clip carried text to the Room's reference budget, with the Room's own clipping marker. */
export function fitRoomSummaryToBudget(
  text: string,
  budget = ROOM_SUMMARY_TOKEN_BUDGET,
  estimateTokens: RoomTokenEstimator = estimateModelTokens,
): string {
  return fitTextToTokenBudget(text, budget, "[summary clipped to the Room context budget]", estimateTokens);
}

function selectRecent(messages: readonly MessageOut[], budget: number, estimateTokens: RoomTokenEstimator): {
  messages: MessageOut[];
  token_estimate: number;
} {
  const selected: MessageOut[] = [];
  let tokens = 0;
  for (const message of [...messages].reverse()) {
    const count = estimateTokens(message.content);
    // The triggering message is supplied separately and is never truncated.
    // Prior oversized messages are omitted so the raw tail remains bounded.
    if (count <= budget && tokens + count <= budget) {
      selected.push(message);
      tokens += count;
      continue;
    }
    if (count > budget) continue;
    break;
  }
  return { messages: selected.reverse(), token_estimate: tokens };
}
