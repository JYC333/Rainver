import { DUPLICATE_TASK_CANCELLATION_REASON } from "@rainver/protocol";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { sharedHostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { JobWorker } from "../src/modules/jobs/worker.js";
import { policyModule } from "../src/modules/policy/index.js";
import { proposalsModule } from "../src/modules/proposals/index.js";
import { RoomService } from "../src/modules/rooms/service.js";
import { RuntimeContextPolicyRepository } from "../src/modules/policy/runtimeContextPolicyRepository.js";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins.js";
import { registerAgentRunHandler } from "../src/modules/runs/agentRunHandler.js";
import { runsModule } from "../src/modules/runs/index.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { sensitiveConversationReads } from "../src/modules/runs/contextTaint.js";
import { ConversationExecutionContextService } from "../src/modules/sessions/executionContextService.js";
import { CLAUDE_CONVERSATION_DEFAULT_MODEL } from "../src/modules/sessions/sessionConfig.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { sourcesModule } from "../src/modules/sources/index.js";
import { assertGmailAgentReadUrl } from "../src/modules/sources/gmail/gmailAgentReadContract.js";
import { assertGmailDigestReadUrl } from "../src/modules/sources/gmail/gmailDigestReads.js";
import { startDueGmailDigests } from "../src/modules/sources/gmail/gmailDigests.js";
import { __setGmailOAuthGuardForTests } from "../src/modules/sources/gmail/gmailOAuthTransport.js";
import { __setGmailProfileGuardForTests } from "../src/modules/sources/gmail/gmailOAuthFlow.js";
import { __setGmailReadGuardForTests } from "../src/modules/sources/gmail/gmailMailReads.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { seedAgentWithVersion, seedRoomManager, seedRun, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { publicAddressGuard } from "./support/outboundGuard.js";
import { resetTables } from "./support/resetTables.js";
import { SyntheticAcpHost, type SyntheticAcpAnswer, type SyntheticAcpPrompt } from "./support/syntheticAcpHost.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { proposeGmailDigest } from "../src/modules/sources/gmail/gmailDigestProposal.js";
import { AuthorizationRequestService } from "../src/modules/policy/authorizationRequestService.js";

/**
 * ADR 0033 §6 acceptance, joined end to end on real
 * PostgreSQL: a person asks about their Gmail in a Room of a Project; the
 * production Room service writes the message and the Room's Run; the
 * production `agent_run` job handler executes it on the conversation's own
 * selected runtime (here the built-in Host's CLI on its own login,
 * `runtime_native`: no ModelProvider lease, no isolated launch); the agent
 * calls `source.gmail.mail.read` on the Run's own tool route; the first read
 * in this Project is refused with `operation_consent_required` and the agent
 * calls `authorization.request`; the mailbox owner approves the card in place;
 * the reconcile job requeues the **same** Run, which reads the newest five
 * bodies and a `superlinear` search through the server's Gmail broker and
 * replies in the Room — no new conversation, message copy or navigation.
 *
 * Stand-ins: the Host daemon process and CLI/ACP adapter (`SyntheticAcpHost`
 * answers the wire frames and makes the tool calls a CLI would make with what
 * its launch frame held); the file-v1 tool bridge (tool calls are injected into
 * the Run tool route with the Run's token); Google (a `fetch` stub with a
 * synthetic mailbox). Real: Room service, queue/worker and handlers, Gateway
 * and snapshot, dispatcher, run tool identity and route, system actions,
 * consent request/approval, release gate, Room message writer.
 */
const db = useTestDatabase(import.meta.filename, { max: 6 });
const CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");
const CLIENT_ID = "gmail-client.apps.googleusercontent.com";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
// Match the default model the server requests on native Claude conversations.
const ACP_CONFIG_OPTIONS = [{
  id: "model", category: "model", type: "select", name: "Model",
  currentValue: CLAUDE_CONVERSATION_DEFAULT_MODEL,
  options: [{ value: CLAUDE_CONVERSATION_DEFAULT_MODEL, name: "Default model" }],
}];
const READ_TOOL = "source.gmail.mail.read";
const REQUEST = "Summarize my five latest emails, then find the superlinear one.";
const BODY = "ROOM-BODY-MARK-5d21";
const ROOM_REPLY = "Your five latest emails and the superlinear offer, summarized.";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const idToken = (sub: string) => `e30.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
type Msg = { id: string; at: number; subject: string; text: string };
const base = Date.UTC(2026, 10, 10);
const mailbox: Msg[] = [
  ...Array.from({ length: 6 }, (_, i) => ({ id: (0x2a00 + i).toString(16), at: base + i * 60_000, subject: `Update ${i}`, text: `${BODY} update ${i}` })),
  { id: "2b01", at: base - 86_400_000, subject: "Superlinear offer", text: `${BODY} superlinear terms` },
];
const full = (m: Msg) => ({ id: m.id, threadId: m.id, internalDate: String(m.at), labelIds: ["INBOX"],
  payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: m.subject }, { name: "From", value: "Sender <s@mail.example>" }], body: { data: b64(m.text) } } });

let config: ServerConfig;
let app: ReturnType<typeof buildModuleServer> | undefined;
let host: SyntheticAcpHost | undefined;
let home = "";
const google = { calls: [] as string[], onMessageGet: null as null | (() => Promise<void>) };
let space: string, spaceOwner: string, owner: string, peer: string, project: string, agent: string, hostId: string;

beforeEach(async () => {
  // One built-in Host per instance (uq_hosts_single_server).
  await resetTables(db.pool, ["spaces", "users", "hosts", "machines", "jobs", "credentials", "source_request_quota_state"], { cascade: true });
  home = await mkdtemp(join(tmpdir(), "rainver-gmail-room-accept-"));
  space = randomUUID(); spaceOwner = randomUUID(); owner = randomUUID(); peer = randomUUID(); project = randomUUID();
  agent = randomUUID(); hostId = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner: spaceOwner, project, spaceType: "team" });
  for (const user of [owner, peer]) {
    await seedSpaceMember(db.pool, { space, user });
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, user]);
  }
  for (const user of [spaceOwner, owner, peer]) {
    const personal = randomUUID();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Personal','personal',now(),now())`, [personal]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',now(),now())`, [randomUUID(), personal, user]);
  }
  config = loadConfig({
    ...process.env,
    SERVER_DEBUG: "false",
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_INTERNAL_TOKEN: "internal-token",
    RAINVER_HOME: home,
    GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret-fixture",
    GMAIL_OAUTH_REDIRECT_URI: "http://localhost:3000/api/v1/sources/gmail/oauth/callback",
  });
  // The Host with a logged-in CLI installation (no model channel needed or used).
  await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,NULL,'Server','server',now(),now())`, [hostId]);
  await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,last_heartbeat_at,created_at,updated_at)
    VALUES ($1,NULL,$1,'Server','server','server','online',$2::jsonb,now(),now(),now())`, [hostId, JSON.stringify({
    execution_workspaces: { version: 2 }, runtimes: [], versions: {},
    installations: { claude_code: [{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, health_check_protocol: "acp", options: { config_options: [] } }] },
  })]);
  // The Room's Agent on the CLI's own login (`runtime_native`): exactly the case an isolation requirement used to refuse.
  await seedAgentWithVersion(db.pool, { space, owner: spaceOwner, agent, version: randomUUID(), name: "Assistant", systemPrompt: "Answer in the Room.", seedDefaultRuntimeProfile: false });
  await db.pool.query(`UPDATE agents SET visibility='space_shared' WHERE id=$1`, [agent]);
  await db.pool.query(`INSERT INTO agent_runtime_profiles (id,space_id,agent_id,execution_host_id,workspace_location_id,workspace_mode,runtime_installation,name,runtime_key,
      backend_mode,model_provider_id,model_name,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
    VALUES ($1,$2,$3,$4,NULL,'managed','managed:1.0.0','Default','claude_code','runtime_native',NULL,NULL,'{}'::jsonb,'{}'::jsonb,true,true,now(),now())`,
    [randomUUID(), space, agent, hostId]);
  await new RuntimeContextPolicyRepository(db.pool).write({ spaceId: space, userId: spaceOwner }, "space", space, {
    base_version_id: null, policy: { constraints: {}, preferences: {} }, reason: "Synthetic acceptance policy",
  });
  await syncBuiltinPrompts(db.pool, CATALOG_ROOT);

  app = buildModuleServer(config, [sourcesModule, systemActionsModule, proposalsModule, policyModule, runsModule]);
  __setGmailOAuthGuardForTests(publicAddressGuard);
  __setGmailProfileGuardForTests(publicAddressGuard);
  __setGmailReadGuardForTests(publicAddressGuard);
  google.calls = []; google.onMessageGet = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const href = String(url instanceof Request ? url.url : url);
    google.calls.push(href);
    if (href === "https://oauth2.googleapis.com/token") return json({ access_token: `ya29.${randomUUID()}`, expires_in: 3599, token_type: "Bearer", scope: `openid ${READONLY}`, id_token: idToken("6006"), refresh_token: `1//r-${randomUUID()}` });
    if (href.endsWith("/profile")) return json({ emailAddress: "owner@gmail.example" });
    const parsed = new URL(href);
    const window = /^after:(\d+) before:(\d+)$/.exec(parsed.searchParams.get("q") ?? "");
    // A digest's request is its own server-built window (or a rule digest's frozen ids); an on-demand read's is the Agent read allowlist.
    if (window) expect(() => assertGmailDigestReadUrl(href)).not.toThrow();
    else {
      const allowed = (assert: (url: string) => unknown) => { try { assert(href); return true; } catch { return false; } };
      expect(allowed(assertGmailAgentReadUrl) || allowed(assertGmailDigestReadUrl), href).toBe(true);
    }
    if (parsed.pathname.endsWith("/messages")) {
      const q = parsed.searchParams.get("q"), max = Number(parsed.searchParams.get("maxResults"));
      const listed = [...mailbox].sort((a, b) => b.at - a.at).filter((m) => window
        ? m.at > Number(window[1]) * 1000 && m.at < Number(window[2]) * 1000
        : !q || m.text.toLowerCase().includes(q.split(" ")[0]!.toLowerCase()));
      return json({ messages: listed.slice(0, max).map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: listed.length });
    }
    const m = mailbox.find((x) => parsed.pathname.endsWith(`/${x.id}`));
    if (m && google.onMessageGet) { const hook = google.onMessageGet; google.onMessageGet = null; await hook(); }
    return m ? json(full(m)) : json({ error: { code: 404 } }, 404);
  });
});

afterEach(async () => {
  __setAuthIdentityForTests(null); __setGmailOAuthGuardForTests(null); __setGmailProfileGuardForTests(null); __setGmailReadGuardForTests(null);
  vi.restoreAllMocks();
  host?.disconnect(); host = undefined;
  await app?.close(); app = undefined;
  if (home) await rm(home, { recursive: true, force: true });
});

const as = (userId: string) => __setAuthIdentityForTests({ spaceId: space, userId });
const userCall = (name: string, payload: Record<string, unknown>) => app!.inject({ method: "POST", url: `/api/v1/actions/${name}`, headers: { "idempotency-key": randomUUID() }, payload });
const mailGets = () => google.calls.filter((url) => url.includes("/messages"));
/**
 * The owner revokes a Gmail consent from their own entry — the consent list and the Gmail card both call
 * `plugin_data_grant.revoke` — and the response is the revoked consent; the list then shows it revoked.
 */
