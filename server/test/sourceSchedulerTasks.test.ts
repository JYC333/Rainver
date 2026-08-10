import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { buildSourceSchedulerTasks } from "../src/modules/scheduler/sourceTasks";
import type { PgJobQueueRepository } from "../src/modules/jobs/repository";

const config = loadConfig({
  SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
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
      SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
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
