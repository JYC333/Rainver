import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRun, seedServerHost, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { publicAddressGuard } from "./support/outboundGuard.js";
import { sourcesModule } from "../src/modules/sources/index.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { proposalsModule } from "../src/modules/proposals/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { __setGmailOAuthGuardForTests } from "../src/modules/sources/gmail/gmailOAuthTransport.js";
import { __setGmailProfileGuardForTests } from "../src/modules/sources/gmail/gmailOAuthFlow.js";
import { __setGmailReadGuardForTests } from "../src/modules/sources/gmail/gmailMailReads.js";
import { PgProjectAgentRepository } from "../src/modules/projects/projectAgents.js";
import { loadSystemActionRegistry } from "../src/modules/systemActions/registry.js";
import { POLICY_ACTION_REGISTRY } from "@rainver/protocol";
import { buildRunToolGrants } from "../src/modules/systemActions/runToolGrants.js";
import { CONVERSATION_TOOL_ALLOWANCE, ROOM_CONVERSATION_TOOL_ALLOWANCE } from "../src/modules/systemActions/scenarioToolAllowance.js";
import { actionPreviewsForViewer, loadProjectChatActionPreviews, sharedActionPreviews } from "../src/modules/agents/projectChatActionPreviews.js";
import { createPrivateToolCallFilter } from "../src/modules/runtimeAdapters/privateToolCalls.js";
import type { RunScenario } from "../src/modules/plugins/dataAccess.js";

// ADR 0033 §6 on real PostgreSQL: the earlier hand-off that carried a request from a shared conversation into
// a new private conversation is withdrawn. No conversation offers its tool, a card it left is history only
// (owner-only, never decided, never executed), and nothing starts or links a new conversation. Google is
// stubbed only for the OAuth connect (token + profile); no real mailbox, Google project or deployment is involved.
const db = useTestDatabase(import.meta.filename);
const CLIENT_ID = "gmail-client.apps.googleusercontent.com";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const TOOL = "source.gmail.private_read.request";
const REQUEST = "Did the builder send the revised kitchen quote this week?";
let config: ServerConfig, app: ReturnType<typeof buildModuleServer>;
let space: string, spaceOwner: string, owner: string, peer: string, project: string, agent: string, agentVersion: string, hostId: string;
const google = { calls: [] as string[], sub: "5005", email: "owner@gmail.example" };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const idToken = (sub: string) => `e30.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;

beforeEach(async () => {
  await resetTables(db.pool, ["spaces", "users", "credentials", "source_request_quota_state"], { cascade: true });
  space = randomUUID(); spaceOwner = randomUUID(); owner = randomUUID(); peer = randomUUID(); project = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner: spaceOwner, project, spaceType: "team" });
  for (const user of [owner, peer]) {
    await seedSpaceMember(db.pool, { space, user });
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, user]);
  }
  await db.pool.query(`UPDATE spaces SET oversight_mode='full' WHERE id=$1`, [space]);
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: mkdtempSync(join(tmpdir(), "rainver-gmail-handoff-")),
    GMAIL_OAUTH_CLIENT_ID: CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret-fixture",
    GMAIL_OAUTH_REDIRECT_URI: "http://localhost:3000/api/v1/sources/gmail/oauth/callback",
  });
  app = buildModuleServer(config, [sourcesModule, systemActionsModule, proposalsModule]);
  __setGmailOAuthGuardForTests(publicAddressGuard);
  __setGmailProfileGuardForTests(publicAddressGuard);
  __setGmailReadGuardForTests(publicAddressGuard);
  google.calls = []; google.sub = "5005"; google.email = "owner@gmail.example";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const href = String(url);
    google.calls.push(href);
    if (href === "https://oauth2.googleapis.com/token") return json({ access_token: `ya29.${randomUUID()}`, expires_in: 3599, token_type: "Bearer", scope: `openid ${READONLY}`, id_token: idToken(google.sub), refresh_token: `1//r-${randomUUID()}` });
    if (href.endsWith("/profile")) return json({ emailAddress: google.email });
    throw new Error(`unexpected Google request ${href}`);
  });
  // The Room's Agent, on the Project's list, bound to a server Host so a private turn can be admitted.
  const seedRunId = randomUUID();
  agent = randomUUID(); agentVersion = randomUUID();
  await seedRun(db.pool, { id: seedRunId, space, owner, agent, version: agentVersion });
  hostId = randomUUID();
  await seedServerHost(db.pool, { id: hostId, installations: { opencode: [{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, options: null, health_check_protocol: "acp" }] } });
  await db.pool.query(`UPDATE agent_runtime_profiles SET execution_host_id=$2,workspace_mode='managed',runtime_installation='managed:1.0.0' WHERE agent_id=$1 AND is_default`, [agent, hostId]);
  await db.pool.query(`UPDATE agents SET visibility='space_shared' WHERE id=$1`, [agent]);
  await new PgProjectAgentRepository(db.pool).upsertActive({ spaceId: space, projectId: project, agentId: agent, userId: spaceOwner });
});
afterEach(async () => {
  __setAuthIdentityForTests(null); __setGmailOAuthGuardForTests(null); __setGmailProfileGuardForTests(null); __setGmailReadGuardForTests(null);
  vi.restoreAllMocks();
  await app?.close();
});

