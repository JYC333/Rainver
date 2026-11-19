import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunToolGrant } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRun, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { publicAddressGuard } from "./support/outboundGuard.js";
import { sourcesModule } from "../src/modules/sources/index.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { policyModule } from "../src/modules/policy/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { __setGmailOAuthGuardForTests } from "../src/modules/sources/gmail/gmailOAuthTransport.js";
import { __setGmailProfileGuardForTests } from "../src/modules/sources/gmail/gmailOAuthFlow.js";
import { __setGmailReadGuardForTests } from "../src/modules/sources/gmail/gmailMailReads.js";
import { assertGmailAgentReadUrl } from "../src/modules/sources/gmail/gmailAgentReadContract.js";
import { buildRunToolGrants } from "../src/modules/systemActions/runToolGrants.js";
import { pluginToolPins, type RunScenario } from "../src/modules/plugins/dataAccess.js";
import { CliAgentToolTransport } from "../src/modules/runs/cliToolTransport.js";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";
import { AuthorizationRequestService } from "../src/modules/policy/authorizationRequestService.js";
import { disconnectGmailConnectionIn, lockOwnedGmailConnection, setGmailAgentReadIn } from "../src/modules/sources/gmail/gmailConnections.js";
import type { OperationToolResponse } from "../src/modules/systemActions/operations/agentResult.js";
import { contentDecisionFromDb } from "../src/modules/access/contentAccessQuery.js";
import { sensitiveTaintEgressContext } from "../src/modules/plugins/egress.js";
import { runInSensitiveConversation, runPinsSensitivePluginTool } from "../src/modules/runs/modelChannelLaunch.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { createPrivateToolCallFilter } from "../src/modules/runtimeAdapters/privateToolCalls.js";
import { executeRemoteHostCliAdapter, type RemoteBindingPort } from "../src/modules/runs/remoteHostCliAdapter.js";
import { resolveRuntimeProfileScope } from "../src/modules/runs/remoteProviderBinding.js";
import { directChatMayReadSensitive, runRequiresIsolatedLaunch } from "../src/modules/runs/sensitiveRuntimeProfile.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";
import { ProviderProxyLeaseRegistry } from "../src/modules/providers/proxy/lease.js";
import { __setProvidersDbPortForTests } from "../src/modules/providers/dbReader.js";
import { sensitiveConversationReads } from "../src/modules/runs/contextTaint.js";

// ADR 0032 on real PostgreSQL: real routes, operation core, ADR 0030 consent/isolation/release gate,
// Sources broker and outbound guard. Only Google is stubbed (globalThis.fetch) with a small fake
// mailbox; no real mailbox, Google project or deployment is involved. Every Gmail GET is checked
// against the Agent-read allowlist and no POST except the OAuth token endpoint may occur.
const db = useTestDatabase(import.meta.filename);
const CLIENT_ID = "gmail-client.apps.googleusercontent.com";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const BODY = "AGENT-BODY-MARK-3c91";
const ACTION = "source.gmail.mail.read";
let config: ServerConfig, app: ReturnType<typeof buildModuleServer>;
let space: string, spaceOwner: string, member: string, project: string;

type Msg = { id: string; at: number; labels?: string[]; subject?: string; text?: string };
const google = { calls: [] as { url: string; method: string }[], mailbox: [] as Msg[], nextSub: "3003", afterMailGet: null as null | ((count: number) => Promise<void>) };
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const idToken = (sub: string) => `e30.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
function full(m: Msg) {
  return {
    id: m.id, threadId: m.id, internalDate: String(m.at), labelIds: m.labels ?? ["INBOX"],
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "Subject", value: m.subject ?? `Subject ${m.id}` }, { name: "From", value: "Ada <ada@uni.example>" }, { name: "To", value: "member@gmail.example" }, { name: "Date", value: new Date(m.at).toUTCString() }],
      parts: [{ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }], body: { data: b64(m.text ?? `${BODY} ${m.id}`) } }],
    },
  };
}
async function stub(url: string, init?: RequestInit): Promise<Response> {
  const call = { url, method: String(init?.method ?? "GET") };
  google.calls.push(call);
  if (url === "https://oauth2.googleapis.com/token") {
    return json({ access_token: `ya29.${randomUUID()}`, expires_in: 3599, token_type: "Bearer", scope: `openid ${READONLY}`, id_token: idToken(google.nextSub), refresh_token: `1//r-${randomUUID()}` });
  }
  expect(call.method).toBe("GET");
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/profile")) return json({ emailAddress: "member@gmail.example" });
  // Every mail request is on the Agent-read allowlist.
  expect(() => assertGmailAgentReadUrl(url)).not.toThrow();
  const response = await mailResponse(parsed);
  await google.afterMailGet?.(google.calls.filter((c) => c.url.includes("/messages")).length);
  return response;
}
function mailResponse(parsed: URL): Response {
  if (parsed.pathname.endsWith("/messages")) {
    const max = Number(parsed.searchParams.get("maxResults"));
    const q = parsed.searchParams.get("q");
    const word = q?.split(" ")[0]?.toLowerCase();
    const listed = [...google.mailbox].sort((a, b) => b.at - a.at)
      .filter((m) => q ? (m.subject ?? "").toLowerCase().includes(word!) || (m.text ?? "").toLowerCase().includes(word!) : (m.labels ?? ["INBOX"]).includes("INBOX"));
    return json({ messages: listed.slice(0, max).map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: listed.length });
  }
  const id = /\/messages\/([0-9a-f]+)$/.exec(parsed.pathname)?.[1];
  const m = google.mailbox.find((x) => x.id === id);
  return m ? json(full(m)) : json({ error: { code: 404 } }, 404);
}

beforeEach(async () => {
  await resetTables(db.pool, ["spaces", "users", "credentials", "source_request_quota_state"], { cascade: true });
  space = randomUUID(); spaceOwner = randomUUID(); member = randomUUID(); project = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner: spaceOwner, project, spaceType: "team" });
  await seedSpaceMember(db.pool, { space, user: member });
  // The mailbox owner works in the Project (its private conversations need that).
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, member]);
  // Consent receipts live in each person's Personal Space.
  for (const user of [spaceOwner, member]) {
    const personal = randomUUID();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Personal','personal',now(),now())`, [personal]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',now(),now())`, [randomUUID(), personal, user]);
  }
  // The strictest case for oversight: the Space owner may read every member's ordinary private content.
  await db.pool.query(`UPDATE spaces SET oversight_mode='full' WHERE id=$1`, [space]);
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: mkdtempSync(join(tmpdir(), "rainver-gmail-agent-")),
    GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret-fixture",
    GMAIL_OAUTH_REDIRECT_URI: "http://localhost:3000/api/v1/sources/gmail/oauth/callback",
  });
  app = buildModuleServer(config, [sourcesModule, systemActionsModule, policyModule]);
  __setGmailOAuthGuardForTests(publicAddressGuard);
  __setGmailProfileGuardForTests(publicAddressGuard);
  __setGmailReadGuardForTests(publicAddressGuard);
  const base = Date.UTC(2026, 10, 1);
  google.calls = []; google.nextSub = "3003"; google.afterMailGet = null;
  google.mailbox = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: (0x1a00 + i).toString(16), at: base + i * 60_000, subject: `Weekly note ${i}` })),
    { id: "1b01", at: base + 3_600_000, subject: "Superlinear offer", text: `${BODY} superlinear terms` },
    { id: "1b02", at: base + 3_700_000, subject: "Superlinear draft", labels: ["DRAFT"], text: "UNSENT-DRAFT-TEXT superlinear" },
    { id: "1b03", at: base + 3_800_000, subject: "Superlinear spam", labels: ["SPAM"], text: "SPAM-TEXT superlinear" },
  ];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => stub(String(url), init));
});
afterEach(async () => {
  __setAuthIdentityForTests(null); __setGmailOAuthGuardForTests(null); __setGmailProfileGuardForTests(null); __setGmailReadGuardForTests(null);
  vi.restoreAllMocks();
  await app?.close();
});

const as = (userId: string) => __setAuthIdentityForTests({ spaceId: space, userId });
async function connect(userId = member): Promise<string> {
  as(userId);
  const start = await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: {} });
  const state = new URL(start.json().authorize_url).searchParams.get("state")!;
  const res = await app.inject({ method: "GET", url: `/api/v1/sources/gmail/oauth/callback?${new URLSearchParams({ state, code: `4/c-${randomUUID()}` })}` });
  expect(new URL(String(res.headers.location)).searchParams.get("gmail")).toBe("connected");
  google.calls = [];
  return (await db.pool.query(`SELECT id FROM gmail_connections WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0].id;
}
const userCall = (name: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1/actions/${name}`, headers: { "idempotency-key": randomUUID() }, payload });
const setAgentRead = (connectionId: string, enabled: boolean) => userCall("source.gmail.connection.set_agent_read", { connection_id: connectionId, enabled });
/** The owner's own private conversation in a Project (no Room): where Agent mail reads are offered (ADR 0033). */
async function directSession(userId = member, projectId: string | null = project): Promise<string> {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO sessions (id,space_id,user_id,project_id,status,title,created_at,updated_at) VALUES ($1,$2,$3,$4,'active','Mail',now(),now())`, [id, space, userId, projectId]);
  return id;
}
async function otherProject(): Promise<string> {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Other','active',now(),now())`, [id, space, member]);
  return id;
}
async function roomSession(): Promise<string> {
  const room = randomUUID(), id = randomUUID();
  await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,title,status,is_mainline,created_by_user_id,created_at,updated_at) VALUES ($1,$2,$3,'Room','active',false,$4,now(),now())`, [room, space, project, member]);
  await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,title,created_at,updated_at) VALUES ($1,$2,$3,$4,'active','Room',now(),now())`, [id, space, room, project]);
  return id;
}
const scenario = (origin: RunScenario["origin"] = "manual", audience = [member]): RunScenario => ({ origin, instructingUserId: member, audience });
const grants = (sessionId: string | null, s: RunScenario = scenario()) =>
  buildRunToolGrants([ACTION, "memory.remember"], { allowed_tools: [ACTION, "memory.remember"] }, { db: db.pool, spaceId: space, userId: member, config, scenario: s, sessionId });
