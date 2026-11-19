import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SYSTEM_ACTION_REGISTRY } from "@rainver/protocol";
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
import { __setGmailReadGuardForTests, readGmailThread } from "../src/modules/sources/gmail/gmailMailReads.js";
import { GMAIL_READ_TX_LIMITS, GmailReadError } from "../src/modules/sources/gmail/gmailReadAuthority.js";
import { __setGmailReadControlForTests, gmailPageScope, withGmailReadTransaction, type GmailPageScope } from "../src/modules/sources/gmail/gmailReadDeadline.js";
import { listGmailSelectionsBounded } from "../src/modules/sources/gmail/gmailSelections.js";
import { stallableRelay } from "./support/operationFaultHarness.js";
import { __setGmailRefreshClockForTests } from "../src/modules/sources/gmail/gmailTokenRefresh.js";
import { Pool } from "pg";
import { assertGmailReadUrl } from "../src/modules/sources/gmail/gmailReadContract.js";
import { openGmailCursor, signGmailCursor, type GmailReadCursor } from "../src/modules/sources/gmail/gmailCursor.js";
import { pruneContentAccessLogs } from "../src/modules/scheduler/backgroundServices.js";

// Real PostgreSQL, real routes, operation core, Sources broker and outbound guard; only Google is stubbed at
// globalThis.fetch with a small fake mailbox. Every Gmail GET the server sends is checked against the exact
// read allowlist, and no POST other than the OAuth token endpoint may occur.
const db = useTestDatabase(import.meta.filename);
const CLIENT_ID = "gmail-client.apps.googleusercontent.com";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const BODY_MARK = "BODY-MARKER-7f3c";
const SUBJECT_MARK = "SUBJECT-MARKER-91ab";
const QUERY_MARK = "querymarker5521";
let config: ServerConfig, app: ReturnType<typeof buildModuleServer>;
let space: string, owner: string, peer: string, admin: string, project: string, project2: string;

type Msg = { id: string; at: number; draft?: boolean; subject?: string; snippet?: string; text?: string; html?: string; size?: number; missing?: boolean; attachments?: number };
type Hold = { match: (url: string) => boolean; reached: () => void; opened: Promise<void> };
const google = {
  calls: [] as { url: string; method: string; auth?: string }[],
  threads: new Map<string, Msg[]>(),
  holds: [] as Hold[],
  tokens: new Map<string, string>(),
  delayMs: 0,
};
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const headers = (m: Msg) => [
  { name: "Subject", value: m.subject ?? `${SUBJECT_MARK} ${m.id}` }, { name: "From", value: "HR <hr@uni.example>" },
  { name: "To", value: "owner@gmail.example" }, { name: "Date", value: new Date(m.at).toUTCString() },
];
const metadata = (m: Msg) => ({ id: m.id, threadId: "t", labelIds: m.draft ? ["DRAFT"] : ["INBOX"], internalDate: String(m.at), snippet: m.snippet ?? `We&#39;re ${SUBJECT_MARK}`, payload: { headers: headers(m) } });
function full(m: Msg) {
  const parts: unknown[] = [m.html
    ? { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { data: b64(m.html) } }
    : { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }], body: { data: b64(m.text ?? `${BODY_MARK} ${m.id}`) } }];
  for (let i = 0; i < (m.attachments ?? 0); i += 1) parts.push({ mimeType: "application/pdf", filename: `a${i}.pdf`, headers: [], body: { attachmentId: `att${i}`, size: 10 } });
  // `size` pads the response with an inline non-text part: raw bytes the reader must account for but never shows.
  if (m.size) parts.push({ mimeType: "image/png", headers: [], body: { data: "A".repeat(m.size) } });
  return { id: m.id, threadId: "t", internalDate: String(m.at), payload: { mimeType: "multipart/mixed", headers: [...headers(m), { name: "Cc", value: "cc@uni.example" }], parts } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const idToken = (sub: string) => `e30.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
let nextSub = "1001";

async function stub(url: string, init?: RequestInit): Promise<Response> {
  const auth = ((init?.headers ?? {}) as Record<string, string>).authorization;
  const call = { url, method: String(init?.method ?? "GET"), auth };
  google.calls.push(call);
  const signal = init?.signal ?? undefined;
  const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  aborted.catch(() => {});
  for (const hold of google.holds.filter((h) => h.match(url))) { hold.reached(); await Promise.race([hold.opened, aborted]); }
  if (google.delayMs && url.includes("format=full")) await Promise.race([new Promise((resolve) => setTimeout(resolve, google.delayMs)), aborted]);
  if (url === "https://oauth2.googleapis.com/token") {
    const access = `ya29.access-${randomUUID()}`;
    google.tokens.set(access, nextSub);
    return json({ access_token: access, expires_in: 3599, token_type: "Bearer", scope: `openid ${READONLY}`, id_token: idToken(nextSub), refresh_token: `1//refresh-${randomUUID()}` });
  }
  expect(call.method).toBe("GET");
  expect(() => assertGmailReadUrl(url)).not.toThrow();
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/profile")) return json({ emailAddress: "owner@gmail.example" });
  const thread = /\/threads\/([0-9a-f]+)$/.exec(parsed.pathname);
  if (thread) {
    const messages = google.threads.get(thread[1]!);
    return messages ? json({ id: thread[1], messages: messages.map(metadata) }) : json({ error: { code: 404 } }, 404);
  }
  const message = /\/messages\/([0-9a-f]+)$/.exec(parsed.pathname);
  if (message) {
    const m = [...google.threads.values()].flat().find((x) => x.id === message[1]);
    return m && !m.missing ? json(full(m)) : json({ error: { code: 404 } }, 404);
  }
  throw new Error("unexpected Gmail request");
}

beforeEach(async () => {
  await resetTables(db.pool, ["spaces", "users", "credentials", "source_request_quota_state"], { cascade: true });
  space = randomUUID(); owner = randomUUID(); peer = randomUUID(); admin = randomUUID(); project = randomUUID(); project2 = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: "team" });
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Second','active',now(),now())`, [project2, space, owner]);
  await seedSpaceMember(db.pool, { space, user: peer });
  await seedSpaceMember(db.pool, { space, user: admin, role: "admin" });
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, peer]);
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: mkdtempSync(join(tmpdir(), "rainver-gmail-read-")),
    GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret-fixture",
    GMAIL_OAUTH_REDIRECT_URI: "http://localhost:3000/api/v1/sources/gmail/oauth/callback",
  });
  app = buildModuleServer(config, [sourcesModule, systemActionsModule]);
  as(owner);
  __setGmailOAuthGuardForTests(publicAddressGuard);
  __setGmailProfileGuardForTests(publicAddressGuard);
  __setGmailReadGuardForTests(publicAddressGuard);
  google.calls = []; google.threads = new Map(); google.holds = []; google.tokens = new Map(); google.delayMs = 0; nextSub = "1001";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => stub(String(url), init));
});
afterEach(async () => {
  __setAuthIdentityForTests(null); __setGmailOAuthGuardForTests(null); __setGmailProfileGuardForTests(null); __setGmailReadGuardForTests(null);
  __setGmailReadControlForTests(null); __setGmailRefreshClockForTests(null);
  vi.restoreAllMocks();
  await app?.close();
});

