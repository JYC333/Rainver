/**
 * Gmail push intake: `POST /api/v1/sources/gmail/push`, called by the
 * configured Pub/Sub push subscription. Unauthenticated by session; it is
 * accepted only with a Google-signed OIDC token:
 *
 * - `Authorization: Bearer <JWT>`, RS256, `kid` found in Google's JWKS
 *   (`https://www.googleapis.com/oauth2/v3/certs`, fetched through the
 *   outbound guard, 64 KiB, no redirects, cached by `max-age` within 5 min–6 h,
 *   refetched at most once a minute for an unknown `kid`);
 * - `iss` Google, `aud` exactly `GMAIL_PUBSUB_PUSH_AUDIENCE`, `email` exactly
 *   the configured push service account with `email_verified`, `exp` in the
 *   future and `iat` not ahead (60 s skew), lifetime ≤ 1 h;
 * - the body (≤ 8 KiB) names exactly the configured subscription.
 *
 * The notification is only a wake-up. Its `historyId` is never trusted or
 * stored; only `emailAddress` selects which connections to sync, and the sync
 * reads changes from the persisted cursor. Every accepted, well-formed or not,
 * answers 204 so Pub/Sub does not redeliver; an authentication failure is 401
 * and touches nothing. Not configured → 404.
 */
import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";
import type { GmailPushConfig } from "../../../config.js";
import { fetchGuarded, outboundGuard, type OutboundGuard } from "../outboundUrlSafety.js";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs" as const;
export const GMAIL_PUSH_BODY_LIMIT = 8 * 1024;
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const SKEW_S = 60;

let guardOverride: OutboundGuard | null = null;
let clock: () => number = () => Date.now();
export function __setGmailPushForTests(input: { guard?: OutboundGuard | null; clock?: (() => number) | null } | null): void {
  if (input === null) { guardOverride = null; clock = () => Date.now(); jwks = null; lastFetchAt = 0; return; }
  if (input.guard !== undefined) guardOverride = input.guard;
  if (input.clock !== undefined) clock = input.clock ?? (() => Date.now());
  jwks = null; lastFetchAt = 0;
}

let jwks: { keys: Map<string, JsonWebKey>; expiresAt: number } | null = null;
let lastFetchAt = 0;

async function fetchJwks(): Promise<void> {
  lastFetchAt = clock();
  const response = await fetchGuarded({
    url: GOOGLE_JWKS_URL, method: "GET", requireHttps: true, maxRedirects: 0, maxDownloadBytes: 64 * 1024, deadlineMs: 10_000,
    headers: { accept: "application/json" },
  }, guardOverride ?? outboundGuard);
  if (!response.ok || response.truncated) throw new Error("gmail_push_jwks_unavailable");
  const body = JSON.parse(new TextDecoder().decode(response.bytes)) as { keys?: unknown };
  const keys = new Map<string, JsonWebKey>();
  for (const key of Array.isArray(body.keys) ? body.keys : []) {
    const k = key as Record<string, unknown>;
    if (k.kty === "RSA" && typeof k.kid === "string" && typeof k.n === "string" && typeof k.e === "string" && (k.alg === undefined || k.alg === "RS256")) {
      keys.set(k.kid, { kty: "RSA", n: k.n, e: k.e });
    }
  }
  const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
  const ttl = Math.min(Math.max(Number(maxAge ?? 0) * 1000, 5 * 60_000), 6 * 60 * 60_000);
  jwks = { keys, expiresAt: clock() + ttl };
}

async function keyFor(kid: string): Promise<JsonWebKey | null> {
  if (!jwks || jwks.expiresAt <= clock()) await fetchJwks();
  let key = jwks!.keys.get(kid) ?? null;
  if (!key && clock() - lastFetchAt > 60_000) {
    await fetchJwks();
    key = jwks!.keys.get(kid) ?? null;
  }
  return key;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** True only for a Google-signed token for exactly this push subscription's audience and service account. */
export async function verifyGmailPushToken(config: GmailPushConfig, authorization: string | undefined): Promise<boolean> {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match || authorization!.length > 8192) return false;
  const [, headerPart, payloadPart, signaturePart] = match as unknown as [string, string, string, string];
  const header = decodeJson(headerPart);
  const claims = decodeJson(payloadPart);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 128) return false;
  let jwk: JsonWebKey | null;
  try { jwk = await keyFor(header.kid); } catch { return false; }
  if (!jwk) return false;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  let valid = false;
  try { valid = verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signaturePart, "base64url")); } catch { return false; }
  if (!valid) return false;
  const now = Math.floor(clock() / 1000);
  const exp = claims.exp, iat = claims.iat;
  return typeof claims.iss === "string" && GOOGLE_ISSUERS.has(claims.iss)
    && claims.aud === config.audience
    && typeof claims.email === "string" && claims.email.toLowerCase() === config.serviceAccountEmail
    && claims.email_verified === true
    && typeof exp === "number" && typeof iat === "number"
    && exp > now - SKEW_S && iat <= now + SKEW_S && exp - iat <= 3600 + SKEW_S;
}

/** The mailbox a well-formed push names, or null. `historyId` is read for shape only and dropped. */
export function gmailPushMailbox(config: GmailPushConfig, body: unknown): string | null {
  const envelope = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (envelope.subscription !== config.subscriptionName) return null;
  const message = typeof envelope.message === "object" && envelope.message !== null ? envelope.message as Record<string, unknown> : {};
  if (typeof message.data !== "string" || message.data.length > 4096) return null;
  const data = decodeJson(message.data.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
  const email = data?.emailAddress;
  return typeof email === "string" && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null;
}
