import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common";
import {
  BLOCKING_CHECKPOINT_TYPES,
  SCREENING_AUTO_CONTINUE_CORPUS_LIMIT,
  checkpointBlocks,
  screeningExceedsAutoBudget,
  waiveCheckpointAutomatically,
} from "../src/modules/projectResearch/researchCheckpointPolicy";

// The checkpoint reform's decision table. These assertions are
// the product decision written down: changing one means the reform changed,
// not that a test needs updating.

describe("research checkpoint policy", () => {
  it("keeps a blocking gate only for the external-facing manuscript step", () => {
    expect(checkpointBlocks("manuscript_gate")).toBe(true);
    for (const type of ["idea_review", "integrity_gate", "review_gate", "other"]) {
      expect(checkpointBlocks(type)).toBe(false);
    }
    expect([...BLOCKING_CHECKPOINT_TYPES]).toEqual(["manuscript_gate"]);
  });

  it("the screening budget blocks only when the corpus exceeds the auto-continue limit", () => {
    const under = { relevant: 10, maybe: 5 };
    const at = { relevant: SCREENING_AUTO_CONTINUE_CORPUS_LIMIT, maybe: 0 };
    const over = { relevant: SCREENING_AUTO_CONTINUE_CORPUS_LIMIT, maybe: 1 };

    expect(screeningExceedsAutoBudget(under)).toBe(false);
    expect(screeningExceedsAutoBudget(at)).toBe(false);
    expect(screeningExceedsAutoBudget(over)).toBe(true);
    // `checkpointBlocks` deliberately answers only the unconditional half:
    // an earlier signature that took the counts as an optional context bag
    // failed open when a caller forgot them. The screening site must combine
    // both predicates explicitly.
    expect(checkpointBlocks("screening_gate")).toBe(false);
  });

  it("counts maybe items against the budget, since they reach synthesis too", () => {
    const counts = { relevant: SCREENING_AUTO_CONTINUE_CORPUS_LIMIT - 1, maybe: 5 };
    expect(screeningExceedsAutoBudget(counts)).toBe(true);
  });

  it("records an automatic waiver without attributing it to a person", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await waiveCheckpointAutomatically({ query } as unknown as Queryable, "space", "checkpoint", "why");

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("status='waived'");
    // decided_by_user_id and user_decision are deliberately untouched: an
    // audit must be able to tell that nobody looked at this checkpoint.
    expect(sql).not.toContain("decided_by_user_id");
    expect(sql).not.toContain("user_decision");
    expect(sql).toContain("status='pending'");
    expect(params).toEqual(["checkpoint", "space", "why", expect.any(String)]);
  });
});