let currentUser = "";
function as(userId: string) { currentUser = userId; __setAuthIdentityForTests({ spaceId: space, userId }); }
/** Connects a Gmail account for the current person through the real OAuth routes; returns the connection id. */
async function connect(sub = "1001"): Promise<string> {
  nextSub = sub;
  const start = await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: {} });
  const state = new URL(start.json().authorize_url).searchParams.get("state")!;
  const res = await app.inject({ method: "GET", url: `/api/v1/sources/gmail/oauth/callback?${new URLSearchParams({ state, code: `4/c-${randomUUID()}` })}` });
  expect(new URL(String(res.headers.location)).searchParams.get("gmail")).toBe("connected");
  const rows = (await db.pool.query(`SELECT id FROM gmail_connections WHERE google_subject=$1 ORDER BY created_at DESC LIMIT 1`, [sub])).rows;
  google.calls = [];
  return rows[0].id;
}
const hex = (n: number) => (0x18c0000000 + n).toString(16);
// Selections are legacy rows (Gmail V2 has no selection add), seeded directly here.
const removeSelection = (id: string, key = randomUUID()) => app.inject({ method: "DELETE", url: `/api/v1/sources/gmail/selections/${id}`, headers: { "idempotency-key": key } });
const read = (selectionId: string, cursor?: string) => app.inject({ method: "POST", url: `/api/v1/sources/gmail/selections/${selectionId}/read`, payload: cursor ? { cursor } : {} });
const audits = async () => (await db.pool.query(`SELECT * FROM gmail_read_audit_events ORDER BY accessed_at, id`)).rows;
const gmailGets = (fragment: string) => google.calls.filter((c) => c.method === "GET" && c.url.includes(fragment));
function hold(match: (url: string) => boolean) {
  let reached!: () => void, open!: () => void;
  const reachedP = new Promise<void>((resolve) => { reached = resolve; });
  const opened = new Promise<void>((resolve) => { open = resolve; });
  google.holds.push({ match, reached, opened });
  return { reached: reachedP, open };
}
/** A thread of `count` messages, one minute apart, oldest first. */
function seedThread(threadId: string, count: number, extra: (i: number) => Partial<Msg> = () => ({})): Msg[] {
  const base = Date.UTC(2026, 9, 1);
  const messages = Array.from({ length: count }, (_, i) => ({ id: (0x19d0000000 + Number.parseInt(threadId, 16) % 1000 * 1000 + i).toString(16), at: base + i * 60_000, ...extra(i) }));
  google.threads.set(threadId, messages);
  return messages;
}
async function selectThread(connectionId: string, threadId: string, window: { read_after?: string; read_before?: string; project_id?: string } = {}): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO gmail_project_thread_selections (id,space_id,project_id,owner_user_id,gmail_connection_id,google_thread_id,read_after,read_before,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())`,
    [id, space, window.project_id ?? project, currentUser, connectionId, threadId, window.read_after ?? null, window.read_before ?? null]);
  return id;
}

it("keeps connections and legacy selections private to their owner, even from Project members and Space admins", async () => {
  as(peer);
  const connectionId = await connect("2002");
  seedThread(hex(1), 3);
  const selectionId = await selectThread(connectionId, hex(1));
  const own = await app.inject({ method: "GET", url: `/api/v1/sources/gmail/selections?project_id=${project}` });
  expect(own.json().selections).toEqual([expect.objectContaining({ id: selectionId, project_id: project, connection_id: connectionId, google_thread_id: hex(1), project_readable: true })]);
  expect(own.body).not.toContain(SUBJECT_MARK);
  for (const other of [owner, admin]) {
    as(other);
    expect((await app.inject({ method: "GET", url: `/api/v1/sources/gmail/selections?project_id=${project}` })).json()).toEqual({ selections: [] });
    expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/connections" })).json().connections).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/read-audit" })).json()).toEqual({ events: [] });
    const res = await read(selectionId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("gmail_not_found");
    expect((await removeSelection(selectionId)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/actions/source.gmail.selection.remove", headers: { "idempotency-key": randomUUID() }, payload: { selection_id: selectionId } })).statusCode).toBe(404);
  }
  expect(google.calls).toEqual([]);
  // Reading needs Project read access; a legacy selection in Project 2 (unreadable by the peer) is the same hidden 404.
  as(peer);
  expect((await read(await selectThread(connectionId, hex(1), { project_id: project2 }))).statusCode).toBe(404);
  // Agents, Rooms and Runs have no route: the remaining command is human-only, public-API-only and ungrantable.
  for (const id of ["source.gmail.selection.remove"]) {
    const definition = SYSTEM_ACTION_REGISTRY.find((d) => d.id === id)!;
    expect([...definition.visibility]).toEqual(["public_api"]);
    expect(definition.allowed_actor_types).toEqual(["user"]);
    expect(definition.grantable).toBe(false);
  }
  // The only other mail reads are the Agent's on-demand read (ADR 0032) and a digest's own read (ADR 0033 B):
  // Agent-only, ungrantable queries under ADR 0030's consent and isolation (`gmailAgentReadDb.test.ts`).
  expect(SYSTEM_ACTION_REGISTRY.filter((d) => /gmail.*(search|read)/.test(d.id)).map((d) => [d.id, [...d.visibility], d.allowed_actor_types, d.grantable, d.execution?.kind, d.side_effects]))
    .toEqual([["source.gmail.connection.set_agent_read", ["public_api"], ["user"], false, "command", "durable"], ["source.gmail.mail.read", ["agent_tool"], ["agent"], false, "query", "none"], ["source.gmail.digest.read", ["agent_tool"], ["agent"], false, "query", "none"]]);
});

it("removes a legacy selection as a hard delete; forget cascades the connection's selections", async () => {
  const connectionId = await connect();
  const first = { json: () => ({ data: { selection_id: "" } }) };
  const selectionId = await selectThread(connectionId, hex(1));
  first.json = () => ({ data: { selection_id: selectionId } });
  const removeKey = randomUUID();
  const removed = await removeSelection(first.json().data.selection_id, removeKey);
  expect(removed.json().data).toEqual({ selection_id: first.json().data.selection_id, space_id: space, removed: true });
  // The row is gone, so (like forget) even a same-key replay is the hidden 404 of a vanished reference.
  expect((await removeSelection(first.json().data.selection_id, removeKey)).statusCode).toBe(404);
  expect((await removeSelection(first.json().data.selection_id)).statusCode).toBe(404);
  expect((await read(first.json().data.selection_id)).statusCode).toBe(404);
  // Forget cascades the connection's selections.
  await app.inject({ method: "POST", url: `/api/v1/sources/gmail/connections/${connectionId}/disconnect`, headers: { "idempotency-key": randomUUID() } });
  expect((await app.inject({ method: "DELETE", url: `/api/v1/sources/gmail/connections/${connectionId}`, headers: { "idempotency-key": randomUUID() } })).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT 1 FROM gmail_project_thread_selections WHERE gmail_connection_id=$1`, [connectionId])).rows).toEqual([]);
});