const as = (userId: string) => __setAuthIdentityForTests({ spaceId: space, userId });
const userCall = (name: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1/actions/${name}`, headers: { "idempotency-key": randomUUID() }, payload });
const accept = (proposalId: string) => app.inject({ method: "POST", url: `/api/v1/proposals/${proposalId}/accept`, headers: { "idempotency-key": randomUUID() }, payload: {} });
async function connect(userId = owner): Promise<string> {
  as(userId);
  const start = await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: {} });
  const state = new URL(start.json().authorize_url).searchParams.get("state")!;
  const res = await app.inject({ method: "GET", url: `/api/v1/sources/gmail/oauth/callback?${new URLSearchParams({ state, code: `4/c-${randomUUID()}` })}` });
  expect(new URL(String(res.headers.location)).searchParams.get("gmail")).toBe("connected");
  const id = (await db.pool.query(`SELECT id FROM gmail_connections WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0].id;
  expect((await userCall("source.gmail.connection.set_agent_read", { connection_id: id, enabled: true })).statusCode).toBe(200);
  google.calls = [];
  return id;
}
/** A conversation of a Room of the Project (or of its mainline) whose roster is the owner and the peer. */
async function roomSession(mainline = false): Promise<string> {
  const existing = mainline ? (await db.pool.query<{ id: string }>(`SELECT id FROM rooms WHERE project_id=$1 AND is_mainline AND status='active'`, [project])).rows[0]?.id : undefined;
  const room = existing ?? randomUUID(), id = randomUUID();
  if (!existing) await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,title,status,is_mainline,created_by_user_id,created_at,updated_at) VALUES ($1,$2,$3,'Room','active',$5,$4,now(),now())`, [room, space, project, owner, mainline]);
  for (const user of [owner, peer]) await db.pool.query(`INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'member','active',now(),now()) ON CONFLICT DO NOTHING`, [randomUUID(), space, room, user]);
  await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,title,created_at,updated_at) VALUES ($1,$2,$3,$4,'active','Room',now(),now())`, [id, space, room, project]);
  return id;
}
async function directSession(projectId: string | null = project): Promise<string> {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO sessions (id,space_id,user_id,project_id,status,title,created_at,updated_at) VALUES ($1,$2,$3,$4,'active','Chat',now(),now())`, [id, space, owner, projectId]);
  return id;
}
/** A finished turn of the owner in `sessionId` that, before the withdrawal, left an owner-only hand-off card. */
async function historicCard(sessionId: string, connectionId: string, status: "pending" | "accepted"): Promise<{ runId: string; cardId: string }> {
  const messageId = randomUUID(), runId = randomUUID(), cardId = randomUUID();
  await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at)
    VALUES ($1,$2,$3,$4,'user',$5,(SELECT count(*) FROM messages WHERE session_id=$3::varchar),'/',now())`, [messageId, space, sessionId, owner, REQUEST]);
  await seedRun(db.pool, { id: runId, space, owner, agent, version: agentVersion, existingAgent: true });
  await db.pool.query(`UPDATE runs SET status='succeeded',instructed_by_user_id=$2,owner_user_id=$2,visibility='space_shared',session_id=$3,project_id=$4 WHERE id=$1`, [runId, owner, sessionId, project]);
  const payload = { proposal_type: "gmail_private_read", action_id: TOOL, connection_id: connectionId, connection_generation: 1, mailbox_email: "owner@gmail.example",
    project_id: project, project_name: "Kitchen", agent_id: agent, source_run_id: runId, source_message_id: messageId, request_text: REQUEST, consent: "confirm" };
  await db.pool.query(`INSERT INTO proposals (id,space_id,proposal_type,title,summary,rationale,payload_json,status,risk_level,urgency,visibility,access_level,owner_user_id,
      created_by_agent_id,created_by_run_id,action_idempotency_key,expires_at,created_at,updated_at)
    VALUES ($1,$2,'gmail_private_read','Private Gmail check','s','r',$3::jsonb,$4,'high','normal','private','full',$5,$6,$7,'call-1',now()+interval '1 day',now(),now())`,
    [cardId, space, JSON.stringify(payload), status, owner, agent, runId]);
  return { runId, cardId };
}
const grants = async () => (await db.pool.query(`SELECT id FROM plugin_data_grants WHERE plugin_id='core:gmail'`)).rows;
const counts = async () => (await db.pool.query(`SELECT (SELECT count(*)::int FROM sessions) AS sessions, (SELECT count(*)::int FROM runs) AS runs,
    (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM jobs) AS jobs`)).rows[0];
