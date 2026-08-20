import { describe, expect, it } from "vitest";
import {
  ROOM_RECENT_TOKEN_BUDGET,
  ROOM_SUMMARY_SOURCE_TOKEN_BUDGET,
  assembleRoomConversationContext,
  estimateRoomSummaryTokens,
  selectRoomCompactionBatch,
} from "../src/modules/rooms/conversationContext";
import { parseSummary } from "../src/modules/rooms/conversationSummaryService";
import type { MessageOut } from "@agent-space/protocol" with { "resolution-mode": "import" };

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
  it("keeps summary coverage and recent messages disjoint", () => {
    const summary = {
      id: "summary-1",
      version: 1,
      summary_text: "Earlier decisions are preserved.",
      covered_through_message_id: "m-2",
      covered_through_created_at: "2026-01-01T00:00:02.000Z",
    };
    const current = message("m-4", "current request", "2026-01-01T00:00:04.000Z");
    const context = assembleRoomConversationContext({
      summary,
      currentMessage: current,
      messages: [
        message("m-1", "old", "2026-01-01T00:00:01.000Z"),
        message("m-2", "covered", "2026-01-01T00:00:02.000Z"),
        message("m-3", "recent", "2026-01-01T00:00:03.000Z", "assistant"),
        current,
      ],
    });
    expect(context?.no_overlap).toBe(true);
    expect(context?.message_refs).toEqual(["m-3"]);
    expect(context?.trace.covered_through_message_id).toBe("m-2");
  });

  it("omits an oversized prior turn instead of exceeding the raw budget", () => {
    const oversized = "x".repeat(ROOM_RECENT_TOKEN_BUDGET * 8);
    const current = message("m-2", "trigger", "2026-01-01T00:00:02.000Z");
    const context = assembleRoomConversationContext({
      currentMessage: current,
      messages: [message("m-1", oversized, "2026-01-01T00:00:01.000Z", "assistant"), current],
    });
    expect(context).toBeNull();
  });

  it("advances compaction through an exclusive cursor", () => {
    const messages = Array.from({ length: 20 }, (_, index) => message(
      `m-${index + 1}`,
      `turn ${index + 1} ${"detail ".repeat(300)}`,
      `2026-01-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
    ));
    const batch = selectRoomCompactionBatch({
      messages,
      summary: {
        covered_through_message_id: "m-2",
        covered_through_created_at: "2026-01-01T00:00:02.000Z",
      },
    });
    expect(batch.should_compact).toBe(true);
    expect(batch.source_messages[0]?.id).toBe("m-3");
    expect(batch.covered_through_message?.id).toBe(batch.source_messages.at(-1)?.id);
    expect(batch.retained_recent_messages.at(-1)?.id).toBe("m-20");
  });

  it("bounds each summary source batch without skipping the oldest cursor", () => {
    const messages = Array.from({ length: 40 }, (_, index) => message(
      `m-${index + 1}`,
      "detail ".repeat(500),
      `2026-01-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
    ));
    const batch = selectRoomCompactionBatch({ messages });
    expect(batch.source_messages.length).toBeGreaterThan(0);
    expect(batch.source_token_estimate).toBeGreaterThan(0);
    expect(batch.source_token_estimate).toBeGreaterThanOrEqual(
      estimateRoomSummaryTokens(batch.source_messages[0]!.content),
    );
    expect(batch.source_token_estimate).toBeLessThanOrEqual(ROOM_SUMMARY_SOURCE_TOKEN_BUDGET);
    expect(batch.source_messages.at(-1)?.id).toBe(batch.covered_through_message?.id);
    expect(batch.source_messages.at(-1)?.id).not.toBe("m-40");
  });

  it("accepts only the versioned summary response shape", () => {
    expect(parseSummary('{"summary":"Keep this decision."}')).toBe("Keep this decision.");
    expect(parseSummary('{"summary":"ok","extra":"leak"}')).toBeNull();
    expect(parseSummary("provider refusal")).toBeNull();
    expect(parseSummary("```json\n{\"summary\":\"fenced\"}\n```"))
      .toBe("fenced");
  });
});