it("reads a selected thread newest first, 20 messages per page, inside its window, as plain text with explicit omissions", async () => {
  const connectionId = await connect();
  const thread = hex(7);
  const messages = seedThread(thread, 28, (i) => ({
    draft: i === 27,
    html: i === 26 ? `<p>${BODY_MARK} html</p><img src="https://remote.example/p.gif"><script>x()</script>` : undefined,
    attachments: i === 25 ? 2 : 0,
    size: i === 24 ? 2.2 * 1024 * 1024 : undefined,
    missing: i === 23,
  }));
  // The window drops the two oldest messages: 28 - 1 draft - 2 outside = 25.
  const selectionId = await selectThread(connectionId, thread, { read_after: new Date(messages[2]!.at).toISOString() });
  const first = await read(selectionId);
  expect(first.statusCode, first.body.slice(0, 500)).toBe(200);
  expect(first.headers["cache-control"]).toMatch(/private.*no-store|no-store.*private/);
  const page = first.json();
  expect(page).toMatchObject({ selection_id: selectionId, project_id: project, connection_id: connectionId, google_thread_id: thread, messages_in_window: 25, truncated: true, truncation: [] });
  expect(page.messages).toHaveLength(20);
  expect(page.messages.map((m: { google_message_id: string }) => m.google_message_id)).toEqual(messages.slice(7, 27).reverse().map((m) => m.id));
  const byIndex = (i: number) => page.messages.find((m: { google_message_id: string }) => m.google_message_id === messages[i]!.id);
  expect(byIndex(26)).toMatchObject({ text: `${BODY_MARK} html`, text_format: "html_converted", omitted: null, cc: "cc@uni.example" });
  expect(byIndex(25)).toMatchObject({ attachment_count: 2, text_format: "plain" });
  expect(byIndex(24)).toMatchObject({ omitted: "too_large", text: "", gmail_url: `https://mail.google.com/mail/u/?authuser=owner%40gmail.example#all/${messages[24]!.id}` });
  expect(byIndex(23)).toMatchObject({ omitted: "unavailable", text: "" });
  expect(byIndex(22).text).toBe(`${BODY_MARK} ${messages[22]!.id}`);
  expect(first.body).not.toMatch(/remote\.example|<p>|x\(\)/);
  // 1 thread-metadata send + 20 message sends: exactly the page budget.
  expect(gmailGets("format=metadata")).toHaveLength(1);
  expect(gmailGets("format=full")).toHaveLength(20);

  const second = await read(selectionId, page.next_cursor);
  expect(second.statusCode).toBe(200);
  expect(second.json().messages.map((m: { google_message_id: string }) => m.google_message_id)).toEqual(messages.slice(2, 7).reverse().map((m) => m.id));
  expect(second.json().next_cursor).toBeNull();
  expect((await audits()).map((a) => [a.operation, a.selection_id, a.google_thread_id, a.item_count])).toEqual([
    ["thread_read", selectionId, thread, 20], ["thread_read", selectionId, thread, 5],
  ]);
  // Changing the selection's window invalidates its outstanding cursors; another selection's cursor never applies.
  await db.pool.query(`UPDATE gmail_project_thread_selections SET read_before='2100-01-01T00:00:00Z' WHERE id=$1`, [selectionId]);
  expect((await read(selectionId, page.next_cursor)).json().error.code).toBe("gmail_cursor_invalid");
  const otherSelection = await selectThread(connectionId, hex(8));
  seedThread(hex(8), 1);
  expect((await read(otherSelection, page.next_cursor)).json().error.code).toBe("gmail_cursor_invalid");
  // A thread Google no longer has is a fixed error, not content.
  const gone = await selectThread(connectionId, hex(99));
  expect((await read(gone)).json().error.code).toBe("gmail_thread_unavailable");
});

it("truncates a page honestly at the normalized-text and raw-byte ceilings and continues on the next page", async () => {
  const connectionId = await connect();
  // Four messages of ~1.2 MiB text: each is cut to 256 KiB, and the fourth would pass the 1 MiB page text limit.
  seedThread(hex(20), 4, () => ({ text: `${BODY_MARK} ${"x".repeat(1.2 * 1024 * 1024)}` }));
  const textSelection = await selectThread(connectionId, hex(20));
  const text = await read(textSelection);
  expect(text.json()).toMatchObject({ truncated: true, truncation: ["page_text_bytes"] });
  expect(text.json().messages).toHaveLength(3);
  expect(text.json().messages.every((m: { text_truncated: boolean }) => m.text_truncated)).toBe(true);
  const rest = await read(textSelection, text.json().next_cursor);
  expect(rest.json().messages).toHaveLength(1);
  // Five ~1.6 MiB responses with tiny text: the fifth send could pass the 8 MiB raw page limit, so the page stops at four.
  google.calls = [];
  seedThread(hex(21), 5, () => ({ text: "small", size: 1.6 * 1024 * 1024 }));
  const raw = await read(await selectThread(connectionId, hex(21)));
  expect(raw.json()).toMatchObject({ truncated: true, truncation: ["page_raw_bytes"], messages_in_window: 5 });
  expect(raw.json().messages).toHaveLength(4);
  expect(gmailGets("format=full")).toHaveLength(4);
  expect(raw.json().next_cursor).not.toBeNull();
});

