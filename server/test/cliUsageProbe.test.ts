import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __setClaudeOAuthUsageHttpClientForTests,
  __setCodexRpcFactoryForTests,
  __setProbeFactoryForTests,
  parseQuota,
  parseClaudeOAuthUsageResponse,
  parseCodexManagedUsageResponse,
  probeClaudeOAuthQuota,
  probeClaudeOAuthQuotaWithAccessToken,
  type ClaudeOAuthHttpClient,
  probeCodexQuota,
  type CodexRpcFactory,
  type CodexRpcHandle,
  probeClaudeQuota,
  type ProbePtyFactory,
} from "../src/modules/providers";

let tempDir: string | undefined;

afterEach(async () => {
  __setProbeFactoryForTests(null);
  __setCodexRpcFactoryForTests(null);
  __setClaudeOAuthUsageHttpClientForTests(null);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

const FAST = { promptSettleMs: 20, outputSettleMs: 20, pollMs: 5, deadlineMs: 1_000 };
const FAST_RPC = { initializeTimeoutMs: 500, requestTimeoutMs: 500 };
const claudeResolver = { resolveForExecution: async () => ({ executable_path: "claude" }) };
const codexResolver = { resolveForExecution: async () => ({ executable_path: "codex" }) };

const USAGE_SCREEN = [
  "Claude usage this cycle",
  "",
  " Current session",
  " ███████░░░  45% used",
  " Resets 3pm (in 2h)",
  "",
  " Current week (all models)",
  " ████░░░░░░  18% used",
  " Resets Monday 9am",
  "",
].join("\n");

class FakeProbePty {
  written: string[] = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];
  private screen: string;

  constructor(screen: string) {
    this.screen = screen;
  }
  write(data: string): void {
    this.written.push(data);
    // The real CLI renders the bars after `/usage` is submitted.
    if (data.includes("/usage")) {
      setTimeout(() => this.emit(this.screen), 0);
    }
  }
  onData(listener: (d: string) => void): void {
    this.dataListeners.push(listener);
  }
  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener);
  }
  kill(): void {
    for (const l of this.exitListeners) l(0);
  }
  private emit(data: string): void {
    for (const l of this.dataListeners) l(data);
  }
}

// Real Claude Code 2.1.177 output: the TUI uses carriage returns within a row
// and positions text with cursor moves, so after ANSI strip the session header,
// its bar+percent and reset line share one CR-delimited line, and "current
// week (all models)" collapses to "currentweek(allmodels)".
const COLLAPSED_REAL_SCREEN = [
  "Settings  Status   Config   Usage Stats",
  "Session",
  "Totalcost:$0.0000",
  "Usage:0input,0output,0cacheread,0cachewrite",
  "Current session\r████████  79%used\rReses9:40pm (UTC)",
  "Currentweek(allmodels)",
  "████                 18%used",
  "ResetsJun18,4pm(UTC)",
  "Usagecredits",
].join("\n");

describe("parseQuota", () => {
  it("extracts session/week percentages and reset text", () => {
    const q = parseQuota(USAGE_SCREEN);
    expect(q.available).toBe(true);
    expect(q.session_pct).toBe(45);
    expect(q.week_pct).toBe(18);
    expect(q.session_resets).toContain("3pm");
    expect(q.week_resets).toContain("Monday");
    expect(q.error).toBeNull();
  });

  it("parses the real collapsed screen: session and week kept distinct", () => {
    const q = parseQuota(COLLAPSED_REAL_SCREEN);
    expect(q.session_pct).toBe(79);
    expect(q.week_pct).toBe(18);
    expect(q.session_resets).toBe("Resets 9:40pm (UTC)");
    expect(q.week_resets).toBe("Resets Jun18,4pm(UTC)");
    expect(q.available).toBe(true);
  });

  it("flags API-billing accounts that have no subscription bars", () => {
    const q = parseQuota("Account: API Usage Billing\nNo subscription quota available\n");
    expect(q.available).toBe(false);
    expect(q.error).toMatch(/API/i);
  });

  it("degrades to unavailable when nothing parses", () => {
    const q = parseQuota("loading…\n");
    expect(q.available).toBe(false);
    expect(q.session_pct).toBeNull();
    expect(q.error).toBeNull();
  });
});

