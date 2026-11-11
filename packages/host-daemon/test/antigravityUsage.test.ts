import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseAntigravityQuota, probeAntigravity } from "../src/antigravityUsage.js";
import { HostUsageQuotaSchema } from "@rainver/protocol";
import { parseClaudeOAuthUsage } from "../src/usageProbe.js";

afterEach(() => vi.unstubAllGlobals());

it("preserves small measured consumption for display-time rounding", () => {
  const quota = parseAntigravityQuota({ groups: [{ buckets: [{ bucketId: "gemini", remainingFraction: 0.9985148 }] }] });
  expect(quota.windows?.[0].used_pct).toBeCloseTo(0.14852, 5);
});

it("retains independent model-family windows without inventing an account total", () => {
  const quota = parseAntigravityQuota({ response: { groups: [
    { displayName: "Gemini", buckets: [
      { bucketId: "g-week", window: "weekly", remaining: { remainingFraction: 0.7 } },
      { bucketId: "g-session", window: "5h", remainingFraction: 0.25 },
      { bucketId: "unknown", window: "weekly" },
      { bucketId: "disabled", window: "weekly", remainingFraction: 0, disabled: true },
    ] },
    { displayName: "Claude/GPT", buckets: [{ bucketId: "c-week", window: "weekly", remainingFraction: 0.1 }] },
  ] } });
  expect(quota).toMatchObject({ available: true, session_pct: null, week_pct: null });
  expect(quota.windows).toHaveLength(4);
  expect(quota.windows?.find(w => w.id === "unknown")?.used_pct).toBeNull();
});

it("never mistakes missing or invalid fractions for unused capacity", () => {
  expect(parseAntigravityQuota({ groups: [{ buckets: [{ bucketId: "gemini", remainingFraction: 2 }] }] }).available).toBe(false);
  expect(parseAntigravityQuota({ models: { gemini: { quotaInfo: { remainingFraction: 1 } } } }).available).toBe(false);
  const unclassified = parseAntigravityQuota({ groups: [{ buckets: [{ bucketId: "gemini", remainingFraction: 0.5 }] }] });
  expect(unclassified).toMatchObject({ available: true, session_pct: null, week_pct: null });
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

it.each(["private@example.invalid", "a.@x.com"])("reads native quota even if its display email is unsupported: %s", async email => {
  const home = await mkdtemp(join(tmpdir(), "rainver-quota-'account-"));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  try {
    await mkdir(join(home, ".gemini/antigravity-cli"), { recursive: true });
    await writeFile(join(home, ".gemini/antigravity-cli/antigravity-oauth-token"), "synthetic-login-not-for-the-probe-to-parse");
    const cli = join(home, "native-cli.cjs");
    await writeFile(cli, `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const { spawnSync } = require("node:child_process");
      fs.accessSync(join(process.env.HOME, ".gemini/antigravity-cli/antigravity-oauth-token"));
      const settings = JSON.parse(process.argv[process.argv.indexOf("--settings") + 1]);
      const captured = spawnSync(settings.statusLine.command, {
        shell: true,
        input: JSON.stringify({ quota: { "gemini-weekly": { remaining_fraction: 0.6 } }, email: ${JSON.stringify(email)}, other: "access-secret" }),
      });
      if (captured.status !== 0) process.exit(1);
      setInterval(() => {}, 1000);
    `);
    const quota = await probeAntigravity(home, null, 5, process.execPath, [cli]);
    expect(quota.available).toBe(true);
    expect(quota.week_pct).toBeNull();
    expect(quota.windows?.[0].used_pct).toBe(40);
    expect(quota.account).toMatchObject({ provider: "google", product: "antigravity", identity_kind: "email", organization_id: null });
    expect(quota.account?.account_id).toMatch(/^[a-f0-9]{64}$/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(quota.account_display).toEqual(email === "private@example.invalid" ? { email } : null);
    expect(HostUsageQuotaSchema.safeParse(quota).success).toBe(true);
    expect(JSON.stringify(quota)).not.toMatch(/access-secret/);
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

it("does not let an exhausted Argon allowance consume other model families", () => {
  const quota = parseAntigravityQuota({ groups: [{ buckets: [
    { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0 },
    { bucketId: "gemini-weekly", remainingFraction: 0.8 },
    { bucketId: "3p-weekly", remainingFraction: 0.9 },
  ] }] });
  expect(quota.week_pct).toBeNull();
  expect(quota.windows?.map(w => w.scope)).toEqual(["family", "family", "family"]);
  expect(quota.windows?.[0].used_pct).toBe(100);
});
