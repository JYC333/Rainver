import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  DuplicateJobHandlerError,
  JobDeferredError,
  JobHandlerRegistry,
  UnknownJobTypeError,
} from "../src/modules/jobs/handlerRegistry.js";
import { JobWorker } from "../src/modules/jobs/worker.js";
import { PgJobQueueRepository, type JobRecord } from "../src/modules/jobs/repository.js";
import { waitForJobWake, wakeJobWorkers } from "../src/modules/jobs/wakeSignal.js";
import { jobEventToOut, jobNotFoundForSpace, jobToOut } from "../src/modules/jobs/routes.js";
import { SchedulerRegistry, startSchedulerRegistry } from "../src/modules/scheduler/registry.js";
import type { QueryResult, Queryable } from "../src/modules/routeUtils/common.js";
import { AutomationService } from "../src/modules/automations/service.js";
import type { AutomationRow } from "../src/modules/automations/repository.js";
import { registerRetrievalMaintenanceAutomationTarget } from "../src/modules/retrieval/automationTarget.js";
import { registerContextOpsReviewCycleAutomationTarget } from "../src/modules/contextOps/automationTarget.js";
import {
  isValidTimezone,
  PgDailyReportSettingsRepository,
  type DailyReportSettingRow,
} from "../src/modules/dailyReports/repository.js";
import { buildDailyReportJobPayload } from "../src/modules/dailyReports/scheduler.js";
import { loadConfig } from "../src/config.js";
import { enforce } from "../src/modules/policy/index.js";

const maintenanceScanMock = vi.hoisted(() => vi.fn());
const dbPoolMock = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../src/db/pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/pool.js")>();
  return {
    ...actual,
    getDbPool: vi.fn((databaseUrl: string) => dbPoolMock.current ?? actual.getDbPool(databaseUrl)),
  };
});

vi.mock("../src/modules/retrieval/maintenance/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/retrieval/maintenance/service.js")>();
  return {
    ...actual,
    RetrievalMaintenanceService: vi.fn().mockImplementation(() => ({
      scan: maintenanceScanMock,
    })),
  };
});

vi.mock("../src/modules/policy/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/policy/index.js")>();
  return {
    ...actual,
    enforce: vi.fn(),
  };
});

vi.mock("../src/modules/policy/actionRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/policy/actionRegistry.js")>();
  const action = (
    name: string,
    resourceType: string,
    risk: "low" | "medium" | "high" = "medium",
  ) => ({
    action: name,
    resource_type: resourceType,
    default_risk_level: risk,
    default_decision: "allow",
    audit_required: false,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "test",
    description: "test action",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  });
  return {
    ...actual,
    loadActionRegistry: vi.fn(async () =>
      new Map([
        ["runtime.execute", action("runtime.execute", "run")],
        ["runtime.use_credential", action("runtime.use_credential", "credential", "high")],
        ["context.inject_memory", action("context.inject_memory", "memory")],
        ["context.render_for_runtime", action("context.render_for_runtime", "context", "low")],
      ]),
    ),
  };
});

// A fake clock left installed by a failing test would stall every file
// that runs after this one in the same worker.
afterEach(() => {
  vi.useRealTimers();
});

describe("JobHandlerRegistry", () => {
  it("registers handlers and fails fast on duplicates", () => {
    const registry = new JobHandlerRegistry();
    registry.register("memory_consolidation", async () => ({ ok: true }));
    expect(() =>
      registry.register("memory_consolidation", async () => ({ ok: false })),
    ).toThrow(DuplicateJobHandlerError);
  });

  it("dispatch raises UnknownJobTypeError for unregistered types", async () => {
    const registry = new JobHandlerRegistry();
    await expect(
      registry.dispatch({
        job_id: "j1",
        space_id: "s1",
        user_id: "u1",
        job_type: "missing",
        attempts: 1,
        max_attempts: 3,
        worker_id: "w1",
        payload: {},
      }),
    ).rejects.toThrow(UnknownJobTypeError);
  });
});

