import { describe, expect, it } from "vitest";
import type { ChatContextCandidateItem } from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  buildChatConversationWindow,
  buildChatContext,
  composeChatPrompt,
  conversationWindowToMessages,
  renderConversationWindow,
  renderContextPreamble,
} from "../src/modules/agents/chatContextBuilder";

function item(
  over: Partial<ChatContextCandidateItem> & { item_type: string },
): ChatContextCandidateItem {
  return { token_count: 0, metadata: {}, ...over };
}

function message(
  id: string,
  role: string,
  content: string,
  createdAt = "2026-06-14T10:00:00.000Z",
) {
  return {
    id,
    session_id: "session-1",
    space_id: "space-1",
    user_id: "user-1",
    role,
    content,
    metadata_json: null,
    created_at: createdAt,
  };
}

describe("renderContextPreamble", () => {
  it("returns empty string for no items", () => {
    expect(renderContextPreamble([])).toBe("");
  });

  it("renders the header plus a bullet per item, with/without excerpt", () => {
    const out = renderContextPreamble([
      item({ item_type: "memory", title: "Mem", excerpt: "content" }),
      item({ item_type: "project_folder", title: "WS", excerpt: "" }),
    ]);
    expect(out).toBe(
      "[Context from your space — use it if relevant; do not repeat it verbatim.]\n" +
        "- (memory) Mem: content\n" +
        "- (project_folder) WS",
    );
  });

  it("falls back to item_type then 'item' for a missing title", () => {
    expect(
      renderContextPreamble([item({ item_type: "source", title: null, excerpt: "x" })]),
    ).toBe(
      "[Context from your space — use it if relevant; do not repeat it verbatim.]\n" +
        "- (source) source: x",
    );
  });
});

describe("composeChatPrompt", () => {
  it("keeps conversation as the stable prefix and appends dynamic context", () => {
    expect(composeChatPrompt("history\n\nhi", "PRE")).toBe(
      "history\n\nhi\n\nPRE",
    );
    expect(composeChatPrompt("hi", "")).toBe("hi");
  });
});

describe("buildChatConversationWindow", () => {
  it("renders only the current message when there is no history or summary", () => {
    const window = buildChatConversationWindow({
      messages: [],
      currentMessage: message("m-current", "user", "Hi"),
    });

    expect(renderConversationWindow(window)).toBe("Hi");
    expect(window.trace).toMatchObject({
      token_count: 1,
      truncated: false,
      messages: [
        {
          message_id: "m-current",
          role: "user",
          current: true,
        },
      ],
    });
  });

  it("uses the active summary for covered history and keeps later turns", () => {
    const window = buildChatConversationWindow({
      messages: [
        message("m-1", "user", "old question"),
        message("m-2", "assistant", "old answer"),
        message("m-3", "user", "new question"),
        message("m-current", "user", "continue"),
      ],
      currentMessage: message("m-current", "user", "continue"),
      summary: {
        id: "summary-1",
        session_id: "session-1",
        version: 2,
        summary_text: "Earlier discussion covered the old question.",
        source_message_count: 2,
        source_first_message_id: "m-1",
        source_last_message_id: "m-2",
        condenser_version: "pattern.v1",
      },
    });

    expect(window.messages.map((m) => m.message_id)).toEqual(["m-3", "m-current"]);
    expect(window.trace).toMatchObject({
      covered_by_summary_count: 2,
      covered_by_summary_message_ids: ["m-1", "m-2"],
      summary: {
        summary_id: "summary-1",
        source_last_message_id: "m-2",
      },
    });
    const rendered = renderConversationWindow(window);
    expect(rendered).toContain("[Condensed earlier conversation]");
    expect(rendered).toContain("Earlier discussion covered the old question.");
    expect(rendered).toContain("new question");
    expect(rendered).toContain("continue");
    expect(rendered).not.toContain("old answer");
  });

  it("shows all messages after the summary watermark, not just maxRecentMessages", () => {
    // A lagging summary watermark (covers only m-0) plus a small recent cap must
    // not drop the turns between the watermark and the last N — they are
    // uncovered context and the budget, not maxRecentMessages, bounds them.
    const history = [];
    for (let i = 0; i < 14; i += 1) {
      history.push(
        message(`m-${i}`, i % 2 === 0 ? "user" : "assistant", `turn ${i}`),
      );
    }
    history.push(message("m-current", "user", "now"));
    const window = buildChatConversationWindow({
      messages: history,
      currentMessage: message("m-current", "user", "now"),
      maxRecentMessages: 3,
      maxTokens: 100000,
      summary: {
        id: "summary-1",
        session_id: "session-1",
        version: 1,
        summary_text: "covered the very first turn",
        source_message_count: 1,
        source_first_message_id: "m-0",
        source_last_message_id: "m-0",
        condenser_version: "pattern.v1",
      },
    });
    // m-1 .. m-13 (after watermark m-0) + current are all present; none dropped
    // by the recent-limit cap.
    expect(window.messages.map((m) => m.message_id)).toEqual([
      ...Array.from({ length: 13 }, (_, i) => `m-${i + 1}`),
      "m-current",
    ]);
    expect(
      (window.trace.overflow_recovery as Record<string, unknown>)
        .messages_dropped_for_recent_limit,
    ).toBe(0);
  });

  it("records overflow recovery when the recent turn budget is exceeded", () => {
    const long = "x".repeat(1000);
    const window = buildChatConversationWindow({
      messages: [
        message("m-1", "user", long),
        message("m-2", "assistant", long),
        message("m-current", "user", "now"),
      ],
      currentMessage: message("m-current", "user", "now"),
      maxTokens: 90,
    });

    expect(window.truncated).toBe(true);
    expect(window.trace).toMatchObject({
      truncated: true,
      overflow_recovery: {
        applied: true,
        strategy: "summary_then_recent_turns",
      },
    });
    const recovery = window.trace.overflow_recovery as Record<string, unknown>;
    expect(
      Number(recovery.messages_compacted) + Number(recovery.messages_dropped_for_budget),
    ).toBeGreaterThan(0);
  });
});

