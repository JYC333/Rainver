import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { publicAddressGuard } from "./support/outboundGuard.js";
import { sourcesModule } from "../src/modules/sources/index.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { __setGmailOAuthGuardForTests } from "../src/modules/sources/gmail/gmailOAuthTransport.js";
import { __setGmailProfileGuardForTests } from "../src/modules/sources/gmail/gmailOAuthFlow.js";
import { __setGmailRefreshClockForTests, resolveGmailAccessToken } from "../src/modules/sources/gmail/gmailTokenRefresh.js";
import { gmailQuotaGroups } from "../src/modules/sources/gmail/gmailQuota.js";
import { gmailConnectionRegistrations } from "../src/modules/sources/gmail/gmailOperations.js";
import { lockGmailOwnerSpace } from "../src/modules/sources/gmail/gmailConnections.js";
import { loadSystemActionRegistry } from "../src/modules/systemActions/registry.js";
import { lockActivePerson } from "../src/modules/access/activePerson.js";
import type { OperationActor, RegisteredSystemActionDefinition } from "@rainver/protocol";
import type { PoolClient } from "pg";

// Real PostgreSQL, real routes, operation core, broker and outbound guard; only Google is stubbed at globalThis.fetch.
// The MVP never revokes a Google grant automatically: the stub has no revoke endpoint, and every test that
// could have revoked asserts that nothing was sent there.
const db = useTestDatabase(import.meta.filename);
const CLIENT_ID = "gmail-client.apps.googleusercontent.com";
const CLIENT_SECRET = "gmail-client-secret-fixture";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
let config: ServerConfig, app: ReturnType<typeof buildModuleServer>, space: string, owner: string, peer: string;

type Call = { url: string; method: string; body: string; auth?: string };
type Google = {
  calls: Call[];
  token: (form: URLSearchParams) => Response | Promise<Response>;
  profile: () => Response | Promise<Response>;
};
let google: Google;
const idToken = (sub: string, aud = CLIENT_ID) => `e30.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
const tokens = (sub: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  access_token: `ya29.access-${randomUUID()}`, expires_in: 3599, token_type: "Bearer", scope: `openid ${READONLY}`,
  id_token: idToken(sub), refresh_token: `1//refresh-${randomUUID()}`, ...extra,
}), { status: 200 });

beforeEach(async () => {
  await resetTables(db.pool, ["spaces", "users", "credentials", "source_request_quota_state"], { cascade: true });
  space = randomUUID(); owner = randomUUID(); peer = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner, project: randomUUID(), spaceType: "team" });
  await seedSpaceMember(db.pool, { space, user: peer });
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: mkdtempSync(join(tmpdir(), "rainver-gmail-")),
    GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GMAIL_OAUTH_REDIRECT_URI: "http://localhost:3000/api/v1/sources/gmail/oauth/callback",
  });
  app = buildModuleServer(config, [sourcesModule, systemActionsModule]);
  __setAuthIdentityForTests({ spaceId: space, userId: owner });
  __setGmailOAuthGuardForTests(publicAddressGuard);
  __setGmailProfileGuardForTests(publicAddressGuard);
  google = { calls: [], token: () => new Response("{}", { status: 500 }), profile: () => new Response(JSON.stringify({ emailAddress: "owner@gmail.example", messagesTotal: 1 }), { status: 200 }) };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url: String(url), method: String(init?.method), body, auth: headers.authorization };
    google.calls.push(call);
    if (call.url === "https://oauth2.googleapis.com/token") return google.token(new URLSearchParams(body));
    if (call.url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return google.profile();
    throw new Error(`unexpected request ${call.url}`);
  });
});
afterEach(async () => {
  __setAuthIdentityForTests(null); __setGmailOAuthGuardForTests(null); __setGmailProfileGuardForTests(null); __setGmailRefreshClockForTests(null);
  vi.restoreAllMocks();
  await app?.close();
});

