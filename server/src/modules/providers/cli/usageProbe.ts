/**
 * Deterministic PTY parser/test harness for Claude Code quota output.
 *
 * `claude` exposes the Pro/Max usage bars only through the interactive `/usage`
 * slash command (no machine-readable flag), so we drive it the same way the
 * login engine does: spawn the CLI in a PTY, let the TUI settle, inject
 * `/usage`, scrape the rendered screen, then kill the process (claude 2.x does
 * not honor `/exit`). The CLI reports its own subscription usage, so this stays
 * inside the CLI channel. The broker now tries the Claude OAuth usage API first
 * and falls back to this path when credentials/API access are unavailable.
 *
 * TUI scraping is inherently fragile and slow, so this is NEVER on the request
 * path: callers run it on demand / on a schedule and persist the result to a
 * cache that the UI reads. A failed probe returns an "unavailable" result and
 * the caller keeps the last good cache. Production no longer invokes this
 * file-capable CLI fallback in the application-server namespace; live Claude
 * quota refresh uses the server-owned OAuth API path.
 */

import { mkdir } from "node:fs/promises";

export interface QuotaResult {
  available: boolean;
  session_pct: number | null;
  session_resets: string | null;
  week_pct: number | null;
  week_resets: string | null;
  checked_at: string | null;
  error: string | null;
  /**
   * How `checked_at` was obtained. Both the scheduled probe and a Run
   * piggyback write into this same cache, so a consumer (e.g. autonomous
   * admission's audit trace) must read this rather than guess from runtime
   * type — a `claude_code` value can come from either path.
   */
  source?: "live_probe" | "run_piggyback";
}