async function revokeAsOwner(grantId: string, purpose: "on_demand_read" | "daily_digest" | "rule_digest") {
  as(owner);
  const revoked = await userCall("plugin_data_grant.revoke", { grant_id: grantId });
  expect(revoked.statusCode, revoked.body).toBe(200);
  expect(revoked.json().data).toMatchObject({ id: grantId, scope: "project", purpose, project_id: project, status: "revoked", revoked_at: expect.any(String) });
  const listed = await app!.inject({ method: "GET", url: `/api/v1/queries/plugin_data_grant.list?input=${encodeURIComponent("{}")}` });
  expect(listed.statusCode, listed.body).toBe(200);
  expect((listed.json().data.items as { id: string; status: string }[]).find((g) => g.id === grantId)).toMatchObject({ status: "revoked", purpose });
}

async function connectGmail(): Promise<string> {
  as(owner);
  const start = await app!.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: {} });
  const state = new URL(start.json().authorize_url).searchParams.get("state")!;
  await app!.inject({ method: "GET", url: `/api/v1/sources/gmail/oauth/callback?${new URLSearchParams({ state, code: `4/c-${randomUUID()}` })}` });
  const id = (await db.pool.query(`SELECT id FROM gmail_connections WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [owner])).rows[0].id;
  const optIn = await userCall("source.gmail.connection.set_agent_read", { connection_id: id, enabled: true });
  expect(optIn.statusCode, optIn.body).toBe(200);
  google.calls = [];
  return id;
}

/**
 * A Room conversation on the Host: the Project's mainline by default, or (`room: "limited"`) a Room of the Project
 * whose roster is the owner and the peer; `room` may also be an existing Room's id. The Agent is its manager.
 */
async function roomConversation(options: { room?: "mainline" | "limited" | string } = {}) {
  const room = options.room === "limited"
    ? (await db.pool.query<{ id: string }>(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline)
        VALUES ($1,$2,$3,$4,'Applications','active',now(),now(),false) RETURNING id`, [randomUUID(), space, project, owner])).rows[0]!.id
    : options.room && options.room !== "mainline" ? options.room
    : (await db.pool.query<{ id: string }>(`SELECT id FROM rooms WHERE project_id=$1 AND is_mainline`, [project])).rows[0]!.id;
  await seedRoomManager(db.pool, { space, room, agent });
  for (const user of [owner, peer]) await db.pool.query(`INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'member','active',now(),now()) ON CONFLICT DO NOTHING`, [randomUUID(), space, room, user]);
  const conversation = await new PgSessionRepository(db.pool).createRoomConversation({
    space_id: space, room_id: room, project_id: project, project_folder_id: null, title: "Mail", metadata: {},
  });
  const profile = (await db.pool.query<{ id: string }>(`SELECT id FROM agent_runtime_profiles WHERE agent_id=$1`, [agent])).rows[0]!.id;
  await new ConversationExecutionContextService(db.pool).initialize({ spaceId: space, userId: owner }, conversation.id, {
    selection: { execution_host_id: hostId, primary: { kind: "managed" } },
    runtime: { agent_id: agent, runtime_profile_id: profile, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
  });
  return { room, conversationId: conversation.id };
}

/** One tool call the way a CLI makes it: the Run's tool route with the token its launch frame carried. */
async function runTool(frame: Record<string, any>, action: string, args: Record<string, unknown> = {}) {
  const env = frame.work_surface.env as Record<string, string>;
  const response = await app!.inject({ method: "POST", url: `/api/v1/runs/${env.RAINVER_RUN_ID ?? frame.run_id}/tools/${action}`,
    headers: { authorization: `Bearer ${env.RAINVER_TOOL_TOKEN}`, "idempotency-key": randomUUID() }, payload: args });
  return { status: response.statusCode, body: response.json() as Record<string, any>, raw: response.body };
}

