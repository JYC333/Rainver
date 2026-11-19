import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GMAIL_DIGEST_LIMITS, SYSTEM_ACTION_REGISTRY, type GmailDigestReadOutput } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRun, seedServerHost, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { publicAddressGuard } from "./support/outboundGuard.js";
import { sourcesModule } from "../src/modules/sources/index.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { proposalsModule } from "../src/modules/proposals/index.js";
import { activityModule } from "../src/modules/activity/index.js";
import { frontendSupportModule } from "../src/modules/frontendSupport/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { __setGmailOAuthGuardForTests } from "../src/modules/sources/gmail/gmailOAuthTransport.js";
import { __setGmailProfileGuardForTests } from "../src/modules/sources/gmail/gmailOAuthFlow.js";
import { __setGmailSyncGuardForTests, syncGmailMailbox } from "../src/modules/sources/gmail/gmailMailboxSync.js";
import { __setGmailWatchGuardForTests } from "../src/modules/sources/gmail/gmailWatch.js";
import { __setGmailReadControlForTests } from "../src/modules/sources/gmail/gmailReadDeadline.js";
import { runsModule } from "../src/modules/runs/index.js";
import { contentAccessModule } from "../src/modules/contentAccess/index.js";
import { loadRunTurn } from "../src/modules/runs/turnReadModel.js";
import { __setGmailPushForTests } from "../src/modules/sources/gmail/gmailPush.js";
import { proposeGmailDigest } from "../src/modules/sources/gmail/gmailDigestProposal.js";
import { PgProjectAgentRepository } from "../src/modules/projects/projectAgents.js";
import { runRequiresIsolatedLaunch } from "../src/modules/runs/sensitiveRuntimeProfile.js";
import { __setGmailReadGuardForTests } from "../src/modules/sources/gmail/gmailMailReads.js";
import { assertGmailDigestReadUrl, readGmailDigestPage } from "../src/modules/sources/gmail/gmailDigestReads.js";
import { recordHostThreadOutcome } from "../src/modules/hosts/threadOutcome.js";
import { finalizeChatTurn } from "../src/modules/runs/chatTurnFinalizer.js";
import { OperationToolResponse } from "../src/modules/systemActions/operations/agentResult.js";
import { CliAgentToolTransport } from "../src/modules/runs/cliToolTransport.js";
import { executeRemoteHostCliAdapter } from "../src/modules/runs/remoteHostCliAdapter.js";
import { resolveRuntimeProfileScope } from "../src/modules/runs/remoteProviderBinding.js";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";
import { ProviderProxyLeaseRegistry } from "../src/modules/providers/proxy/lease.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { PgRunRepository, type AgentRunRecord } from "../src/modules/runs/repository.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { gmailDigestDailyWindow, nextGmailDigestSlot } from "../src/modules/sources/gmail/gmailDigestSchedule.js";
import { settleGmailDigestRun, startGmailDigestDelivery, startDueGmailDigests } from "../src/modules/sources/gmail/gmailDigests.js";
import { proposeGmailMonitor } from "../src/modules/sources/gmail/gmailMonitorProposal.js";
import { enqueueDueGmailMailboxSyncs, pruneGmailMonitorMatches } from "../src/modules/sources/gmail/gmailMonitors.js";
import { assertGmailSyncUrl } from "../src/modules/sources/gmail/gmailSyncContract.js";
import { CONVERSATION_TOOL_ALLOWANCE } from "../src/modules/systemActions/scenarioToolAllowance.js";

// Real PostgreSQL, routes, operation core, proposal apply service, Sources broker and outbound guard; only
// Google is stubbed at globalThis.fetch with a small stateful mailbox (history, messages, profile, watch,
// JWKS). Every Gmail GET a sync sends must pass the exact sync allowlist; the only POSTs are the OAuth token
// endpoint and users.watch. No real account, mailbox or cloud resource is involved.
const db = useTestDatabase(import.meta.filename);
const CLIENT_ID = "gmail-client.apps.googleusercontent.com";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const SUBJECT_MARK = "SUBJECT-MARKER-c41d";
const SENDER_MARK = "admissions-office";
const TOPIC = "projects/rainver-test-proj/topics/gmail-push";
const SUBSCRIPTION = "projects/rainver-test-proj/subscriptions/gmail-push-sub";
const AUDIENCE = "https://rainver.example/api/v1/sources/gmail/push";
const PUSH_ACCOUNT = "gmail-push@rainver-test-proj.iam.gserviceaccount.com";
const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";

let config: ServerConfig, noPushConfig: ServerConfig, app: ReturnType<typeof buildModuleServer>;
let space: string, owner: string, peer: string, admin: string, project: string;

type Mail = { id: string; at: number; from: string; subject: string; labels: string[] };
const google = {
  calls: [] as { url: string; method: string; auth?: string; body?: string }[],
  historyId: 1000,
  history: [] as { id: string; messageIds: string[] }[],
  messages: new Map<string, Mail>(),
  failDigestMessage: null as string | null,
  /** history.list answers 404 for a start id below this (Google expired the cursor). */
  expiredBelow: 0,
  historyPageSize: 100,
  failHistory: 0,
  nextSub: "1001",
  /** Holds the next history.list until opened (a sync in flight). */
  gate: null as null | { reached: () => void; opened: Promise<void> },
  /**
   * What the next users.watch calls answer with instead of success: a status, a status with
   * Google's Retry-After, or "hang" (no answer until the request is aborted).
   */
  watchFailures: [] as (number | { status: number; retryAfter: string } | "hang")[],
};
let nextMessage = 0x1a0000000;
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const idToken = (sub: string) => `e30.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;

/** Mail arriving now (or at `at`): a new message and its history record. */
function deliver(input: Partial<Mail> = {}): Mail {
  const mail: Mail = {
    id: (nextMessage++).toString(16), at: input.at ?? Date.now(), from: input.from ?? `Admissions <${SENDER_MARK}@uni.example>`,
    subject: input.subject ?? `${SUBJECT_MARK} interview`, labels: input.labels ?? ["INBOX", "UNREAD"],
  };
  google.messages.set(mail.id, mail);
  google.historyId += 1;
  google.history.push({ id: String(google.historyId), messageIds: [mail.id] });
  return mail;
}

/** Many messages arriving in one history record (a bulk import, a filter moving mail). */
function deliverRecord(count: number): { recordId: string; mails: Mail[] } {
  const mails = Array.from({ length: count }, () => {
    const mail: Mail = { id: (nextMessage++).toString(16), at: Date.now(), from: `Admissions <${SENDER_MARK}@uni.example>`, subject: `${SUBJECT_MARK} interview`, labels: ["INBOX"] };
    google.messages.set(mail.id, mail);
    return mail;
  });
  google.historyId += 1;
  // Google's order inside a record is not the sync's concern: it sorts.
  google.history.push({ id: String(google.historyId), messageIds: mails.map((m) => m.id).reverse() });
  return { recordId: String(google.historyId), mails };
}
/** A pending history.list, held until released. */
function holdHistory(): { reached: Promise<void>; open: () => void } {
  let reached!: () => void, open!: () => void;
  const reachedP = new Promise<void>((resolve) => { reached = resolve; });
  google.gate = { reached, opened: new Promise<void>((resolve) => { open = resolve; }) };
  return { reached: reachedP, open };
}

async function stub(url: string, init?: RequestInit): Promise<Response> {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const raw = init?.body;
  const body = typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : undefined;
  const call = { url, method: String(init?.method ?? "GET"), auth: headers.authorization, body };
  google.calls.push(call);
  if (url === "https://oauth2.googleapis.com/token") {
    return json({ access_token: `ya29.access-${randomUUID()}`, expires_in: 3599, token_type: "Bearer", scope: `openid ${READONLY}`, id_token: idToken(google.nextSub), refresh_token: `1//refresh-${randomUUID()}` });
  }
  if (url === "https://www.googleapis.com/oauth2/v3/certs") {
    const jwk = signingKey.publicKey.export({ format: "jwk" }) as { n: string; e: string };
    return json({ keys: [{ kty: "RSA", kid: KID, alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] }, 200, { "cache-control": "public, max-age=3600" });
  }
  if (url === "https://gmail.googleapis.com/gmail/v1/users/me/watch") {
    expect(call.method).toBe("POST");
    const failing = google.watchFailures.shift();
    if (failing === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) { reject(new Error("watch request without a signal")); return; }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (typeof failing === "number") return json({ error: { code: failing } }, failing);
    if (failing) return json({ error: { code: failing.status } }, failing.status, { "retry-after": failing.retryAfter });
    return json({ historyId: String(google.historyId), expiration: String(Date.now() + 7 * 86_400_000) });
  }
  expect(call.method).toBe("GET");
  const parsed = new URL(url);
  const digest = parsed.searchParams.get("format") === "full" || parsed.searchParams.get("q")?.includes(" before:");
  expect(() => digest ? assertGmailDigestReadUrl(url) : assertGmailSyncUrl(url), url).not.toThrow();
  if (parsed.pathname.endsWith("/profile")) return json({ emailAddress: "owner@gmail.example", historyId: String(google.historyId) });
  if (parsed.pathname.endsWith("/history")) {
    if (google.failHistory > 0) { google.failHistory -= 1; return json({ error: { code: 429 } }, 429); }
    if (google.gate) { const gate = google.gate; google.gate = null; gate.reached(); await gate.opened; }
    const start = Number(parsed.searchParams.get("startHistoryId"));
    if (start < google.expiredBelow) return json({ error: { code: 404 } }, 404);
    const records = google.history.filter((r) => Number(r.id) > start);
    const offset = Number(parsed.searchParams.get("pageToken")?.slice(1) ?? 0);
    const page = records.slice(offset, offset + google.historyPageSize);
    return json({
      history: page.map((r) => ({ id: r.id, messagesAdded: r.messageIds.map((id) => ({ message: { id, threadId: id } })) })),
      historyId: String(google.historyId),
      ...offset + google.historyPageSize < records.length ? { nextPageToken: `p${offset + google.historyPageSize}` } : {},
    });
  }
  if (parsed.pathname.endsWith("/messages")) {
    const [after, before] = (parsed.searchParams.get("q") ?? "").split(" ");
    const floor = Number(after?.slice("after:".length));
    const ceiling = before ? Number(before.slice("before:".length)) : Infinity;
    const max = digest ? Number(parsed.searchParams.get("maxResults")) : 40;
    const all = [...google.messages.values()].filter((m) => m.at / 1000 > floor && m.at / 1000 < ceiling).sort((a, b) => b.at - a.at);
    const offset = Number(parsed.searchParams.get("pageToken")?.slice(1) ?? 0);
    const page = all.slice(offset, offset + max);
    return json({ messages: page.map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: all.length, ...offset + max < all.length ? { nextPageToken: `p${offset + max}` } : {} });
  }
  const message = /\/messages\/([0-9a-f]+)$/.exec(parsed.pathname);
  if (message) {
    const m = google.messages.get(message[1]!);
    if (!m || (digest && google.failDigestMessage === m.id)) return json({ error: { code: 404 } }, 404);
    return json({ id: m.id, threadId: m.id, labelIds: m.labels, internalDate: String(m.at), snippet: `${SUBJECT_MARK} snippet`,
      payload: { ...(digest ? { mimeType: "text/plain", body: { data: Buffer.from("Synthetic admission update.").toString("base64url") } } : {}), headers: [{ name: "Subject", value: m.subject }, { name: "From", value: m.from }, { name: "To", value: "owner@gmail.example" }] } });
  }
  throw new Error(`unexpected Google request ${url}`);
}

