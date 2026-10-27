import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseAntigravityQuota, probeAntigravity } from "../src/antigravityUsage.js";
import { parseClaudeOAuthUsage } from "../src/usageProbe.js";

afterEach(() => vi.unstubAllGlobals());

it("preserves small measured consumption for display-time rounding", () => {
  const quota = parseAntigravityQuota({ buckets: [{ modelId: "gemini", remainingFraction: 0.9985148 }] });
  expect(quota.windows?.[0].used_pct).toBeCloseTo(0.14852, 5);
});

it("retains model-family windows and aggregates only explicit cadences", () => {
  const quota = parseAntigravityQuota({ response: { groups: [
    { displayName: "Gemini", buckets: [
      { bucketId: "g-week", window: "weekly", remaining: { remainingFraction: 0.7 } },
      { bucketId: "g-session", window: "5h", remainingFraction: 0.25 },
      { bucketId: "unknown", window: "weekly" },
      { bucketId: "disabled", window: "weekly", remainingFraction: 0, disabled: true },
    ] },
    { displayName: "Claude/GPT", buckets: [{ bucketId: "c-week", window: "weekly", remainingFraction: 0.1 }] },
  ] } });
  expect(quota).toMatchObject({ available: true, session_pct: 75, week_pct: 90 });
  expect(quota.windows).toHaveLength(4);
  expect(quota.windows?.find(w => w.id === "unknown")?.used_pct).toBeNull();
});

it("never mistakes missing or invalid fractions for unused capacity", () => {
  expect(parseAntigravityQuota({ buckets: [{ modelId: "gemini", remainingFraction: 2 }] }).available).toBe(false);
  expect(parseAntigravityQuota({ models: { gemini: { quotaInfo: { remainingFraction: 1 } } } }).available).toBe(false);
  const legacy = parseAntigravityQuota({ buckets: [{ modelId: "gemini", remainingFraction: 0.5 }] });
  expect(legacy).toMatchObject({ available: true, session_pct: null, week_pct: null });
});

it("preserves Fable's independent quota without replacing the account week", () => {
  const quota = parseClaudeOAuthUsage({
    seven_day: { utilization: 20 }, seven_day_fable: { utilization: 95 },
    seven_day_sonnet: { utilization: 30 }, seven_day_future_model: { utilization: 40 },
  });
  expect(quota.week_pct).toBe(20);
  expect(quota.windows?.find(w => w.id === "seven_day_fable")?.used_pct).toBe(95);
  expect(quota.windows).toHaveLength(4);
});

it("uses only this copy's refresh credential and fixed endpoints, falling back on denied summaries", async () => {
  const home = await mkdtemp(join(tmpdir(), "rainver-quota-"));
  try {
    await mkdir(join(home, ".gemini/antigravity-acp"), { recursive: true });
    await writeFile(join(home, ".gemini/antigravity-acp/acp_token.json"), JSON.stringify({
      client_id: "client", client_secret: "secret", refresh_token: "refresh+token", project_id: "project",
      token_uri: "https://untrusted.example/token",
    }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-secret" })))
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ buckets: [{ modelId: "gemini", remainingFraction: 0.6 }] })));
    vi.stubGlobal("fetch", fetcher);
    const quota = await probeAntigravity(home, null, 2);
    expect(quota.windows?.[0].used_pct).toBe(40);
    expect(fetcher.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    expect(fetcher.mock.calls[0][1].body.get("refresh_token")).toBe("refresh+token");
    expect(fetcher.mock.calls[2][1].body).toBe('{"project":"project"}');
    expect(fetcher.mock.calls.every(call => call[1].redirect === "error")).toBe(true);
    expect(JSON.stringify(quota)).not.toMatch(/access-secret|refresh.token|client_secret/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("does not discover or authorize another account when this copy has no login", async () => {
  const home = await mkdtemp(join(tmpdir(), "rainver-quota-missing-"));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  try {
    const quota = await probeAntigravity(home, null, 1);
    expect(quota.available).toBe(false);
    expect(quota.error).toMatch(/Log in/);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("does not confuse Claude product usage shares with independent Fable allowances", () => {
  const quota = parseClaudeOAuthUsage({
    seven_day: { utilization: 49 },
    seven_day_breakdown: { rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }] },
  });
  expect(quota.week_pct).toBe(49);
  expect(quota.windows).toHaveLength(1);
  expect(quota.windows?.some(window => /fable|breakdown/.test(window.id))).toBe(false);
});