describe("ADR 0033 §6 Gmail read in place in a Room, from the queue to the Room reply", () => {
  /** The Room conversation, the production queue worker (agent runs and authorization reconciles) and the synthetic Host. */
  async function roomQueue(onTurn: (frame: Record<string, any>, prompt: SyntheticAcpPrompt) => Promise<SyntheticAcpAnswer>, options: { room?: "mainline" | "limited" } = {}) {
    const { room, conversationId } = await roomConversation(options);
    const handlers = new JobHandlerRegistry();
    registerAgentRunHandler(handlers, config);
    const worker = new JobWorker(new PgJobQueueRepository(db.pool), handlers, "gmail-room-read", ["agent_run", "authorization_request_reconcile"], 0);
    const launched: string[] = [];
    host = new SyntheticAcpHost(sharedHostConnectionRegistry, hostId, async (prompt: SyntheticAcpPrompt): Promise<SyntheticAcpAnswer> => {
      launched.push(prompt.runId);
      return onTurn(host!.launchFrames.get(prompt.runId) as Record<string, any>, prompt);
    }, ACP_CONFIG_OPTIONS).connect();
    const execute = async (runId: string, until: readonly string[] = ["succeeded", "failed", "cancelled", "orphaned"]) => {
      for (let job = 0; job < 8; job += 1) {
        const state = (await db.pool.query("SELECT status FROM runs WHERE id=$1", [runId])).rows[0];
        if (until.includes(state.status)) break;
        if (!await worker.processOne()) break;
      }
      return (await db.pool.query(`SELECT * FROM runs WHERE id=$1`, [runId])).rows[0];
    };
    const runJobs = async (runId: string) => (await db.pool.query(`SELECT status FROM jobs WHERE payload_json->>'run_id'=$1 ORDER BY created_at`, [runId])).rows;
    /** A second `agent_run` job for the same Run, the way a redelivery or a recovery sweep adds one. */
    const duplicateJob = async (runId: string) => {
      const run = (await db.pool.query(`SELECT space_id,agent_id,project_folder_id,instructed_by_user_id FROM runs WHERE id=$1`, [runId])).rows[0];
      await new PgJobQueueRepository(db.pool).enqueue({ job_type: "agent_run", space_id: run.space_id, user_id: run.instructed_by_user_id,
        agent_id: run.agent_id, project_folder_id: run.project_folder_id, payload: { run_id: runId } });
    };
    return { room, conversationId, launched, worker, execute, runJobs, duplicateJob };
  }

  it("confirms once in place and continues the same Room Run: reads the newest five bodies and a superlinear search on the conversation's own runtime, and replies in the Room", async () => {
    const connectionId = await connectGmail();
    const seen: { frames: Record<string, any>[]; tools?: string[]; asked?: { status: number; body: Record<string, any> }; request?: { status: number; body: Record<string, any> };
      recent?: { status: number; body: Record<string, any> }; search?: { status: number; body: Record<string, any> } } = { frames: [] };
    const { room, conversationId, launched, execute } = await roomQueue(async (frame) => {
      seen.frames.push(frame);
      const tools = await app!.inject({ method: "GET", url: `/api/v1/runs/${frame.run_id ?? frame.work_surface.env.RAINVER_RUN_ID}/tools`, headers: { authorization: `Bearer ${frame.work_surface.env.RAINVER_TOOL_TOKEN}` } });
      seen.tools = (tools.json().tools as Array<{ name: string }>).map((tool) => tool.name);
      const first = await runTool(frame, READ_TOOL);
      if (first.status === 403) {
        // The first read in this Project: ask the owner once, in this conversation, with the refusal's details.
        seen.asked = first;
        seen.request = await runTool(frame, "authorization.request", { policy_decision_record_id: first.body.policy_decision_record_id, reason: "Read your latest mail for your request" });
        return { text: "Waiting for your Gmail confirmation." };
      }
      seen.recent = first;
      seen.search = await runTool(frame, READ_TOOL, { query: "superlinear" });
      return { text: ROOM_REPLY };
    });
    const sessionsBefore = (await db.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n;
    // 1. The owner asks in the Room; the production Room service writes the message and the Room's Run.
    const sent = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: REQUEST });
    const runId = sent.run_ids[0]!;
    const waiting = await execute(runId, ["waiting_for_review", "succeeded", "failed", "cancelled", "orphaned"]);
    expect(waiting, JSON.stringify({ error: waiting.error_json, message: waiting.error_message, asked: seen.asked, request: seen.request })).toMatchObject({ status: "waiting_for_review" });
    // The Room's Run holds the mail tool itself and launched on the conversation's own runtime: no isolation, no model channel.
    expect(seen.tools).toContain(READ_TOOL);
    expect(seen.tools).not.toContain("source.gmail.private_check.request");
    expect(seen.frames[0]!.model_channel).toBeUndefined();
    expect(seen.frames[0]!.isolation?.egress_profile).not.toBe("none");
    expect(seen.asked!.body).toMatchObject({ ok: false, error: { code: "operation_consent_required" } });
    expect(seen.request!.status, JSON.stringify(seen.request!.body)).toBe(200);
    expect(mailGets()).toEqual([]);

    // 2. The card is the mailbox owner's alone; the peer and the Space owner can neither see nor decide it.
    const requests = new AuthorizationRequestService(db.pool, config);
    const [card] = await requests.listForRun({ spaceId: space, userId: owner }, runId);
    expect(card).toMatchObject({ approver: "data_owner", consent_state: "approvable", status: "pending" });
    for (const other of [peer, spaceOwner]) {
      expect(await requests.listForRun({ spaceId: space, userId: other }, runId)).toEqual([]);
      await expect(requests.decide({ spaceId: space, userId: other }, card!.id, "approved")).rejects.toMatchObject({ statusCode: 404 });
    }
    // 3. The owner approves in place; the same Run continues (requeued), reads and replies in the Room.
    const approved = await requests.decide({ spaceId: space, userId: owner }, card!.id, "approved");
    expect(approved.resulting_plugin_data_grant_id).toEqual(expect.any(String));
    const done = await execute(runId);
    // The deterministic harness marks a Run whose turn met a (since resolved) consent refusal `degraded`; it ended and replied.
    expect(["succeeded", "degraded"], JSON.stringify({ error: done.error_json, message: done.error_message })).toContain(done.status);
    expect(launched.filter((id) => id === runId)).toHaveLength(2);
    expect(seen.recent!.status, JSON.stringify(seen.recent!.body)).toBe(200);
    const recentItems = (seen.recent!.body.data as { items: { id: string; text: string }[] }).items;
    expect(recentItems.map((i) => i.id)).toEqual(["2a05", "2a04", "2a03", "2a02", "2a01"]);
    for (const item of recentItems) expect(item.text).toContain(BODY);
    expect(seen.search!.status, JSON.stringify(seen.search!.body)).toBe(200);
    const hits = (seen.search!.body.data as { items: { id: string; text: string }[] }).items;
    expect(hits.map((i) => i.id)).toEqual(["2b01"]);
    expect(hits[0]!.text).toContain("superlinear terms");
    // The consent is bound to this Project and mailbox; reads are audited to it; no new conversation was created.
    expect((await db.pool.query(`SELECT project_id,connection_id,scope,purpose FROM plugin_data_grants WHERE id=$1`, [approved.resulting_plugin_data_grant_id])).rows[0])
      .toEqual({ project_id: project, connection_id: connectionId, scope: "project", purpose: "on_demand_read" });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events WHERE run_id=$1 AND project_id=$2`, [runId, project])).rows[0].n).toBe(2);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n).toBe(sessionsBefore);
    // The reply is the Room's: one assistant message in this conversation, for its audience.
    const replies = (await db.pool.query(`SELECT content,session_id FROM messages WHERE run_id=$1 AND role='assistant'`, [runId])).rows;
    expect(replies.at(-1)).toEqual({ content: ROOM_REPLY, session_id: conversationId });
    // The tool call's words and result are not in the event logs; the Gmail credential never reached the Host.
    for (const [table, column] of [["run_events", "metadata_json"], ["run_events", "summary"]] as const)
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}::text LIKE $1`, [`%${BODY}%`])).rows[0].n, `${table}.${column}`).toBe(0);
    expect(JSON.stringify(seen.frames)).not.toMatch(/ya29\.|1\/\/r-/);

    // 4. A later request in the same Project's conversation reuses the consent at once; revocation stops the next read.
    const again = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: "Any new mail?" });
    expect((await execute(again.run_ids[0]!)).status).toBe("succeeded");
    expect(seen.recent!.status).toBe(200);
    await revokeAsOwner(approved.resulting_plugin_data_grant_id!, "on_demand_read");
    google.calls = [];
    seen.asked = undefined;
    const third = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: "And now?" });
    await execute(third.run_ids[0]!, ["waiting_for_review", "succeeded", "failed", "cancelled", "orphaned"]);
    expect((seen.asked as { body: unknown } | undefined)?.body).toMatchObject({ error: { code: "operation_consent_required" } });
    expect(mailGets()).toEqual([]);
  });

  type Call = { status: number; body: Record<string, any>; raw: string };
  const UNTIL_WAIT = ["waiting_for_review", "succeeded", "degraded", "failed", "cancelled", "orphaned"];
  const removeFromProject = (user: string) => db.pool.query(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [project, user]);
  const restoreToProject = (user: string) => db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
    [randomUUID(), space, project, user]);

  it("limits Gmail-tainted cancellation to shared, unstarted Tasks without execution or publication dependencies", async () => {
    await connectGmail();
    const tasks = new PgTaskRepository(db.pool);
    const createTask = (projectId: string, userId: string, title: string, status = "ready", visibility = "space_shared") => tasks.createTask(
      { spaceId: space, userId }, { project_id: projectId, title, status, visibility },
    );
    const duplicate = await createTask(project, owner, "Duplicate");
    const other = await createTask(project, owner, "Other Task");
    const ordinary = await createTask(project, owner, "Ordinary active Task", "in_progress");
    const done = await createTask(project, owner, "Done Task");
    await tasks.updateTask({ spaceId: space, userId: owner }, done.id, { status: "done" });
    const active = await createTask(project, owner, "Active Task", "in_progress");
    const reopened = await createTask(project, owner, "Reopened Task", "in_progress");
    await tasks.updateTask({ spaceId: space, userId: owner }, reopened.id, { status: "ready" });
    const privateTask = await createTask(project, peer, "Private Task", "ready", "private");
    const withRun = await createTask(project, owner, "Task with Run");
    const withMerge = await createTask(project, owner, "Task with merge");
    const withWorkspace = await createTask(project, owner, "Task with workspace");
    const withMergeJob = await createTask(project, owner, "Task with pending merge job");
    const ineligible = [
      { task: done, status: "done" }, { task: active, status: "in_progress" },
      { task: reopened, status: "ready" }, { task: privateTask, status: "ready" },
      { task: withRun, status: "ready" }, { task: withMerge, status: "ready" },
      { task: withWorkspace, status: "ready" }, { task: withMergeJob, status: "ready" },
    ];

    const location = randomUUID(), folder = randomUUID(), linkedRun = randomUUID(), merge = randomUUID();
    await db.pool.query(
      `INSERT INTO project_folders (id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at)
       VALUES ($1,$2,$3,'Fixture repo','code','active',false,false,now(),now())`, [folder, space, project],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (id,space_id,project_folder_id,execution_host_id,execution_host_kind,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'server',now(),now())`, [location, space, folder, hostId],
    );
    const version = (await db.pool.query<{ current_version_id: string }>(
      "SELECT current_version_id FROM agents WHERE id=$1", [agent],
    )).rows[0]!.current_version_id;
    await seedRun(db.pool, { id: linkedRun, space, owner, agent, version, existingAgent: true });
    await db.pool.query("UPDATE runs SET project_id=$2,project_folder_id=$3,workspace_location_id=$4 WHERE id=$1",
      [linkedRun, project, folder, location]);
    await db.pool.query(
      "INSERT INTO task_runs (id,space_id,task_id,run_id,role,created_at) VALUES ($1,$2,$3,$4,'primary',now())",
      [randomUUID(), space, withRun.id, linkedRun],
    );
    await db.pool.query(
      `INSERT INTO task_merges (id,space_id,task_id,workspace_location_id,basis,status,requested_by_user_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'fixture','conflict',$5,now(),now())`, [merge, space, withMerge.id, location, owner],
    );
    await db.pool.query(
      `INSERT INTO execution_workspaces (id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,task_id)
       VALUES ($1,$2,$3,$4,$5,'task',$6)`, [randomUUID(), space, project, location, hostId, withWorkspace.id],
    );
    const scheduledAt = new Date(Date.now() + 3600_000);
    const pendingMerge = await new PgJobQueueRepository(db.pool).enqueue({
      job_type: "task_merge", space_id: space, user_id: owner, scheduled_at: scheduledAt,
      payload: { task_id: withMergeJob.id, merge_id: randomUUID(), workspace_location_id: location, host_id: hostId },
    });
    const foreignProject = randomUUID();
    await db.pool.query(
      "INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,'Other Project','active',$3,now(),now())",
      [foreignProject, space, peer],
    );
    const foreign = await createTask(foreignProject, peer, "Foreign Task");
    const cancelled = { status: "cancelled", reason: DUPLICATE_TASK_CANCELLATION_REASON };
    const results = new Map<string, Awaited<ReturnType<typeof runTool>>>();
    let phase: "ordinary" | "read" | "cancel" | "revoked" = "ordinary";
    const { room, conversationId, execute } = await roomQueue(async (frame) => {
      const call = async (label: string, action: string, input?: Record<string, unknown>) => {
        const result = await runTool(frame, action, input);
        results.set(label, result);
        return result;
      };
      if (phase === "read") {
        const read = await call("read", READ_TOOL);
        if (read.status === 403) {
          await call("request", "authorization.request", { policy_decision_record_id: read.body.policy_decision_record_id, reason: "Check the latest mail" });
        }
        return { text: "Checked the request." };
      }

      const list = await call("list", "task.list");
      const listed = list.body.tasks as Array<{ task_id: string; title: string }>;
      const listedId = (title: string) => listed.find(t => t.title === title)!.task_id;
      if (phase === "ordinary") {
        await call("ordinary", "task.set_status", { ...cancelled, task_id: listedId(ordinary.title) });
        return { text: "Checked the cancellation." };
      }
      if (phase === "revoked") {
        await call("revoked", "task.set_status", { ...cancelled, task_id: listedId(other.title) });
        return { text: "Checked the cancellation." };
      }
      for (const {task} of ineligible) {
        await call(task.title, "task.set_status", { ...cancelled, task_id: listedId(task.title) });
      }
      const task_id = listedId(duplicate.title);
      await call("text", "task.set_status", { ...cancelled, task_id, reason: `${cancelled.reason}: ${BODY}` });
      for (const status of ["done", "waiting_for_review", "blocked"]) {
        await call(status, "task.set_status", { task_id, status, reason: cancelled.reason });
      }
      await call("outward", "task.create", { title: BODY });
      // Negative scope control: the peer owns this fixture but the tool is bound to this Run's Project.
      await call("foreign", "task.set_status", { ...cancelled, task_id: foreign.id });
      const role = (next: string) => db.pool.query("UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2", [project, peer, next]);
      await role("viewer");
      try {
        await call("no write", "task.set_status", { ...cancelled, task_id });
      } finally {
        await role("member");
      }
      await call("cancel", "task.set_status", { ...cancelled, task_id });
      return { text: "Checked the duplicate." };
    }, { room: "limited" });
    const turn = async (userId: string, content: string) => (await new RoomService(config, db.pool)
      .sendMessage({ spaceId: space, userId }, room, conversationId, { content })).run_ids[0]!;

    await execute(await turn(peer, "Cancel the ordinary active Task."));
    expect(results.get("ordinary")).toMatchObject({
      status: 200, body: { data: { task_id: ordinary.id, status: "cancelled" } },
    });
    phase = "read";
    const readRun = await turn(owner, "Check my latest mail.");
    await execute(readRun, ["waiting_for_review"]);
    const requests = new AuthorizationRequestService(db.pool, config);
    const [card] = await requests.listForRun({ spaceId: space, userId: owner }, readRun);
    const grant = (await requests.decide({ spaceId: space, userId: owner }, card!.id, "approved")).resulting_plugin_data_grant_id!;
    await execute(readRun);
    expect(results.get("read")).toMatchObject({ status: 200 });
    expect(results.get("read")!.raw).toContain(BODY);

    const before = [...google.calls];
    phase = "cancel";
    const cancelRun = await turn(peer, "Cancel the duplicate Task.");
    const run = await execute(cancelRun);
    expect(run.instructed_by_user_id).toBe(peer);
    expect(run.context_taint_json).toMatchObject({
      non_instructing_owner_user_ids: [owner],
      plugin_reads: [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner, gmail_scope: { project_id: project, grant_id: grant } }],
    });
    expect(results.get("list")?.body.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ task_id: duplicate.id })]));
    for (const label of ["outward", "foreign", "no write"]) {
      expect(results.get(label), label).toMatchObject({ status: 404, body: { error: { code: "operation_not_found", metadata: {} } } });
    }
    expect(results.get("foreign")?.body.error).toMatchObject({
      message: expect.stringContaining("Use task.list in this Project"),
    });
    expect(results.get("no write")?.body.error).toMatchObject({
      message: (results.get("foreign")?.body.error as {message: string}).message,
    });
    const blockers = {
      text: "task_cancellation_requires_fixed_reason",
      done: "task_status_not_cancellation",
      waiting_for_review: "task_status_not_cancellation",
      blocked: "task_status_not_cancellation",
      [done.title]: "task_already_started_or_closed",
      [active.title]: "task_already_started_or_closed",
      [privateTask.title]: "task_not_shared",
      [reopened.title]: "task_has_work_history",
      [withRun.title]: "task_has_work_history",
      [withMerge.title]: "task_has_work_history",
      [withWorkspace.title]: "task_has_work_history",
      [withMergeJob.title]: "task_has_work_history",
    };
    for (const [label, code] of Object.entries(blockers)) {
      expect(results.get(label), label).toMatchObject({
        status: 409, body: { error: { code: "operation_conflict", metadata: { code }, retryable: false } },
      });
      expect(results.get(label)!.raw).not.toContain(BODY);
    }
    expect(results.get("cancel"), JSON.stringify(results.get("cancel"))).toMatchObject({
      status: 200, body: { data: { task_id: duplicate.id, status: "cancelled" } },
    });
    const unchanged = (await db.pool.query(
      "SELECT id,status FROM tasks WHERE id=ANY($1::text[])", [ineligible.map(({task}) => task.id)],
    )).rows;
    expect(unchanged).toHaveLength(ineligible.length);
    expect(unchanged).toEqual(expect.arrayContaining(ineligible.map(({task, status}) => ({ id: task.id, status }))));
    expect((await db.pool.query("SELECT status FROM task_merges WHERE id=$1", [merge])).rows).toEqual([{ status: "conflict" }]);
    expect((await db.pool.query(
      "SELECT id,scheduled_at FROM jobs WHERE job_type IN ('task_branch_delete','task_merge') AND payload_json->>'task_id'=ANY($1::text[])",
      [[duplicate.id, ...ineligible.map(({task}) => task.id)]],
    )).rows).toEqual([{ id: pendingMerge.id, scheduled_at: scheduledAt }]);
    const flow = (await db.pool.query(
      "SELECT e.data_json,a.agent_id FROM project_work_events e JOIN actors a ON a.id=e.actor_id WHERE e.subject_id=$1 AND e.event_kind<>'task.created'",
      [duplicate.id],
    )).rows;
    expect(flow).toEqual([{ agent_id: agent, data_json: { from: "ready", to: "cancelled", via: "agent", reason: cancelled.reason, run_id: cancelRun } }]);
    const audits = (await db.pool.query(
      "SELECT decision,policy_rule_id FROM policy_decision_records WHERE run_id=$1 AND action='task.status.set'", [cancelRun],
    )).rows;
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: "allow" }),
      { decision: "deny", policy_rule_id: "hard_invariant_sensitive_plugin_read_egress" },
    ]));

    await revokeAsOwner(grant, "on_demand_read");
    phase = "revoked";
    await execute(await turn(peer, "Cancel the other Task."));
    expect(results.get("revoked")).toMatchObject({
      status: 409, body: { error: { code: "operation_conflict", metadata: { code: "task_status_restricted_context" } } },
    });
    expect((await db.pool.query("SELECT status FROM tasks WHERE id=$1", [other.id])).rows).toEqual([{ status: "ready" }]);
    expect((await db.pool.query("SELECT status FROM tasks WHERE id=$1", [foreign.id])).rows).toEqual([{ status: "ready" }]);
    expect(google.calls).toEqual(before);
  });

  it("checks the audience before choosing a mailbox and never names the owner's mailboxes to a shared Room", async () => {
    const first = await connectGmail();
    // A second opted-in mailbox of the owner, so the read cannot choose one by itself.
    const credential = randomUUID(), second = randomUUID();
    await db.pool.query(`INSERT INTO credentials SELECT (jsonb_populate_record(NULL::credentials, to_jsonb(c) || jsonb_build_object('id',$2::text))).* FROM credentials c
      WHERE c.id=(SELECT credential_id FROM gmail_connections WHERE id=$1)`, [first, credential]);
    await db.pool.query(`INSERT INTO gmail_connections SELECT (jsonb_populate_record(NULL::gmail_connections, to_jsonb(g) || jsonb_build_object('id',$2::text,'credential_id',$3::text,'google_subject','7007','mailbox_email','second@gmail.example'))).*
      FROM gmail_connections g WHERE g.id=$1`, [first, second, credential]);
    const reads: Call[] = [];
    const drafts: Call[] = [];
    const { room, conversationId, execute } = await roomQueue(async (frame) => {
      reads.push(await runTool(frame, READ_TOOL));
      drafts.push(await runTool(frame, "source.gmail.digest.propose", { kind: "daily", local_time: "08:00", time_zone: "Europe/London" }));
      return { text: "Which mailbox?" };
    }, { room: "limited" });
    const rooms = new RoomService(config, db.pool);
    // Everyone reads the Project: the fixed ambiguity code, without either address.
    await execute((await rooms.sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: REQUEST })).run_ids[0]!, UNTIL_WAIT);
    expect(reads.at(-1)!.body, reads.at(-1)!.raw).toMatchObject({ ok: false, error: { metadata: { code: "gmail_agent_read_mailbox_ambiguous" } } });
    expect(reads.at(-1)!.raw).not.toMatch(/owner@gmail\.example|second@gmail\.example/);
    // A digest drafted there asks which mailbox the same way, without listing them.
    expect(drafts.at(-1)!.body, drafts.at(-1)!.raw).toMatchObject({ error: "gmail_digest_mailbox_ambiguous" });
    expect(drafts.at(-1)!.raw).not.toMatch(/owner@gmail\.example|second@gmail\.example/);
    // A reader outside the Project: the audience is refused first, before any mailbox is chosen.
    await removeFromProject(peer);
    await execute((await rooms.sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: REQUEST })).run_ids[0]!, UNTIL_WAIT);
    expect(reads.at(-1)!.body, reads.at(-1)!.raw).toMatchObject({ ok: false, error: { metadata: { code: "gmail_agent_read_audience_outside_project" } } });
    expect(reads.at(-1)!.raw).not.toMatch(/owner@gmail\.example|second@gmail\.example/);
    expect(mailGets()).toEqual([]);
  });

  it("issues no Gmail card while someone outside the Project reads the Room, and rechecks the audience when the owner confirms a card", async () => {
    await connectGmail();
    const seen: { reads: Call[]; requests: Call[] } = { reads: [], requests: [] };
    const { room, conversationId, execute } = await roomQueue(async (frame) => {
      const first = await runTool(frame, READ_TOOL);
      seen.reads.push(first);
      if (first.status === 403) {
        seen.requests.push(await runTool(frame, "authorization.request", { policy_decision_record_id: first.body.policy_decision_record_id, reason: "Read your latest mail" }));
        return { text: "Waiting for your Gmail confirmation." };
      }
      return { text: "Gmail cannot be read in this conversation." };
    }, { room: "limited" });
    const requests = new AuthorizationRequestService(db.pool, config);

    // 1. The peer no longer works in the Project but stays on the Room roster: a fixed refusal, no card, no mail read.
    await removeFromProject(peer);
    const blocked = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: REQUEST });
    await execute(blocked.run_ids[0]!, UNTIL_WAIT);
    expect(seen.reads.at(-1)!.body, JSON.stringify(seen.reads.at(-1))).toMatchObject({ ok: false, error: { metadata: { code: "gmail_agent_read_audience_outside_project" } }, policy_decision_record_id: null });
    expect(seen.requests).toEqual([]);
    expect(await requests.listForRun({ spaceId: space, userId: owner }, blocked.run_ids[0]!)).toEqual([]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM authorization_requests WHERE run_id=$1`, [blocked.run_ids[0]])).rows[0].n).toBe(0);
    expect(mailGets()).toEqual([]);

    // 2. Back in the Project, the owner's next ask gets the card; the peer then leaves the Project again before
    //    the owner confirms: the card is no longer approvable and confirming writes no consent.
    await restoreToProject(peer);
    const asked = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: REQUEST });
    const runId = asked.run_ids[0]!;
    expect((await execute(runId, UNTIL_WAIT)).status).toBe("waiting_for_review");
    expect(seen.requests.at(-1)!.status, JSON.stringify(seen.requests.at(-1))).toBe(200);
    const [card] = await requests.listForRun({ spaceId: space, userId: owner }, runId);
    expect(card).toMatchObject({ consent_state: "approvable", status: "pending" });
    await removeFromProject(peer);
    const [stale] = await requests.listForRun({ spaceId: space, userId: owner }, runId);
    expect(stale).toMatchObject({ id: card!.id, consent_state: "ended", consent_target: null });
    await expect(requests.decide({ spaceId: space, userId: owner }, card!.id, "approved")).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE data_owner_user_id=$1 AND status='active'`, [owner])).rows[0].n).toBe(0);
    expect(mailGets()).toEqual([]);
  });

  it("keeps a Gmail reply's untrusted fence and Project constraint in a Room reference: only the owner may widen it, and later turns where it lands remember, materialize and write nothing", async () => {
    await connectGmail();
    let phase: "read" | "later" = "read";
    const seen: { remember?: Call; task?: Call } = {};
    const { room, conversationId, execute } = await roomQueue(async (frame) => {
      if (phase === "later") {
        seen.remember = await runTool(frame, "memory.remember", { content: "The owner has a superlinear offer.", memory_type: "semantic", rationale: "Useful later." });
        seen.task = await runTool(frame, "task.create", { title: "Answer the superlinear offer" });
        return { text: "Noted here." };
      }
      const first = await runTool(frame, READ_TOOL);
      if (first.status === 403) {
        await runTool(frame, "authorization.request", { policy_decision_record_id: first.body.policy_decision_record_id, reason: "Read your latest mail" });
        return { text: "Waiting for your Gmail confirmation." };
      }
      return { text: ROOM_REPLY };
    }, { room: "limited" });
    const rooms = new RoomService(config, db.pool);
    const requests = new AuthorizationRequestService(db.pool, config);
    const sent = await rooms.sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: REQUEST });
    const runId = sent.run_ids[0]!;
    const waiting = await execute(runId, UNTIL_WAIT);
    expect(waiting.status, JSON.stringify(waiting.error_json)).toBe("waiting_for_review");
    const [card] = await requests.listForRun({ spaceId: space, userId: owner }, runId);
    expect(card).toMatchObject({ consent_state: "approvable" });
    const approved = await requests.decide({ spaceId: space, userId: owner }, card!.id, "approved");
    expect(approved.resulting_plugin_data_grant_id).toEqual(expect.any(String));
    const read = await execute(runId);
    expect(["succeeded", "degraded"], JSON.stringify({ error: read.error_json, card })).toContain(read.status);
    const reply = (await db.pool.query<{ id: string }>(`SELECT id FROM messages WHERE run_id=$1 AND role='assistant' AND content=$2`, [runId, ROOM_REPLY])).rows[0]!.id;

    // The mainline reaches further than the limited Room: the Space owner reads the Project.
    const target = await roomConversation();
    const pick = [{ kind: "messages" as const, id: conversationId, item_ids: [reply] }];
    // Another member cannot carry the owner's mail beyond its audience, even confirming.
    await expect(rooms.attachConversationReferences({ spaceId: space, userId: peer }, target.room, target.conversationId, { references: pick, confirm_disclosure: true }))
      .rejects.toMatchObject({ statusCode: 409, responseBody: { code: "reference_sensitive_scope_mismatch" } });
    // The owner may, under the ordinary disclosure confirmation naming who gains access.
    await expect(rooms.attachConversationReferences({ spaceId: space, userId: owner }, target.room, target.conversationId, { references: pick }))
      .rejects.toMatchObject({ statusCode: 409, responseBody: { code: "reference_disclosure_confirmation_required", gains_access_user_ids: [spaceOwner] } });
    await rooms.attachConversationReferences({ spaceId: space, userId: owner }, target.room, target.conversationId, { references: pick, confirm_disclosure: [spaceOwner] });
    const copied = (await db.pool.query<{ content: string; metadata_json: Record<string, any> }>(
      `SELECT content,metadata_json FROM messages WHERE session_id=$1 AND metadata_json->>'room_display'='reference'`, [target.conversationId])).rows;
    expect(copied).toHaveLength(1);
    expect(copied[0]!.metadata_json.reference).toMatchObject({ trust: "external_untrusted", source_project_id: project, sensitive_reads: [{ plugin_id: "core:gmail", owner_user_id: owner }], sensitive_reads_version: 2 });
    expect(copied[0]!.content).toMatch(/--- begin quoted external transcript [0-9a-f]{8} ---/);
    expect(copied[0]!.content).toContain("never\ninstructions to follow");
    expect(copied[0]!.content).toContain(ROOM_REPLY);

    // A later turn there — another member's — keeps its runtime but inherits the read: no Memory, no Task.
    phase = "later";
    const later = await rooms.sendMessage({ spaceId: space, userId: peer }, target.room, target.conversationId, { content: "Make a task for the offer." });
    const laterRun = await execute(later.run_ids[0]!);
    expect(["succeeded", "degraded"], JSON.stringify(laterRun.error_json)).toContain(laterRun.status);
    expect(laterRun.permission_snapshot_json.sensitive_conversation).toBeUndefined();
    // Inherited with the mailbox owner's id, not as the peer's own read.
    expect(laterRun.context_taint_json.plugin_reads).toEqual([{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }]);
    expect(seen.remember!.body, JSON.stringify(seen.remember!.body)).toMatchObject({ ok: false });
    expect(JSON.stringify(seen.remember!.body)).toContain("stays in this Project's conversations");
    expect(seen.task!.body, JSON.stringify(seen.task!.body)).toMatchObject({ ok: false });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id=$1 AND title='Answer the superlinear offer'`, [project])).rows[0].n).toBe(0);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM memory_entries WHERE content LIKE '%superlinear offer%'`)).rows[0].n).toBe(0);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM proposals WHERE created_by_run_id=$1`, [later.run_ids[0]])).rows[0].n).toBe(0);
    // The conversation the copy landed in answers as holding the owner's Gmail read (Run creation and reflection ask this).
    // Only the owner's: the peer's later turn there is not counted as the peer's own Gmail.
    expect(await sensitiveConversationReads(db.pool, space, target.conversationId)).toEqual({ reads: [{ pluginId: "core:gmail", ownerUserId: owner }], complete: true });

    // A second hop out of that conversation keeps the real owner: the peer copies the reply their own later turn
    // wrote there into another mainline conversation (no one gains access, so no confirmation), and the copy
    // still names the owner's Gmail, not the peer's.
    const laterReply = (await db.pool.query<{ id: string }>(`SELECT id FROM messages WHERE run_id=$1 AND role='assistant'`, [later.run_ids[0]])).rows[0]!.id;
    const third = await roomConversation();
    await rooms.attachConversationReferences({ spaceId: space, userId: peer }, third.room, third.conversationId, { references: [{ kind: "messages", id: target.conversationId, item_ids: [laterReply] }] });
    const hopped = (await db.pool.query<{ metadata_json: Record<string, any> }>(
      `SELECT metadata_json FROM messages WHERE session_id=$1 AND metadata_json->>'room_display'='reference'`, [third.conversationId])).rows;
    expect(hopped.map((row) => row.metadata_json.reference)).toEqual([expect.objectContaining({ trust: "external_untrusted", source_project_id: project, sensitive_reads: [{ plugin_id: "core:gmail", owner_user_id: owner }], sensitive_reads_version: 2 })]);
    expect(await sensitiveConversationReads(db.pool, space, third.conversationId)).toEqual({ reads: [{ pluginId: "core:gmail", ownerUserId: owner }], complete: true });
  });

  it("ends an ordinary Room Run from the claim's locked refusal even when the permission is restored right after it; duplicate jobs change nothing", async () => {
    const { room, conversationId, launched, worker, execute, runJobs, duplicateJob } = await roomQueue(async () => ({ error: "nothing launches here" }));
    const sent = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: "Summarize the kitchen plan." });
    const runId = sent.run_ids[0]!;
    // A redelivered job for the same queued Run, waiting behind the first.
    await duplicateJob(runId);
    expect(await runJobs(runId)).toHaveLength(2);
    // The owner leaves the Room just before the claim's locked recheck and is re-added the moment it returns:
    // an unlocked recheck after the claim would now be allowed and leave the Run queued.
    const membership = (status: string) => db.pool.query(`UPDATE room_user_members SET status=$3,updated_at=now() WHERE room_id=$1 AND user_id=$2`, [room, owner, status]);
    const claim = PgRunRepository.prototype.claimRunExecution;
    const claims: string[] = [];
    vi.spyOn(PgRunRepository.prototype, "claimRunExecution").mockImplementation(async function (this: PgRunRepository, input) {
      if (input.run_id !== runId || claims.length) return claim.call(this, input);
      await membership("removed");
      try {
        const result = await claim.call(this, input);
        claims.push(result.outcome);
        return result;
      } finally {
        await membership("active");
      }
    });
    const ended = await execute(runId);
    expect(claims).toEqual(["authorization_rejected"]);
    expect(ended).toMatchObject({ status: "failed", started_at: null, error_json: expect.objectContaining({ error_code: "run_execution_authorization_revoked" }) });
    expect(launched).toEqual([]);
    expect(host!.launchFrames.has(runId)).toBe(false);
    const terminal = (await db.pool.query(`SELECT status,ended_at,updated_at FROM runs WHERE id=$1`, [runId])).rows[0];
    // The duplicate job is claimed and worked too: it finds the Run ended and changes nothing.
    expect(await worker.processOne()).toBeTruthy();
    expect(await runJobs(runId)).toEqual([{ status: "completed" }, { status: "completed" }]);
    expect((await db.pool.query(`SELECT status,ended_at,updated_at FROM runs WHERE id=$1`, [runId])).rows[0]).toEqual(terminal);
    expect(claims).toEqual(["authorization_rejected"]);
    expect(launched).toEqual([]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM run_attempts WHERE run_id=$1 AND launch_id IS NOT NULL`, [runId])).rows[0].n).toBe(0);
  });

});

describe("ADR 0033 phase B: a Gmail digest set up and delivered in a Room conversation", () => {
  it("is drafted in the owner's own mainline turn, confirmed by them alone, run by the scheduler as one Room turn in that same conversation on its own runtime, and its mail stays in the Project in later turns", async () => {
    await connectGmail();
    const { room, conversationId } = await roomConversation();
    const handlers = new JobHandlerRegistry();
    registerAgentRunHandler(handlers, config);
    const worker = new JobWorker(new PgJobQueueRepository(db.pool), handlers, "gmail-room-digest", ["agent_run", "authorization_request_reconcile"], 0);
    let phase: "setup" | "digest" | "later" = "setup";
    const seen: { frames: Record<string, any>[]; tools: Record<string, string[]>; drafted?: { status: number; body: Record<string, any> };
      pages: { status: number; body: Record<string, any> }[]; remember?: { status: number; body: Record<string, any> }; task?: { status: number; body: Record<string, any> } } = { frames: [], tools: {}, pages: [] };
    const DIGEST_REPLY = "Two new mails today: the admissions interview and the visa appointment.";
    host = new SyntheticAcpHost(sharedHostConnectionRegistry, hostId, async (prompt: SyntheticAcpPrompt): Promise<SyntheticAcpAnswer> => {
      const frame = host!.launchFrames.get(prompt.runId) as Record<string, any>;
      seen.frames.push(frame);
      const tools = await app!.inject({ method: "GET", url: `/api/v1/runs/${prompt.runId}/tools`, headers: { authorization: `Bearer ${frame.work_surface.env.RAINVER_TOOL_TOKEN}` } });
      seen.tools[phase] = (tools.json().tools as Array<{ name: string }>).map((tool) => tool.name);
      if (phase === "setup") {
        seen.drafted = await runTool(frame, "source.gmail.digest.propose", { kind: "daily", local_time: "08:00", time_zone: "Europe/London" });
        return { text: "Please confirm the digest on the card." };
      }
      if (phase === "digest") {
        let page = await runTool(frame, "source.gmail.digest.read");
        seen.pages.push(page);
        while (page.status === 200 && page.body.data.more_in_window) {
          page = await runTool(frame, "source.gmail.digest.read", { page_token: page.body.data.next_page_token });
          seen.pages.push(page);
        }
        return { text: DIGEST_REPLY };
      }
      // A later ordinary turn of the same conversation, whose history now holds the digest.
      seen.remember = await runTool(frame, "memory.remember", { content: "The owner has a visa appointment.", memory_type: "semantic", rationale: "Useful later." });
      seen.task = await runTool(frame, "task.create", { title: "Prepare the visa appointment" });
      return { text: "Noted here." };
    }, ACP_CONFIG_OPTIONS).connect();
    const execute = async (runId: string) => {
      for (let job = 0; job < 8; job += 1) {
        const state = (await db.pool.query("SELECT status FROM runs WHERE id=$1", [runId])).rows[0];
        if (["succeeded", "degraded", "failed", "cancelled", "orphaned"].includes(state.status)) break;
        if (!await worker.processOne()) break;
      }
      return (await db.pool.query(`SELECT * FROM runs WHERE id=$1`, [runId])).rows[0];
    };
    const sessionsBefore = (await db.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n;

    // 1. The owner asks in the mainline; the Agent drafts the digest in that turn.
    const asked = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: "Summarize my inbox here every morning at 8." });
    const setup = await execute(asked.run_ids[0]!);
    expect(setup.status, JSON.stringify(setup.error_json)).toBe("succeeded");
    expect(seen.tools.setup).toContain("source.gmail.digest.propose");
    expect(seen.drafted!.status, JSON.stringify(seen.drafted!.body)).toBe(200);
    const proposalId = String(seen.drafted!.body.data?.proposal_id ?? seen.drafted!.body.proposal_id);
    const proposal = (await db.pool.query(`SELECT status,visibility,owner_user_id,payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0];
    expect(proposal).toMatchObject({ status: "pending", visibility: "private", owner_user_id: owner,
      payload_json: { session_id: conversationId, project_id: project, shared_conversation: true } });

    // 2. Only the mailbox owner decides the card; the peer and the Space owner cannot.
    const accept = () => app!.inject({ method: "POST", url: `/api/v1/proposals/${proposalId}/accept`, headers: { "idempotency-key": randomUUID() }, payload: {} });
    for (const other of [peer, spaceOwner]) { as(other); expect((await accept()).statusCode).toBe(404); }
    as(owner);
    const accepted = await accept();
    expect(accepted.statusCode, accepted.body).toBe(200);
    const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
    expect(digest).toMatchObject({ status: "active", session_id: conversationId, project_id: project, kind: "daily" });

    // 3. Due now: the Sources scheduler starts one Room turn in that same conversation, no new conversation.
    const covered = new Date(Date.now() - 3600_000);
    await db.pool.query(`UPDATE gmail_digests SET covered_until=$2,next_run_at=now() WHERE id=$1`, [digest.id, covered]);
    const fresh = [{ id: "2c01", at: Date.now() - 1800_000, subject: "Admissions interview", text: `${BODY} interview Tuesday` },
      { id: "2c02", at: Date.now() - 900_000, subject: "Visa appointment", text: `${BODY} visa appointment` }];
    mailbox.push(...fresh);
    try {
      phase = "digest";
      expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
      const delivery = (await db.pool.query(`SELECT * FROM gmail_digest_deliveries WHERE digest_id=$1`, [digest.id])).rows[0];
      const queued = (await db.pool.query(`SELECT trigger_origin,session_id,visibility,project_id,permission_snapshot_json FROM runs WHERE id=$1`, [delivery.run_id])).rows[0];
      expect(queued).toMatchObject({ trigger_origin: "automation", session_id: conversationId, visibility: "selected_users", project_id: project });
      const done = await execute(delivery.run_id);
      expect(["succeeded", "degraded"], JSON.stringify({ error: done.error_json, pages: seen.pages })).toContain(done.status);
      // Only the digest read, on the conversation's own runtime: no model channel, no isolated launch.
      expect(seen.tools.digest).toEqual(["source.gmail.digest.read"]);
      const digestFrame = seen.frames.at(-1)!;
      expect(digestFrame.model_channel).toBeUndefined();
      expect(digestFrame.isolation?.egress_profile).not.toBe("none");
      expect(seen.pages.every((page) => page.status === 200), JSON.stringify(seen.pages)).toBe(true);
      expect(seen.pages.flatMap((page) => (page.body.data.items as { id: string }[]).map((item) => item.id)).sort()).toEqual(["2c01", "2c02"]);
      // Settled into the Room: one Room message of this conversation, for its audience; the delivery advanced coverage.
      expect((await db.pool.query(`SELECT status,read_complete,message_count FROM gmail_digest_deliveries WHERE id=$1`, [delivery.id])).rows[0])
        .toEqual({ status: "delivered", read_complete: true, message_count: 2 });
      expect((await db.pool.query(`SELECT content,session_id,sender_agent_id FROM messages WHERE run_id=$1 AND role='assistant'`, [delivery.run_id])).rows)
        .toEqual([{ content: DIGEST_REPLY, session_id: conversationId, sender_agent_id: agent }]);
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n).toBe(sessionsBefore);
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events WHERE run_id=$1 AND project_id=$2 AND operation='digest_read'`, [delivery.run_id, project])).rows[0].n)
        .toBe(seen.pages.length);
      expect(JSON.stringify(seen.frames)).not.toMatch(/ya29\.|1\/\/r-/);

      // 4. A later ordinary turn keeps the runtime but inherits the mail's Project constraint: nothing leaves it.
      phase = "later";
      const later = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, conversationId, { content: "Make a task for the visa." });
      const laterRun = await execute(later.run_ids[0]!);
      expect(["succeeded", "degraded"]).toContain(laterRun.status);
      expect(laterRun.permission_snapshot_json.sensitive_conversation).toBeUndefined();
      expect(laterRun.context_taint_json.plugin_reads).toEqual(expect.arrayContaining([{ plugin_id: "core:gmail_digest", data_class: "sensitive", owner_user_id: owner }]));
      expect(seen.frames.at(-1)!.model_channel).toBeUndefined();
      expect(seen.remember!.body, JSON.stringify(seen.remember!.body)).toMatchObject({ ok: false });
      expect(JSON.stringify(seen.remember!.body)).toContain("stays in this Project's conversations");
      expect(seen.task!.body, JSON.stringify(seen.task!.body)).toMatchObject({ ok: false });
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id=$1 AND title='Prepare the visa appointment'`, [project])).rows[0].n).toBe(0);
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM memory_entries WHERE content LIKE '%visa appointment%'`)).rows[0].n).toBe(0);
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM proposals WHERE created_by_run_id=$1`, [later.run_ids[0]])).rows[0].n).toBe(0);

      // 5. The owner ends the digest: the next due slot starts nothing and reads nothing.
      as(owner);
      expect((await userCall("source.gmail.digest.end", { digest_id: digest.id })).statusCode).toBe(200);
      await db.pool.query(`UPDATE gmail_digests SET next_run_at=now() WHERE id=$1`, [digest.id]);
      google.calls = [];
      expect(await startDueGmailDigests(db.pool, config, 20)).toBe(0);
      expect(mailGets()).toEqual([]);
    } finally {
      mailbox.splice(mailbox.length - fresh.length, fresh.length);
    }
  });
});

