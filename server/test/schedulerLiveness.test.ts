import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TASK_TIMEOUT_SECONDS,
  SchedulerRegistry,
} from "../src/modules/scheduler/registry";

const silentLog = { warn: vi.fn(), error: vi.fn() };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SchedulerRegistry liveness", () => {
  it("defaults a task's reporting deadline and exposes it", () => {
    const registry = new SchedulerRegistry();
    registry.register({ name: "a", intervalSeconds: 30, run: async () => undefined });
    registry.register({
      name: "b",
      intervalSeconds: 30,
      timeoutSeconds: 90,
      run: async () => undefined,
    });
    const byName = Object.fromEntries(registry.statuses().map((s) => [s.name, s]));
    expect(byName.a.timeout_seconds).toBe(DEFAULT_TASK_TIMEOUT_SECONDS);
    expect(byName.b.timeout_seconds).toBe(90);
  });

  it("rejects a non-positive timeout", () => {
    const registry = new SchedulerRegistry();
    expect(() =>
      registry.register({
        name: "bad",
        intervalSeconds: 30,
        timeoutSeconds: 0,
        run: async () => undefined,
      }),
    ).toThrow(/positive timeout/);
  });

  it("records a successful pass as healthy", async () => {
    const registry = new SchedulerRegistry(silentLog);
    registry.register({
      name: "good",
      intervalSeconds: 3600,
      awaitRunOnStart: true,
      run: async () => undefined,
    });
    await registry.start();
    const [status] = registry.statuses();
    expect(status.health).toBe("ok");
    expect(status.state).toBe("idle");
    expect(status.last_success_at).not.toBeNull();
    expect(status.consecutive_failures).toBe(0);
    expect(status.seconds_since_completion).toBe(0);
    await registry.stop();
  });

  it("reports a throwing task as failing and keeps the error message", async () => {
    const registry = new SchedulerRegistry(silentLog);
    registry.register({
      name: "broken",
      intervalSeconds: 3600,
      awaitRunOnStart: true,
      run: async () => {
        throw new Error("boom");
      },
    });
    await registry.start();
    const [status] = registry.statuses();
    expect(status.health).toBe("failing");
    expect(status.consecutive_failures).toBe(1);
    expect(status.last_error).toBe("boom");
    expect(status.last_success_at).toBeNull();
    expect(status.last_failure_at).not.toBeNull();
    await registry.stop();
  });

  it("alerts on a pass that exceeds its deadline instead of hanging silently", async () => {
    vi.useFakeTimers();
    try {
      const onTaskError = vi.fn(async () => undefined);
      const hang = deferred();
      const registry = new SchedulerRegistry(silentLog, onTaskError);
      registry.register({
        name: "hung",
        intervalSeconds: 3600,
        timeoutSeconds: 5,
        awaitRunOnStart: true,
        run: () => hang.promise,
      });

      const started = registry.start();
      await vi.advanceTimersByTimeAsync(5_000);
      await started;

      expect(onTaskError).toHaveBeenCalledWith("hung", expect.any(Error));
      const [status] = registry.statuses();
      expect(status.timeouts_total).toBe(1);
      expect(status.consecutive_failures).toBe(1);
      expect(status.last_error).toMatch(/did not complete within 5s/);
      // The pass is still outstanding — it could not be cancelled — so the
      // task must still read as running, not as idle-and-fine.
      expect(status.state).toBe("running");

      hang.resolve();
      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start another pass while a timed-out pass is still outstanding", async () => {
    vi.useFakeTimers();
    try {
      let starts = 0;
      const hang = deferred();
      const registry = new SchedulerRegistry(silentLog, async () => undefined);
      registry.register({
        name: "hung",
        intervalSeconds: 1,
        timeoutSeconds: 5,
        run: () => {
          starts += 1;
          return hang.promise;
        },
      });

      void registry.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(starts).toBe(1);

      // Several further intervals elapse while the first pass is still wedged.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(starts).toBe(1);

      hang.resolve();
      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a task that stopped completing as stalled, not merely failing", async () => {
    vi.useFakeTimers();
    try {
      const hang = deferred();
      const registry = new SchedulerRegistry(silentLog, async () => undefined);
      registry.register({
        name: "wedged",
        intervalSeconds: 10,
        timeoutSeconds: 5,
        run: () => hang.promise,
      });
      void registry.start();
      await vi.advanceTimersByTimeAsync(5_000);

      // Stall threshold is max(interval*3, timeout+interval) = 30s here.
      const beforeThreshold = registry.statuses(new Date(Date.now() + 20_000))[0];
      expect(beforeThreshold.health).toBe("failing");

      const afterThreshold = registry.statuses(new Date(Date.now() + 60_000))[0];
      expect(afterThreshold.health).toBe("stalled");

      hang.resolve();
      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates tasks: one task's failure does not stop another task's passes", async () => {
    vi.useFakeTimers();
    try {
      let healthyRuns = 0;
      const registry = new SchedulerRegistry(silentLog, async () => undefined);
      registry.register({
        name: "always-throws",
        intervalSeconds: 1,
        run: async () => {
          throw new Error("domain A is down");
        },
      });
      registry.register({
        name: "healthy",
        intervalSeconds: 1,
        run: async () => {
          healthyRuns += 1;
        },
      });

      void registry.start();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(healthyRuns).toBeGreaterThan(1);
      const byName = Object.fromEntries(registry.statuses().map((s) => [s.name, s]));
      expect(byName["always-throws"].health).toBe("failing");
      expect(byName.healthy.health).toBe("ok");

      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops promptly without waiting out an outstanding pass", async () => {
    const hang = deferred();
    const registry = new SchedulerRegistry(silentLog, async () => undefined);
    registry.register({
      name: "hung",
      intervalSeconds: 3600,
      // Long enough that awaiting the deadline would hang this test.
      timeoutSeconds: 3600,
      run: () => hang.promise,
    });
    void registry.start();
    await Promise.resolve();

    await registry.stop();

    hang.resolve();
  });
});