const as = (userId: string) => __setAuthIdentityForTests({ spaceId: space, userId });
async function start(reconnect?: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: reconnect ? { reconnect_connection_id: reconnect } : {} });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers["cache-control"]).toMatch(/no-store.*private|private.*no-store/);
  const url = new URL(res.json().authorize_url as string);
  return { url, state: url.searchParams.get("state")!, challenge: url.searchParams.get("code_challenge")! };
}
async function callback(query: Record<string, string>) {
  const res = await app.inject({ method: "GET", url: `/api/v1/sources/gmail/oauth/callback?${new URLSearchParams(query)}` });
  expect(res.statusCode, res.body).toBe(303);
  const location = new URL(String(res.headers.location));
  expect([...location.searchParams.keys()]).toEqual(["gmail"]);
  return location.searchParams.get("gmail");
}
/** Starts and completes one OAuth attempt; `token` shapes Google's token response for the subject. */
async function connect(sub: string, opts: { reconnect?: string; token?: (sub: string) => Response } = {}) {
  const attempt = await start(opts.reconnect);
  google.token = (form) => {
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(attempt.challenge);
    return (opts.token ?? ((s) => tokens(s)))(sub);
  };
  return { result: await callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY }), attempt };
}
const connections = async () => (await db.pool.query("SELECT * FROM gmail_connections ORDER BY created_at, id")).rows;
const gmailCredentials = async () => (await db.pool.query("SELECT id,owner_user_id,space_id,secret_ref,scopes_json,metadata_json FROM credentials WHERE credential_type='gmail_oauth'")).rows;
const op = (method: "POST" | "DELETE", connectionId: string, key = randomUUID()) => app.inject({
  method, url: method === "POST" ? `/api/v1/sources/gmail/connections/${connectionId}/disconnect` : `/api/v1/sources/gmail/connections/${connectionId}`,
  headers: { "idempotency-key": key },
});
/** The generic operation entry, the same core command without the REST adapter. */
const action = (operation: string, connectionId: string, key = randomUUID()) => app.inject({
  method: "POST", url: `/api/v1/actions/${operation}`, headers: { "idempotency-key": key }, payload: { connection_id: connectionId },
});
const revokeCalls = () => google.calls.filter((c) => c.url.endsWith("/revoke"));
const codeExchanges = () => google.calls.filter((c) => c.url.endsWith("/token") && new URLSearchParams(c.body).get("grant_type") === "authorization_code");
const setMembership = (userId: string, status: string) => db.pool.query("UPDATE space_memberships SET status=$3 WHERE space_id=$1 AND user_id=$2", [space, userId, status]);
const DISCONNECTED = { status: "disconnected", remote_revocation: "not_requested", manual_revocation_url: "https://myaccount.google.com/connections" } as const;
/** A held Google response: `open()` lets it through. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

it("refuses to start without configuration and reports configured=false", async () => {
  await app.close();
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: config.rainverHome }), [sourcesModule]);
  const res = await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: {} });
  expect(res.statusCode).toBe(503);
  expect(res.json().error.code).toBe("gmail_not_configured");
  expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/connections" })).json()).toEqual({ configured: false, connections: [] });
  expect(await callback({ state: "x".repeat(43), code: "c" })).toBe("gmail_not_configured");
  expect(google.calls).toEqual([]);
});

it("starts with openid+gmail.readonly, offline consent, S256 PKCE and a stored state hash only", async () => {
  const { url, state } = await start();
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: CLIENT_ID, redirect_uri: "http://localhost:3000/api/v1/sources/gmail/oauth/callback", response_type: "code",
    scope: `openid ${READONLY}`, access_type: "offline", prompt: "consent", include_granted_scopes: "false", code_challenge_method: "S256",
  });
  expect(url.toString()).not.toContain(CLIENT_SECRET);
  const rows = (await db.pool.query("SELECT * FROM gmail_oauth_attempts")).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].state_sha256).toBe(createHash("sha256").update(state).digest("hex"));
  expect(JSON.stringify(rows)).not.toContain(state);
  // A new start supersedes the person's earlier unconsumed attempt.
  await start();
  expect((await db.pool.query("SELECT 1 FROM gmail_oauth_attempts")).rows).toHaveLength(1);
});

it("installs a private connection once per attempt; the callback cannot be replayed or used by another person", async () => {
  const attempt = await start();
  google.token = () => tokens("1001");
  const code = `4/code-${randomUUID()}`;
  // Another signed-in person cannot consume the owner's attempt, and it stays usable for the owner.
  as(peer);
  expect(await callback({ state: attempt.state, code })).toBe("gmail_oauth_state_invalid");
  as(owner);
  expect(await callback({ state: attempt.state, code })).toBe("connected");
  const posts = google.calls.filter((c) => c.method === "POST");
  expect(posts).toHaveLength(1);
  // Replay: the consumed state is refused before any token exchange.
  expect(await callback({ state: attempt.state, code })).toBe("gmail_oauth_state_invalid");
  expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  // The profile read is the only Gmail GET, sent with the fresh access token.
  expect(google.calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/profile"]);

  const [row] = await connections();
  expect(row).toMatchObject({ owner_user_id: owner, space_id: space, google_subject: "1001", mailbox_email: "owner@gmail.example", status: "active", generation: 1 });
  expect(row).not.toHaveProperty("revocation_status");
  const [credential] = await gmailCredentials();
  expect(credential).toMatchObject({ id: row.credential_id, owner_user_id: owner, space_id: space, metadata_json: {} });
  expect(credential.secret_ref).toMatch(/^gmail_oauth:v1:/);
  expect(credential.scopes_json).toEqual(["openid", READONLY].sort());
  // No code, token or state is stored anywhere in these tables.
  const dump = JSON.stringify({ c: await connections(), k: await gmailCredentials(), a: (await db.pool.query("SELECT * FROM gmail_oauth_attempts")).rows });
  expect(dump).not.toContain(code);
  expect(dump).not.toContain("ya29.");
  expect(dump).not.toContain("1//refresh");

  const list = await app.inject({ method: "GET", url: "/api/v1/sources/gmail/connections" });
  expect(list.headers["cache-control"]).toMatch(/no-store.*private|private.*no-store/);
  expect(list.json()).toEqual({ configured: true, connections: [expect.objectContaining({ id: row.id, mailbox_email: "owner@gmail.example", status: "active" })] });
  expect(list.body).not.toContain("1001");
  // Another Space member sees nothing and cannot act on it or reconnect through it.
  as(peer);
  expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/connections" })).json().connections).toEqual([]);
  expect((await op("POST", row.id)).statusCode).toBe(404);
  expect((await op("DELETE", row.id)).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: { reconnect_connection_id: row.id } })).statusCode).toBe(404);
});

it("refuses expired attempts, denial, bad identity, wrong scopes and missing refresh tokens; refused fresh tokens are discarded, never revoked", async () => {
  const expired = await start();
  await db.pool.query("UPDATE gmail_oauth_attempts SET expires_at=now()-interval '1 second'");
  expect(await callback({ state: expired.state, code: "c" })).toBe("gmail_oauth_state_invalid");
  const denied = await start();
  expect(await callback({ state: denied.state, error: "access_denied" })).toBe("gmail_oauth_denied");
  expect(google.calls).toEqual([]);

  const cases: [string, (sub: string) => Response][] = [
    ["gmail_identity_invalid", (s) => tokens(s, { id_token: idToken(s, "another-client") })],
    ["gmail_scope_excess", (s) => tokens(s, { scope: `openid ${READONLY} https://www.googleapis.com/auth/gmail.send` })],
    ["gmail_scope_missing", (s) => tokens(s, { scope: "openid" })],
    ["gmail_refresh_token_missing", (s) => tokens(s, { refresh_token: undefined })],
  ];
  for (const [code, token] of cases) {
    google.calls = [];
    expect(await connect("2002", { token }).then((r) => r.result)).toBe(code);
    expect(codeExchanges()).toHaveLength(1);
    expect(revokeCalls()).toEqual([]);
  }
  // Exchange failure, and an unreadable profile, leave nothing behind.
  google.calls = [];
  expect(await connect("2002", { token: () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) }).then((r) => r.result)).toBe("gmail_oauth_exchange_failed");
  google.profile = () => new Response("nope", { status: 500 });
  expect(await connect("2002").then((r) => r.result)).toBe("gmail_profile_unavailable");
  expect(await connections()).toEqual([]);
  expect(await gmailCredentials()).toEqual([]);
});

it("reconnects the same account into the same row, replaces the credential, and never moves a row to another account", async () => {
  expect((await connect("3003")).result).toBe("connected");
  const [first] = await connections();
  const [firstCredential] = await gmailCredentials();
  // Same account, Google omits the refresh token: the proven account keeps its stored one, the credential row is replaced.
  expect((await connect("3003", { reconnect: first.id, token: (s) => tokens(s, { refresh_token: undefined }) })).result).toBe("connected");
  const [again] = await connections();
  const [secondCredential] = await gmailCredentials();
  expect(again).toMatchObject({ id: first.id, generation: 2, status: "active" });
  expect(secondCredential.id).not.toBe(firstCredential.id);
  expect((await db.pool.query("SELECT 1 FROM credentials WHERE id=$1", [firstCredential.id])).rows).toEqual([]);
  // A reconnect that signs in as a different Google account is refused and the row is untouched.
  google.calls = [];
  expect((await connect("4004", { reconnect: first.id })).result).toBe("gmail_account_mismatch");
  expect(revokeCalls()).toEqual([]);
  expect((await connections())[0]).toMatchObject({ id: first.id, google_subject: "3003", generation: 2, credential_id: secondCredential.id });
  // Without reconnect, another account is another row.
  expect((await connect("4004")).result).toBe("connected");
  expect((await connections()).map((r) => r.google_subject)).toEqual(["3003", "4004"]);
});

it("disconnects locally only: no Google request, credential and attempts gone, receipt says remote revocation was not requested", async () => {
  await connect("5005");
  const [row] = await connections();
  expect((await op("DELETE", row.id)).json().error.code).toBe("operation_conflict");
  // An outstanding reconnect attempt of the owner dies with the disconnect.
  await start(row.id);
  google.calls = [];
  const key = randomUUID();
  const res = await op("POST", row.id, key);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data).toEqual({ connection_id: row.id, space_id: space, generation: 2, ...DISCONNECTED });
  expect(google.calls).toEqual([]);
  expect(await gmailCredentials()).toEqual([]);
  expect((await db.pool.query("SELECT 1 FROM gmail_oauth_attempts")).rows).toEqual([]);
  expect((await connections())[0]).toMatchObject({ status: "disconnected", credential_id: null, generation: 2 });
  // No background work is left behind for this disconnect.
  expect((await db.pool.query("SELECT job_type FROM jobs")).rows).toEqual([]);
  // Same-key replay returns the receipt without any request; a fresh disconnect is a conflict.
  const replay = await op("POST", row.id, key);
  expect(replay.statusCode).toBe(200);
  expect(replay.json().data).toEqual(res.json().data);
  expect((await op("POST", row.id)).statusCode).toBe(409);
  expect(google.calls).toEqual([]);
  // Forget deletes the row immediately; no receipt or job record carries a secret.
  const forgot = await op("DELETE", row.id);
  expect(forgot.statusCode, forgot.body).toBe(200);
  expect(forgot.json().data).toEqual({ connection_id: row.id, space_id: space, forgotten: true });
  expect(await connections()).toEqual([]);
  const stored = JSON.stringify([
    (await db.pool.query("SELECT * FROM operation_idempotency")).rows,
    (await db.pool.query("SELECT * FROM jobs")).rows,
    (await db.pool.query("SELECT * FROM job_events")).rows,
  ]);
  expect(stored).not.toContain("1//refresh");
  expect(stored).not.toContain("ya29.");
});

it("refreshes once per connection, settles only for the current generation, and handles invalid_grant and transient failures", async () => {
  await connect("6006");
  const [row] = await connections();
  const snapshot = { connectionId: row.id, ownerUserId: owner, spaceId: space, generation: row.generation };
  // Fresh token: no refresh.
  google.calls = [];
  await resolveGmailAccessToken(config, db.pool, snapshot);
  expect(google.calls).toEqual([]);
  // Expired: concurrent resolves share one POST.
  __setGmailRefreshClockForTests(() => Date.now() + 2 * 3600_000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  google.token = async (form) => {
    expect(form.get("grant_type")).toBe("refresh_token");
    await gate;
    return new Response(JSON.stringify({ access_token: "ya29.refreshed", expires_in: 3599, token_type: "Bearer", scope: `openid ${READONLY}` }), { status: 200 });
  };
  const both = Promise.all([resolveGmailAccessToken(config, db.pool, snapshot), resolveGmailAccessToken(config, db.pool, snapshot)]);
  await vi.waitFor(() => expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1));
  release();
  __setGmailRefreshClockForTests(() => Date.now());
  expect(await both).toEqual(["ya29.refreshed", "ya29.refreshed"]);
  expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  const [credential] = await gmailCredentials();
  expect(credential.metadata_json).toEqual({});

  // Transient: recorded, then backed off without another POST.
  __setGmailRefreshClockForTests(() => Date.now() + 4 * 3600_000);
  google.calls = [];
  google.token = () => new Response("busy", { status: 503 });
  await expect(resolveGmailAccessToken(config, db.pool, snapshot)).rejects.toMatchObject({ code: "gmail_refresh_unavailable" });
  await expect(resolveGmailAccessToken(config, db.pool, snapshot)).rejects.toMatchObject({ code: "gmail_refresh_unavailable" });
  expect(google.calls).toHaveLength(1);
  expect((await connections())[0]).toMatchObject({ status: "active", last_error_class: "transient", generation: 1 });

  // invalid_grant: reauth_required, credential deleted, generation +1; the old snapshot is no longer admitted.
  __setGmailRefreshClockForTests(() => Date.now() + 5 * 3600_000);
  google.token = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  await expect(resolveGmailAccessToken(config, db.pool, snapshot)).rejects.toMatchObject({ code: "gmail_reauth_required" });
  expect((await connections())[0]).toMatchObject({ status: "reauth_required", credential_id: null, generation: 2, last_error_class: "invalid_grant" });
  expect(await gmailCredentials()).toEqual([]);
  await expect(resolveGmailAccessToken(config, db.pool, snapshot)).rejects.toMatchObject({ code: "gmail_connection_changed" });
});

it("a refresh still in flight when the owner disconnects cannot resurrect the connection or its credential", async () => {
  await connect("7007");
  const [row] = await connections();
  __setGmailRefreshClockForTests(() => Date.now() + 2 * 3600_000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  google.token = async () => { await gate; return new Response(JSON.stringify({ access_token: "ya29.late", expires_in: 3599, token_type: "Bearer" }), { status: 200 }); };
  const late = resolveGmailAccessToken(config, db.pool, { connectionId: row.id, ownerUserId: owner, spaceId: space, generation: 1 });
  await vi.waitFor(() => expect(google.calls.filter((c) => c.url.endsWith("/token") && c.body.includes("refresh_token"))).toHaveLength(1));
  expect((await op("POST", row.id)).statusCode).toBe(200);
  release();
  await expect(late).rejects.toMatchObject({ code: "gmail_connection_changed" });
  expect((await connections())[0]).toMatchObject({ status: "disconnected", credential_id: null, generation: 2 });
  expect(await gmailCredentials()).toEqual([]);
});

it("keeps the stable-subject Google cooldown across real reconnect attempts, disconnect, forget and a new connection", async () => {
  expect((await connect("8008")).result).toBe("connected");
  const [first] = await connections();
  // Google cools the account on a reconnect's profile read.
  google.profile = () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
  expect((await connect("8008", { reconnect: first.id })).result).toBe("gmail_profile_unavailable");
  google.profile = () => new Response(JSON.stringify({ emailAddress: "owner@gmail.example" }), { status: 200 });
  // Disconnect + forget remove the connection and its credential...
  expect((await op("POST", first.id)).statusCode).toBe(200);
  expect((await op("DELETE", first.id)).statusCode).toBe(200);
  expect(await connections()).toEqual([]);
  // ...but a brand-new connection of the same Google account is still cooled: no profile GET is sent.
  google.calls = [];
  expect((await connect("8008")).result).toBe("gmail_profile_unavailable");
  expect(google.calls.filter((c) => c.method === "GET")).toEqual([]);
  expect(await connections()).toEqual([]);
  // The cooldown key is the subject's, not the connection's or the credential's; another person's other account is unaffected
  // (the 429 also cooled this owner's endpoint group, as the broker does for every Google 429).
  const keys = gmailQuotaGroups({ googleSubject: "8008", ownerUserId: owner });
  expect((await db.pool.query("SELECT 1 FROM source_request_quota_state WHERE group_key=$1 AND cooldown_until > now()", [keys.account])).rows.length).toBeGreaterThan(0);
  as(peer);
  expect((await connect("9009")).result).toBe("connected");
});

it("a reconnect callback paused at the token exchange cannot reinstall after a disconnect", async () => {
  expect((await connect("1101")).result).toBe("connected");
  const [row] = await connections();
  const attempt = await start(row.id);
  const held = gate();
  google.token = async (form) => { await held.opened; return tokens("1101", { refresh_token: `1//refresh-late-${form.get("code")}` }); };
  const pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  await vi.waitFor(() => expect(google.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1));
  // The attempt is consumed but not installed; the owner disconnects meanwhile.
  expect((await op("POST", row.id)).json().data).toMatchObject({ generation: 2, ...DISCONNECTED });
  expect((await db.pool.query("SELECT 1 FROM gmail_oauth_attempts")).rows).toEqual([]);
  held.open();
  expect(await pending).toBe("gmail_oauth_superseded");
  expect((await connections())[0]).toMatchObject({ status: "disconnected", credential_id: null, generation: 2 });
  expect(await gmailCredentials()).toEqual([]);
  // The superseded fresh token is discarded, not revoked.
  expect(revokeCalls()).toEqual([]);
});

it("a first-connect callback paused at the profile read cannot reactivate a connection disconnected meanwhile", async () => {
  expect((await connect("1102")).result).toBe("connected");
  const [row] = await connections();
  const attempt = await start();
  google.token = () => tokens("1102");
  const held = gate();
  google.profile = (() => held.opened.then(() => new Response(JSON.stringify({ emailAddress: "owner@gmail.example" }), { status: 200 }))) as unknown as () => Response;
  const pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  await vi.waitFor(() => expect(google.calls.filter((c) => c.method === "GET")).toHaveLength(1));
  // Disconnect through the generic actions entry this time.
  const res = await action("source.gmail.connection.disconnect", row.id);
  expect(res.statusCode, res.body).toBe(200);
  held.open();
  expect(await pending).toBe("gmail_oauth_superseded");
  expect((await connections())[0]).toMatchObject({ id: row.id, status: "disconnected", credential_id: null, generation: 2 });
  expect(await gmailCredentials()).toEqual([]);
});

it("of several outstanding attempts only one installs; a stale reconnect generation is superseded before the code is spent", async () => {
  const a = await start();
  const heldA = gate();
  google.token = async () => { await heldA.opened; return tokens("1103", { refresh_token: "1//refresh-A" }); };
  const pendingA = callback({ state: a.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  await vi.waitFor(() => expect(google.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1));
  // B starts after A was consumed (so A survives the start), and completes first.
  expect((await connect("1103", { token: (s) => tokens(s, { refresh_token: "1//refresh-B" }) })).result).toBe("connected");
  heldA.open();
  expect(await pendingA).toBe("gmail_oauth_superseded");
  const [row] = await connections();
  expect(row).toMatchObject({ status: "active", generation: 1 });
  // A's fresh token is discarded; B's live grant (the same Google grant) is never cut.
  expect(revokeCalls()).toEqual([]);
  expect((await gmailCredentials())).toHaveLength(1);

  // A reconnect started at generation 1, completed after a reauth transition (generation 2), is superseded.
  const r = await start(row.id);
  __setGmailRefreshClockForTests(() => Date.now() + 2 * 3600_000);
  google.token = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  await expect(resolveGmailAccessToken(config, db.pool, { connectionId: row.id, ownerUserId: owner, spaceId: space, generation: 1 })).rejects.toMatchObject({ code: "gmail_reauth_required" });
  __setGmailRefreshClockForTests(null);
  google.token = () => tokens("1103");
  google.calls = [];
  expect(await callback({ state: r.state, code: `4/code-${randomUUID()}`, scope: READONLY })).toBe("gmail_oauth_superseded");
  expect(google.calls).toEqual([]);
  expect((await connections())[0]).toMatchObject({ status: "reauth_required", generation: 2, credential_id: null });
  // The refused attempt was still consumed: it cannot be retried.
  expect(await callback({ state: r.state, code: `4/code-${randomUUID()}`, scope: READONLY })).toBe("gmail_oauth_state_invalid");
});

it("the generic actions entry and the REST adapter run the same local disconnect; a replay is the same receipt", async () => {
  expect((await connect("1104")).result).toBe("connected");
  const [row] = await connections();
  const key = randomUUID();
  google.calls = [];
  const first = await action("source.gmail.connection.disconnect", row.id, key);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().data).toEqual({ connection_id: row.id, space_id: space, generation: 2, ...DISCONNECTED });
  const replay = await action("source.gmail.connection.disconnect", row.id, key);
  expect(replay.statusCode).toBe(200);
  expect(replay.json().data).toEqual(first.json().data);
  expect(google.calls).toEqual([]);
  expect(await gmailCredentials()).toEqual([]);
  // Forget through the generic entry, too.
  expect((await action("source.gmail.connection.forget", row.id)).statusCode).toBe(200);
  expect(await connections()).toEqual([]);
});

it("disconnecting one Space's connection never touches another connection of the same Google account", async () => {
  // The same Google account connected by the owner and by another member: one Google grant.
  expect((await connect("1108")).result).toBe("connected");
  as(peer);
  expect((await connect("1108")).result).toBe("connected");
  as(owner);
  const mine = (await connections()).find((r) => r.owner_user_id === owner)!;
  const theirs = (await connections()).find((r) => r.owner_user_id === peer)!;
  google.calls = [];
  expect((await op("POST", mine.id)).json().data).toMatchObject(DISCONNECTED);
  expect(google.calls).toEqual([]);
  // The other connection stays active with its credential and keeps refreshing.
  expect((await connections()).find((r) => r.id === theirs.id)).toMatchObject({ status: "active", generation: 1 });
  __setGmailRefreshClockForTests(() => Date.now() + 2 * 3600_000);
  google.token = () => new Response(JSON.stringify({ access_token: "ya29.peer", expires_in: 3599, token_type: "Bearer" }), { status: 200 });
  expect(await resolveGmailAccessToken(config, db.pool, { connectionId: theirs.id, ownerUserId: peer, spaceId: space, generation: 1 })).toBe("ya29.peer");
});

it("a person who is no longer active, or no longer a Space member, cannot spend an authorization code", async () => {
  for (const revoke of [() => setMembership(owner, "left"), () => db.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [owner])]) {
    const attempt = await start();
    await revoke();
    google.calls = [];
    google.token = () => tokens("1201");
    expect(await callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY })).toBe("gmail_connection_unavailable");
    expect(google.calls).toEqual([]);
    expect(await connections()).toEqual([]);
    await setMembership(owner, "active");
    await db.pool.query("UPDATE users SET status='active' WHERE id=$1", [owner]);
    // The attempt was consumed by the refusal; it is not reusable once authority returns.
    expect(await callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY })).toBe("gmail_oauth_state_invalid");
  }
  // A forgotten reconnect target takes its attempt with it.
  expect((await connect("1202")).result).toBe("connected");
  const [row] = await connections();
  const reconnect = await start(row.id);
  expect((await op("POST", row.id)).statusCode).toBe(200);
  expect((await op("DELETE", row.id)).statusCode).toBe(200);
  google.calls = [];
  expect(await callback({ state: reconnect.state, code: `4/code-${randomUUID()}`, scope: READONLY })).toBe("gmail_oauth_state_invalid");
  expect(google.calls).toEqual([]);
});

it("membership removed while a callback is paused at the code exchange: nothing is installed and nothing is revoked", async () => {
  const attempt = await start();
  const held = gate();
  google.token = async () => { await held.opened; return tokens("1203"); };
  const pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  await vi.waitFor(() => expect(codeExchanges()).toHaveLength(1));
  await setMembership(owner, "revoked");
  held.open();
  // The profile read's broker authorization or the install's locked recheck refuses; either way nothing is stored.
  expect(["gmail_profile_unavailable", "gmail_connection_unavailable"]).toContain(await pending);
  expect(await connections()).toEqual([]);
  expect(await gmailCredentials()).toEqual([]);
  expect(revokeCalls()).toEqual([]);
});

it("token resolution requires the owner's current authority: no cached token, no refresh POST, no stored refresh result", async () => {
  expect((await connect("1204")).result).toBe("connected");
  const [row] = await connections();
  const snapshot = { connectionId: row.id, ownerUserId: owner, spaceId: space, generation: 1 };
  const [before] = await gmailCredentials();
  // Still-valid cached access token: refused once membership is gone.
  await setMembership(owner, "left");
  google.calls = [];
  await expect(resolveGmailAccessToken(config, db.pool, snapshot)).rejects.toMatchObject({ code: "gmail_authority_revoked" });
  // Expired: no refresh POST is sent for a person without authority.
  __setGmailRefreshClockForTests(() => Date.now() + 2 * 3600_000);
  await expect(resolveGmailAccessToken(config, db.pool, snapshot)).rejects.toMatchObject({ code: "gmail_authority_revoked" });
  expect(google.calls).toEqual([]);
  // Authority removed while the refresh POST is in flight: its result is discarded at settlement.
  await setMembership(owner, "active");
  const held = gate();
  google.token = async () => { await held.opened; return new Response(JSON.stringify({ access_token: "ya29.after-removal", expires_in: 3599, token_type: "Bearer" }), { status: 200 }); };
  const late = resolveGmailAccessToken(config, db.pool, snapshot);
  await vi.waitFor(() => expect(google.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1));
  await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [owner]);
  held.open();
  await expect(late).rejects.toMatchObject({ code: "gmail_authority_revoked" });
  const [after] = await gmailCredentials();
  expect(after.secret_ref).toBe(before.secret_ref);
  expect(JSON.stringify(await gmailCredentials())).not.toContain("after-removal");
  expect(revokeCalls()).toEqual([]);
});

it("racing install and disconnect of the same connection never error and always end disconnected without a credential", async () => {
  expect((await connect("1205")).result).toBe("connected");
  const [row] = await connections();
  for (let i = 0; i < 6; i += 1) {
    if ((await connections())[0].status !== "active") expect((await connect("1205", { reconnect: row.id })).result).toBe("connected");
    const attempt = await start(row.id);
    const held = gate();
    google.token = async () => { await held.opened; return tokens("1205"); };
    google.calls = [];
    const installing = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
    await vi.waitFor(() => expect(codeExchanges()).toHaveLength(1));
    // Release the exchange and the disconnect together; either may take the owner's attempt locks first.
    const [result, disconnected] = await Promise.all([installing, (held.open(), op("POST", row.id))]);
    expect(["connected", "gmail_oauth_superseded"]).toContain(result);
    expect(disconnected.statusCode, disconnected.body).toBe(200);
    // Whichever committed first, the later disconnect (or the refused install) leaves no credential behind.
    expect((await connections())[0]).toMatchObject({ status: "disconnected", credential_id: null });
    expect(await gmailCredentials()).toEqual([]);
    expect(revokeCalls()).toEqual([]);
  }
});

/**
 * A disconnect held open inside the real operation registration, after the core's actor pin
 * (`lockActivePerson`) and its `authorize` step: exactly where a second command would interleave.
 */
