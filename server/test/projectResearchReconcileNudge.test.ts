import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { loadConfig } from "../src/config.js";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator.js";

const CONFIG = loadConfig({});

function fakeDb() {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const query = vi.fn(async <Row>(text: string, values?: unknown[]) => {
    queries.push({ text, values });
    if (text.includes("INSERT INTO jobs")) {
      return {
        rows: [{ id: "job-1", job_type: "project_research_execution_nudge", status: "pending" } as Row],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 } as { rows: Row[]; rowCount: number };
  });
  return { db: { query } as unknown as Queryable, queries };
}

describe("Project Research event hooks", () => {
  it("turns post-processing recovery start and finish into reconcile nudges", async () => {
    const { db, queries } = fakeDb();
    const orchestrator = new ProjectResearchOrchestrator(db, CONFIG);

    await orchestrator.onPostProcessingRecoveryStarted({ spaceId: "space-1", operationId: "operation-1" });
    await orchestrator.onPostProcessingRecoveryFinished({
      spaceId: "space-1",
      operationId: "operation-1",
    });

    expect(queries).toHaveLength(2);
    expect(queries.every(({ text }) => text.includes("INSERT INTO jobs"))).toBe(true);
    expect(queries.map(({ values }) => JSON.parse(String(values?.[7])))).toEqual([
      expect.objectContaining({ operation_id: "operation-1", reason: "post_processing_recovery_started" }),
      expect.objectContaining({ operation_id: "operation-1", reason: "post_processing_recovery_finished" }),
    ]);
    expect(queries.some(({ text }) => /UPDATE project_operations|UPDATE project_research_workflows/.test(text))).toBe(false);
  });

  it("nudges the reconciler after post-processing succeeds", async () => {
    const { db, queries } = fakeDb();
    const orchestrator = new ProjectResearchOrchestrator(db, CONFIG);

    await orchestrator.onPostProcessingSucceeded({
      spaceId: "space-1",
      projectId: "project-1",
      sourcePostProcessingRunId: "post-run-1",
      userId: "user-1",
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("INSERT INTO jobs");
    expect(JSON.parse(String(queries[0]!.values?.[7]))).toEqual(expect.objectContaining({
      source_post_processing_run_id: "post-run-1",
      reason: "post_processing_succeeded",
    }));
    expect(queries.some(({ text }) => /UPDATE project_operations|UPDATE project_research_workflows/.test(text))).toBe(false);
  });
});