export interface ProbePtyHandle {
  write(data: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface ProbePtyFactory {
  spawn(
    command: string,
    args: string[],
    options: { cols: number; rows: number; env: Record<string, string> },
  ): ProbePtyHandle;
}

export interface ProbeToolResolver {
  resolveForExecution(runtime: string): Promise<{ executable_path: string }>;
}

export interface ProbeTimings {
  /** Min wait after spawn before injecting `/usage` (lets the TUI render). */
  promptSettleMs: number;
  /** Screen must be quiet this long before we trust the scraped data. */
  outputSettleMs: number;
  pollMs: number;
  deadlineMs: number;
}

const DEFAULT_TIMINGS: ProbeTimings = {
  promptSettleMs: 1_500,
  outputSettleMs: 1_200,
  pollMs: 200,
  deadlineMs: 90_000,
};

// PTY auth/usage screens are wide; don't let the terminal wrap the bars.
const PROBE_COLS = 220;
const PROBE_ROWS = 50;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

let ptyFactoryOverride: ProbePtyFactory | null = null;

export function __setProbeFactoryForTests(factory: ProbePtyFactory | null): void {
  ptyFactoryOverride = factory;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function defaultPtyFactory(): Promise<ProbePtyFactory> {
  throw new Error("Interactive Claude quota fallback is disabled outside the scoped Sandbox Runner.");
}

/**
 * Parse the rendered `/usage` screen into session/week percentages + reset text.
 * Tolerant of layout drift: it keys on the "current session"/"current week"
 * section headers and flexible "N% used" / "resets …" lines, and degrades to an
 * unavailable result rather than throwing.
 */
export function parseQuota(raw: string): QuotaResult {
  // Claude's TUI redraws rows with carriage returns and positions text with
  // cursor moves (the spaces you see are cursor jumps, not space chars). After
  // stripping ANSI those rows collapse, so: split on CR *and* LF to separate a
  // header / bar+percent / reset line, and match headers space-insensitively.
  const lines = stripAnsi(raw)
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const result = emptyQuota();

  // claude.ai subscription accounts show usage bars; API-billing org accounts do not.
  if (lines.some((l) => l.toLowerCase().includes("api usage billing"))) {
    result.error =
      "Authenticated to an Anthropic API account (API Usage Billing). Re-authenticate with a Claude.ai subscription to see quota.";
    return result;
  }

  const despace = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  let section: "session" | "week" | null = null;
  for (const line of lines) {
    const d = despace(line);
    if (d.includes("currentsession")) {
      section = "session";
      continue;
    }
    if (d.includes("currentweek")) {
      section = "week";
      continue;
    }
    if (!section) continue;

    const pct = line.match(/(\d+)\s*%\s*used/i);
    if (pct) {
      const value = Number(pct[1]);
      if (section === "session" && result.session_pct === null) result.session_pct = value;
      else if (section === "week" && result.week_pct === null) result.week_pct = value;
      continue;
    }

    // "Resets …" — tolerate the collapsed/clipped forms ("ResetsJun18…", "Reses9:40pm").
    if (/^rese[t]?s/i.test(line)) {
      const resets = `Resets ${line.replace(/^rese[t]?s/i, "").trim()}`;
      if (section === "session" && !result.session_resets) result.session_resets = resets;
      else if (section === "week" && !result.week_resets) result.week_resets = resets;
    }
  }

  result.available = result.session_pct !== null || result.week_pct !== null;
  return result;
}

/** Has the screen rendered enough quota data to stop early? */
function screenHasQuota(raw: string): { full: boolean; partial: boolean } {
  // Space-insensitive: the rendered screen collapses spaces ("currentweek").
  const d = stripAnsi(raw).toLowerCase().replace(/\s+/g, "");
  const pctCount = (d.match(/%used/g) ?? []).length;
  const full = d.includes("currentweek") && pctCount >= 2;
  const partial = pctCount >= 1 || d.includes("currentsession");
  return { full, partial };
}

/**
 * Run `claude` in a PTY, inject `/usage`, scrape and parse the result.
 *
 * @param loginHome  aspace-managed HOME holding the synced credentials, so the
 *                   CLI authenticates without touching the host home.
 */
export async function probeClaudeQuota(
  loginHome: string,
  toolResolver: ProbeToolResolver,
  timings: ProbeTimings = DEFAULT_TIMINGS,
): Promise<QuotaResult> {
  let executable: string;
  try {
    executable = (await toolResolver.resolveForExecution("claude_code")).executable_path;
  } catch (error) {
    const result = emptyQuota();
    result.error = error instanceof Error ? error.message : "Claude runtime tool is not installed.";
    return result;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = env.TERM || "xterm-256color";
  env.HOME = loginHome;
  // An API key forces Claude Code into API-billing mode, which hides the bars.
  delete env.ANTHROPIC_API_KEY;

  await mkdir(loginHome, { recursive: true, mode: 0o700 });

  const factory = ptyFactoryOverride ?? (await defaultPtyFactory());
  const handle = factory.spawn(executable, [], { cols: PROBE_COLS, rows: PROBE_ROWS, env });

  let raw = "";
  let lastOutputAt = Date.now();
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    handle.onExit(() => {
      exited = true;
      resolve();
    });
  });
  handle.onData((data) => {
    raw += data;
    lastOutputAt = Date.now();
  });

  const deadline = Date.now() + timings.deadlineMs;
  try {
    // Step 1: let the REPL render, then inject /usage once output settles.
    const promptDeadline = Date.now() + timings.promptSettleMs;
    while (!exited && Date.now() < promptDeadline) {
      await Promise.race([exitPromise, sleep(timings.pollMs)]);
      if (Date.now() - lastOutputAt > timings.outputSettleMs) break;
    }
    try {
      handle.write("/usage\r");
    } catch {
      // PTY closed early; parse whatever we have.
    }
    const usageSentAt = Date.now();

    // Step 2: wait for the quota bars to render and settle.
    while (!exited && Date.now() < deadline) {
      await Promise.race([exitPromise, sleep(timings.pollMs)]);
      const now = Date.now();
      const settled = now - lastOutputAt > timings.outputSettleMs;
      const { full, partial } = screenHasQuota(raw);
      if (full && settled) break;
      if (partial && settled && now - usageSentAt > 3 * timings.outputSettleMs) break;
    }
  } finally {
    handle.kill();
    await Promise.race([exitPromise, sleep(2_000)]);
  }

  return parseQuota(raw);
}
