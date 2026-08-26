import { describe, expect, it } from "vitest";
import { CLI_USAGE_REFRESH_INTERVAL_SECONDS, createCliUsageRefreshTask } from "../src/modules/providers/cli/usageScheduler.js";

describe("createCliUsageRefreshTask", () => {
  it("is a scheduled task, not a self-owned timer", () => {
    const task = createCliUsageRefreshTask({
      async listQuotaRefreshTargets() {
        return [];
      },
      async refreshStaleCliQuota() {
        return null;
      },
    });
    // Timing, shutdown, failure alerting, and liveness belong to
    // SchedulerRegistry; this module only declares the work and its cadence.
    expect(task.name).toBe("cli_usage_quota_refresh");
    expect(task.intervalSeconds).toBe(CLI_USAGE_REFRESH_INTERVAL_SECONDS);
    expect(task.runOnStart).toBe(false);
  });

  it("refreshes every target of every runtime with the configured max age", async () => {
    const calls: Array<{ runtime: string; maxAgeMs: number }> = [];
    const task = createCliUsageRefreshTask(
      {
        async listQuotaRefreshTargets() {
          return [
            { profile_id: "profile-1", space_id: "space-1", owner_user_id: "user-1" },
            { profile_id: "profile-2", space_id: "space-2", owner_user_id: "user-2" },
          ];
        },
        async refreshStaleCliQuota(runtime, maxAgeMs, spaceId, userId, profileId) {
          calls.push({ runtime: `${runtime}:${spaceId}:${userId}:${profileId}`, maxAgeMs });
          return null;
        },
      },
      { maxAgeMs: 123, runtimes: ["claude_code"] },
    );

    await task.run();

    expect(calls).toEqual([
      { runtime: "claude_code:space-1:user-1:profile-1", maxAgeMs: 123 },
      { runtime: "claude_code:space-2:user-2:profile-2", maxAgeMs: 123 },
    ]);
  });

  it("derives the default max age from the interval", async () => {
    const seen: number[] = [];
    const task = createCliUsageRefreshTask(
      {
        async listQuotaRefreshTargets() {
          return [{ profile_id: "p", space_id: "s", owner_user_id: "u" }];
        },
        async refreshStaleCliQuota(_runtime, maxAgeMs) {
          seen.push(maxAgeMs);
          return null;
        },
      },
      { intervalSeconds: 60, runtimes: ["claude_code"] },
    );

    await task.run();

    expect(seen).toEqual([60_000]);
  });

  it("does not start a second pass while one is still running", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];

    const task = createCliUsageRefreshTask(
      {
        async listQuotaRefreshTargets() {
          return [{ profile_id: "profile-1", space_id: "space-1", owner_user_id: "user-1" }];
        },
        async refreshStaleCliQuota(runtime) {
          calls.push(runtime);
          await blocked;
          return null;
        },
      },
      { runtimes: ["claude_code"] },
    );

    const first = task.run();
    const second = task.run();
    await Promise.resolve();
    expect(calls).toEqual(["claude_code"]);

    release();
    await Promise.all([first, second]);
  });

  it("skips broker refresh when auto-refresh is disabled", async () => {
    let calls = 0;
    const task = createCliUsageRefreshTask(
      {
        async listQuotaRefreshTargets() {
          return [];
        },
        async refreshStaleCliQuota() {
          calls += 1;
          return null;
        },
      },
      { isEnabled: () => false },
    );

    await task.run();

    expect(calls).toBe(0);
  });

  it("continues refreshing other profiles when one profile fails", async () => {
    const calls: string[] = [];
    const task = createCliUsageRefreshTask(
      {
        async listQuotaRefreshTargets() {
          return [
            { profile_id: "profile-1", space_id: "space-1", owner_user_id: "user-1" },
            { profile_id: "profile-2", space_id: "space-2", owner_user_id: "user-2" },
          ];
        },
        async refreshStaleCliQuota(_runtime, _maxAgeMs, _spaceId, _userId, profileId) {
          calls.push(profileId);
          if (profileId === "profile-1") throw new Error("probe failed");
          return null;
        },
      },
      { runtimes: ["codex_cli"] },
    );

    await task.run();

    expect(calls).toEqual(["profile-1", "profile-2"]);
  });
});