describe("probeClaudeQuota", () => {
  it("injects /usage, scrapes the rendered screen, and parses the quota", async () => {
    const pty = new FakeProbePty(USAGE_SCREEN);
    const factory: ProbePtyFactory = { spawn: () => pty };
    __setProbeFactoryForTests(factory);

    const result = await probeClaudeQuota("/tmp/aspace-probe-home", claudeResolver, FAST);

    expect(pty.written).toContain("/usage\r");
    expect(result.available).toBe(true);
    expect(result.session_pct).toBe(45);
    expect(result.week_pct).toBe(18);
  });

  it("returns an error result when the runtime tool is missing", async () => {
    __setProbeFactoryForTests({ spawn: () => new FakeProbePty(USAGE_SCREEN) });
    const result = await probeClaudeQuota(
      "/tmp/aspace-probe-home",
      {
        async resolveForExecution() {
          throw new Error("Runtime tool 'claude_code' is not installed.");
        },
      },
      FAST,
    );
    expect(result.available).toBe(false);
    expect(result.error).toContain("not installed");
  });
});

describe("probeClaudeOAuthQuota", () => {
  it("parses Claude OAuth usage windows into session/week quota", () => {
    const result = parseClaudeOAuthUsageResponse({
      five_hour: { utilization: 44.6, resets_at: "2026-06-14T13:00:00Z" },
      seven_day: { utilization: 82.2, resets_at: "2026-06-18T16:00:00Z" },
    });

    expect(result.available).toBe(true);
    expect(result.session_pct).toBe(45);
    expect(result.week_pct).toBe(82);
    expect(result.session_resets).toBe("Resets 2026-06-14T13:00:00.000Z");
    expect(result.week_resets).toBe("Resets 2026-06-18T16:00:00.000Z");
  });

  it("calls the Claude OAuth usage API with the managed profile access token", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-claude-oauth-"));
    const profile = join(tempDir, "profile");
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-token",
          expiresAt: Date.now() + 60_000,
          scopes: ["user:profile"],
        },
      }),
    );

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client: ClaudeOAuthHttpClient = {
      async fetch(url, init) {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          five_hour: { utilization: 12, resets_at: "2026-06-14T13:00:00Z" },
          seven_day: { utilization: 34, resets_at: "2026-06-18T16:00:00Z" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    __setClaudeOAuthUsageHttpClientForTests(client);

    const result = await probeClaudeOAuthQuota(profile);

    expect(result.available).toBe(true);
    expect(result.session_pct).toBe(12);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer oauth-token");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("rejects expired credentials so callers can fall back to PTY", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-claude-oauth-"));
    const profile = join(tempDir, "profile");
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(profile, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-token",
          expiresAt: Date.now() - 1_000,
          scopes: ["user:profile"],
        },
      }),
    );

    await expect(probeClaudeOAuthQuota(profile)).rejects.toThrow(/expired/i);
  });

  it("probes a managed token directly without reading a CLI profile", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    __setClaudeOAuthUsageHttpClientForTests({
      async fetch(url, init) {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          five_hour: { utilization: 7, resets_at: "2026-06-14T13:00:00Z" },
        }), { status: 200 });
      },
    });

    const result = await probeClaudeOAuthQuotaWithAccessToken("managed-access-token");

    expect(result).toMatchObject({ available: true, session_pct: 7 });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization)
      .toBe("Bearer managed-access-token");
  });
});

class FakeCodexRpc implements CodexRpcHandle {
  writes: Array<Record<string, unknown>> = [];
  private stdoutListeners: Array<(d: string) => void> = [];
  private stderrListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];

  write(data: string): void {
    const payload = JSON.parse(data) as Record<string, unknown>;
    this.writes.push(payload);
    const id = payload.id;
    const method = payload.method;
    if (typeof id !== "number" || typeof method !== "string") return;
    if (method === "initialize") {
      setTimeout(() => this.emitStdout({ id, result: {} }), 0);
    } else if (method === "account/rateLimits/read") {
      setTimeout(() => this.emitStdout({
        id,
        result: {
          rateLimits: {
            primary: { usedPercent: 91.4, windowDurationMins: 300, resetsAt: 1_766_000_000 },
            secondary: { usedPercent: 82.2, windowDurationMins: 10_080, resetsAt: 1_766_500_000 },
          },
        },
      }), 0);
    }
  }
  onStdout(listener: (d: string) => void): void {
    this.stdoutListeners.push(listener);
  }
  onStderr(listener: (d: string) => void): void {
    this.stderrListeners.push(listener);
  }
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }
  kill(): void {
    for (const l of this.exitListeners) l(0, null);
  }
  emitStderr(text: string): void {
    for (const l of this.stderrListeners) l(text);
  }
  private emitStdout(value: Record<string, unknown>): void {
    for (const l of this.stdoutListeners) l(`${JSON.stringify(value)}\n`);
  }
}

