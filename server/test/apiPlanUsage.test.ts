import { describe, expect, it, vi } from "vitest";
import { collectPlanUsage, parseMiniMaxPlanUsage, planUsageSource } from "../src/modules/providers/planUsage/collectors.js";

const source = planUsageSource("https://api.minimaxi.com/anthropic")!;
describe("MiniMax API plan meters", () => {
  it("prefers shared general percentages over zero legacy counters and model aliases", () => {
    const windows = parseMiniMaxPlanUsage({ base_resp: { status_code: 0 }, model_remains: [
      { model_name: "MiniMax-M3", current_interval_remaining_percent: 90 },
      { model_name: "general", current_interval_total_count: 0, current_interval_usage_count: 0,
        current_interval_remaining_percent: 75, current_weekly_remaining_percent: 60,
        remains_time: 60_000, weekly_remains_time: 120_000 },
    ] }, Date.parse("2026-11-07T12:00:00Z"));
    expect(windows).toEqual([
      { id: "session-0", label: "5h", used_pct: 25, resets_at: "2026-11-07T12:01:00.000Z" },
      { id: "week-0", label: "7d", used_pct: 40, resets_at: "2026-11-07T12:02:00.000Z" },
    ]);
  });
  it("reads official epoch-millisecond end times, and falls back to the remaining duration when an end is stale or not epoch-ms", () => {
    // Field shape and units from MiniMax's own CLI (mmx-cli 1.0.28 QuotaModelRemain): every *_time is milliseconds.
    const now = Date.parse("2026-11-07T12:00:00Z");
    const general = { model_name: "general", start_time: now - 3_600_000, end_time: now + 4 * 3_600_000, remains_time: 4 * 3_600_000 - 5_000,
      current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 70,
      current_weekly_total_count: 0, current_weekly_usage_count: 0, current_weekly_remaining_percent: 55,
      weekly_start_time: now - 86_400_000, weekly_end_time: now + 6 * 86_400_000, weekly_remains_time: 6 * 86_400_000 - 5_000 };
    const parse = (row: Record<string, unknown>) => parseMiniMaxPlanUsage({ base_resp: { status_code: 0 }, model_remains: [row] }, now).map(w => w.resets_at);
    expect(parse(general)).toEqual(["2026-11-07T16:00:00.000Z", "2026-11-13T12:00:00.000Z"]);
    // A window whose end already passed (not yet restarted) uses remains_time; none left means no reset claim.
    expect(parse({ ...general, end_time: now - 1_000, weekly_end_time: now - 1_000 })).toEqual(["2026-11-07T15:59:55.000Z", "2026-11-13T11:59:55.000Z"]);
    expect(parse({ ...general, end_time: now - 1_000, remains_time: 0 })[0]).toBeNull();
    // Seconds or microseconds are not reinterpreted: the duration stands in, never 1970 or year 55000.
    expect(parse({ ...general, end_time: Math.floor((now + 3_600_000) / 1000) })[0]).toBe("2026-11-07T15:59:55.000Z");
    expect(parse({ ...general, end_time: (now + 3_600_000) * 1000 })[0]).toBe("2026-11-07T15:59:55.000Z");
    expect(parse({ ...general, end_time: (now + 3_600_000) * 1000, remains_time: 90 * 86_400_000 })[0]).toBeNull();
  });
  it("reads legacy remaining counts without inverting consumption and omits absent weekly quota", () => {
    expect(parseMiniMaxPlanUsage({ model_remains: [{ model_name: "MiniMax-M2.7", current_interval_total_count: 1500, current_interval_usage_count: 1200 }] }))
      .toEqual([{ id: "session-0", label: "MiniMax-M2.7 · 5h", used_pct: 20, resets_at: null }]);
  });
  it("distinguishes real zero/exhaustion from missing, invalid or failed readings", () => {
    for (const remaining of [0, 100]) expect(parseMiniMaxPlanUsage({ model_remains: [{ model_name: "general", current_interval_remaining_percent: remaining }] })[0].used_pct).toBe(100 - remaining);
    for (const value of [null, {}, { base_resp: { status_code: 1004 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 100 }] },
      { model_remains: [{ model_name: "general", current_interval_remaining_percent: -1 }] },
      { model_remains: [{ model_name: "general", current_interval_total_count: 0, current_interval_usage_count: 0 }] }]) expect(parseMiniMaxPlanUsage(value)).toEqual([]);
  });
  it("only chooses exact official HTTPS origins, with no credentials, redirect host or custom proxy", () => {
    expect(source.url).toBe("https://www.minimaxi.com/v1/token_plan/remains");
    expect(planUsageSource("https://api.minimax.io/v1")?.url).toBe("https://www.minimax.io/v1/token_plan/remains");
    for (const base of ["http://api.minimaxi.com/anthropic", "https://api.minimaxi.com.evil.test/anthropic", "https://key@api.minimaxi.com/anthropic", "https://api.minimaxi.com:8443/anthropic", "https://localhost/v1", "https://api.moonshot.cn/v1", "https://api.z.ai/api/paas/v4"]) expect(planUsageSource(base)).toBeNull();
  });
  it("uses a bounded GET with the subscription key and returns only normalized windows", async () => {
    const fetcher = vi.fn(async () => Response.json({ secret: "vendor-private", model_remains: [{ model_name: "general", current_interval_remaining_percent: 75 }] }));
    const result = await collectPlanUsage(source, "test-subscription-secret", fetcher);
    expect(fetcher).toHaveBeenCalledWith(source.url, expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: "Bearer test-subscription-secret" }) }));
    expect(JSON.stringify(result)).not.toMatch(/secret|private/);
    expect(result[0].used_pct).toBe(25);
  });
  it("never returns vendor bodies, keys or transport errors on failures", async () => {
    for (const fetcher of [async () => new Response("test-subscription-secret", { status: 401 }), async () => Response.json({}), async () => { throw new Error("test-subscription-secret"); }]) {
      await expect(collectPlanUsage(source, "test-subscription-secret", fetcher)).rejects.toThrow(/^Plan usage query failed\./);
    }
  });
});
