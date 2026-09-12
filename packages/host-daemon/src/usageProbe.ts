import { spawn } from "node:child_process";
import { helperProcessEnv } from "./providerBinding.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostUsageQuota, RuntimeLoginSpec } from "@rainver/protocol";
import { OWN_INSTALLATION, readToolManifestSync, type ToolManifest } from "./tools.js";

/**
 * What one copy's subscription has left, read on the host that holds it.
 *
 * This used to run beside the server, against a credential the broker had
 * copied into a profile directory it owned. Credentials live with the copy now
 * (ADR 0016 §7), so the control plane has nothing left to read — asking the
 * host is the only way to answer "how much of this subscription is gone".
 * Vendor-specific by necessity: a quota is only readable the way its vendor
 * exposes it. What crosses back is percentages and reset times; the token is
 * read here, spent against the vendor's own endpoint, and never returned,
 * logged, or written anywhere else.
 */
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
/**
 * Codex's own machine-readable endpoint, read-only and never-approve so the
 * probe cannot act. `-a untrusted` was ported from the deleted server-side
 * reader and this Codex rejects it outright ("possible values: on-request,
 * never"), which cost the whole probe.
 */
const CODEX_APP_SERVER_ARGS = ["-s", "read-only", "-a", "never", "app-server"];

function emptyQuota(): HostUsageQuota {
  return { available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: null };
}