const withdrawals: [string, (ids: { connectionId: string; selectionId: string }) => Promise<unknown>, number, string][] = [
  ["disconnect", ({ connectionId }) => app.inject({ method: "POST", url: `/api/v1/sources/gmail/connections/${connectionId}/disconnect`, headers: { "idempotency-key": randomUUID() } }), 409, "gmail_connection_inactive"],
  ["selection removed", ({ selectionId }) => removeSelection(selectionId), 404, "gmail_not_found"],
  ["Project membership removed", () => db.pool.query(`UPDATE project_members SET status='revoked' WHERE user_id=$1`, [peer]), 404, "gmail_not_found"],
  ["Space membership removed", () => db.pool.query(`UPDATE space_memberships SET status='removed' WHERE user_id=$1`, [peer]), 404, "gmail_not_found"],
  ["user disabled", () => db.pool.query(`UPDATE users SET status='disabled' WHERE id=$1`, [peer]), 404, "gmail_not_found"],
  ["connection generation changed", ({ connectionId }) => db.pool.query(`UPDATE gmail_connections SET generation=generation+1 WHERE id=$1`, [connectionId]), 409, "gmail_connection_changed"],
  ["selection window changed", ({ selectionId }) => db.pool.query(`UPDATE gmail_project_thread_selections SET read_before='2030-01-01T00:00:00Z' WHERE id=$1`, [selectionId]), 409, "gmail_selection_changed"],
];

it.each(withdrawals)("refuses release after the last fetch when %s, with no content and no audit row", async (_name, withdraw, status, code) => {
  as(peer);
  const connectionId = await connect("4004");
  seedThread(hex(30), 1);
  const selectionId = await selectThread(connectionId, hex(30));
  // Held at Google's answer to the only message send: admission and every send were authorized; only release remains.
  const held = hold((url) => url.includes("format=full"));
  const pending = read(selectionId);
  await held.reached;
  await withdraw({ connectionId, selectionId });
  held.open();
  const res = await pending;
  expect(res.statusCode, res.body).toBe(status);
  expect(res.json().error.code).toBe(code);
  expect(res.body).not.toMatch(new RegExp(`${BODY_MARK}|${SUBJECT_MARK}`));
  expect(await audits()).toEqual([]);
});

it("sends nothing more once authority is withdrawn between sends", async () => {
  as(peer);
  const connectionId = await connect("5005");
  seedThread(hex(31), 3);
  const selectionId = await selectThread(connectionId, hex(31));
  const held = hold((url) => url.includes("format=metadata"));
  const pending = read(selectionId);
  await held.reached;
  await db.pool.query(`UPDATE project_members SET status='revoked' WHERE user_id=$1`, [peer]);
  held.open();
  expect((await pending).statusCode).toBe(404);
  expect(gmailGets("format=full")).toEqual([]);
  expect(await audits()).toEqual([]);
});

it("withholds content when the owner-read audit cannot be written, and rolls the release back", async () => {
  const connectionId = await connect();
  seedThread(hex(40), 2);
  const selectionId = await selectThread(connectionId, hex(40));
  await db.pool.query(`CREATE OR REPLACE FUNCTION gmail_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit store down'; END $$`);
  await db.pool.query(`CREATE TRIGGER gmail_audit_fail BEFORE INSERT ON gmail_read_audit_events FOR EACH ROW EXECUTE FUNCTION gmail_audit_fail()`);
  try {
    for (const res of [await read(selectionId)]) {
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("gmail_audit_unavailable");
      expect(res.body).not.toMatch(new RegExp(`${BODY_MARK}|${SUBJECT_MARK}|audit store down`));
    }
  } finally {
    await db.pool.query(`DROP TRIGGER gmail_audit_fail ON gmail_read_audit_events`);
  }
  expect(await audits()).toEqual([]);
  expect((await read(selectionId)).statusCode).toBe(200);
});

it("stores no mail, query, token or Google content in Jobs, operation results, policy records, Source items or access logs", async () => {
  const connectionId = await connect();
  seedThread(hex(50), 2);
  const selectionId = await selectThread(connectionId, hex(50));
  const res = await read(selectionId);
  expect(res.body).toContain(BODY_MARK);
  const dump: Record<string, unknown[]> = {};
  for (const table of ["operation_idempotency", "policy_decision_records", "jobs", "job_events", "source_items", "content_access_logs",
    "gmail_read_audit_events", "gmail_project_thread_selections", "gmail_connections"]) {
    dump[table] = (await db.pool.query(`SELECT * FROM ${table}`)).rows;
  }
  const text = JSON.stringify(dump);
  for (const secret of [BODY_MARK, SUBJECT_MARK, QUERY_MARK, "ya29.", "hr@uni.example"]) expect(text).not.toContain(secret);
  expect(dump.jobs).toEqual([]);
  expect(dump.source_items).toEqual([]);
  // The owner-read audit follows the content-access-log retention.
  expect(dump.gmail_read_audit_events).toHaveLength(1);
  await db.pool.query(`UPDATE gmail_read_audit_events SET accessed_at=now()-interval '400 days'`);
  expect(await pruneContentAccessLogs(config, 90)).toBe(1);
  expect(await audits()).toEqual([]);
});

it("scopes Google ids by connection: one owner's two accounts keep separate selections and tokens for the same id", async () => {
  const a = await connect("6006");
  const b = await connect("7007");
  seedThread(hex(60), 1);
  const sa = await selectThread(a, hex(60));
  const sb = await selectThread(b, hex(60));
  expect(sa).not.toBe(sb);
  for (const [selection, sub] of [[sa, "6006"], [sb, "7007"]] as const) {
    google.calls = [];
    expect((await read(selection)).statusCode).toBe(200);
    const tokens = new Set(google.calls.map((c) => google.tokens.get(c.auth!.replace("Bearer ", ""))));
    expect([...tokens]).toEqual([sub]);
  }
});

it("pages a thread by a stable (date, id) boundary: mail added or deleted between pages never repeats or skips", async () => {
  const connectionId = await connect();
  const thread = hex(80);
  const messages = seedThread(thread, 25);
  const selectionId = await selectThread(connectionId, thread);
  const first = await read(selectionId);
  expect(first.json().messages.map((m: { google_message_id: string }) => m.google_message_id)).toEqual(messages.slice(5).reverse().map((m) => m.id));
  // Two newer messages arrive and one unread older message is deleted before page 2.
  const base = messages.at(-1)!.at;
  google.threads.set(thread, [...messages.filter((_, i) => i !== 3), { id: "19e0000001", at: base + 60_000 }, { id: "19e0000002", at: base + 120_000 }]);
  const second = await read(selectionId, first.json().next_cursor);
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json().messages.map((m: { google_message_id: string }) => m.google_message_id)).toEqual([4, 2, 1, 0].map((i) => messages[i]!.id));
  expect(second.json().next_cursor).toBeNull();
  // The cursor binds the thread and a well-formed message boundary; a mismatch refuses before any Google send.
  const opened = await openGmailCursor(config, first.json().next_cursor, "read") as GmailReadCursor;
  expect(opened).toMatchObject({ th: thread, bi: messages[5]!.id, ba: new Date(messages[5]!.at).toISOString(), sel: selectionId });
  google.calls = [];
  for (const forged of [{ ...opened, th: hex(81) }, { ...opened, bi: "NOT-HEX" }, { ...opened, ba: "yesterday" }]) {
    const res = await read(selectionId, await signGmailCursor(config, forged));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("gmail_cursor_invalid");
  }
  expect(google.calls).toEqual([]);
});