async function holdDisconnect(connectionId: string) {
  const definitions = await loadSystemActionRegistry(config) as unknown as ReadonlyMap<string, RegisteredSystemActionDefinition>;
  const registration = gmailConnectionRegistrations(definitions).find((r) => r.definition.id === "source.gmail.connection.disconnect")!;
  const actor = { principal: { kind: "user", id: owner }, space_id: space, on_behalf_of_user_id: owner } as unknown as OperationActor;
  const client: PoolClient = await db.pool.connect();
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  await client.query("BEGIN");
  await lockActivePerson(client, space, owner);
  await registration.authorize(client as never, { connection_id: connectionId } as never, actor, undefined as never);
  let done = false;
  return {
    pid,
    /** Rolls back if the test failed before `finish`, so a blocked request is released rather than hanging. */
    abort: async () => { if (!done) { done = true; await client.query("ROLLBACK").catch(() => undefined); client.release(); } },
    /** Runs the registration's execute in the same transaction and commits. */
    finish: async () => {
      done = true;
      try {
        const out = await registration.execute(client as never, { connection_id: connectionId } as never, actor, { requestId: "test", idempotencyKey: "held" } as never);
        await client.query("COMMIT");
        return out;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
  };
}
/** Waits until another backend of this database is blocked on the Gmail owner + Space advisory lock. */
async function blockedOnOwnerMutex(except: number) {
  await vi.waitFor(async () => {
    const rows = (await db.pool.query<{ wait_event: string }>(
      `SELECT wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>$1 AND pid<>pg_backend_pid() AND wait_event_type='Lock'`, [except])).rows;
    expect(rows.map((r) => r.wait_event)).toEqual(["advisory"]);
  }, { timeout: 5000, interval: 20 });
}

it("two disconnects with different keys and no attempt rows serialize on the owner + Space mutex instead of deadlocking", async () => {
  expect((await connect("1301")).result).toBe("connected");
  const [row] = await connections();
  expect((await db.pool.query("SELECT 1 FROM gmail_oauth_attempts")).rows).toEqual([]);
  const held = await holdDisconnect(row.id);
  // The second command (another idempotency key, the real REST entry) must wait before it locks the connection row.
  const second = op("POST", row.id, randomUUID());
  try {
    await blockedOnOwnerMutex(held.pid);
    expect(await held.finish()).toMatchObject({ connection_id: row.id, generation: 2, status: "disconnected" });
  } finally { await held.abort(); }
  const res = await second;
  expect(res.statusCode, res.body).toBe(409);
  expect(res.json().error.metadata).toMatchObject({ code: "gmail_connection_disconnected" });
  expect((await connections())[0]).toMatchObject({ status: "disconnected", credential_id: null, generation: 2 });
});

it("an attempt started while a disconnect holds the owner's (empty) attempt set waits, survives, and can still connect", async () => {
  expect((await connect("1302")).result).toBe("connected");
  const [row] = await connections();
  const held = await holdDisconnect(row.id);
  const starting = start();
  try {
    await blockedOnOwnerMutex(held.pid);
    await held.finish();
  } finally { await held.abort(); }
  const attempt = await starting;
  // The disconnect committed first, so it could not delete the new attempt.
  expect((await db.pool.query("SELECT 1 FROM gmail_oauth_attempts WHERE state_sha256=$1", [createHash("sha256").update(attempt.state).digest("hex")])).rows).toHaveLength(1);
  google.token = () => tokens("1302");
  expect(await callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY })).toBe("connected");
  expect((await connections())[0]).toMatchObject({ id: row.id, status: "active", generation: 3 });
});

