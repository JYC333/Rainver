import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common";
import { ProjectResearchMonitoringCoordinator } from "../src/modules/projectResearch/pipeline/monitoringCoordinator";

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
