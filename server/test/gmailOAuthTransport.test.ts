import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOutboundGuard } from "@rainver/outbound-guard";
import { publicAddressGuard } from "./support/outboundGuard.js";
import {
  __setGmailOAuthGuardForTests,
  exchangeGmailAuthorizationCode,
  refreshGmailAccessToken,
} from "../src/modules/sources/gmail/gmailOAuthTransport.js";
import { decryptGmailOAuthSecret, encryptGmailOAuthSecret } from "../src/modules/sources/gmail/gmailCredentialCrypto.js";
import { googleSubjectFromIdToken } from "../src/modules/sources/gmail/gmailIdToken.js";

// The production transport (fetchGuarded → undici pinned fetch → globalThis.fetch); only DNS and the socket are stubbed.
const client = { clientId: "client-123.apps.googleusercontent.com", clientSecret: "gmail-client-secret-fixture", redirectUri: "https://rainver.example/api/v1/sources/gmail/oauth/callback" };
type Sent = { url: string; method?: string; body: string; redirect?: string };
function stub(handler: (sent: Sent) => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "");
    const record = { url: String(url), method: init?.method, body, redirect: init?.redirect };
    sent.push(record);
    return handler(record);
  });
  return sent;
}
const tokenJson = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ access_token: "ya29.fixture-access", expires_in: 3599, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/gmail.readonly", ...extra }), { status: 200, headers: { "content-type": "application/json" } });

const admit = async () => undefined;
const refresh = { refreshToken: "1//r", admit };

beforeEach(() => __setGmailOAuthGuardForTests(publicAddressGuard));
afterEach(() => { __setGmailOAuthGuardForTests(null); vi.restoreAllMocks(); });

it("posts the code exchange as a form body to the fixed token URL, once, without following redirects", async () => {
  const sent = stub(() => tokenJson({ refresh_token: "1//fixture-refresh" }));
  const outcome = await exchangeGmailAuthorizationCode(client, { code: "4/fixture-code", codeVerifier: "v".repeat(43), admit });
  expect(outcome).toMatchObject({ kind: "ok", value: { access_token: "ya29.fixture-access", refresh_token: "1//fixture-refresh", expires_in: 3599 } });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ url: "https://oauth2.googleapis.com/token", method: "POST", redirect: "manual" });
  expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({
    grant_type: "authorization_code", code: "4/fixture-code", code_verifier: "v".repeat(43),
    redirect_uri: client.redirectUri, client_id: client.clientId, client_secret: client.clientSecret,
  });
});