describe("probeCodexQuota", () => {
  it("maps the managed ChatGPT usage response with the CLI quota semantics", () => {
    const result = parseCodexManagedUsageResponse({
      rate_limit: {
        primary_window: {
          used_percent: 23.6,
          limit_window_seconds: 18_000,
          reset_at: 1_766_000_000,
        },
        secondary_window: {
          used_percent: 67.8,
          limit_window_seconds: 604_800,
          reset_at: 1_766_500_000,
        },
      },
    });

    expect(result).toMatchObject({ available: true, session_pct: 24, week_pct: 68 });
    expect(result.session_resets).toContain("2025");
  });

  it("routes the production quota RPC through the scoped Runner executor", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aspace-codex-runner-probe-"));
    const home = join(tempDir, "home");
    const workspace = join(tempDir, "workspace");
    await mkdir(workspace, { recursive: true });
    const calls: Array<Record<string, unknown>> = [];
    const result = await probeCodexQuota(home, home, codexResolver, FAST_RPC, {
      run_id: "usage-probe-1",
      workspace_cwd: workspace,
      executor: {
        async runCommand(input) {
          calls.push(input as unknown as Record<string, unknown>);
          let closed = false;
          const send = (message: Record<string, unknown>) => {
            if (message.method === "initialize") {
              input.stdio_controller?.receive({ id: 1, result: {} }, send, () => { closed = true; });
            } else if (message.method === "account/rateLimits/read") {
              input.stdio_controller?.receive({
                id: 2,
                result: {
                  rateLimits: {
                    primary: { usedPercent: 12, windowDurationMins: 300 },
                    secondary: { usedPercent: 34, windowDurationMins: 10_080 },
                  },
                },
              }, send, () => { closed = true; });
            }
          };
          input.stdio_controller?.start(send);
          expect(closed).toBe(true);
          return { returncode: 0, stdout: "", stderr: "", timed_out: false };
        },
      },
    });
    expect(result).toMatchObject({ available: true, session_pct: 12, week_pct: 34 });
    expect(calls[0]).toMatchObject({
      cwd: workspace,
      run_id: "usage-probe-1",
      egress_profile: "provider",
      command: ["codex", "-s", "read-only", "-a", "untrusted", "app-server"],
    });
  });

  it("reads Codex app-server rate limits and maps them to session/week quota", async () => {
    const rpc = new FakeCodexRpc();
    const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const factory: CodexRpcFactory = {
      spawn(command, args, options) {
        spawned.push({ command, args, env: options.env });
        return rpc;
      },
    };
    __setCodexRpcFactoryForTests(factory);

    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENAI_API_KEY = "sk-host-should-not-pass";
    process.env.CODEX_HOME = "/host/codex";
    try {
      const result = await probeCodexQuota("/tmp/aspace-codex-profile", "/tmp/aspace-codex-home", codexResolver, FAST_RPC);
      expect(result.available).toBe(true);
      expect(result.session_pct).toBe(91);
      expect(result.week_pct).toBe(82);
      expect(result.session_resets).toContain("2025");
      expect(spawned[0]?.command).toBe("codex");
      expect(spawned[0]?.args).toEqual(["-s", "read-only", "-a", "untrusted", "app-server"]);
      expect(spawned[0]?.env.HOME).toBe("/tmp/aspace-codex-home");
      expect(spawned[0]?.env.CODEX_HOME).toBe("/tmp/aspace-codex-profile");
      expect(spawned[0]?.env.OPENAI_API_KEY).toBeUndefined();
      expect(rpc.writes.map((w) => w.method)).toContain("account/rateLimits/read");
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});
