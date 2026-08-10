/**
 * Canonical-message continuity window helpers used by Runtime Context direct
 * acquisition. Retrieval selection and budgeting belong to Runtime Context and
 * the Retrieval Engine, not this message-history utility.
 */

import type {
  CanonicalMessage,
  MessageOut,
} from "@agent-space/protocol" with { "resolution-mode": "import" };

export interface ChatConversationWindowMessage {
  message_id: string | null;
  role: string;
  content: string;
  token_count: number;
  compacted: boolean;
  current: boolean;
}

export interface ChatConversationWindow {
  version: "conversation_window.v1";
  messages: ChatConversationWindowMessage[];
  token_count: number;
  max_tokens: number;
  truncated: boolean;
  trace: Record<string, unknown>;
}

export interface BuildChatConversationWindowInput {
  messages: readonly MessageOut[];
  currentMessage: MessageOut;
  maxTokens?: number;
  maxRecentMessages?: number;
}

const DEFAULT_CONVERSATION_WINDOW_TOKENS = 6000;
const DEFAULT_RECENT_MESSAGE_LIMIT = 12;
const MIN_COMPACTED_MESSAGE_TOKENS = 80;

export function buildChatConversationWindow(
  input: BuildChatConversationWindowInput,
): ChatConversationWindow {
  const maxTokens = positiveInt(
    input.maxTokens,
    DEFAULT_CONVERSATION_WINDOW_TOKENS,
  );
  const maxRecentMessages = positiveInt(
    input.maxRecentMessages,
    DEFAULT_RECENT_MESSAGE_LIMIT,
  );
  const current = normalizeWindowMessage(input.currentMessage, true);
  const history = input.messages
    .filter((message) => message.id !== input.currentMessage.id)
    .filter((message) => message.content.trim().length > 0)
    .map((message) => normalizeWindowMessage(message, false));

  const recentCandidates = history.slice(-maxRecentMessages);
  const droppedByRecentLimit = history.slice(
    0,
    Math.max(0, history.length - recentCandidates.length),
  );

  let remaining = maxTokens - current.token_count;
  const droppedByBudget: ChatConversationWindowMessage[] = [];
  const selectedReversed: ChatConversationWindowMessage[] = [];
  const compactedMessageIds: string[] = [];

  for (const message of [...recentCandidates].reverse()) {
    if (remaining <= 0) {
      droppedByBudget.push(message);
      continue;
    }
    if (message.token_count <= remaining) {
      selectedReversed.push(message);
      remaining -= message.token_count;
      continue;
    }
    if (remaining >= MIN_COMPACTED_MESSAGE_TOKENS) {
      const compacted = compactWindowMessage(message, remaining);
      selectedReversed.push(compacted);
      compactedMessageIds.push(message.message_id ?? "");
      remaining -= compacted.token_count;
      continue;
    }
    droppedByBudget.push(message);
  }

  const selectedHistory = selectedReversed.reverse();
  const messages = [...selectedHistory, current];
  const droppedMessages = [...droppedByRecentLimit, ...droppedByBudget.reverse()];
  const tokenCount = messages.reduce((sum, message) => sum + message.token_count, 0);
  const overBudget = current.token_count > maxTokens;
  const truncated =
    overBudget ||
    compactedMessageIds.length > 0 ||
    droppedMessages.length > 0 ||
    droppedByRecentLimit.length > 0;

  return {
    version: "conversation_window.v1",
    messages,
    token_count: tokenCount,
    max_tokens: maxTokens,
    truncated,
    trace: {
      version: "conversation_window.v1",
      max_tokens: maxTokens,
      max_recent_messages: maxRecentMessages,
      token_count: tokenCount,
      truncated,
      over_budget: overBudget,
      current_message_id: input.currentMessage.id,
      messages: messages.map((message) => ({
        message_id: message.message_id,
        role: message.role,
        token_count: message.token_count,
        compacted: message.compacted,
        current: message.current,
      })),
      dropped_message_ids: droppedMessages.map((message) => message.message_id),
      dropped_message_count: droppedMessages.length,
      compacted_message_ids: compactedMessageIds.filter(Boolean),
      overflow_recovery: {
        applied: truncated,
        strategy: "recent_turns",
        messages_compacted: compactedMessageIds.length,
        messages_dropped_for_recent_limit: droppedByRecentLimit.length,
        messages_dropped_for_budget: droppedByBudget.length,
      },
    },
  };
}