it("takes the thread subject only from messages inside the selection window, and null for an empty window", async () => {
  const connectionId = await connect();
  const messages = seedThread(hex(82), 3, (i) => ({ subject: `subject-${i}` }));
  const windowed = await selectThread(connectionId, hex(82), { read_after: new Date(messages[1]!.at).toISOString() });
  const page = (await read(windowed)).json();
  expect(page.subject).toBe("subject-1");
  expect(JSON.stringify(page)).not.toContain("subject-0");
  google.threads.set(hex(83), messages.map((m) => ({ ...m })));
  const empty = await selectThread(connectionId, hex(83), { read_after: "2030-01-01T00:00:00Z" });
  const none = (await read(empty)).json();
  expect(none).toMatchObject({ subject: null, messages: [], messages_in_window: 0, next_cursor: null });
  expect(JSON.stringify(none)).not.toContain("subject-");
});

// Lock observation is exact under a fully loaded shared PostgreSQL: only an ungranted advisory lock in this
// test's database, on this test's owner key (pg_locks splits the bigint key into classid/objid, objsubid=1), whose
// backend is blocked by this test's blocker. Other files' waiters (other databases, keys or blockers) never match,
// so no test can observe them or select their backend as a cancellation victim.
const ownerLock = () => `gmail-owner:${space}:${owner}`;
type OwnerLockBlocker = { pid: number; end: () => Promise<void> };
async function holdOwnerLock(): Promise<OwnerLockBlocker> {
  const blocker = await db.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [ownerLock()]);
  const pid = (await blocker.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
  let ended = false;
  return { pid, end: async () => { if (ended) return; ended = true; await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); } };
}
const ADVISORY_KEY_WAITERS = `SELECT l.pid, a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
  WHERE l.locktype='advisory' AND NOT l.granted AND l.objsubid=1
    AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND a.datname=current_database()
    AND l.classid::bigint=((hashtextextended($1,0) >> 32) & 4294967295) AND l.objid::bigint=(hashtextextended($1,0) & 4294967295)
    AND $2::int = ANY(pg_blocking_pids(l.pid))
  ORDER BY l.pid`;
const advisoryKeyWaiters = async (key: string, blockerPid: number) =>
  (await db.pool.query<{ pid: number; application_name: string }>(ADVISORY_KEY_WAITERS, [key, blockerPid])).rows;
const ownerLockWaiters = (blocker: OwnerLockBlocker) => advisoryKeyWaiters(ownerLock(), blocker.pid);
/** Waits for exactly one waiter on the owner key behind `blocker` and returns its backend pid. */
async function waitForLockWaiter(blocker: OwnerLockBlocker, applicationName?: string): Promise<number> {
  let pid = 0;
  await vi.waitFor(async () => {
    const rows = await ownerLockWaiters(blocker);
    expect(rows).toHaveLength(1);
    if (applicationName) expect(rows[0]!.application_name).toBe(applicationName);
    pid = rows[0]!.pid;
  }, { timeout: 3000, interval: 20 });
  return pid;
}
/** A one-client pool whose backend is tagged, so a selected victim pid is proven to be this pool's backend. */
function taggedPool() {
  const tag = `gmail-target-${randomUUID().slice(0, 8)}`;
  const url = new URL(db.connectionUri); url.searchParams.set("application_name", tag);
  return { tag, pool: new Pool({ connectionString: url.toString(), max: 1 }) };
}