describe("JobWorker", () => {
  it("alerts when stuck-job reclaim exhausts max attempts", async () => {
    const alerts = { emit: vi.fn(async () => undefined) };
    const queue = {
      async reclaimStuckJobs() {
        return {
          reclaimed_count: 2,
          exhausted_jobs: [{
            id: "job-stuck",
            space_id: "space-1",
            user_id: "user-1",
            job_type: "agent_run",
            attempts: 3,
            max_attempts: 3,
          }],
        };
      },
    };
    const worker = new JobWorker(
      queue as never,
      new JobHandlerRegistry(),
      "worker-1",
      [],
      undefined,
      alerts,
    );
    await expect(worker.reclaimStuckJobs()).resolves.toBe(2);
    expect(alerts.emit).toHaveBeenCalledTimes(1);
    expect(alerts.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "job_exhausted",
      dedupeKey: "job_exhausted:job-stuck",
    }));
  });

  it("fails unknown job types without starting the job", async () => {
    const events: string[] = [];
    const queue = {
      async claimNext() {
        return makeJob({ job_type: "orphan_job" });
      },
      async startJob(jobId: string) {
        events.push(`start:${jobId}`);
        return true;
      },
      async completeJob() {
        return true;
      },
      async failJob(jobId: string, error: string) {
        events.push(`fail:${jobId}:${error}`);
        return "failed";
      },
      async cancelJob() {
        return true;
      },
      async touchHeartbeat() {
        return true;
      },
      async appendJobEvent(input: { message: string }) {
        events.push(`event:${input.message}`);
        return { id: "e1", job_id: "job-1", event_type: "error", message: input.message };
      },
      async reclaimStuckJobs() {
        return { reclaimed_count: 0 };
      },
    };
    const registry = new JobHandlerRegistry();
    const alerts = { emit: vi.fn(async () => undefined) };
    const worker = new JobWorker(queue as never, registry, "worker-1", [], undefined, alerts);
    const result = await worker.processOne();
    expect(result.status).toBe("failed");
    expect(events.some((event) => event.startsWith("fail:job-1"))).toBe(true);
    expect(events.some((event) => event.startsWith("start:"))).toBe(false);
    expect(alerts.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "job_exhausted",
      dedupeKey: "job_exhausted:job-1",
      spaceId: "space-1",
    }));
  });

  it("does not dispatch a handler when startJob loses ownership", async () => {
    const events: string[] = [];
    const queue = {
      async claimNext() {
        return makeJob({ job_type: "agent_run" });
      },
      async startJob(jobId: string) {
        events.push(`start:${jobId}`);
        return false;
      },
      async completeJob() {
        events.push("complete");
        return true;
      },
      async failJob() {
        events.push("fail");
        return "failed";
      },
      async cancelJob() {
        return true;
      },
      async touchHeartbeat() {
        return true;
      },
      async appendJobEvent(input: { event_type: string; message: string }) {
        events.push(`event:${input.event_type}:${input.message}`);
        return { id: "e1", job_id: "job-1", event_type: input.event_type, message: input.message };
      },
      async reclaimStuckJobs() {
        return { reclaimed_count: 0 };
      },
    };
    const handler = vi.fn(async () => ({ ok: true }));
    const registry = new JobHandlerRegistry();
    registry.register("agent_run", handler);
    const worker = new JobWorker(queue as never, registry, "worker-1", ["agent_run"]);

    await expect(worker.processOne()).resolves.toEqual({
      status: "failed",
      job_id: "job-1",
      error: "Job start skipped because ownership or status changed",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(events).toEqual([
      "start:job-1",
      "event:warning:Job start skipped because ownership or status changed",
    ]);
  });

  it("reports completion loss without overwriting the job state", async () => {
    const events: string[] = [];
    const queue = {
      async claimNext() {
        return makeJob({ job_type: "agent_run" });
      },
      async startJob(jobId: string) {
        events.push(`start:${jobId}`);
        return true;
      },
      async completeJob(jobId: string) {
        events.push(`complete:${jobId}`);
        return false;
      },
      async failJob() {
        events.push("fail");
        return "failed";
      },
      async cancelJob() {
        return true;
      },
      async touchHeartbeat() {
        return true;
      },
      async appendJobEvent(input: { event_type: string; message: string }) {
        events.push(`event:${input.event_type}:${input.message}`);
        return { id: "e1", job_id: "job-1", event_type: input.event_type, message: input.message };
      },
      async reclaimStuckJobs() {
        return { reclaimed_count: 0 };
      },
    };
    const registry = new JobHandlerRegistry();
    registry.register("agent_run", async () => ({ ok: true }));
    const worker = new JobWorker(queue as never, registry, "worker-1", ["agent_run"]);

    await expect(worker.processOne()).resolves.toEqual({
      status: "failed",
      job_id: "job-1",
      error: "Job completion skipped because ownership or status changed",
    });
    expect(events).toEqual([
      "start:job-1",
      "event:status_change:Job started by server worker",
      "complete:job-1",
      "event:warning:Job completion skipped because ownership or status changed",
    ]);
  });

  it("defers lock-bound work without burning retries in a tight loop", async () => {
    const deferred: Date[] = [];
    const queue = {
      async claimNext() {
        return makeJob({ job_type: "authorization_request_reconcile", attempts: 1 });
      },
      async startJob() {
        return true;
      },
      async completeJob() {
        return true;
      },
      async failJob() {
        throw new Error("deferred jobs must not use immediate failure retry");
      },
      async deferJob(
        _jobId: string,
        _error: string,
        _workerId: string,
        scheduledAt: Date,
      ) {
        deferred.push(scheduledAt);
        return true;
      },
      async touchHeartbeat() {
        return true;
      },
      async appendJobEvent() {
        return {};
      },
    };
    const registry = new JobHandlerRegistry();
    registry.register("authorization_request_reconcile", async () => {
      throw new JobDeferredError("execution lock remains held", 2_000);
    });
    const before = Date.now();
    const worker = new JobWorker(
      queue as never,
      registry,
      "worker-1",
      ["authorization_request_reconcile"],
    );

    await expect(worker.processOne()).resolves.toEqual({
      status: "deferred",
      job_id: "job-1",
    });
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.getTime()).toBeGreaterThanOrEqual(before + 2_000);
  });
});