it("start cleans up only the caller's own Space: other Spaces, other people and consumed attempts inside their install window survive", async () => {
  const otherSpace = randomUUID(), other = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space: otherSpace, owner: other, project: randomUUID(), spaceType: "team" });
  const insert = (id: string, spaceId: string, userId: string, expires: string, consumed: string | null) => db.pool.query(
    `INSERT INTO gmail_oauth_attempts (id,state_sha256,space_id,user_id,expires_at,consumed_at,created_at)
     VALUES ($1,$6,$2,$3,now()+$4::interval,now()+$5::interval,now()-interval '15 minutes')`,
    [id, spaceId, userId, expires, consumed, createHash("sha256").update(id).digest("hex")]);
  const keep = { otherSpaceOpen: randomUUID(), otherSpaceConsumed: randomUUID(), peerExpired: randomUUID(), peerConsumed: randomUUID(), ownConsumedInWindow: randomUUID() };
  const drop = { ownOpen: randomUUID(), ownStale: randomUUID() };
  await insert(keep.otherSpaceOpen, otherSpace, owner, "5 minutes", null);
  await insert(keep.otherSpaceConsumed, otherSpace, owner, "-1 minute", "-2 minutes");
  await insert(keep.peerExpired, space, peer, "-1 minute", null);
  await insert(keep.peerConsumed, space, peer, "-1 minute", "-2 minutes");
  await insert(keep.ownConsumedInWindow, space, owner, "-1 minute", "-2 minutes");
  await insert(drop.ownOpen, space, owner, "5 minutes", null);
  await insert(drop.ownStale, space, owner, "-5 minutes", "-11 minutes");
  await start();
  const ids = new Set((await db.pool.query<{ id: string }>("SELECT id FROM gmail_oauth_attempts")).rows.map((r) => r.id));
  for (const id of Object.values(keep)) expect(ids.has(id), id).toBe(true);
  for (const id of Object.values(drop)) expect(ids.has(id), id).toBe(false);
  expect(ids.size).toBe(Object.keys(keep).length + 1);
});

