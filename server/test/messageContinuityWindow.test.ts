import { describe, expect, it } from "vitest";
import {
  buildChatConversationWindow,
  conversationWindowToMessages,
  renderConversationWindow,
} from "../src/modules/agents/messageContinuityWindow";

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

  it("bounds unsummarized history to the configured recent-message limit", () => {
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
    });
    expect(window.messages.map((m) => m.message_id)).toEqual(["m-11", "m-12", "m-13", "m-current"]);
    expect(
      (window.trace.overflow_recovery as Record<string, unknown>)
        .messages_dropped_for_recent_limit,
    ).toBe(11);
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
        strategy: "recent_turns",
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

});