describe("PgJobQueueRepository", () => {
  it("casts failJob terminal timestamps inside CASE expressions", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db: Queryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
        calls.push({ sql, params });
        return { rows: [{ status: "failed" } as Row], rowCount: 1 };
      },
    };

    const status = await new PgJobQueueRepository(db).failJob(
      "job-1",
      "boom",
      "worker-1",
      new Date("2026-07-08T02:14:22.455Z"),
    );

    expect(status).toBe("failed");
    expect(calls[0]?.sql).toContain("completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE $3::timestamptz END");
    expect(calls[0]?.sql).toContain("updated_at = $3::timestamptz");
  });

  it("moves deferred jobs back to pending at a future scheduled time", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db: Queryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    const scheduledAt = new Date("2026-07-26T12:00:02.000Z");
    await expect(new PgJobQueueRepository(db).deferJob(
      "job-1",
      "lock held",
      "worker-1",
      scheduledAt,
      new Date("2026-07-26T12:00:00.000Z"),
    )).resolves.toBe(true);
    expect(calls[0]?.sql).toContain("scheduled_at = $3");
    expect(calls[0]?.sql).toContain("attempts = GREATEST(0, attempts - 1)");
    expect(calls[0]?.sql).not.toContain("attempts < max_attempts");
    expect(calls[0]?.params[2]).toBe(scheduledAt.toISOString());
  });

  it("wakes a waiting worker loop when the enqueued job is claimable now", async () => {
    const db: Queryable = {
      async query<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
        return { rows: [{ id: "job-1" } as Row], rowCount: 1 };
      },
    };
    const wake = waitForJobWake(1_000);

    await new PgJobQueueRepository(db).enqueue({
      job_type: "agent_run",
      payload: { run_id: "run-1" },
      space_id: "space-1",
      user_id: null,
    });

    await expect(wake).resolves.toBe("signalled");
  });

  it("does not wake a worker for a job scheduled in the future", async () => {
    const db: Queryable = {
      async query<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
        return { rows: [{ id: "job-1" } as Row], rowCount: 1 };
      },
    };
    const wake = waitForJobWake(20);

    await new PgJobQueueRepository(db).enqueue({
      job_type: "agent_run",
      payload: { run_id: "run-1" },
      space_id: "space-1",
      user_id: null,
      scheduled_at: new Date(Date.now() + 60_000),
    });

    await expect(wake).resolves.toBe("timeout");
  });
});

describe("job wake signal", () => {
  it("times out on its own when no enqueue arrives", async () => {
    await expect(waitForJobWake(5)).resolves.toBe("timeout");
  });

  it("wakes every waiting loop and stops holding them afterwards", async () => {
    const first = waitForJobWake(1_000);
    const second = waitForJobWake(1_000);

    wakeJobWorkers();

    expect(await first).toBe("signalled");
    expect(await second).toBe("signalled");
    // A later wake with nobody waiting must be a no-op, not a queued signal
    // that the next waiter picks up as a phantom job.
    wakeJobWorkers();
    await expect(waitForJobWake(5)).resolves.toBe("timeout");
  });
});

describe("SchedulerRegistry", () => {
  it("reports task exceptions to the operational alert hook", async () => {
    const onTaskError = vi.fn(async () => undefined);
    const registry = new SchedulerRegistry({ warn: vi.fn(), error: vi.fn() }, onTaskError);
    registry.register({
      name: "broken-task",
      intervalSeconds: 60,
      run: async () => { throw new Error("scheduler boom"); },
      awaitRunOnStart: true,
    });
    await registry.start();
    expect(onTaskError).toHaveBeenCalledWith("broken-task", expect.any(Error));
    await registry.stop();
  });

  it("validates task names, duplicate names, and run-on-start options", () => {
    const registry = new SchedulerRegistry();
    expect(() =>
      registry.register({ name: "", intervalSeconds: 1, run: async () => undefined }),
    ).toThrow(/name is required/);
    expect(() =>
      registry.register({ name: "bad", intervalSeconds: 0, run: async () => undefined }),
    ).toThrow(/positive interval/);
    expect(() =>
      registry.register({
        name: "bad-await",
        intervalSeconds: 1,
        run: async () => undefined,
        runOnStart: false,
        awaitRunOnStart: true,
      }),
    ).toThrow(/awaitRunOnStart requires runOnStart/);

    registry.register({ name: "once", intervalSeconds: 1, run: async () => undefined });
    expect(() =>
      registry.register({ name: "once", intervalSeconds: 1, run: async () => undefined }),
    ).toThrow(/already registered/);
  });

  it("awaits awaitRunOnStart tasks before start resolves", async () => {
    vi.useFakeTimers();
    let releaseTask: () => void = () => undefined;
    const taskBlocked = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const run = vi.fn(async () => {
      await taskBlocked;
    });
    const registry = new SchedulerRegistry();
    registry.register({
      name: "startup-task",
      intervalSeconds: 1,
      run,
      awaitRunOnStart: true,
    });

    try {
      let started = false;
      const startPromise = registry.start().then(() => {
        started = true;
      });
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(1);
      expect(started).toBe(false);
      releaseTask();
      await startPromise;
      expect(started).toBe(true);
      await registry.stop();
    } finally {
      releaseTask();
      vi.useRealTimers();
    }
  });

  it("waits for an awaitRunOnStart task when stopped during startup", async () => {
    vi.useFakeTimers();
    let releaseTask: () => void = () => undefined;
    const taskBlocked = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const registry = new SchedulerRegistry();
    registry.register({
      name: "startup-stop-task",
      intervalSeconds: 1,
      run: async () => taskBlocked,
      awaitRunOnStart: true,
    });

    try {
      void registry.start();
      let stopped = false;
      const stopPromise = registry.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      releaseTask();
      await stopPromise;
      expect(stopped).toBe(true);
      expect(registry.taskNames).toEqual(["startup-stop-task"]);
    } finally {
      releaseTask();
      vi.useRealTimers();
    }
  });

  it("does not overlap a slow task and waits for it during stop", async () => {
    vi.useFakeTimers();
    let releaseTask: () => void = () => undefined;
    const taskBlocked = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const run = vi.fn(async () => {
      await taskBlocked;
    });

    try {
      const handle = startSchedulerRegistry(
        [{ name: "slow-task", intervalSeconds: 1, run, runOnStart: true }],
        { warn: vi.fn(), error: vi.fn() },
      );

      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(run).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopPromise = handle.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      releaseTask();
      await stopPromise;
      expect(stopped).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      releaseTask();
      vi.useRealTimers();
    }
  });
});

