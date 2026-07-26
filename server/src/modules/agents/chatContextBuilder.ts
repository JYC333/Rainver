/**
 * Chat-path context assembly.
 *
 * Owns the cumulative budget/dedup loop and compact context preamble rendering.
 *
 * Per-source candidate reads (memory/knowledge/source/activity/project_folder/project)
 * are produced by the native `ChatContextCandidateCollector`, already excerpted,
 * scored, and token-counted in priority order. This module applies only the
 * cumulative `max_items` / `max_tokens` / dedup selection and builds the audit
 * `retrieval_trace`, so the final selection remains stable over the frozen
 * compatibility fixture (`chat_context_build_contract.json`).
 */

import type {
  ChatContextCandidateItem,
  ChatContextCandidatesResult,
  CanonicalMessage,
  MessageOut,
  SessionSummaryForContext,
} from "@agent-space/protocol" with { "resolution-mode": "import" };

export interface ChatContextBundle {
  items: ChatContextCandidateItem[];
  token_count: number;
  truncated: boolean;
  retrieval_trace: Record<string, unknown>;
}

export interface ChatConversationWindowMessage {
  message_id: string | null;
  role: string;
  content: string;
  token_count: number;
  compacted: boolean;
  current: boolean;
}

export interface ChatConversationWindowSummary {
  summary_id: string;
  version: number;
  content: string;
  token_count: number;
  compacted: boolean;
  source_message_count: number | null;
  source_first_message_id: string | null;
  source_last_message_id: string | null;
  condenser_version: string;
}

export interface ChatConversationWindow {
  version: "conversation_window.v1";
  summary: ChatConversationWindowSummary | null;
  messages: ChatConversationWindowMessage[];
  token_count: number;
  max_tokens: number;
  truncated: boolean;
  trace: Record<string, unknown>;
}

export interface BuildChatConversationWindowInput {
  messages: readonly MessageOut[];
  currentMessage: MessageOut;
  summary?: SessionSummaryForContext | null;
  maxTokens?: number;
  maxRecentMessages?: number;
}

const DEFAULT_CONVERSATION_WINDOW_TOKENS = 6000;
const DEFAULT_RECENT_MESSAGE_LIMIT = 12;
const DEFAULT_SUMMARY_MAX_TOKENS = 1200;
const MIN_COMPACTED_MESSAGE_TOKENS = 80;
const MIN_SUMMARY_TOKENS = 32;

/**
 * Apply the cumulative budget/dedup loop over priority-ordered candidates.
 *
 * Scan candidates in order, stop once `max_tokens` or `max_items` is reached,
 * dedup by `(item_type, item_id)` (null-id items are never deduped against each
 * other), and sum `token_count`.
 */
