import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildSourceSchedulerTasks, reconcileSourceBackfills } from "../src/modules/scheduler/sourceTasks.js";
import { SourceBackfillExecutionService } from "../src/modules/sources/sourceBackfillExecutionService.js";
import type { PgJobQueueRepository } from "../src/modules/jobs/repository.js";

const config = loadConfig({
  SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
});

const fakeQueue = {} as PgJobQueueRepository;

describe("buildSourceSchedulerTasks", () => {
  it("registers each source domain as its own task", () => {
    const names = buildSourceSchedulerTasks(config, { queue: fakeQueue }).map((t) => t.name);
    // Regression guard: these were one task whose steps ran sequentially in a
    // single run(), so a throw in an earlier domain silently starved every
    // later one. They must stay separate so the registry isolates their
    // failures, alerts, and liveness independently.
    expect(names).toEqual([
      "source_extraction_scheduler",
      "source_backfill_reconciler",
      "custom_source_handler_scheduler",
      "source_recipe_scan_scheduler",
      "source_post_processing_scheduler",
      "source_annotation_sweep",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("omits the queue-backed tasks when no job queue is available", () => {
    const names = buildSourceSchedulerTasks(config, { queue: null }).map((t) => t.name);
    expect(names).not.toContain("source_post_processing_scheduler");
    expect(names).not.toContain("source_annotation_sweep");
    expect(names).toContain("source_backfill_reconciler");
  });

  it("registers nothing when the source scheduler is disabled", () => {
    const disabled = loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
      SERVER_SOURCE_EXTRACTION_SCHEDULER_ENABLED: "false",
    });
    expect(buildSourceSchedulerTasks(disabled, { queue: fakeQueue })).toEqual([]);
  });

  it("registers nothing without a database", () => {
    expect(buildSourceSchedulerTasks(loadConfig({}), { queue: fakeQueue })).toEqual([]);
  });

  it("gives every source task the same configured interval", () => {
    const tasks = buildSourceSchedulerTasks(config, { queue: fakeQueue });
    for (const task of tasks) {
      expect(task.intervalSeconds).toBe(config.sourceExtractionSchedulerIntervalSeconds);
      expect(task.runOnStart).toBe(true);
    }
  });
});

describe("reconcileSourceBackfills", () => {
  it("reconciles every plan past one that keeps failing, and moves that one to the back", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        if (sql.includes("SELECT id,space_id FROM source_backfill_plans")) {
          return { rows: [{ id: "plan-stuck", space_id: "space-1" }, { id: "plan-next", space_id: "space-1" }] };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const reconciled: string[] = [];
    const spy = vi.spyOn(SourceBackfillExecutionService.prototype, "reconcile")
      .mockImplementation(async (_spaceId: string, planId: string) => {
        if (planId === "plan-stuck") throw new Error("Source channel not found for backfill plan");
        reconciled.push(planId);
        return undefined as never;
      });
    try {
      await expect(reconcileSourceBackfills(db as never)).rejects.toThrow(/Source channel not found/);
    } finally {
      spy.mockRestore();
    }
    expect(reconciled).toEqual(["plan-next"]);
    // Its failed reconcile rolled back its own bump; without this it would
    // lead the `ORDER BY updated_at` page on every pass.
    expect(queries.some(({ sql, params }) =>
      /SET updated_at=now\(\)/.test(sql) && !sql.includes("status='approved'") && params[0] === "plan-stuck")).toBe(true);
  });
});