it("a consumed attempt past its state expiry still installs after another start by the same person or by another person", async () => {
  for (const restarter of [owner, peer]) {
    as(owner);
    const attempt = await start();
    const held = gate();
    google.token = async () => { await held.opened; return tokens(`14${restarter === owner ? "01" : "02"}`); };
    const pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
    await vi.waitFor(() => expect(codeExchanges()).toHaveLength(1));
    // The state lifetime has passed, but the consumed attempt is still inside its 10 min install window.
    await db.pool.query("UPDATE gmail_oauth_attempts SET expires_at=now()-interval '1 second' WHERE consumed_at IS NOT NULL");
    as(restarter);
    await start();
    held.open();
    expect(await pending).toBe("connected");
    google.calls = [];
  }
  expect((await connections()).map((c) => c.status)).toEqual(["active", "active"]);
});

/** Pauses the token-endpoint name resolution; the profile read keeps its own guard. */
function pauseTokenDns() {
  const held = gate();
  let entered = false;
  __setGmailOAuthGuardForTests({ pin: async (url, signal) => { entered = true; await held.opened; return publicAddressGuard.pin(url, signal); } });
  return { ...held, entered: () => vi.waitFor(() => expect(entered).toBe(true)) };
}
const refreshPosts = () => google.calls.filter((c) => c.url.endsWith("/token") && new URLSearchParams(c.body).get("grant_type") === "refresh_token");