const offered = async (sessionId: string | null, allowance: readonly string[]) =>
  (await buildRunToolGrants([...allowance, TOOL], { allowed_tools: [...allowance, TOOL] }, { db: db.pool, spaceId: space, userId: owner, config, sessionId,
    scenario: { origin: "manual", instructingUserId: owner, audience: [owner] } satisfies RunScenario })).map((grant) => grant.action_id);

it("no conversation offers a withdrawn hand-off or private check; every conversation of a Project reads Gmail itself", async () => {
  await connect();
  for (const withdrawn of [TOOL, "source.gmail.private_check.request"]) {
    expect((await loadSystemActionRegistry(config)).has(withdrawn)).toBe(false);
    expect(POLICY_ACTION_REGISTRY.some((entry) => (entry.action as string) === withdrawn)).toBe(false);
    expect([...CONVERSATION_TOOL_ALLOWANCE, ...ROOM_CONVERSATION_TOOL_ALLOWANCE]).not.toContain(withdrawn);
  }
  // A Room and the Project mainline read in place (ADR 0033 §6), as the private Project chat does.
  for (const [sessionId, allowance] of [[await roomSession(), ROOM_CONVERSATION_TOOL_ALLOWANCE], [await roomSession(true), ROOM_CONVERSATION_TOOL_ALLOWANCE],
    [await directSession(), CONVERSATION_TOOL_ALLOWANCE]] as const) {
    const tools = await offered(sessionId, allowance);
    expect(tools).toContain("source.gmail.mail.read");
    expect(tools).not.toContain(TOOL);
    expect(tools).not.toContain("source.gmail.private_check.request");
  }
  // A chat outside every Project has nothing a consent could bind to.
  expect(await offered(await directSession(null), CONVERSATION_TOOL_ALLOWANCE)).not.toContain("source.gmail.mail.read");
  expect(google.calls).toEqual([]);
});

it("an old pending card is owner-only history: never offered for a decision, refused on accept, and starts or links nothing", async () => {
  const connectionId = await connect();
  for (const mainline of [false, true]) {
    const { runId, cardId } = await historicCard(await roomSession(mainline), connectionId, "pending");
    const before = await counts();
    const previews = await loadProjectChatActionPreviews(db.pool, space, runId);
    // Never snapshotted into the shared message, never shown to another reader, and not decidable for the owner either.
    expect(sharedActionPreviews(previews)).toEqual([]);
    expect(actionPreviewsForViewer(previews, peer)).toEqual([]);
    expect(actionPreviewsForViewer(previews, spaceOwner)).toEqual([]);
    const [own] = actionPreviewsForViewer(previews, owner);
    expect(own).toMatchObject({ action_id: TOOL, proposal_id: cardId, status: "failed", decidable_by_user_id: owner, scope: { project_id: project } });
    expect(own!.scope).not.toHaveProperty("session_id");
    // Nobody else sees it; the owner's acceptance is refused and writes nothing.
    for (const other of [peer, spaceOwner]) { as(other); expect((await accept(cardId)).statusCode).toBe(404); }
    as(owner);
    const refused = await accept(cardId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({ domain: "gmail", message: expect.stringContaining("withdrawn") });
    expect((await db.pool.query(`SELECT status FROM proposals WHERE id=$1`, [cardId])).rows[0].status).toBe("pending");
    expect(await grants()).toEqual([]);
    // Zero new conversations, Runs, messages or queued turns.
    expect(await counts()).toEqual(before);
  }
  expect(google.calls).toEqual([]);
});

it("keeps an accepted card's private conversation and audit as history, without a link from the shared conversation", async () => {
  const connectionId = await connect();
  const { runId, cardId } = await historicCard(await roomSession(), connectionId, "accepted");
  // The private conversation that card created earlier, with its owner-only Run.
  const privateChat = await directSession();
  await db.pool.query(`UPDATE sessions SET metadata_json=$2::jsonb WHERE id=$1`, [privateChat, JSON.stringify({ gmail_private_read_proposal_id: cardId })]);
  const before = await counts();
  const [own] = actionPreviewsForViewer(await loadProjectChatActionPreviews(db.pool, space, runId), owner);
  expect(own).toMatchObject({ proposal_id: cardId, status: "auto_applied", scope: { project_id: project } });
  expect(own!.scope).not.toHaveProperty("session_id");
  expect(await counts()).toEqual(before);
  expect((await db.pool.query(`SELECT metadata_json FROM sessions WHERE id=$1`, [privateChat])).rows[0].metadata_json).toEqual({ gmail_private_read_proposal_id: cardId });
  expect((await db.pool.query(`SELECT status FROM proposals WHERE id=$1`, [cardId])).rows[0].status).toBe("accepted");
});

it("keeps a model's call of the withdrawn tool name out of shared event logs", () => {
  const filter = createPrivateToolCallFilter();
  const reduced = filter({ method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "c1", title: TOOL, rawInput: { mailbox_email: "owner@gmail.example" } } } });
  expect(JSON.stringify(reduced)).not.toContain("owner@gmail.example");
});