describe("jobs route visibility", () => {
  it("treats cross-space jobs as not found", () => {
    expect(jobNotFoundForSpace({ space_id: "space-2" }, "space-1")).toBe(true);
    expect(jobNotFoundForSpace({ space_id: "space-1" }, "space-1")).toBe(false);
  });

  it("maps database job rows to the public jobs schema", () => {
    expect(jobToOut(makeJob({
      payload_json: { run_id: "run-1" },
      result_json: { ok: true },
    }))).toMatchObject({
      id: "job-1",
      payload: { run_id: "run-1" },
      result: { ok: true },
    });
  });

  it("maps job event data and timestamps to the public event schema", () => {
    expect(jobEventToOut({
      id: "event-1",
      job_id: "job-1",
      event_type: "status_change",
      message: "started",
      data: { worker_id: "worker-1" },
      created_at: "2026-06-16T00:00:00.000Z",
    })).toEqual({
      id: "event-1",
      job_id: "job-1",
      event_type: "status_change",
      message: "started",
      data: { worker_id: "worker-1" },
      created_at: "2026-06-16T00:00:00.000Z",
    });
  });
});


describe("AutomationService policy preflight", () => {
  const config = loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
  });
  const configWithoutDb = loadConfig({});

  beforeEach(() => {
    registerRetrievalMaintenanceAutomationTarget();
    registerContextOpsReviewCycleAutomationTarget();
    vi.mocked(enforce).mockReset();
    maintenanceScanMock.mockReset();
    dbPoolMock.current = null;
  });

  it("rejects credential-looking automation config keys before policy enforcement", async () => {
    const repo = new FakeAutomationRepository(sampleAutomation());
    const service = new AutomationService(configWithoutDb, repo);
    await expect(
      service.create({
        spaceId: "space-1",
        ownerUserId: "owner-1",
        body: {
          name: "Nightly",
          agent_id: "agent-1",
          config_json: { nested: { apiToken: "secret" } },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("apiToken"),
    });
    expect(enforce).not.toHaveBeenCalled();
  });

  it("allows non-secret token budget fields in automation config", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const repo = new FakeAutomationRepository(sampleAutomation());
    const service = new AutomationService(configWithoutDb, repo);
    await expect(
      service.create({
        spaceId: "space-1",
        ownerUserId: "owner-1",
        body: {
          name: "Nightly",
          agent_id: "agent-1",
          config_json: { max_tokens: 1024 },
        },
      }),
    ).resolves.toMatchObject({ id: "auto-1" });
    expect(enforce).toHaveBeenCalledOnce();
  });

  it("rejects targets that are absent from the protocol registry", async () => {
    const repo = new FakeAutomationRepository(sampleAutomation());
    const service = new AutomationService(configWithoutDb, repo);
    await expect(
      service.create({
        spaceId: "space-1",
        ownerUserId: "owner-1",
        body: {
          name: "Unknown target",
          agent_id: "agent-1",
          config_json: { target_type: "quietly_hardcoded_target" },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("Unsupported automation target_type"),
    });
    expect(repo.createInputs).toHaveLength(0);
  });

  it("does not let users create the registered control-plane target", async () => {
    const repo = new FakeAutomationRepository(sampleAutomation());
    const service = new AutomationService(configWithoutDb, repo);
    await expect(
      service.create({
        spaceId: "space-1",
        ownerUserId: "owner-1",
        body: {
          name: "Autonomous work",
          agent_id: "agent-1",
          config_json: { target_type: "autonomous_tick" },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("not user-selectable"),
    });
    expect(repo.createInputs).toHaveLength(0);
  });

  it("passes active membership_role into automation policy checks", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const repo = new FakeAutomationRepository(sampleAutomation(), "admin");
    const service = new AutomationService(configWithoutDb, repo);
    await service.create({
      spaceId: "space-1",
      ownerUserId: "owner-1",
      body: {
        name: "Nightly",
        agent_id: "agent-1",
        config_json: {},
      },
    });
    expect(vi.mocked(enforce).mock.calls[0]?.[2].context).toMatchObject({
      membership_role: "admin",
    });
  });

  it("creates knowledge maintenance automations with maintenance preflight instead of runtime preflight", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const repo = new FakeAutomationRepository(sampleAutomation(), "owner");
    const service = new AutomationService(configWithoutDb, repo);
    await service.create({
      spaceId: "space-1",
      ownerUserId: "owner-1",
      body: {
        name: "Knowledge maintenance",
        agent_id: "agent-1",
        config_json: {
          target_type: "knowledge_retrieval_maintenance",
          create_packet: true,
        },
      },
    });

    expect(vi.mocked(enforce).mock.calls[0]?.[2].context).toMatchObject({
      target_type: "knowledge_retrieval_maintenance",
      membership_role: "owner",
    });
    expect(repo.createInputs[0]?.preflightSnapshot).toMatchObject({
      executable: true,
      target_type: "knowledge_retrieval_maintenance",
      maintenance_preflight: {
        persist_report: true,
        create_packet: true,
        membership_role: "owner",
      },
    });
  });

  it("creates Context Review Cycle automations with Context Review Cycle preflight", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const repo = new FakeAutomationRepository(sampleAutomation(), "owner");
    const service = new AutomationService(configWithoutDb, repo);
    await service.create({
      spaceId: "space-1",
      ownerUserId: "owner-1",
      body: {
        name: "Context Review Cycle",
        agent_id: "agent-1",
        config_json: {
          target_type: "context_ops_review_cycle",
          create_packets: true,
          include_memory_maintenance: true,
        },
      },
    });

    expect(vi.mocked(enforce).mock.calls[0]?.[2].context).toMatchObject({
      target_type: "context_ops_review_cycle",
      membership_role: "owner",
    });
    expect(repo.createInputs[0]?.preflightSnapshot).toMatchObject({
      executable: true,
      target_type: "context_ops_review_cycle",
      context_review_cycle_preflight: {
        scope: "context_ops",
        persist_report: true,
        create_packets: true,
        review_scope: "private",
        include_memory_maintenance: true,
        membership_role: "owner",
      },
    });
  });

  it("rejects knowledge maintenance automations for non-admin space members", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const repo = new FakeAutomationRepository(sampleAutomation(), "member");
    const service = new AutomationService(configWithoutDb, repo);
    await expect(
      service.create({
        spaceId: "space-1",
        ownerUserId: "member-1",
        body: {
          name: "Knowledge maintenance",
          agent_id: "agent-1",
          config_json: { target_type: "knowledge_retrieval_maintenance" },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("owner or admin"),
    });
    expect(repo.createInputs).toHaveLength(0);
  });

  it("rejects Context Review Cycle automations for non-admin space members", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const repo = new FakeAutomationRepository(sampleAutomation(), "member");
    const service = new AutomationService(configWithoutDb, repo);
    await expect(
      service.create({
        spaceId: "space-1",
        ownerUserId: "member-1",
        body: {
          name: "Context Review Cycle",
          agent_id: "agent-1",
          config_json: { target_type: "context_ops_review_cycle" },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("owner or admin"),
    });
    expect(repo.createInputs).toHaveLength(0);
  });

  it("rejects invalid Context Review Cycle config fields", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const repo = new FakeAutomationRepository(sampleAutomation(), "owner");
    const service = new AutomationService(configWithoutDb, repo);
    await expect(
      service.create({
        spaceId: "space-1",
        ownerUserId: "owner-1",
        body: {
          name: "Context Review Cycle",
          agent_id: "agent-1",
          config_json: {
            target_type: "context_ops_review_cycle",
            review_scope: "everyone",
          },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("review_scope"),
    });
    expect(repo.createInputs).toHaveLength(0);
  });

  it("rejects knowledge maintenance automations with an invalid attribution agent", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const repo = new FakeAutomationRepository(
      sampleAutomation(),
      "owner",
      [],
      { status: "inactive", current_version_id: "agent-version-1", version_id: "agent-version-1" },
    );
    const service = new AutomationService(configWithoutDb, repo);

    await expect(
      service.create({
        spaceId: "space-1",
        ownerUserId: "owner-1",
        body: {
          name: "Knowledge maintenance",
          agent_id: "agent-1",
          config_json: { target_type: "knowledge_retrieval_maintenance" },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("not active"),
    });
    expect(repo.createInputs).toHaveLength(0);
  });

  it("advances due maintenance automations when preflight fails before execution", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const due = sampleAutomation({
      trigger_type: "schedule",
      config_json: {
        target_type: "knowledge_retrieval_maintenance",
        cron: "0 9 * * *",
        timezone: "UTC",
      },
    });
    const repo = new FakeAutomationRepository(due, "member", [due]);
    const alerts = { emit: vi.fn(async () => undefined) };
    const service = new AutomationService(config, repo, alerts);

    await expect(service.scanAndFire()).resolves.toBe(0);
    expect(repo.advanceScheduleCalls).toBe(1);
    expect(repo.createAutomationRunCalls).toBe(0);
    expect(alerts.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "automation_fire_failed",
      dedupeKey: `automation_fire_failed:${due.id}`,
      spaceId: due.space_id,
      userId: due.owner_user_id,
      projectId: due.project_id,
    }));
  });

  it("advances due maintenance automations once when scan execution fails", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    maintenanceScanMock.mockRejectedValue(new Error("scan failed"));
    const fakePool = new MaintenanceAutomationFakePool();
    dbPoolMock.current = fakePool;
    const due = sampleAutomation({
      trigger_type: "schedule",
      config_json: {
        target_type: "knowledge_retrieval_maintenance",
        cron: "0 9 * * *",
        timezone: "UTC",
      },
    });
    const repo = new FakeAutomationRepository(due, "owner", [due]);
    const service = new AutomationService(config, repo);

    await expect(service.scanAndFire()).resolves.toBe(0);
    expect(fakePool.advanceScheduleCalls).toBe(1);
    expect(fakePool.terminalStatuses).toEqual(["failed"]);
    expect(repo.advanceScheduleCalls).toBe(0);
  });

  it("blocks fire with 403 when policy denies automation.fire", async () => {
    vi.mocked(enforce).mockResolvedValue({
      status: "blocked",
      message: "automation.fire requires admin or owner authority",
    });
    const repo = new FakeAutomationRepository(sampleAutomation());
    const service = new AutomationService(config, repo);
    await expect(
      service.fire({
        spaceId: "space-1",
        automationId: "auto-1",
        actorUserId: "member-user",
      }),
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("admin") });
    expect(repo.createAutomationRunCalls).toBe(0);
  });

  it("records last_fired_at for a successful manual agent-run fire", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const fakePool = new AgentAutomationFireFakePool();
    dbPoolMock.current = fakePool;
    const repo = new FakeAutomationRepository(
      sampleAutomation(),
      "owner",
      [],
      { status: "active", current_version_id: "agent-version-1", version_id: "agent-version-1" },
      true,
    );
    const service = new AutomationService(config, repo);

    const result = await service.fire({
      spaceId: "space-1",
      automationId: "auto-1",
      actorUserId: "owner-1",
      prompt: "Run now",
    });

    expect(result).toMatchObject({
      trigger_origin: "automation",
      preflight_executable: true,
    });
    expect(result.run_id).toEqual(expect.any(String));
    expect(result.automation_run_id).toEqual(expect.any(String));
    expect(repo.recordFireCalls).toBe(1);
    expect(fakePool.runPrompts).toEqual(["Run now"]);
  });

  it("uses the configured prompt for unattended agent-run fires", async () => {
    vi.mocked(enforce).mockResolvedValue({ status: "allow" });
    const fakePool = new AgentAutomationFireFakePool();
    dbPoolMock.current = fakePool;
    const automation = sampleAutomation({
      trigger_type: "schedule",
      config_json: {
        target_type: "agent_run",
        prompt: "Analyze the newly collected papers.",
      },
    });
    const repo = new FakeAutomationRepository(
      automation,
      "owner",
      [],
      { status: "active", current_version_id: "agent-version-1", version_id: "agent-version-1" },
      true,
    );
    const service = new AutomationService(config, repo);

    await service.fire({
      spaceId: "space-1",
      automationId: "auto-1",
      actorUserId: "owner-1",
      triggerType: "schedule",
    });

    expect(fakePool.runPrompts).toEqual(["Analyze the newly collected papers."]);
  });

});

