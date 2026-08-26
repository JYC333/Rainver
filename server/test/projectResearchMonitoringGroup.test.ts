import { describe, expect, it, vi } from "vitest";
import { parseCrossrefIntegrityEvents } from "../src/modules/projectResearch/integrityMonitorService.js";
import { parseMonitorComparisons } from "../src/modules/projectResearch/monitorComparisonService.js";
import { laterPublicationWatermark, publicationWindowStart } from "../src/modules/projectResearch/monitoringWindow.js";
import { ProjectResearchMonitoringCoordinator } from "../src/modules/projectResearch/pipeline/monitoringCoordinator.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { computeNextCheckAt } from "../src/modules/sources/sourceScanCadence.js";

describe("projectResearchMonitoring", () => {
  describe("Project Research monitoring contracts", () => {
    it("returns every valid comparison that matches an expected paper", () => {
      expect(parseMonitorComparisons({ comparisons: [
        { source_item_id: "paper-1", stance: "supports", detail: "Replicates the primary effect.", affected_sections: ["understanding"] },
        { source_item_id: "paper-2", stance: "contradicts", detail: "The effect disappears under the preregistered analysis.", affected_sections: ["understanding", "questions"] },
      ] }, ["paper-1", "paper-2"])).toHaveLength(2);
    });

    it("never throws for content problems — it silently drops what it can't use instead of discarding the whole batch", () => {
      // A model occasionally drops, duplicates, or invents a source_item_id.
      // The caller (ProjectResearchMonitoringCoordinator) decides what to do
      // about a paper that got no valid comparison — this function's job is
      // only to extract whatever's usable, never to fail the batch over it.
      expect(parseMonitorComparisons({ comparisons: [
        { source_item_id: "paper-1", stance: "supports", detail: "Replicates the effect.", affected_sections: [] },
        { source_item_id: "unexpected-id", stance: "supports", detail: "Fabricated, not a real requested paper.", affected_sections: [] },
        { source_item_id: "paper-1", stance: "contradicts", detail: "Duplicate id in the same response.", affected_sections: [] },
      ] }, ["paper-1", "paper-2"])).toEqual([
        { source_item_id: "paper-1", stance: "supports", detail: "Replicates the effect.", affected_sections: [] },
      ]);
      expect(parseMonitorComparisons({ comparisons: "not an array" }, ["paper-1"])).toEqual([]);
      expect(parseMonitorComparisons(null, ["paper-1"])).toEqual([]);
    });

    it("ignores source_item_id entirely for a solo retry — there is only one candidate, so nothing to disambiguate", () => {
      // A one-paper request is always a retry for a single, already-known
      // paper (see ProjectResearchMonitoringCoordinator's failed pool).
      // Requiring the model to also echo back the right id only ever cost the
      // retry over a relabeling it didn't need to get right.
      expect(parseMonitorComparisons({ comparisons: [
        { source_item_id: "some-other-id-the-model-made-up", stance: "supports", detail: "Replicates the effect.", affected_sections: ["understanding"] },
      ] }, ["paper-1"])).toEqual([
        { source_item_id: "paper-1", stance: "supports", detail: "Replicates the effect.", affected_sections: ["understanding"] },
      ]);
      expect(parseMonitorComparisons({ comparisons: [
        { stance: "supports", detail: "No source_item_id at all.", affected_sections: [] },
      ] }, ["paper-1"])).toEqual([
        { source_item_id: "paper-1", stance: "supports", detail: "No source_item_id at all.", affected_sections: [] },
      ]);
      // Structurally invalid content still yields no match — there's nothing
      // usable to attach to the one paper.
      expect(parseMonitorComparisons({ comparisons: [
        { source_item_id: "paper-1", stance: "maybe", detail: "Invalid stance.", affected_sections: [] },
      ] }, ["paper-1"])).toEqual([]);
    });

    it("normalizes Crossref Retraction Watch update relations into stable alerts", () => {
      const alerts = parseCrossrefIntegrityEvents("https://doi.org/10.1000/Original", "source-1", {
        message: {
          "updated-by": [
            { DOI: "10.1000/retraction", type: "retraction", source: "retraction-watch" },
            { DOI: "10.1000/correction", type: "expression-of-concern", source: "publisher" },
          ],
        },
      });
      expect(alerts).toMatchObject([
        { doi: "10.1000/original", source_item_id: "source-1", event_type: "retraction", source: "retraction-watch", notice_doi: "10.1000/retraction" },
        { doi: "10.1000/original", event_type: "expression_of_concern", source: "publisher", notice_doi: "10.1000/correction" },
      ]);
      expect(alerts[0]?.event_key).toHaveLength(64);
    });
  });
});

describe("projectResearchMonitoringCoordinator", () => {
  describe("ProjectResearchMonitoringCoordinator", () => {
    it("returns the existing durable scan summary when an idempotent insert conflicts", async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: "summary-existing" }], rowCount: 1 });
      const coordinator = new ProjectResearchMonitoringCoordinator(
        { query } as unknown as Queryable,
        undefined,
        {
          projectWriterActor: vi.fn(),
          screeningProgressFor: vi.fn(),
          hasResearchQuestionDrift: vi.fn(),
          appendPendingIncrementalItems: vi.fn(),
          reconcileOperation: vi.fn(),
          startEmptyScanPass: vi.fn(),
          activeHistoricalBackfill: vi.fn(),
          backfillPlanForItems: vi.fn(),
          operationByIdempotency: vi.fn(),
          activeIncremental: vi.fn(),
          createIncrementalOperation: vi.fn(),
          operation: vi.fn(),
          failOperation: vi.fn(),
          setWorkflowMonitoring: vi.fn(),
          reconcileCompletedRun: vi.fn(),
          enqueueIntegrityMonitor: vi.fn(),
        },
      );

      await expect(coordinator.insertScanSummary({
        spaceId: "space",
        projectId: "project",
        workflowId: "workflow",
        operationId: "operation",
        scanKey: "operation:operation",
        scanWindowStart: null,
        scanWindowEnd: "2026-01-02T00:00:00.000Z",
        scannedAt: "2026-01-02T00:00:00.000Z",
        newItemCount: 0,
        relevantCount: 0,
        maybeCount: 0,
        excludedCount: 0,
      })).resolves.toBe("summary-existing");
      expect(query).toHaveBeenCalledTimes(2);
    });
  });
});

describe("projectResearchMonitoringWindow", () => {
  describe("Project Research monitoring boundaries", () => {
    it("uses publication time for the overlap window and never moves its watermark backwards", () => {
      expect(publicationWindowStart("2026-07-30T12:00:00.000Z", 48))
        .toBe("2026-07-28T12:00:00.000Z");
      expect(laterPublicationWatermark(
        "2026-07-30T12:00:00.000Z",
        "2026-07-29T12:00:00.000Z",
      )).toBe("2026-07-30T12:00:00.000Z");
    });

    it("schedules monitoring at the next cadence boundary instead of immediately", () => {
      expect(computeNextCheckAt(
        "daily",
        "2026-07-30T22:56:31.000Z",
        { scheduleRule: { frequency: "daily", hour: 3, minute: 0 } },
      )).toBe("2026-07-31T03:00:00.000Z");
    });
  });
});
