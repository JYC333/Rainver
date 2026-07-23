import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common";
import {
  ProjectResearchRetryService,
  type ProjectResearchRetryPorts,
  type RetryOperationRow,
} from "../src/modules/projectResearch/pipeline/retryService";

const identity = { spaceId: "space", userId: "user" };

describe("ProjectResearchRetryService", () => {
  it("routes a failed screening stage back through screening recovery", async () => {
    const operation = failedOperation("screening", {
      source_post_processing_rule_ids: ["rule"],
    });
    const ports = retryPorts(operation);
    const result = await new ProjectResearchRetryService(writerDb(), ports)
      .retry(identity, "project", operation.id);

    expect(result).toEqual({ id: operation.id });
    expect(ports.ensureProcessingBatchSize).toHaveBeenCalledWith(identity, ["rule"]);
    expect(ports.setState).toHaveBeenCalledWith(
      operation,
      expect.objectContaining({ current_stage: "screening", stage_state: "running" }),
    );
    expect(ports.enqueueReconcile).toHaveBeenCalledWith("space", "user", operation.id, "retry_screening");
    expect(ports.queueSynthesis).not.toHaveBeenCalled();
  });

  it("delegates synthesis retry atomically and returns the current operation", async () => {
    const operation = failedOperation("synthesis");
    const ports = retryPorts(operation);
    const result = await new ProjectResearchRetryService(writerDb(), ports)
      .retry(identity, "project", operation.id);

    expect(result).toEqual({ id: operation.id });
    expect(ports.queueSynthesis).toHaveBeenCalledWith({
      spaceId: "space",
      userId: "user",
      projectId: "project",
      operationId: operation.id,
      workflowId: "workflow",
      from: ["failed"],
      reuseExistingRun: false,
    });
    expect(ports.readOperation).toHaveBeenCalledTimes(1);
  });
});

function failedOperation(failedStage: "screening" | "synthesis", extra: Record<string, unknown> = {}): RetryOperationRow {
  return {
    id: "operation",
    space_id: "space",
    project_id: "project",
    status: "failed",
    progress_json: {
      workflow_id: "workflow",
      run_kind: "baseline",
      current_stage: "failed",
      failed_stage: failedStage,
      ...extra,
    },
  };
}

function writerDb(): Queryable {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM projects")) {
        return { rows: [{ id: "project", status: "active", owner_user_id: "user" }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as Queryable;
}

function retryPorts(operation: RetryOperationRow): ProjectResearchRetryPorts<{ id: string }, { id: string }> {
  return {
    operation: vi.fn().mockResolvedValue(operation),
    assertQuestionAligned: vi.fn().mockResolvedValue(undefined),
    activeOperation: vi.fn().mockResolvedValue(null),
    retryMonitorSetup: vi.fn().mockResolvedValue({ id: operation.id }),
    ensureProcessingBatchSize: vi.fn().mockResolvedValue(undefined),
    setState: vi.fn().mockResolvedValue(undefined),
    enqueueReconcile: vi.fn().mockResolvedValue(undefined),
    failOperation: vi.fn().mockResolvedValue(undefined),
    readOperation: vi.fn().mockResolvedValue({ id: operation.id }),
    queueSynthesis: vi.fn().mockResolvedValue({ applied: true, operation: null, state: null }),
    queueComparison: vi.fn().mockResolvedValue({ applied: true, operation: null, state: null }),
    retryBackfill: vi.fn().mockResolvedValue(undefined),
  };
}