async function host(): Promise<string> {
  const existing = (await db.pool.query<{ id: string }>(`SELECT id FROM hosts WHERE kind='server'`)).rows[0]?.id;
  if (existing) return existing;
  const id = randomUUID();
  await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,NULL,'Server','server',now(),now())`, [id]);
  await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,environment_kind,name,kind,status,created_at,updated_at) VALUES ($1,NULL,$1,'server','server','server','online',now(),now())`, [id]);
  return id;
}
/** What the dispatching server records for an isolated launch; tests stand in for the launch itself. */
async function launch(runId: string, egress: "none" | "default") {
  const launchId = randomUUID(), hostId = await host();
  await db.pool.query(`UPDATE run_attempts SET status='running', launch_id=$2, launch_isolation_json=$3::jsonb WHERE run_id=$1`, [runId, launchId,
    JSON.stringify({ launch_id: launchId, host_id: hostId, host_kind: "server", egress_profile: egress, sandbox_mode: "read_write" })]);
}
async function agentRun(sessionId: string, snapshot: RunToolGrant[], egress: "none" | "default" = "none", extra: Record<string, unknown> = {}): Promise<AgentRunRecord> {
  const runId = randomUUID();
  await seedRun(db.pool, { id: runId, space, owner: member, agent: randomUUID(), version: randomUUID() });
  await db.pool.query(`UPDATE runs SET status='running',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',session_id=$3,permission_snapshot_json=$4::jsonb WHERE id=$1`,
    [runId, member, sessionId, JSON.stringify({ tool_grants: snapshot, plugin_tool_pins: pluginToolPins(config, snapshot), ...extra })]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, runId]);
  await launch(runId, egress);
  return (await db.pool.query<AgentRunRecord>("SELECT * FROM runs WHERE id=$1", [runId])).rows[0]!;
}
const transport = () => new CliAgentToolTransport(config, { actionEventSink: async () => {} });
const call = async (run: AgentRunRecord, args: Record<string, unknown> = {}) =>
  (await transport().call((await db.pool.query<AgentRunRecord>("SELECT * FROM runs WHERE id=$1", [run.id])).rows[0]!, { id: randomUUID(), name: ACTION, arguments: args })) as OperationToolResponse;
const mailGets = () => google.calls.filter((c) => c.url.includes("/messages"));
/** The one in-conversation consent: approving the request writes the owner's standing consent for this Project and mailbox. */
async function consent(run: AgentRunRecord, connectionId?: string, projectId = project): Promise<string> {
  const denied = await call(run);
  expect(denied.httpStatus).toBe(403);
  expect(denied.body).toMatchObject({ ok: false, error: { code: "operation_consent_required" } });
  const requests = new AuthorizationRequestService(db.pool, config);
  const request = await requests.createFromDeniedDecision({ spaceId: space, runId: run.id, agentId: run.agent_id!, policyDecisionRecordId: denied.body.policy_decision_record_id as string, reason: "Summarize my latest mail" });
  expect(request).toMatchObject({ request_kind: "plugin_data", status: "pending" });
  // The request froze exactly what it asks for (ADR 0033).
  expect((await db.pool.query(`SELECT consent_owner_user_id,consent_project_id,consent_connection_id,consent_purpose,
      consent_connection_generation=(SELECT generation FROM gmail_connections WHERE id=consent_connection_id) AS current_generation FROM authorization_requests WHERE id=$1`, [request.id])).rows[0])
    .toEqual({ consent_owner_user_id: member, consent_project_id: projectId, consent_connection_id: connectionId ?? expect.any(String), consent_purpose: "on_demand_read", current_generation: true });
  expect((await requests.listForRun({ spaceId: space, userId: member }, run.id))[0]).toMatchObject({ approver: "data_owner", consent_state: "approvable" });
  // Neither the Space owner (with full oversight) nor anyone else decides for the mailbox owner: the
  // owner-only Run's request does not exist for them.
  await expect(requests.decide({ spaceId: space, userId: spaceOwner }, request.id, "approved")).rejects.toMatchObject({ statusCode: 404 });
  const approved = await requests.decide({ spaceId: space, userId: member }, request.id, "approved");
  // The waiting turn continues on its own launch (whatever runtime that was).
  await db.pool.query(`UPDATE runs SET status='running' WHERE id=$1`, [run.id]);
  await db.pool.query(`UPDATE run_attempts SET status='running' WHERE run_id=$1`, [run.id]);
  const grant = (await db.pool.query(`SELECT plugin_id,toolset,data_class,scope,target_run_id,data_owner_user_id,granted_by_user_id,expires_at,project_id,purpose,connection_id,
      connection_generation=(SELECT generation FROM gmail_connections WHERE id=connection_id) AS current_generation FROM plugin_data_grants WHERE id=$1`, [approved.resulting_plugin_data_grant_id])).rows[0];
  expect(grant).toEqual({ plugin_id: "core:gmail", toolset: "read", data_class: "sensitive", scope: "project", target_run_id: null, data_owner_user_id: member, granted_by_user_id: member,
    expires_at: null, project_id: projectId, purpose: "on_demand_read", connection_id: connectionId ?? expect.any(String), current_generation: true });
  return approved.resulting_plugin_data_grant_id!;
}