beforeEach(async () => {
  await resetTables(db.pool, ["spaces", "users", "credentials", "source_request_quota_state", "jobs"], { cascade: true });
  space = randomUUID(); owner = randomUUID(); peer = randomUUID(); admin = randomUUID(); project = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: "team" });
  await seedSpaceMember(db.pool, { space, user: peer });
  await seedSpaceMember(db.pool, { space, user: admin, role: "admin" });
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, peer]);
  const env = {
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: mkdtempSync(join(tmpdir(), "rainver-gmail-monitor-")),
    GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret-fixture",
    GMAIL_OAUTH_REDIRECT_URI: "http://localhost:3000/api/v1/sources/gmail/oauth/callback",
  };
  noPushConfig = loadConfig(env);
  config = loadConfig({ ...env, GMAIL_PUBSUB_TOPIC: TOPIC, GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION, GMAIL_PUBSUB_PUSH_AUDIENCE: AUDIENCE, GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT: PUSH_ACCOUNT });
  // Both configs share RAINVER_HOME, so credentials encrypted under one decrypt under the other.
  app = buildModuleServer(config, [sourcesModule, systemActionsModule, proposalsModule, activityModule, frontendSupportModule, runsModule, contentAccessModule]);
  as(owner);
  __setGmailOAuthGuardForTests(publicAddressGuard);
  __setGmailProfileGuardForTests(publicAddressGuard);
  __setGmailSyncGuardForTests(publicAddressGuard);
  __setGmailReadGuardForTests(publicAddressGuard);
  __setGmailWatchGuardForTests(publicAddressGuard);
  __setGmailPushForTests({ guard: publicAddressGuard });
  Object.assign(google, { calls: [], historyId: 1000, history: [], messages: new Map(), expiredBelow: 0, historyPageSize: 100, failHistory: 0, nextSub: "1001", gate: null, watchFailures: [], failDigestMessage: null });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => stub(String(url), init));
});
afterEach(async () => {
  __setAuthIdentityForTests(null); __setGmailOAuthGuardForTests(null); __setGmailProfileGuardForTests(null);
  __setGmailReadGuardForTests(null);
  __setGmailSyncGuardForTests(null); __setGmailWatchGuardForTests(null); __setGmailPushForTests(null); __setGmailReadControlForTests(null);
  vi.restoreAllMocks();
  await app?.close();
});

function as(userId: string) { __setAuthIdentityForTests({ spaceId: space, userId }); }
async function connect(sub = "1001"): Promise<string> {
  google.nextSub = sub;
  const start = await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: {} });
  const state = new URL(start.json().authorize_url).searchParams.get("state")!;
  const res = await app.inject({ method: "GET", url: `/api/v1/sources/gmail/oauth/callback?${new URLSearchParams({ state, code: `4/c-${randomUUID()}` })}` });
  expect(new URL(String(res.headers.location)).searchParams.get("gmail")).toBe("connected");
  google.calls = [];
  return (await db.pool.query(`SELECT id FROM gmail_connections WHERE google_subject=$1 ORDER BY created_at DESC LIMIT 1`, [sub])).rows[0].id;
}
/** Reconnect the same Google account to an existing connection row (a new generation). */
async function reconnect(connectionId: string): Promise<void> {
  const start = await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: { reconnect_connection_id: connectionId } });
  const state = new URL(start.json().authorize_url).searchParams.get("state")!;
  const res = await app.inject({ method: "GET", url: `/api/v1/sources/gmail/oauth/callback?${new URLSearchParams({ state, code: `4/c-${randomUUID()}` })}` });
  expect(new URL(String(res.headers.location)).searchParams.get("gmail")).toBe("connected");
}
/** A conversation Run of `user`'s own turn; `shape` makes it shared or delegated. */
async function turn(user: string, shape: "private" | "space_shared" | "delegated" = "private"): Promise<string> {
  const run = randomUUID();
  await seedRun(db.pool, { id: run, space, owner: user, agent: randomUUID(), version: randomUUID() });
  if (shape === "delegated") {
    const parent = randomUUID();
    await seedRun(db.pool, { id: parent, space, owner: user, agent: randomUUID(), version: randomUUID() });
    await db.pool.query(`UPDATE runs SET visibility='private',instructed_by_user_id=$2 WHERE id=$1`, [parent, user]);
    await db.pool.query(`UPDATE runs SET trigger_origin='delegation',parent_run_id=$2 WHERE id=$1`, [run, parent]);
  }
  await db.pool.query(`UPDATE runs SET visibility=$2,instructed_by_user_id=$3,owner_user_id=$3,project_id=$4 WHERE id=$1`,
    [run, shape === "space_shared" ? "space_shared" : "private", user, project]);
  return run;
}
const criteria = { from_any: ["@uni.example"], subject_any: ["interview"] };
async function propose(run: string, input: Record<string, unknown> = {}, key: string | null = randomUUID()) {
  return proposeGmailMonitor(db.pool, run, space, { purpose: "Tell me when the admissions office writes about interviews", ...criteria, ...input } as never, key) as Promise<{ modelResult: Record<string, unknown> }>;
}
const accept = (proposalId: string) => app.inject({ method: "POST", url: `/api/v1/proposals/${proposalId}/accept`, headers: { "idempotency-key": randomUUID() }, payload: {} });
/** The owner's own monitor, created through the real draft → accept path. */
async function monitor(connectionId: string, input: Record<string, unknown> = {}, user = owner): Promise<string> {
  void connectionId;
  const drafted = await propose(await turn(user), input);
  expect(drafted.modelResult.ok, JSON.stringify(drafted)).toBe(true);
  const res = await accept(String(drafted.modelResult.proposal_id));
  expect(res.statusCode, res.body).toBe(200);
  return (await db.pool.query(`SELECT id FROM gmail_monitor_rules WHERE proposal_id=$1`, [drafted.modelResult.proposal_id])).rows[0].id;
}
const sync = (connectionId: string, cfg: ServerConfig = config) => syncGmailMailbox(cfg, db.pool, connectionId);
/** Time passing for the durable quota: the minute window (and any Google cooldown) ends. */
const nextMinute = () => db.pool.query(`DELETE FROM source_request_quota_state`);
/** Time passing past a failure: the quota window, Google's cooldown and the sync's own retry floor end. */
async function retryFloorPasses(connectionId: string) {
  await nextMinute();
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET retry_not_before=now()-interval '1 second',next_poll_at=now() WHERE gmail_connection_id=$1`, [connectionId]);
}
const syncRow = async (connectionId: string) => (await db.pool.query(`SELECT * FROM gmail_mailbox_sync_states WHERE gmail_connection_id=$1`, [connectionId])).rows[0];
const matches = async () => (await db.pool.query(`SELECT rule_id,google_message_id FROM gmail_monitor_matches ORDER BY google_message_id`)).rows;
const alerts = async () => (await db.pool.query(`SELECT * FROM activity_records WHERE activity_type='operational_alert' AND payload_json->>'alert_kind'='gmail_monitor_matches'`)).rows;
const gets = (fragment: string) => google.calls.filter((c) => c.method === "GET" && c.url.includes(fragment));

const digestStatus = (id: string, status: "active" | "paused") => app.inject({
  method: "POST", url: `/api/v1/sources/gmail/digests/${id}/status`,
  headers: { "idempotency-key": randomUUID() }, payload: { status },
});
const digestTime = (id: string, localTime: string) => app.inject({
  method: "POST", url: "/api/v1/actions/source.gmail.digest.set_time",
  headers: { "idempotency-key": randomUUID() }, payload: { digest_id: id, local_time: localTime },
});

async function digestConversation() {
  as(owner);
  const connectionId = await connect();
  const setting = (enabled: boolean) => app.inject({
    method: "POST", url: "/api/v1/actions/source.gmail.connection.set_agent_read",
    headers: { "idempotency-key": randomUUID() }, payload: { connection_id: connectionId, enabled },
  });
  expect((await setting(true)).statusCode).toBe(200);
  const run = await turn(owner);
  const session = randomUUID();
  await db.pool.query(`INSERT INTO sessions (id,space_id,user_id,project_id,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, owner, project]);
  await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [run, session]);

  return { connectionId, setting, run, session };
}

async function digestHost(run: string) {
  const agentId = (await db.pool.query<{ agent_id: string }>(`SELECT agent_id FROM runs WHERE id=$1`, [run])).rows[0]!.agent_id;
  const hostId = randomUUID();
  await seedServerHost(db.pool, { id: hostId, installations: {
    opencode: [{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, options: null, health_check_protocol: "acp" }],
  } });
  await db.pool.query(`UPDATE agent_runtime_profiles SET execution_host_id=$2,workspace_mode='managed',runtime_installation='managed:1.0.0'
    WHERE agent_id=$1 AND is_default`, [agentId, hostId]);
  await new PgProjectAgentRepository(db.pool).upsertActive({ spaceId: space, projectId: project, agentId, userId: owner });
  return hostId;
}

async function launchDigestReader(run: string, runId: string, hostId: string) {
  await db.pool.query(`UPDATE runs target SET runtime_profile_id=source.runtime_profile_id,
    runtime_key=source.runtime_key,runtime_profile_selection_source='explicit',runtime_profile_snapshot_json=source.runtime_profile_snapshot_json
    FROM runs source WHERE target.id=$1 AND source.id=$2`, [runId, run]);
  expect(await new PgRunRepository(db.pool, config).markRunRunning({ run_id: runId, space_id: space, started_at: new Date().toISOString() })).not.toBeNull();
  const launchId = randomUUID();
  await db.pool.query(`UPDATE run_attempts SET launch_id=$2,launch_isolation_json=$3::jsonb WHERE run_id=$1 AND status='running'`, [runId, launchId,
    // The conversation's own runtime: ordinary egress, no model-only channel (ADR 0033 §6).
    JSON.stringify({ launch_id: launchId, host_id: hostId, host_kind: "server", egress_profile: "default", sandbox_mode: "read_write" })]);
  const loadRun = async () => (await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [runId])).rows[0]!;
  const transport = new CliAgentToolTransport(config, { actionEventSink: async () => {} });
  const read = async (pageToken?: string) => {
    const result = await transport.call(await loadRun(), {
      id: randomUUID(), name: "source.gmail.digest.read", arguments: pageToken ? { page_token: pageToken } : {},
    });
    if (!(result instanceof OperationToolResponse)) throw new Error("Expected the Gmail digest operation response");
    return result;
  };
  return { loadRun, read };
}

