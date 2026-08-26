import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { CliCredentialBroker } from "../src/modules/providers/cli/credentialBroker.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("CLI usage auto-refresh settings", () => {
  it("defaults to enabled and persists frontend changes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-usage-settings-"));
    const broker = new CliCredentialBroker(loadConfig({ RAINVER_HOME: tempDir }));

    expect(await broker.isCliUsageAutoRefreshEnabled()).toBe(true);
    expect((await broker.cliUsageAutoRefreshSettings()).updated_at).toBeNull();

    const saved = await broker.setCliUsageAutoRefresh(false);
    expect(saved.enabled).toBe(false);
    expect(saved.updated_at).toBeTruthy();

    const brokerAfterReload = new CliCredentialBroker(loadConfig({ RAINVER_HOME: tempDir }));
    expect(await brokerAfterReload.isCliUsageAutoRefreshEnabled()).toBe(false);
  });

  it("stores live Claude quota in the selected profile cache", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-live-quota-"));
    const broker = new CliCredentialBroker(loadConfig({ RAINVER_HOME: tempDir }));

    await broker.recordLiveQuota("claude_code", "profile-1", {
      status: "allowed_warning",
      rate_limit_type: "seven_day",
      utilization: 0.42,
      resets_at: 1_785_427_200,
      is_using_overage: false,
    });

    const cached = JSON.parse(await readFile(
      join(tempDir, "cache", "cli-quota", "claude_code", "profile-1.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(cached).toMatchObject({
      available: true,
      week_pct: 42,
      week_resets: new Date(1_785_427_200_000).toISOString(),
      error: null,
    });
  });
});
