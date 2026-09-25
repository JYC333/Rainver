import { describe, expect, it } from "vitest";
import { RoomDiscussionDetailSchema, RoomDiscussionNoticeSchema } from "../src/roomDiscussions.js";
import { SubscriptionQuotaPolicyUpdateSchema } from "../src/subscriptionQuota.js";

describe("subscription quota contracts", () => {
  it("keeps the warning line at or below the reserve line", () => {
    expect(SubscriptionQuotaPolicyUpdateSchema.safeParse({ warn_pct: 70, reserve_pct: 85 }).success).toBe(true);
    expect(SubscriptionQuotaPolicyUpdateSchema.safeParse({ warn_pct: 90, reserve_pct: 85 }).success).toBe(false);
    expect(SubscriptionQuotaPolicyUpdateSchema.safeParse({ warn_pct: 0, reserve_pct: 85 }).success).toBe(false);
  });

  it("reports a discussion's cost one line per funding source, and what it holds", () => {
    const detail = {
      discussion: {
        id: "d-1", room_id: "r-1", session_id: "s-1", kind: "explicit", shape: "open", status: "active",
        stop_reason: null, topic: "t", opened_by_user_id: "u-1", origin_message_id: "m-1", participant_agent_ids: [],
        round_cap: 3, rounds_used: 1, round_base: 0, turns_used: 0, spend_cap_usd: 2, spend_usd: 0,
        held_mentions: [], conclusion_message_id: null, quota_override_by_user_id: null,
        created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z",
      },
      waves: [],
      usage: {
        priced_usd: 0.42,
        subscription: [{
          account_label: "Claude Code · Server",
          tokens: 1200,
          window: { kind: "session", utilization: 87, resets_at: "2026-09-24T19:40:00.000Z" },
        }],
      },
      quota_hold: { account_label: "Claude Code · Server", window: "session", resets_at: null, run_ids: ["run-1"], can_continue: false },
    };
    expect(RoomDiscussionDetailSchema.parse(detail).usage.subscription[0]!.tokens).toBe(1200);
    // The single token total it replaced is not part of the contract.
    expect(RoomDiscussionDetailSchema.safeParse({ ...detail, usage: { ...detail.usage, tokens: 3 } }).success).toBe(false);
  });

  it("carries a quota hold's reset time on its notice", () => {
    expect(RoomDiscussionNoticeSchema.parse({
      discussion_id: "d-1", kind: "quota_hold", reason: "waiting", agent_ids: [], resets_at: "2026-09-24T19:40:00.000Z",
    }).kind).toBe("quota_hold");
  });
});
