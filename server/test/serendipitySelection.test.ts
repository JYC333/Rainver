import { describe, expect, it } from "vitest";
import type { StandbyCandidate } from "../src/modules/informationDigest/serendipityRepository.js";
import { selectSerendipity } from "../src/modules/informationDigest/serendipitySelection.js";

function candidate(input: Partial<StandbyCandidate> & Pick<StandbyCandidate, "pool_id" | "source_item_id" | "target_domain_key">): StandbyCandidate {
  return {
    connection_id: null,
    title: input.source_item_id,
    source_uri: null,
    source_domain: null,
    author: null,
    excerpt: null,
    occurred_at: "2026-08-05T00:00:00Z",
    first_seen_at: "2026-08-05T00:00:00Z",
    domain_key: input.target_domain_key,
    depth: "overview",
    genre: "explainer",
    summary: null,
    topic_candidates: [],
    project_relevance: null,
    project_confidence: null,
    discovery_origin: "weekly_probe",
    source_channel_id: null,
    last_surfaced_at: null,
    ...input,
    stance_target: input.stance_target ?? null,
    stance_target_key: input.stance_target_key ?? null,
    stance_polarity: input.stance_polarity ?? "neutral",
    stance_confidence: input.stance_confidence ?? 0,
  };
}

describe("serendipity selection", () => {
  it("reserves the first slot for a truly distant domain and ranks deterministically", () => {
    const selected = selectSerendipity([
      candidate({ pool_id: "adjacent", source_item_id: "adjacent", target_domain_key: "software_engineering" }),
      candidate({ pool_id: "distant-old", source_item_id: "distant-old", target_domain_key: "history", occurred_at: "2025-01-01T00:00:00Z" }),
      candidate({ pool_id: "distant-new", source_item_id: "distant-new", target_domain_key: "history" }),
    ], {
      coveredDomains: ["artificial_intelligence"],
      depthCounts: { analysis: 5 },
      genreCounts: { paper: 5 },
      stanceByTarget: {},
    }, "warm", 2, new Date("2026-08-06T23:59:59.999Z"));

    expect(selected.map((item) => item.candidate.pool_id)).toEqual(["distant-new", "adjacent"]);
    expect(selected.map((item) => item.quotaSlot)).toEqual(["serendipity:distant:1", "serendipity:adjacent:1"]);
  });

  it("does not let adjacent material consume an unavailable distant slot", () => {
    const selected = selectSerendipity([
      candidate({ pool_id: "adjacent", source_item_id: "adjacent", target_domain_key: "software_engineering" }),
    ], { coveredDomains: ["artificial_intelligence"], depthCounts: {}, genreCounts: {}, stanceByTarget: {} }, "warm", 2,
    new Date("2026-08-06T23:59:59.999Z"));

    expect(selected).toHaveLength(1);
    expect(selected[0]?.quotaSlot).toBe("serendipity:adjacent:1");
  });

  it("uses the second slot for an available same-topic opposing conclusion", () => {
    const selected = selectSerendipity([
      candidate({ pool_id: "distant", source_item_id: "distant", target_domain_key: "history" }),
      candidate({
        pool_id: "opposing", source_item_id: "opposing", target_domain_key: "software_engineering",
        stance_target: "open source models improve safety", stance_target_key: "open source models improve safety",
        stance_polarity: "opposes", stance_confidence: 90,
      }),
      candidate({ pool_id: "adjacent", source_item_id: "adjacent", target_domain_key: "computer_systems" }),
    ], {
      coveredDomains: ["artificial_intelligence"], depthCounts: {}, genreCounts: {},
      stanceByTarget: { "open source models improve safety": "supports" },
    }, "warm", 2, new Date("2026-08-06T23:59:59.999Z"));

    expect(selected.map((item) => item.quotaSlot)).toEqual(["serendipity:distant:1", "serendipity:opposition:1"]);
    expect(selected[1]?.components.stance_opposition).toBe(1);
    expect(selected[1]?.rationale).toContain("opposite conclusion");
  });
});