describe("Room and mainline Gmail digests: one audience rule from start to settlement, Work Context, the 0040 upgrade, and where a digest is confirmed again", () => {
  const DIGEST_REPLY = "Two new mails: the admissions interview and the visa appointment.";
  const ENDED = ["succeeded", "degraded", "failed", "cancelled", "orphaned"];
  const DAILY = { kind: "daily", local_time: "08:00", time_zone: "Europe/London" };
  type Call = { status: number; body: Record<string, any> };
  type Script = { mode: "propose"; input: Record<string, unknown> } | { mode: "digest" } | { mode: "ask_mail" };
  const fresh: Msg[] = [];
  beforeEach(() => {
    fresh.splice(0, fresh.length, { id: "2d01", at: Date.now() - 1800_000, subject: "Admissions interview", text: `${BODY} interview Tuesday` },
      { id: "2d02", at: Date.now() - 900_000, subject: "Visa appointment", text: `${BODY} visa appointment` });
    mailbox.push(...fresh);
  });
  afterEach(() => { mailbox.splice(mailbox.length - fresh.length, fresh.length); });

  /** A Room conversation, the production queue worker and the synthetic Host answering each turn by `state.script`. */
  async function digestRoom(options: { room?: "mainline" | "limited" } = {}) {
    const connectionId = await connectGmail();
    const { room, conversationId } = await roomConversation(options);
    const handlers = new JobHandlerRegistry();
    registerAgentRunHandler(handlers, config);
    const worker = new JobWorker(new PgJobQueueRepository(db.pool), handlers, "gmail-room-digest-audience", ["agent_run", "authorization_request_reconcile"], 0);
    const state = { script: { mode: "digest" } as Script, launched: [] as string[], tools: [] as string[][], drafted: [] as Call[], pages: [] as Call[] };
    host = new SyntheticAcpHost(sharedHostConnectionRegistry, hostId, async (prompt: SyntheticAcpPrompt): Promise<SyntheticAcpAnswer> => {
      const frame = host!.launchFrames.get(prompt.runId) as Record<string, any>;
      state.launched.push(prompt.runId);
      const tools = await app!.inject({ method: "GET", url: `/api/v1/runs/${prompt.runId}/tools`, headers: { authorization: `Bearer ${frame.work_surface.env.RAINVER_TOOL_TOKEN}` } });
      state.tools.push((tools.json().tools as Array<{ name: string }>).map((tool) => tool.name));
      const script = state.script;
      if (script.mode === "propose") {
        state.drafted.push(await runTool(frame, "source.gmail.digest.propose", script.input));
        return { text: "Please confirm the digest on the card." };
      }
      if (script.mode === "ask_mail") {
        const first = await runTool(frame, READ_TOOL);
        if (first.status === 403) await runTool(frame, "authorization.request", { policy_decision_record_id: first.body.policy_decision_record_id, reason: "Read your latest mail" });
        return { text: "Waiting for your Gmail confirmation." };
      }
      let page = await runTool(frame, "source.gmail.digest.read");
      state.pages.push(page);
      while (page.status === 200 && page.body.data.more_in_window) {
        page = await runTool(frame, "source.gmail.digest.read", { page_token: page.body.data.next_page_token });
        state.pages.push(page);
      }
      return { text: page.status === 200 ? DIGEST_REPLY : "The digest could not be produced." };
    }, ACP_CONFIG_OPTIONS).connect();
    const execute = async (runId: string, until: readonly string[] = ENDED) => {
      for (let job = 0; job < 8; job += 1) {
        const current = (await db.pool.query("SELECT status FROM runs WHERE id=$1", [runId])).rows[0];
        if (until.includes(current.status)) break;
        if (!await worker.processOne()) break;
      }
      return (await db.pool.query(`SELECT * FROM runs WHERE id=$1`, [runId])).rows[0];
    };
    /** The owner's own turn in a conversation of this Room asks the Agent to set the digest up; the tool's answer. */
    const draft = async (sessionId: string, input: Record<string, unknown>): Promise<Call> => {
      state.script = { mode: "propose", input };
      const sent = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, room, sessionId, { content: "Summarize my inbox here every morning at 8." });
      const drafting = await execute(sent.run_ids[0]!);
      expect(["succeeded", "degraded"], JSON.stringify({ error: drafting.error_json, drafted: state.drafted.at(-1) })).toContain(drafting.status);
      state.script = { mode: "digest" };
      return state.drafted.at(-1)!;
    };
    const accept = (proposalId: string) => {
      as(owner);
      return app!.inject({ method: "POST", url: `/api/v1/proposals/${proposalId}/accept`, headers: { "idempotency-key": randomUUID() }, payload: {} });
    };
    /** Drafted in the owner's turn and accepted by them on the card: the digest row (also when confirmed again in place). */
    const confirm = async (sessionId: string, input: Record<string, unknown>) => {
      const drafted = await draft(sessionId, input);
      expect(drafted.status, JSON.stringify({ body: drafted.body, tools: state.tools.at(-1) })).toBe(200);
      const proposalId = String(drafted.body.data?.proposal_id ?? drafted.body.proposal_id);
      const accepted = await accept(proposalId);
      expect(accepted.statusCode, JSON.stringify({ accepted: accepted.body, drafted: drafted.body })).toBe(200);
      return (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
    };
    const due = (digestId: string) => db.pool.query(`UPDATE gmail_digests SET covered_until=now()-interval '1 hour',next_run_at=now(),retry_not_before=NULL WHERE id=$1`, [digestId]);
    const latestDelivery = async (digestId: string) => (await db.pool.query(`SELECT * FROM gmail_digest_deliveries WHERE digest_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [digestId])).rows[0];
    const digestRow = async (digestId: string) => (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [digestId])).rows[0];
    const replies = async (runId: string) => (await db.pool.query(`SELECT content,session_id FROM messages WHERE run_id=$1 AND role='assistant'`, [runId])).rows;
    const readIds = () => state.pages.filter((page) => page.status === 200).flatMap((page) => (page.body.data.items as { id: string }[]).map((item) => item.id)).sort();
    return { connectionId, room, conversationId, worker, state, execute, draft, accept, confirm, due, latestDelivery, digestRow, replies, readIds };
  }
  const projectMember = {
    remove: (user: string) => db.pool.query(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [project, user]),
    restore: (user: string) => db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), space, project, user]),
  };

  it.each(["mainline", "limited"] as const)("in a %s Room the daily and the monitor-hit digest each run as one scheduled turn of that conversation and reply there", async (kind) => {
    const h = await digestRoom({ room: kind });
    const sessionsBefore = (await db.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n;
    // Both set up first: once a digest is delivered, later turns of the conversation carry its mail and draft nothing.
    const daily = await h.confirm(h.conversationId, DAILY);
    expect(daily).toMatchObject({ status: "active", kind: "daily", session_id: h.conversationId });
    const rule = await h.confirm(h.conversationId, { kind: "rule" });
    expect(rule).toMatchObject({ status: "active", kind: "rule", session_id: h.conversationId });
    // Daily: the whole frozen window, read on the conversation's own runtime, delivered as the Room's message.
    await h.due(daily.id);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const dailyDelivery = await h.latestDelivery(daily.id);
    expect((await db.pool.query(`SELECT trigger_origin,visibility FROM runs WHERE id=$1`, [dailyDelivery.run_id])).rows[0]).toEqual({ trigger_origin: "automation", visibility: "selected_users" });
    expect(ENDED.slice(0, 2)).toContain((await h.execute(dailyDelivery.run_id)).status);
    expect(h.state.tools.at(-1)).toEqual(["source.gmail.digest.read"]);
    expect(h.readIds()).toEqual(["2d01", "2d02"]);
    expect((await h.latestDelivery(daily.id))).toMatchObject({ status: "delivered", read_complete: true, message_count: 2 });
    expect(await h.replies(dailyDelivery.run_id)).toEqual([{ content: DIGEST_REPLY, session_id: h.conversationId }]);

    // Monitor hits: only the frozen matched id is read, once; the next pass has nothing new.
    const monitorRule = randomUUID();
    await db.pool.query(`INSERT INTO gmail_monitor_rules (id,space_id,owner_user_id,gmail_connection_id,project_id,purpose,criteria,status,active_since,proposal_id,match_count,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'Admissions','{}'::jsonb,'active',now(),NULL,1,now(),now())`, [monitorRule, space, owner, h.connectionId, project]);
    await db.pool.query(`INSERT INTO gmail_monitor_matches (rule_id,google_message_id,space_id,owner_user_id,matched_at) VALUES ($1,'2d01',$2,$3,clock_timestamp())`, [monitorRule, space, owner]);
    h.state.pages = [];
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const ruleDelivery = await h.latestDelivery(rule.id);
    expect(ruleDelivery.message_ids).toEqual(["2d01"]);
    expect(ENDED.slice(0, 2)).toContain((await h.execute(ruleDelivery.run_id)).status);
    expect(h.readIds()).toEqual(["2d01"]);
    expect(await h.latestDelivery(rule.id)).toMatchObject({ status: "delivered", read_complete: true, message_count: 1 });
    expect(await h.replies(ruleDelivery.run_id)).toEqual([{ content: DIGEST_REPLY, session_id: h.conversationId }]);
    expect((await db.pool.query(`SELECT google_message_id FROM gmail_digest_items WHERE digest_id=$1`, [rule.id])).rows).toEqual([{ google_message_id: "2d01" }]);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(0);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n).toBe(sessionsBefore);
  });

  it("counts a member removed from the Project who stays on the Room roster: nothing starts, a queued delivery is refused at its claim, a read stops before its next Gmail send, and each settles with no reply and its window kept", async () => {
    const h = await digestRoom({ room: "limited" });
    const digest = await h.confirm(h.conversationId, DAILY);

    // 1. At start: the peer no longer works in the Project but is still on the Room's roster.
    await projectMember.remove(peer);
    await h.due(digest.id);
    google.calls = [];
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(0);
    expect(await h.digestRow(digest.id)).toMatchObject({ status: "active", last_error_code: "gmail_digest_audience_outside_project" });
    expect(await h.latestDelivery(digest.id)).toBeUndefined();
    expect(mailGets()).toEqual([]);
    as(owner);
    const listed = (await app!.inject({ method: "GET", url: "/api/v1/sources/gmail/digests" })).json().digests.find((row: { id: string }) => row.id === digest.id);
    expect(listed).toMatchObject({ status: "active", room_id: h.room, last_error_code: "gmail_digest_audience_outside_project" });

    // 2. At the claim: the delivery was queued while everyone worked in the Project; the peer leaves before it starts.
    await projectMember.restore(peer);
    await db.pool.query(`UPDATE gmail_digests SET retry_not_before=NULL WHERE id=$1`, [digest.id]);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const queued = await h.latestDelivery(digest.id);
    await projectMember.remove(peer);
    const refused = await h.execute(queued.run_id);
    expect(refused).toMatchObject({ status: "failed", started_at: null });
    expect(h.state.launched).not.toContain(queued.run_id);
    expect(mailGets()).toEqual([]);
    expect(await h.latestDelivery(digest.id)).toMatchObject({ id: queued.id, status: "failed", error_code: "gmail_digest_audience_outside_project" });
    const afterClaim = await h.digestRow(digest.id);
    expect(afterClaim).toMatchObject({ status: "active", last_error_code: "gmail_digest_audience_outside_project", failure_count: 2 });
    expect(afterClaim.retry_not_before).not.toBeNull();
    expect(await h.replies(queued.run_id)).toEqual([]);

    // 3. Before a send: the retry restarts the same frozen window; the peer leaves after the first message is fetched.
    await projectMember.restore(peer);
    await db.pool.query(`UPDATE gmail_digests SET retry_not_before=NULL WHERE id=$1`, [digest.id]);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const retried = await h.latestDelivery(digest.id);
    expect([retried.window_start, retried.window_end]).toEqual([queued.window_start, queued.window_end]);
    google.calls = [];
    google.onMessageGet = async () => { await projectMember.remove(peer); };
    h.state.pages = [];
    await h.execute(retried.run_id);
    expect(h.state.pages[0]!.status, JSON.stringify(h.state.pages)).toBe(409);
    expect(JSON.stringify(h.state.pages[0]!.body)).toContain("gmail_digest_audience_outside_project");
    expect(google.calls.filter((url) => /\/messages\/[0-9a-f]+\?/.test(url))).toHaveLength(1);
    expect(await h.latestDelivery(digest.id)).toMatchObject({ id: retried.id, status: "failed", read_complete: false, error_code: "gmail_digest_audience_outside_project" });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events WHERE run_id=$1`, [retried.run_id])).rows[0].n).toBe(0);
    expect(await h.replies(retried.run_id)).toEqual([]);
    const afterSend = await h.digestRow(digest.id);
    expect(afterSend).toMatchObject({ status: "active", last_error_code: "gmail_digest_audience_outside_project", failure_count: 3 });
    expect(new Date(afterSend.covered_until).getTime()).toBe(new Date(afterClaim.covered_until).getTime());
  });

  it("follows ordinary Room roster removal: a member removed from the Room and the Project no longer counts, and an owner removed from the Room is never added back as one of its readers", async () => {
    const h = await digestRoom({ room: "limited" });
    const digest = await h.confirm(h.conversationId, DAILY);
    const roster = (user: string, status: "active" | "removed") =>
      db.pool.query(`UPDATE room_user_members SET status=$3,updated_at=now() WHERE room_id=$1 AND user_id=$2`, [h.room, user, status]);

    // The peer leaves the Room and the Project the ordinary way: the digest still runs and replies in its conversation.
    await roster(peer, "removed");
    await projectMember.remove(peer);
    await h.due(digest.id);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const delivered = await h.latestDelivery(digest.id);
    expect(ENDED.slice(0, 2)).toContain((await h.execute(delivered.run_id)).status);
    expect(await h.latestDelivery(digest.id)).toMatchObject({ id: delivered.id, status: "delivered", read_complete: true, message_count: 2 });
    expect(await h.replies(delivered.run_id)).toEqual([{ content: DIGEST_REPLY, session_id: h.conversationId }]);

    // The owner leaves the Room but still reads the Project: they no longer read the conversation, so nothing starts.
    await roster(owner, "removed");
    await h.due(digest.id);
    google.calls = [];
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(0);
    expect(await h.latestDelivery(digest.id)).toMatchObject({ id: delivered.id });
    expect(await h.digestRow(digest.id)).toMatchObject({ status: "active", last_error_code: "gmail_digest_audience_outside_project" });
    expect(mailGets()).toEqual([]);

    // A delivery queued while they were on the roster is refused at its claim once they leave it.
    await roster(owner, "active");
    await db.pool.query(`UPDATE gmail_digests SET retry_not_before=NULL WHERE id=$1`, [digest.id]);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const queued = await h.latestDelivery(digest.id);
    await roster(owner, "removed");
    expect(await h.execute(queued.run_id)).toMatchObject({ status: "failed", started_at: null });
    expect(h.state.launched).not.toContain(queued.run_id);
    expect(await h.latestDelivery(digest.id)).toMatchObject({ id: queued.id, status: "failed", error_code: "gmail_digest_audience_outside_project" });
    expect(await h.replies(queued.run_id)).toEqual([]);
    expect(mailGets()).toEqual([]);
  });

  it("stops an active daily and monitor-hit digest when the owner revokes its consent from their consent list: the scheduler reads nothing and ends each", async () => {
    const h = await digestRoom({ room: "limited" });
    const daily = await h.confirm(h.conversationId, DAILY);
    const rule = await h.confirm(h.conversationId, { kind: "rule" });
    await revokeAsOwner(daily.grant_id, "daily_digest");
    await revokeAsOwner(rule.grant_id, "rule_digest");
    // Each would be due now: the daily window has elapsed and a monitor hit waits for the rule digest.
    await h.due(daily.id);
    const monitorRule = randomUUID();
    await db.pool.query(`INSERT INTO gmail_monitor_rules (id,space_id,owner_user_id,gmail_connection_id,project_id,purpose,criteria,status,active_since,proposal_id,match_count,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'Admissions','{}'::jsonb,'active',now(),NULL,1,now(),now())`, [monitorRule, space, owner, h.connectionId, project]);
    await db.pool.query(`INSERT INTO gmail_monitor_matches (rule_id,google_message_id,space_id,owner_user_id,matched_at) VALUES ($1,'2d01',$2,$3,clock_timestamp())`, [monitorRule, space, owner]);
    // Revoking the consent leaves both rows active: only the scheduler's own pass (each digest is due) ends them.
    for (const d of [daily, rule]) expect(await h.digestRow(d.id)).toMatchObject({ status: "active", ended_at: null, last_error_code: null });
    google.calls = [];
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(0);
    for (const d of [daily, rule]) {
      expect(await h.latestDelivery(d.id)).toBeUndefined();
      // Persisted, not only shown: each digest row is ended with the consent code.
      expect(await h.digestRow(d.id)).toMatchObject({ status: "ended", ended_at: expect.any(Date), next_run_at: null, last_error_code: "gmail_digest_consent_ended" });
    }
    expect(mailGets()).toEqual([]);
    // An ended digest is no longer due: a later pass starts nothing.
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(0);
    as(owner);
    const listed = (await app!.inject({ method: "GET", url: "/api/v1/sources/gmail/digests" })).json().digests as { id: string }[];
    for (const d of [daily, rule]) expect(listed.find((x) => x.id === d.id)).toMatchObject({ status: "ended", last_error_code: "gmail_digest_consent_ended" });
    // Revoking again answers with the same revoked consent and changes nothing.
    await revokeAsOwner(daily.grant_id, "daily_digest");
  });

  it("lets a new card replace an ordinarily paused digest whose consent was revoked, while only a digest awaiting re-confirmation is kept", async () => {
    const h = await digestRoom({ room: "limited" });
    const digest = await h.confirm(h.conversationId, DAILY);
    as(owner);
    const paused = await userCall("source.gmail.digest.set_status", { digest_id: digest.id, status: "paused" });
    expect(paused.statusCode, paused.body).toBe(200);
    // The owner revokes its consent from their consent list; the paused digest row is left as is and reads as ended.
    await revokeAsOwner(digest.grant_id, "daily_digest");
    expect(await h.digestRow(digest.id)).toMatchObject({ status: "paused", last_error_code: null });
    expect(((await app!.inject({ method: "GET", url: "/api/v1/sources/gmail/digests" })).json().digests as { id: string }[]).find((d) => d.id === digest.id))
      .toMatchObject({ status: "ended", next_run_at: null, last_error_code: "gmail_digest_consent_ended" });

    // The owner sets the digest up again: the old one ends (its history stays) and the new one delivers.
    const next = await h.confirm(h.conversationId, DAILY);
    expect(next.id).not.toBe(digest.id);
    expect(next).toMatchObject({ status: "active", session_id: h.conversationId });
    expect(await h.digestRow(digest.id)).toMatchObject({ status: "ended" });
    await h.due(next.id);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const delivery = await h.latestDelivery(next.id);
    expect(ENDED.slice(0, 2)).toContain((await h.execute(delivery.run_id)).status);
    expect(await h.replies(delivery.run_id)).toEqual([{ content: DIGEST_REPLY, session_id: h.conversationId }]);

    // A digest awaiting re-confirmation (0040) in another conversation is still not ended by a card from here.
    const second = await roomConversation({ room: h.room });
    await db.pool.query(`UPDATE gmail_digests SET status='paused',next_run_at=NULL,last_error_code='gmail_digest_reconfirm_required',session_id=$2 WHERE id=$1`,
      [next.id, second.conversationId]);
    await revokeAsOwner(next.grant_id, "daily_digest");
    const foreignCard = randomUUID();
    await db.pool.query(`INSERT INTO proposals SELECT (jsonb_populate_record(NULL::proposals, to_jsonb(p) || jsonb_build_object('id',$2::text,'status','pending',
        'action_idempotency_key',NULL))).* FROM proposals p WHERE p.id=$1`, [next.proposal_id, foreignCard]);
    expect((await h.accept(foreignCard)).statusCode).toBe(409);
    expect(await h.digestRow(next.id)).toMatchObject({ status: "paused", last_error_code: "gmail_digest_reconfirm_required", session_id: second.conversationId });
  });

  it("keeps only the digest read when a queued Room digest Run is bound to its Work Context, and still delivers the window there", async () => {
    const h = await digestRoom({ room: "limited" });
    const digest = await h.confirm(h.conversationId, DAILY);
    await h.due(digest.id);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const delivery = await h.latestDelivery(digest.id);
    const before = (await db.pool.query(`SELECT project_folder_id,runtime_profile_id FROM runs WHERE id=$1`, [delivery.run_id])).rows[0];
    const rebound = await new PgRunRepository(db.pool, config).bindRunToWorkContext({
      run_id: delivery.run_id, space_id: space, project_id: project, project_folder_id: before.project_folder_id, agent_id: agent, runtime_profile_id: before.runtime_profile_id,
    });
    expect(rebound).not.toBeNull();
    const snapshot = (await db.pool.query(`SELECT permission_snapshot_json FROM runs WHERE id=$1`, [delivery.run_id])).rows[0].permission_snapshot_json;
    expect((snapshot.tool_grants as { action_id: string }[]).map((grant) => grant.action_id)).toEqual(["source.gmail.digest.read"]);
    expect(ENDED.slice(0, 2)).toContain((await h.execute(delivery.run_id)).status);
    expect(h.state.tools.at(-1)).toEqual(["source.gmail.digest.read"]);
    expect(await h.latestDelivery(digest.id)).toMatchObject({ status: "delivered", message_count: 2 });
    expect(await h.replies(delivery.run_id)).toEqual([{ content: DIGEST_REPLY, session_id: h.conversationId }]);
  });

  it("upgrade (0040) in a Room: a pending consent card expires and its Run ends, an in-flight delivery fails unsent, and the paused digest is confirmed again only in its own conversation, in place with its history", async () => {
    const h = await digestRoom({ room: "limited" });
    const digest = await h.confirm(h.conversationId, DAILY);
    // A pending in-conversation consent card, in a second conversation of the same Room.
    const second = await roomConversation({ room: h.room });
    h.state.script = { mode: "ask_mail" };
    const asked = await new RoomService(config, db.pool).sendMessage({ spaceId: space, userId: owner }, h.room, second.conversationId, { content: REQUEST });
    const askRun = asked.run_ids[0]!;
    expect((await h.execute(askRun, ["waiting_for_review", ...ENDED])).status).toBe("waiting_for_review");
    const [card] = await new AuthorizationRequestService(db.pool, config).listForRun({ spaceId: space, userId: owner }, askRun);
    expect(card).toMatchObject({ status: "pending" });
    h.state.script = { mode: "digest" };
    // An in-flight delivery, queued and not yet claimed.
    await h.due(digest.id);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const inFlight = await h.latestDelivery(digest.id);
    google.calls = [];

    const statements = readFileSync(join(import.meta.dirname, "./fixtures/preSquash/0040_gmail_project_scope_reconfirm.sql"), "utf8")
      .split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
    for (const statement of statements) await db.pool.query(statement);

    expect((await db.pool.query(`SELECT status FROM authorization_requests WHERE id=$1`, [card!.id])).rows[0].status).toBe("expired");
    expect(await h.latestDelivery(digest.id)).toMatchObject({ id: inFlight.id, status: "failed", error_code: "gmail_digest_unavailable" });
    expect(await h.digestRow(digest.id)).toMatchObject({ status: "paused", last_error_code: "gmail_digest_reconfirm_required", session_id: h.conversationId });
    // The reconcile job ends the waiting Run; the in-flight Run is refused at its claim. Neither reads or replies.
    for (let job = 0; job < 12 && await h.worker.processOne(); job += 1) { /* the queued jobs: the reconcile and the in-flight claim */ }
    expect(["cancelled", "failed"]).toContain((await db.pool.query(`SELECT status FROM runs WHERE id=$1`, [askRun])).rows[0].status);
    expect((await db.pool.query(`SELECT status,started_at FROM runs WHERE id=$1`, [inFlight.run_id])).rows[0]).toEqual({ status: "failed", started_at: null });
    expect(h.state.launched).not.toContain(inFlight.run_id);
    expect(mailGets()).toEqual([]);
    expect(await h.replies(inFlight.run_id)).toEqual([]);
    expect(await h.digestRow(digest.id)).toMatchObject({ status: "paused", last_error_code: "gmail_digest_reconfirm_required" });

    // Another conversation of the Project cannot take it over: drafting there is refused, and a card from there conflicts
    // without ending the paused digest or its history.
    const elsewhere = await h.draft(second.conversationId, DAILY);
    expect(JSON.stringify(elsewhere.body)).toContain("gmail_digest_reconfirm_elsewhere");
    const original = (await db.pool.query(`SELECT id FROM proposals WHERE id=$1`, [digest.proposal_id])).rows[0].id;
    const foreignCard = randomUUID();
    await db.pool.query(`INSERT INTO proposals SELECT (jsonb_populate_record(NULL::proposals, to_jsonb(p) || jsonb_build_object('id',$2::text,'status','pending',
        'action_idempotency_key',NULL,'payload_json',jsonb_set(p.payload_json,'{session_id}',to_jsonb($3::text))))).* FROM proposals p WHERE p.id=$1`,
      [original, foreignCard, second.conversationId]);
    expect((await h.accept(foreignCard)).statusCode).toBe(409);
    expect(await h.digestRow(digest.id)).toMatchObject({ status: "paused", last_error_code: "gmail_digest_reconfirm_required", session_id: h.conversationId });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digests WHERE space_id=$1`, [space])).rows[0].n).toBe(1);

    // In its own conversation the owner confirms it again: the same digest resumes with its history and delivers there.
    const again = await h.confirm(h.conversationId, DAILY);
    expect(again).toMatchObject({ id: digest.id, status: "active", last_error_code: null, session_id: h.conversationId });
    expect(again.grant_id).not.toBe(digest.grant_id);
    await h.due(digest.id);
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const resumed = await h.latestDelivery(digest.id);
    expect(ENDED.slice(0, 2)).toContain((await h.execute(resumed.run_id)).status);
    expect(await h.replies(resumed.run_id)).toEqual([{ content: DIGEST_REPLY, session_id: h.conversationId }]);
    expect((await db.pool.query(`SELECT status FROM gmail_digest_deliveries WHERE digest_id=$1 ORDER BY created_at`, [digest.id])).rows.map((row) => row.status))
      .toEqual(["failed", "delivered"]);
  });
  it("ADR 0035 §3: a Room digest's confirmed model is applied strictly: when the live session does not offer it the turn reads and delivers nothing, never on the runtime's default", async () => {
    const h = await digestRoom({ room: "limited" });
    // The owner's turn binds the conversation's Agent; then the conversation saves a full model id that the live
    // session (the synthetic Host offers only its default) will not apply, and the owner confirms a card naming it.
    await h.draft(h.conversationId, DAILY);
    const confirmedModel = "claude-opus-5-5";
    await db.pool.query(`UPDATE session_conversation_backends SET session_config_json=$2::jsonb WHERE session_id=$1`,
      [h.conversationId, JSON.stringify([{ id: "model", type: "select", value: confirmedModel, category: "model" }])]);
    const ownerTurn = (await db.pool.query(`SELECT id FROM runs WHERE session_id=$1 AND instructed_by_user_id=$2 ORDER BY created_at DESC LIMIT 1`, [h.conversationId, owner])).rows[0].id;
    const drafted = await proposeGmailDigest(db.pool, ownerTurn, space, DAILY as never, randomUUID());
    expect(drafted.modelResult, JSON.stringify(drafted)).toMatchObject({ ok: true });
    const proposalId = String((drafted.modelResult as { proposal_id: string }).proposal_id);
    expect((await h.accept(proposalId)).statusCode).toBe(200);
    const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
    expect(digest.runtime_binding).toMatchObject({ pinned_model: confirmedModel, session_config: [{ id: "model", value: confirmedModel }] });
    await h.due(digest.id);
    h.state.pages = [];
    expect(await startDueGmailDigests(db.pool, config, 20)).toBe(1);
    const delivery = await h.latestDelivery(digest.id);
    // Queued strictly (never a saved, droppable selection), so the live session cannot quietly keep its default.
    const queued = (await db.pool.query(`SELECT model_override_json FROM runs WHERE id=$1`, [delivery.run_id])).rows[0].model_override_json;
    expect(queued).toMatchObject({ acp_session_config: [{ id: "model", value: confirmedModel }] });
    expect(queued.acp_session_config_source).not.toBe("saved");
    await h.execute(delivery.run_id);
    expect(h.state.pages.filter((page) => page.status === 200)).toEqual([]);
    expect(await h.replies(delivery.run_id)).toEqual([]);
    expect((await h.latestDelivery(digest.id)).status).toBe("failed");
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events WHERE operation='digest_read'`)).rows[0].n).toBe(0);
  });
});
