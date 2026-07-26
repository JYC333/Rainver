import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startCliUsageRefreshScheduler,
  type CliUsageRefreshScheduler,
} from "../src/modules/providers";

let scheduler: CliUsageRefreshScheduler | null = null;

afterEach(() => {
  scheduler?.stop();
  scheduler = null;
  vi.useRealTimers();
});

describe("startCliUsageRefreshScheduler", () => {
  it("refreshes stale usage on the configured interval", async () => {
    vi.useFakeTimers();
    const calls: Array<{ runtime: string; maxAgeMs: number }> = [];
    scheduler = startCliUsageRefreshScheduler(
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
      { intervalMs: 50, maxAgeMs: 123, runtimes: ["claude_code"] },
    );

    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toEqual([
      { runtime: "claude_code:space-1:user-1:profile-1", maxAgeMs: 123 },
      { runtime: "claude_code:space-2:user-2:profile-2", maxAgeMs: 123 },
    ]);
  });

  it("does not start a second refresh while one is still running", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];

    scheduler = startCliUsageRefreshScheduler(
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
      { intervalMs: 1_000_000, runtimes: ["claude_code"] },
    );

    const first = scheduler.refreshDueUsage();
    const second = scheduler.refreshDueUsage();
    await Promise.resolve();
    expect(calls).toEqual(["claude_code"]);

    release();
    await Promise.all([first, second]);
  });

  it("skips broker refresh when auto-refresh is disabled", async () => {
    vi.useFakeTimers();
    let calls = 0;
    scheduler = startCliUsageRefreshScheduler(
      {
        async listQuotaRefreshTargets() {
          return [];
        },
        async refreshStaleCliQuota() {
          calls += 1;
          return null;
        },
      },
      { intervalMs: 50, isEnabled: () => false },
    );

    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toBe(0);
  });

  it("continues refreshing other profiles when one profile fails", async () => {
    const calls: string[] = [];
    scheduler = startCliUsageRefreshScheduler(
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
      { intervalMs: 1_000_000, runtimes: ["codex_cli"] },
    );

    await scheduler.refreshDueUsage();

    expect(calls).toEqual(["profile-1", "profile-2"]);
  });
});