it("confirms daily and immediate rule summaries separately and manages their owner-only consents", async () => {
  const { connectionId, setting, run, session } = await digestConversation();
  const daily = await proposeGmailDigest(db.pool, run, space, { kind: "daily", local_time: "08:00", time_zone: "Europe/London" }, randomUUID());
  const rule = await proposeGmailDigest(db.pool, run, space, { kind: "rule" }, randomUUID());
  expect(daily.modelResult).toMatchObject({ status: "pending" });
  expect(rule.modelResult).toMatchObject({ status: "pending" });
  const dailyId = "proposal_id" in daily.modelResult ? daily.modelResult.proposal_id : "";
  const ruleId = "proposal_id" in rule.modelResult ? rule.modelResult.proposal_id : "";
  as(admin);
  expect((await accept(ruleId)).statusCode).toBe(404);
  as(owner);
  const acceptedDaily = await accept(dailyId);
  expect(acceptedDaily.statusCode, acceptedDaily.body).toBe(200);
  expect((await accept(ruleId)).statusCode).toBe(200);
  const list = () => app.inject({ method: "GET", url: "/api/v1/sources/gmail/digests" });
  const result = await list();
  expect(result.statusCode, result.body).toBe(200);
  const { digests } = result.json();
  expect(digests).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "daily", local_time: "08:00", time_zone: "Europe/London", next_run_at: expect.any(String) }),
    expect.objectContaining({ kind: "rule", local_time: null, time_zone: null, next_run_at: null }),
  ]));
  const dailyDigest = digests.find((digest: { kind: string }) => digest.kind === "daily");
  const dailyState = async () => (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [dailyDigest.id])).rows[0];
  const originalDaily = await dailyState();
  as(admin);
  expect((await digestTime(dailyDigest.id, "09:00")).statusCode).toBe(404);
  as(owner);
  expect((await digestTime(dailyDigest.id, "09:00")).statusCode).toBe(200);
  expect(await dailyState()).toMatchObject({
    local_time: "09:00", covered_until: originalDaily.covered_until, grant_id: originalDaily.grant_id,
    next_run_at: nextGmailDigestSlot("09:00", "Europe/London", new Date()),
  });
  const ruleDigest = digests.find((digest: { kind: string }) => digest.kind === "rule");
  expect(await startGmailDigestDelivery(db.pool, config, ruleDigest.id)).toBe("nothing_new");
  const hostId = await digestHost(run);
  const ruleMonitor = await monitor(connectionId);
  const insertMatch = (id: string) => db.pool.query(`INSERT INTO gmail_monitor_matches (rule_id,google_message_id,space_id,owner_user_id,matched_at)
    VALUES ($1,$2,$3,$4,clock_timestamp())`, [ruleMonitor, id, space, owner]);
  expect((await digestStatus(ruleDigest.id, "paused")).statusCode).toBe(200);
  await insertMatch(deliver().id);
  expect((await digestStatus(ruleDigest.id, "active")).statusCode).toBe(200);
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(0);
  const matchedId = deliver().id;
  await insertMatch(matchedId);
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(1);
  const delivery = (await db.pool.query(`SELECT dl.message_ids, r.id AS run_id, r.trigger_origin, r.visibility, r.session_id, r.permission_snapshot_json
    FROM gmail_digest_deliveries dl JOIN runs r ON r.id=dl.run_id WHERE dl.digest_id=$1`, [ruleDigest.id])).rows[0];
  expect(delivery).toMatchObject({ message_ids: [matchedId], trigger_origin: "automation", visibility: "private", session_id: session });
  expect(delivery.permission_snapshot_json.tool_grants.map((grant: { action_id: string }) => grant.action_id)).toEqual(["source.gmail.digest.read"]);
  // A digest Run keeps its conversation's own runtime (ADR 0033 §6): no isolated launch is required.
  expect(runRequiresIsolatedLaunch(delivery)).toBe(false);
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(0);
  const runId = delivery.run_id;
  const { loadRun, read } = await launchDigestReader(run, runId, hostId);
  const response = await read();
  expect(response).toMatchObject({ httpStatus: 200, body: { ok: true, data: {
    kind: "rule", items: [expect.objectContaining({ id: matchedId, text: "Synthetic admission update." })],
  } } });
  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [runId]);
  const reply = await settleGmailDigestRun(db.pool, await loadRun(), "One admissions reply arrived.", (tx, content) =>
    new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, session, runId, { content }));
  expect(reply).toMatchObject({ content: "One admissions reply arrived.", session_id: session });
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(0);
  const now = Date.now();
  const previousSlot = new Date("2026-10-24T07:00:00Z");
  const slot = nextGmailDigestSlot("08:00", "Europe/London", previousSlot);
  expect(slot.toISOString()).toBe("2026-10-25T08:00:00.000Z");
  const fallWindow = gmailDigestDailyWindow(previousSlot, new Date(slot.getTime() + 180_000), slot, "08:00", "Europe/London");
  expect(fallWindow).toEqual({ start: previousSlot, end: slot, gapBefore: false });
  const firstHour = deliver({ at: previousSlot.getTime() + 1000 });
  const fallPage = await readGmailDigestPage(config, db.pool, {
    spaceId: space, ownerUserId: owner, connectionId, kind: "daily", window: fallWindow,
    ids: null, pageToken: null, signal: new AbortController().signal, authorizeSend: async () => {},
  });
  expect(fallPage.items.map(item => item.id)).toEqual([firstHour.id]);
  const old = deliver({ at: now - 48 * 3600_000 });
  const fresh = deliver({ at: now - 1000 });
  const archived = deliver({ at: now - 2000, labels: ["UNREAD"] });
  const dailyPage = await readGmailDigestPage(config, db.pool, {
    spaceId: space, ownerUserId: owner, connectionId, kind: "daily",
    window: { start: new Date(now - 24 * 3600_000), end: new Date(now + 1000) }, ids: null, pageToken: null,
    signal: new AbortController().signal, authorizeSend: async () => {},
  });
  expect(dailyPage.items.map(item => item.id)).toContain(fresh.id);
  expect(dailyPage.items.map(item => item.id)).not.toContain(old.id);
  expect(dailyPage.items.map(item => item.id)).not.toContain(archived.id);
  const dailyRequest = google.calls.map(call => new URL(call.url)).find(url => url.searchParams.get("labelIds") === "INBOX");
  expect(dailyRequest?.searchParams.get("q")).toMatch(/^after:\d+ before:\d+$/);
  as(admin);
  expect((await list()).json()).toEqual({ digests: [] });
  as(owner);
  const end = await app.inject({ method: "POST", url: `/api/v1/sources/gmail/digests/${ruleDigest.id}/end`,
    headers: { "idempotency-key": randomUUID() }, payload: {} });
  expect(end.statusCode, end.body).toBe(200);
  expect((await setting(false)).statusCode).toBe(200);
  expect((await list()).json().digests.every((digest: { status: string }) => digest.status === "ended")).toBe(true);
  expect(google.calls.every(call => call.method === "GET")).toBe(true);
});

