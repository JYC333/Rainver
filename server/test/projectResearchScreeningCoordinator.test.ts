import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common";
import { ProjectResearchScreeningCoordinator } from "../src/modules/projectResearch/pipeline/screeningCoordinator";
import { researchState } from "../src/modules/projectResearch/operationProjection";

describe("ProjectResearchScreeningCoordinator", () => {
  it("returns canonical zero counts without querying corpus projections", async () => {
    const query = vi.fn();
    const coordinator = new ProjectResearchScreeningCoordinator(
      { query } as unknown as Queryable,
      { createCheckpoint: vi.fn(), setState: vi.fn(), resumeAfterCheckpoint: vi.fn(), notifyRoom: vi.fn(), failOperation: vi.fn() },
    );

    await expect(coordinator.countRelevantItems("space", "project", [])).resolves.toEqual({
      total: 0,
      relevant: 0,
      maybe: 0,
      excluded: 0,
      missing_full_text: 0,
      evidence_count: 0,
      failed_items: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("requires extraction, processing, and event queues all to drain", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ pending_extraction: "0", pending_processing: "0", pending_events: "0" }] })
      .mockResolvedValueOnce({ rows: [{ pending_extraction: "0", pending_processing: "1", pending_events: "0" }] });
    const coordinator = new ProjectResearchScreeningCoordinator(
      { query } as unknown as Queryable,
      { createCheckpoint: vi.fn(), setState: vi.fn(), resumeAfterCheckpoint: vi.fn(), notifyRoom: vi.fn(), failOperation: vi.fn() },
    );
    const state = researchState({
      source_backfill_plan_ids: ["plan"],
      channel_ids: ["channel"],
    });

    await expect(coordinator.isSourcePipelineDrained("space", state)).resolves.toBe(true);
    await expect(coordinator.isSourcePipelineDrained("space", state)).resolves.toBe(false);
  });
});