describe("DailyCaptureReport settings validation", () => {
  it("rejects string booleans instead of coercing them", async () => {
    const db = new DailySettingsFakeDb();
    const repo = new PgDailyReportSettingsRepository(db);

    await expect(
      repo.update("space-1", "user-1", { enabled: "false" }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "enabled must be a boolean",
    });
    expect(db.updateCount).toBe(0);
  });

  it("keeps user settings in scoped settings and scheduler state separate", async () => {
    const db = new DailySettingsFakeDb();
    const repo = new PgDailyReportSettingsRepository(db);

    const row = await repo.update("space-1", "user-1", {
      enabled: true,
      local_time: "10:30",
      timezone: "UTC",
      max_memory_proposals_per_day: 2,
    });

    expect(db.settingsJson).toMatchObject({
      enabled: true,
      local_time: "10:30",
      timezone: "UTC",
      max_memory_proposals_per_day: 2,
    });
    expect(db.schedulerTask?.state_json.last_report_date).toBeUndefined();
    expect(db.schedulerTask?.next_run_at).toEqual(expect.any(String));
    expect(row.next_run_at).toBe(db.schedulerTask?.next_run_at);
    expect(db.updateCount).toBe(2);
  });

  it("rejects invalid timezones and unsupported source types", async () => {
    const repo = new PgDailyReportSettingsRepository(new DailySettingsFakeDb());
    await expect(
      repo.update("space-1", "user-1", { enabled: true, timezone: "Mars/Phobos" }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("valid IANA timezone"),
    });
    await expect(
      repo.update("space-1", "user-1", { include_source_types: ["user_capture", "email"] }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("unsupported values"),
    });
  });

  it("does not build a scheduled job payload for an invalid legacy timezone", () => {
    const setting = sampleDailyReportSetting();
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
    expect(buildDailyReportJobPayload(
      { ...setting, enabled: true, timezone: "Mars/Phobos", next_run_at: "2026-06-16T09:00:00.000Z" },
      "2026-06-16T09:00:00.000Z",
    )).toBeNull();
  });
});

