/**
 * How much of a *managed subscription* is left.
 *
 * The in-process channel's half of quota reading, and all that remains of it
 * on the server. A managed subscription's OAuth credential is held here (ADR
 * 0008 — managed subscriptions stay the in-process channel), so the token is
 * already in memory and the vendor's endpoint is one HTTP call away.
 *
 * The CLI half moved to the host that holds the copy's login
 * (`packages/host-daemon/src/usageProbe.ts`, ADR 0016 §7). Nothing here reads
 * a filesystem profile any more, and nothing here launches a CLI.
 */

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";

export interface QuotaResult {
  available: boolean;
  session_pct: number | null;
  session_resets: string | null;
  week_pct: number | null;
  week_resets: string | null;
  checked_at: string | null;
  error: string | null;
}

export function emptyQuota(): QuotaResult {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isoResetText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return `Resets ${Number.isFinite(parsed) ? new Date(parsed).toISOString() : value}`;
}

function epochResetText(value: number | null): string | null {
  return value ? `Resets ${new Date(value * 1000).toISOString()}` : null;
}

/** Anthropic's OAuth usage response: a five-hour session window and a seven-day one. */
export function parseClaudeOAuthUsageResponse(value: unknown): QuotaResult {
  const root = asRecord(value);
  const result = emptyQuota();
  if (!root) return result;
  const session = asRecord(root.five_hour);
  const week = asRecord(root.seven_day ?? root.seven_day_oauth_apps);
  const sessionUtilization = num(session?.utilization);
  const weekUtilization = num(week?.utilization);
  if (sessionUtilization !== null) {
    result.session_pct = pct(sessionUtilization);
    result.session_resets = isoResetText(session?.resets_at);
  }
  if (weekUtilization !== null) {
    result.week_pct = pct(weekUtilization);
    result.week_resets = isoResetText(week?.resets_at);
  }
  result.available = result.session_pct !== null || result.week_pct !== null;
  return result;
}

/** The caller owns refresh and supplies only the in-memory access token. */
export async function probeClaudeOAuthQuotaWithAccessToken(accessToken: string): Promise<QuotaResult> {
  if (!accessToken.trim()) throw new Error("Claude OAuth access token is missing.");
  const response = await fetch(CLAUDE_OAUTH_USAGE_URL, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      "User-Agent": "claude-code/2.1.0",
    },
  });
  if (!response.ok) throw new Error(`Claude OAuth usage API returned HTTP ${response.status}.`);
  const result = parseClaudeOAuthUsageResponse(await response.json());
  if (!result.available) throw new Error("Claude OAuth usage API returned no quota windows.");
  return result;
}

/** One window of ChatGPT's `/wham/usage` response, whose windows are named by their length. */
function parseWhamWindow(value: unknown): { usedPercent: number; resetsAt: number | null; windowMins: number | null } | null {
  const obj = asRecord(value);
  const usedPercent = num(obj?.used_percent);
  if (usedPercent === null) return null;
  const windowSeconds = num(obj?.limit_window_seconds);
  return {
    usedPercent,
    resetsAt: num(obj?.reset_at),
    windowMins: windowSeconds === null ? null : Math.round(windowSeconds / 60),
  };
}

/**
 * The direct ChatGPT `/wham/usage` response for a managed Codex subscription.
 *
 * `primary`/`secondary` do not say which window is which and their order has
 * changed between releases, so the five-hour and week-long durations decide.
 */
export function parseCodexManagedUsageResponse(value: unknown): QuotaResult {
  const root = asRecord(value);
  const rateLimit = asRecord(root?.rate_limit ?? root?.rateLimit);
  const result = emptyQuota();
  if (!rateLimit) return result;
  const windows = [
    parseWhamWindow(rateLimit.primary_window ?? rateLimit.primaryWindow),
    parseWhamWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow),
  ].filter((window): window is NonNullable<typeof window> => window !== null);
  const week = windows.find((window) => window.windowMins === 10_080)
    ?? (windows.length > 1 ? windows[1] : null);
  const session = windows.find((window) => window !== week) ?? null;
  if (session) {
    result.session_pct = pct(session.usedPercent);
    result.session_resets = epochResetText(session.resetsAt);
  }
  if (week) {
    result.week_pct = pct(week.usedPercent);
    result.week_resets = epochResetText(week.resetsAt);
  }
  result.available = result.session_pct !== null || result.week_pct !== null;
  return result;
}