it("selects only this test's lock waiter: a decoy on another key is never observed, and the blocker filter matches no other backend", async () => {
  const blocker = await holdOwnerLock();
  const otherKey = `gmail-decoy-${randomUUID()}`;
  // Decoys use their own pool: the file pool (max 3) also serves the blocker and the observation queries.
  const decoys = new Pool({ connectionString: db.connectionUri, max: 3 });
  const decoyHolder = await decoys.connect();
  const decoyWaiters = [await decoys.connect(), await decoys.connect()];
  const target = taggedPool();
  const waits: Promise<unknown>[] = [];
  try {
    await decoyHolder.query("BEGIN");
    await decoyHolder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [otherKey]);
    // Decoy 1 waits on another key in this database; decoy 2 is an idle backend, never a waiter.
    waits.push(decoyWaiters[0]!.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [otherKey]).catch(() => null));
    await vi.waitFor(async () => expect(await advisoryKeyWaiters(otherKey, (await decoyHolder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid)).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(await ownerLockWaiters(blocker)).toEqual([]);
    const client = await target.pool.connect();
    const targetPid = (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    waits.push(client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [ownerLock()]).catch(() => null).finally(() => client.release()));
    expect(await waitForLockWaiter(blocker, target.tag)).toBe(targetPid);
    // The blocker filter: with an unrelated backend's pid (not a blocker of any waiter) the target is not returned.
    const foreignPid = (await decoyWaiters[1]!.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    expect(await advisoryKeyWaiters(ownerLock(), foreignPid)).toEqual([]);
  } finally {
    await blocker.end();
    await decoyHolder.query("ROLLBACK").catch(() => {});
    decoyHolder.release();
    await Promise.all(waits);
    for (const c of decoyWaiters) c.release();
    await decoys.end();
    await target.pool.end();
  }
});

it("bounds read-authority lock waits and releases the connection when the caller cancels", async () => {
  const connectionId = await connect();
  seedThread(hex(84), 1);
  const selectionId = await selectThread(connectionId, hex(84));
  const blocker = await holdOwnerLock();
  try {
    const started = Date.now();
    const busy = await read(selectionId);
    expect(busy.statusCode, busy.body).toBe(503);
    expect(busy.json().error.code).toBe("gmail_authority_busy");
    expect(Date.now() - started).toBeLessThan(GMAIL_READ_TX_LIMITS.lockTimeoutMs + 3000);
    // Cancellation while waiting on the lock: the statement is cancelled, rolled back, and nothing keeps waiting.
    const controller = new AbortController();
    const pending = readGmailThread(config, db.pool, { spaceId: space, userId: owner, selectionId, requestId: randomUUID(), signal: controller.signal })
      .then(() => null, (error: unknown) => error);
    await waitForLockWaiter(blocker);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(GmailReadError);
    expect(error).toMatchObject({ status: 499, code: "gmail_cancelled" });
    expect(await ownerLockWaiters(blocker)).toEqual([]);
  } finally {
    await blocker.end();
  }
  expect(gmailGets("format=")).toEqual([]);
  expect(await audits()).toEqual([]);
  expect((await read(selectionId)).statusCode).toBe(200);
});

// ── One page deadline, bounded acquisition and awaited cancellation (gmailReadDeadline.ts) ──────────────────────

const settled = <T>(promise: Promise<T>) => { const state = { done: false }; promise.then(() => { state.done = true; }, () => { state.done = true; }); return state; };
/** A control "pool" whose cancel requests wait for `open()` (or fail/hang), forwarding to a real pool. */
function gatedControl(mode: "gate" | "fail" | "hang") {
  const real = new Pool({ connectionString: db.connectionUri, max: 1 });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const calls: unknown[] = [];
  const state = { settled: 0 };
  const pool = { query: async (...args: unknown[]) => {
    calls.push(args);
    if (mode === "fail") throw new Error("control unavailable");
    if (mode === "hang") return new Promise(() => {});
    await gate;
    try { return await (real.query as (...a: unknown[]) => Promise<unknown>)(...args); } finally { state.settled += 1; }
  } } as unknown as Pool;
  return { pool, open, calls, get settled() { return state.settled; }, end: () => real.end() };
}

it("holds the target client out of the pool until the cancel request has answered: the reused backend's next transaction is not cancelled", async () => {
  const main = new Pool({ connectionString: db.connectionUri, max: 1 });
  const control = gatedControl("gate");
  const blocker = await holdOwnerLock();
  try {
    const abort = new AbortController();
    const scope: GmailPageScope = { pool: main, control: control.pool, signal: abort.signal, deadlineAt: Date.now() + 60_000 };
    const target = withGmailReadTransaction(scope, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [ownerLock()]);
      return (await tx.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    }).then(() => null, (error: unknown) => error);
    const targetState = settled(target);
    await waitForLockWaiter(blocker);
    abort.abort();
    // The lock is released: the target's statement finishes, but its cancel request is still unanswered.
    await blocker.end();
    const next = main.connect();
    const nextState = settled(next);
    // The cancel request is issued and held unanswered; give a wrong early release a window to show.
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(control.calls).toHaveLength(1);
    expect(targetState.done).toBe(false);
    expect(nextState.done).toBe(false);
    expect(main.idleCount).toBe(0);
    // The waiting transaction starts on the same backend only after the cancel answered; a late signal cannot reach it.
    const reused = next.then(async (client) => {
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_sleep(0.4)`);
        await client.query("COMMIT");
        return "ok";
      } finally { client.release(); }
    });
    control.open();
    expect(await target).toMatchObject({ status: 499, code: "gmail_cancelled" });
    expect(await reused).toBe("ok");
    expect(main.totalCount).toBe(1);
  } finally {
    await blocker.end();
    await main.end(); await control.end();
  }
});

it("destroys the target client when the cancel request fails or times out, and returns without waiting for the lock timeout", async () => {
  for (const mode of ["fail", "hang"] as const) {
    const { tag, pool: main } = taggedPool();
    const control = gatedControl(mode);
    const blocker = await holdOwnerLock();
    try {
      const abort = new AbortController();
      const scope: GmailPageScope = { pool: main, control: control.pool, signal: abort.signal, deadlineAt: Date.now() + 60_000 };
      const target = withGmailReadTransaction(scope, (tx) => tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [ownerLock()]))
        .then(() => null, (error: unknown) => error);
      const victim = await waitForLockWaiter(blocker, tag);
      const started = Date.now();
      abort.abort();
      expect(await target).toMatchObject({ status: 499, code: "gmail_cancelled" });
      const limit = mode === "fail" ? 1000 : GMAIL_READ_TX_LIMITS.cancelRequestMs + 1000;
      expect(Date.now() - started).toBeLessThan(limit);
      expect(main.totalCount).toBe(0);
      // The destroyed backend ends no later than its own lock timeout; it never returns to a pool.
      await blocker.end();
      await vi.waitFor(async () => {
        // pid and tag together: a recycled pid of another backend under load is not this victim.
        expect((await db.pool.query(`SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND application_name=$2`, [victim, tag])).rows).toEqual([]);
      }, { timeout: GMAIL_READ_TX_LIMITS.lockTimeoutMs + 2000, interval: 50 });
    } finally {
      await blocker.end();
      await main.end(); await control.end();
    }
  }
});

it("cancels through the control pool while the main pool is exhausted, and the queued request's transaction on the reused backend survives", async () => {
  const connectionId = await connect();
  seedThread(hex(90), 1);
  const selectionId = await selectThread(connectionId, hex(90));
  const main = new Pool({ connectionString: db.connectionUri, max: 1 });
  const blocker = await holdOwnerLock();
  try {
    const abort = new AbortController();
    const pending = readGmailThread(config, main, { spaceId: space, userId: owner, selectionId, requestId: randomUUID(), signal: abort.signal })
      .then(() => null, (error: unknown) => error);
    await waitForLockWaiter(blocker);
    // The main pool is full (one client, held by the waiting admission) and another request is queued.
    const queued = main.connect();
    const started = Date.now();
    abort.abort();
    expect(await pending).toMatchObject({ status: 499, code: "gmail_cancelled" });
    expect(Date.now() - started).toBeLessThan(GMAIL_READ_TX_LIMITS.lockTimeoutMs - 1000);
    const client = await queued;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_sleep(0.4)`);
      await client.query("COMMIT");
    } finally { client.release(); }
  } finally {
    await blocker.end();
    await main.end();
  }
  expect(gmailGets("/threads/")).toEqual([]);
  expect(await audits()).toEqual([]);
});

it("gives up pool acquisition on abort and returns a client that arrives later to the pool unused", async () => {
  const connectionId = await connect();
  seedThread(hex(91), 1);
  const selectionId = await selectThread(connectionId, hex(91));
  const main = new Pool({ connectionString: db.connectionUri, max: 1 });
  const occupant = await main.connect();
  try {
    const abort = new AbortController();
    const pending = readGmailThread(config, main, { spaceId: space, userId: owner, selectionId, requestId: randomUUID(), signal: abort.signal })
      .then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(main.waitingCount).toBe(1), { timeout: 2000, interval: 10 });
    const started = Date.now();
    abort.abort();
    expect(await pending).toMatchObject({ status: 499, code: "gmail_cancelled" });
    expect(Date.now() - started).toBeLessThan(500);
    occupant.release();
    await vi.waitFor(() => { expect(main.waitingCount).toBe(0); expect(main.idleCount).toBe(1); }, { timeout: 2000, interval: 10 });
    const after = await main.query<{ state: string }>(`SELECT 'ok' AS state`);
    expect(after.rows[0]!.state).toBe("ok");
  } finally {
    await main.end();
  }
  expect(google.calls).toEqual([]);
});