class FakeAutomationRepository {
  createAutomationRunCalls = 0;
  createInputs: Array<{ preflightSnapshot: Record<string, unknown> }> = [];
  advanceScheduleCalls = 0;
  recordFireCalls = 0;

  constructor(
    private readonly automation: AutomationRow,
    private readonly membershipRole: string | null = "owner",
    private readonly dueAutomations: AutomationRow[] = [],
    private readonly agentPreflight: {
      status: string;
      current_version_id: string | null;
      version_id: string | null;
    } | null = { status: "active", current_version_id: "agent-version-1", version_id: "agent-version-1" },
    private readonly activeGrant = false,
    private readonly eventAutomations: AutomationRow[] = [],
  ) {}

  async get(spaceId: string, automationId: string): Promise<AutomationRow | null> {
    if (spaceId !== this.automation.space_id || automationId !== this.automation.id) return null;
    return this.automation;
  }

  async list(): Promise<AutomationRow[]> {
    return [this.automation];
  }

  async create(input?: { preflightSnapshot: Record<string, unknown> }): Promise<AutomationRow> {
    if (input) this.createInputs.push(input);
    return this.automation;
  }

  // Part of AutomationRepositoryPort. These tests never exercise the Autonomy
  // upsert path, but the double has to satisfy the port rather than the port
  // being weakened to fit the double.
  async upsertAutonomyAutomation(input: { preflightSnapshot: Record<string, unknown> }): Promise<AutomationRow> {
    this.createInputs.push(input);
    return this.automation;
  }

  async getMembershipRole(): Promise<string | null> {
    return this.membershipRole;
  }

  async assertProjectWriter(): Promise<void> {
    return;
  }

  async canWriteProject(): Promise<boolean> {
    return true;
  }

  async projectInSpace(): Promise<boolean> {
    return true;
  }

  async getAgentPreflight(): Promise<{
    status: string;
    current_version_id: string | null;
    version_id: string | null;
  } | null> {
    return this.agentPreflight;
  }

  async update(): Promise<AutomationRow> {
    return this.automation;
  }

  async hasActiveGrant(): Promise<boolean> {
    return this.activeGrant;
  }