export function buildChatContext(
  candidates: ChatContextCandidatesResult,
): ChatContextBundle {
  const items: ChatContextCandidateItem[] = [];
  const seen = new Set<string>();
  let totalTokens = 0;

  const maxTokens = candidates.max_tokens;
  const maxItems = candidates.max_items;

  candidates.items.forEach((item) => {
    if (totalTokens >= maxTokens || items.length >= maxItems) return;
    // Null/empty item_id falls back to a per-item unique key, so such items
    // never dedup together.
    const key = item.item_id ? `${item.item_type}::${item.item_id}` : null;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    items.push(item);
    totalTokens += item.token_count ?? 0;
  });

  // `forEach` cannot break, so the cap is re-checked per item above. Once the
  // cap is hit every later item is skipped.
  const truncated = totalTokens >= maxTokens || items.length >= maxItems;

  return {
    items,
    token_count: totalTokens,
    truncated,
    retrieval_trace: {
      allowed_sources: candidates.allowed_sources,
      context_policy_applied: candidates.context_policy_applied,
      item_count: items.length,
      total_tokens: totalTokens,
      truncated,
      max_tokens: maxTokens,
      max_items: maxItems,
    },
  };
}

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
  const summary = input.summary ?? null;
  const current = normalizeWindowMessage(input.currentMessage, true);
  const history = input.messages
    .filter((message) => message.id !== input.currentMessage.id)
    .filter((message) => message.content.trim().length > 0)
    .map((message) => normalizeWindowMessage(message, false));

  const summarySplit = splitHistoryCoveredBySummary(history, summary);
  // Messages after the summary watermark are uncovered context. When a summary
  // is present they must all be candidates (bounded only by the token budget
  // below), otherwise a lagging condenser watermark — the summary covers up to
  // `total - keepRecent` only once a batch has aged out — would leave the turns
  // between the watermark and the last `maxRecentMessages` neither summarized
  // nor shown. The `maxRecentMessages` cap only bounds an unsummarized history.
  const recentCandidates = summary
    ? [...summarySplit.after]
    : summarySplit.after.slice(-maxRecentMessages);
  const droppedByRecentLimit = summarySplit.after.slice(
    0,
    Math.max(0, summarySplit.after.length - recentCandidates.length),
  );

  let remaining = maxTokens - current.token_count;
  const droppedByBudget: ChatConversationWindowMessage[] = [];
  const selectedReversed: ChatConversationWindowMessage[] = [];
  const compactedMessageIds: string[] = [];

  const summaryWindow = buildSummaryWindow(summary, Math.min(
    DEFAULT_SUMMARY_MAX_TOKENS,
    Math.max(0, remaining),
  ));
  if (summaryWindow) remaining -= summaryWindow.token_count;

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
  const tokenCount =
    (summaryWindow?.token_count ?? 0) +
    messages.reduce((sum, message) => sum + message.token_count, 0);
  const overBudget = current.token_count > maxTokens;
  const truncated =
    overBudget ||
    summaryWindow?.compacted === true ||
    compactedMessageIds.length > 0 ||
    droppedMessages.length > 0 ||
    droppedByRecentLimit.length > 0;

  return {
    version: "conversation_window.v1",
    summary: summaryWindow,
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
      summary: summaryWindow
        ? {
            summary_id: summaryWindow.summary_id,
            version: summaryWindow.version,
            token_count: summaryWindow.token_count,
            compacted: summaryWindow.compacted,
            source_message_count: summaryWindow.source_message_count,
            source_first_message_id: summaryWindow.source_first_message_id,
            source_last_message_id: summaryWindow.source_last_message_id,
            condenser_version: summaryWindow.condenser_version,
          }
        : null,
      messages: messages.map((message) => ({
        message_id: message.message_id,
        role: message.role,
        token_count: message.token_count,
        compacted: message.compacted,
        current: message.current,
      })),
      covered_by_summary_count: summarySplit.coveredCount,
      covered_by_summary_message_ids: summarySplit.coveredIds,
      dropped_message_ids: droppedMessages.map((message) => message.message_id),
      dropped_message_count: droppedMessages.length,
      compacted_message_ids: compactedMessageIds.filter(Boolean),
      overflow_recovery: {
        applied: truncated,
        strategy: "summary_then_recent_turns",
        summary_compacted: summaryWindow?.compacted === true,
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
  if (!window.summary && priorMessages.length === 0) {
    return current?.content ?? "";
  }

  const lines = [
    "[Conversation window - use this for continuity. Recent turns override older summaries.]",
  ];
  if (window.summary) {
    lines.push(
      "",
      "[Condensed earlier conversation]",
      window.summary.content,
    );
  }
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
  if (window.summary) {
    messages.push({
      role: "user",
      content:
        "[Condensed earlier conversation]\n" +
        `${window.summary.content}\n\n` +
        "Use this as background continuity. Recent turns override this summary.",
    });
  }
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
 * an assistant-led conversation — reachable here when no summary is present and
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

/** Compact bullet list of selected items. */
export function renderContextPreamble(
  items: readonly ChatContextCandidateItem[],
): string {
  if (items.length === 0) return "";
  const lines = [
    "[Context from your space — use it if relevant; do not repeat it verbatim.]",
  ];
  for (const it of items) {
    const title = (it.title || it.item_type || "item").trim();
    const excerpt = (it.excerpt || "").trim();
    lines.push(
      excerpt
        ? `- (${it.item_type}) ${title}: ${excerpt}`
        : `- (${it.item_type}) ${title}`,
    );
  }
  return lines.join("\n");
}

/**
 * Compose the fallback runtime prompt with the conversation first so vendor
 * prompt caches can reuse the longest stable prefix. Retrieved context changes
 * per turn and therefore belongs in the dynamic tail.
 */
export function composeChatPrompt(
  conversation: string,
  contextPreamble: string,
): string {
  return contextPreamble
    ? `${conversation}\n\n${contextPreamble}`
    : conversation;
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

function buildSummaryWindow(
  summary: SessionSummaryForContext | null,
  maxTokens: number,
): ChatConversationWindowSummary | null {
  if (!summary || !summary.summary_text.trim()) return null;
  if (maxTokens < MIN_SUMMARY_TOKENS) return null;
  const compacted = compactText(summary.summary_text.trim(), maxTokens);
  return {
    summary_id: summary.id,
    version: summary.version,
    content: compacted.content,
    token_count: compacted.token_count,
    compacted: compacted.compacted,
    source_message_count: numberOrNull(summary.source_message_count),
    source_first_message_id: stringOrNull(summary.source_first_message_id),
    source_last_message_id: stringOrNull(summary.source_last_message_id),
    condenser_version: summary.condenser_version,
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

function splitHistoryCoveredBySummary(
  history: readonly ChatConversationWindowMessage[],
  summary: SessionSummaryForContext | null,
): {
  after: ChatConversationWindowMessage[];
  coveredCount: number;
  coveredIds: string[];
} {
  const lastId = stringOrNull(summary?.source_last_message_id);
  if (!lastId) {
    return { after: [...history], coveredCount: 0, coveredIds: [] };
  }
  const index = history.findIndex((message) => message.message_id === lastId);
  if (index < 0) {
    return {
      after: [...history],
      coveredCount: numberOrNull(summary?.source_message_count) ?? 0,
      coveredIds: [],
    };
  }
  const covered = history.slice(0, index + 1);
  return {
    after: history.slice(index + 1),
    coveredCount: covered.length,
    coveredIds: covered.map((message) => message.message_id).filter(isString),
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