it("a refresh paused at DNS sends nothing once the owner disconnects or loses membership meanwhile", async () => {
  for (const [sub, revoke, code] of [["1501", "disconnect", "gmail_connection_changed"], ["1502", "membership", "gmail_authority_revoked"]] as const) {
    __setGmailOAuthGuardForTests(publicAddressGuard);
    await setMembership(owner, "active");
    expect((await connect(sub)).result).toBe("connected");
    const row = (await connections()).find((c) => c.google_subject === sub)!;
    const [before] = (await gmailCredentials()).filter((c) => c.id === row.credential_id);
    __setGmailRefreshClockForTests(() => Date.now() + 2 * 3600_000);
    google.calls = [];
    google.token = () => new Response(JSON.stringify({ access_token: "ya29.must-not-exist", expires_in: 3599, token_type: "Bearer" }), { status: 200 });
    const dns = pauseTokenDns();
    const late = resolveGmailAccessToken(config, db.pool, { connectionId: row.id, ownerUserId: owner, spaceId: space, generation: row.generation });
    // The in-flight reservation is committed and the POST is waiting on name resolution.
    await dns.entered();
    if (revoke === "disconnect") expect((await op("POST", row.id)).statusCode).toBe(200);
    else await setMembership(owner, "revoked");
    dns.open();
    await expect(late).rejects.toMatchObject({ code });
    expect(refreshPosts()).toEqual([]);
    expect(JSON.stringify(await gmailCredentials())).not.toContain("must-not-exist");
    if (revoke === "membership") expect((await gmailCredentials()).find((c) => c.id === before.id)?.secret_ref).toBe(before.secret_ref);
    __setGmailRefreshClockForTests(null);
  }
});