  async createAutomationRun(): Promise<string> {
    this.createAutomationRunCalls += 1;
    return "automation-run-1";
  }

  async listDue(): Promise<AutomationRow[]> {
    return this.dueAutomations;
  }

  async listEventAutomationsForConnection(): Promise<AutomationRow[]> {
    return this.eventAutomations;
  }

  async currentSourceWatermark(): Promise<null> {
    return null;
  }

  async hasInFlightRun(): Promise<boolean> {
    return false;
  }

  async advanceSchedule(): Promise<void> {
    this.advanceScheduleCalls += 1;
  }

  async recordFire(): Promise<void> {
    this.recordFireCalls += 1;
  }
}

class MaintenanceAutomationFakePool implements Queryable {
  advanceScheduleCalls = 0;
  terminalStatuses: string[] = [];
  private schedulerTask: Record<string, unknown> | null = null;

  async connect(): Promise<Queryable & { release(): void }> {
    return {
      query: this.query.bind(this),
      release() {
        return;
      },
    };
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const trimmed = sql.trim();
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM agents")) {
      return {
        rowCount: 1,
        rows: [{ id: "agent-1", status: "active", current_version_id: "agent-version-1" }] as Row[],
      };
    }
    if (sql.includes("FROM agent_versions")) {
      return { rowCount: 1, rows: [{ id: "agent-version-1" }] as Row[] };
    }
    if (sql.includes("SELECT id FROM automations") && sql.includes("FOR UPDATE")) {
      return { rowCount: 1, rows: [{ id: "auto-1" }] as Row[] };
    }
    if (sql.includes("INSERT INTO runs")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: "run-1",
            space_id: "space-1",
            agent_id: "agent-1",
            agent_version_id: "agent-version-1",
            status: "running",
          },
        ] as Row[],
      };
    }
    if (sql.includes("INSERT INTO run_attempts")) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("INSERT INTO automation_runs")) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SELECT DISTINCT task_id") && sql.includes("FROM task_runs")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("SELECT DISTINCT m.host_task_thread_id")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("WITH linked_tasks AS") && sql.includes("UPDATE tasks t")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("UPDATE runs")) {
      this.terminalStatuses.push(String(params[2]));
      return {
        rowCount: 1,
        rows: [{ id: "run-1", status: params[2] }] as Row[],
      };
    }
    if (sql.includes("FROM scheduler_tasks")) {
      return this.schedulerTask
        ? { rowCount: 1, rows: [this.schedulerTask as Row] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes("INSERT INTO scheduler_tasks")) {
      this.advanceScheduleCalls += 1;
      this.schedulerTask = {
        id: this.schedulerTask?.id ?? params[0],
        task_type: params[1],
        task_key: params[2],
        scope_type: params[3],
        scope_id: params[4],
        space_id: params[5] ?? null,
        user_id: params[6] ?? null,
        status: params[7],
        next_run_at: params[8] ?? null,
        last_run_at: params[9] ?? this.schedulerTask?.last_run_at ?? null,
        state_json: JSON.parse(String(params[10] ?? "{}")),
        created_at: this.schedulerTask?.created_at ?? params[11],
        updated_at: params[11],
      };
      return { rowCount: 1, rows: [this.schedulerTask as Row] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class AgentAutomationFireFakePool implements Queryable {
  runPrompts: Array<unknown> = [];
  runInstructions: Array<unknown> = [];
  automationRunTriggerContexts: Array<unknown> = [];

  async connect(): Promise<Queryable & { release(): void }> {
    return {
      query: this.query.bind(this),
      release() {
        return;
      },
    };
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const trimmed = sql.trim();
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM agents")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: "agent-1",
            status: "active",
            current_version_id: "agent-version-1",
            version_id: "agent-version-1",
            runtime_config_json: { adapter_type: "model_api" },
            runtime_policy_json: { risk_level: "medium" },
            model_provider_id: "provider-1",
          },
        ] as Row[],
      };
    }
    if (sql.includes("SELECT runtime_config_json") && sql.includes("FROM agent_versions")) {
      return {
        rowCount: 1,
        rows: [
          {
            runtime_config_json: { adapter_type: "model_api" },
            runtime_policy_json: { risk_level: "medium" },
            model_provider_id: "provider-1",
            model_name: "gpt-4o-mini",
          },
        ] as Row[],
      };
    }
    if (sql.includes("FROM agent_versions")) {
      return { rowCount: 1, rows: [{ id: "agent-version-1" }] as Row[] };
    }
    if (sql.includes("SELECT id FROM automations") && sql.includes("FOR UPDATE")) {
      return { rowCount: 1, rows: [{ id: "auto-1" }] as Row[] };
    }
    if (sql.includes("FROM agent_runtime_profiles")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: "runtime-profile-1",
            space_id: "space-1",
            agent_id: "agent-1",
            name: "Default",
            adapter_type: "model_api",
            model_provider_id: "provider-1",
            model_name: "gpt-4o-mini",
            credential_profile_id: null,
            runtime_config_json: {},
            runtime_policy_json: {},
            enabled: true,
            is_default: true,
            created_at: "2026-06-01T00:00:00.000Z",
            updated_at: "2026-06-01T00:00:00.000Z",
          },
        ] as Row[],
      };
    }
    if (sql.includes("FROM model_provider_space_grants")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: "provider-1",
            name: "Main",
            provider_type: "openai",
            default_model: "gpt-4o-mini",
            enabled: true,
            credential_id: "credential-1",
            config_json: { is_default: true },
          },
        ] as Row[],
      };
    }
    if (sql.includes("INSERT INTO runs")) {
      this.runPrompts.push(params[18]);
      this.runInstructions.push(params[19]);
      return {
        rowCount: 1,
        rows: [
          {
            id: params[0],
            space_id: "space-1",
            agent_id: "agent-1",
            agent_version_id: "agent-version-1",
            status: "queued",
          },
        ] as Row[],
      };
    }
    if (sql.includes("INSERT INTO run_attempts")) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("INSERT INTO jobs")) {
      return { rowCount: 1, rows: [makeJob({ id: String(params[0]) })] as Row[] };
    }
    if (sql.includes("INSERT INTO automation_runs")) {
      this.automationRunTriggerContexts.push(params[6]);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class DailySettingsFakeDb implements Queryable {
  updateCount = 0;
  settingsJson: Record<string, unknown> = sampleDailySettingsJson();
  schedulerTask: {
    id: string;
    task_type: string;
    task_key: string;
    scope_type: string;
    scope_id: string;
    space_id: string | null;
    user_id: string | null;
    status: string;
    next_run_at: string | null;
    last_run_at: string | null;
    state_json: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  } | null = null;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("INSERT INTO settings") && !norm.includes("RETURNING")) {
      return { rowCount: 0, rows: [] };
    }
    if (norm.startsWith("SELECT") && sql.includes("FROM settings")) {
      if (sql.includes("WHERE id = $1")) {
        return params[0] === "setting-1"
          ? { rowCount: 1, rows: [this.settingsRow()] as Row[] }
          : { rowCount: 0, rows: [] };
      }
      return params[0] === "space_user" &&
        params[1] === "space-1:user-1" &&
        params[2] === "daily_capture_report.settings"
        ? { rowCount: 1, rows: [this.settingsRow()] as Row[] }
        : { rowCount: 0, rows: [] };
    }
    if (norm.startsWith("INSERT INTO settings") && norm.includes("RETURNING")) {
      this.updateCount += 1;
      this.settingsJson = JSON.parse(String(params[4] ?? "{}")) as Record<string, unknown>;
      return { rowCount: 1, rows: [this.settingsRow()] as Row[] };
    }
    if (norm.startsWith("SELECT") && sql.includes("FROM scheduler_tasks")) {
      return this.schedulerTask
        ? { rowCount: 1, rows: [this.schedulerTask as Row] }
        : { rowCount: 0, rows: [] };
    }
    if (norm.startsWith("INSERT INTO scheduler_tasks") && norm.includes("RETURNING")) {
      this.updateCount += 1;
      this.schedulerTask = {
        id: "scheduler-task-1",
        task_type: String(params[1]),
        task_key: String(params[2]),
        scope_type: String(params[3]),
        scope_id: String(params[4]),
        space_id: params[5] === null ? null : String(params[5]),
        user_id: params[6] === null ? null : String(params[6]),
        status: String(params[7]),
        next_run_at: params[8] === null ? null : String(params[8]),
        last_run_at: params[9] === null ? this.schedulerTask?.last_run_at ?? null : String(params[9]),
        state_json: JSON.parse(String(params[10] ?? "{}")) as Record<string, unknown>,
        created_at: this.schedulerTask?.created_at ?? String(params[11]),
        updated_at: String(params[11]),
      };
      return { rowCount: 1, rows: [this.schedulerTask as Row] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  private settingsRow(): Record<string, unknown> {
    return {
      id: "setting-1",
      scope_type: "space_user",
      scope_id: "space-1:user-1",
      settings_key: "daily_capture_report.settings",
      settings_json: this.settingsJson,
      updated_by_user_id: "user-1",
      created_at: "2026-06-16T00:00:00.000Z",
      updated_at: "2026-06-16T00:00:00.000Z",
    };
  }
}

function sampleDailySettingsJson(): Record<string, unknown> {
  return {
    enabled: false,
    local_time: "09:00",
    timezone: "UTC",
    include_source_types: ["user_capture"],
    create_experience_proposals: true,
    create_memory_proposals: true,
    experience_confidence_threshold: 0.6,
    memory_confidence_threshold: 0.7,
    max_experience_proposals_per_day: 5,
    max_memory_proposals_per_day: 3,
  };
}

function sampleDailyReportSetting(): DailyReportSettingRow {
  return {
    id: "setting-1",
    space_id: "space-1",
    user_id: "user-1",
    enabled: false,
    local_time: "09:00",
    timezone: "UTC",
    include_source_types_json: ["user_capture"],
    create_experience_proposals: true,
    create_memory_proposals: true,
    experience_confidence_threshold: 0.6,
    memory_confidence_threshold: 0.7,
    max_experience_proposals_per_day: 5,
    max_memory_proposals_per_day: 3,
    last_report_date: null,
    next_run_at: null,
    created_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
  };
}

function sampleAutomation(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: "auto-1",
    space_id: "space-1",
    owner_user_id: "owner-1",
    agent_id: "agent-1",
    project_folder_id: null,
    project_id: null,
    name: "Nightly",
    description: null,
    trigger_type: "manual",
    status: "active",
    preflight_snapshot_json: { executable: true },
    config_json: null,
    next_run_at: null,
    last_fired_at: null,
    created_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    space_id: "space-1",
    user_id: "user-1",
    project_folder_id: null,
    agent_id: null,
    job_type: "agent_run",
    status: "claimed",
    priority: 0,
    payload_json: { run_id: "run-1" },
    result_json: null,
    error: null,
    attempts: 1,
    max_attempts: 3,
    scheduled_at: new Date().toISOString(),
    claimed_by: "worker-1",
    claimed_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