it.each([
  "complete", "early reply", "message failure", "run failure", "revoked", "limit", "paused in flight",
] as const)("settles a daily Gmail window only after complete authorized reads (%s)", async (scenario) => {
  const { setting, run } = await digestConversation();
  const draft = await proposeGmailDigest(db.pool, run, space, { kind: "daily", local_time: "08:00", time_zone: "Europe/London" }, randomUUID());
  expect(draft.modelResult).toMatchObject({ status: "pending" });
  const proposal = "proposal_id" in draft.modelResult ? draft.modelResult.proposal_id : "";
  expect((await accept(proposal)).statusCode).toBe(200);
  const covered = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600_000);
  const digestId = (await db.pool.query<{ id: string }>(`UPDATE gmail_digests
    SET covered_until=$1,next_run_at=now() WHERE space_id=$2 RETURNING id`, [covered, space])).rows[0]!.id;
  const digestRow = async () => (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [digestId])).rows[0];
  const attempt = async () => (await db.pool.query(`SELECT * FROM gmail_digest_deliveries
    WHERE digest_id=$1 ORDER BY created_at DESC LIMIT 1`, [digestId])).rows[0];
  const hostId = await digestHost(run);
  expect(await startGmailDigestDelivery(db.pool, config, digestId)).toBe("started");
  const { run_id: runId, window_end: end, window_start: start } = await attempt();
  expect(start).toEqual(covered);
  const { loadRun, read } = await launchDigestReader(run, runId, hostId);
  const inside = scenario === "limit" ? GMAIL_DIGEST_LIMITS.messagesPerCall * GMAIL_DIGEST_LIMITS.readsPerRun + 1 : 12;
  // List search is second-granular, but the delivery's interval is [start, end).
  const expected = Array.from({ length: inside }, (_, i) => deliver({ at: covered.getTime() + i + 1 }).id);
  expected.push(deliver({ at: covered.getTime() }).id);
  deliver({ at: covered.getTime() - 1 });
  deliver({ at: end.getTime() });
  expected.push(deliver({ at: end.getTime() - 1 }).id);
  const page = async (token?: string): Promise<GmailDigestReadOutput> => {
    const response = await read(token);
    expect(response).toMatchObject({ httpStatus: 200, body: { ok: true } });
    return response.body.data as GmailDigestReadOutput;
  };
  const first = await page();
  expect(first).toMatchObject({ more_in_window: true, next_page_token: expect.any(String) });
  expect((await attempt()).read_complete).toBe(false);
  const firstToken = first.next_page_token!;
  if (scenario === "complete") {
    const sends = google.calls.length;
    expect((await read()).httpStatus).toBe(422);
    expect(google.calls).toHaveLength(sends);
  }
  if (scenario === "message failure") google.failDigestMessage = expected[0]!;
  if (scenario === "revoked") expect((await setting(false)).statusCode).toBe(200);

  if (scenario === "message failure" || scenario === "revoked") {
    expect((await read(firstToken)).httpStatus).not.toBe(200);
    expect((await attempt()).read_complete).toBe(false);
  } else if (scenario !== "early reply") {
    const items = [...first.items];
    let next = first;
    for (let index = 1; next.more_in_window && index < GMAIL_DIGEST_LIMITS.readsPerRun; index++) {
      next = await page(next.next_page_token!);
      items.push(...next.items);
    }
    if (scenario === "limit") {
      expect(next.more_in_window).toBe(true);
      expect((await read(next.next_page_token!)).httpStatus).toBe(429);
      expect((await attempt()).read_complete).toBe(false);
    } else {
      expect(next.more_in_window).toBe(false);
      expect(items.map(item => item.id).sort()).toEqual(expected.sort());
      expect((await attempt()).read_complete).toBe(true);
      if (scenario === "complete") expect((await read(firstToken)).httpStatus).not.toBe(200);
    }
  }

  if (scenario === "paused in flight") {
    expect((await digestStatus(digestId, "paused")).statusCode).toBe(200);
    expect((await digestStatus(digestId, "active")).statusCode).toBe(200);
  }
  await db.pool.query(`UPDATE runs SET status=$2,output_json=$3::jsonb WHERE id=$1`,
    [runId, scenario === "run failure" ? "failed" : "succeeded", JSON.stringify({ summary: "Synthetic summary" })]);
  const completedRun = await loadRun();
  const result = await finalizeChatTurn(config, new PgRunRepository(db.pool, config), completedRun);
  if (scenario === "complete") {
    expect(result).toMatchObject({ ok: true, assistant_message: { content: "Synthetic summary" } });
    expect(await attempt()).toMatchObject({ status: "delivered", read_complete: true, error_code: null, message_count: expected.length });
    expect(await digestRow()).toMatchObject({ covered_until: end, last_delivered_at: expect.any(Date), failure_count: 0 });
    return;
  }

  if (scenario === "paused in flight") {
    expect(result).toMatchObject({ ok: false, error_code: "gmail_digest_not_delivered", assistant_message: null });
    expect(await attempt()).toMatchObject({ status: "failed", error_code: "gmail_digest_unavailable", read_complete: true });
    expect(await digestRow()).toMatchObject({ status: "active", last_delivered_at: null, failure_count: 0, retry_not_before: null });
    expect((await digestRow()).covered_until.getTime()).toBeGreaterThanOrEqual(end.getTime());
    return;
  }

  const code = scenario === "limit" ? "gmail_digest_read_limit" : scenario === "revoked" ? "gmail_digest_unavailable"
    : scenario === "run failure" ? "gmail_digest_run_failed" : "gmail_digest_window_incomplete";
  expect(result).toMatchObject({ ok: false, error_code: "gmail_digest_not_delivered", assistant_message: null, reply: null });
  expect(await attempt()).toMatchObject({ status: "failed", error_code: code });
  expect(await digestRow()).toMatchObject({ covered_until: covered, last_delivered_at: null, last_error_code: code, failure_count: 1 });

  if (scenario === "limit") {
    expect(await digestRow()).toMatchObject({ status: "paused", next_run_at: null, retry_not_before: null });
    expect(await startGmailDigestDelivery(db.pool, config, digestId)).toBe("not_due");
    const failed = await attempt();
    expect((await digestStatus(digestId, "active")).statusCode).toBe(200);
    const resumed = await digestRow();
    expect(resumed).toMatchObject({ status: "active", failure_count: 0, last_error_code: null });
    expect(resumed.covered_until.getTime()).toBeGreaterThanOrEqual(end.getTime());
    expect(await attempt()).toEqual(failed);
    expect((await recordHostThreadOutcome(config, completedRun.host_task_thread_id!, completedRun, false)).claim).toBe("released");
    await db.pool.query(`UPDATE gmail_digests SET next_run_at=clock_timestamp() WHERE id=$1`, [digestId]);
    expect(await startGmailDigestDelivery(db.pool, config, digestId)).toBe("started");
    expect(await attempt()).toMatchObject({ window_start: resumed.covered_until, status: "running" });
  } else if (scenario === "message failure") {
    const hostSettlement = await recordHostThreadOutcome(config, completedRun.host_task_thread_id!, completedRun, false);
    expect(hostSettlement.claim).toBe("released");
    expect(await startGmailDigestDelivery(db.pool, config, digestId)).toBe("not_due");
    await db.pool.query(`UPDATE gmail_digests SET retry_not_before=now() WHERE id=$1`, [digestId]);
    expect(await startGmailDigestDelivery(db.pool, config, digestId)).toBe("started");
    expect(await attempt()).toMatchObject({ status: "running", window_start: start, window_end: end, message_count: 0 });
  }
});

it("acceptance: a confirmed daily digest is delivered on the conversation's remote codex_cli native login, reads its window and settles into that conversation", async () => {
  const { run, session } = await digestConversation();
  const draft = await proposeGmailDigest(db.pool, run, space, { kind: "daily", local_time: "08:00", time_zone: "Europe/London" }, randomUUID());
  const proposal = "proposal_id" in draft.modelResult ? draft.modelResult.proposal_id : "";
  expect((await accept(proposal)).statusCode).toBe(200);
  const covered = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600_000);
  const digestId = (await db.pool.query<{ id: string }>(`UPDATE gmail_digests SET covered_until=$1,next_run_at=now() WHERE space_id=$2 RETURNING id`, [covered, space])).rows[0]!.id;
  // The conversation's Agent runs on the owner's paired (remote) Host with codex_cli on its own login (runtime_native).
  const agentId = (await db.pool.query<{ agent_id: string }>(`SELECT agent_id FROM runs WHERE id=$1`, [run])).rows[0]!.agent_id;
  const remote = randomUUID();
  await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,$2,'Laptop','workstation',now(),now())`, [remote, owner]);
  await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,last_heartbeat_at,created_at,updated_at)
    VALUES ($1,$2,$1,'laptop','remote','linux_native','online',$3::jsonb,now(),now(),now())`, [remote, owner, JSON.stringify({ runtimes: [], versions: {},
    installations: { codex_cli: [{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, options: null, health_check_protocol: "acp" }] } })]);
  await db.pool.query(`UPDATE agent_runtime_profiles SET execution_host_id=$2,workspace_mode='managed',runtime_installation='managed:1.0.0',runtime_key='codex_cli',
      backend_mode='runtime_native',model_provider_id=NULL,model_name=NULL WHERE agent_id=$1 AND is_default`, [agentId, remote]);
  await new PgProjectAgentRepository(db.pool).upsertActive({ spaceId: space, projectId: project, agentId, userId: owner });
  const started = await startGmailDigestDelivery(db.pool, config, digestId);
  expect(started, JSON.stringify((await db.pool.query(`SELECT last_error_code FROM gmail_digests WHERE id=$1`, [digestId])).rows[0])).toBe("started");
  const delivery = (await db.pool.query(`SELECT * FROM gmail_digest_deliveries WHERE digest_id=$1`, [digestId])).rows[0];
  // Routed as the queue routes it: the conversation's own Runtime Profile.
  const created = (await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [delivery.run_id])).rows[0]!;
  const route = await new PgRouteDecisionRepository(db.pool).routeRun(created);
  const queued = (await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [delivery.run_id])).rows[0]!;
  // An owner-only automation turn in that private conversation, with only the digest read, on the conversation's own runtime.
  expect(route, JSON.stringify(route)).toMatchObject({ runtime_key: "codex_cli" });
  expect(queued).toMatchObject({ trigger_origin: "automation", visibility: "private", session_id: session });
  expect(queued.runtime_profile_snapshot_json).toMatchObject({ backend_mode: "runtime_native", runtime_key: "codex_cli" });
  expect(runRequiresIsolatedLaunch(queued)).toBe(false);
  expect(await new PgRunRepository(db.pool, config).markRunRunning({ run_id: queued.id, space_id: space, started_at: new Date().toISOString() })).not.toBeNull();
  // Dispatched to the remote Host: launched (no isolation refusal), on the CLI's own login, without a model-only channel.
  class Sink implements HostFrameSink { sent: Record<string, unknown>[] = []; send(frame: Record<string, unknown>) { this.sent.push(frame); } close() {} }
  const registry = new HostConnectionRegistry(), sink = new Sink();
  registry.registerConnection(remote, sink);
  const fresh = (await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [queued.id])).rows[0]!;
  const execution = executeRemoteHostCliAdapter({ run: fresh, prompt: "digest", model: null, resume_session_id: null,
    workspace: { kind: "managed", agent_id: agentId, container: { kind: "conversation", conversation_id: session } } }, remote, null,
    { connectionRegistry: registry, config, db: db.pool, leaseRegistry: new ProviderProxyLeaseRegistry(), policyEnforcer: async () => ({ status: "allow" as const, policy_decision_record_id: null }),
      bindings: { async resolve() { return null; }, async record() {}, profileScope: (r, location) => resolveRuntimeProfileScope(db.pool, r, location) } });
  const ended = await Promise.race([execution.then(() => true), vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"), { timeout: 30000 }).then(() => false)]);
  expect(ended, JSON.stringify(ended ? await execution : null)).toBe(false);
  const frame = sink.sent.find((f) => f.type === "launch")! as Record<string, any>;
  expect(frame.model_channel).toBeUndefined();
  expect(frame.provider_binding).toMatchObject({ credential_source: "host_login" });
  try {
    // The window's mail through the server's broker, read by the running digest Run.
    const inside = [deliver({ at: covered.getTime() + 1000 }).id, deliver({ at: covered.getTime() + 2000 }).id];
    const transport = new CliAgentToolTransport(config, { actionEventSink: async () => {} });
    const page = await transport.call((await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [queued.id])).rows[0]!, { id: randomUUID(), name: "source.gmail.digest.read", arguments: {} });
    if (!(page instanceof OperationToolResponse)) throw new Error("Expected the Gmail digest operation response");
    expect(page.httpStatus, JSON.stringify(page.body)).toBe(200);
    expect((page.body.data as GmailDigestReadOutput).items.map((item) => item.id).sort()).toEqual(inside.sort());
  } finally {
    registry.receiveComplete(remote, queued.id, { exit_code: 0, timed_out: false, error: null }, String(frame.launch_id));
    await execution;
  }
  // Settled into the owner's private conversation it was set up in.
  await db.pool.query(`UPDATE runs SET status='succeeded',output_json=$2::jsonb WHERE id=$1`, [queued.id, JSON.stringify({ summary: "Two admissions emails today." })]);
  const result = await finalizeChatTurn(config, new PgRunRepository(db.pool, config), (await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [queued.id])).rows[0]!);
  expect(result).toMatchObject({ ok: true, assistant_message: { content: "Two admissions emails today." } });
  expect((await db.pool.query(`SELECT status,read_complete FROM gmail_digest_deliveries WHERE id=$1`, [delivery.id])).rows[0]).toEqual({ status: "delivered", read_complete: true });
  expect((await db.pool.query(`SELECT session_id FROM messages WHERE run_id=$1 AND role='assistant'`, [queued.id])).rows).toEqual([{ session_id: session }]);
});

