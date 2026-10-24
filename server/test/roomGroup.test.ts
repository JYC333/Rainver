import type { MessageOut } from "@rainver/protocol";
import { describe, expect, it } from "vitest";
import { assembleRoomConversationContext, ROOM_RECENT_TOKEN_BUDGET } from "../src/modules/rooms/conversationContext.js";
import { estimateModelTokens, fitTextToTokenBudget, trimTextToModelTokens, trimTextToModelTokensFromEnd } from "../src/modules/usage/modelCatalog.js";
import { cleanGeneratedTitle, titleFromMessage } from "../src/modules/rooms/conversationTitleService.js";

describe("roomConversationContext", () => {
  function message(id: string, content: string, createdAt: string, role: "user" | "assistant" = "user"): MessageOut {
    return {
      id,
      session_id: "session-1",
      space_id: "space-1",
      user_id: role === "user" ? "user-1" : null,
      sender_agent_id: role === "assistant" ? "agent-1" : null,
      role,
      content,
      metadata_json: null,
      created_at: createdAt,
    };
  }

  describe("Room conversation context", () => {
    it("omits an oversized prior turn instead of exceeding the raw budget", () => {
      const oversized = "x".repeat(ROOM_RECENT_TOKEN_BUDGET * 8);
      const current = message("m-2", "trigger", "2026-01-01T00:00:02.000Z");
      const context = assembleRoomConversationContext({
        currentMessage: current,
        messages: [message("m-1", oversized, "2026-01-01T00:00:01.000Z", "assistant"), current],
      });
      expect(context).toBeNull();
    });

    it("estimates tokens by character class, not by UTF-8 bytes", () => {
      expect(estimateModelTokens("")).toBe(0);
      // English and code merge into ~4-character pieces.
      expect(estimateModelTokens("a".repeat(4_000))).toBe(1_000);
      // CJK is about one token per character — its UTF-8 byte count is three.
      expect(estimateModelTokens("界".repeat(900))).toBe(900);
      expect(estimateModelTokens(`${"a".repeat(400)}${"界".repeat(100)}`)).toBe(200);
      // A run holding a digit — a number, a hash, a UUID — splits into short
      // pieces: three quarters a character, never the quarter a word costs.
      expect(estimateModelTokens("deadbeef0123")).toBe(9);
      expect(estimateModelTokens("123e4567-e89b-12d3-a456-426614174000")).toBe(26);
      expect(estimateModelTokens("feature/cache word")).toBe(5);
      // A cut charges a run as it stands in the cut: letters before its first
      // digit cost a quarter, and the digit re-charges the whole run.
      expect(trimTextToModelTokens("abcdef012345", 3)).toBe("abcdef");
      expect(estimateModelTokens("abcdef")).toBe(2);
      // The cut and the estimate agree, and never split a code point.
      const cut = trimTextToModelTokens(`${"a".repeat(10)}界界`, 4);
      expect(cut).toBe(`${"a".repeat(10)}界`);
      expect(estimateModelTokens(cut)).toBeLessThanOrEqual(4);
      const fitted = fitTextToTokenBudget("word ".repeat(10_000), 500, "[clipped]");
      expect(estimateModelTokens(fitted)).toBeLessThanOrEqual(500);
      expect(fitted.endsWith("[clipped]")).toBe(true);
    });

    it("cuts to a cut's own estimate and gets the same cut back", () => {
      // What the planner stores and what the gateway rebuilds from it.
      const deploy = "Rolled out: the deploy id is abcdefghij0123 on host 7.";
      for (let budget = 0; budget <= estimateModelTokens(deploy); budget += 1) {
        const cut = trimTextToModelTokens(deploy, budget);
        expect(estimateModelTokens(cut)).toBeLessThanOrEqual(budget);
        expect(trimTextToModelTokens(deploy, estimateModelTokens(cut))).toBe(cut);
      }
      let seed = 7;
      const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
      const alphabet = "abcXYZ0189 -_/.{}\n界ü";
      for (let sample = 0; sample < 200; sample += 1) {
        const text = Array.from({ length: 5 + (next() % 60) }, () => alphabet[next() % alphabet.length]).join("");
        for (let budget = 0; budget <= estimateModelTokens(text); budget += 1) {
          const cut = trimTextToModelTokens(text, budget);
          expect(estimateModelTokens(cut)).toBeLessThanOrEqual(budget);
          expect(trimTextToModelTokens(text, estimateModelTokens(cut))).toBe(cut);
          expect(text.startsWith(cut)).toBe(true);
          const tail = trimTextToModelTokensFromEnd(text, budget);
          expect(estimateModelTokens(tail)).toBeLessThanOrEqual(budget);
          expect(trimTextToModelTokensFromEnd(text, estimateModelTokens(tail))).toBe(tail);
          expect(text.endsWith(tail)).toBe(true);
        }
      }
    });

    it("keeps more of the conversation when given a larger budget", () => {
      const budgets = { recent: 30_000 };
      const messages = Array.from({ length: 30 }, (_, index) => message(
        `m-${String(index + 1).padStart(2, "0")}`,
        "detail ".repeat(800),
        `2026-01-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
      ));
      const current = messages.at(-1)!;
      const floor = assembleRoomConversationContext({ messages, currentMessage: current });
      const large = assembleRoomConversationContext({ messages, currentMessage: current, budgets });
      expect(floor!.recent_token_estimate).toBeLessThanOrEqual(ROOM_RECENT_TOKEN_BUDGET);
      expect(large!.recent_messages.length).toBeGreaterThan(floor!.recent_messages.length);
      expect(large!.recent_token_estimate).toBeGreaterThan(ROOM_RECENT_TOKEN_BUDGET * 4);
      expect(large!.recent_token_estimate).toBeLessThanOrEqual(budgets.recent);
    });

  });
});

describe("roomConversationTitle", () => {
  describe("Room conversation titles", () => {
    it("creates a useful zero-cost title from a Chinese first message", () => {
      expect(titleFromMessage("我想要做一个研究 agent memory 的项目。先帮我定义问题"))
        .toBe("研究 agent memory 的项目");
    });

    it("normalizes long first messages without exposing formatting", () => {
      const title = titleFromMessage(`# Please help me investigate ${"memory retrieval ".repeat(8)}`);
      expect(title).not.toContain("#");
      expect(Array.from(title)).toHaveLength(48);
      expect(title.endsWith("…")).toBe(true);
    });

    it("accepts plain model titles and rejects JSON-shaped output", () => {
      expect(cleanGeneratedTitle("标题：个人 Agent 分层记忆\n"))
        .toBe("个人 Agent 分层记忆");
      expect(cleanGeneratedTitle('{"title":"个人 Agent 分层记忆"}')).toBeNull();
    });

    it("never settles on a placeholder title, which the sweep would request — and bill — again every minute", () => {
      expect(cleanGeneratedTitle("New Conversation")).toBeNull();
      expect(cleanGeneratedTitle("\"conversation\"")).toBeNull();
      expect(titleFromMessage("new conversation")).toBe("New topic");
      expect(titleFromMessage("Conversation")).toBe("New topic");
      expect(titleFromMessage("Conversation about memory")).toBe("Conversation about memory");
    });
  });
});
