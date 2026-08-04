import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  buildStatusBody,
  databaseUnavailableStatusBody,
  worstStatus,
} from "../src/modules/system/statusService";
import type { ScheduledTaskStatus } from "../src/modules/scheduler/registry";
import type { BackgroundServicesStatusSource } from "../src/modules/scheduler/runtimeStatus";

const config = loadConfig({
  SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
});

function task(overrides: Partial<ScheduledTaskStatus> = {}): ScheduledTaskStatus {
  return {
    name: "a_task",
    interval_seconds: 60,
    timeout_seconds: 600,
    state: "idle",
    health: "ok",
    last_started_at: "2026-07-26T00:00:00.000Z",
    last_success_at: "2026-07-26T00:00:00.000Z",
    last_failure_at: null,
    last_error: null,
    consecutive_failures: 0,
    timeouts_total: 0,
    seconds_since_completion: 1,
    ...overrides,
  };
}

function source(overrides: Partial<BackgroundServicesStatusSource> = {}): BackgroundServicesStatusSource {
  return {
    schedulerStatuses: () => [task()],
    workerId: () => "ts-job-worker:abc",
    queueDepth: async () => ({ pending: 0, running: 1 }),
    ...overrides,
  };
}

function component(body: Awaited<ReturnType<typeof buildStatusBody>>, name: string) {
  const found = body.components.find((c) => c.name === name);
  if (!found) throw new Error(`missing component ${name}`);
  return found;
}

describe("worstStatus", () => {
  it("takes the worst component status", () => {
    expect(worstStatus(["ok", "ok"])).toBe("ok");
    expect(worstStatus(["ok", "degraded"])).toBe("degraded");
    expect(worstStatus(["degraded", "error", "ok"])).toBe("error");
  });
});

describe("databaseUnavailableStatusBody", () => {
  it("reports only the database and no operational internals", () => {
    const body = databaseUnavailableStatusBody(config);
    expect(body.overall).toBe("error");
    expect(body.components).toHaveLength(1);
    expect(body.components[0]).toMatchObject({ name: "database", status: "error" });
    expect(body.scheduler_tasks).toEqual([]);
  });
});

describe("buildStatusBody", () => {
  it("is ok when database, scheduler, worker, and queue are all healthy", async () => {
    const body = await buildStatusBody(config, { databaseOk: true, source: source() });
    expect(body.overall).toBe("ok");
    expect(component(body, "database").status).toBe("ok");
    expect(component(body, "scheduler").status).toBe("ok");
    expect(component(body, "jobs_worker").detail).toBe("ts-job-worker:abc");
    expect(component(body, "jobs_queue").detail).toBe("0 pending, 1 running");
    expect(body.scheduler_tasks).toHaveLength(1);
  });

  it("surfaces a stalled task by name and fails the overall status", async () => {
    const body = await buildStatusBody(config, {
      databaseOk: true,
      source: source({
        schedulerStatuses: () => [
          task({ name: "source_extraction_scheduler", health: "stalled", state: "running" }),
          task({ name: "backup_scheduler" }),
        ],
      }),
    });
    expect(body.overall).toBe("error");
    expect(component(body, "scheduler")).toMatchObject({
      status: "error",
      detail: "Stalled: source_extraction_scheduler",
    });
  });

  it("degrades rather than fails when a task is only failing", async () => {
    const body = await buildStatusBody(config, {
      databaseOk: true,
      source: source({
        schedulerStatuses: () => [task({ name: "automation_scheduler", health: "failing" })],
      }),
    });
    expect(body.overall).toBe("degraded");
    expect(component(body, "scheduler").detail).toBe("Failing: automation_scheduler");
  });

  it("reports a missing worker as an error only when jobs are waiting", async () => {
    const idle = await buildStatusBody(config, {
      databaseOk: true,
      source: source({ workerId: () => null, queueDepth: async () => ({ pending: 0, running: 0 }) }),
    });
    expect(component(idle, "jobs_worker").status).toBe("degraded");
    expect(component(idle, "jobs_queue").status).toBe("ok");

    const backedUp = await buildStatusBody(config, {
      databaseOk: true,
      source: source({ workerId: () => null, queueDepth: async () => ({ pending: 4, running: 0 }) }),
    });
    expect(component(backedUp, "jobs_worker")).toMatchObject({
      status: "error",
      detail: "No jobs worker running while 4 job(s) are pending",
    });
    expect(component(backedUp, "jobs_queue").status).toBe("error");
    expect(backedUp.overall).toBe("error");
  });

  it("fails when background services are not running at all", async () => {
    const body = await buildStatusBody(config, { databaseOk: true, source: null });
    expect(component(body, "scheduler")).toMatchObject({
      status: "error",
      detail: "Background services are not running",
    });
    expect(body.overall).toBe("error");
  });

  it("degrades the queue component when depth cannot be read", async () => {
    const body = await buildStatusBody(config, {
      databaseOk: true,
      source: source({
        queueDepth: async () => {
          throw new Error("connection reset");
        },
      }),
    });
    expect(component(body, "jobs_queue")).toMatchObject({
      status: "degraded",
      detail: "Queue depth unavailable",
    });
    expect(body.overall).toBe("degraded");
  });
});
