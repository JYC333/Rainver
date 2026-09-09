import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedCliEntry, parseClaudeOAuthUsage, probeUsage, quotaFromRateLimitsResult, quotaFromRefusal } from "../src/usageProbe.js";

/**
 * Reading a subscription's remaining quota moved from the control plane to
 * the host in ADR 0016 §7, because the credential it needs no longer leaves
 * the copy. These pin the two shapes that arrive and the one thing that must
 * never happen: a token in the answer.
 */
describe("parsing what a vendor reports about a subscription", () => {
  it("reads Claude's five-hour and seven-day windows", () => {
    const quota = parseClaudeOAuthUsage({
      five_hour: { utilization: 61.4, resets_at: "2026-09-08T12:00:00.000Z" },
      seven_day: { utilization: 18, resets_at: "2026-09-12T00:00:00.000Z" },
    });
    expect(quota).toMatchObject({ available: true, session_pct: 61, week_pct: 18 });
    expect(quota.session_resets).toBe("Resets 2026-09-08T12:00:00.000Z");
  });

  it("reports Claude as unavailable rather than guessing when no window is present", () => {
    expect(parseClaudeOAuthUsage({ five_hour: {} })).toMatchObject({ available: false, session_pct: null });
  });

  it("puts Codex's windows in the right places by their durations, not their order", () => {
    // `primary`/`secondary` do not say which is the session and which the
    // week, and the order has changed between Codex versions. Reading them
    // positionally reported a week's usage as the session's.
    const quota = quotaFromRateLimitsResult({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 77, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      },
    });
    expect(quota).toMatchObject({ available: true, session_pct: 77, week_pct: 12 });
  });

  it("recovers the numbers from the refusal an over-limit account gets", () => {
    // The accounts whose quota matters most are exactly the ones whose
    // rate-limit call is refused; reading only successful results reported
    // them as unavailable.
    const quota = quotaFromRefusal(
      'stream error: unexpected status 429 Too Many Requests: body={"rate_limit":{"primary_window":{"used_percent":100,"limit_window_seconds":18000,"reset_at":1700000000},"secondary_window":{"used_percent":40,"limit_window_seconds":604800}}}',
    );
    expect(quota).toMatchObject({ available: true, session_pct: 100, week_pct: 40 });
  });

  it("returns an empty quota rather than throwing on a refusal that carries no body", () => {
    expect(quotaFromRefusal("connection reset")).toMatchObject({ available: false, error: null });
  });
});

describe("which program the probe enters", () => {
  // A managed copy launches its ACP adapter for a Run and its vendor CLI for
  // everything else. The probe wants the second: asking `codex-acp` for an
  // app-server answers `-32600 Invalid request`, which read as a timeout.
  const codexManifest = {
    adapter_type: "codex_cli",
    version: "1.10.0",
    command: "/usr/local/bin/node",
    args: ["/tools/codex_cli/1.10.0/node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
    entry_args: ["/tools/codex_cli/1.10.0/node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
    env: {},
    home: "/tools/codex_cli/1.10.0/home",
    login_command: [
      "/usr/local/bin/node",
      "/tools/codex_cli/1.10.0/node_modules/@openai/codex/bin/codex.js",
      "login",
      "--device-auth",
    ],
    login: {
      command: ["codex", "login", "--device-auth"],
      home_subdir: ".codex",
      credential_file: "auth.json",
    },
    installed_at: "2026-09-08T13:27:20.849Z",
  } as const;

  it("enters the vendor CLI, never the ACP adapter it launches for a Run", () => {
    const entry = managedCliEntry(codexManifest as never);
    expect(entry).toEqual({
      command: "/usr/local/bin/node",
      args: ["/tools/codex_cli/1.10.0/node_modules/@openai/codex/bin/codex.js"],
    });
    expect(entry?.args).not.toContain(codexManifest.entry_args[0]);
  });

  it("drops exactly the subcommand the login spec carries, whatever names the CLI", () => {
    // Claude names its CLI in one element and its subcommand in one more.
    expect(managedCliEntry({
      ...codexManifest,
      login_command: ["/tools/claude/claude", "/login"],
      login: { command: ["claude", "/login"], home_subdir: ".claude", credential_file: ".credentials.json" },
    } as never)).toEqual({ command: "/tools/claude/claude", args: [] });
  });

  it("refuses rather than guesses when the copy records no login command", () => {
    expect(managedCliEntry({ ...codexManifest, login_command: null } as never)).toBeNull();
  });
});

describe("probing one copy on this host", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "rainver-usage-"));
    process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    delete process.env.RAINVER_HOST_CONFIG_DIR;
    vi.unstubAllGlobals();
    await rm(configDir, { recursive: true, force: true });
  });

  async function installClaude(credentials: unknown): Promise<void> {
    const tree = join(configDir, "tools", "claude_code", "1.0.0");
    const home = join(tree, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(tree, "manifest.json"), JSON.stringify({
      adapter_type: "claude_code", version: "1.0.0", command: "/bin/true", args: [], env: {},
      home, login_command: null, login: null, installed_at: "",
    }));
    await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify(credentials));
  }

  it("reads the copy's own login and answers with numbers only", async () => {
    await installClaude({ claudeAiOauth: { accessToken: "secret-token", expiresAt: Date.now() + 3_600_000, scopes: ["user:profile"] } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ five_hour: { utilization: 50, resets_at: null } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const quota = await probeUsage({ adapter_type: "claude_code", installation: "managed:1.0.0", login: null, timeout_seconds: 10 });

    expect(quota).toMatchObject({ available: true, session_pct: 50 });
    // The whole point of moving this to the host: the credential is spent
    // here and never travels back.
    expect(JSON.stringify(quota)).not.toContain("secret-token");
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe("Bearer secret-token");
  });

  it("says the login expired instead of spending a dead token", async () => {
    await installClaude({ claudeAiOauth: { accessToken: "stale", expiresAt: Date.now() - 1_000, scopes: [] } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const quota = await probeUsage({ adapter_type: "claude_code", installation: "managed:1.0.0", login: null, timeout_seconds: 10 });

    expect(quota).toMatchObject({ available: false });
    expect(quota.error).toMatch(/expired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a copy this host does not have rather than falling back to the machine's own", async () => {
    const quota = await probeUsage({ adapter_type: "claude_code", installation: "managed:9.9.9", login: null, timeout_seconds: 10 });
    expect(quota.error).toMatch(/does not have claude_code managed:9\.9\.9/);
  });

  it("says a runtime has no subscription quota rather than launching it to find out", async () => {
    const quota = await probeUsage({ adapter_type: "opencode", installation: "own", login: null, timeout_seconds: 10 });
    expect(quota).toMatchObject({ available: false });
    expect(quota.error).toMatch(/no subscription quota/);
  });
});