it("drafts a monitor only in the owner's own private turn, as a private proposal only that owner can accept", async () => {
  const connectionId = await connect();
  // The tool is a conversation tool (person-scoped, like a memory), and it is an Agent-only proposal action.
  expect(CONVERSATION_TOOL_ALLOWANCE).toContain("source.gmail.monitor.propose");
  const definition = SYSTEM_ACTION_REGISTRY.find((d) => d.id === "source.gmail.monitor.propose")!;
  expect([...definition.visibility]).toEqual(["agent_tool"]);
  expect(definition).toMatchObject({ side_effects: "proposal", grantable: false, proposal_type: "gmail_monitor_create" });

  for (const shape of ["space_shared", "delegated"] as const) {
    const refused = await propose(await turn(owner, shape));
    expect(refused.modelResult).toMatchObject({ ok: false, error: "gmail_monitor_private_turn_required" });
  }
  expect((await propose(await turn(owner), { from_any: [], subject_any: [] })).modelResult).toMatchObject({ ok: false, error: "gmail_monitor_criteria_invalid" });
  // A person without a connection gets a fixed refusal; their own private turn is otherwise eligible.
  expect((await propose(await turn(peer))).modelResult).toMatchObject({ ok: false, error: "gmail_not_connected" });
  expect((await db.pool.query(`SELECT 1 FROM proposals WHERE proposal_type='gmail_monitor_create'`)).rows).toEqual([]);

  const run = await turn(owner);
  const key = randomUUID();
  const drafted = await propose(run, {}, key);
  expect(drafted.modelResult).toMatchObject({ ok: true, status: "pending" });
  // The tool result carries no criteria; a replay returns the same draft.
  expect(JSON.stringify(drafted)).not.toContain("uni.example");
  expect((await propose(run, {}, key)).modelResult.proposal_id).toBe(drafted.modelResult.proposal_id);
  // Concurrent replays of one new key serialize on the owner's locks: one draft, one id.
  const raceKey = randomUUID();
  const raced = await Promise.all([propose(run, {}, raceKey), propose(run, {}, raceKey), propose(run, {}, raceKey)]);
  expect(new Set(raced.map((r) => r.modelResult.proposal_id)).size).toBe(1);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM proposals WHERE action_idempotency_key=$1`, [raceKey])).rows[0].n).toBe(1);
  await db.pool.query(`DELETE FROM proposals WHERE action_idempotency_key=$1`, [raceKey]);
  const proposalId = String(drafted.modelResult.proposal_id);
  const row = (await db.pool.query(`SELECT visibility,owner_user_id,project_id,created_by_user_id,payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0];
  expect(row).toMatchObject({ visibility: "private", owner_user_id: owner, project_id: null, created_by_user_id: null });
  expect(row.payload_json).toMatchObject({ connection_id: connectionId, target_project_id: project, criteria: { from_any: ["@uni.example"], subject_any: ["interview"], label_any: [] } });
  expect(google.calls).toEqual([]);

  // Nobody else sees or decides it: not a Project member, not the Space admin.
  for (const other of [peer, admin]) {
    as(other);
    const list = await app.inject({ method: "GET", url: "/api/v1/proposals?status=pending" });
    expect(list.body).not.toContain(proposalId);
    expect([403, 404]).toContain((await accept(proposalId)).statusCode);
  }
  expect((await db.pool.query(`SELECT 1 FROM gmail_monitor_rules`)).rows).toEqual([]);
  as(owner);
  const accepted = await accept(proposalId);
  expect(accepted.statusCode, accepted.body).toBe(200);
  const rule = (await db.pool.query(`SELECT * FROM gmail_monitor_rules`)).rows;
  expect(rule).toEqual([expect.objectContaining({ owner_user_id: owner, gmail_connection_id: connectionId, project_id: project, status: "active", proposal_id: proposalId })]);
  expect(await syncRow(connectionId)).toMatchObject({ state: "baseline", history_id: null });
  expect((await db.pool.query(`SELECT payload_json FROM jobs WHERE job_type='gmail_mailbox_sync'`)).rows).toEqual([{ payload_json: { connection_id: connectionId } }]);
  // The list is the owner's only.
  expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/monitors" })).json().monitors).toHaveLength(1);
  as(peer);
  expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/monitors" })).json()).toMatchObject({ monitors: [], sync: [], recent_matches: [] });
});

it("never treats the inbox's old mail as new on first enable, then reminds the owner privately once per matching message", async () => {
  const connectionId = await connect();
  for (let i = 0; i < 3; i += 1) deliver({ at: Date.now() - 3 * 86_400_000 + i });
  const monitorId = await monitor(connectionId);
  // Arrives after acceptance but before the first sync: the baseline scan (after: acceptance) still finds it.
  const early = deliver();
  const first = await sync(connectionId);
  expect(first).toMatchObject({ status: "synced", newMatches: 1 });
  expect(await matches()).toEqual([{ rule_id: monitorId, google_message_id: early.id }]);
  const afterBaseline = await syncRow(connectionId);
  expect(afterBaseline).toMatchObject({ state: "ok", history_id: String(google.historyId), lease_id: null, failure_count: 0 });
  // The baseline read headers only: profile, one after: page and message metadata, never a body.
  expect(google.calls.some((c) => c.url.includes("format=full") || c.url.includes("format=raw"))).toBe(false);

  const hit = deliver();
  deliver({ from: "News <news@other.example>", subject: "interview tips" });
  deliver({ subject: `${SUBJECT_MARK} interview`, labels: ["DRAFT"] });
  deliver({ labels: ["SENT"] });
  deliver({ from: `Dean <dean@cs.uni.example>`, subject: "Re: Interview schedule" });
  google.calls = [];
  const second = await sync(connectionId);
  expect(second).toMatchObject({ status: "synced", newMatches: 2 });
  expect(gets("/history?")).toHaveLength(1);
  expect((await matches()).map((m) => m.google_message_id)).toContain(hit.id);
  // A duplicate wake-up (push replay) and an out-of-order cursor overlap change nothing.
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 0 });
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET history_id=$2 WHERE gmail_connection_id=$1`, [connectionId, afterBaseline.history_id]);
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 0 });
  expect((await syncRow(connectionId)).history_id).toBe(String(google.historyId));
  expect(await matches()).toHaveLength(3);
  const rule = (await db.pool.query(`SELECT match_count FROM gmail_monitor_rules WHERE id=$1`, [monitorId])).rows[0];
  expect(rule.match_count).toBe(3);

  // One private, content-free Inbox pointer for the owner: no subject, sender or Project on it.
  const rows = await alerts();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ user_id: owner, owner_user_id: owner, visibility: "private", project_id: null, status: "raw" });
  expect(rows[0].payload_json).toMatchObject({ pointer_type: "gmail_monitor_matches", monitor_id: monitorId, connection_id: connectionId });
  // Nothing at rest holds subject, sender or token: rules, cursor, ledger, Jobs, alerts, proposals, policy records.
  const dump: Record<string, unknown[]> = {};
  for (const table of ["gmail_monitor_rules", "gmail_mailbox_sync_states", "gmail_monitor_matches", "jobs", "job_events", "activity_records", "proposals",
    "policy_decision_records", "operation_idempotency", "source_items", "gmail_read_audit_events"]) dump[table] = (await db.pool.query(`SELECT * FROM ${table}`)).rows;
  const text = JSON.stringify(dump);
  for (const secret of [SUBJECT_MARK, SENDER_MARK, "news@other.example", "ya29.", "Interview schedule"]) expect(text).not.toContain(secret);
  // The owner's list shows match ids and Gmail links only.
  const listed = await app.inject({ method: "GET", url: "/api/v1/sources/gmail/monitors" });
  expect(listed.json().recent_matches).toHaveLength(3);
  expect(listed.body).not.toContain(SUBJECT_MARK);
});

it("pages history and stops at the last fully processed record when a sync reaches its message bound", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 0 });
  google.historyPageSize = 10;
  const sent = Array.from({ length: 45 }, () => deliver());
  google.calls = [];
  const first = await sync(connectionId);
  expect(first).toMatchObject({ status: "synced", newMatches: 40, more: true });
  expect(gets("/history?").length).toBe(5);
  const row = await syncRow(connectionId);
  // The cursor is the 40th message's record; a follow-up sync is requested at once.
  expect(row.history_id).toBe(google.history.find((r) => r.messageIds[0] === sent[39]!.id)!.id);
  expect(row.sync_requested_at).not.toBeNull();
  await db.pool.query(`DELETE FROM jobs`);
  expect(await enqueueDueGmailMailboxSyncs(db.pool)).toBe(1);
  expect(await enqueueDueGmailMailboxSyncs(db.pool)).toBe(0);
  // The follow-up waits for the next quota minute rather than exceeding it.
  expect(await sync(connectionId)).toMatchObject({ status: "failed", code: "gmail_quota_exhausted" });
  expect((await syncRow(connectionId)).history_id).toBe(row.history_id);
  await retryFloorPasses(connectionId);
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 5, more: false });
  expect((await matches()).map((m) => m.google_message_id).sort()).toEqual(sent.map((m) => m.id).sort());
});

it("recovers an expired cursor with a bounded scan from the last success, and reports what did not fit as partial", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  const missed = [deliver(), deliver(), deliver()];
  google.expiredBelow = google.historyId + 1;
  const expired = await sync(connectionId);
  expect(expired).toMatchObject({ status: "synced", newMatches: 0, more: true });
  expect(await syncRow(connectionId)).toMatchObject({ state: "recovering", last_error_code: "gmail_history_expired" });
  google.calls = [];
  // The position is read before the scan; mail arriving after it is ordinary history next time.
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 3 });
  expect(google.calls.map((c) => new URL(c.url).pathname.split("/").pop())[0]).toBe("profile");
  expect(await syncRow(connectionId)).toMatchObject({ state: "ok", recovery_partial: false, last_error_code: null });
  expect((await matches()).map((m) => m.google_message_id).sort()).toEqual(missed.map((m) => m.id).sort());

  // More than one recovery page: the first page is checked, the rest is reported, never silently skipped.
  Array.from({ length: 41 }, () => deliver());
  google.expiredBelow = google.historyId + 1;
  await nextMinute();
  await sync(connectionId);
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 40 });
  expect(await syncRow(connectionId)).toMatchObject({ state: "ok", recovery_partial: true });
  const status = (await app.inject({ method: "GET", url: "/api/v1/sources/gmail/monitors" })).json().sync[0];
  expect(status).toMatchObject({ connection_id: connectionId, state: "ok", recovery_partial: true });
});

it("does not advance past mail a monitor accepted during an in-flight sync never checked", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  const before = (await syncRow(connectionId)).history_id;
  let reached!: () => void, open!: () => void;
  const reachedP = new Promise<void>((resolve) => { reached = resolve; });
  google.gate = { reached, opened: new Promise<void>((resolve) => { open = resolve; }) };
  const running = sync(connectionId);
  await reachedP;
  // While the history read is in flight: a second monitor is accepted and mail only it matches arrives.
  const second = await monitor(connectionId, { from_any: ["news@other.example"], subject_any: [] });
  const onlySecond = deliver({ from: "News <news@other.example>", subject: "Weekly digest" });
  open();
  expect(await running).toMatchObject({ status: "synced", newMatches: 0, more: true });
  const kept = await syncRow(connectionId);
  expect(kept.history_id).toBe(before);
  expect(kept.sync_requested_at).not.toBeNull();
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect(await matches()).toEqual([{ rule_id: second, google_message_id: onlySecond.id }]);
  expect((await syncRow(connectionId)).history_id).toBe(String(google.historyId));
});

it("serializes concurrent syncs by lease, backs off on Google rate limits with the cursor kept, and retries later", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  deliver();
  const both = await Promise.all([sync(connectionId), sync(connectionId)]);
  expect(both.map((o) => o.status).sort()).toEqual(["busy", "synced"]);
  expect(await matches()).toHaveLength(1);
  const before = await syncRow(connectionId);
  deliver();
  google.failHistory = 1;
  expect(await sync(connectionId)).toMatchObject({ status: "failed", code: "gmail_rate_limited" });
  const failed = await syncRow(connectionId);
  expect(failed).toMatchObject({ history_id: before.history_id, failure_count: 1, last_error_code: "gmail_rate_limited", lease_id: null });
  expect(new Date(failed.next_poll_at).getTime()).toBeGreaterThan(Date.now());
  // Not due yet: the heartbeat leaves it alone until its backoff (and Google's cooldown) ends.
  await db.pool.query(`DELETE FROM jobs`);
  expect(await enqueueDueGmailMailboxSyncs(db.pool)).toBe(0);
  // A Job queued earlier cannot start before the floor either: the claim checks it and sends nothing.
  google.calls = [];
  expect(await sync(connectionId)).toEqual({ status: "waiting" });
  expect(google.calls).toEqual([]);
  await retryFloorPasses(connectionId);
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect(await syncRow(connectionId)).toMatchObject({ failure_count: 0, last_error_code: null, retry_not_before: null });
});

it("pauses with the cursor kept when the connection loses authority, and resumes from it after reconnecting the same account", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  const kept = (await syncRow(connectionId)).history_id;
  await app.inject({ method: "POST", url: `/api/v1/sources/gmail/connections/${connectionId}/disconnect`, headers: { "idempotency-key": randomUUID() } });
  deliver();
  google.calls = [];
  expect(await sync(connectionId)).toEqual({ status: "inactive" });
  expect(google.calls).toEqual([]);
  expect(await syncRow(connectionId)).toMatchObject({ history_id: kept, last_error_code: "gmail_connection_inactive" });
  await db.pool.query(`DELETE FROM jobs`);
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET next_poll_at=now() WHERE gmail_connection_id=$1`, [connectionId]);
  expect(await enqueueDueGmailMailboxSyncs(db.pool)).toBe(0);
  // Reconnecting the same Google account reuses the row: the monitor and cursor carry on.
  await reconnect(connectionId);
  // Resumed at once, not after the parked interval: the stale authority code is cleared and a sync is queued.
  const resumed = await syncRow(connectionId);
  expect(resumed).toMatchObject({ history_id: kept, last_error_code: null, retry_not_before: null });
  expect(new Date(resumed.next_poll_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  expect((await db.pool.query(`SELECT payload_json FROM jobs WHERE job_type='gmail_mailbox_sync' AND status='pending'`)).rows).toEqual([{ payload_json: { connection_id: connectionId } }]);
  google.calls = [];
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect(new URL(gets("/history?")[0]!.url).searchParams.get("startHistoryId")).toBe(kept);
  // A person who left the Space gets nothing synced on their behalf.
  await db.pool.query(`UPDATE space_memberships SET status='revoked' WHERE user_id=$1 AND space_id=$2`, [owner, space]);
  google.calls = [];
  expect(await sync(connectionId)).toEqual({ status: "inactive" });
  expect(google.calls).toEqual([]);
});