function failed(error: string): HostUsageQuota {
  return { ...emptyQuota(), error };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Consumed capacity, rounded. Deliberately not clamped at 100: an account past
 * its limit reports more than that, and showing it as exactly 100 hides the
 * one state a person most needs to see.
 */
function pct(value: number): number {
  return Math.max(0, Math.round(value));
}

/** Where this copy keeps its login: machine HOME for `own`, stable managed HOME otherwise. */
function copyHome(adapterType: string, installation: string): { home: string; manifest: ToolManifest | null } | null {
  if (installation === OWN_INSTALLATION) return { home: homedir(), manifest: null };
  const manifest = readToolManifestSync(adapterType, installation);
  return manifest ? { home: manifest.home, manifest } : null;
}

// --- Claude Code -----------------------------------------------------------

interface OAuthWindow {
  utilization: number;
  resetsAt: string | null;
}

function parseOAuthWindow(value: unknown): OAuthWindow | null {
  const obj = asRecord(value);
  const utilization = num(obj?.utilization);
  if (utilization === null) return null;
  return { utilization, resetsAt: typeof obj?.resets_at === "string" ? obj.resets_at : null };
}

function oauthResetText(window: OAuthWindow | null): string | null {
  if (!window?.resetsAt) return null;
  const parsed = Date.parse(window.resetsAt);
  return `Resets ${Number.isFinite(parsed) ? new Date(parsed).toISOString() : window.resetsAt}`;
}

/** Exported for testing: the vendor's response body never leaves this process. */
export function parseClaudeOAuthUsage(value: unknown): HostUsageQuota {
  const root = asRecord(value);
  const result = emptyQuota();
  if (!root) return result;
  const session = parseOAuthWindow(root.five_hour);
  const week = parseOAuthWindow(root.seven_day ?? root.seven_day_oauth_apps);
  if (session) {
    result.session_pct = pct(session.utilization);
    result.session_resets = oauthResetText(session);
  }
  if (week) {
    result.week_pct = pct(week.utilization);
    result.week_resets = oauthResetText(week);
  }
  result.available = result.session_pct !== null || result.week_pct !== null;
  return result;
}

async function probeClaude(home: string, login: RuntimeLoginSpec | null, timeoutSeconds: number): Promise<HostUsageQuota> {
  const credentialPath = join(home, login?.home_subdir ?? ".claude", login?.credential_file ?? ".credentials.json");
  let accessToken: string;
  try {
    const oauth = asRecord(asRecord(JSON.parse(await readFile(credentialPath, "utf8")))?.claudeAiOauth);
    accessToken = typeof oauth?.accessToken === "string" ? oauth.accessToken.trim() : "";
    if (!accessToken) return failed("Log in to Claude Code on this host before reading usage.");
    const expiresAt = num(oauth?.expiresAt);
    if (expiresAt === null || Date.now() >= expiresAt) return failed("This copy's Claude login has expired; log in again.");
    const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes.filter((item): item is string => typeof item === "string") : [];
    if (scopes.length > 0 && !scopes.includes("user:profile")) return failed("This copy's Claude login cannot read usage (missing user:profile scope).");
  } catch {
    return failed("Log in to Claude Code on this host before reading usage.");
  }
  // The control plane budgets its own wait on the host giving up first, so a
  // bare fetch — which would hang to the HTTP client's own multi-minute
  // default — would leave the daemon answering a request nobody is holding.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(1, timeoutSeconds) * 1000);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetch(CLAUDE_OAUTH_USAGE_URL, {
      // Not followed: this carries the owner's OAuth access token, and a
      // redirect is the upstream asking for it to be sent somewhere else.
      redirect: "error",
      method: "GET",
      signal: abort.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
        "User-Agent": "claude-code/2.1.0",
      },
    });
  } catch (error) {
    return failed(abort.signal.aborted
      ? "Claude usage API did not answer in time."
      : `Claude usage API was unreachable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return failed(`Claude usage API returned HTTP ${response.status}.`);
  let quota: HostUsageQuota;
  try {
    quota = parseClaudeOAuthUsage(await response.json());
  } catch {
    return failed("Claude usage API returned a response this host could not read.");
  }
  return quota.available ? quota : failed("Claude usage API returned no quota windows.");
}

// --- Codex CLI -------------------------------------------------------------

interface RpcWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

function parseRpcWindow(value: unknown): RpcWindow | null {
  const obj = asRecord(value);
  const usedPercent = num(obj?.usedPercent);
  if (usedPercent === null) return null;
  return { usedPercent, windowDurationMins: num(obj?.windowDurationMins), resetsAt: num(obj?.resetsAt) };
}

/** The same numbers as they appear in a refusal's echoed API body, which uses the HTTP field names. */
function parseApiWindow(value: unknown): RpcWindow | null {
  const obj = asRecord(value);
  const usedPercent = num(obj?.used_percent);
  if (usedPercent === null) return null;
  const windowSeconds = num(obj?.limit_window_seconds);
  return {
    usedPercent,
    resetsAt: num(obj?.reset_at),
    windowDurationMins: windowSeconds === null ? null : Math.round(windowSeconds / 60),
  };
}

/**
 * Codex names its two windows `primary` and `secondary` without saying which
 * is which, and the order is not stable across versions. The durations are:
 * five hours is the session, a week is the week.
 */
function windowRole(window: RpcWindow): "session" | "week" | "unknown" {
  if (window.windowDurationMins === 300) return "session";
  if (window.windowDurationMins === 10_080) return "week";
  return "unknown";
}

function normalizeWindows(primary: RpcWindow | null, secondary: RpcWindow | null): { session: RpcWindow | null; week: RpcWindow | null } {
  if (primary && secondary) {
    const primaryRole = windowRole(primary);
    const secondaryRole = windowRole(secondary);
    if ((primaryRole === "session" && secondaryRole !== "session") || (primaryRole === "unknown" && secondaryRole === "week")) {
      return { session: primary, week: secondary };
    }
    if ((primaryRole === "week" && secondaryRole !== "week") || (primaryRole === "unknown" && secondaryRole === "session")) {
      return { session: secondary, week: primary };
    }
    return { session: primary, week: secondary };
  }
  if (primary) return windowRole(primary) === "week" ? { session: null, week: primary } : { session: primary, week: null };
  if (secondary) return windowRole(secondary) === "week" ? { session: null, week: secondary } : { session: secondary, week: null };
  return { session: null, week: null };
}

function rpcResetText(window: RpcWindow | null): string | null {
  if (!window?.resetsAt) return null;
  return `Resets ${new Date(window.resetsAt * 1000).toISOString()}`;
}

function quotaFromWindows(primary: RpcWindow | null, secondary: RpcWindow | null): HostUsageQuota {
  const result = emptyQuota();
  const { session, week } = normalizeWindows(primary, secondary);
  if (session) {
    result.session_pct = pct(session.usedPercent);
    result.session_resets = rpcResetText(session);
  }
  if (week) {
    result.week_pct = pct(week.usedPercent);
    result.week_resets = rpcResetText(week);
  }
  result.available = result.session_pct !== null || result.week_pct !== null;
  return result;
}

/** Exported for testing: `account/rateLimits/read`'s result. */
export function quotaFromRateLimitsResult(result: unknown): HostUsageQuota {
  const limits = asRecord(asRecord(result)?.rateLimits);
  if (!limits) return emptyQuota();
  return quotaFromWindows(parseRpcWindow(limits.primary), parseRpcWindow(limits.secondary));
}

function extractJSONObject(after: string, text: string): string | null {
  const marker = text.indexOf(after);
  if (marker < 0) return null;
  const start = text.indexOf("{", marker + after.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * An account over its limit gets its rate-limit call refused — with the
 * numbers in the refusal. Reading only successful results reported "quota
 * unavailable" for exactly the accounts whose quota mattered most.
 */
export function quotaFromRefusal(message: string): HostUsageQuota {
  const json = extractJSONObject("body=", message);
  if (!json) return emptyQuota();
  try {
    const rateLimit = asRecord((JSON.parse(json) as Record<string, unknown>).rate_limit);
    if (!rateLimit) return emptyQuota();
    return quotaFromWindows(parseApiWindow(rateLimit.primary_window), parseApiWindow(rateLimit.secondary_window));
  } catch {
    return emptyQuota();
  }
}

/**
 * How to enter this copy's **vendor CLI**, before any subcommand.
 *
 * Not `manifest.entry_args`: that is the ACP adapter this copy launches for a
 * Run (`codex-acp`), which is a different program and answers an app-server
 * request with `-32600 Invalid request`. The vendor CLI is the one the login
 * command enters, so it is derived from the login spec — `command` and
 * `managed_command` describe the same invocation and differ only in how many
 * elements name the CLI itself, so dropping the subcommand `command` carries
 * leaves exactly the managed entry (`["codex","login","--device-auth"]` has
 * two trailing subcommand arguments, so Codex's four-element managed command
 * enters with its first two).
 */
export function managedCliEntry(manifest: ToolManifest | null): { command: string; args: string[] } | null {
  if (!manifest) return { command: "codex", args: [] };
  const managed = manifest.login_command;
  const subcommand = (manifest.login?.command?.length ?? 0) - 1;
  if (!managed || subcommand < 0 || managed.length - subcommand < 1) return null;
  const entry = managed.slice(0, managed.length - subcommand);
  return { command: entry[0]!, args: entry.slice(1) };
}

/**
 * The environment Codex's app-server reads its own login from. The whole
 * `CODEX_` prefix is dropped so the machine's shell cannot redirect the probe
 * at a different profile than the one the copy runs with, and the whole
 * `OPENAI_` prefix because an API key answers with the key's quota, not the
 * subscription's — a silently wrong number is worse than none. Both by prefix,
 * through the daemon's one helper rule; naming `OPENAI_API_KEY` alone left
 * every other spelling of it in place.
 */
function codexEnv(home: string, extra: Record<string, string>): Record<string, string> {
  // The daemon's one helper rule rather than this probe's own two-line version
  // of it: `codex_cli` drops `OPENAI_`/`CODEX_`, which is what this listed.
  const env: Record<string, string> = helperProcessEnv(process.env, "codex_cli");
  Object.assign(env, extra);
  env.HOME = home;
  env.CODEX_HOME = join(home, ".codex");
  env.TERM = "dumb";
  return env;
}

function probeCodex(home: string, manifest: ToolManifest | null, timeoutSeconds: number): Promise<HostUsageQuota> {
  const entry = managedCliEntry(manifest);
  if (!entry) return Promise.resolve(failed("Reinstall this managed copy of Codex before reading usage."));
  return new Promise((resolve) => {
    const child = spawn(entry.command, [...entry.args, ...CODEX_APP_SERVER_ARGS], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: codexEnv(home, manifest?.env ?? {}),
    });
    let settled = false;
    let buffer = "";
    let stderr = "";
    const finish = (quota: HostUsageQuota) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve(quota);
    };
    /** A refusal carries the numbers; fall back to it before reporting the error text. */
    const finishWithFailure = (message: string) => {
      const recovered = quotaFromRefusal(message);
      finish(recovered.available ? recovered : failed(message));
    };
    const timer = setTimeout(
      () => finishWithFailure(stderr.trim() || "Codex did not answer its rate-limit request in time."),
      Math.max(1, timeoutSeconds) * 1000,
    );
    timer.unref?.();
    child.on("error", (error) => finish(failed(`Codex could not be started: ${error.message}`)));
    child.on("close", () => finishWithFailure(stderr.trim() || "Codex exited before reporting its rate limits."));
    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded: a refusal body is small, and a chatty CLI must not grow this
      // without limit while the probe waits out its timeout.
      if (stderr.length < 65_536) stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      // A line this long is not a JSON-RPC message; keeping only the tail
      // stops a child that emits carriage-return progress from growing this
      // without bound while the probe waits out its timeout.
      buffer = (lines.pop() ?? "").slice(-65_536);
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown> | null;
        try {
          message = asRecord(JSON.parse(line));
        } catch {
          continue;
        }
        // A JSON-RPC error for an unparseable or unrecognised request carries
        // `id: null`, so filtering on the ids we sent threw away the one
        // message that said what was wrong and left the probe to time out
        // naming nothing. Errors are read whatever id they carry.
        if (!message) continue;
        const error = asRecord(message.error);
        if (!error && message.id !== 1 && message.id !== 2) continue;
        if (error) {
          // Checked before the handshake branch: an `initialize` that fails is
          // the real reason, and continuing past it only produced a timeout
          // that named the wrong thing.
          finishWithFailure(typeof error.message === "string"
            ? error.message
            : message.id === 1 ? "Codex refused to start its app-server." : "Codex refused the rate-limit request.");
          return;
        }
        if (message.id === 1) {
          child.stdin?.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin?.write(`${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: {} })}\n`);
          continue;
        }
        const quota = quotaFromRateLimitsResult(message.result);
        finish(quota.available ? quota : failed("Codex reported no rate-limit windows."));
        return;
      }
    });
    child.stdin?.on("error", () => finish(failed("Codex closed its input before the rate-limit request was sent.")));
    child.stdin?.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "rainver", version: "0.0.0" } } })}\n`);
  });
}

// --- Entry point -----------------------------------------------------------

export type UsageProbeFrame = {
  adapter_type: string;
  installation: string;
  login: RuntimeLoginSpec | null;
  timeout_seconds: number;
};

export async function probeUsage(frame: UsageProbeFrame): Promise<HostUsageQuota> {
  const copy = copyHome(frame.adapter_type, frame.installation);
  if (!copy) return failed(`This host does not have ${frame.adapter_type} ${frame.installation} installed.`);
  if (frame.adapter_type === "claude_code") return probeClaude(copy.home, frame.login ?? copy.manifest?.login ?? null, frame.timeout_seconds);
  if (frame.adapter_type === "codex_cli") return probeCodex(copy.home, copy.manifest, frame.timeout_seconds);
  // OpenCode bills through whichever provider it is pointed at, and a registry
  // Agent's limits are its own product's business. Neither has a subscription
  // quota this host could read; saying so beats an empty panel that reads as a
  // failure.
  return { ...emptyQuota(), error: `${frame.adapter_type} reports no subscription quota.` };
}