it("a code exchange paused at DNS sends nothing once a disconnect supersedes it or membership is removed", async () => {
  expect((await connect("1601")).result).toBe("connected");
  const [row] = await connections();
  // Reconnect attempt, consumed, waiting on DNS; the owner disconnects.
  let attempt = await start(row.id);
  let dns = pauseTokenDns();
  google.calls = [];
  google.token = () => tokens("1601");
  let pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  await dns.entered();
  expect((await op("POST", row.id)).statusCode).toBe(200);
  dns.open();
  expect(await pending).toBe("gmail_oauth_superseded");
  expect(codeExchanges()).toEqual([]);
  // First connect, consumed, waiting on DNS; the owner's membership is removed.
  __setGmailOAuthGuardForTests(publicAddressGuard);
  attempt = await start();
  dns = pauseTokenDns();
  pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  await dns.entered();
  await setMembership(owner, "revoked");
  dns.open();
  expect(await pending).toBe("gmail_connection_unavailable");
  expect(codeExchanges()).toEqual([]);
  expect((await connections())[0]).toMatchObject({ status: "disconnected", credential_id: null });
  expect(await gmailCredentials()).toEqual([]);
});

/**
 * Holds the owner + Space mutex in its own transaction. While a lifecycle transaction (already begun,
 * so its `now()` is fixed) waits behind it, `moveDeadline` sets a deadline to the database's actual
 * time inside the holder, and the commit releases the waiter after that deadline: deterministic, no sleep.
 */