it("keeps monitor commands owner-only, and a resumed monitor never reminds about mail received while it was paused", async () => {
  const connectionId = await connect();
  const monitorId = await monitor(connectionId);
  await sync(connectionId);
  const setStatus = (status: string) => app.inject({ method: "POST", url: `/api/v1/sources/gmail/monitors/${monitorId}/status`, headers: { "idempotency-key": randomUUID() }, payload: { status } });
  for (const other of [peer, admin]) {
    as(other);
    expect((await setStatus("paused")).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/sources/gmail/monitors/${monitorId}`, headers: { "idempotency-key": randomUUID() } })).statusCode).toBe(404);
  }
  as(owner);
  expect((await setStatus("paused")).json().data).toEqual({ monitor_id: monitorId, space_id: space, status: "paused" });
  deliver();
  expect(await sync(connectionId)).toEqual({ status: "idle" });
  expect((await setStatus("active")).statusCode).toBe(200);
  expect(await syncRow(connectionId)).toMatchObject({ state: "baseline" });
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 0 });
  const after = deliver();
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect(await matches()).toEqual([{ rule_id: monitorId, google_message_id: after.id }]);
  // Delete removes the monitor and its ledger; forget of the connection cascades the cursor.
  expect((await app.inject({ method: "DELETE", url: `/api/v1/sources/gmail/monitors/${monitorId}`, headers: { "idempotency-key": randomUUID() } })).statusCode).toBe(200);
  expect(await matches()).toEqual([]);
  await app.inject({ method: "POST", url: `/api/v1/sources/gmail/connections/${connectionId}/disconnect`, headers: { "idempotency-key": randomUUID() } });
  expect((await app.inject({ method: "DELETE", url: `/api/v1/sources/gmail/connections/${connectionId}`, headers: { "idempotency-key": randomUUID() } })).statusCode).toBe(200);
  expect(await syncRow(connectionId)).toBeUndefined();
  // The dedup ledger is pruned after its window.
  expect(await pruneGmailMonitorMatches(db.pool)).toBe(0);
});

it("renews the Gmail watch only with push configured, and keeps scheduled checks without it", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  expect(await sync(connectionId, noPushConfig)).toMatchObject({ status: "synced" });
  expect(google.calls.filter((c) => c.method === "POST")).toEqual([]);
  const scheduled = await syncRow(connectionId);
  expect(new Date(scheduled.next_poll_at).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  google.calls = [];
  await sync(connectionId);
  const watch = google.calls.filter((c) => c.method === "POST");
  expect(watch).toHaveLength(1);
  expect(watch[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/watch");
  expect(JSON.parse(watch[0]!.body!)).toEqual({ topicName: TOPIC });
  const pushed = await syncRow(connectionId);
  expect(pushed.watch_expires_at).not.toBeNull();
  // With a current watch the scheduled check is only the catch-up.
  expect(new Date(pushed.next_poll_at).getTime() - Date.now()).toBeGreaterThan(60 * 60_000);
  google.calls = [];
  await sync(connectionId);
  expect(google.calls.filter((c) => c.method === "POST")).toEqual([]);
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET watch_expires_at=now()+interval '2 hours' WHERE gmail_connection_id=$1`, [connectionId]);
  await sync(connectionId);
  expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

function pushToken(claims: Record<string, unknown> = {}, key = signingKey.privateKey, kid = KID): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: AUDIENCE, email: PUSH_ACCOUNT, email_verified: true, iat: now, exp: now + 3600, ...claims })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
}
const pushBody = (email = "owner@gmail.example", subscription = SUBSCRIPTION) => ({
  message: { data: Buffer.from(JSON.stringify({ emailAddress: email, historyId: "99999999" })).toString("base64"), messageId: "1", publishTime: new Date().toISOString() },
  subscription,
});
const push = (token: string | null, body: unknown = pushBody()) => app.inject({ method: "POST", url: "/api/v1/sources/gmail/push",
  headers: { "content-type": "application/json", ...token ? { authorization: `Bearer ${token}` } : {} }, payload: JSON.stringify(body) });

it("accepts only Google-signed pushes for this subscription and uses them as a wake-up, never as a cursor", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  await db.pool.query(`DELETE FROM jobs`);
  const cursor = (await syncRow(connectionId)).history_id;
  for (const token of [null, pushToken({ aud: "https://elsewhere.example/api/v1/sources/gmail/push" }), pushToken({ email: "intruder@evil-proj.iam.gserviceaccount.com" }),
    pushToken({ email_verified: false }), pushToken({ exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 4000 }),
    pushToken({ iss: "https://evil.example" }), pushToken({}, otherKey.privateKey), pushToken({}, signingKey.privateKey, "unknown-kid")]) {
    expect((await push(token)).statusCode).toBe(401);
  }
  expect((await db.pool.query(`SELECT 1 FROM jobs`)).rows).toEqual([]);
  expect((await syncRow(connectionId)).sync_requested_at).toBeNull();
  // Another subscription or another mailbox is acknowledged and changes nothing.
  expect((await push(pushToken(), pushBody("owner@gmail.example", "projects/rainver-test-proj/subscriptions/other"))).statusCode).toBe(204);
  expect((await push(pushToken(), pushBody("stranger@gmail.example"))).statusCode).toBe(204);
  expect((await db.pool.query(`SELECT 1 FROM jobs`)).rows).toEqual([]);
  // A valid push marks the cursor and queues one Job; a duplicate push queues nothing more.
  expect((await push(pushToken())).statusCode).toBe(204);
  expect((await push(pushToken())).statusCode).toBe(204);
  expect((await db.pool.query(`SELECT payload_json FROM jobs WHERE job_type='gmail_mailbox_sync'`)).rows).toEqual([{ payload_json: { connection_id: connectionId } }]);
  const marked = await syncRow(connectionId);
  expect(marked.sync_requested_at).not.toBeNull();
  expect(marked.last_push_at).not.toBeNull();
  // The notification's historyId is never stored.
  expect(marked.history_id).toBe(cursor);
  expect(JSON.stringify(await db.pool.query(`SELECT * FROM gmail_mailbox_sync_states`).then((r) => r.rows))).not.toContain("99999999");
  // A body over the limit is refused before parsing.
  expect((await push(pushToken(), { message: { data: "A".repeat(9000) }, subscription: SUBSCRIPTION })).statusCode).toBe(413);
  // Not configured: the endpoint does not exist.
  await app.close();
  app = buildModuleServer(noPushConfig, [sourcesModule, systemActionsModule, proposalsModule]);
  expect((await push(pushToken())).statusCode).toBe(404);
});

