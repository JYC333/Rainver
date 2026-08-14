/**
 * Claude subscription-quota probe through Claude's OAuth usage API.
 *
 * This is the primary path used before the PTY `/usage` fallback. It reads only
 * the aspace-managed Claude Code profile (`.credentials.json`) and sends the
 * access token to Anthropic's OAuth usage endpoint. No credential material is
 * returned or logged through the public API.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { QuotaResult } from "./usageProbe";

export interface ClaudeOAuthHttpClient {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

interface ClaudeOAuthCredentials {
  accessToken: string;
  expiresAt: number | null;
  scopes: string[];
}

interface OAuthUsageWindow {
  utilization: number;
  resetsAt: string | null;
}

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CREDENTIALS_FILE = ".credentials.json";

let httpClientOverride: ClaudeOAuthHttpClient | null = null;

export function __setClaudeOAuthUsageHttpClientForTests(client: ClaudeOAuthHttpClient | null): void {
  httpClientOverride = client;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCredentials(raw: string): ClaudeOAuthCredentials {
  const root = asRecord(JSON.parse(raw));
  const oauth = asRecord(root?.claudeAiOauth);
  const accessToken = typeof oauth?.accessToken === "string"
    ? oauth.accessToken.trim()
    : "";
  if (!accessToken) throw new Error("Claude OAuth access token is missing.");
  const expiresAt = typeof oauth?.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
    ? oauth.expiresAt
    : null;
  const scopes = Array.isArray(oauth?.scopes)
    ? oauth.scopes.filter((item): item is string => typeof item === "string")
    : [];
  return { accessToken, expiresAt, scopes };
}

async function loadCredentials(profileDir: string): Promise<ClaudeOAuthCredentials> {
  return parseCredentials(await readFile(join(profileDir, CLAUDE_CREDENTIALS_FILE), "utf8"));
}

function validateCredentials(credentials: ClaudeOAuthCredentials): void {
  if (credentials.expiresAt === null || Date.now() >= credentials.expiresAt) {
    throw new Error("Claude OAuth access token is expired.");
  }
  if (credentials.scopes.length > 0 && !credentials.scopes.includes("user:profile")) {
    throw new Error("Claude OAuth token is missing user:profile scope.");
  }
}

function parseWindow(value: unknown): OAuthUsageWindow | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const utilization = typeof obj.utilization === "number" && Number.isFinite(obj.utilization)
    ? obj.utilization
    : null;
  if (utilization === null) return null;
  return {
    utilization,
    resetsAt: typeof obj.resets_at === "string" ? obj.resets_at : null,
  };
}

function pct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resetText(window: OAuthUsageWindow | null): string | null {
  if (!window?.resetsAt) return null;
  const parsed = Date.parse(window.resetsAt);
  return `Resets ${Number.isFinite(parsed) ? new Date(parsed).toISOString() : window.resetsAt}`;
}

export function parseClaudeOAuthUsageResponse(value: unknown): QuotaResult {
  const root = asRecord(value);
  const result = emptyQuota();
  if (!root) return result;

  const session = parseWindow(root.five_hour);
  const week = parseWindow(root.seven_day ?? root.seven_day_oauth_apps);

  if (session) {
    result.session_pct = pct(session.utilization);
    result.session_resets = resetText(session);
  }
  if (week) {
    result.week_pct = pct(week.utilization);
    result.week_resets = resetText(week);
  }

  result.available = result.session_pct !== null || result.week_pct !== null;
  return result;
}

function defaultHttpClient(): ClaudeOAuthHttpClient {
  return {
    fetch: (url, init) => fetch(url, init),
  };
}

export async function probeClaudeOAuthQuota(profileDir: string): Promise<QuotaResult> {
  const credentials = await loadCredentials(profileDir);
  validateCredentials(credentials);

  return probeClaudeOAuthQuotaWithAccessToken(credentials.accessToken);
}

/** Managed subscription path: the caller owns refresh and supplies only the
 * in-memory access token. This never reads a CLI profile. */
export async function probeClaudeOAuthQuotaWithAccessToken(accessToken: string): Promise<QuotaResult> {
  if (!accessToken.trim()) throw new Error("Claude OAuth access token is missing.");

  const client = httpClientOverride ?? defaultHttpClient();
  const response = await client.fetch(CLAUDE_OAUTH_USAGE_URL, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      "User-Agent": "claude-code/2.1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Claude OAuth usage API returned HTTP ${response.status}.`);
  }
  const result = parseClaudeOAuthUsageResponse(await response.json());
  if (!result.available) {
    throw new Error("Claude OAuth usage API returned no quota windows.");
  }
  return result;
}
