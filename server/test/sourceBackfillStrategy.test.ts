import { describe, expect, it } from "vitest";
import {
  ARXIV_HISTORY_FLOOR,
  assertSupportedStrategy,
  normalizeStrategy,
  planSegments,
  resolveStrategyBounds,
} from "../src/modules/sources/sourceBackfillStrategy.js";

describe("source backfill history strategy", () => {
  it("resolves all available arXiv history to the connector floor", () => {
    const strategy = resolveStrategyBounds(normalizeStrategy({
      strategy: {
        window_unit: "date_window",
        history_mode: "all_available",
        max_items: 1000,
      },
    }), new Date("2026-07-13T00:00:00.000Z"));

    expect(strategy.from).toBe(ARXIV_HISTORY_FLOOR);
    expect(strategy.to).toBe("2026-07-13T00:00:00.000Z");
    expect(planSegments(strategy).length).toBeGreaterThan(400);
  });

  it("keeps the existing bounded strategy default independent from all history", () => {
    const strategy = resolveStrategyBounds(normalizeStrategy({
      strategy: { window_unit: "date_window", max_items: 100, to: "2026-07-13T00:00:00.000Z" },
    }), new Date("2026-07-13T00:00:00.000Z"));

    expect(strategy.history_mode).toBe("bounded_range");
    expect(strategy.from).toBeNull();
    expect(strategy.to).toBe("2026-07-13T00:00:00.000Z");
    expect(planSegments(strategy)[0]?.from).toBe("2026-06-13T00:00:00.000Z");
  });

  it("rejects all available history for non-arXiv connectors", () => {
    const strategy = resolveStrategyBounds(normalizeStrategy({
      strategy: { window_unit: "date_window", history_mode: "all_available", max_items: 100 },
    }));

    expect(() => assertSupportedStrategy("rss", strategy)).toThrow("History import is not supported by this connector");
  });
});
