/**
 * Subscription-quota probe for Codex CLI.
 *
 * CodexBar reads Codex subscription usage through Codex's machine-readable
 * `app-server` JSON-RPC endpoint. We use the same provider-specific path here:
 * launch `codex -s read-only -a untrusted app-server`, initialize the RPC
 * session, and call `account/rateLimits/read`. This avoids scraping the TUI
 * while keeping the credential access inside the Codex CLI profile channel.
 */

import { mkdir } from "node:fs/promises";
import type { ProbeToolResolver, QuotaResult } from "./usageProbe";
import type { CliCommandExecutor, CliStdioController } from "../../runs/localCliExecution";

export interface CodexRpcHandle {
  write(data: string): void;
  onStdout(listener: (data: string) => void): void;
  onStderr(listener: (data: string) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

export interface CodexRpcFactory {
  spawn(
    command: string,
    args: string[],
    options: { env: Record<string, string> },
  ): CodexRpcHandle;
}

export interface CodexRpcTimings {
  initializeTimeoutMs: number;
  requestTimeoutMs: number;
}

interface RpcWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface RpcRateLimits {
  primary?: RpcWindow | null;
  secondary?: RpcWindow | null;
}

const DEFAULT_TIMINGS: CodexRpcTimings = {
  initializeTimeoutMs: 8_000,
  requestTimeoutMs: 5_000,
};

const CODEX_APP_SERVER_ARGS = ["-s", "read-only", "-a", "untrusted", "app-server"];

let codexRpcFactoryOverride: CodexRpcFactory | null = null;

export function __setCodexRpcFactoryForTests(factory: CodexRpcFactory | null): void {
  codexRpcFactoryOverride = factory;
}

function emptyQuota(): QuotaResult {
  return {
    available: false,
    session_pct: null,
    session_resets: null,
    week_pct: null,
    week_resets: null,
    checked_at: null,
    error: null,
  };
}

function codexProbeEnv(codexHome: string, loginHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.OPENAI_API_KEY;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_")) delete env[key];
  }
  env.HOME = loginHome;
  env.CODEX_HOME = codexHome;
  env.TERM = env.TERM || "xterm-256color";
  return env;
}

function requestPayload(id: number, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ id, method, params })}\n`;
}

function notificationPayload(method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ method, params })}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRpcWindow(value: unknown): RpcWindow | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const usedPercent = num(obj.usedPercent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    windowDurationMins: num(obj.windowDurationMins),
    resetsAt: num(obj.resetsAt),
  };
}

function parseRateLimits(result: unknown): RpcRateLimits | null {
  const root = asRecord(result);
  const limits = asRecord(root?.rateLimits);
  if (!limits) return null;
  return {
    primary: parseRpcWindow(limits.primary),
    secondary: parseRpcWindow(limits.secondary),
  };
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

function parseRateLimitsFromError(message: string): RpcRateLimits | null {
  const json = extractJSONObject("body=", message);
  if (!json) return null;
  try {
    const body = JSON.parse(json) as Record<string, unknown>;
    const rateLimit = asRecord(body.rate_limit);
    if (!rateLimit) return null;
    return {
      primary: parseApiWindow(rateLimit.primary_window),
      secondary: parseApiWindow(rateLimit.secondary_window),
    };
  } catch {
    return null;
  }
}

function parseApiWindow(value: unknown): RpcWindow | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const usedPercent = num(obj.used_percent);
  const resetAt = num(obj.reset_at);
  const windowSeconds = num(obj.limit_window_seconds);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    resetsAt: resetAt,
    windowDurationMins: windowSeconds === null ? null : Math.round(windowSeconds / 60),
  };
}

function windowRole(window: RpcWindow): "session" | "week" | "unknown" {
  if (window.windowDurationMins === 300) return "session";
  if (window.windowDurationMins === 10_080) return "week";
  return "unknown";
}

function normalizeWindows(
  primary: RpcWindow | null | undefined,
  secondary: RpcWindow | null | undefined,
): { session: RpcWindow | null; week: RpcWindow | null } {
  if (primary && secondary) {
    const primaryRole = windowRole(primary);
    const secondaryRole = windowRole(secondary);
    if (
      (primaryRole === "session" && (secondaryRole === "week" || secondaryRole === "unknown")) ||
      (primaryRole === "unknown" && secondaryRole === "week")
    ) {
      return { session: primary, week: secondary };
    }
    if (
      (primaryRole === "week" && (secondaryRole === "session" || secondaryRole === "unknown")) ||
      (primaryRole === "unknown" && secondaryRole === "session")
    ) {
      return { session: secondary, week: primary };
    }
    return { session: primary, week: secondary };
  }
  if (primary) {
    return windowRole(primary) === "week"
      ? { session: null, week: primary }
      : { session: primary, week: null };
  }
  if (secondary) {
    return windowRole(secondary) === "week"
      ? { session: null, week: secondary }
      : { session: secondary, week: null };
  }
  return { session: null, week: null };
}

function pct(value: number): number {
  return Math.max(0, Math.round(value));
}

function resetText(window: RpcWindow | null): string | null {
  if (!window?.resetsAt) return null;
  return `Resets ${new Date(window.resetsAt * 1000).toISOString()}`;
}

function quotaFromRateLimits(rateLimits: RpcRateLimits | null): QuotaResult {
  const result = emptyQuota();
  if (!rateLimits) return result;
  const { session, week } = normalizeWindows(rateLimits.primary, rateLimits.secondary);
  if (session) {
    result.session_pct = pct(session.usedPercent);
    result.session_resets = resetText(session);
  }
  if (week) {
    result.week_pct = pct(week.usedPercent);
    result.week_resets = resetText(week);
  }
  result.available = result.session_pct !== null || result.week_pct !== null;
  return result;
}

class CodexRpcSession {
  private nextId = 1;
  private lineBuffer = "";
  private stderr = "";
  private exited = false;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private handle: CodexRpcHandle) {
    handle.onStdout((data) => this.onStdout(data));
    handle.onStderr((data) => {
      this.stderr += data;
    });
    handle.onExit((code, signal) => {
      this.exited = true;
      const reason = code === null
        ? `Codex RPC process exited${signal ? ` (${signal})` : ""}`
        : `Codex RPC process exited with code ${code}`;
      this.rejectAll(new Error(this.stderr.trim() || reason));
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error("Codex RPC process is not running."));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(new Error(`Codex RPC timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.handle.write(requestPayload(id, method, params));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.exited) return;
    this.handle.write(notificationPayload(method, params));
  }

  kill(): void {
    this.handle.kill();
  }

  private onStdout(data: string): void {
    this.lineBuffer += data;
    for (;;) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (!line) continue;
      this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const error = asRecord(message.error);
    if (error) {
      const messageText = typeof error.message === "string"
        ? error.message
        : `${pending.method} failed`;
      pending.reject(new Error(messageText));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export async function probeCodexQuota(
  codexHome: string,
  loginHome: string,
  toolResolver: ProbeToolResolver,
  timings: CodexRpcTimings = DEFAULT_TIMINGS,
  runner?: { executor: CliCommandExecutor; run_id: string; workspace_cwd: string; proxy_url?: string },
): Promise<QuotaResult> {
  let executable: string;
  try {
    executable = (await toolResolver.resolveForExecution("codex_cli")).executable_path;
  } catch (error) {
    const result = emptyQuota();
    result.error = error instanceof Error ? error.message : "Codex runtime tool is not installed.";
    return result;
  }

  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(loginHome, { recursive: true, mode: 0o700 });

  if (!codexRpcFactoryOverride) {
    if (!runner) {
      const result = emptyQuota();
      result.error = "Codex quota probing requires the scoped Sandbox Runner.";
      return result;
    }
    return await probeCodexQuotaWithRunner(executable, codexHome, loginHome, timings, runner);
  }
  const factory = codexRpcFactoryOverride;
  let session: CodexRpcSession | null = null;
  try {
    const handle = factory.spawn(executable, CODEX_APP_SERVER_ARGS, {
      env: codexProbeEnv(codexHome, loginHome),
    });
    session = new CodexRpcSession(handle);
    await session.request(
      "initialize",
      { clientInfo: { name: "agent-space", version: "0.0.0" } },
      timings.initializeTimeoutMs,
    );
    session.notify("initialized");
    const result = await session.request("account/rateLimits/read", {}, timings.requestTimeoutMs);
    return quotaFromRateLimits(parseRateLimits(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recovered = quotaFromRateLimits(parseRateLimitsFromError(message));
    if (recovered.available) return recovered;
    const result = emptyQuota();
    result.error = message || "Codex usage probe failed.";
    return result;
  } finally {
    session?.kill();
  }
}

async function probeCodexQuotaWithRunner(
  executable: string,
  codexHome: string,
  loginHome: string,
  timings: CodexRpcTimings,
  runner: { executor: CliCommandExecutor; run_id: string; workspace_cwd: string; proxy_url?: string },
): Promise<QuotaResult> {
  const controller = new CodexQuotaController();
  const timeoutMs = timings.initializeTimeoutMs + timings.requestTimeoutMs + 2_000;
  const execution = await runner.executor.runCommand({
    command: [executable, ...CODEX_APP_SERVER_ARGS],
    cwd: runner.workspace_cwd,
    timeout_seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
    env: {
      HOME: loginHome,
      CODEX_HOME: codexHome,
      TERM: "dumb",
      ...(runner.proxy_url ? { HTTP_PROXY: runner.proxy_url, HTTPS_PROXY: runner.proxy_url } : {}),
    },
    run_id: runner.run_id,
    scope_id: runner.run_id,
    stdin: null,
    stdio_controller: controller,
    egress_profile: "provider",
  });
  if (controller.rateLimits) return quotaFromRateLimits(parseRateLimits(controller.rateLimits));
  const recovered = quotaFromRateLimits(parseRateLimitsFromError(controller.error ?? execution.stderr));
  if (recovered.available) return recovered;
  const result = emptyQuota();
  result.error = controller.error ?? (execution.stderr || "Codex usage probe failed.");
  return result;
}

class CodexQuotaController implements CliStdioController {
  rateLimits: unknown = null;
  error: string | null = null;
  private completed = false;

  start(send: (message: Record<string, unknown>) => void): void {
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-space", version: "0.0.0" } } });
  }

  receive(message: Record<string, unknown>, send: (message: Record<string, unknown>) => void, closeStdin: () => void): void {
    const error = asRecord(message.error);
    if (error) {
      this.error = typeof error.message === "string" ? error.message : "Codex quota RPC failed.";
      closeStdin();
      return;
    }
    if (message.id === 1) {
      send({ method: "initialized", params: {} });
      send({ id: 2, method: "account/rateLimits/read", params: {} });
      return;
    }
    if (message.id === 2) {
      this.rateLimits = message.result;
      this.completed = true;
      closeStdin();
    }
  }

  reject(message: string): void { this.error = message; }
  result(): { completed: boolean; error: string | null; text: string } {
    return { completed: this.completed, error: this.error, text: "" };
  }
}
