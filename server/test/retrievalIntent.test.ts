import { describe, expect, it } from "vitest";
import { classifyIntent, rankingConfigForIntent } from "../src/modules/retrieval/intent.js";
import { DEFAULT_RANKING_SIGNALS } from "../src/modules/retrieval/ranking.js";

// Deterministic, query-only intent classification. No DB / no provider — intent
// only selects access-neutral ranking knobs, so these guard the routing rules
// and the per-intent config shape.

describe("retrieval intent classification", () => {
  it("classifies time-referencing queries as temporal", () => {
    expect(classifyIntent("what did we ship last week")).toBe("temporal");
    expect(classifyIntent("latest deployment notes")).toBe("temporal"); // "latest" wins over event
    expect(classifyIntent("roadmap for 2026")).toBe("temporal");
    expect(classifyIntent("changes since March")).toBe("temporal");
  });

  it("classifies event-vocabulary queries as event", () => {
    expect(classifyIntent("notes from the architecture meeting")).toBe("event");
    expect(classifyIntent("the production incident writeup")).toBe("event");
    expect(classifyIntent("postmortem action items")).toBe("event");
  });

  it("classifies short / name-like queries as entity", () => {
    expect(classifyIntent("Project Helios")).toBe("entity"); // short
    expect(classifyIntent("RRF")).toBe("entity");
    expect(classifyIntent("Aurora Borealis Initiative report")).toBe("entity"); // capitalized-dominant
  });

  it("falls back to general for descriptive multi-word queries", () => {
    expect(classifyIntent("how do i configure the embedding dimension for a space")).toBe("general");
    expect(classifyIntent("")).toBe("general");
    expect(classifyIntent("   ")).toBe("general");
  });

  it("temporal precedence: a time marker beats event vocabulary", () => {
    // "meeting" is an event word but "yesterday" is an explicit time reference.
    expect(classifyIntent("yesterday's meeting")).toBe("temporal");
  });

  describe("rankingConfigForIntent", () => {
    it("entity leans on name/title signals", () => {
      const cfg = rankingConfigForIntent("entity");
      expect(cfg.nameMatchBoost).toBeGreaterThan(DEFAULT_RANKING_SIGNALS.nameMatchBoost);
      expect(cfg.titlePhraseBoost).toBeGreaterThan(DEFAULT_RANKING_SIGNALS.titlePhraseBoost);
    });

    it("temporal strengthens and shortens recency", () => {
      const cfg = rankingConfigForIntent("temporal");
      expect(cfg.recencyMaxBoost).toBeGreaterThan(DEFAULT_RANKING_SIGNALS.recencyMaxBoost);
      expect(cfg.recencyHalfLifeDays).toBeLessThan(DEFAULT_RANKING_SIGNALS.recencyHalfLifeDays);
    });

    it("event lifts the source tier", () => {
      const cfg = rankingConfigForIntent("event");
      expect(cfg.sourceTier.source).toBeGreaterThan(1);
    });

    it("general is the default config", () => {
      expect(rankingConfigForIntent("general")).toBe(DEFAULT_RANKING_SIGNALS);
    });
  });
});