it("bounds the selection route lookup: a table lock is 503 after lock_timeout, an abort 499, and a short page deadline 504", async () => {
  const connectionId = await connect();
  seedThread(hex(92), 1);
  const selectionId = await selectThread(connectionId, hex(92));
  const locker = await db.pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query(`LOCK TABLE gmail_project_thread_selections IN ACCESS EXCLUSIVE MODE`);
    let started = Date.now();
    const busy = await read(selectionId);
    expect(busy.statusCode, busy.body).toBe(503);
    expect(busy.json().error.code).toBe("gmail_authority_busy");
    expect(Date.now() - started).toBeLessThan(GMAIL_READ_TX_LIMITS.lockTimeoutMs + 1500);
    const abort = new AbortController();
    const pending = readGmailThread(config, db.pool, { spaceId: space, userId: owner, selectionId, requestId: randomUUID(), signal: abort.signal })
      .then(() => null, (error: unknown) => error);
    await vi.waitFor(async () => {
      expect((await db.pool.query(`SELECT 1 FROM pg_locks WHERE relation='gmail_project_thread_selections'::regclass AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows.length).toBeGreaterThan(0);
    }, { timeout: 2000, interval: 20 });
    abort.abort();
    expect(await pending).toMatchObject({ status: 499, code: "gmail_cancelled" });
    __setGmailReadControlForTests({ pageDeadlineMs: 700 });
    started = Date.now();
    const late = await read(selectionId);
    expect(late.statusCode, late.body).toBe(504);
    expect(late.json().error.code).toBe("gmail_upstream_timeout");
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await db.pool.query(`SELECT 1 FROM pg_locks WHERE relation='gmail_project_thread_selections'::regclass AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows).toEqual([]);
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
  }
  expect(google.calls).toEqual([]);
  expect(await audits()).toEqual([]);
  __setGmailReadControlForTests({ pageDeadlineMs: null });
  expect((await read(selectionId)).statusCode).toBe(200);
});

it("applies one page deadline across all sends: each send is far under 15 s, the page still ends at its deadline with no content", async () => {
  const connectionId = await connect();
  seedThread(hex(93), 20);
  const selectionId = await selectThread(connectionId, hex(93));
  __setGmailReadControlForTests({ pageDeadlineMs: 1500 });
  google.delayMs = 300;
  const started = Date.now();
  const res = await read(selectionId);
  expect(res.statusCode, res.body).toBe(504);
  expect(res.json().error.code).toBe("gmail_upstream_timeout");
  expect(Date.now() - started).toBeLessThan(2500);
  expect(gmailGets("format=full").length).toBeGreaterThan(1);
  expect(gmailGets("format=full").length).toBeLessThan(20);
  expect(res.body).not.toContain(BODY_MARK);
  expect(await audits()).toEqual([]);
});

it("bounds token refresh by the page deadline: a stalled refresh POST ends the page at the deadline", async () => {
  const connectionId = await connect();
  seedThread(hex(94), 1);
  const selectionId = await selectThread(connectionId, hex(94));
  // Two hours later the stored access token has expired: the first send must refresh it.
  __setGmailRefreshClockForTests(() => Date.now() + 2 * 3_600_000);
  hold((url) => url === "https://oauth2.googleapis.com/token");
  __setGmailReadControlForTests({ pageDeadlineMs: 800 });
  const started = Date.now();
  const res = await read(selectionId);
  expect(res.statusCode, res.body).toBe(504);
  expect(res.json().error.code).toBe("gmail_upstream_timeout");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(google.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
  expect(gmailGets("/threads/")).toEqual([]);
  expect(await audits()).toEqual([]);
});

// ── Unresponsive wire, bounded cleanup and bounded list endpoints (Phase 3 third review) ──────────────────────

/** A pool through a silent-able relay; the `stallAt`-th query of a client stalls the wire before it is sent. */
async function relayPool(stallAt: number) {
  const relay = await stallableRelay(db.connectionUri);
  const tag = `gmail-stall-${randomUUID().slice(0, 8)}`;
  const url = new URL(relay.url); url.searchParams.set("application_name", tag);
  const real = new Pool({ connectionString: url.toString(), max: 1 });
  real.on("error", () => {});
  const pool = { connect: async () => {
    const client = await real.connect();
    client.on("error", () => {});
    const query = client.query.bind(client) as (...a: unknown[]) => unknown;
    let n = 0;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => { n += 1; if (n === stallAt) relay.stall(); return query(...args); };
    return client;
  } } as unknown as Pool;
  const backends = async () => (await db.pool.query(`SELECT pid FROM pg_stat_activity WHERE application_name=$1`, [tag])).rows;
  return { pool, real, relay, backends, end: async () => { await relay.close(); await real.end().catch(() => {}); } };
}
const deadlineScope = (pool: Pool, ms: number, control: Pool = db.pool): GmailPageScope =>
  ({ pool, control, signal: AbortSignal.timeout(ms), deadlineAt: Date.now() + ms });

it("ends at the page deadline when BEGIN or the marker query gets no answer, and destroys the client instead of pooling it", async () => {
  for (const stallAt of [1, 2]) {
    const wire = await relayPool(stallAt);
    try {
      const started = Date.now();
      const error = await withGmailReadTransaction(deadlineScope(wire.pool, 600), async () => "unreachable").then(() => null, (e: unknown) => e);
      expect(error).toMatchObject({ status: 504, code: "gmail_upstream_timeout" });
      expect(Date.now() - started).toBeLessThan(1200);
      expect(wire.real.totalCount).toBe(0);
      // The destroyed client closed its socket; the backend (idle, or idle in the BEGUN transaction) is gone in PostgreSQL.
      await vi.waitFor(async () => expect(await wire.backends()).toEqual([]), { timeout: 3000, interval: 50 });
    } finally { await wire.end(); }
  }
});

it("bounds a ROLLBACK that gets no answer by the page deadline: the client is destroyed and the transaction's lock released", async () => {
  const wire = await relayPool(4);
  const key = `gmail-rollback-${randomUUID()}`;
  try {
    const started = Date.now();
    // Query 3 takes the lock; query 4 is the ROLLBACK after the work fails, sent into a silent wire.
    const error = await withGmailReadTransaction(deadlineScope(wire.pool, 800), async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [key]);
      throw new Error("work failed");
    }).then(() => null, (e: unknown) => e);
    expect(String(error)).toContain("work failed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(wire.real.totalCount).toBe(0);
    await vi.waitFor(async () => {
      expect(await wire.backends()).toEqual([]);
      expect((await db.pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objsubid=1 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid::bigint=((hashtextextended($1,0) >> 32) & 4294967295) AND objid::bigint=(hashtextextended($1,0) & 4294967295)`, [key])).rows).toEqual([]);
    }, { timeout: 3000, interval: 50 });
  } finally { await wire.end(); }
});

it("bounds cleanup after an abort when the wire is silent: cancel answered, but the ROLLBACK never is", async () => {
  const wire = await relayPool(4);
  const blocker = await holdOwnerLock();
  try {
    const abort = new AbortController();
    const scope: GmailPageScope = { pool: wire.pool, control: db.pool, signal: abort.signal, deadlineAt: Date.now() + 60_000 };
    const target = withGmailReadTransaction(scope, (tx) => tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [ownerLock()]))
      .then(() => null, (e: unknown) => e);
    await waitForLockWaiter(blocker);
    // The lock wait is query 3; the wire goes silent with the ROLLBACK (query 4), after the cancel has landed.
    const started = Date.now();
    abort.abort();
    expect(await target).toMatchObject({ status: 499, code: "gmail_cancelled" });
    expect(Date.now() - started).toBeLessThan(GMAIL_READ_TX_LIMITS.cleanupMs + 800);
    expect(wire.real.totalCount).toBe(0);
    await vi.waitFor(async () => expect(await wire.backends()).toEqual([]), { timeout: 3000, interval: 50 });
  } finally {
    await blocker.end();
    await wire.end();
  }
});

it("lets a cancel request answered only after its timeout land without reaching the transaction that runs next", async () => {
  const { tag, pool: main } = taggedPool();
  const control = gatedControl("gate");
  const blocker = await holdOwnerLock();
  try {
    const abort = new AbortController();
    const scope: GmailPageScope = { pool: main, control: control.pool, signal: abort.signal, deadlineAt: Date.now() + 60_000 };
    const target = withGmailReadTransaction(scope, (tx) => tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [ownerLock()]))
      .then(() => null, (e: unknown) => e);
    const victim = await waitForLockWaiter(blocker, tag);
    abort.abort();
    // The request is still unanswered at its timeout: the client is destroyed, not pooled.
    expect(await target).toMatchObject({ status: 499, code: "gmail_cancelled" });
    expect(main.totalCount).toBe(0);
    const next = await main.connect();
    try {
      await next.query("BEGIN");
      const pid = (await next.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      expect(pid).not.toBe(victim);
      const running = next.query(`SELECT pg_sleep(0.5)`);
      // The late request now actually reaches PostgreSQL, keyed by the destroyed backend's pid + backend_start.
      control.open();
      await vi.waitFor(() => expect(control.settled).toBe(1), { timeout: 2000, interval: 20 });
      await running;
      await next.query("COMMIT");
    } finally { next.release(); }
  } finally {
    await blocker.end();
    await main.end(); await control.end();
  }
});

it("bounds the selection and read-audit lists, including the Project readability lookup: table locks are 503, abort 499, the deadline 504", async () => {
  const connectionId = await connect();
  seedThread(hex(95), 1);
  const selectionId = await selectThread(connectionId, hex(95));
  const list = () => app.inject({ method: "GET", url: "/api/v1/sources/gmail/selections" });
  const auditList = () => app.inject({ method: "GET", url: "/api/v1/sources/gmail/read-audit" });
  const before = (await list()).json();
  expect(before.selections.map((s: { id: string }) => s.id)).toEqual([selectionId]);
  const ungranted = async () => (await db.pool.query(`SELECT 1 FROM pg_locks WHERE locktype='relation' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows;
  for (const [table, request] of [["gmail_project_thread_selections", list], ["projects", list], ["gmail_read_audit_events", auditList]] as const) {
    const locker = await db.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      const started = Date.now();
      const busy = await request();
      expect(busy.statusCode, `${table} ${busy.body}`).toBe(503);
      expect(busy.json().error.code).toBe("gmail_authority_busy");
      expect(Date.now() - started).toBeLessThan(GMAIL_READ_TX_LIMITS.lockTimeoutMs + 1500);
      expect(await ungranted()).toEqual([]);
    } finally { await locker.query("ROLLBACK"); locker.release(); }
  }
  const locker = await db.pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query(`LOCK TABLE projects IN ACCESS EXCLUSIVE MODE`);
    const abort = new AbortController();
    const pending = listGmailSelectionsBounded(gmailPageScope(config, db.pool, abort.signal), { spaceId: space, userId: owner }, {})
      .then(() => null, (e: unknown) => e);
    await vi.waitFor(async () => expect((await ungranted()).length).toBeGreaterThan(0), { timeout: 2000, interval: 20 });
    abort.abort();
    expect(await pending).toMatchObject({ status: 499, code: "gmail_cancelled" });
    expect(await ungranted()).toEqual([]);
    __setGmailReadControlForTests({ pageDeadlineMs: 700 });
    const started = Date.now();
    const late = await auditList();
    expect(late.statusCode).toBe(200); // the audit list does not touch `projects`
    const timedOut = await list();
    expect(timedOut.statusCode, timedOut.body).toBe(504);
    expect(Date.now() - started).toBeLessThan(1500);
  } finally { await locker.query("ROLLBACK"); locker.release(); }
  __setGmailReadControlForTests({ pageDeadlineMs: null });
  // Owner-only access is unchanged: the owner sees the same rows, a Project member none.
  expect((await list()).json()).toEqual(before);
  as(peer);
  expect((await list()).json().selections).toEqual([]);
  expect((await auditList()).json().events).toEqual([]);
});

it("keeps the refusal class when quota admission's bounded transaction fails: 503, not a wrapped 502", async () => {
  const connectionId = await connect();
  seedThread(hex(96), 1);
  const selectionId = await selectThread(connectionId, hex(96));
  const locker = await db.pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query(`LOCK TABLE source_request_quota_state IN ACCESS EXCLUSIVE MODE`);
    const res = await read(selectionId);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe("gmail_authority_busy");
  } finally { await locker.query("ROLLBACK"); locker.release(); }
  expect(google.calls).toEqual([]);
  expect(await audits()).toEqual([]);
  expect((await read(selectionId)).statusCode).toBe(200);
});