it("classifies refusals, unavailability, redirects, unreadable 2xx and transport failures without leaking bodies", async () => {
  stub(() => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request <secret>" }), { status: 400 }));
  expect(await refreshGmailAccessToken(client, refresh)).toEqual({ kind: "refused", status: 400, error: "invalid_grant" });
  vi.restoreAllMocks();
  stub(() => new Response("busy", { status: 503 }));
  expect(await refreshGmailAccessToken(client, refresh)).toEqual({ kind: "unavailable", status: 503 });
  vi.restoreAllMocks();
  const redirected = stub(() => new Response(null, { status: 307, headers: { location: "https://oauth2.googleapis.com/elsewhere" } }));
  expect(await refreshGmailAccessToken(client, refresh)).toEqual({ kind: "uncertain" });
  expect(redirected).toHaveLength(1);
  vi.restoreAllMocks();
  stub(() => new Response("not json", { status: 200 }));
  expect(await refreshGmailAccessToken(client, refresh)).toEqual({ kind: "uncertain" });
  vi.restoreAllMocks();
  stub(() => { throw new TypeError("socket hang up"); });
  expect(await refreshGmailAccessToken(client, refresh)).toEqual({ kind: "uncertain" });
  vi.restoreAllMocks();
  // The block list still applies: refused before any byte is sent.
  __setGmailOAuthGuardForTests(createOutboundGuard({ lookup: async () => [{ address: "169.254.169.254", family: 4 }] }));
  const none = stub(() => tokenJson());
  expect(await refreshGmailAccessToken(client, refresh)).toEqual({ kind: "not_sent" });
  expect(none).toHaveLength(0);
});

it("runs the admission step after DNS as the last step before the send; a refusal sends nothing", async () => {
  const order: string[] = [];
  __setGmailOAuthGuardForTests({ pin: async (url, signal) => { order.push("pin"); return publicAddressGuard.pin(url, signal); } });
  const sent = stub(() => { order.push("send"); return tokenJson(); });
  expect(await refreshGmailAccessToken(client, { refreshToken: "1//r", admit: async () => { order.push("admit"); } })).toMatchObject({ kind: "ok" });
  expect(order).toEqual(["pin", "admit", "send"]);
  expect(await refreshGmailAccessToken(client, { refreshToken: "1//r", admit: async () => { throw new Error("revoked"); } })).toEqual({ kind: "not_sent" });
  expect(await exchangeGmailAuthorizationCode(client, { code: "4/c", codeVerifier: "v".repeat(43), admit: async () => { throw new Error("revoked"); } })).toEqual({ kind: "not_sent" });
  expect(sent).toHaveLength(1);
});

it("caps the token response at 64 KiB", async () => {
  stub(() => new Response("x".repeat(70 * 1024), { status: 200 }));
  expect(await refreshGmailAccessToken(client, refresh)).toEqual({ kind: "uncertain" });
});

it("binds the gmail_oauth envelope to its credential and connection (AAD)", () => {
  const key = randomBytes(32), secret = { refresh_token: "1//r", access_token: "ya29.a", access_token_expires_at: 1_900_000_000_000 };
  const ref = encryptGmailOAuthSecret(secret, key, { credentialId: "cred-1", connectionId: "conn-1" });
  expect(ref).toMatch(/^gmail_oauth:v1:/);
  expect(ref).not.toContain("ya29");
  expect(decryptGmailOAuthSecret(ref, key, { credentialId: "cred-1", connectionId: "conn-1" })).toEqual(secret);
  expect(() => decryptGmailOAuthSecret(ref, key, { credentialId: "cred-2", connectionId: "conn-1" })).toThrow("gmail_credential_undecryptable");
  expect(() => decryptGmailOAuthSecret(ref, key, { credentialId: "cred-1", connectionId: "conn-2" })).toThrow("gmail_credential_undecryptable");
  expect(() => decryptGmailOAuthSecret(ref, randomBytes(32), { credentialId: "cred-1", connectionId: "conn-1" })).toThrow();
  expect(() => decryptGmailOAuthSecret("model_provider_oauth:v1:abc:def", key, { credentialId: "cred-1", connectionId: "conn-1" })).toThrow("gmail_credential_malformed");
});

it("accepts only a Google ID token for this client that is unexpired and carries a subject", () => {
  const now = Date.UTC(2026, 10, 16);
  const token = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const base = { iss: "https://accounts.google.com", aud: client.clientId, sub: "109876543210", exp: now / 1000 + 600, iat: now / 1000 };
  expect(googleSubjectFromIdToken(token(base), client.clientId, now)).toBe("109876543210");
  expect(googleSubjectFromIdToken(token({ ...base, iss: "accounts.google.com" }), client.clientId, now)).toBe("109876543210");
  for (const bad of [{ iss: "https://evil.example" }, { aud: "other-client" }, { exp: now / 1000 - 3600 }, { sub: undefined }, { sub: "a b" }, { azp: "other" }, { iat: now / 1000 + 3600 }]) {
    expect(googleSubjectFromIdToken(token({ ...base, ...bad }), client.clientId, now)).toBeNull();
  }
  expect(googleSubjectFromIdToken(null, client.clientId, now)).toBeNull();
  expect(googleSubjectFromIdToken("not-a-jwt", client.clientId, now)).toBeNull();
});