export function renderConversationWindow(window: ChatConversationWindow): string {
  const priorMessages = window.messages.filter((message) => !message.current);
  const current = window.messages.find((message) => message.current);
  if (priorMessages.length === 0) {
    return current?.content ?? "";
  }

  const lines = [
    "[Conversation window - use this for continuity.]",
  ];
  if (priorMessages.length > 0) {
    lines.push("", "[Recent session turns]");
    for (const message of priorMessages) {
      lines.push(renderRoleBlock(message.role, message.content));
    }
  }
  if (current) {
    lines.push("", "[Current user message]", renderRoleBlock(current.role, current.content));
  }
  return lines.join("\n");
}

export function conversationWindowToMessages(
  window: ChatConversationWindow,
): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (const message of window.messages) {
    messages.push({
      role: normalizeProviderRole(message.role),
      content: message.content,
    });
  }
  return normalizeProviderMessages(messages);
}

/**
 * Make a message list valid for managed chat providers (e.g. Anthropic
 * Messages): drop empty turns, ensure the first turn is `user` (providers reject
 * an assistant-led conversation — reachable here when
 * the budget loop drops the oldest user turn), and merge consecutive same-role
 * turns so roles alternate. Always returns at least one `user` turn.
 */
function normalizeProviderMessages(
  messages: readonly CanonicalMessage[],
): CanonicalMessage[] {
  const nonEmpty = messages.filter(
    (message) => (message.content ?? "").trim().length > 0,
  );
  // A conversation must start with the user turn.
  const firstUser = nonEmpty.findIndex((message) => message.role === "user");
  const fromFirstUser = firstUser < 0 ? [] : nonEmpty.slice(firstUser);

  const merged: CanonicalMessage[] = [];
  for (const message of fromFirstUser) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content ?? ""}\n\n${message.content ?? ""}`;
      continue;
    }
    merged.push({ role: message.role, content: message.content ?? "" });
  }
  return merged.length > 0 ? merged : [{ role: "user", content: "" }];
}

function positiveInt(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function normalizeWindowMessage(
  message: MessageOut,
  current: boolean,
): ChatConversationWindowMessage {
  const content = message.content.trim();
  return {
    message_id: message.id ?? null,
    role: message.role,
    content,
    token_count: estimateTokens(content),
    compacted: false,
    current,
  };
}

function compactWindowMessage(
  message: ChatConversationWindowMessage,
  maxTokens: number,
): ChatConversationWindowMessage {
  const compacted = compactText(message.content, maxTokens);
  return {
    ...message,
    content: compacted.content,
    token_count: compacted.token_count,
    compacted: compacted.compacted,
  };
}

function compactText(
  text: string,
  maxTokens: number,
): { content: string; token_count: number; compacted: boolean } {
  const tokenCount = estimateTokens(text);
  if (tokenCount <= maxTokens) {
    return { content: text, token_count: tokenCount, compacted: false };
  }
  const marker = "\n[... compacted by conversation window budget ...]";
  const maxChars = Math.max(0, maxTokens * 4);
  const contentChars = Math.max(0, maxChars - marker.length);
  const content = `${text.slice(0, contentChars).trimEnd()}${marker}`;
  return {
    content,
    token_count: estimateTokens(content),
    compacted: true,
  };
}

function renderRoleBlock(role: string, content: string): string {
  return `${role}:\n${content}`;
}

function normalizeProviderRole(role: string): string {
  // Managed chat providers only model `user` / `assistant` turns; the chat path
  // is tool-disabled and the system prompt is carried separately, so collapse
  // every non-assistant role (tool/system/unknown) to `user`.
  return role === "assistant" ? "assistant" : "user";
}
