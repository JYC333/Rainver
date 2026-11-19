/**
 * The two fixed Google OAuth POSTs for Gmail connections: authorization-code
 * exchange and refresh. Server-only; not a proxy, not Agent-visible. There is
 * no revoke POST: the MVP never revokes a Google grant automatically (a grant
 * is per client + account, so one revoke could cut another Space's or a newer
 * attempt's tokens); the person revokes in their Google Account.
 *
 * Every POST goes through the outbound guard (`fetchGuarded`): HTTPS, exactly
 * the one fixed `oauth2.googleapis.com/token` URL, `maxRedirects: 0` (the body —
 * code, refresh token, client secret — is never replayed), 64 KiB response
 * cap and 10 s deadline. Outcomes carry only a classification and Google's
 * OAuth error code; never a token, the client secret or an upstream body.
 *
 * Each POST takes a required `admit` step that the guard runs in `beforeSend`,
 * after name resolution and pinning, as the last await before the request is
 * dispatched. The caller rechecks current authority there in its own short
 * transaction; a refusal is `not_sent` (no byte left the process). What it
 * cannot close: a writer that commits after `admit` returned and before the
 * bytes are on the wire still sees that one POST go out; the caller's
 * settlement discards its result.
 */
import type { GuardedRequest } from "@rainver/outbound-guard";
import type { GmailOAuthClientConfig } from "../../../config.js";
import { fetchGuarded, outboundGuard, type OutboundGuard } from "../outboundUrlSafety.js";
import { GOOGLE_OAUTH_TOKEN_URL } from "./gmailReadContract.js";

export const GMAIL_OAUTH_RESPONSE_BYTES = 64 * 1024;
export const GMAIL_OAUTH_DEADLINE_MS = 10_000;
const OAUTH_POST_URLS = new Set<string>([GOOGLE_OAUTH_TOKEN_URL]);
const OAUTH_ERROR = /^[a-z_]{1,64}$/;

let guardOverride: OutboundGuard | null = null;
/** Tests inject a DNS-stubbed guard; the block list and transport stay the production ones. */
export function __setGmailOAuthGuardForTests(guard: OutboundGuard | null): void { guardOverride = guard; }

export interface GmailTokenSet {
  access_token: string;
  expires_in: number;
  refresh_token: string | null;
  scope: string | null;
  id_token: string | null;
}

/**
 * `ok`: Google answered 2xx. `refused`: a definite 4xx (no rotation happened).
 * `unavailable`: Google answered 429/5xx. `not_sent`: refused before any byte
 * left this process. `uncertain`: sent, then no complete answer (timeout,
 * network) — the effect may have happened.
 */
export type GmailOAuthOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; status: number; error: string | null }
  | { kind: "unavailable"; status: number }
  | { kind: "not_sent" }
  | { kind: "uncertain" };

async function post(url: string, form: Record<string, string>, admit: () => Promise<void>, signal?: AbortSignal): Promise<GmailOAuthOutcome<{ status: number; bytes: Uint8Array }>> {
  if (!OAUTH_POST_URLS.has(url)) return { kind: "not_sent" };
  let sent = false;
  const request: GuardedRequest = {
    url,
    method: "POST",
    requireHttps: true,
    maxRedirects: 0,
    maxDownloadBytes: GMAIL_OAUTH_RESPONSE_BYTES,
    deadlineMs: GMAIL_OAUTH_DEADLINE_MS,
    readErrorBody: true,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    beforeSend: async (hop) => {
      if (hop.toString() !== url) throw new Error("gmail_oauth_url_refused");
      await admit();
      sent = true;
    },
    ...(signal ? { signal } : {}),
  };
  try {
    const response = await fetchGuarded(request, guardOverride ?? outboundGuard);
    if (response.status >= 300 && response.status < 400) return { kind: "uncertain" };
    if (response.truncated) return response.ok ? { kind: "uncertain" } : { kind: "refused", status: response.status, error: null };
    if (response.ok) return { kind: "ok", value: { status: response.status, bytes: response.bytes } };
    if (response.status === 429 || response.status >= 500) return { kind: "unavailable", status: response.status };
    return { kind: "refused", status: response.status, error: oauthError(response.bytes) };
  } catch {
    return sent ? { kind: "uncertain" } : { kind: "not_sent" };
  }
}

function json(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function oauthError(bytes: Uint8Array): string | null {
  const error = json(bytes)?.error;
  return typeof error === "string" && OAUTH_ERROR.test(error) ? error : null;
}

function tokenSet(bytes: Uint8Array): GmailTokenSet | null {
  const body = json(bytes);
  if (!body) return null;
  const str = (key: string, max: number) => {
    const value = body[key];
    return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
  };
  const access = str("access_token", 4096);
  const expires = body.expires_in;
  const tokenType = str("token_type", 32);
  if (!access || typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0 || tokenType?.toLowerCase() !== "bearer") return null;
  return {
    access_token: access,
    expires_in: Math.min(expires, 86_400),
    refresh_token: str("refresh_token", 4096),
    scope: str("scope", 2048),
    id_token: str("id_token", 16 * 1024),
  };
}

function parsed(outcome: GmailOAuthOutcome<{ status: number; bytes: Uint8Array }>): GmailOAuthOutcome<GmailTokenSet> {
  if (outcome.kind !== "ok") return outcome;
  const tokens = tokenSet(outcome.value.bytes);
  // A 2xx we cannot read may still have issued tokens: treat as uncertain, never as success.
  return tokens ? { kind: "ok", value: tokens } : { kind: "uncertain" };
}

export async function exchangeGmailAuthorizationCode(client: GmailOAuthClientConfig, input: { code: string; codeVerifier: string; admit: () => Promise<void> }, signal?: AbortSignal): Promise<GmailOAuthOutcome<GmailTokenSet>> {
  return parsed(await post(GOOGLE_OAUTH_TOKEN_URL, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  }, input.admit, signal));
}

export async function refreshGmailAccessToken(client: GmailOAuthClientConfig, input: { refreshToken: string; admit: () => Promise<void> }, signal?: AbortSignal): Promise<GmailOAuthOutcome<GmailTokenSet>> {
  return parsed(await post(GOOGLE_OAUTH_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  }, input.admit, signal));
}
