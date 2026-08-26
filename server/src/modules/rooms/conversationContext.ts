import type { MessageOut } from "@rainver/protocol";
import { estimateModelTokens } from "../usage/modelCatalog.js";

export const ROOM_SUMMARY_TOKEN_BUDGET = 2_000;
export const ROOM_RECENT_TOKEN_BUDGET = 6_000;
/** Keep each provider task bounded even when the uncaptured archive is large. */
export const ROOM_SUMMARY_SOURCE_TOKEN_BUDGET = 12_000;

export type RoomTokenEstimator = (text: string) => number;

export interface RoomSummaryCoverage {
  id: string;
  version: number;
  summary_text: string;
  covered_through_message_id: string;
  covered_through_created_at: string;
}

export interface RoomConversationContext {
  summary: RoomSummaryCoverage | null;
  recent_messages: MessageOut[];
  recent_token_estimate: number;
  summary_token_estimate: number;
  message_refs: string[];
  no_overlap: true;
  trace: {
    version: "room_conversation_context.v1";
    summary_ref: { id: string; version: number } | null;
    covered_through_message_id: string | null;
    recent_message_ids: string[];
    recent_token_estimate: number;
    summary_token_estimate: number;
  };
}

export interface RoomCompactionBatch {
  source_messages: MessageOut[];
  retained_recent_messages: MessageOut[];
  covered_through_message: MessageOut | null;
  source_token_estimate: number;
  retained_recent_token_estimate: number;
  should_compact: boolean;
}

/**
 * Build the fixed Room context contract: at most 2k summary tokens plus at
 * most 6k uncaptured recent tokens. The summary cursor is exclusive, so a
 * message can never be represented in both halves of the prompt.
 */
export function assembleRoomConversationContext(input: {
  messages: readonly MessageOut[];
  currentMessage: MessageOut;
  summary?: RoomSummaryCoverage | null;
  estimateTokens?: RoomTokenEstimator;
}): RoomConversationContext | null {
  const estimate = input.estimateTokens ?? estimateModelTokens;
  const summary = input.summary ?? null;
  const history = input.messages
    .filter((message) => message.id !== input.currentMessage.id)
    .filter((message) => message.content.trim().length > 0)
    .filter((message) => !summary || isAfterCoverage(message, summary));
  const recent = selectRecent(history, ROOM_RECENT_TOKEN_BUDGET, estimate);
  const summaryText = summary?.summary_text.trim() ?? "";
  if (!summaryText && recent.messages.length === 0) return null;

  const summaryIds = new Set(
    summary ? input.messages
      .filter((message) => !isAfterCoverage(message, summary) && message.id !== input.currentMessage.id)
      .map((message) => message.id) : [],
  );
  const overlap = recent.messages.some((message) => summaryIds.has(message.id));
  if (overlap) throw new Error("Room conversation context summary/recent ranges overlap");

  return {
    summary,
    recent_messages: recent.messages,
    recent_token_estimate: recent.token_estimate,
    summary_token_estimate: estimate(summaryText),
    message_refs: recent.messages.map((message) => message.id),
    no_overlap: true,
    trace: {
      version: "room_conversation_context.v1",
      summary_ref: summary ? { id: summary.id, version: summary.version } : null,
      covered_through_message_id: summary?.covered_through_message_id ?? null,
      recent_message_ids: recent.messages.map((message) => message.id),
      recent_token_estimate: recent.token_estimate,
      summary_token_estimate: estimate(summaryText),
    },
  };
}

/** Select an oldest prefix for the next rolling summary and retain the tail. */
export function selectRoomCompactionBatch(input: {
  messages: readonly MessageOut[];
  summary?: Pick<RoomSummaryCoverage, "covered_through_message_id" | "covered_through_created_at"> | null;
  estimateTokens?: RoomTokenEstimator;
}): RoomCompactionBatch {
  const estimate = input.estimateTokens ?? estimateModelTokens;
  const candidates = input.messages
    .filter((message) => message.content.trim().length > 0)
    .filter((message) => !input.summary || isAfterCoverage(message, input.summary));
  const retained = selectRecent(candidates, ROOM_RECENT_TOKEN_BUDGET, estimate);
  const retainedIds = new Set(retained.messages.map((message) => message.id));
  const sourceCandidates = candidates.filter((message) => !retainedIds.has(message.id));
  const source = selectOldest(sourceCandidates, ROOM_SUMMARY_SOURCE_TOKEN_BUDGET, estimate);
  return {
    source_messages: source,
    retained_recent_messages: retained.messages,
    covered_through_message: source.at(-1) ?? null,
    source_token_estimate: sumTokens(source, estimate),
    retained_recent_token_estimate: retained.token_estimate,
    should_compact: source.length > 0,
  };
}

export function estimateRoomSummaryTokens(text: string, estimateTokens: RoomTokenEstimator = estimateModelTokens): number {
  return estimateTokens(text);
}

export function fitRoomSummaryToBudget(
  text: string,
  budget = ROOM_SUMMARY_TOKEN_BUDGET,
  estimateTokens: RoomTokenEstimator = estimateModelTokens,
): string {
  const normalized = text.trim();
  if (estimateTokens(normalized) <= budget) return normalized;
  const marker = "\n[summary clipped to the Room context budget]";
  const prefix = trimUtf8(normalized, Math.max(0, budget - estimateTokens(marker)), estimateTokens);
  return `${prefix.trimEnd()}${marker}`.trim();
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

function selectOldest(messages: readonly MessageOut[], budget: number, estimateTokens: RoomTokenEstimator): MessageOut[] {
  const selected: MessageOut[] = [];
  let tokens = 0;
  for (const message of messages) {
    const count = estimateTokens(message.content);
    // Keep at least one complete source message so an oversized turn fails
    // explicitly at the provider boundary rather than being silently lost.
    if (selected.length === 0 || tokens + count <= budget) {
      selected.push(message);
      tokens += count;
      continue;
    }
    break;
  }
  return selected;
}

function isAfterCoverage(
  message: Pick<MessageOut, "id" | "created_at">,
  coverage: Pick<RoomSummaryCoverage, "covered_through_message_id" | "covered_through_created_at">,
): boolean {
  if (message.created_at !== coverage.covered_through_created_at) {
    return message.created_at > coverage.covered_through_created_at;
  }
  return message.id > coverage.covered_through_message_id;
}

function sumTokens(messages: readonly MessageOut[], estimateTokens: RoomTokenEstimator): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

function trimUtf8(text: string, maxTokens: number, estimateTokens: RoomTokenEstimator): string {
  // Tokenizer implementations are intentionally injectable. The shared
  // fallback is conservative and character-boundary safe; provider-specific
  // implementations can replace it without changing cursor semantics.
  let result = "";
  for (const character of text) {
    const candidate = result + character;
    if (estimateTokens(candidate) > maxTokens) break;
    result = candidate;
  }
  return result;
}
