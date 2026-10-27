import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostUsageQuota, RuntimeStateBoundary } from "@rainver/protocol";

// Data-source and grouped-window design reference: steipete/CodexBar,
// AntigravityRemoteUsageFetcher.swift and AntigravityQuotaSummaryParser.swift.
// Independent implementation; credentials remain on this execution host.
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const empty = (error: string | null): HostUsageQuota => ({
  available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error,
});
function remaining(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? (1 - v) * 100 : null;
}
function reset(v: unknown): string | null {
  const value = text(v);
  return value && Number.isFinite(Date.parse(value)) ? `Resets ${new Date(value).toISOString()}` : null;
}

export function parseAntigravityQuota(value: unknown): HostUsageQuota {
  const root = record(value);
  const payload = record(root?.response) ?? record(root?.summary) ?? root;
  const windows: NonNullable<HostUsageQuota["windows"]> = [];
  const cadences = new Map<string, string>();
  if (Array.isArray(payload?.groups)) {
    for (const groupValue of payload.groups) {
      const group = record(groupValue);
      if (!Array.isArray(group?.buckets)) continue;
      for (const bucketValue of group.buckets) {
        const bucket = record(bucketValue);
        if (!bucket || bucket.disabled === true) continue;
        const id = text(bucket.bucketId) ?? text(bucket.id);
        if (!id || windows.some(w => w.id === id)) continue;
        const used = remaining(bucket.remainingFraction ?? record(bucket.remaining)?.remainingFraction);
        windows.push({
          id: id.slice(0, 256),
          label: `${text(group.displayName) ?? text(group.name) ?? "Quota"} · ${(text(bucket.displayName) ?? text(bucket.name) ?? id).replace(/\s+remaining$/i, "")}`.slice(0, 256),
          used_pct: used, resets: reset(bucket.resetTime),
        });
        cadences.set(id.slice(0, 256), text(bucket.window) ?? id);
      }
    }
  } else if (Array.isArray(payload?.buckets)) {
    // Legacy endpoint explicitly reports measured quota buckets, not model availability.
    for (const value of payload.buckets) {
      const bucket = record(value);
      const id = text(bucket?.modelId);
      if (!id) continue;
      const next = { id: id.slice(0, 256), label: id.slice(0, 256), used_pct: remaining(bucket?.remainingFraction), resets: reset(bucket?.resetTime) };
      const prior = windows.find(w => w.id === next.id);
      if (!prior) windows.push(next);
      else if (next.used_pct !== null && (prior.used_pct === null || next.used_pct > prior.used_pct)) Object.assign(prior, next);
    }
  }
  const result = empty(null);
  result.windows = windows.slice(0, 64);
  result.available = result.windows.some(w => w.used_pct !== null);
  // Aggregate only explicit cadences; model buckets are not assumed to be weekly.
  for (const window of result.windows) {
    if (window.used_pct === null) continue;
    const cadence = cadences.get(window.id) ?? "";
    if (/weekly|seven.day/i.test(cadence) && window.used_pct >= (result.week_pct ?? -1)) {
      result.week_pct = window.used_pct; result.week_resets = window.resets;
    } else if (/5h|five.hour/i.test(cadence) && window.used_pct >= (result.session_pct ?? -1)) {
      result.session_pct = window.used_pct; result.session_resets = window.resets;
    }
  }
  return result;
}

export async function probeAntigravity(home: string, state: RuntimeStateBoundary | null, seconds: number): Promise<HostUsageQuota> {
  let credential: Record<string, unknown> | null;
  try {
    credential = record(JSON.parse(await readFile(join(home, state?.home_subdir ?? ".gemini/antigravity-acp", state?.credential_file ?? "acp_token.json"), "utf8")));
  } catch {
    return empty("Log in to this Antigravity ACP copy before reading usage.");
  }
  // ACP stores authorized-user refresh credentials. Never discover another CLI's account,
  // trust a token_uri from disk, persist refreshed secrets, or start interactive onboarding.
  const refreshToken = text(credential?.refresh_token);
  const clientId = text(credential?.client_id);
  const clientSecret = text(credential?.client_secret);
  if (!refreshToken || !clientId || !clientSecret) return empty("This Antigravity login cannot read quota; log in again.");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(1, seconds) * 1000);
  timer.unref?.();
  try {
    const auth = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: abort.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    });
    if (!auth.ok) return empty(`Antigravity token refresh failed (HTTP ${auth.status}); log in again.`);
    const token = text(record(await auth.json())?.access_token);
    if (!token) return empty("Antigravity returned no access token.");
    const body = JSON.stringify(text(credential?.project_id) ? { project: text(credential?.project_id) } : {});
    for (const [index, endpoint] of [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    ].entries()) {
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: abort.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": `antigravity/hub/2.9.1 ${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}` },
        body,
      });
      if (response.status === 401) return empty("Antigravity rejected this login; log in again.");
      if (!response.ok) {
        if (index === 0) continue;
        return empty(response.status === 403 ? "Antigravity does not permit quota inspection for this account." : `Antigravity quota API returned HTTP ${response.status}.`);
      }
      const quota = parseAntigravityQuota(await response.json());
      if (quota.available) return quota;
    }
    return empty("Antigravity returned no measured quota. Login status does not establish remaining capacity.");
  } catch {
    return empty(abort.signal.aborted ? "Antigravity quota check timed out." : "Antigravity quota service could not be read.");
  } finally { clearTimeout(timer); }
}