describe("ADR 0032 on-demand Gmail reads for an Agent", () => {
  it("offers the tool in any ordinary conversation of a Project after the owner's opt-in, only in their own manual turn", async () => {
    const connectionId = await connect();
    const direct = await directSession();
    const names = async (sessionId: string | null, s?: RunScenario) => (await grants(sessionId, s)).map((g) => g.action_id);
    // Connected but not opted in: absent.
    expect(await names(direct)).not.toContain(ACTION);
    as(member);
    const enabled = await setAgentRead(connectionId, true);
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().data).toEqual({ connection_id: connectionId, space_id: space, agent_read_enabled: true });
    expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/connections" })).json().connections[0]).toMatchObject({ agent_read_enabled: true });
    expect(await names(direct)).toContain(ACTION);
    // A Room or the Project mainline of that Project offers it too (ADR 0033 §6), whoever else reads it: whether every
    // reader works in the consent's Project is decided with the consent, at call and release time.
    expect(await names(await roomSession())).toContain(ACTION);
    expect(await names(await roomSession(), scenario("manual", [member, spaceOwner].sort()))).toContain(ACTION);
    // A conversation outside every Project, no session, another person's private session, or a non-manual scenario: absent.
    expect(await names(await directSession(member, null))).not.toContain(ACTION);
    expect(await names(null)).not.toContain(ACTION);
    expect(await names(await directSession(spaceOwner))).not.toContain(ACTION);
    for (const origin of ["delegated", "scheduled", "system"] as const) expect(await names(direct, scenario(origin))).not.toContain(ACTION);
    // Nobody else toggles the owner's opt-in.
    as(spaceOwner);
    expect((await setAgentRead(connectionId, false)).statusCode).toBe(404);
    // The pin keeps the conversation's own runtime (no isolated launch or model-only channel), and a private Run
    // that may read mail is owner-only: even full oversight does not read it.
    const run = await agentRun(direct, await grants(direct));
    expect(runPinsSensitivePluginTool(run)).toBe(false);
    expect(runRequiresIsolatedLaunch(run)).toBe(false);
    expect(await contentDecisionFromDb(db.pool, { spaceId: space, userId: spaceOwner }, "run", run.id)).toBe("deny");
    expect(await contentDecisionFromDb(db.pool, { spaceId: space, userId: member }, "run", run.id)).toBe("full");
    // Disconnect ends the opt-in.
    as(member);
    expect((await userCall("source.gmail.connection.disconnect", { connection_id: connectionId })).statusCode).toBe(200);
    expect((await db.pool.query(`SELECT agent_read_enabled FROM gmail_connections WHERE id=$1`, [connectionId])).rows[0]).toEqual({ agent_read_enabled: false });
    expect(await names(direct)).not.toContain(ACTION);
    expect(google.calls).toEqual([]);
  });

  it("posts only the owner's edited excerpt as a Room message without queuing an Agent", async () => {
    as(member);
    const connectionId = await connect();
    expect((await setAgentRead(connectionId, true)).statusCode).toBe(200);
    const sourceSession = await directSession();
    const run = await agentRun(sourceSession, await grants(sourceSession));
    await consent(run, connectionId);
    google.mailbox = [{ id: "aa1", at: Date.now() - 1000 }];
    expect((await call(run)).httpStatus).toBe(200);
    const source = await new PgSessionRepository(db.pool).addAssistantMessageForRun(
      space, member, sourceSession, run.id, { content: "Private original summary." },
    );
    const destination = await roomSession();
    const room = (await db.pool.query(`SELECT room_id FROM sessions WHERE id=$1`, [destination])).rows[0].room_id;
    await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'owner','active',now(),now())`, [randomUUID(), space, room, member]);
    const target = { source_message_id: source!.id, room_id: room, session_id: destination };
    const preview = (destination = target) => app.inject({
      method: "GET", url: `/api/v1/queries/source.gmail.summary.preview?input=${encodeURIComponent(JSON.stringify(destination))}`,
    });
    const key = randomUUID();
    const post = (audienceVersion: string, requestKey = key) => app.inject({
      method: "POST", url: "/api/v1/actions/source.gmail.summary.share", headers: { "idempotency-key": requestKey },
      payload: { ...target, content: "Edited excerpt.", audience_version: audienceVersion },
    });
    const limited = await preview();
    expect(limited.statusCode, limited.body).toBe(200);
    expect(limited.json().data.readers).toHaveLength(1);

    // Mainline readers are the whole Project, including colleagues who have not opened this Room.
    const mainlineRoom = (await db.pool.query<{ id: string }>(
      `SELECT id FROM rooms WHERE project_id=$1 AND is_mainline`, [project],
    )).rows[0]!.id;
    const mainlineSession = randomUUID();
    await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,title,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'active','Project mainline',now(),now())`, [mainlineSession, space, mainlineRoom, project]);
    const joinRoom = (roomId: string, userId: string) => db.pool.query(
      `INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, roomId, userId],
    );
    await joinRoom(mainlineRoom, member);
    const mainline = await preview({ ...target, room_id: mainlineRoom, session_id: mainlineSession });
    expect(mainline.statusCode, mainline.body).toBe(200);
    expect(mainline.json().data.readers).toHaveLength(2);

    await joinRoom(room, spaceOwner);
    expect((await post(limited.json().data.audience_version, randomUUID())).statusCode).toBe(409);
    expect((await db.pool.query(`SELECT 1 FROM messages WHERE session_id=$1`, [destination])).rows).toEqual([]);
    const reviewed = (await preview()).json().data;
    expect(reviewed.readers).toHaveLength(2);
    const published = () => post(reviewed.audience_version);
    const posted = await published();
    expect(posted.statusCode, posted.body).toBe(200);
    expect((await published()).json()).toEqual(posted.json());
    expect((await db.pool.query(`SELECT role,content,user_id,run_id,metadata_json FROM messages WHERE session_id=$1`, [destination])).rows).toEqual([
      { role: "user", content: "Edited excerpt.", user_id: member, run_id: null, metadata_json: {
        shared_from: "private_gmail_summary", source_project_id: project, sensitive_reads: [{ plugin_id: "core:gmail", owner_user_id: member }],
        sensitive_reads_version: 2,
      } },
    ]);
    expect((await db.pool.query(`SELECT 1 FROM runs WHERE session_id=$1`, [destination])).rows).toEqual([]);
    // The Room keeps the read's Project constraint: its later Runs inherit the owner's Gmail read.
    expect(await sensitiveConversationReads(db.pool, space, destination)).toEqual({ reads: [{ pluginId: "core:gmail", ownerUserId: member }], complete: true });
    // The source Run's reads decide by the shared rule: an unknown owner, an old entry whose owner cannot be
    // proven (the conversation held an earlier Run's reads it may have inherited) or malformed metadata is refused.
    const taintOf = (reads: unknown) => JSON.stringify({ schema_version: 1, narrowest_visibility: "private", input_owner_user_ids: [], non_instructing_owner_user_ids: [], personal_memory_grant_ids: [], plugin_reads: reads });
    const earlier = randomUUID();
    await db.pool.query(`INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs, to_jsonb(r) || jsonb_build_object('id',$1::text,
        'created_at',r.created_at - interval '1 minute','has_context_taint',true,'context_taint_json',$3::jsonb))).* FROM runs r WHERE r.id=$2`,
      [earlier, run.id, taintOf([{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: spaceOwner }])]);
    for (const reads of [[{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: null }], [{ plugin_id: "core:gmail", data_class: "sensitive" }], "core:gmail", [7]]) {
      await db.pool.query(`UPDATE runs SET context_taint_json=$2::jsonb WHERE id=$1`, [run.id, taintOf(reads)]);
      const refused = await post(reviewed.audience_version, randomUUID());
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.body).toContain("gmail_summary_share_foreign_data");
    }
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM messages WHERE session_id=$1`, [destination])).rows[0].n).toBe(1);
    as(spaceOwner);
    expect((await preview()).statusCode).toBe(404);
    expect((await published()).statusCode).toBe(404);
  });

  it("treats a private Project chat as one that may read from the opt-in on, before any Run of it exists", async () => {
    const connectionId = await connect();
    const direct = await directSession(), room = await roomSession();
    const may = (sessionId: string) => directChatMayReadSensitive(db.pool, { spaceId: space, userId: member, sessionId });
    expect(await may(direct)).toBe(false);
    as(member); await setAgentRead(connectionId, true);
    expect(await may(direct)).toBe(true);
    // A Room conversation of the Project may read too (its own audience rules apply; this decides only a direct chat's container).
    expect(await may(room)).toBe(true);
    // After the opt-out, a conversation none of whose Runs pinned the tool returns to the shared container.
    await setAgentRead(connectionId, false);
    expect(await may(direct)).toBe(false);
  });

  it("reads the five newest inbox messages only after the owner's Project consent, and audits, taints and attributes the read", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const run = await agentRun(session, await grants(session));
    const grantId = await consent(run, connectionId);
    expect(mailGets()).toEqual([]);
    const read = await call(run);
    expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
    const data = read.body.data as { source: string; mailbox_email: string; items: { id: string; subject: string; text: string }[]; truncated: boolean };
    expect(data.source).toBe("recent_inbox");
    expect(data.mailbox_email).toBe("member@gmail.example");
    // Newest first, inbox only: the draft and spam never appear.
    expect(data.items.map((i) => i.id)).toEqual(["1b01", "1a06", "1a05", "1a04", "1a03"]);
    expect(data.items[0]!.text).toContain(BODY);
    expect(JSON.stringify(data)).not.toMatch(/UNSENT-DRAFT-TEXT|SPAM-TEXT/);
    const list = new URL(mailGets()[0]!.url);
    expect(Object.fromEntries(list.searchParams)).toEqual({ maxResults: "5", labelIds: "INBOX" });
    expect(mailGets()).toHaveLength(6);
    // Taint, Agent-read log and the owner's Gmail audit: ids and counts only, never content.
    const taint = (await db.pool.query(`SELECT context_taint_json FROM runs WHERE id=$1`, [run.id])).rows[0].context_taint_json;
    expect(taint).toMatchObject({ narrowest_visibility: "private", plugin_reads: [{ plugin_id: "core:gmail", data_class: "sensitive" }] });
    const logs = (await db.pool.query(`SELECT owner_user_id,action_id,resource_type,resource_ids_json,data_class,grant_id FROM agent_data_read_logs WHERE run_id=$1`, [run.id])).rows;
    expect(logs).toEqual([{ owner_user_id: member, action_id: ACTION, resource_type: "gmail_message", resource_ids_json: ["1a03", "1a04", "1a05", "1a06", "1b01"], data_class: "sensitive", grant_id: grantId }]);
    const audits = (await db.pool.query(`SELECT operation,owner_user_id,actor_user_id,gmail_connection_id,run_id,agent_id,item_count,project_id FROM gmail_read_audit_events`)).rows;
    expect(audits).toEqual([{ operation: "agent_read", owner_user_id: member, actor_user_id: member, gmail_connection_id: connectionId, run_id: run.id, agent_id: run.agent_id, item_count: 5, project_id: project }]);
    // The Gmail management card shows the consent, its Project and when it was last used.
    const card = (await app.inject({ method: "GET", url: "/api/v1/sources/gmail/connections" })).json().connections[0];
    expect(card.agent_read_grants).toEqual([{ grant_id: grantId, project_id: project, project_name: expect.any(String), purpose: "on_demand_read", created_at: expect.any(String), last_used_at: expect.any(String) }]);
    const stored = JSON.stringify([taint, logs, audits, (await db.pool.query(`SELECT * FROM policy_decision_records`)).rows, (await db.pool.query(`SELECT * FROM authorization_requests`)).rows]);
    expect(stored).not.toContain(BODY);
    expect(stored).not.toContain("Superlinear");
    // After the read every outward write of the Run is refused by the hard invariant.
    expect(await sensitiveTaintEgressContext(db.pool, space, run.id, { id: "task.create", side_effects: "durable" })).toEqual({ sensitive_plugin_read_taint: true, outward_action: true });
    // The owner sees it in their own read audit; the Space owner sees nothing.
    expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/read-audit" })).json().events).toEqual([expect.objectContaining({ operation: "agent_read", item_count: 5 })]);
    as(spaceOwner);
    expect((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/read-audit" })).json().events).toEqual([]);
  });

  it("searches with the owner's words, never returns drafts, spam or trash, and bounds the call", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const run = await agentRun(session, await grants(session));
    await consent(run);
    const read = await call(run, { query: "superlinear", max_messages: 3 });
    expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
    const data = read.body.data as { source: string; items: { id: string; text: string }[] };
    expect(data.source).toBe("search");
    expect(data.items.map((i) => i.id)).toEqual(["1b01"]);
    expect(JSON.stringify(data)).not.toMatch(/UNSENT-DRAFT-TEXT|SPAM-TEXT/);
    const list = new URL(mailGets()[0]!.url);
    expect(Object.fromEntries(list.searchParams)).toEqual({ maxResults: "3", q: "superlinear -in:drafts -in:chats -in:spam -in:trash" });
    // Input bounds: at most five messages, a bounded single-line query.
    expect((await call(run, { max_messages: 6 })).httpStatus).toBe(422);
    expect((await call(run, { query: "a\nb" })).httpStatus).toBe(422);
    // The allowlist refuses any other Gmail request shape.
    for (const url of [
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=6&labelIds=INBOX",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&labelIds=SPAM",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=x",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&labelIds=INBOX&pageToken=abc",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/1a01?format=raw",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/1a01/attachments/x",
      "https://gmail.googleapis.com/gmail/v1/users/me/threads?q=x",
    ]) expect(() => assertGmailAgentReadUrl(url)).toThrow();
  });

  it("reads on the conversation's own runtime, and never past a revoked consent, an opt-out or another conversation", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    // Ordinary egress (the conversation's own runtime): no isolation refusal; the only gate is the owner's consent.
    const open = await agentRun(session, await grants(session), "default");
    const asked = await call(open);
    expect(asked.httpStatus).toBe(403);
    expect(asked.body).toMatchObject({ ok: false, error: { code: "operation_consent_required" } });
    expect(mailGets()).toEqual([]);
    // A Run without the pin (e.g. created before the opt-in) cannot call it at all.
    const unpinned = await agentRun(session, []);
    expect((await call(unpinned)).httpStatus).not.toBe(200);
    // Revoked: the next read is refused and sends nothing.
    const run = await agentRun(session, await grants(session));
    await consent(run);
    expect((await call(run)).httpStatus).toBe(200);
    google.calls = [];
    expect((await userCall("plugin_data_grant.revoke_run", { run_id: run.id })).statusCode).toBe(200);
    const afterRevoke = await call(run);
    expect(afterRevoke.httpStatus).toBe(403);
    expect(afterRevoke.body).toMatchObject({ error: { code: "operation_consent_required" } });
    expect(mailGets()).toEqual([]);
    // Opted out mid-Run, even with a fresh consent: refused, nothing sent.
    const second = await agentRun(session, await grants(session));
    await consent(second);
    expect((await setAgentRead(connectionId, false)).statusCode).toBe(200);
    google.calls = [];
    expect((await call(second)).httpStatus).not.toBe(200);
    expect(mailGets()).toEqual([]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events`)).rows[0].n).toBe(1);
  });

  it("caps the reads one Run makes under the standing consent", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const run = await agentRun(session, await grants(session));
    const grantId = await consent(run);
    for (let i = 0; i < 10; i += 1) await db.pool.query(`INSERT INTO agent_data_read_logs (id,space_id,owner_user_id,run_id,agent_id,action_id,resource_type,resource_ids_json,data_class,grant_id,accessed_at)
      VALUES ($1,$2,$3,$4,$5,$6,'gmail_message','[]'::jsonb,'sensitive',$7,now())`, [randomUUID(), space, member, run.id, run.agent_id, ACTION, grantId]);
    const capped = await call(run);
    expect(capped.httpStatus).toBe(429);
    expect(capped.body).toMatchObject({ error: { metadata: { code: "gmail_agent_read_limit" } } });
    expect(mailGets()).toEqual([]);
  });

  it("keeps a conversation's later Runs on its own runtime after a read, with no reflection memory of it", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const run = await agentRun(session, await grants(session));
    await consent(run);
    expect((await call(run)).httpStatus).toBe(200);
    await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [run.id]);
    // The next Run of the same conversation, created by the real repository, even after the opt-out.
    expect((await setAgentRead(connectionId, false)).statusCode).toBe(200);
    const { PgRunRepository } = await import("../src/modules/runs/repository.js");
    const next = await new PgRunRepository(db.pool, config).createQueuedRun({
      execution_kind: "agent", space_id: space, user_id: member, agent_id: run.agent_id!, session_id: session, mode: "live", run_type: "agent",
      trigger_origin: "manual", visibility: "private", capabilities_json: [ACTION], scenario_tool_allowance: [ACTION], prompt: "and the one before?",
    } as never);
    // A Project-bound read (ADR 0033 §6) does not mark the conversation for isolation: the next turn keeps the
    // conversation's selected runtime. Independently of that, it inherits the read's taint, so the mail in the
    // conversation's history keeps its Project constraint (no outward write, no materialization, no Memory).
    expect(runInSensitiveConversation(next)).toBe(false);
    expect(runRequiresIsolatedLaunch(next)).toBe(false);
    const inherited = (await db.pool.query(`SELECT has_context_taint,context_taint_json FROM runs WHERE id=$1`, [next.id])).rows[0];
    expect(inherited.has_context_taint).toBe(true);
    expect(inherited.context_taint_json.plugin_reads).toEqual([{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: member }]);
    // A user-requested reflection does not turn the conversation into a memory.
    expect(await new PgSessionRepository(db.pool).addMessage(space, member, session, { role: "user", content: "summarize my latest mail" })).toBeTruthy();
    expect(await new PgSessionRepository(db.pool).reflectSession(space, member, session)).toEqual({ session_id: session, proposals_created: 0 });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM proposals WHERE space_id=$1`, [space])).rows[0].n).toBe(0);
    // Another conversation of the same person is unaffected.
    const other = await new PgRunRepository(db.pool, config).createQueuedRun({
      execution_kind: "agent", space_id: space, user_id: member, agent_id: run.agent_id!, session_id: await directSession(), mode: "live", run_type: "agent",
      trigger_origin: "manual", visibility: "private", capabilities_json: [], scenario_tool_allowance: [], prompt: "hello",
    } as never);
    expect(runInSensitiveConversation(other)).toBe(false);
    expect((await db.pool.query(`SELECT has_context_taint FROM runs WHERE id=$1`, [other.id])).rows[0].has_context_taint).toBe(false);
  });

  it("acceptance: a remote Host's codex_cli on its own CLI login reads the newest five bodies and a superlinear search in a Room of the Project, refuses another Project and stops at revocation", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    // The failing configuration: a paired (remote) Host of the owner, codex_cli, runtime_native (no ModelProvider binding).
    const remoteHost = randomUUID();
    await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,$2,'Laptop','workstation',now(),now())`, [remoteHost, member]);
    await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,environment_kind,name,kind,status,created_at,updated_at) VALUES ($1,$2,$1,'linux_native','laptop','remote','online',now(),now())`, [remoteHost, member]);
    // A Room of the Project: the owner and a colleague who also works in the Project read it.
    const roomConversation = await roomSession();
    const roomId = (await db.pool.query(`SELECT room_id FROM sessions WHERE id=$1`, [roomConversation])).rows[0].room_id as string;
    for (const user of [member, spaceOwner]) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, roomId, user]);
    const roomScenario = scenario("manual", [member, spaceOwner].sort());
    const run = await agentRun(roomConversation, await grants(roomConversation, roomScenario));
    await db.pool.query(`UPDATE runs SET visibility='selected_users',project_id=$2 WHERE id=$1`, [run.id, project]);
    await db.pool.query(`INSERT INTO content_access_grants (id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,created_at)
      VALUES ($1,$2,'run',$3,$4,$5,now())`, [randomUUID(), space, run.id, spaceOwner, member]).catch(() => undefined);
    expect(runRequiresIsolatedLaunch(run)).toBe(false);
    class Sink implements HostFrameSink { sent: Record<string, unknown>[] = []; send(frame: Record<string, unknown>) { this.sent.push(frame); } close() {} }
    const thread = await new PgHostThreadRepository(db.pool).getOrCreateForConversationAgent({
      executionHostId: remoteHost, workspaceMode: "managed", workspaceLocationId: null, spaceId: space, sessionId: roomConversation,
      agentId: run.agent_id!, runtimeKey: "codex_cli", runtimeInstallation: "managed:1.0.0", createdByUserId: member });
    await db.pool.query(`UPDATE runs SET runtime_key='codex_cli', host_task_thread_id=$2,
        model_override_json=jsonb_build_object('workspace', jsonb_build_object('kind','managed','agent_id',agent_id,'container',jsonb_build_object('kind','conversation','conversation_id',session_id::text))) WHERE id=$1`,
      [run.id, thread.id]);
    await db.pool.query(`UPDATE run_attempts SET launch_id=NULL, launch_isolation_json=NULL WHERE run_id=$1`, [run.id]);
    const registry = new HostConnectionRegistry(), sink = new Sink();
    registry.registerConnection(remoteHost, sink);
    const bindings: RemoteBindingPort = { async resolve() { return null; }, async record() {}, profileScope: (r, location) => resolveRuntimeProfileScope(db.pool, r, location) };
    const fresh = (await db.pool.query<AgentRunRecord>("SELECT * FROM runs WHERE id=$1", [run.id])).rows[0]!;
    const execution = executeRemoteHostCliAdapter({ run: fresh, prompt: "Read my latest five mails, then find superlinear", model: null, resume_session_id: null,
      workspace: { kind: "managed", agent_id: run.agent_id!, container: { kind: "conversation", conversation_id: roomConversation } } }, remoteHost, null,
      { connectionRegistry: registry, bindings, config, db: db.pool, leaseRegistry: new ProviderProxyLeaseRegistry(), policyEnforcer: async () => ({ status: "allow" as const, policy_decision_record_id: null }) });
    const ended = await Promise.race([execution.then(() => true), vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"), { timeout: 30000 }).then(() => false)]);
    expect(ended, JSON.stringify(ended ? await execution : null)).toBe(false);
    // Launched on the conversation's own runtime: the remote Host, codex_cli, its own login — no strict Host, no
    // egress `none`, no model-only channel and no ModelProvider lease; the Gmail credential is not in the frame.
    const frame = sink.sent.find((f) => f.type === "launch")! as Record<string, any>;
    expect(frame.runtime_key ?? frame.runtime?.key ?? "codex_cli").toBe("codex_cli");
    expect(frame.isolation?.egress_profile).not.toBe("none");
    expect(frame.model_channel).toBeUndefined();
    expect(frame.provider_binding).toMatchObject({ credential_source: "host_login" });
    expect(JSON.stringify(frame)).not.toMatch(/ya29\.|refresh_token|1\/\/r-/);
    try {
      // First read in this Project: the owner's one confirmation in place (the waiting turn continues on approval).
      await consent(run, connectionId);
      // The newest five inbox messages, each with its body.
      const recent = await call(run);
      expect(recent.httpStatus, JSON.stringify(recent.body)).toBe(200);
      const recentData = recent.body.data as { source: string; items: { id: string; text: string }[] };
      expect(recentData.source).toBe("recent_inbox");
      expect(recentData.items.map((i) => i.id)).toEqual(["1b01", "1a06", "1a05", "1a04", "1a03"]);
      for (const item of recentData.items) expect(item.text).toContain(BODY);
      // A search for superlinear, and the body of the hit (never the draft or the spam).
      const search = await call(run, { query: "superlinear" });
      expect(search.httpStatus, JSON.stringify(search.body)).toBe(200);
      const hits = (search.body.data as { items: { id: string; subject: string; text: string }[] }).items;
      expect(hits.map((i) => i.id)).toEqual(["1b01"]);
      expect(hits[0]!.text).toContain("superlinear terms");
      expect(JSON.stringify(hits)).not.toMatch(/UNSENT-DRAFT-TEXT|SPAM-TEXT/);
      // Reads are audited to this Room's Project; the Room Run keeps its audience (the colleague reads the Run).
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events WHERE run_id=$1 AND project_id=$2`, [run.id, project])).rows[0].n).toBe(2);
      expect(await contentDecisionFromDb(db.pool, { spaceId: space, userId: spaceOwner }, "run", run.id)).not.toBe("deny");

      // Another Project never inherits the consent or the mail context: its conversation asks again and reads nothing.
      const elsewhere = await otherProject();
      await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())
        ON CONFLICT DO NOTHING`, [randomUUID(), space, elsewhere, member]);
      const otherSession = await directSession(member, elsewhere);
      const otherRun = await agentRun(otherSession, await grants(otherSession));
      await db.pool.query(`UPDATE runs SET project_id=$2 WHERE id=$1`, [otherRun.id, elsewhere]);
      google.calls = [];
      const crossed = await call(otherRun);
      expect(crossed.httpStatus).toBe(403);
      expect(crossed.body).toMatchObject({ error: { code: "operation_consent_required" } });
      expect(mailGets()).toEqual([]);

      // An audience reaching beyond the Project (a Space-shared Run of the Room) is refused with a fixed code, sending nothing.
      const outsider = randomUUID();
      await seedSpaceMember(db.pool, { space, user: outsider });
      await db.pool.query(`UPDATE runs SET visibility='space_shared' WHERE id=$1`, [run.id]);
      const widened = await call(run);
      expect(widened.httpStatus).toBe(409);
      expect(widened.body).toMatchObject({ error: { metadata: { code: "gmail_agent_read_audience_outside_project" } } });
      expect(mailGets()).toEqual([]);
      await db.pool.query(`UPDATE runs SET visibility='selected_users' WHERE id=$1`, [run.id]);

      // Revocation stops the next read before any Gmail request.
      expect((await userCall("plugin_data_grant.revoke_run", { run_id: run.id })).statusCode).toBe(200);
      const revoked = await call(run);
      expect(revoked.httpStatus).toBe(403);
      expect(mailGets()).toEqual([]);
    } finally {
      registry.receiveComplete(remoteHost, run.id, { exit_code: 0, timed_out: false, error: null }, String(frame.launch_id));
      await execution;
    }
  });

  it("reuses one Project consent across the owner's private conversations of that Project, and only there", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const first = await directSession();
    const firstRun = await agentRun(first, await grants(first));
    const grantId = await consent(firstRun, connectionId);
    expect((await call(firstRun)).httpStatus).toBe(200);
    // Another private conversation of the same Project reads with no further request.
    const second = await directSession();
    const secondRun = await agentRun(second, await grants(second));
    const reused = await call(secondRun, { query: "superlinear" });
    expect(reused.httpStatus, JSON.stringify(reused.body)).toBe(200);
    expect((await db.pool.query(`SELECT grant_id FROM agent_data_read_logs WHERE run_id=$1`, [secondRun.id])).rows).toEqual([{ grant_id: grantId }]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM authorization_requests`)).rows[0].n).toBe(1);
    // Another Project of the same owner needs its own consent.
    const elsewhere = await directSession(member, await otherProject());
    const elsewhereRun = await agentRun(elsewhere, await grants(elsewhere));
    google.calls = [];
    expect((await call(elsewhereRun)).body).toMatchObject({ ok: false, error: { code: "operation_consent_required" } });
    expect(mailGets()).toEqual([]);
    // Nobody else's Run uses it: another member's private conversation of the same Project, or a Run
    // in a conversation that belongs to someone else, even when it names the owner.
    const foreign = await directSession(spaceOwner);
    const foreignRun = await agentRun(foreign, await grants(first));
    expect((await call(foreignRun)).httpStatus).not.toBe(200);
    expect(mailGets()).toEqual([]);
    // No per-Run consent can be written for Gmail any more, by the request flow or directly.
    await expect(db.pool.query(`INSERT INTO plugin_data_grants (id,space_id,plugin_id,toolset,data_class,scope,data_owner_user_id,granted_by_user_id,target_run_id,plugin_version,authority_hash,expanded_json,status,expires_at,created_at,updated_at)
      VALUES ($1,$2,'core:gmail','read','sensitive','run',$3,$3,$4,'1','x','[]'::jsonb,'active',now()+interval '1 hour',now(),now())`, [randomUUID(), space, member, secondRun.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a Run a withdrawn private Gmail check card started, without a Gmail request; the conversation's ordinary turns still read", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const chat = await directSession();
    const ordinary = await agentRun(chat, await grants(chat));
    await consent(ordinary, connectionId);
    // A turn still queued at the upgrade carries the card's binding; there is no compatible execution for it.
    const legacy = await agentRun(chat, await grants(chat));
    const generation = (await db.pool.query(`SELECT generation FROM gmail_connections WHERE id=$1`, [connectionId])).rows[0].generation;
    await db.pool.query(`UPDATE runs SET model_override_json=$2::jsonb WHERE id=$1`, [legacy.id, JSON.stringify({ gmail_private_read: {
      schema_version: "gmail_private_read_turn.v1", proposal_id: randomUUID(), connection_id: connectionId, connection_generation: generation } })]);
    google.calls = [];
    for (const args of [{}, { mailbox_email: "member@gmail.example" }])
      expect((await call(legacy, args)).body).toMatchObject({ ok: false, error: { metadata: { code: "gmail_agent_read_unavailable" } } });
    expect(mailGets()).toEqual([]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1`, [legacy.id])).rows[0].n).toBe(0);
    expect((await call(ordinary)).httpStatus).toBe(200);
  });

  it("ends the Project consent on revocation, opt-out, disconnect and reconnect, and never restores it", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const status = async (id: string) => (await db.pool.query(`SELECT status FROM plugin_data_grants WHERE id=$1`, [id])).rows[0].status;
    const fresh = async () => agentRun(session, await grants(session));
    // Revoked from the Gmail card: the next conversation must ask again.
    const revokedId = await consent(await fresh(), connectionId);
    expect((await userCall("plugin_data_grant.revoke", { grant_id: revokedId })).statusCode).toBe(200);
    expect((await call(await fresh())).body).toMatchObject({ error: { code: "operation_consent_required" } });
    // Opt-out ends it; turning reads on again does not bring it back.
    const optedOutId = await consent(await fresh(), connectionId);
    expect((await setAgentRead(connectionId, false)).statusCode).toBe(200);
    expect(await status(optedOutId)).toBe("revoked");
    await setAgentRead(connectionId, true);
    expect((await call(await fresh())).body).toMatchObject({ error: { code: "operation_consent_required" } });
    expect(((await app.inject({ method: "GET", url: "/api/v1/sources/gmail/connections" })).json().connections[0]).agent_read_grants).toEqual([]);
    // A consent whose connection generation changed (reconnect, re-authorization) stops admitting at once.
    const staleId = await consent(await fresh(), connectionId);
    await db.pool.query(`UPDATE gmail_connections SET generation=generation+1 WHERE id=$1`, [connectionId]);
    google.calls = [];
    expect((await call(await fresh())).body).toMatchObject({ error: { code: "operation_consent_required" } });
    expect(mailGets()).toEqual([]);
    await db.pool.query(`UPDATE gmail_connections SET generation=generation-1 WHERE id=$1`, [connectionId]);
    // Disconnect ends it, and reconnecting the same account needs the opt-in and a new consent.
    expect((await userCall("source.gmail.connection.disconnect", { connection_id: connectionId })).statusCode).toBe(200);
    expect(await status(staleId)).toBe("revoked");
    expect(await connect()).toBe(connectionId);
    as(member); await setAgentRead(connectionId, true);
    expect((await call(await fresh())).body).toMatchObject({ error: { code: "operation_consent_required" } });
    // The ended consents stay as history; only a new one is active.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE plugin_id='core:gmail' AND status='active'`)).rows[0].n).toBe(0);
  });

  it("freezes what a consent request asks for, shows the mailbox and Project to the owner alone, and approves only exactly that", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const run = await agentRun(session, await grants(session));
    const denied = await call(run);
    const requests = new AuthorizationRequestService(db.pool, config);
    const request = await requests.createFromDeniedDecision({ spaceId: space, runId: run.id, agentId: run.agent_id!, policyDecisionRecordId: denied.body.policy_decision_record_id as string, reason: "Read my mail" });
    const generation = (await db.pool.query(`SELECT generation FROM gmail_connections WHERE id=$1`, [connectionId])).rows[0].generation;
    expect((await db.pool.query(`SELECT consent_owner_user_id,consent_project_id,consent_connection_id,consent_connection_generation,consent_purpose FROM authorization_requests WHERE id=$1`, [request.id])).rows[0])
      .toEqual({ consent_owner_user_id: member, consent_project_id: project, consent_connection_id: connectionId, consent_connection_generation: generation, consent_purpose: "on_demand_read" });
    const projectName = (await db.pool.query(`SELECT name FROM projects WHERE id=$1`, [project])).rows[0].name;
    const card = async () => (await requests.listForRun({ spaceId: space, userId: member }, run.id))[0]!;
    expect(await card()).toMatchObject({
      consent_state: "approvable", consent_target: { project_id: project, project_name: projectName, mailbox_email: "member@gmail.example", purpose: "on_demand_read" } });
    // The Run may read the owner's mail, so it is owner-only: the Space owner (full oversight) gets no row at
    // all — not its reason, resource or Project — from the service or its route, and cannot decide it.
    expect(await requests.listForRun({ spaceId: space, userId: spaceOwner }, run.id)).toEqual([]);
    as(spaceOwner);
    const route = await app.inject({ method: "GET", url: `/api/v1/runs/${run.id}/authorization-requests` });
    expect(route.statusCode).toBe(200);
    expect(route.json()).toEqual([]);
    expect(route.body).not.toContain("Read my mail");
    expect((await app.inject({ method: "POST", url: `/api/v1/authorization-requests/${request.id}/reject`, headers: { "idempotency-key": randomUUID() }, payload: {} })).statusCode).not.toBe(200);
    as(member);
    const owned = await app.inject({ method: "GET", url: `/api/v1/runs/${run.id}/authorization-requests` });
    expect(owned.json()).toMatchObject([{ id: request.id, consent_state: "approvable" }]);
    const active = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE plugin_id='core:gmail' AND status='active'`)).rows[0].n;
    // The connection changed after the request (reconnect, re-authorization): the server projects the card
    // as ended (no mailbox shown) and refuses its approval.
    await db.pool.query(`UPDATE gmail_connections SET generation=generation+1 WHERE id=$1`, [connectionId]);
    expect(await card()).toMatchObject({ consent_state: "ended", consent_target: null });
    await expect(requests.decide({ spaceId: space, userId: member }, request.id, "approved")).rejects.toMatchObject({ statusCode: 409 });
    await db.pool.query(`UPDATE gmail_connections SET generation=generation-1 WHERE id=$1`, [connectionId]);
    // So do reads turned off and the Run no longer waiting for this review.
    await db.pool.query(`UPDATE gmail_connections SET agent_read_enabled=false WHERE id=$1`, [connectionId]);
    expect(await card()).toMatchObject({ consent_state: "ended", consent_target: null });
    await db.pool.query(`UPDATE gmail_connections SET agent_read_enabled=true WHERE id=$1`, [connectionId]);
    await db.pool.query(`UPDATE runs SET status='running' WHERE id=$1`, [run.id]);
    expect(await card()).toMatchObject({ consent_state: "ended", consent_target: null });
    await db.pool.query(`UPDATE runs SET status='waiting_for_review' WHERE id=$1`, [run.id]);
    expect(await card()).toMatchObject({ consent_state: "approvable" });
    // A card naming another Project than the Run's conversation never widens to it.
    const other = await otherProject();
    await db.pool.query(`UPDATE authorization_requests SET consent_project_id=$2 WHERE id=$1`, [request.id, other]);
    await expect(requests.decide({ spaceId: space, userId: member }, request.id, "approved")).rejects.toMatchObject({ statusCode: 409 });
    await db.pool.query(`UPDATE authorization_requests SET consent_project_id=$2 WHERE id=$1`, [request.id, project]);
    // (Losing the Project through its membership writer ends the card for good: see the lifecycle test below.)
    expect(await active()).toBe(0);
    // Every part holds again: the consent written is exactly the frozen one.
    const approved = await requests.decide({ spaceId: space, userId: member }, request.id, "approved");
    expect((await db.pool.query(`SELECT data_owner_user_id,project_id,connection_id,connection_generation,purpose FROM plugin_data_grants WHERE id=$1`, [approved.resulting_plugin_data_grant_id])).rows[0])
      .toEqual({ data_owner_user_id: member, project_id: project, connection_id: connectionId, connection_generation: generation, purpose: "on_demand_read" });
  });

  it("never approves a card made under the earlier per-turn consent into a standing one", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const run = await agentRun(session, await grants(session));
    const denied = await call(run);
    const requests = new AuthorizationRequestService(db.pool, config);
    const request = await requests.createFromDeniedDecision({ spaceId: space, runId: run.id, agentId: run.agent_id!, policyDecisionRecordId: denied.body.policy_decision_record_id as string, reason: "Read my mail" });
    // A pending card from before ADR 0033 carries no frozen consent.
    await db.pool.query(`UPDATE authorization_requests SET consent_owner_user_id=NULL,consent_project_id=NULL,consent_connection_id=NULL,consent_connection_generation=NULL,consent_purpose=NULL WHERE id=$1`, [request.id]);
    expect((await requests.listForRun({ spaceId: space, userId: member }, run.id))[0]).toMatchObject({ consent_target: null, consent_state: "superseded" });
    await expect(requests.decide({ spaceId: space, userId: member }, request.id, "approved")).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants`)).rows[0].n).toBe(0);
    // The owner can still close it.
    expect(await requests.decide({ spaceId: space, userId: member }, request.id, "rejected")).toMatchObject({ status: "rejected", resulting_plugin_data_grant_id: null });
    // A partly frozen request cannot be stored at all.
    await expect(db.pool.query(`UPDATE authorization_requests SET consent_owner_user_id=$2,consent_project_id=$3,consent_connection_id=$4,consent_purpose='on_demand_read' WHERE id=$1`,
      [request.id, member, project, connectionId])).rejects.toMatchObject({ code: "23514" });
  });

  it("ends a pending consent card for good when its mailbox or Project goes away, and cancels its Run", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const requests = new AuthorizationRequestService(db.pool, config);
    const pending = async () => {
      const run = await agentRun(session, await grants(session));
      const denied = await call(run);
      const request = await requests.createFromDeniedDecision({ spaceId: space, runId: run.id, agentId: run.agent_id!, policyDecisionRecordId: denied.body.policy_decision_record_id as string, reason: "Read my mail" });
      expect((await requests.listForRun({ spaceId: space, userId: member }, run.id))[0]).toMatchObject({ status: "pending", consent_state: "approvable" });
      return { runId: run.id, requestId: request.id };
    };
    const expectEnded = async (card: { runId: string; requestId: string }) => {
      // Decided by nobody, no consent written, and the waiting Run is cancelled through the reconcile job.
      expect((await db.pool.query(`SELECT status,decided_by_user_id,resulting_plugin_data_grant_id,decided_at IS NOT NULL AS ended FROM authorization_requests WHERE id=$1`, [card.requestId])).rows[0])
        .toEqual({ status: "expired", decided_by_user_id: null, resulting_plugin_data_grant_id: null, ended: true });
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type='authorization_request_reconcile' AND payload_json->>'authorization_request_id'=$1`, [card.requestId])).rows[0].n).toBe(1);
      const listed = (await requests.listForRun({ spaceId: space, userId: member }, card.runId))[0]!;
      expect(listed.status).toBe("expired");
      expect(listed.consent_target).toBeUndefined();
    };
    const neverApproves = (card: { requestId: string }) => expect(requests.decide({ spaceId: space, userId: member }, card.requestId, "approved")).rejects.toMatchObject({ statusCode: 409 });
    // Agent reads turned off; turning them on again revives nothing.
    const optOut = await pending();
    as(member); expect((await setAgentRead(connectionId, false)).statusCode).toBe(200);
    await expectEnded(optOut);
    await setAgentRead(connectionId, true);
    await neverApproves(optOut);
    // Leaving the Project through its membership writer; being added back revives nothing.
    const left = await pending();
    as(spaceOwner);
    expect((await userCall("project.member.remove", { project_id: project, user_id: member })).statusCode).toBe(200);
    await expectEnded(left);
    expect((await userCall("project.member.add", { project_id: project, user_id: member, role: "member" })).statusCode).toBe(201);
    await neverApproves(left);
    // Disconnect; reconnecting the same account and opting in again revives nothing.
    as(member);
    const disconnected = await pending();
    expect((await userCall("source.gmail.connection.disconnect", { connection_id: connectionId })).statusCode).toBe(200);
    await expectEnded(disconnected);
    expect(await connect()).toBe(connectionId);
    as(member); await setAgentRead(connectionId, true);
    await neverApproves(disconnected);
    // None of the ended cards ever wrote a consent.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE plugin_id='core:gmail'`)).rows[0].n).toBe(0);
  });

  it("approves only while the Run still waits for exactly this request; otherwise the card can only be rejected", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const requests = new AuthorizationRequestService(db.pool, config);
    const pending = async () => {
      const run = await agentRun(session, await grants(session));
      const denied = await call(run);
      return { run, request: await requests.createFromDeniedDecision({ spaceId: space, runId: run.id, agentId: run.agent_id!, policyDecisionRecordId: denied.body.policy_decision_record_id as string, reason: "Read my mail" }) };
    };
    const notWaiting = (requestId: string) => expect(requests.decide({ spaceId: space, userId: member }, requestId, "approved"))
      .rejects.toMatchObject({ statusCode: 409, responseBody: { code: "authorization_request_run_not_waiting" } });
    // The person stopped the Run while its card was pending: the request is still pending, but approving it
    // would write a standing consent nobody is waiting for.
    const stopped = await pending();
    await db.pool.query(`UPDATE runs SET status='cancelled' WHERE id=$1`, [stopped.run.id]);
    expect((await requests.listForRun({ spaceId: space, userId: member }, stopped.run.id))[0]).toMatchObject({ status: "pending", consent_state: "ended", consent_target: null });
    await notWaiting(stopped.request.id);
    // Paused again, but for another request: still not this one's to approve.
    await db.pool.query(`UPDATE runs SET status='waiting_for_review',error_json=jsonb_build_object('error_code','authorization_request_pending','authorization_request_id',$2::text) WHERE id=$1`, [stopped.run.id, randomUUID()]);
    await notWaiting(stopped.request.id);
    expect((await db.pool.query(`SELECT status FROM authorization_requests WHERE id=$1`, [stopped.request.id])).rows[0].status).toBe("pending");
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE plugin_id='core:gmail'`)).rows[0].n).toBe(0);
    // Rejecting it needs no waiting Run, so an ended card is always closable; a second decision is refused.
    expect(await requests.decide({ spaceId: space, userId: member }, stopped.request.id, "rejected")).toMatchObject({ status: "rejected", resulting_plugin_data_grant_id: null });
    await expect(requests.decide({ spaceId: space, userId: member }, stopped.request.id, "approved")).rejects.toMatchObject({ statusCode: 409 });
    // The ordinary pending flow is unchanged: the waiting Run's card approves once, and a repeat is refused.
    const waiting = await pending();
    const approved = await requests.decide({ spaceId: space, userId: member }, waiting.request.id, "approved");
    expect(approved).toMatchObject({ status: "approved", resulting_plugin_data_grant_id: expect.any(String) });
    await expect(requests.decide({ spaceId: space, userId: member }, waiting.request.id, "approved")).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE plugin_id='core:gmail' AND status='active'`)).rows[0].n).toBe(1);
  });

  it("keeps one lock order with the mailbox writers and the Run (Project → Run → connection → request), so either side wins cleanly", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const identity = { spaceId: space, userId: member };
    const requests = new AuthorizationRequestService(db.pool, config);
    const pending = async () => {
      const run = await agentRun(session, await grants(session));
      const denied = await call(run);
      return { run, request: await requests.createFromDeniedDecision({ spaceId: space, runId: run.id, agentId: run.agent_id!, policyDecisionRecordId: denied.body.policy_decision_record_id as string, reason: "Read my mail" }) };
    };
    // A regressed order fails fast instead of hanging: bounded lock waits, abandoned transactions ended by the
    // server, and each session discarded after use.
    const open = new Set<{ release: (destroy?: boolean) => void }>();
    const begin = async () => {
      const client = await db.pool.connect();
      open.add(client);
      await client.query("SET idle_in_transaction_session_timeout = '20s'");
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      return { client, pid: (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid };
    };
    const end = async (tx: Awaited<ReturnType<typeof begin>>, commit: boolean) => { try { await tx.client.query(commit ? "COMMIT" : "ROLLBACK"); } finally { open.delete(tx.client); tx.client.release(true); } };
    const blocked = async (pid: number) => {
      for (let i = 0; i < 400; i++) {
        if ((await db.pool.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1`, [pid])).rows[0]?.wait_event_type === "Lock") return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("expected the transaction to wait on a lock");
    };
    /** Whether another transaction could take this row exclusively right now. */
    const free = async (table: "runs" | "authorization_requests", id: string) => {
      const probe = await begin();
      try { await probe.client.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE NOWAIT`, [id]); return true; }
      catch (error) { if ((error as { code?: string }).code === "55P03") return false; throw error; }
      finally { await end(probe, false); }
    };
    const status = async (id: string) => (await db.pool.query(`SELECT status FROM authorization_requests WHERE id=$1`, [id])).rows[0].status;
    const consents = async () => (await db.pool.query<{ status: string }>(`SELECT status FROM plugin_data_grants WHERE plugin_id='core:gmail' ORDER BY created_at`)).rows.map((r) => r.status);

    try {
    // 1. The opt-out holds the connection first. The approval waits there holding the Run but not yet the
    //    request, so the writer ends the request and commits; the approval then finds it ended.
    const first = await pending();
    const writer = await begin();
    await lockOwnedGmailConnection(writer.client, identity, connectionId);
    const approver = await begin();
    const approving = requests.decideInTransaction(approver.client, identity, first.request.id, "approved").then(() => null, (error: unknown) => error);
    await blocked(approver.pid);
    expect(await free("runs", first.run.id)).toBe(false);
    expect(await free("authorization_requests", first.request.id)).toBe(true);
    await setGmailAgentReadIn(writer.client, identity, connectionId, false);
    await end(writer, true);
    expect(await approving).toMatchObject({ statusCode: 409 });
    await end(approver, false);
    expect(await status(first.request.id)).toBe("expired");
    expect(await consents()).toEqual([]);

    // 2. The Run is stopped first. The approval waits on the Run and then refuses: it no longer waits.
    as(member); await setAgentRead(connectionId, true);
    const second = await pending();
    const canceller = await begin();
    await canceller.client.query(`UPDATE runs SET status='cancelled' WHERE id=$1`, [second.run.id]);
    const approver2 = await begin();
    const approving2 = requests.decideInTransaction(approver2.client, identity, second.request.id, "approved").then(() => null, (error: unknown) => error);
    await blocked(approver2.pid);
    await end(canceller, true);
    expect(await approving2).toMatchObject({ statusCode: 409, responseBody: { code: "authorization_request_run_not_waiting" } });
    await end(approver2, false);
    expect(await status(second.request.id)).toBe("pending");
    expect(await consents()).toEqual([]);

    // 3. The approval holds first. Disconnect waits on the connection until the approval commits, then ends
    //    the consent it wrote; no deadlock, no request left pending, the approval's resume job stays the only one.
    const third = await pending();
    const approver3 = await begin();
    const decided = await requests.decideInTransaction(approver3.client, identity, third.request.id, "approved");
    const writer3 = await begin();
    const closing = disconnectGmailConnectionIn(writer3.client, identity, connectionId);
    await blocked(writer3.pid);
    await end(approver3, true);
    await closing;
    await end(writer3, true);
    expect(await status(third.request.id)).toBe("approved");
    expect((await db.pool.query(`SELECT status FROM plugin_data_grants WHERE id=$1`, [decided.resulting_plugin_data_grant_id])).rows[0].status).toBe("revoked");
    expect((await db.pool.query(`SELECT status FROM gmail_connections WHERE id=$1`, [connectionId])).rows[0].status).toBe("disconnected");
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type='authorization_request_reconcile' AND payload_json->>'authorization_request_id'=$1`, [third.request.id])).rows[0].n).toBe(1);
    } finally {
      // A failed step must not leave a session holding locks or the pool waiting at teardown.
      for (const client of open) client.release(true);
    }
  });

  it("forgets a connection whose consent was approved: the evidence stays, monitor data goes, and the old consent never admits", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const grantId = await consent(await agentRun(session, await grants(session)), connectionId);
    const approvedRequest = (await db.pool.query(`SELECT id FROM authorization_requests WHERE resulting_plugin_data_grant_id=$1 AND status='approved'`, [grantId])).rows[0].id;
    // A pending card on the same mailbox (asked while the consent was briefly revoked), and the connection's
    // private monitor data.
    await db.pool.query(`UPDATE plugin_data_grants SET status='revoked',revoked_at=now(),revoked_by_user_id=$2 WHERE id=$1`, [grantId, member]);
    const refusedRun = await agentRun(session, await grants(session));
    const refused = await call(refusedRun);
    const requests = new AuthorizationRequestService(db.pool, config);
    const pendingRequest = await requests.createFromDeniedDecision({ spaceId: space, runId: refusedRun.id, agentId: refusedRun.agent_id!, policyDecisionRecordId: refused.body.policy_decision_record_id as string, reason: "Read my mail" });
    await db.pool.query(`UPDATE plugin_data_grants SET status='active',revoked_at=NULL,revoked_by_user_id=NULL WHERE id=$1`, [grantId]);
    const rule = randomUUID();
    await db.pool.query(`INSERT INTO gmail_monitor_rules (id,space_id,owner_user_id,gmail_connection_id,project_id,purpose,criteria,status,active_since,match_count,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'Offers','{"from":"ada@uni.example"}'::jsonb,'active',now(),0,now(),now())`, [rule, space, member, connectionId, project]);
    await db.pool.query(`INSERT INTO gmail_monitor_matches (rule_id,google_message_id,space_id,owner_user_id,matched_at) VALUES ($1,'1b01',$2,$3,now())`, [rule, space, member]);
    await db.pool.query(`INSERT INTO gmail_mailbox_sync_states (gmail_connection_id,space_id,owner_user_id,state,recovery_partial,next_poll_at,failure_count,created_at,updated_at)
      VALUES ($1,$2,$3,'baseline',false,now(),0,now(),now())`, [connectionId, space, member]);
    // Normal disconnect, then Forget: allowed although an approved request points at the consent.
    as(member);
    expect((await userCall("source.gmail.connection.disconnect", { connection_id: connectionId })).statusCode).toBe(200);
    const forgot = await userCall("source.gmail.connection.forget", { connection_id: connectionId });
    expect(forgot.statusCode, forgot.body).toBe(200);
    const count = async (sql: string, params: unknown[]) => (await db.pool.query(sql, params)).rows[0].n;
    expect(await count(`SELECT count(*)::int AS n FROM gmail_connections WHERE id=$1`, [connectionId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM gmail_monitor_rules WHERE gmail_connection_id=$1`, [connectionId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM gmail_monitor_matches WHERE rule_id=$1`, [rule])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM gmail_mailbox_sync_states WHERE gmail_connection_id=$1`, [connectionId])).toBe(0);
    // The approval evidence stays: the approved request and the ended consent it wrote.
    expect((await db.pool.query(`SELECT status,resulting_plugin_data_grant_id FROM authorization_requests WHERE id=$1`, [approvedRequest])).rows[0]).toEqual({ status: "approved", resulting_plugin_data_grant_id: grantId });
    expect((await db.pool.query(`SELECT status,connection_id FROM plugin_data_grants WHERE id=$1`, [grantId])).rows[0]).toEqual({ status: "revoked", connection_id: connectionId });
    // The pending card ended with the mailbox.
    expect((await db.pool.query(`SELECT status FROM authorization_requests WHERE id=$1`, [pendingRequest.id])).rows[0].status).toBe("expired");
    // Even an old consent row put back to active by hand names a connection that no longer exists: it admits nothing.
    await db.pool.query(`UPDATE plugin_data_grants SET status='active',revoked_at=NULL,revoked_by_user_id=NULL WHERE id=$1`, [grantId]);
    // Connecting the same account again is a new connection; neither it nor the old consent admits without a new one.
    const again = await connect();
    expect(again).not.toBe(connectionId);
    as(member); await setAgentRead(again, true);
    google.calls = [];
    expect((await call(await agentRun(session, await grants(session)))).body).toMatchObject({ error: { code: "operation_consent_required" } });
    expect(mailGets()).toEqual([]);
  });

  it("rechecks the owner's current Project access at admission, before every Gmail send and at release; losing it ends the consent for good", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const grantId = await consent(await agentRun(session, await grants(session)), connectionId);
    const leave = () => db.pool.query(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [project, member]);
    const rejoin = () => db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, member]);
    const released = async (runId: string) => (await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1`, [runId])).rows[0].n
      + (await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events WHERE run_id=$1`, [runId])).rows[0].n;
    // Access lost after the list request: the next send is refused, nothing more leaves for Google.
    google.calls = [];
    google.afterMailGet = async (count) => { if (count === 1) await leave(); };
    const midRead = await agentRun(session, await grants(session));
    expect((await call(midRead)).httpStatus).not.toBe(200);
    expect(mailGets()).toHaveLength(1);
    expect(await released(midRead.id)).toBe(0);
    google.afterMailGet = null; await rejoin();
    // Access lost after the last send: the release withholds the result and records nothing.
    google.calls = [];
    google.afterMailGet = async (count) => { if (count === 6) await leave(); };
    const atRelease = await agentRun(session, await grants(session));
    const withheld = await call(atRelease);
    expect(withheld.httpStatus).not.toBe(200);
    expect(JSON.stringify(withheld.body)).not.toContain(BODY);
    expect(mailGets()).toHaveLength(6);
    expect(await released(atRelease.id)).toBe(0);
    google.afterMailGet = null;
    // Not a member at admission: no consent is found, no card is offered (the owner is outside the Project) and nothing is sent.
    google.calls = [];
    expect((await call(await agentRun(session, await grants(session)))).body).toMatchObject({ error: { metadata: { code: "gmail_agent_read_audience_outside_project" } } });
    expect(mailGets()).toEqual([]);
    await rejoin();
    expect((await call(await agentRun(session, await grants(session)))).httpStatus).toBe(200);
    // The real membership writer ends the consent in its own transaction; being added back revives nothing.
    as(spaceOwner);
    expect((await userCall("project.member.remove", { project_id: project, user_id: member })).statusCode).toBe(200);
    expect((await db.pool.query(`SELECT status,revoked_by_user_id FROM plugin_data_grants WHERE id=$1`, [grantId])).rows[0]).toEqual({ status: "revoked", revoked_by_user_id: spaceOwner });
    expect((await userCall("project.member.add", { project_id: project, user_id: member, role: "member" })).statusCode).toBe(201);
    google.calls = [];
    expect((await call(await agentRun(session, await grants(session)))).body).toMatchObject({ error: { code: "operation_consent_required" } });
    expect(mailGets()).toEqual([]);
    expect((await db.pool.query(`SELECT status FROM plugin_data_grants WHERE id=$1`, [grantId])).rows[0].status).toBe("revoked");
  });

  it("refuses a Project consent with any part missing or a time limit (no NULL hole in its shape)", async () => {
    const connectionId = await connect();
    const insert = (overrides: Record<string, unknown>) => {
      const row: Record<string, unknown> = { id: randomUUID(), space_id: space, plugin_id: "core:gmail", toolset: "read", data_class: "sensitive", scope: "project", data_owner_user_id: member, granted_by_user_id: member,
        target_run_id: null, plugin_version: "1", authority_hash: "x", expanded_json: "[]", status: "revoked", revoked_at: new Date().toISOString(), expires_at: null, project_id: project, connection_id: connectionId,
        connection_generation: 1, purpose: "on_demand_read", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...overrides };
      const columns = Object.keys(row);
      return db.pool.query(`INSERT INTO plugin_data_grants (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`, columns.map((c) => row[c]));
    };
    await expect(insert({})).resolves.toBeTruthy();
    for (const hole of [{ connection_generation: null }, { purpose: null }, { data_owner_user_id: null, connection_id: null }, { expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { connection_generation: 0 }])
      await expect(insert(hole), JSON.stringify(hole)).rejects.toMatchObject({ code: "23514" });
    // A sensitive per-Run row without its owner was a NULL hole too.
    await expect(insert({ plugin_id: "plug", scope: "run", data_owner_user_id: null, project_id: null, connection_id: null, connection_generation: null, purpose: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject({ code: "23514" });
  });

  it("upgrade: a per-Run Gmail consent still active before ADR 0033 is ended by its migration and never admits", async () => {
    const connectionId = await connect();
    as(member); await setAgentRead(connectionId, true);
    const session = await directSession();
    const run = await agentRun(session, await grants(session));
    const statements = readFileSync(join(import.meta.dirname, "./fixtures/preSquash/0033_gmail_project_agent_read_consent.sql"), "utf8").split("--> statement-breakpoint").map((part) => part.trim());
    const upgrade = statements.filter((part) => part.includes(`UPDATE "plugin_data_grants" SET "status" = 'expired'`) || part.includes(`ADD CONSTRAINT "ck_plugin_data_grants_core_scope"`));
    expect(upgrade).toHaveLength(2);
    const pin = JSON.stringify([{ action_id: ACTION, action_version: 1, data_class: "sensitive", side_effects: "none", gate_class: null }]);
    const legacy = randomUUID();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      // The schema before 0033 held this row: the owner's one-hour consent bound to the Run.
      await client.query(`ALTER TABLE plugin_data_grants DROP CONSTRAINT ck_plugin_data_grants_core_scope`);
      await client.query(`INSERT INTO plugin_data_grants (id,space_id,plugin_id,toolset,data_class,scope,data_owner_user_id,granted_by_user_id,target_run_id,plugin_version,authority_hash,expanded_json,status,expires_at,created_at,updated_at)
        VALUES ($1,$2,'core:gmail','read','sensitive','run',$3,$3,$4,'1','x',$5::jsonb,'active',now()+interval '1 hour',now(),now())`, [legacy, space, member, run.id, pin]);
      for (const statement of upgrade) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect((await db.pool.query(`SELECT status,revoked_at FROM plugin_data_grants WHERE id=$1`, [legacy])).rows[0]).toEqual({ status: "expired", revoked_at: null });
    // The Run it was bound to reads nothing with it; only a new Project consent would admit.
    google.calls = [];
    expect((await call(run)).body).toMatchObject({ ok: false, error: { code: "operation_consent_required" } });
    expect(mailGets()).toEqual([]);
    // It cannot be brought back, and no new one can be written.
    await expect(db.pool.query(`UPDATE plugin_data_grants SET status='active' WHERE id=$1`, [legacy])).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps the call's words and result out of the Run's event logs", () => {
    const filter = createPrivateToolCallFilter();
    const start = filter({ method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "c1", title: `$RAINVER_CLI call ${ACTION} '{"query":"superlinear"}'`, rawInput: { command: `rainver call ${ACTION}` }, status: "pending", kind: "execute" } } });
    const done = filter({ method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: BODY } }] } } });
    expect(JSON.stringify([start, done])).not.toMatch(new RegExp(`superlinear|${BODY}`));
  });
});