describe("conversationWindowToMessages", () => {
  it("keeps a user-led, role-alternating message list", () => {
    const window = buildChatConversationWindow({
      messages: [
        message("m-1", "user", "old question"),
        message("m-2", "assistant", "old answer"),
        message("m-current", "user", "continue"),
      ],
      currentMessage: message("m-current", "user", "continue"),
    });
    expect(conversationWindowToMessages(window)).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "continue" },
    ]);
  });

  it("drops a leading assistant turn so the list starts with user", () => {
    // No summary + an assistant-led history (e.g. budget dropped the oldest
    // user turn) must not produce an assistant-first message list.
    const window = buildChatConversationWindow({
      messages: [
        message("m-1", "assistant", "leading assistant"),
        message("m-2", "user", "user reply"),
        message("m-current", "user", "now"),
      ],
      currentMessage: message("m-current", "user", "now"),
    });
    const out = conversationWindowToMessages(window);
    expect(out[0]?.role).toBe("user");
    expect(out.some((m) => m.content === "leading assistant")).toBe(false);
  });

  it("renders the summary as the leading user turn", () => {
    const window = buildChatConversationWindow({
      messages: [
        message("m-1", "user", "covered question"),
        message("m-2", "assistant", "covered answer"),
        message("m-3", "user", "new question"),
        message("m-current", "user", "continue"),
      ],
      currentMessage: message("m-current", "user", "continue"),
      summary: {
        id: "summary-1",
        session_id: "session-1",
        version: 1,
        summary_text: "Earlier discussion covered the old question.",
        source_message_count: 1,
        source_first_message_id: "m-1",
        source_last_message_id: "m-1",
        condenser_version: "pattern.v1",
      },
    });
    const out = conversationWindowToMessages(window);
    expect(out[0]?.role).toBe("user");
    expect(out[0]?.content).toContain("[Condensed earlier conversation]");
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // No two consecutive turns share a role.
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]?.role).not.toBe(out[i - 1]?.role);
    }
  });
});

describe("buildChatContext", () => {
  it("stops at max_items and flags truncation", () => {
    const bundle = buildChatContext({
      allowed_sources: ["memory"],
      max_tokens: 100000,
      max_items: 2,
      context_policy_applied: true,
      items: [
        item({ item_type: "memory", item_id: "a", token_count: 1 }),
        item({ item_type: "memory", item_id: "b", token_count: 1 }),
        item({ item_type: "memory", item_id: "c", token_count: 1 }),
      ],
    });
    expect(bundle.items.map((i) => i.item_id)).toEqual(["a", "b"]);
    expect(bundle.truncated).toBe(true);
    expect(bundle.retrieval_trace).toMatchObject({ item_count: 2, max_items: 2 });
  });
});