it("checks a single history record larger than one sync in parts, persisting its progress and moving the cursor only once it is done", async () => {
  const connectionId = await connect();
  const monitorId = await monitor(connectionId);
  await sync(connectionId);
  const before = (await syncRow(connectionId)).history_id;
  const { recordId, mails } = deliverRecord(45);
  const first = await sync(connectionId);
  expect(first).toMatchObject({ status: "synced", newMatches: 40, more: true });
  // The cursor stays before the record; the record's progress is persisted with it.
  expect(await syncRow(connectionId)).toMatchObject({ history_id: before, record_history_id: recordId, record_offset: 40 });
  // A failed retry keeps both (no cursor or progress loss) and sets the retry floor.
  await nextMinute();
  google.failHistory = 1;
  expect(await sync(connectionId)).toMatchObject({ status: "failed", code: "gmail_rate_limited" });
  expect(await syncRow(connectionId)).toMatchObject({ history_id: before, record_history_id: recordId, record_offset: 40 });
  await retryFloorPasses(connectionId);
  google.calls = [];
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 5, more: false });
  // Only the rest of the record was read; the cursor is past it now and its progress cleared.
  expect(gets("/messages/")).toHaveLength(5);
  expect(await syncRow(connectionId)).toMatchObject({ history_id: String(google.historyId), record_history_id: null, record_offset: 0 });
  expect((await matches()).map((m) => m.google_message_id).sort()).toEqual(mails.map((m) => m.id).sort());
  expect((await db.pool.query(`SELECT match_count FROM gmail_monitor_rules WHERE id=$1`, [monitorId])).rows[0].match_count).toBe(45);
  // A replay of the whole range reminds about nothing twice.
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET history_id=$2 WHERE gmail_connection_id=$1`, [connectionId, before]);
  await nextMinute();
  await sync(connectionId);
  await nextMinute();
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 0 });
  expect(await matches()).toHaveLength(45);
});

it("never delivers an in-flight batch for a monitor paused and resumed meanwhile, and does not skip what its new version has not checked", async () => {
  const connectionId = await connect();
  const resumedId = await monitor(connectionId);
  // A second active monitor, so resuming the first does not restart a baseline.
  await monitor(connectionId, { from_any: ["news@other.example"], subject_any: [] });
  await sync(connectionId);
  const before = (await syncRow(connectionId)).history_id;
  const held = holdHistory();
  const running = sync(connectionId);
  await held.reached;
  const setStatus = (status: string) => app.inject({ method: "POST", url: `/api/v1/sources/gmail/monitors/${resumedId}/status`, headers: { "idempotency-key": randomUUID() }, payload: { status } });
  expect((await setStatus("paused")).statusCode).toBe(200);
  // Mail of the paused period: the in-flight sync sees it with the monitor's old start time.
  const pausedPeriod = deliver();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await setStatus("active")).statusCode).toBe(200);
  held.open();
  expect(await running).toMatchObject({ status: "synced", newMatches: 0, more: true });
  expect(await matches()).toEqual([]);
  expect((await syncRow(connectionId)).history_id).toBe(before);
  // The follow-up checks the range with the monitor as it is now: paused-period mail never reminds,
  // mail since the resume does.
  const afterResume = deliver({ at: Date.now() + 1000 });
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect(await matches()).toEqual([{ rule_id: resumedId, google_message_id: afterResume.id }]);
  expect((await matches()).map((m) => m.google_message_id)).not.toContain(pausedPeriod.id);
  expect((await syncRow(connectionId)).history_id).toBe(String(google.historyId));
});

it("holds pushes and scheduled checks to the durable retry floor after a failure, keeping the pending request for later", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  await db.pool.query(`DELETE FROM jobs`);
  deliver();
  google.failHistory = 1;
  expect(await sync(connectionId)).toMatchObject({ status: "failed", code: "gmail_rate_limited" });
  const failed = await syncRow(connectionId);
  expect(new Date(failed.retry_not_before).getTime()).toBeGreaterThan(Date.now());
  // A push during the backoff marks the request but queues nothing; the heartbeat does not either.
  expect((await push(pushToken())).statusCode).toBe(204);
  expect((await syncRow(connectionId)).sync_requested_at).not.toBeNull();
  expect((await db.pool.query(`SELECT 1 FROM jobs`)).rows).toEqual([]);
  expect(await enqueueDueGmailMailboxSyncs(db.pool)).toBe(0);
  google.calls = [];
  expect(await sync(connectionId)).toEqual({ status: "waiting" });
  expect(google.calls).toEqual([]);
  expect((await syncRow(connectionId)).sync_requested_at).not.toBeNull();
  // Once the floor passes, the kept request is queued by the heartbeat and the mail is found.
  await retryFloorPasses(connectionId);
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET next_poll_at=now()+interval '1 hour' WHERE gmail_connection_id=$1`, [connectionId]);
  expect(await enqueueDueGmailMailboxSyncs(db.pool)).toBe(1);
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
});

it("records watch renewal failures apart from a settled increment, and never swallows lost authority during renewal", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  expect((await syncRow(connectionId)).watch_error_code).toBeNull();
  // Renewal due and refused by Google: the new mail still settles; the watch failure is its own record.
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET watch_expires_at=now()+interval '2 hours' WHERE gmail_connection_id=$1`, [connectionId]);
  const hit = deliver();
  google.watchFailures = [403];
  await nextMinute();
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect((await matches()).map((m) => m.google_message_id)).toContain(hit.id);
  const row = await syncRow(connectionId);
  expect(row).toMatchObject({ watch_error_code: "gmail_watch_refused", watch_failure_count: 1, last_error_code: null, failure_count: 0, retry_not_before: null });
  expect(new Date(row.watch_retry_at).getTime()).toBeGreaterThan(Date.now());
  // Not shown as active, and the scheduled check falls back to the short interval.
  expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/monitors" })).json().sync[0].push).toBe("inactive");
  expect(new Date(row.next_poll_at).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  // Before its retry time no renewal is sent; after it, a success clears the record.
  google.calls = [];
  await nextMinute();
  await sync(connectionId);
  expect(google.calls.filter((c) => c.method === "POST")).toEqual([]);
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET watch_retry_at=now()-interval '1 second' WHERE gmail_connection_id=$1`, [connectionId]);
  await nextMinute();
  await sync(connectionId);
  expect(await syncRow(connectionId)).toMatchObject({ watch_error_code: null, watch_failure_count: 0, watch_retry_at: null });
  expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/monitors" })).json().sync[0].push).toBe("active");

  // The owner leaves the Space while the history read is in flight; the renewal's recheck refuses.
  await db.pool.query(`UPDATE gmail_mailbox_sync_states SET watch_expires_at=now()+interval '2 hours' WHERE gmail_connection_id=$1`, [connectionId]);
  const kept = (await syncRow(connectionId)).history_id;
  await nextMinute();
  const held = holdHistory();
  google.calls = [];
  const running = sync(connectionId);
  await held.reached;
  await db.pool.query(`UPDATE space_memberships SET status='revoked' WHERE user_id=$1 AND space_id=$2`, [owner, space]);
  held.open();
  expect(await running).toMatchObject({ status: "failed", code: "gmail_authority_revoked" });
  expect(google.calls.filter((c) => c.method === "POST")).toEqual([]);
  expect(await syncRow(connectionId)).toMatchObject({ history_id: kept, last_error_code: "gmail_authority_revoked", watch_error_code: null });
});

it("commits the increment before a watch renewal, which runs on its own deadline, keeps Google's Retry-After and records its timeout", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  const renewalDue = () => db.pool.query(`UPDATE gmail_mailbox_sync_states SET watch_expires_at=now()+interval '2 hours',watch_retry_at=NULL WHERE gmail_connection_id=$1`, [connectionId]);
  const watchPosts = () => google.calls.filter((c) => c.method === "POST" && c.url.endsWith("/watch")).length;
  // Google throttles the renewal with Retry-After: the next renewal waits that long, not the 1 min backoff.
  await renewalDue(); await nextMinute();
  google.watchFailures = [{ status: 429, retryAfter: "7200" }];
  const first = deliver();
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  let row = await syncRow(connectionId);
  expect(row).toMatchObject({ watch_error_code: "gmail_watch_unavailable", last_error_code: null, retry_not_before: null, lease_id: null });
  expect(new Date(row.watch_retry_at).getTime() - Date.now()).toBeGreaterThan(110 * 60_000);

  // The renewal gets no answer until its own deadline ends. The increment beside it is already
  // committed (ledger, cursor), the lease is released and the renewal's timeout is recorded.
  await renewalDue(); await nextMinute();
  __setGmailReadControlForTests({ pageDeadlineMs: 2500 });
  google.watchFailures = ["hang"];
  const before = Number((await syncRow(connectionId)).history_id);
  const second = deliver();
  google.calls = [];
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect(watchPosts()).toBe(1);
  row = await syncRow(connectionId);
  expect((await matches()).map((m) => m.google_message_id)).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(Number(row.history_id)).toBeGreaterThan(before);
  expect(row).toMatchObject({ watch_error_code: "gmail_watch_timeout", watch_failure_count: 2, lease_id: null, last_error_code: null, failure_count: 0, retry_not_before: null });
  expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/monitors" })).json().sync[0].push).toBe("inactive");

  // The single request's own deadline ends while the renewal's deadline still has time:
  // that is a timeout too, not an uncertain send, and the increment still settles.
  __setGmailReadControlForTests({ pageDeadlineMs: null });
  __setGmailWatchGuardForTests(publicAddressGuard, { deadlineMs: 300 });
  await renewalDue(); await nextMinute();
  google.watchFailures = ["hang"];
  const third = deliver();
  google.calls = [];
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect(watchPosts()).toBe(1);
  expect((await matches()).map((m) => m.google_message_id)).toContain(third.id);
  expect(await syncRow(connectionId)).toMatchObject({ watch_error_code: "gmail_watch_timeout", watch_failure_count: 3, lease_id: null, last_error_code: null });
});

it("lets a reconnect supersede a sync in flight, so its late failure leaves no stale error or retry floor on the reconnected connection", async () => {
  const connectionId = await connect();
  await monitor(connectionId);
  await sync(connectionId);
  const kept = (await syncRow(connectionId)).history_id;
  const hit = deliver();
  await nextMinute();
  const held = holdHistory();
  const running = sync(connectionId);
  await held.reached;
  // Same account reconnected while the old generation's sync waits on Google.
  await reconnect(connectionId);
  held.open();
  expect(await running).toMatchObject({ status: "failed", code: "gmail_connection_changed" });
  expect(await syncRow(connectionId)).toMatchObject({ history_id: kept, last_error_code: null, retry_not_before: null, failure_count: 0, lease_id: null });
  // The resumed sync starts at once (no lease to wait out, no floor) from the kept cursor.
  await nextMinute();
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  expect((await matches()).map((m) => m.google_message_id)).toContain(hit.id);
});

const shareWithSpace = (type: string, id: string) => app.inject({ method: "PUT", url: `/api/v1/content-access/${type}/${id}`, headers: { "idempotency-key": randomUUID() },
  payload: { visibility: "space_shared", access_level: "full", project_id: type === "run" ? project : null, grants: [] } });