async function holdOwnerMutex() {
  const client: PoolClient = await db.pool.connect();
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  await client.query("BEGIN");
  await lockGmailOwnerSpace(client, { spaceId: space, userId: owner });
  let done = false;
  const end = async (sql: string) => { if (!done) { done = true; try { await client.query(sql); } finally { client.release(); } } };
  return {
    pid,
    moveDeadline: (sql: string) => client.query(sql),
    commit: () => end("COMMIT"),
    abort: () => end("ROLLBACK").catch(() => undefined),
  };
}

it("a callback that waits on the owner mutex across the state expiry neither consumes the attempt nor spends the code", async () => {
  const attempt = await start();
  google.token = () => tokens("1701");
  const held = await holdOwnerMutex();
  const pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  try {
    await blockedOnOwnerMutex(held.pid);
    // The state expires now, after the waiting consume transaction began.
    await held.moveDeadline("UPDATE gmail_oauth_attempts SET expires_at=clock_timestamp()");
    await held.commit();
  } finally { await held.abort(); }
  expect(await pending).toBe("gmail_oauth_state_invalid");
  expect(codeExchanges()).toEqual([]);
  expect((await db.pool.query("SELECT consumed_at FROM gmail_oauth_attempts")).rows).toEqual([{ consumed_at: null }]);
});

it("a code exchange whose pre-send admission waits across the install deadline sends nothing", async () => {
  const attempt = await start();
  google.token = () => tokens("1702");
  const dns = pauseTokenDns();
  const pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  await dns.entered();
  const held = await holdOwnerMutex();
  try {
    dns.open();
    await blockedOnOwnerMutex(held.pid);
    // Consumed exactly one install window ago, measured after the admission's transaction began.
    await held.moveDeadline("UPDATE gmail_oauth_attempts SET consumed_at=clock_timestamp()-interval '10 minutes'");
    await held.commit();
  } finally { await held.abort(); }
  expect(await pending).toBe("gmail_oauth_superseded");
  expect(codeExchanges()).toEqual([]);
  expect(await connections()).toEqual([]);
});

it("an install that waits on the owner mutex across the install deadline installs nothing", async () => {
  const attempt = await start();
  google.token = () => tokens("1703");
  const profile = gate();
  let profileRead = false;
  google.profile = async () => { profileRead = true; await profile.opened; return new Response(JSON.stringify({ emailAddress: "owner@gmail.example" }), { status: 200 }); };
  const pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  await vi.waitFor(() => expect(profileRead).toBe(true));
  const held = await holdOwnerMutex();
  try {
    profile.open();
    await blockedOnOwnerMutex(held.pid);
    await held.moveDeadline("UPDATE gmail_oauth_attempts SET consumed_at=clock_timestamp()-interval '10 minutes'");
    await held.commit();
  } finally { await held.abort(); }
  expect(await pending).toBe("gmail_oauth_superseded");
  expect(await connections()).toEqual([]);
  expect(await gmailCredentials()).toEqual([]);
});

it("consumption records the actual time after the lock wait, not the transaction start", async () => {
  const attempt = await start();
  google.token = () => new Response("{}", { status: 400 });
  const held = await holdOwnerMutex();
  const pending = callback({ state: attempt.state, code: `4/code-${randomUUID()}`, scope: READONLY });
  let released!: string;
  try {
    await blockedOnOwnerMutex(held.pid);
    released = (await held.moveDeadline("SELECT clock_timestamp()::text AS t")).rows[0].t as string;
    await held.commit();
  } finally { await held.abort(); }
  expect(await pending).toBe("gmail_oauth_exchange_failed");
  const { later } = (await db.pool.query("SELECT consumed_at >= $1::timestamptz AS later FROM gmail_oauth_attempts", [released])).rows[0];
  expect(later).toBe(true);
});