it("lets an active plain member accept their own monitor draft, while nobody else — oversight Space owner and admin included — sees, decides or replays it, or its reminder", async () => {
  await db.pool.query(`UPDATE spaces SET oversight_mode='full' WHERE id=$1`, [space]);
  as(peer);
  const connectionId = await connect("2002");
  const draftRun = await turn(peer);
  const drafted = await propose(draftRun);
  expect(drafted.modelResult.ok, JSON.stringify(drafted)).toBe(true);
  const proposalId = String(drafted.modelResult.proposal_id);
  // The Run evidence the dispatcher persists from the tool summary carries no proposal id.
  expect((drafted as unknown as { summary: Record<string, unknown> }).summary).toEqual({ tool_name: "source.gmail.monitor.propose", ok: true });
  const peerKey = randomUUID();
  const decide = (verb: "accept" | "reject", key = randomUUID()) => app.inject({ method: "POST", url: `/api/v1/proposals/${proposalId}/${verb}`, headers: { "idempotency-key": key }, payload: {} });
  for (const other of [owner, admin]) {
    as(other);
    // Generic list (all and typed), detail, Home, accept, reject and a replay of the owner's key: hidden.
    expect((await app.inject({ method: "GET", url: "/api/v1/proposals?status=pending" })).body).not.toContain(proposalId);
    expect((await app.inject({ method: "GET", url: "/api/v1/proposals?status=pending&type=gmail_monitor_create" })).body).not.toContain(proposalId);
    expect((await app.inject({ method: "GET", url: `/api/v1/proposals/${proposalId}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/home/summary" })).body).not.toContain(proposalId);
    expect((await decide("accept")).statusCode).toBe(404);
    expect((await decide("reject")).statusCode).toBe(404);
    expect((await decide("accept", peerKey)).statusCode).toBe(404);
    // The drafting Run is owner-only too: no trace, turn (with its card) or I/O under oversight.
    for (const path of ["", "/trace", "/turn", "/io"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/runs/${draftRun}${path}` });
      expect(res.statusCode, path).toBe(404);
      expect(res.body).not.toContain(proposalId);
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/runs" })).body).not.toContain(draftRun);
    // Nor can oversight read or change who may read the draft or that Run.
    for (const [type, id] of [["proposal", proposalId], ["run", draftRun]] as const) {
      expect((await app.inject({ method: "GET", url: `/api/v1/content-access/${type}/${id}` })).statusCode).toBe(404);
      expect((await shareWithSpace(type, id)).statusCode).toBe(404);
    }
  }
  as(peer);
  // The owner reads their own turn and its decision card; a reader without that identity gets no card.
  expect((await app.inject({ method: "GET", url: `/api/v1/runs/${draftRun}/trace` })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: `/api/v1/runs/${draftRun}/turn` })).body).toContain(proposalId);
  expect(JSON.stringify(await loadRunTurn(db.pool, { spaceId: space, runId: draftRun }))).not.toContain(proposalId);
  expect(JSON.stringify(await loadRunTurn(db.pool, { spaceId: space, runId: draftRun, viewerUserId: admin }))).not.toContain(proposalId);
  // Even the owner cannot widen an owner-only row.
  for (const [type, id] of [["proposal", proposalId], ["run", draftRun]] as const) {
    const widened = await shareWithSpace(type, id);
    expect(widened.statusCode, widened.body).toBe(409);
    expect(widened.body).toContain("owner_only_content");
  }
  expect((await db.pool.query(`SELECT status FROM proposals WHERE id=$1`, [proposalId])).rows[0].status).toBe("pending");
  // The owner — a plain member of this team Space — sees and accepts it; a same-key replay is the same result.
  as(peer);
  expect((await app.inject({ method: "GET", url: `/api/v1/proposals/${proposalId}` })).statusCode).toBe(200);
  const accepted = await decide("accept", peerKey);
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect((await decide("accept", peerKey)).statusCode).toBe(200);
  // Once the owner's success receipt exists, a replay of that key by anyone else is still hidden.
  for (const other of [owner, admin]) {
    as(other);
    const replay = await decide("accept", peerKey);
    expect(replay.statusCode).toBe(404);
    expect(replay.body).not.toContain(proposalId);
  }
  as(peer);
  const rule = (await db.pool.query(`SELECT id,owner_user_id FROM gmail_monitor_rules WHERE proposal_id=$1`, [proposalId])).rows;
  expect(rule).toEqual([{ id: expect.any(String), owner_user_id: peer }]);
  const audit = (await db.pool.query(`SELECT audit_code FROM policy_decision_records WHERE resource_id=$1 AND decision='allow'`, [proposalId])).rows;
  expect(audit.map((r) => r.audit_code)).toContain("approved_private_owner");

  // Its reminder is the owner's alone too.
  await sync(connectionId);
  deliver();
  expect(await sync(connectionId)).toMatchObject({ status: "synced", newMatches: 1 });
  const alert = (await alerts())[0];
  expect(alert).toMatchObject({ owner_user_id: peer, visibility: "private" });
  expect((await app.inject({ method: "GET", url: "/api/v1/activity" })).body).toContain(alert.id);
  const ownCount = (await app.inject({ method: "GET", url: "/api/v1/home/summary" })).json().activity_summary.recent_count;
  for (const other of [owner, admin]) {
    as(other);
    expect((await app.inject({ method: "GET", url: "/api/v1/activity" })).body).not.toContain(alert.id);
    expect((await app.inject({ method: "GET", url: `/api/v1/activity/${alert.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/home/summary" })).json().activity_summary.recent_count).toBe(ownCount - 1);
  }
  // That the narrow rule widens nothing else is pinned at the pure gate (proposalPrivateOwnerGate.test.ts).
});

it("upgrade (migration 0040): consents and cards given under the earlier private, isolated scope end; a digest keeps its schedule and history paused until the owner confirms it again in its conversation", async () => {
  const { connectionId, run, session } = await digestConversation();
  const draftDaily = await proposeGmailDigest(db.pool, run, space, { kind: "daily", local_time: "08:00", time_zone: "Europe/London" }, randomUUID());
  expect((await accept(String("proposal_id" in draftDaily.modelResult ? draftDaily.modelResult.proposal_id : ""))).statusCode).toBe(200);
  // A card still pending at the upgrade, and an on-demand Project consent of the same mailbox.
  const pendingRule = await proposeGmailDigest(db.pool, run, space, { kind: "rule" }, randomUUID());
  const pendingId = String("proposal_id" in pendingRule.modelResult ? pendingRule.modelResult.proposal_id : "");
  const generation = (await db.pool.query<{ generation: number }>(`SELECT generation FROM gmail_connections WHERE id=$1`, [connectionId])).rows[0]!.generation;
  const onDemand = randomUUID();
  await db.pool.query(`INSERT INTO plugin_data_grants (id,space_id,plugin_id,toolset,data_class,scope,data_owner_user_id,granted_by_user_id,target_run_id,plugin_version,authority_hash,expanded_json,status,
      expires_at,project_id,connection_id,connection_generation,purpose,created_at,updated_at)
    VALUES ($1,$2,'core:gmail','read','sensitive','project',$3,$3,NULL,'1','x','[]'::jsonb,'active',NULL,$4,$5,$6,'on_demand_read',now(),now())`,
    [onDemand, space, owner, project, connectionId, generation]);
  const before = (await db.pool.query(`SELECT * FROM gmail_digests WHERE space_id=$1 AND kind='daily'`, [space])).rows[0];
  await db.pool.query(`INSERT INTO gmail_digest_deliveries (id,digest_id,space_id,owner_user_id,window_start,window_end,gap_before,message_ids,run_id,status,message_count,read_complete,created_at,finished_at)
    VALUES ($1,$2,$3,$4,now()-interval '1 day',now()-interval '1 hour',false,NULL,NULL,'delivered',3,true,now()-interval '1 hour',now()-interval '1 hour')`, [randomUUID(), before.id, space, owner]);
  const messagesBefore = (await db.pool.query(`SELECT count(*)::int AS n FROM messages WHERE session_id=$1`, [session])).rows[0].n;

  const statements = readFileSync(join(import.meta.dirname, "./fixtures/preSquash/0040_gmail_project_scope_reconfirm.sql"), "utf8")
    .split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) await db.pool.query(statement);

  // Nothing given under the earlier scope admits any more; the pending card is closed; history stays.
  expect((await db.pool.query(`SELECT status FROM plugin_data_grants WHERE id=ANY($1::varchar[]) ORDER BY status`, [[onDemand, before.grant_id]])).rows)
    .toEqual([{ status: "revoked" }, { status: "revoked" }]);
  expect((await db.pool.query(`SELECT status FROM proposals WHERE id=$1`, [pendingId])).rows[0].status).toBe("superseded");
  const paused = (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [before.id])).rows[0];
  expect(paused).toMatchObject({ status: "paused", next_run_at: null, last_error_code: "gmail_digest_reconfirm_required",
    local_time: "08:00", time_zone: "Europe/London", session_id: session, agent_id: before.agent_id, proposal_id: before.proposal_id });
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digest_deliveries WHERE digest_id=$1`, [before.id])).rows[0].n).toBe(1);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM messages WHERE session_id=$1`, [session])).rows[0].n).toBe(messagesBefore);
  // The schedule runs nothing and cannot be resumed or retimed without the owner's new confirmation; the card says why.
  await db.pool.query(`UPDATE gmail_digests SET next_run_at=now() WHERE id=$1 AND status='paused'`, [before.id]);
  expect(await startDueGmailDigests(db.pool, config, 20)).toBe(0);
  await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL WHERE id=$1`, [before.id]);
  as(owner);
  expect((await digestStatus(before.id, "active")).statusCode).toBe(409);
  expect((await digestTime(before.id, "09:00")).statusCode).toBe(409);
  const listed = (await app.inject({ method: "GET", url: "/api/v1/sources/gmail/digests" })).json().digests
    .find((digest: { id: string }) => digest.id === before.id);
  expect(listed).toMatchObject({ status: "paused", last_error_code: "gmail_digest_reconfirm_required", local_time: "08:00", room_id: null });

  // The owner confirms it again under the new scope, on a new card in its conversation: the same digest resumes with its history.
  const again = await proposeGmailDigest(db.pool, run, space, { kind: "daily", local_time: "08:00", time_zone: "Europe/London" }, randomUUID());
  expect(again.modelResult, JSON.stringify(again.modelResult)).toMatchObject({ ok: true, status: "pending" });
  const againId = String("proposal_id" in again.modelResult ? again.modelResult.proposal_id : "");
  expect((await accept(againId)).statusCode).toBe(200);
  const resumed = (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [before.id])).rows[0];
  expect(resumed).toMatchObject({ status: "active", proposal_id: againId, last_error_code: null, local_time: "08:00", session_id: session });
  expect(resumed.grant_id).not.toBe(before.grant_id);
  expect(new Date(resumed.covered_until).getTime()).toBeGreaterThan(new Date(before.covered_until).getTime());
  expect((await db.pool.query(`SELECT status,purpose,project_id FROM plugin_data_grants WHERE id=$1`, [resumed.grant_id])).rows[0])
    .toEqual({ status: "active", purpose: "daily_digest", project_id: project });
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digests WHERE space_id=$1 AND kind='daily'`, [space])).rows[0].n).toBe(1);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digest_deliveries WHERE digest_id=$1`, [before.id])).rows[0].n).toBe(1);
  // The on-demand consent is not revived: the next read asks again in place.
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE plugin_id='core:gmail' AND status='active'`)).rows[0].n).toBe(0);
});
