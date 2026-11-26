import { runTool as callRunTool } from "./support/runTool.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { GmailDigestListSchema, ProposalOutSchema, type RainverPlugin } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedRun, seedServerHost, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { publicAddressGuard } from "./support/outboundGuard.js";
import { sourcesModule } from "../src/modules/sources/index.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { proposalsModule } from "../src/modules/proposals/index.js";
import { runsModule } from "../src/modules/runs/index.js";
import { contentAccessModule } from "../src/modules/contentAccess/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { withTransaction } from "../src/db/tx.js";
import { getOperationAuditPool, type PoolClient } from "../src/db/pool.js";
import { BUILT_IN_PLUGINS } from "../src/modules/plugins/builtInPlugins.js";
import { PluginHost } from "../src/modules/plugins/host/index.js";
import { migrateOperationPlugin } from "../src/modules/plugins/operationMigrations.js";
import { pluginServiceFor } from "../src/modules/plugins/service.js";
import { __setGmailOAuthGuardForTests } from "../src/modules/sources/gmail/gmailOAuthTransport.js";
import { __setGmailProfileGuardForTests } from "../src/modules/sources/gmail/gmailOAuthFlow.js";
import { __setGmailSyncGuardForTests, syncGmailMailbox } from "../src/modules/sources/gmail/gmailMailboxSync.js";
import { __setGmailReadGuardForTests } from "../src/modules/sources/gmail/gmailMailReads.js";
import { assertGmailDigestReadUrl } from "../src/modules/sources/gmail/gmailDigestReads.js";
import { assertGmailSyncUrl } from "../src/modules/sources/gmail/gmailSyncContract.js";
import { assertGmailAgentReadUrl } from "../src/modules/sources/gmail/gmailAgentReadContract.js";
import { PgProjectAgentRepository } from "../src/modules/projects/projectAgents.js";
import { PgRunRepository, type AgentRunRecord } from "../src/modules/runs/repository.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { CliAgentToolTransport } from "../src/modules/runs/cliToolTransport.js";
import { OperationToolResponse } from "../src/modules/systemActions/operations/agentResult.js";
import { recordHostThreadOutcome } from "../src/modules/hosts/threadOutcome.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { endGmailDigestIn, settleGmailDigestRun, startDueGmailDigests, startGmailDigestDelivery } from "../src/modules/sources/gmail/gmailDigests.js";
import {
  flagGmailApplicationMessage, listGmailApplicationUpdates, proposeGmailApplicationUpdates, setGmailApplicationUpdatesStatus,
} from "../src/modules/sources/gmail/gmailApplicationUpdates.js";
import { APPLICATION_UPDATE_RUN_TOOLS } from "../src/modules/sources/gmail/gmailApplicationUpdateRuns.js";
import { __setGmailDigestReadBudgetForTests, GMAIL_DIGEST_READ_BUDGET_MS } from "../src/modules/sources/gmail/gmailDigestReadOperation.js";
import { PgRunToolIdentityRepository } from "../src/modules/runs/runToolIdentityRepository.js";
import { recordRuntimeModelFallback } from "../src/modules/runs/runtimeModelFallback.js";
import { CONVERSATION_TOOL_ALLOWANCE } from "../src/modules/systemActions/scenarioToolAllowance.js";
import { isOutwardAfterSensitiveRead } from "../src/modules/plugins/egress.js";
import { persistRunContextTaint } from "../src/modules/runs/contextTaint.js";
import { proposeGmailSetup } from "../src/modules/sources/gmail/gmailSetupProposal.js";
import { listGmailDelegations, proposeGmailDelegation } from "../src/modules/sources/gmail/gmailDelegations.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { proposalRevisionSql } from "../src/modules/proposals/proposalRevision.js";
import { proposeGmailDigest } from "../src/modules/sources/gmail/gmailDigestProposal.js";
import { PgFrontendSupportService } from "../src/modules/frontendSupport/service.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { ProviderProxyLeaseRegistry, setProviderProxyBaseUrlForProcess } from "../src/modules/providers/proxy/lease.js";
import { buildRemoteProviderBinding, recordRemoteRunBackend, resolveRemoteRunBinding, resolveRuntimeProfileScope } from "../src/modules/runs/remoteProviderBinding.js";
import { selectModelChannelLaunch } from "../src/modules/runs/modelChannelLaunch.js";
import { executeRemoteHostCliAdapter, NO_PROVIDER_BINDINGS } from "../src/modules/runs/remoteHostCliAdapter.js";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";
import { hostThreadDispatchInputs } from "../src/modules/hosts/threadDispatchInputs.js";

// ADR 0034 on real PostgreSQL with the real proposal apply service, operation core, Applications package,
// mailbox sync, scheduler, digest read and Agent tool transport. Only Google is stubbed at globalThis.fetch
// with a small synthetic mailbox; no real account, mailbox or rule is used.
const db = useTestDatabase(import.meta.filename);
const CLIENT_ID = "gmail-client.apps.googleusercontent.com";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const SUBJECT_MARK = "SUBJECT-MARK-7f2a";
const BODY_MARK = "BODY-MARK-91c3";
const plugin = BUILT_IN_PLUGINS.find((p) => p.id === "phd_application") as RainverPlugin;

let config: ServerConfig, app: ReturnType<typeof buildModuleServer>;
let space: string, owner: string, peer: string, admin: string, project: string;

type Mail = { id: string; at: number; subject: string; body: string; labels: string[]; from?: string; to?: string; headers?: { name: string; value: string }[] };
const google = { calls: [] as { url: string; method: string }[], historyId: 1000, history: [] as { id: string; messageIds: string[] }[], messages: new Map<string, Mail>(), nextSub: "1001",
  /** A status Gmail answers instead for a message's own get (a transient 5xx), by message id. */
  failing: new Map<string, number>() };
let nextMessage = 0x2b0000000;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const idToken = (sub: string) => `e30.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
/** A synthetic message arriving now (its receipt time at whole seconds, as Gmail reports milliseconds). */
function deliver(input: Partial<Mail> = {}): Mail {
  const mail: Mail = { id: (nextMessage++).toString(16), at: input.at ?? Date.now(), subject: input.subject ?? `${SUBJECT_MARK} Quick chat`, body: input.body ?? `${BODY_MARK} Are you free next week to talk about your application?`, labels: input.labels ?? ["INBOX", "UNREAD"], from: input.from, to: input.to, headers: input.headers };
  google.messages.set(mail.id, mail);
  google.historyId += 1;
  google.history.push({ id: String(google.historyId), messageIds: [mail.id] });
  return mail;
}

/** Runs inside the synthetic Google before it answers a request (after the server admitted the send). */
let beforeGoogle: ((url: string) => Promise<void>) | null = null;
async function stub(url: string, init?: RequestInit): Promise<Response> {
  google.calls.push({ url, method: String(init?.method ?? "GET") });
  if (beforeGoogle) await beforeGoogle(url);
  if (url === "https://oauth2.googleapis.com/token") {
    return json({ access_token: `ya29.access-${randomUUID()}`, expires_in: 3599, token_type: "Bearer", scope: `openid ${READONLY}`, id_token: idToken(google.nextSub), refresh_token: `1//refresh-${randomUUID()}` });
  }
  expect(String(init?.method ?? "GET")).toBe("GET");
  const parsed = new URL(url);
  const full = parsed.searchParams.get("format") === "full";
  // An owner's on-demand read (`source.gmail.mail.read`) is held to its own allowlist instead.
  const onDemand = !(parsed.searchParams.get("q") ?? "after:").startsWith("after:");
  expect(() => onDemand ? assertGmailAgentReadUrl(url) : full ? assertGmailDigestReadUrl(url) : assertGmailSyncUrl(url), url).not.toThrow();
  if (parsed.pathname.endsWith("/profile")) return json({ emailAddress: "owner@gmail.example", historyId: String(google.historyId) });
  if (parsed.pathname.endsWith("/history")) {
    const start = Number(parsed.searchParams.get("startHistoryId"));
    const records = google.history.filter((r) => Number(r.id) > start);
    return json({ history: records.map((r) => ({ id: r.id, messagesAdded: r.messageIds.map((id) => ({ message: { id, threadId: id } })) })), historyId: String(google.historyId) });
  }
  if (parsed.pathname.endsWith("/messages")) {
    const floor = onDemand ? 0 : Number((parsed.searchParams.get("q") ?? "").split(" ")[0]?.slice("after:".length));
    const all = [...google.messages.values()].filter((m) => m.at / 1000 > floor).sort((a, b) => b.at - a.at);
    return json({ messages: all.map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: all.length });
  }
  const message = /\/messages\/([0-9a-f]+)$/.exec(parsed.pathname);
  if (message) {
    const forced = google.failing.get(message[1]!);
    if (forced) return json({ error: { code: forced } }, forced);
    const m = google.messages.get(message[1]!);
    if (!m) return json({ error: { code: 404 } }, 404);
    return json({ id: m.id, threadId: m.id, labelIds: m.labels, internalDate: String(m.at), snippet: "",
      payload: { ...(full ? { mimeType: "text/plain", body: { data: Buffer.from(m.body).toString("base64url") } } : {}), headers: [{ name: "Subject", value: m.subject }, { name: "From", value: m.from ?? "Admissions <office@uni.example>" }, { name: "To", value: m.to ?? "owner@gmail.example" }, ...(full ? m.headers ?? [] : [])] } });
  }
  throw new Error(`unexpected Google request ${url}`);
}

beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.operationManifest, "build the official plugins first (server/scripts/build-official-plugins.mjs)").toBeTruthy();
  await migrateOperationPlugin(db.pool, plugin);
});

beforeEach(async () => {
  await resetTables(db.pool, ["spaces", "users", "credentials", "source_request_quota_state", "jobs"], { cascade: true });
  space = randomUUID(); owner = randomUUID(); peer = randomUUID(); admin = randomUUID(); project = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: "team" });
  await seedSpaceMember(db.pool, { space, user: peer });
  await seedSpaceMember(db.pool, { space, user: admin, role: "admin" });
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, peer]);
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: mkdtempSync(join(tmpdir(), "rainver-gmail-apps-")),
    GMAIL_OAUTH_CLIENT_ID: CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret-fixture",
    GMAIL_OAUTH_REDIRECT_URI: "http://localhost:3000/api/v1/sources/gmail/oauth/callback",
  });
  app = buildModuleServer(config, [sourcesModule, systemActionsModule, proposalsModule, runsModule, contentAccessModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  await withTransaction(db.pool, (tx) => pluginServiceFor(config).enablePlugin(tx, "phd_application", space, owner, {}));
  as(owner);
  for (const set of [__setGmailOAuthGuardForTests, __setGmailProfileGuardForTests, __setGmailSyncGuardForTests, __setGmailReadGuardForTests]) set(publicAddressGuard);
  Object.assign(google, { calls: [], historyId: 1000, history: [], messages: new Map(), nextSub: "1001", failing: new Map() });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => stub(String(url), init));
});
afterEach(async () => {
  beforeGoogle = null;
  __setAuthIdentityForTests(null);
  __setGmailDigestReadBudgetForTests(null);
  for (const set of [__setGmailOAuthGuardForTests, __setGmailProfileGuardForTests, __setGmailSyncGuardForTests, __setGmailReadGuardForTests]) set(null);
  vi.restoreAllMocks();
  await app?.close();
});

function as(userId: string) { __setAuthIdentityForTests({ spaceId: space, userId }); }
const action = (id: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1/actions/${id}`, headers: { "idempotency-key": randomUUID() }, payload });
const ok = async (response: Promise<{ statusCode: number; body: string; json(): any }>) => {
  const r = await response;
  expect(r.statusCode, r.body).toBe(200);
  return r.json().data;
};
/** The card's revision as it stands (what the owner's card shows: `card_revision`). */
const cardRevision = async (proposalId: string) =>
  (await db.pool.query<{ revision: string }>(`SELECT ${proposalRevisionSql("p")} AS revision FROM proposals p WHERE p.id=$1`, [proposalId])).rows[0]?.revision ?? null;
/** The owner accepting a card on the revision it shows now (`revision`: another one, or `null` for none). */
const accept = async (proposalId: string, revision?: string | null) => {
  const expected = revision === undefined ? await cardRevision(proposalId) : revision;
  return app.inject({ method: "POST", url: `/api/v1/proposals/${proposalId}/accept`, headers: { "idempotency-key": randomUUID() }, payload: expected ? { expected_revision: expected } : {} });
};

type ExecutionModelRow = { agent_id: string; agent_kind: string; runtime_profile_id: string | null; runtime_key: string | null; model: string | null; available: boolean; reason: string | null };
/**
 * The card's two levels flattened for assertions: one row per model of each configuration (every listed model of an
 * available configuration can be chosen), and one row without a model for a configuration that lists none.
 */
function modelRows(data: { configurations: { agent_id: string; agent_kind: string; runtime_profile_id: string | null; runtime_key: string | null; available: boolean; reason: string | null;
  models: { model: string }[] }[] }): ExecutionModelRow[] {
  return data.configurations.flatMap((c): ExecutionModelRow[] => {
    const base = { agent_id: c.agent_id, agent_kind: c.agent_kind, runtime_profile_id: c.runtime_profile_id, runtime_key: c.runtime_key };
    return c.models.length
      ? c.models.map((m) => ({ ...base, model: m.model, available: c.available, reason: c.reason }))
      : [{ ...base, model: null, available: c.available, reason: c.reason }];
  });
}

async function connect(): Promise<string> {
  const start = await app.inject({ method: "POST", url: "/api/v1/sources/gmail/oauth/start", payload: {} });
  const state = new URL(start.json().authorize_url).searchParams.get("state")!;
  const res = await app.inject({ method: "GET", url: `/api/v1/sources/gmail/oauth/callback?${new URLSearchParams({ state, code: `4/c-${randomUUID()}` })}` });
  expect(new URL(String(res.headers.location)).searchParams.get("gmail")).toBe("connected");
  const id = (await db.pool.query(`SELECT id FROM gmail_connections WHERE space_id=$1 ORDER BY created_at DESC LIMIT 1`, [space])).rows[0].id;
  await ok(action("source.gmail.connection.set_agent_read", { connection_id: id, enabled: true }));
  return id;
}

/** The owner's private conversation of the Project with a turn of theirs, its Agent's confirmed binding and a Host. */
async function ownerConversation(existingHostId?: string) {
  const run = randomUUID(), agent = randomUUID(), session = randomUUID();
  await seedRun(db.pool, { id: run, space, owner, agent, version: randomUUID() });
  await db.pool.query(`INSERT INTO sessions (id,space_id,user_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, owner, project]);
  await db.pool.query(`UPDATE runs SET visibility='private',instructed_by_user_id=$2,owner_user_id=$2,project_id=$3,session_id=$4 WHERE id=$1`, [run, owner, project, session]);
  // Claude Code on the machine's own login: the runtime whose responses name the model that produced them.
  await useRuntime(agent, run, "claude_code");
  await db.pool.query(`INSERT INTO session_conversation_backends (id,space_id,session_id,bound_by_user_id,agent_id,runtime_profile_id,runtime_key_snapshot,backend_mode_snapshot,
      model_name_snapshot,model_provider_id_snapshot,runtime_config_snapshot_json,runtime_policy_snapshot_json,session_config_json,participating,created_at,updated_at)
    SELECT $1,p.space_id,$2,$3,p.agent_id,p.id,p.runtime_key,p.backend_mode,p.model_name,p.model_provider_id,p.runtime_config_json,p.runtime_policy_json,
      $4::jsonb,true,now(),now() FROM agent_runtime_profiles p WHERE p.agent_id=$5 AND p.is_default`,
  [randomUUID(), session, owner, JSON.stringify([{ id: "model", type: "select", value: "synthetic-model-a", category: "model" }]), agent]);
  const hostId = existingHostId ?? randomUUID();
  if (!existingHostId) {
    await seedServerHost(db.pool, { id: hostId, installations: { claude_code: [{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, options: null, health_check_protocol: "acp" }] } });
    await advertiseModels(hostId, ["synthetic-model-a", "synthetic-model-b"]);
  }
  await db.pool.query(`UPDATE agent_runtime_profiles SET execution_host_id=$2,workspace_mode='managed',runtime_installation='managed:1.0.0' WHERE agent_id=$1 AND is_default`, [agent, hostId]);
  await new PgProjectAgentRepository(db.pool).upsertActive({ spaceId: space, projectId: project, agentId: agent, userId: owner });
  return { run, agent, session, hostId };
}

/** Switches the Agent's default Runtime Profile (and a Run seeded from it) to another runtime. */
async function useRuntime(agent: string, run: string, runtimeKey: string) {
  await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_key=$2 WHERE agent_id=$1 AND is_default`, [agent, runtimeKey]);
  await db.pool.query(`UPDATE runs SET runtime_key=$2::text,runtime_profile_snapshot_json=COALESCE(runtime_profile_snapshot_json,'{}'::jsonb)||jsonb_build_object('runtime_key',$2::text) WHERE id=$1`, [run, runtimeKey]);
}

/** The models the Host's runtime currently offers for the conversation's `model` session option. */
async function advertiseModels(hostId: string, models: string[]) {
  await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,claude_code,0,options}',$2::jsonb) WHERE id=$1`, [hostId, JSON.stringify({
    config_options: models.length ? [{ id: "model", name: "Model", category: "model", type: "select", current_value: models[0], options: models.map((value) => ({ value, name: value })) }] : [],
  })]);
}

/** A running `manual` turn of the owner in a conversation, with the given tools. */
async function ownerTurn(sourceRun: string, sessionId: string, tools: string[], visibility = "private") {
  const id = randomUUID();
  const source = (await db.pool.query(`SELECT agent_id,agent_version_id FROM runs WHERE id=$1`, [sourceRun])).rows[0];
  await seedRun(db.pool, { id, space, owner, agent: source.agent_id, version: source.agent_version_id, existingAgent: true });
  const grants = tools.map((action_id) => ({ action_id, approval_behavior: "none", side_effecting: !action_id.endsWith(".list") }));
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',visibility=$5,instructed_by_user_id=$2,owner_user_id=$2,project_id=$3,session_id=$4,permission_snapshot_json=$6::jsonb WHERE id=$1`,
    [id, owner, project, sessionId, visibility, JSON.stringify({ tool_grants: grants })]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, id]);
  return id;
}
const loadRunRow = async (id: string) => (await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [id])).rows[0]!;
const toolCall = (runRow: AgentRunRecord, name: string, args: Record<string, unknown>) =>
  new CliAgentToolTransport(config, { actionEventSink: async () => {} }).call(runRow, { id: randomUUID(), name, arguments: args });

/** A Room conversation of the Project with the given human members. */
async function roomConversation(members: string[]) {
  const room = randomUUID(), session = randomUUID();
  await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline) VALUES ($1,$2,$3,$4,'Room','active',now(),now(),false)`, [room, space, project, owner]);
  for (const user of members) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, user]);
  await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, room, project]);
  return { room, session };
}

/** New inbox mail received a few seconds after the automation's coverage start, recorded by a sync. */
async function newMail(connectionId: string, digestId: string, count: number) {
  await db.pool.query(`UPDATE gmail_digests SET covered_until=now()-interval '60 seconds' WHERE id=$1`, [digestId]);
  const base = Math.floor(Date.now() / 1000) * 1000 - 50_000;
  const mails = Array.from({ length: count }, (_, index) => deliver({ at: base + index * 1000 }));
  expect(await syncGmailMailbox(config, db.pool, connectionId)).toMatchObject({ status: "synced" });
  return mails;
}
const runningDelivery = async (digestId: string) => (await db.pool.query(`SELECT id,run_id FROM gmail_digest_deliveries WHERE digest_id=$1 AND status='running'`, [digestId])).rows[0];

/**
 * The automation Run, launched as the conversation's own runtime would, with its Agent tool transport. As the
 * ACP controller does, the runtime echoes its model option as the prompt starts (`runtime_reported_model`,
 * `on_model_selected`); no proof of the answering model is recorded or needed (ADR 0037). `fallBack` records the
 * runtime's own explicit fallback notice as the Host adapter does (`on_model_fallback`, `recordRuntimeModelFallback`).
 * `relaunch` binds the same attempt to a new launch, as a restart does. Each call carries
 * the launch it comes from, as the Run tool route resolves it from the caller's token (`runToolRequest.ts`);
 * `from` sends it as an earlier launch whose request is still in flight; `signal` is the caller's abort.
 * `sourceRun` copies that Run's runtime profile snapshot onto the automation Run first (the fixture's seeded runtime);
 * `null` keeps the Run exactly as the scheduler created it. Either way the Host side — the echoed option, the launch
 * binding and a fallback report — is synthetic: no Host or runtime runs here.
 */
async function launch(sourceRun: string | null, runId: string, hostId: string, echoed: string | null = "synthetic-model-a") {
  if (sourceRun) await db.pool.query(`UPDATE runs target SET runtime_profile_id=source.runtime_profile_id,runtime_key=source.runtime_key,runtime_profile_selection_source='explicit',
      runtime_profile_snapshot_json=source.runtime_profile_snapshot_json FROM runs source WHERE target.id=$1 AND source.id=$2`, [runId, sourceRun]);
  await db.pool.query(`UPDATE runs SET model_override_json=(COALESCE(model_override_json,'{}'::jsonb)-'runtime_reported_model')
      || CASE WHEN $2::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('runtime_reported_model',$2::text) END WHERE id=$1`, [runId, echoed]);
  expect(await new PgRunRepository(db.pool, config).markRunRunning({ run_id: runId, space_id: space, started_at: new Date().toISOString() })).not.toBeNull();
  const runtimeKey = (await db.pool.query<{ runtime_key: string }>(`SELECT runtime_key FROM runs WHERE id=$1`, [runId])).rows[0]!.runtime_key;
  let launchId = "";
  /** `isolation`: what the launch frame stated (the adapter records it with the nonce); ordinary egress unless given. */
  const relaunch = async (isolation: Record<string, string> = { host_kind: "server", egress_profile: "default", sandbox_mode: "read_write" }) => {
    const previous = launchId;
    launchId = randomUUID();
    expect(await new PgRunRepository(db.pool, config).bindAttemptLaunch({ space_id: space, run_id: runId, launch_id: launchId, expected_launch_id: previous || null,
      isolation: { host_id: hostId, ...isolation } as never })).toBe(true);
    return launchId;
  };
  const fallBack = (title = "Model rerouted", description: string | null = "Switched from synthetic-model-a to synthetic-model-z.") =>
    recordRuntimeModelFallback(db.pool, { spaceId: space, runId, launchId: launchId || null, title, description });
  await relaunch();
  const loadRun = async () => (await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [runId])).rows[0]!;
  const transport = new CliAgentToolTransport(config, { actionEventSink: async () => {} });
  const tool = async (name: string, args: Record<string, unknown>, from = launchId, signal?: AbortSignal) =>
    transport.call(await loadRun(), { id: randomUUID(), name, arguments: args }, signal, { launchId: from, startedAt: Date.now() });
  const call = async (name: string, args: Record<string, unknown>, from = launchId, signal?: AbortSignal) => {
    const result = await tool(name, args, from, signal);
    if (!(result instanceof OperationToolResponse)) throw new Error(`Expected an operation response for ${name}`);
    return result;
  };
  return { loadRun, call, tool, fallBack, relaunch, launchId: () => launchId, runtimeKey };
}

const application = async (institution: string, program: string) =>
  (await ok(action("plugin.phd_application.application.create", { project_id: project, institution, program, checklist: "empty" }))).application_id as string;
const appRow = async (id: string) => (await db.pool.query(`SELECT status,revision,status_changed_at FROM plugin_phd_application.applications WHERE id=$1`, [id])).rows[0];
const items = async (digestId: string) => (await db.pool.query(`SELECT google_message_id,status,reason,attempts,candidate_application_ids FROM gmail_digest_mail_items WHERE digest_id=$1 ORDER BY received_at`, [digestId])).rows;
const iso = (ms: number) => new Date(ms).toISOString();

async function confirmedAutomation(effects?: string[]) {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, effects ? { effects: effects as never } : {}, randomUUID());
  expect(drafted.modelResult.ok, JSON.stringify(drafted)).toBe(true);
  const proposalId = String(drafted.modelResult.proposal_id);
  as(admin);
  expect((await accept(proposalId)).statusCode).toBe(404);
  as(owner);
  const res = await accept(proposalId);
  expect(res.statusCode, res.body).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
  return { connectionId, ...conversation, proposalId, digest };
}

it("is offered in conversation and exempt from the mail-read write refusal only for its owner-only tools", () => {
  expect(CONVERSATION_TOOL_ALLOWANCE).toEqual(expect.arrayContaining(["source.gmail.application_updates.propose", "source.gmail.application_updates.list", "source.gmail.application_updates.set_status"]));
  expect(CONVERSATION_TOOL_ALLOWANCE).not.toContain("source.gmail.application_updates.flag");
  for (const id of ["source.gmail.application_updates.propose", "source.gmail.application_updates.set_status", "source.gmail.application_updates.flag"]) {
    expect(isOutwardAfterSensitiveRead({ id, side_effects: "durable" })).toBe(false);
  }
  // General Applications writes stay outward after a mail read: only the dedicated fact command has a gate.
  expect(isOutwardAfterSensitiveRead({ id: "plugin.phd_application.application.update_status", side_effects: "durable" })).toBe(true);
  expect(isOutwardAfterSensitiveRead({ id: "plugin.phd_application.mail_fact.apply", side_effects: "durable" })).toBe(true);
});

it("confirms one rule in the owner's private conversation on its Agent and model, then records only checked external facts from new inbox mail", async () => {
  // A conversation read by someone outside the Project is refused before anything is drafted (ADR 0035 §1 lets
  // the owner enable it from a Room or the mainline only while every reader works in the Project).
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const roomRun = randomUUID();
  await seedRun(db.pool, { id: roomRun, space, owner, agent: randomUUID(), version: randomUUID() });
  const outside = await roomConversation([owner, admin]);
  await db.pool.query(`UPDATE runs SET visibility='space_shared',instructed_by_user_id=$2,owner_user_id=$2,project_id=$3,session_id=$4 WHERE id=$1`, [roomRun, owner, project, outside.session]);
  expect((await proposeGmailApplicationUpdates(db.pool, config, roomRun, space, {}, randomUUID())).modelResult).toMatchObject({ ok: false, error: "gmail_digest_owner_turn_required" });

  const { run, session, hostId } = await ownerConversation();
  const old = deliver({ at: Date.now() - 120_000 });
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, run, space, { effects: ["interview", "rejected", "deadline"] }, randomUUID());
  expect(drafted.modelResult.ok, JSON.stringify(drafted)).toBe(true);
  const card = (await db.pool.query(`SELECT * FROM proposals WHERE id=$1`, [drafted.modelResult.proposal_id])).rows[0];
  expect(card).toMatchObject({ proposal_type: "gmail_digest_create", visibility: "private", owner_user_id: owner, project_id: null });
  expect(card.summary).toContain("synthetic-model-a");
  expect(card.payload_json).toMatchObject({ kind: "application", effects: ["interview", "rejected", "deadline"], runtime_binding: { model_label: expect.stringContaining("synthetic-model-a") } });
  as(admin);
  expect((await accept(card.id)).statusCode).toBe(404);
  as(owner);
  expect((await accept(card.id)).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [card.id])).rows[0];
  // ADR 0036: it runs in the owner's private execution conversation on the confirmed configuration, not in this one.
  expect(digest).toMatchObject({ kind: "application", status: "active", local_time: null, notice_session_id: null });
  expect(digest.session_id).not.toBe(session);
  expect((await db.pool.query(`SELECT user_id,room_id,metadata_json FROM sessions WHERE id=$1`, [digest.session_id])).rows[0])
    .toMatchObject({ user_id: owner, room_id: null, metadata_json: { gmail_application_execution: true } });
  expect((await db.pool.query(`SELECT plugin_id,purpose,scope FROM plugin_data_grants WHERE id=$1`, [digest.grant_id])).rows[0]).toEqual({ plugin_id: "core:gmail_digest", purpose: "application_update", scope: "project" });

  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const oxford = await application("University of Oxford", "DPhil in Engineering");
  // Synthetic receipt times a minute back, after the rule's coverage start and before the person's own edit below.
  await db.pool.query(`UPDATE gmail_digests SET covered_until=now()-interval '60 seconds' WHERE id=$1`, [digest.id]);
  const base = Math.floor(Date.now() / 1000) * 1000 - 50_000;
  const chat = deliver({ at: base });
  const spam = deliver({ at: base + 1000, labels: ["SPAM"] });
  const sent = deliver({ at: base + 2000, labels: ["SENT"] });
  const moved = deliver({ at: base + 3000, subject: `${SUBJECT_MARK} Interview date`, body: `${BODY_MARK} Your interview is now on 2027-01-20.` });
  const rejection = deliver({ at: base + 4000, subject: `${SUBJECT_MARK} Your application`, body: `${BODY_MARK} We regret to inform you.` });
  expect(await syncGmailMailbox(config, db.pool, connectionId)).toMatchObject({ status: "synced" });
  // Every new inbox message, without keywords; never old, spam or sent mail. Ids and times only.
  expect((await items(digest.id)).map((row) => row.google_message_id)).toEqual([chat.id, moved.id, rejection.id]);
  expect((await items(digest.id)).every((row) => row.status === "pending")).toBe(true);
  const stored = JSON.stringify((await db.pool.query(`SELECT * FROM gmail_digest_mail_items`)).rows);
  expect(stored).not.toContain(SUBJECT_MARK);
  expect(stored).not.toContain(BODY_MARK);
  void old; void spam; void sent;

  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(1);
  const delivery = (await db.pool.query(`SELECT dl.message_ids,r.id AS run_id,r.trigger_origin,r.visibility,r.permission_snapshot_json FROM gmail_digest_deliveries dl JOIN runs r ON r.id=dl.run_id WHERE dl.digest_id=$1`, [digest.id])).rows[0];
  expect(delivery).toMatchObject({ message_ids: [chat.id, moved.id, rejection.id], trigger_origin: "automation", visibility: "private" });
  expect(delivery.permission_snapshot_json.tool_grants.map((grant: { action_id: string }) => grant.action_id).sort()).toEqual([...APPLICATION_UPDATE_RUN_TOOLS].sort());
  const { loadRun, call, tool } = await launch(run, delivery.run_id, hostId);
  const read = await call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  const mail = (read.body as { data: { items: { id: string; internal_date: string; text: string }[] } }).data.items;
  expect(mail.map((item) => item.id)).toEqual([chat.id, moved.id, rejection.id]);
  expect(mail[0]!.text).toContain("talk about your application");
  const listed = await call("plugin.phd_application.application.list", { project_id: project });
  expect(listed.httpStatus, JSON.stringify(listed.body)).toBe(200);

  const apply = (applicationId: string, message: { id: string; at: number }, effect: Record<string, unknown>, revision: number, receivedAt = iso(message.at)) =>
    call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: applicationId, expected_revision: revision, source: { kind: "gmail", message_id: message.id, received_at: receivedAt }, effect });
  const factOf = (response: OperationToolResponse) => (response.body as { data: Record<string, unknown> }).data;
  // "Quick chat" is an interview invitation by meaning: recorded once, replayed thereafter.
  let r = await apply(eth, chat, { kind: "status", status: "interview" }, (await appRow(eth)).revision);
  expect(r.httpStatus, JSON.stringify(r.body)).toBe(200);
  expect(factOf(r)).toMatchObject({ outcome: "recorded", before: "planning", after: "interview", replayed: false, source_message_id: chat.id });
  expect(await appRow(eth)).toMatchObject({ status: "interview" });
  r = await apply(eth, chat, { kind: "status", status: "interview" }, 1);
  expect(factOf(r)).toMatchObject({ outcome: "recorded", replayed: true });
  // The gate refuses what the rule or the Run never allowed: an effect outside the rule, a message the Run was
  // not given, a receipt time other than the message's own.
  expect((await apply(eth, chat, { kind: "status", status: "offer" }, (await appRow(eth)).revision)).httpStatus).toBe(404);
  expect((await apply(eth, old, { kind: "status", status: "rejected" }, (await appRow(eth)).revision)).httpStatus).toBe(404);
  expect((await apply(eth, rejection, { kind: "status", status: "rejected" }, (await appRow(eth)).revision, iso(rejection.at + 1000))).httpStatus).toBe(404);
  // A stale revision writes nothing and is not stored, so a later read can decide it.
  r = await apply(eth, moved, { kind: "deadline", deadline_kind: "interview", due_on: "2027-01-20" }, 1);
  expect(factOf(r)).toMatchObject({ outcome: "conflict", reason: "revision_conflict" });
  r = await apply(eth, moved, { kind: "deadline", deadline_kind: "interview", due_on: "2027-01-20" }, (await appRow(eth)).revision);
  expect(factOf(r)).toMatchObject({ outcome: "recorded", before: null, after: "2027-01-20" });
  // An older message never moves a date or a status set after it was received.
  r = await apply(eth, chat, { kind: "deadline", deadline_kind: "interview", due_on: "2027-01-10" }, (await appRow(eth)).revision);
  expect(factOf(r)).toMatchObject({ outcome: "conflict", reason: "newer_deadline", before: "2027-01-20" });
  r = await apply(oxford, rejection, { kind: "status", status: "rejected" }, (await appRow(oxford)).revision);
  expect(factOf(r)).toMatchObject({ outcome: "recorded", after: "rejected" });
  r = await apply(oxford, chat, { kind: "status", status: "interview" }, (await appRow(oxford)).revision);
  expect(factOf(r)).toMatchObject({ outcome: "conflict", reason: "newer_status", before: "rejected" });
  expect(await appRow(oxford)).toMatchObject({ status: "rejected" });
  // The person's own later change wins over mail received before it.
  await ok(action("plugin.phd_application.application.update_status", { project_id: project, application_id: eth, status: "offer" }));
  r = await apply(eth, rejection, { kind: "status", status: "rejected" }, (await appRow(eth)).revision);
  expect(factOf(r)).toMatchObject({ outcome: "conflict", reason: "newer_status", before: "offer" });
  // An unclear message is kept for the owner instead of guessed.
  // Through the Run's own Agent tool transport (policy, egress after the mail read, the executor).
  const flagged = await tool("source.gmail.application_updates.flag", { message_id: rejection.id, reason: "ambiguous_application", candidate_application_ids: [eth, oxford] });
  expect(JSON.stringify(flagged)).toContain("review");
  expect((await items(digest.id)).find((row) => row.google_message_id === rejection.id)).toMatchObject({ status: "review" });
  expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: old.id, reason: "unclear_fact" }))).toContain("gmail_digest_message_unknown");
  // Outside a Run tool request nothing is known about the caller's launch: nothing is kept.
  expect((await flagGmailApplicationMessage(db.pool, await loadRun(), { message_id: chat.id, reason: "unclear_fact" })).modelResult).toMatchObject({ ok: false, error: "gmail_digest_unavailable" });

  // A person and the owner's ordinary turn never reach the fact command.
  expect((await action("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: 1, source: { kind: "gmail", message_id: chat.id, received_at: iso(chat.at) }, effect: { kind: "status", status: "interview" } })).statusCode).toBe(404);
  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [delivery.run_id]);
  const reply = await settleGmailDigestRun(db.pool, config, await loadRun(), "Recorded an interview at ETH Zurich; kept one message for you.", (tx, content) =>
    new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, digest.session_id, delivery.run_id, { content }));
  expect(reply).toMatchObject({ session_id: digest.session_id });
  expect((await items(digest.id)).map((row) => [row.google_message_id, row.status, row.reason])).toEqual([[chat.id, "done", null], [moved.id, "done", null], [rejection.id, "review", "ambiguous_application"]]);
  expect((await db.pool.query(`SELECT next_run_at>now() AS batched FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].batched).toBe(true);

  // The owner queries in conversation (content-free) and sees what was recorded.
  const listing = await listGmailApplicationUpdates(db.pool, run, space);
  expect(listing.modelResult).toMatchObject({ ok: true, automations: [expect.objectContaining({ digest_id: digest.id, status: "active", effects: ["interview", "rejected", "deadline"], mail_items: { pending: 0, review: 1, failed: 0 } })] });
  expect(JSON.stringify(listing.modelResult)).not.toContain(SUBJECT_MARK);
  const facts = await app.inject({ method: "GET", url: `/api/v1/queries/plugin.phd_application.mail_fact.list?input=${encodeURIComponent(JSON.stringify({ project_id: project }))}` });
  expect(facts.statusCode, facts.body).toBe(200);
  expect(facts.json().data.items.filter((item: { outcome: string }) => item.outcome === "recorded")).toHaveLength(3);
  as(peer);
  const peerFacts = await app.inject({ method: "GET", url: `/api/v1/queries/plugin.phd_application.mail_fact.list?input=${encodeURIComponent(JSON.stringify({ project_id: project }))}` });
  expect(peerFacts.statusCode === 200 ? peerFacts.json().data.items : []).toEqual([]);
  as(owner);
});

it("pauses and changes the rule in conversation, waits for its own Agent and model, and gives up a failing message alone", async () => {
  const { connectionId, run, hostId, session, digest } = await confirmedAutomation();
  expect(digest.effects).toContain("contact");
  // Pausing narrows in place; mail received while paused is never recorded.
  expect((await setGmailApplicationUpdatesStatus(db.pool, run, space, { digest_id: digest.id, status: "paused" })).modelResult).toMatchObject({ ok: true, status: "paused" });
  deliver();
  await syncGmailMailbox(config, db.pool, connectionId);
  expect(await items(digest.id)).toEqual([]);
  // Changing or resuming is a new card, which updates the same automation — drafted through the Agent tool
  // transport in a turn that has just read the owner's mail, which no longer blocks it.
  const turnRun = randomUUID();
  const source = (await db.pool.query(`SELECT agent_id,agent_version_id FROM runs WHERE id=$1`, [run])).rows[0];
  await seedRun(db.pool, { id: turnRun, space, owner, agent: source.agent_id, version: source.agent_version_id, existingAgent: true });
  const grants = ["source.gmail.application_updates.propose", "source.gmail.application_updates.list"].map((action_id) => ({ action_id, approval_behavior: "none", side_effecting: true }));
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',visibility='private',instructed_by_user_id=$2,owner_user_id=$2,project_id=$3,session_id=$4,permission_snapshot_json=$5::jsonb WHERE id=$1`,
    [turnRun, owner, project, session, JSON.stringify({ tool_grants: grants })]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, turnRun]);
  await persistRunContextTaint(db.pool, { runId: turnRun, spaceId: space, instructingUserId: owner, runVisibility: "private", items: [{ ownerUserId: owner, visibility: "private" }],
    pluginReads: [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }] });
  const turn = (await db.pool.query<AgentRunRecord>(`SELECT * FROM runs WHERE id=$1`, [turnRun])).rows[0]!;
  const drafted = await new CliAgentToolTransport(config, { actionEventSink: async () => {} }).call(turn, { id: randomUUID(), name: "source.gmail.application_updates.propose", arguments: { effects: ["interview"] } });
  expect(JSON.stringify(drafted)).toContain("proposal_id");
  const change = { modelResult: { proposal_id: (await db.pool.query(`SELECT id FROM proposals WHERE created_by_run_id=$1`, [turnRun])).rows[0].id } };
  expect((await db.pool.query(`SELECT summary FROM proposals WHERE id=$1`, [change.modelResult.proposal_id])).rows[0].summary).toContain("changes your existing automation");
  expect((await accept(String(change.modelResult.proposal_id))).statusCode).toBe(200);
  const changed = (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0];
  expect(changed).toMatchObject({ status: "active", effects: ["interview"] });
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digests WHERE space_id=$1 AND kind='application'`, [space])).rows[0].n).toBe(1);

  const failing = deliver({ at: Math.floor(Date.now() / 1000) * 1000 + 3000 });
  await syncGmailMailbox(config, db.pool, connectionId);
  expect((await items(digest.id)).map((row) => row.google_message_id)).toEqual([failing.id]);
  // ADR 0036: another model chosen in the conversation it was asked in does not touch it; the configuration is its own.
  await db.pool.query(`UPDATE session_conversation_backends SET session_config_json=$2::jsonb WHERE session_id=$1`, [session, JSON.stringify([{ id: "model", type: "select", value: "synthetic-model-b", category: "model" }])]);
  // Its own execution conversation switched to another model: nothing runs until the owner confirms a new card.
  await db.pool.query(`UPDATE session_conversation_backends SET session_config_json=$2::jsonb WHERE session_id=$1`, [changed.session_id, JSON.stringify([{ id: "model", type: "select", value: "synthetic-model-b", category: "model" }])]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("waiting");
  expect((await db.pool.query(`SELECT last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].last_error_code).toBe("gmail_digest_runtime_changed");
  await db.pool.query(`UPDATE session_conversation_backends SET session_config_json=$2::jsonb WHERE session_id=$1`, [changed.session_id, JSON.stringify([{ id: "model", type: "select", value: "synthetic-model-a", category: "model" }])]);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await db.pool.query(`UPDATE gmail_digests SET retry_not_before=NULL,next_run_at=NULL,status='active' WHERE id=$1`, [digest.id]);
    const started = await startGmailDigestDelivery(db.pool, config, digest.id);
    expect(started, JSON.stringify((await db.pool.query(`SELECT last_error_code,retry_not_before FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0])).toBe("started");
    const runId = (await db.pool.query(`SELECT run_id FROM gmail_digest_deliveries WHERE digest_id=$1 AND status='running'`, [digest.id])).rows[0].run_id;
    // The confirmed model had the mail (its read was released to this launch), then the Run failed.
    const { loadRun, call } = await launch(run, runId, hostId);
    expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
    await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [runId]);
    await settleGmailDigestRun(db.pool, config, await loadRun(), null, async () => null);
    const failedRun = await loadRun();
    expect((await recordHostThreadOutcome(config, failedRun.host_task_thread_id!, failedRun, false)).claim).toBe("released");
    expect((await items(digest.id))[0]).toMatchObject({ attempts: attempt, status: attempt < 3 ? "pending" : "failed" });
  }
  expect((await items(digest.id))[0]).toMatchObject({ reason: "read_failed" });
  // Ending in conversation ends its Gmail permission too.
  expect((await setGmailApplicationUpdatesStatus(db.pool, run, space, { digest_id: digest.id, status: "ended" })).modelResult).toMatchObject({ ok: true, status: "ended" });
  expect((await db.pool.query(`SELECT status FROM plugin_data_grants WHERE id=$1`, [changed.grant_id])).rows[0].status).toBe("revoked");
});

// ---------------------------------------------------------------------------
// Regressions of the review of ADR 0034 (one per finding)
// ---------------------------------------------------------------------------

it("an earlier on-demand read in the same private conversation does not block the automation's facts; an unverified or ended one still does", async () => {
  const { connectionId, run, session, hostId, digest } = await confirmedAutomation(["interview"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  // The owner read mail on demand here before, under their live Gmail consent for this Project (verified at that release).
  const generation = (await db.pool.query(`SELECT generation FROM gmail_connections WHERE id=$1`, [connectionId])).rows[0].generation;
  const { PluginDataGrantRepository } = await import("../src/modules/plugins/dataGrantRepository.js");
  const onDemand = await new PluginDataGrantRepository(db.pool, config).createCoreProjectConsent({ spaceId: space, userId: owner },
    { consentId: "core:gmail", projectId: project, connectionId, generation, purpose: "on_demand_read" });
  // In its private execution conversation (ADR 0036: where the automation runs), an earlier turn of the owner's.
  await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [run, digest.session_id]);
  await persistRunContextTaint(db.pool, { runId: run, spaceId: space, instructingUserId: owner, runVisibility: "private", items: [{ ownerUserId: owner, visibility: "private" }],
    pluginReads: [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner, gmail_scope: { project_id: project, grant_id: onDemand } }] });
  const [first, second] = await newMail(connectionId, digest.id, 2);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  // The automation Run inherits that read (merge-only taint): the isolation stays, it is checked, not dropped.
  expect((await loadRunRow(runId)).context_taint_json).toMatchObject({ plugin_reads: [expect.objectContaining({ plugin_id: "core:gmail", owner_user_id: owner, gmail_scope: { project_id: project, grant_id: onDemand } })] });
  const { call } = await launch(run, runId, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const apply = async (message: Mail) => call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: (await appRow(eth)).revision,
    source: { kind: "gmail", message_id: message.id, received_at: iso(message.at) }, effect: { kind: "status", status: "interview" } });
  // That consent ended: the earlier read is no longer verified, and nothing is recorded.
  await db.pool.query(`UPDATE plugin_data_grants SET status='revoked',revoked_at=now() WHERE id=$1`, [onDemand]);
  expect((await apply(first!)).httpStatus).toBe(404);
  await db.pool.query(`UPDATE plugin_data_grants SET status='active',revoked_at=NULL WHERE id=$1`, [onDemand]);
  const recorded = await apply(first!);
  expect(recorded.httpStatus, JSON.stringify(recorded.body)).toBe(200);
  expect((recorded.body as { data: Record<string, unknown> }).data).toMatchObject({ outcome: "recorded", after: "interview" });
  // A read whose owner or Project consent cannot be verified keeps every later fact of the Run refused.
  await persistRunContextTaint(db.pool, { runId, spaceId: space, instructingUserId: owner, runVisibility: "private", items: [],
    pluginReads: [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }] });
  expect((await apply(second!)).httpStatus).toBe(404);
  void session;
});

it("runs only on the confirmed model: a model missing from the cached picker is left to the strict live session, and a Run that fell back to another is given none", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  // Claude Code's cached picker no longer lists the confirmed model: the turn starts and its live session must
  // apply exactly that model or fail (`sessions/sessionConfig.ts`); no fallback to the runtime's default.
  await advertiseModels(hostId, ["synthetic-model-b"]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  // The confirmed model is applied strictly: never a saved selection the runtime may drop for its default.
  const override = (await loadRunRow(runId)).model_override_json as Record<string, unknown>;
  expect(override.acp_session_config).toEqual([{ id: "model", type: "select", value: "synthetic-model-a", category: "model" }]);
  expect(override).not.toHaveProperty("acp_session_config_source");
  expect(override).not.toHaveProperty("acp_session_config_dropped");
  // A Run that nonetheless ended up on another model (its selection dropped) is given no mail at all.
  await db.pool.query(`UPDATE runs SET model_override_json=model_override_json||$2::jsonb WHERE id=$1`, [runId,
    JSON.stringify({ acp_session_config_dropped: [{ id: "model", category: "model", value: "synthetic-model-a", reason: "not_applied" }] })]);
  const { call } = await launch(run, runId, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).not.toBe(200);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1`, [runId])).rows[0].n).toBe(0);
});

it("binds each delivery to the rule version it was started for: a changed rule ends the earlier Run's reads, facts and settlement", async () => {
  const { connectionId, run, session, hostId, digest, proposalId } = await confirmedAutomation(["interview", "rejected"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const [first, second] = await newMail(connectionId, digest.id, 2);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const oldDelivery = await runningDelivery(digest.id);
  expect((await loadRunRow(oldDelivery.run_id)).contract_snapshot_json).toMatchObject({ workflow_input_json: { gmail_digest: { kind: "application", rule_version: proposalId } } });
  const { call, tool, loadRun } = await launch(run, oldDelivery.run_id, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const apply = async (message: Mail, status: string) => call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: (await appRow(eth)).revision,
    source: { kind: "gmail", message_id: message.id, received_at: iso(message.at) }, effect: { kind: "status", status } });
  expect((await apply(first!, "interview")).httpStatus).toBe(200);
  // The owner changes the rule while that Run is still going (a new card, accepted in their conversation).
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, run, space, { effects: ["interview"] }, randomUUID());
  expect((await accept(String(drafted.modelResult.proposal_id))).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE id=$1`, [oldDelivery.id])).rows[0]).toEqual({ status: "failed", error_code: "gmail_digest_rule_changed" });
  // The earlier version's Run records and flags nothing more, even an effect both versions allow, and settles nothing.
  expect((await apply(second!, "interview")).httpStatus).toBe(404);
  expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: second!.id, reason: "unclear_fact" }))).toContain("gmail_digest_unavailable");
  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [oldDelivery.run_id]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRun(), "Recorded one interview.", (tx, content) =>
    new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, session, oldDelivery.run_id, { content }))).toBeNull();
  expect((await items(digest.id)).find((row) => row.google_message_id === second!.id)).toMatchObject({ status: "pending", attempts: 0 });
  // The waiting message goes to a delivery of the new version, once the earlier turn has left the conversation
  // (its chat finalizer completed it, storing no reply).
  const ended = await loadRun();
  expect((await recordHostThreadOutcome(config, ended.host_task_thread_id!, ended, true)).claim).toBe("released");
  await db.pool.query(`INSERT INTO run_events (id,space_id,run_id,event_index,event_type,status,summary,metadata_json,created_at)
    VALUES ($1,$2,$3,9999,'chat_completed','succeeded','',$4::jsonb,now())`, [randomUUID(), space, ended.id, "{}"]);
  await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [digest.id]);
  const restarted = await startGmailDigestDelivery(db.pool, config, digest.id);
  expect(restarted, JSON.stringify((await db.pool.query(`SELECT last_error_code,retry_not_before FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0])).toBe("started");
  const next = await runningDelivery(digest.id);
  expect((await loadRunRow(next.run_id)).contract_snapshot_json).toMatchObject({ workflow_input_json: { gmail_digest: { rule_version: String(drafted.modelResult.proposal_id) } } });
});

it("delivers only into the owner's private conversation: never a Room, even one nobody else reads yet", async () => {
  const { connectionId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  // An automation whose conversation is (now) a Room — here with no other member — is never started there.
  const solo = await roomConversation([owner]);
  await db.pool.query(`UPDATE gmail_digests SET session_id=$2 WHERE id=$1`, [digest.id, solo.session]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("waiting");
  expect((await db.pool.query(`SELECT last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].last_error_code).toBe("gmail_digest_audience_not_owner");
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digest_deliveries WHERE digest_id=$1`, [digest.id])).rows[0].n).toBe(0);
});

it("answers the mail-fact ledger to an Agent only in the owner's own private conversation, never into a Room", async () => {
  const { run, session } = await confirmedAutomation(["interview"]);
  const turn = await ownerTurn(run, session, ["plugin.phd_application.mail_fact.list"]);
  const privateRead = await toolCall(await loadRunRow(turn), "plugin.phd_application.mail_fact.list", { project_id: project });
  expect(privateRead instanceof OperationToolResponse ? privateRead.httpStatus : privateRead, JSON.stringify(privateRead)).toBe(200);
  // The same owner turn in a Room — with a peer, or with nobody else yet — gets the hidden 404 from the host gate.
  for (const members of [[owner, peer], [owner]]) {
    const room = await roomConversation(members);
    await db.pool.query(`UPDATE runs SET session_id=$2,visibility='space_shared' WHERE id=$1`, [turn, room.session]);
    const { gmailApplicationFactsAudienceAdmitted } = await import("../src/modules/sources/gmail/gmailApplicationUpdates.js");
    const actor = { space_id: space, run_id: turn, on_behalf_of_user_id: owner, principal: { kind: "agent" as const, id: "agent" } };
    expect(await gmailApplicationFactsAudienceAdmitted(db.pool, actor, { project_id: project })).toBe(false);
    const roomRead = await toolCall(await loadRunRow(turn), "plugin.phd_application.mail_fact.list", { project_id: project });
    expect(roomRead instanceof OperationToolResponse ? roomRead.httpStatus : 0).not.toBe(200);
  }
  // The owner reads it directly; another person never gets the owner's rows.
  expect((await app.inject({ method: "GET", url: `/api/v1/queries/plugin.phd_application.mail_fact.list?input=${encodeURIComponent(JSON.stringify({ project_id: project }))}` })).statusCode).toBe(200);
});

it("never resumes an application automation through the generic digest status command: resuming is a new card", async () => {
  const { digest } = await confirmedAutomation(["interview"]);
  const status = (value: string) => app.inject({ method: "POST", url: `/api/v1/sources/gmail/digests/${digest.id}/status`, headers: { "idempotency-key": randomUUID() }, payload: { status: value } });
  expect((await status("paused")).statusCode).toBe(200);
  const resumed = await status("active");
  expect(resumed.statusCode, resumed.body).toBe(409);
  expect((await db.pool.query(`SELECT status FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].status).toBe("paused");
});

// ---------------------------------------------------------------------------
// Regressions of the second review of ADR 0034
// ---------------------------------------------------------------------------

/** Another Agent of the Project on `hostId`, on a runtime-native profile of `runtimeKey` whose picker offers `models` (named by the runtime). */
async function nativeAgent(hostId: string, runtimeKey: string, models: string[]) {
  const other = await ownerConversation(hostId);
  await useRuntime(other.agent, other.run, runtimeKey);
  await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,ARRAY['installations',$3::text],$2::jsonb) WHERE id=$1`, [hostId, JSON.stringify([{
    id: "managed:1.0.0", version: "1.0.0", logged_in: true, health_check_protocol: "acp",
    options: { config_options: models.length ? [{ id: "model", name: "Model", category: "model", type: "select", current_value: models[0], options: models.map((value) => ({ value, name: value.toUpperCase() })) }] : [] },
  }]), runtimeKey]);
  return other;
}
const settleAs = async (runId: string, sessionId: string, status: "succeeded" | "failed", reply: string | null) => {
  await db.pool.query(`UPDATE runs SET status=$2 WHERE id=$1`, [runId, status]);
  return settleGmailDigestRun(db.pool, config, await loadRunRow(runId), reply, (tx, content) =>
    new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, sessionId, runId, { content, metadata: { gmail_result: true } }));
};
/** The Host thread claim and the conversation turn a settled Run releases, as its finalization does, so the next round can start. */
const releaseThread = async (runId: string) => {
  // The turn's finalization, as the chat finalizer records it once the reply (or notice) is stored.
  await db.pool.query(`INSERT INTO run_events (id,space_id,run_id,event_index,event_type,status,summary,metadata_json,created_at)
    VALUES ($1,$2,$3,1000,'chat_completed','succeeded','fixture','{}'::jsonb,now()) ON CONFLICT DO NOTHING`, [randomUUID(), space, runId]);
  const settled = await loadRunRow(runId);
  if (settled.host_task_thread_id) await recordHostThreadOutcome(config, settled.host_task_thread_id, settled, false);
};
const assistantMessages = async (runId: string) => (await db.pool.query<{ content: string }>(`SELECT content FROM messages WHERE run_id=$1 AND role='assistant' ORDER BY created_at`, [runId])).rows.map((row) => row.content);

it("ADR 0037: offers exactly what the conversation's picker offers — aliases and `default` too, or the runtime's own default without a picker — and reads and settles with no proof of the answering model", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const select = (value: string) => db.pool.query(`UPDATE session_conversation_backends SET session_config_json=$2::jsonb WHERE session_id=$1`,
    [conversation.session, JSON.stringify([{ id: "model", type: "select", value, category: "model" }])]);
  // The conversation's own picker, as the Host reports it: every value is offered, in its order, with the runtime's names.
  await advertiseModels(conversation.hostId, ["default", "opus", "sonnet[1m]", "claude-opus-5-5"]);
  await select("opus");
  const opened = (await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, {}, randomUUID())).modelResult;
  expect(opened).toMatchObject({ ok: true, execution: { preselected: { model: "opus" }, available_choices: 4, unavailable_choices: 0 } });
  const shown = (await executionOptions(String(opened.proposal_id))).json().data;
  expect(shown.configurations).toEqual([expect.objectContaining({ runtime_key: "claude_code", available: true, reason: null,
    models: ["default", "opus", "sonnet[1m]", "claude-opus-5-5"].map((model) => ({ model, name: model })) })]);
  // An alias is chosen like any other value; the card's text says how it runs and what a reported fallback does.
  const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: opened.proposal_id, agent_id: conversation.agent,
    runtime_profile_id: shown.configurations[0].runtime_profile_id, model: "sonnet[1m]" }));
  expect(chosen.selected).toMatchObject({ model: "sonnet[1m]" });
  expect(chosen.summary).toContain("It runs as your own conversation with that Agent runs. If its runtime reports that it answered with another model, that round stops");
  // No model option at all: the runtime's own default, as the conversation would run.
  await advertiseModels(conversation.hostId, []);
  await db.pool.query(`UPDATE session_conversation_backends SET session_config_json='[]'::jsonb WHERE session_id=$1`, [conversation.session]);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  expect(drafted.modelResult).toMatchObject({ ok: true, execution: { preselected: { model: "default" }, available_choices: 1 } });
  const proposalId = String(drafted.modelResult.proposal_id);
  const card = (await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0].payload_json;
  expect(card.runtime_binding).toMatchObject({ pinned_model: "default", session_config: [], conversation_launch: true });
  // A card drafted before the model was frozen is still not accepted.
  const legacy = { ...card, runtime_binding: { ...card.runtime_binding } };
  delete legacy.runtime_binding.pinned_model;
  await db.pool.query(`UPDATE proposals SET payload_json=$2::jsonb WHERE id=$1`, [proposalId, JSON.stringify(legacy)]);
  expect((await accept(proposalId)).statusCode).toBe(409);
  await db.pool.query(`UPDATE proposals SET payload_json=$2::jsonb WHERE id=$1`, [proposalId, JSON.stringify(card)]);
  expect((await accept(proposalId)).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
  const [mail] = await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  expect((await loadRunRow(runId)).contract_snapshot_json).toMatchObject({ workflow_input_json: { gmail_digest: { pinned_model: "default" } } });
  // The runtime echoes some model and no response named any: nothing is waited for, and the mail is read at once.
  const { call } = await launch(conversation.run, runId, conversation.hostId, "claude-haiku-5-5");
  const read = await call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  expect((read.body as { data: { items: { id: string }[] } }).data.items.map((item) => item.id)).toEqual([mail!.id]);
  expect(await settleAs(runId, digest.session_id, "succeeded", "Nothing concerned an application.")).toMatchObject({ session_id: digest.session_id });
  expect((await items(digest.id)).map((row) => row.status)).toEqual(["done"]);
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE run_id=$1`, [runId])).rows[0]).toEqual({ status: "delivered", error_code: null });
  // An automation frozen without a model (before it was recorded) waits for a new card.
  await db.pool.query(`UPDATE gmail_digests SET runtime_binding=runtime_binding-'pinned_model',retry_not_before=NULL,next_run_at=NULL WHERE id=$1`, [digest.id]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("waiting");
  expect((await db.pool.query(`SELECT last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].last_error_code).toBe("gmail_digest_runtime_changed");
});

it("ADR 0037: a non-Claude runtime-native configuration the owner's conversation can run (Codex CLI on its own login) is chosen on the card, accepted, scheduled, routed, reads mail, records a fact and settles", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const codex = await nativeAgent(conversation.hostId, "codex_cli", ["gpt-6.1", "gpt-6.1-mini"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  const shown = (await executionOptions(proposalId)).json().data;
  const codexConfig = shown.configurations.find((entry: { agent_id: string }) => entry.agent_id === codex.agent);
  expect(codexConfig).toMatchObject({ runtime_key: "codex_cli", backend_mode: "runtime_native", available: true, reason: null,
    models: [{ model: "gpt-6.1", name: "GPT-6.1" }, { model: "gpt-6.1-mini", name: "GPT-6.1-MINI" }] });
  const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: codex.agent, runtime_profile_id: codexConfig.runtime_profile_id, model: "gpt-6.1-mini" }));
  expect(chosen.selected).toEqual({ agent_id: codex.agent, runtime_profile_id: codexConfig.runtime_profile_id, model: "gpt-6.1-mini" });
  expect((await accept(proposalId, chosen.card_revision)).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
  expect(digest).toMatchObject({ agent_id: codex.agent, status: "active" });
  expect(digest.runtime_binding).toMatchObject({ runtime_key: "codex_cli", backend_mode: "runtime_native", pinned_model: "gpt-6.1-mini", conversation_launch: true,
    session_config: [{ id: "model", type: "select", value: "gpt-6.1-mini", category: "model" }] });
  const [mail] = await newMail(connectionId, digest.id, 1);
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(1);
  const delivery = await runningDelivery(digest.id);
  const queued = await loadRunRow(delivery.run_id);
  // Queued as the owner's conversation queues a turn: the profile, the model option applied strictly, no isolated launch.
  expect(queued.contract_snapshot_json).toMatchObject({ workflow_input_json: { gmail_digest: { kind: "application", pinned_model: "gpt-6.1-mini" } } });
  expect(JSON.stringify(queued.contract_snapshot_json)).not.toContain("model_channel");
  expect((queued.model_override_json as Record<string, unknown>).acp_session_config).toEqual([{ id: "model", type: "select", value: "gpt-6.1-mini", category: "model" }]);
  expect(await new PgRouteDecisionRepository(db.pool).routeRun(queued)).toMatchObject({ runtime_profile_id: codexConfig.runtime_profile_id, runtime_key: "codex_cli" });
  // Codex echoes its option only; nothing proves the answering model, and nothing needs to.
  const { call } = await launch(null, delivery.run_id, conversation.hostId, "gpt-6.1-mini");
  const read = await call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  const fact = await call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: (await appRow(eth)).revision,
    source: { kind: "gmail", message_id: mail!.id, received_at: iso(mail!.at) }, effect: { kind: "status", status: "interview" } });
  expect(fact.httpStatus, JSON.stringify(fact.body)).toBe(200);
  expect((await appRow(eth)).status).toBe("interview");
  expect(await settleAs(delivery.run_id, digest.session_id, "succeeded", "Recorded an interview at ETH Zurich.")).toMatchObject({ content: "Recorded an interview at ETH Zurich." });
  expect((await items(digest.id)).map((row) => row.status)).toEqual(["done"]);
});

it("ADR 0037: the owner switches the model on a new card; once accepted, the next round runs on the new choice and the earlier round's Run reads nothing more", async () => {
  const { connectionId, run, hostId, digest, proposalId } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const earlier = await runningDelivery(digest.id);
  const { call: earlierCall } = await launch(run, earlier.run_id, hostId);
  const changed = await proposeGmailApplicationUpdates(db.pool, config, run, space, { effects: ["interview"] }, randomUUID());
  const changeId = String(changed.modelResult.proposal_id);
  const shown = (await executionOptions(changeId)).json().data;
  expect(shown.selected).toMatchObject({ model: "synthetic-model-a" });
  const switched = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: changeId, agent_id: shown.selected.agent_id,
    runtime_profile_id: shown.selected.runtime_profile_id, model: "synthetic-model-b" }));
  // Until it is accepted nothing changes: the earlier round still reads on the earlier choice.
  expect((await earlierCall("source.gmail.digest.read", {})).httpStatus).toBe(200);
  expect((await accept(changeId, switched.card_revision)).statusCode).toBe(200);
  const now = (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0];
  expect(now).toMatchObject({ proposal_id: changeId, status: "active" });
  expect(now.runtime_binding).toMatchObject({ pinned_model: "synthetic-model-b", session_config: [{ id: "model", value: "synthetic-model-b" }] });
  expect(proposalId).not.toBe(changeId);
  // The earlier round ended with the rule: its Run reads nothing more and counts no attempt.
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE id=$1`, [earlier.id])).rows[0]).toEqual({ status: "failed", error_code: "gmail_digest_rule_changed" });
  expect((await earlierCall("source.gmail.digest.read", {})).httpStatus).not.toBe(200);
  await db.pool.query(`UPDATE runs SET status='cancelled' WHERE id=$1`, [earlier.run_id]);
  await releaseThread(earlier.run_id);
  await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [digest.id]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const next = await runningDelivery(digest.id);
  const queued = await loadRunRow(next.run_id);
  expect(queued.contract_snapshot_json).toMatchObject({ workflow_input_json: { gmail_digest: { rule_version: changeId, pinned_model: "synthetic-model-b" } } });
  expect((queued.model_override_json as Record<string, unknown>).acp_session_config).toEqual([{ id: "model", type: "select", value: "synthetic-model-b", category: "model" }]);
  const { call } = await launch(run, next.run_id, hostId, "synthetic-model-b");
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  expect((await items(digest.id)).every((row) => row.attempts === 0)).toBe(true);
});

it("ADR 0037: only the runtime's explicit fallback report stops a round — later reads, facts and flags are refused, nothing of the round is posted, and the owner gets one notice that what was handed out stays", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview", "rejected"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const oxford = await application("Oxford", "DPhil in Statistics");
  const [first, second] = await newMail(connectionId, digest.id, 2);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const delivery = await runningDelivery(digest.id);
  // The runtime echoes and reports another model id than the one chosen: no explicit report, so no fallback.
  const { call, tool, fallBack } = await launch(run, delivery.run_id, hostId, "synthetic-model-z");
  await db.pool.query(`UPDATE runs SET model_override_json=model_override_json||'{"runtime_reported_model":"synthetic-model-z"}'::jsonb WHERE id=$1`, [delivery.run_id]);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const apply = async (applicationId: string, message: { id: string; at: number }, status: string) => call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: applicationId,
    expected_revision: (await appRow(applicationId)).revision, source: { kind: "gmail", message_id: message.id, received_at: iso(message.at) }, effect: { kind: "status", status } });
  const recorded = await call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: (await appRow(eth)).revision,
    source: { kind: "gmail", message_id: first!.id, received_at: iso(first!.at) }, effect: { kind: "status", status: "interview" } });
  expect(recorded.httpStatus, JSON.stringify(recorded.body)).toBe(200);
  // Then the runtime reports a fallback — after mail was handed out and one fact recorded.
  await fallBack();
  const refused = await call("source.gmail.digest.read", {});
  expect(refused.httpStatus).toBe(409);
  expect(JSON.stringify(refused.body)).toContain("gmail_digest_model_fallback");
  expect((await apply(oxford, second!, "rejected")).httpStatus).toBe(404);
  expect((await appRow(oxford)).status).not.toBe("rejected");
  expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: second!.id, reason: "unclear_fact" }))).toContain("gmail_digest_unavailable");
  // A second report keeps the first.
  await fallBack("Model fallback", "later");
  expect((await loadRunRow(delivery.run_id)).model_override_json).toMatchObject({ runtime_model_fallback: { title: "Model rerouted" } });
  // Settled: the Agent's reply is not posted; one notice is, in the owner's private execution conversation.
  const notice = await settleAs(delivery.run_id, digest.session_id, "succeeded", "Recorded an interview at ETH Zurich.");
  expect(notice?.content).toContain("Automatic application updates stopped this round");
  expect(notice?.content).toContain("2 messages had already been given to the Agent before the report. Rainver cannot take back what was handed out");
  expect(await assistantMessages(delivery.run_id)).toEqual([notice!.content]);
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE id=$1`, [delivery.id])).rows[0]).toEqual({ status: "failed", error_code: "gmail_digest_model_fallback" });
  // What was recorded before the report stays; the mail waits for the next round with no attempt counted.
  expect((await appRow(eth)).status).toBe("interview");
  expect((await items(digest.id)).map((row) => [row.status, row.attempts])).toEqual([["pending", 0], ["pending", 0]]);
  expect((await db.pool.query(`SELECT failure_count,last_error_code,status FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0])
    .toEqual({ failure_count: 1, last_error_code: "gmail_digest_model_fallback", status: "active" });
  // Settling again (the finalizer retries until the turn is published) returns the same one notice and changes nothing.
  expect((await settleAs(delivery.run_id, digest.session_id, "succeeded", "Recorded an interview at ETH Zurich."))?.id).toBe(notice!.id);
  expect(await assistantMessages(delivery.run_id)).toHaveLength(1);
  expect((await db.pool.query(`SELECT failure_count FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].failure_count).toBe(1);
  // A retry that can no longer read the report (a restarted process whose Run-row write had failed) still returns that
  // notice: the delivery's own code is the durable record that the round stopped.
  const reported = (await loadRunRow(delivery.run_id)).model_override_json;
  await db.pool.query(`UPDATE runs SET model_override_json=model_override_json - 'runtime_model_fallback' WHERE id=$1`, [delivery.run_id]);
  expect((await settleAs(delivery.run_id, digest.session_id, "succeeded", "Recorded an interview at ETH Zurich."))?.id).toBe(notice!.id);
  expect(await assistantMessages(delivery.run_id)).toHaveLength(1);
  expect((await db.pool.query(`SELECT failure_count,status FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0]).toEqual({ failure_count: 1, status: "active" });
  await db.pool.query(`UPDATE runs SET model_override_json=$2::jsonb WHERE id=$1`, [delivery.run_id, JSON.stringify(reported)]);
  await releaseThread(delivery.run_id);
  // The next round runs on the chosen configuration again; three reported fallbacks in a row pause the automation.
  for (const round of [2, 3]) {
    await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [digest.id]);
    const startedAgain = await startGmailDigestDelivery(db.pool, config, digest.id);
    expect(startedAgain, JSON.stringify((await db.pool.query(`SELECT last_error_code,retry_not_before,status FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0])).toBe("started");
    const again = await runningDelivery(digest.id);
    const next = await launch(run, again.run_id, hostId);
    await next.fallBack();
    const text = (await settleAs(again.run_id, digest.session_id, "succeeded", "done"))?.content ?? "";
    await releaseThread(again.run_id);
    expect(text, String(round)).toContain("No mail had been given to the Agent before the report.");
    if (round === 3) expect(text).toContain("This happened three rounds in a row, so the automation is paused.");
  }
  expect((await db.pool.query(`SELECT failure_count,status FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0]).toEqual({ failure_count: 3, status: "paused" });
});

it("ADR 0037: earlier authorizations are kept, never widened — a ModelProvider automation confirmed to run isolated pauses for a new card, its isolated Runs read nothing, and an old card is chosen again before it is accepted", async () => {
  const { connectionId, run, digest, session } = await confirmedAutomation(["interview"]);
  const provider = randomUUID();
  await db.pool.query(`INSERT INTO model_providers (id,space_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at) VALUES ($1,$2,'Synthetic','openai_compatible','https://models.example/v1','synthetic-provider-default',true,'{}'::jsonb,'{}'::jsonb,now(),now())`, [provider, space]);
  // An automation confirmed on a ModelProvider configuration while such a configuration launched only isolated to its lease.
  const legacyBinding = { ...digest.runtime_binding, backend_mode: "model_provider", model_provider_id: provider, model_name: "synthetic-provider-a", session_config: [], pinned_model: "synthetic-provider-a" };
  delete legacyBinding.conversation_launch;
  await db.pool.query(`UPDATE gmail_digests SET runtime_binding=$2::jsonb WHERE id=$1`, [digest.id, JSON.stringify(legacyBinding)]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("waiting");
  expect((await db.pool.query(`SELECT status,last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0]).toEqual({ status: "paused", last_error_code: "gmail_digest_launch_reconfirm_required" });
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digest_deliveries WHERE digest_id=$1`, [digest.id])).rows[0].n).toBe(0);
  // The generic resume never widens it: only a new card does.
  expect((await app.inject({ method: "POST", url: `/api/v1/sources/gmail/digests/${digest.id}/status`, headers: { "idempotency-key": randomUUID() }, payload: { status: "active" } })).statusCode).toBe(409);
  // A Run started for an isolated launch (its contract says so) is of an earlier rule: it reads nothing and is ended.
  await db.pool.query(`UPDATE gmail_digests SET status='active',runtime_binding=$2::jsonb,last_error_code=NULL WHERE id=$1`, [digest.id, JSON.stringify(digest.runtime_binding)]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const isolatedRound = await runningDelivery(digest.id);
  await db.pool.query(`UPDATE runs SET contract_snapshot_json=jsonb_set(contract_snapshot_json,'{workflow_input_json,gmail_digest,model_channel}','"required"') WHERE id=$1`, [isolatedRound.run_id]);
  // Its claim is refused as a rule change, so it never launches or reads; the next start ends it without an attempt.
  expect(await new PgRunRepository(db.pool, config).checkRunExecutionAuthorization(await loadRunRow(isolatedRound.run_id)))
    .toMatchObject({ allowed: false, error_code: "gmail_digest_rule_changed" });
  expect(await readLogs(isolatedRound.run_id)).toBe(0);
  await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [isolatedRound.run_id]);
  await db.pool.query(`UPDATE gmail_digests SET status='paused' WHERE id=$1`, [digest.id]);
  await startDueGmailDigests(db.pool, config, 20, connectionId);
  await db.pool.query(`UPDATE gmail_digests SET status='active' WHERE id=$1`, [digest.id]);
  await startGmailDigestDelivery(db.pool, config, digest.id);
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE id=$1`, [isolatedRound.id])).rows[0]).toEqual({ status: "failed", error_code: "gmail_digest_rule_changed" });
  expect((await items(digest.id)).every((row) => row.attempts === 0)).toBe(true);
  // A pending card that froze a ModelProvider configuration as isolated shows no saved choice and is not accepted on it.
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, run, space, { effects: ["interview"] }, randomUUID());
  const cardId = String(drafted.modelResult.proposal_id);
  const card = (await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [cardId])).rows[0].payload_json;
  await db.pool.query(`UPDATE proposals SET payload_json=$2::jsonb WHERE id=$1`, [cardId, JSON.stringify({ ...card, runtime_binding: legacyBinding })]);
  expect((await executionOptions(cardId)).json().data.selected).toBeNull();
  const stale = await accept(cardId);
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error).toMatchObject({ metadata: { code: "gmail_digest_execution_unavailable" } });
  // Chosen again on the card, it says how it runs now; accepted, it changes the same automation in place.
  const rechosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: cardId, agent_id: card.agent_id,
    runtime_profile_id: card.runtime_binding.runtime_profile_id, model: "synthetic-model-a" }));
  expect(rechosen.summary).toContain("It runs as your own conversation with that Agent runs.");
  expect((await accept(cardId, rechosen.card_revision)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT id,status,runtime_binding->>'conversation_launch' AS conversation_launch FROM gmail_digests WHERE proposal_id=$1`, [cardId])).rows[0])
    .toEqual({ id: digest.id, status: "active", conversation_launch: "true" });
  void session;
});

it("ADR 0037 review: an earlier authorization with no new confirmation — ModelProvider or runtime-native — never claims, reads, records or settles, even a queued or running round whose contract names no isolated channel", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const [mail] = await newMail(connectionId, digest.id, 1);
  // A round started under the card in force, still queued: its contract names no model channel.
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const running = await runningDelivery(digest.id);
  expect(JSON.stringify((await loadRunRow(running.run_id)).contract_snapshot_json)).not.toContain("model_channel");
  // The automation as confirmed before cards said how it launches: a ModelProvider isolated to its lease (no
  // `conversation_launch`), whose Runs predate the contract's channel field.
  const provider = randomUUID();
  await db.pool.query(`INSERT INTO model_providers (id,space_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at) VALUES ($1,$2,'Synthetic','openai_compatible','https://models.example/v1','synthetic-model-a',true,'{}'::jsonb,'{}'::jsonb,now(),now())`, [provider, space]);
  const providerLegacy = { ...digest.runtime_binding, backend_mode: "model_provider", model_provider_id: provider, model_name: "synthetic-model-a", session_config: [] };
  delete providerLegacy.conversation_launch;
  await db.pool.query(`UPDATE gmail_digests SET runtime_binding=$2::jsonb WHERE id=$1`, [digest.id, JSON.stringify(providerLegacy)]);
  // Queued, it is never claimed or started: refused as a rule change.
  expect(await new PgRunRepository(db.pool, config).checkRunExecutionAuthorization(await loadRunRow(running.run_id))).toMatchObject({ allowed: false, error_code: "gmail_digest_rule_changed" });
  expect(await new PgRunRepository(db.pool, config).markRunRunning({ run_id: running.run_id, space_id: space, started_at: new Date().toISOString() })).toBeNull();
  // Running — claimed before the upgrade — it reads, records and flags nothing.
  await db.pool.query(`UPDATE gmail_digests SET runtime_binding=$2::jsonb WHERE id=$1`, [digest.id, JSON.stringify(digest.runtime_binding)]);
  const { call, tool } = await launch(run, running.run_id, hostId);
  await db.pool.query(`UPDATE gmail_digests SET runtime_binding=$2::jsonb WHERE id=$1`, [digest.id, JSON.stringify(providerLegacy)]);
  expect(await new PgRunRepository(db.pool, config).checkRunExecutionAuthorization(await loadRunRow(running.run_id))).toMatchObject({ allowed: false, error_code: "gmail_digest_rule_changed" });
  expect((await call("source.gmail.digest.read", {})).httpStatus).not.toBe(200);
  expect(await readLogs(running.run_id)).toBe(0);
  expect((await call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: (await appRow(eth)).revision,
    source: { kind: "gmail", message_id: mail!.id, received_at: iso(mail!.at) }, effect: { kind: "status", status: "interview" } })).httpStatus).not.toBe(200);
  expect((await appRow(eth)).status).not.toBe("interview");
  expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: mail!.id, reason: "unclear_fact" }))).toContain("gmail_digest_unavailable");
  // Settled as a rule change: nothing posted, no attempt counted, the automation's count and schedule untouched.
  expect(await settleAs(running.run_id, digest.session_id, "succeeded", "Recorded an interview.")).toBeNull();
  expect(await assistantMessages(running.run_id)).toEqual([]);
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE id=$1`, [running.id])).rows[0]).toEqual({ status: "failed", error_code: "gmail_digest_rule_changed" });
  expect((await items(digest.id)).map((row) => [row.status, row.attempts])).toEqual([["pending", 0]]);
  await releaseThread(running.run_id);
  // The next start pauses it for a new card instead of running it on the wider commitment.
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("waiting");
  expect((await db.pool.query(`SELECT status,last_error_code,failure_count FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0])
    .toEqual({ status: "paused", last_error_code: "gmail_digest_launch_reconfirm_required", failure_count: 0 });
  // A runtime-native automation confirmed while its mail was released only on proof of the answering model is no
  // narrower: it pauses the same way, and its pending card is chosen again before it is accepted.
  const nativeLegacy = { ...digest.runtime_binding };
  delete nativeLegacy.conversation_launch;
  await db.pool.query(`UPDATE gmail_digests SET status='active',last_error_code=NULL,runtime_binding=$2::jsonb WHERE id=$1`, [digest.id, JSON.stringify(nativeLegacy)]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("waiting");
  expect((await db.pool.query(`SELECT status,last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0]).toEqual({ status: "paused", last_error_code: "gmail_digest_launch_reconfirm_required" });
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digest_deliveries WHERE digest_id=$1 AND status='running'`, [digest.id])).rows[0].n).toBe(0);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, run, space, { effects: ["interview"] }, randomUUID());
  const cardId = String(drafted.modelResult.proposal_id);
  const card = (await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [cardId])).rows[0].payload_json;
  await db.pool.query(`UPDATE proposals SET payload_json=$2::jsonb WHERE id=$1`, [cardId, JSON.stringify({ ...card, runtime_binding: nativeLegacy })]);
  expect((await executionOptions(cardId)).json().data.selected).toBeNull();
  expect((await accept(cardId)).json().error).toMatchObject({ metadata: { code: "gmail_digest_execution_unavailable" } });
  const rechosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: cardId, agent_id: card.agent_id,
    runtime_profile_id: card.runtime_binding.runtime_profile_id, model: "synthetic-model-a" }));
  expect((await accept(cardId, rechosen.card_revision)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT status,runtime_binding->>'conversation_launch' AS conversation_launch FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0])
    .toEqual({ status: "active", conversation_launch: "true" });
});

/**
 * A Host whose runtime answers ACP as `claude-agent-acp` does: a session keeps its current model, `session/resume`
 * reports it, `set_config_option` switches it. `fallBackTo` makes the next prompt report the runtime's own refusal
 * fallback notice and leave the session on that model, as the pinned adapter says it does.
 */
class AcpHost implements HostFrameSink {
  sent: Record<string, unknown>[] = [];
  methods: string[] = [];
  private launchId = "";
  private runId = "";
  fallBackTo: string | null = null;
  /** `models`: the live session's picker choices, and the aliases its `set_config_option` resolves to one of them. */
  constructor(private readonly registry: HostConnectionRegistry, private readonly hostId: string, public current: string, private readonly newSession: string,
    private readonly models: { choices: string[]; aliases?: Record<string, string> } = { choices: ["synthetic-model-a", "synthetic-model-b"] }) {}
  send(frame: Record<string, unknown>) {
    this.sent.push(frame);
    const later = (work: () => void) => setTimeout(work, 0);
    if (frame.type === "launch") {
      this.launchId = String(frame.launch_id); this.runId = String(frame.run_id);
      later(() => this.registry.receiveLaunched(this.hostId, this.runId, this.launchId));
      return;
    }
    // A runtime exits when its stdin closes (the controller closes it when it stops, e.g. on a held model switch).
    if (frame.type === "terminate" || frame.type === "stdin_close") { later(() => this.registry.receiveComplete(this.hostId, this.runId, { exit_code: 0, timed_out: false, error: null }, this.launchId)); return; }
    if (frame.type !== "stdin") return;
    for (const line of String(frame.value).split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (!message.method || message.id === undefined) continue;
      this.methods.push(message.method === "session/set_config_option" ? `set_config_option:${String(message.params?.value)}` : message.method);
      const out = (payload: Record<string, unknown>) => this.registry.receiveOutput(this.hostId, this.runId, `${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`, this.launchId);
      const options = () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: this.current,
        options: this.models.choices.map((value) => ({ value, name: value })) }];
      const sessionId = String(message.params?.sessionId ?? this.newSession);
      later(() => {
        if (message.method === "initialize") out({ id: message.id, result: { protocolVersion: 1 } });
        else if (message.method === "session/new") out({ id: message.id, result: { sessionId: this.newSession, configOptions: options() } });
        else if (message.method === "session/resume") out({ id: message.id, result: { sessionId, configOptions: options() } });
        else if (message.method === "session/set_config_option") {
          this.current = this.models.aliases?.[String(message.params?.value)] ?? String(message.params?.value);
          out({ id: message.id, result: { configOptions: options() } });
        }
        else if (message.method === "session/prompt") {
          if (this.fallBackTo) {
            out({ method: "session/update", params: { sessionId, update: { sessionUpdate: "notice", severity: "warning",
              title: `${this.current} declined this request (cyber); retried with ${this.fallBackTo}. The session will continue on ${this.fallBackTo}.` } } });
            this.current = this.fallBackTo; this.fallBackTo = null;
          }
          out({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Nothing concerned an application." } } } });
          out({ id: message.id, result: { stopReason: "end_turn" } });
          setTimeout(() => this.registry.receiveComplete(this.hostId, this.runId, { exit_code: 0, timed_out: false, error: null }, this.launchId), 5);
        }
      });
    }
  }
  close() {}
}

/** The automation's execution-conversation thread: its current vendor session and those retired. */
const executionThread = async (digest: { session_id: string; agent_id: string }) => (await db.pool.query(
  `SELECT vendor_session_id,retired_vendor_session_ids FROM host_threads WHERE session_id=$1 AND agent_id=$2`, [digest.session_id, digest.agent_id])).rows[0];
/** The last settled context occupancy of that thread, as the launch's switch rule reads it (`canSwitchRetainedSessionModel`). */
const executionOccupancy = (digest: { session_id: string; agent_id: string }, tokens: number) => db.pool.query(
  `UPDATE host_threads SET context_tokens=$3,context_window_tokens=200000 WHERE session_id=$1 AND agent_id=$2`, [digest.session_id, digest.agent_id, tokens]);
/**
 * One automation round through the real Host adapter (`executeRemoteHostCliAdapter`) against `AcpHost`, with the
 * production fallback recording, settled and released as the finalizer does.
 */
async function hostAdapterRound(digest: { id: string; session_id: string }, hostId: string, current: string, newSession: string,
  fallBackTo: string | null = null, models?: ConstructorParameters<typeof AcpHost>[4]) {
  await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL,failure_count=0 WHERE id=$1`, [digest.id]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  await new PgRouteDecisionRepository(db.pool).routeRun(await loadRunRow(runId));
  expect(await new PgRunRepository(db.pool, config).markRunRunning({ run_id: runId, space_id: space, started_at: new Date().toISOString() })).not.toBeNull();
  const queuedRun = await loadRunRow(runId);
  const resume = hostThreadDispatchInputs(queuedRun).resume_session_id;
  const registry = new HostConnectionRegistry();
  const host = new AcpHost(registry, hostId, current, newSession, models);
  host.fallBackTo = fallBackTo;
  registry.registerConnection(hostId, host);
  const result = await executeRemoteHostCliAdapter({ run: queuedRun, prompt: "Check the mail.", model: null, resume_session_id: resume }, hostId, null,
    { connectionRegistry: registry, config, db: db.pool, bindings: { ...NO_PROVIDER_BINDINGS, observeModelFallback: (input) => recordRuntimeModelFallback(db.pool, input) } });
  expect(result.success, JSON.stringify(result).slice(0, 800)).toBe(true);
  await db.pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`,
    [runId, JSON.stringify({ schema_version: "run_output.v1", result: { external_session_id: (result.output_json as { external_session_id?: unknown } | undefined)?.external_session_id ?? null } })]);
  const settled = await settleAs(runId, digest.session_id, "succeeded", result.output_text || null);
  await releaseThread(runId);
  return { runId, resume, settled, methods: host.methods };
}

it("ADR 0037 review: a switched model and a reported fallback go through the conversation's own session switch or reopen on the real Host adapter — never a retained session that holds every round", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const thread = () => executionThread(digest);
  const occupancy = (tokens: number) => executionOccupancy(digest, tokens);
  const round = (current: string, newSession: string, fallBackTo: string | null = null) => hostAdapterRound(digest, hostId, current, newSession, fallBackTo);
  await newMail(connectionId, digest.id, 1);
  // Round 1, on synthetic-model-a, opens the execution conversation's session.
  const first = await round("synthetic-model-a", "vendor-1");
  expect(first.methods).toEqual(["initialize", "session/new", "session/prompt"]);
  expect((await thread()).vendor_session_id).toBe("vendor-1");
  // The owner switches to synthetic-model-b on a new card.
  const changed = await proposeGmailApplicationUpdates(db.pool, config, run, space, { effects: ["interview"] }, randomUUID());
  const changeId = String(changed.modelResult.proposal_id);
  const shown = (await executionOptions(changeId)).json().data;
  const switched = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: changeId, agent_id: shown.selected.agent_id,
    runtime_profile_id: shown.selected.runtime_profile_id, model: "synthetic-model-b" }));
  expect((await accept(changeId, switched.card_revision)).statusCode).toBe(200);
  await newMail(connectionId, digest.id, 1);
  // Round 2: the retained session is small, so it is switched in place as the conversation switches a model — and the
  // runtime reports a refusal fallback that leaves the session on synthetic-model-a.
  await occupancy(1_000);
  const second = await round("synthetic-model-a", "vendor-unused", "synthetic-model-a");
  expect(second.resume).toBe("vendor-1");
  expect(second.methods).toEqual(["initialize", "session/resume", "set_config_option:synthetic-model-b", "session/prompt"]);
  expect(second.settled?.content).toContain("Automatic application updates stopped this round");
  expect((await loadRunRow(second.runId)).model_override_json).toMatchObject({ runtime_model_fallback: { title: expect.stringContaining("retried with synthetic-model-a") } });
  expect((await thread()).vendor_session_id).toBe("vendor-1");
  // Round 3: the session stands on the fallback model and is now too full to switch in place (the launch would hold the
  // switch for a handoff, round after round): it is reopened through the owner's own reset, and the round runs on the choice.
  await occupancy(60_000);
  const third = await round("synthetic-model-a", "vendor-3");
  expect(third.resume).toBeNull();
  expect(third.methods).toEqual(["initialize", "session/new", "set_config_option:synthetic-model-b", "session/prompt"]);
  expect(await thread()).toEqual({ vendor_session_id: "vendor-3", retired_vendor_session_ids: ["vendor-1"] });
  // A round on the same model and session as the last one resumes it, full or not.
  await newMail(connectionId, digest.id, 1);
  const fourth = await round("synthetic-model-b", "vendor-unused");
  expect(fourth.resume).toBe("vendor-3");
  expect(fourth.methods).toEqual(["initialize", "session/resume", "session/prompt"]);
});

it("ADR 0037 §12: the shared session reopen and resume cover a picker alias already resolved in a full session, and a configuration without a picker after a fallback — no round fails for a handoff", async () => {
  const { run, hostId, digest, connectionId, session } = await confirmedAutomation(["interview"]);
  // The live session lists canonical ids; `alpha` and Claude's conversation default `opus` are aliases its adapter resolves.
  const models = { choices: ["synthetic-alpha-1", "synthetic-beta-1", "claude-opus-5-5"], aliases: { alpha: "synthetic-alpha-1", opus: "claude-opus-5-5" } };
  const choose = async (model: string) => {
    const changed = await proposeGmailApplicationUpdates(db.pool, config, run, space, { effects: ["interview"] }, randomUUID());
    const cardId = String(changed.modelResult.proposal_id);
    const shown = (await executionOptions(cardId)).json().data;
    const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: cardId, agent_id: shown.selected?.agent_id ?? digest.agent_id,
      runtime_profile_id: shown.selected?.runtime_profile_id ?? digest.runtime_binding.runtime_profile_id, model }));
    expect((await accept(cardId, chosen.card_revision)).statusCode).toBe(200);
    return (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0];
  };
  // The owner's conversation picker offers the alias; the card offers what it offers.
  await advertiseModels(hostId, ["alpha", "synthetic-beta-1"]);
  const onAlias = await choose("alpha");
  expect(onAlias.runtime_binding.session_config).toEqual([{ id: "model", type: "select", value: "alpha", category: "model" }]);
  await newMail(connectionId, digest.id, 1);
  const first = await hostAdapterRound(onAlias, hostId, "synthetic-beta-1", "vendor-1", null, models);
  expect(first.methods).toEqual(["initialize", "session/new", "set_config_option:alpha", "session/prompt"]);
  // The session is full now. The next round on the same alias resumes it as it stands on the alias's canonical model:
  // nothing to switch, so it is neither reopened nor held for a handoff.
  await executionOccupancy(digest, 60_000);
  await newMail(connectionId, digest.id, 1);
  const second = await hostAdapterRound(onAlias, hostId, "synthetic-alpha-1", "vendor-unused", null, models);
  expect(second.resume).toBe("vendor-1");
  expect(second.methods).toEqual(["initialize", "session/resume", "session/prompt"]);
  // The owner chooses a configuration without a picker (the runtime's own default): a change for the full session, so it
  // is reopened — and the runtime reports a fallback that leaves the new session on another model.
  await advertiseModels(hostId, []);
  await db.pool.query(`UPDATE session_conversation_backends SET session_config_json='[]'::jsonb WHERE session_id=$1`, [session]);
  const onDefault = await choose("default");
  expect(onDefault.runtime_binding.session_config).toEqual([]);
  await newMail(connectionId, digest.id, 1);
  const third = await hostAdapterRound(onDefault, hostId, "synthetic-beta-1", "vendor-3", "synthetic-beta-1", models);
  expect(third.resume).toBeNull();
  expect(third.methods).toEqual(["initialize", "session/new", "set_config_option:opus", "session/prompt"]);
  expect(third.settled?.content).toContain("Automatic application updates stopped this round");
  expect(await executionThread(digest)).toEqual({ vendor_session_id: "vendor-3", retired_vendor_session_ids: ["vendor-1"] });
  // Without a picker nothing switches the session back, and a Claude launch still sends its default, which a full
  // session on the fallback model would refuse every round: after the report it is reopened, picker or not.
  await executionOccupancy(digest, 60_000);
  await newMail(connectionId, digest.id, 1);
  const fourth = await hostAdapterRound(onDefault, hostId, "synthetic-beta-1", "vendor-4", null, models);
  expect(fourth.resume).toBeNull();
  expect(fourth.methods).toEqual(["initialize", "session/new", "set_config_option:opus", "session/prompt"]);
  expect(fourth.settled?.content ?? "").not.toContain("stopped this round");
  expect(await executionThread(digest)).toEqual({ vendor_session_id: "vendor-4", retired_vendor_session_ids: ["vendor-1", "vendor-3"] });
  // The next round, same configuration and no report, resumes it (full or not).
  await newMail(connectionId, digest.id, 1);
  const fifth = await hostAdapterRound(onDefault, hostId, "claude-opus-5-5", "vendor-unused", null, models);
  expect(fifth.resume).toBe("vendor-4");
  expect(fifth.methods).toEqual(["initialize", "session/resume", "session/prompt"]);
});

it("ADR 0037 §11: a fallback this process receives while a release, a fact or a flag waits on SQL after its check stops that step at its commit boundary; what an earlier commit handed out stays", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview", "rejected"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  // Another transaction holding a row the step takes only after its fallback check passed.
  const hold = async (sql: string, params: unknown[]) => {
    const client = await db.pool.connect();
    await client.query("BEGIN");
    await client.query(sql, params);
    return async () => { await client.query("COMMIT"); client.release(); };
  };
  const waitingOn = (fragment: string) => until(async () => (await db.pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND position($1 in query) > 0`, [fragment])).rows[0].n > 0,
  `a statement waiting on ${fragment}`);
  const round = async () => {
    await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [digest.id]);
    const [mail] = await newMail(connectionId, digest.id, 1);
    expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
    const delivery = await runningDelivery(digest.id);
    return { mail: mail!, delivery, ...await launch(run, delivery.run_id, hostId) };
  };
  const reported = async (runId: string) => expect((await loadRunRow(runId)).model_override_json).toMatchObject({ runtime_model_fallback: { title: "Model rerouted" } });
  const finish = async (runId: string) => { const notice = await settleAs(runId, digest.session_id, "succeeded", "done"); await releaseThread(runId); return notice?.content ?? ""; };

  // 1. The release has passed its check and waits for the delivery row; the report arrives (its Run-row write then waits
  // behind the release's Run lock). At its commit boundary the release is withheld: no mail reaches the Agent.
  const one = await round();
  const freeDelivery = await hold(`SELECT id FROM gmail_digest_deliveries WHERE id=$1 FOR UPDATE`, [one.delivery.id]);
  const reading = one.call("source.gmail.digest.read", {});
  await waitingOn("FOR UPDATE OF dl");
  const writing = one.fallBack();
  await freeDelivery();
  expect((await reading).httpStatus).not.toBe(200);
  await writing;
  await reported(one.delivery.run_id);
  expect(await readLogs(one.delivery.run_id)).toBe(0);
  expect(await auditRows(one.delivery.run_id)).toBe(0);
  expect(JSON.stringify((await one.call("source.gmail.digest.read", {})).body)).toContain("gmail_digest_model_fallback");
  expect(await finish(one.delivery.run_id)).toContain("No mail had been given to the Agent before the report.");

  // 2. The mail was released (committed: handed out). A fact has passed its check and waits for the Gmail connection; the
  // report arrives. The fact is refused at its commit boundary: the application is unchanged.
  const two = await round();
  expect((await two.call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const before = await appRow(eth);
  const freeConnection = await hold(`SELECT id FROM gmail_connections WHERE id=$1 FOR UPDATE`, [connectionId]);
  const applying = two.call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: before.revision,
    source: { kind: "gmail", message_id: two.mail.id, received_at: iso(two.mail.at) }, effect: { kind: "status", status: "interview" } });
  await waitingOn("FROM gmail_connections WHERE id=$1 FOR SHARE");
  const writingTwo = two.fallBack();
  await freeConnection();
  expect((await applying).httpStatus).toBe(404);
  await writingTwo;
  await reported(two.delivery.run_id);
  expect(await appRow(eth)).toEqual(before);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_phd_application.application_mail_facts WHERE project_id=$1`, [project])).rows[0].n).toBe(0);
  // The release committed before the report: it stays, and the notice names it (this round's mail and round 1's, still waiting).
  expect(await readLogs(two.delivery.run_id)).toBe(1);
  expect(await finish(two.delivery.run_id)).toContain("2 messages had already been given to the Agent before the report");

  // 3. The same for a review flag: refused at its commit boundary, the message stays waiting.
  const three = await round();
  expect((await three.call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const freeAgain = await hold(`SELECT id FROM gmail_connections WHERE id=$1 FOR UPDATE`, [connectionId]);
  const flagging = three.tool("source.gmail.application_updates.flag", { message_id: three.mail.id, reason: "unclear_fact" });
  await waitingOn("FROM gmail_connections WHERE id=$1 FOR SHARE");
  const writingThree = three.fallBack();
  await freeAgain();
  expect(JSON.stringify(await flagging)).toContain("gmail_digest_unavailable");
  await writingThree;
  await reported(three.delivery.run_id);
  expect((await items(digest.id)).find((row) => row.google_message_id === three.mail.id)).toMatchObject({ status: "pending", reason: null });
  await finish(three.delivery.run_id);
});

/**
 * A round of `providerAutomation` on the conversation's ordinary launch that reads its mail and keeps the first message
 * for review; with `fact`, it also records an interview from a second message.
 */
async function providerReviewRound(automation: { connectionId: string; hostId: string; provider: string; digest: { id: string } }, applicationId: string, fact = false) {
  await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [automation.digest.id]);
  const [mail, factMail] = await newMail(automation.connectionId, automation.digest.id, fact ? 2 : 1);
  expect(await startGmailDigestDelivery(db.pool, config, automation.digest.id)).toBe("started");
  const delivery = await runningDelivery(automation.digest.id);
  await new PgRouteDecisionRepository(db.pool).routeRun(await loadRunRow(delivery.run_id));
  const round = await launch(null, delivery.run_id, automation.hostId, "synthetic-provider-a");
  await recordRemoteRunBackend(db.pool, delivery.run_id, { provider_id: automation.provider, model: "synthetic-provider-a" }, space);
  const read = await round.call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  expect(JSON.stringify(await round.tool("source.gmail.application_updates.flag", { message_id: mail!.id, reason: "unclear_fact", candidate_application_ids: [applicationId] })))
    .toContain('"status":"review"');
  if (factMail) {
    const recorded = await round.call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: applicationId, expected_revision: (await appRow(applicationId)).revision,
      source: { kind: "gmail", message_id: factMail.id, received_at: iso(factMail.at) }, effect: { kind: "status", status: "interview" } });
    expect(recorded.httpStatus, JSON.stringify(recorded.body)).toBe(200);
  }
  return { mail: mail!, factMail, delivery, round };
}
/** As a round the previous release started on the authorization confirmed then: no `conversation_launch` on either. */
async function asPreviousReleaseRound(runId: string, digestId: string) {
  await db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- '{workflow_input_json,gmail_digest,conversation_launch}' WHERE id=$1`, [runId]);
  await db.pool.query(`UPDATE gmail_digests SET runtime_binding=runtime_binding - 'conversation_launch' WHERE id=$1`, [digestId]);
}
/** The Run ends as failed and its settlement runs (it posts nothing); its Host thread is released for the next round. */
async function failAndSettle(runId: string) {
  await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [runId]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRunRow(runId), null, async () => null)).toBeNull();
  await releaseThread(runId);
}
const mailItem = async (digestId: string, id: string) => (await items(digestId)).find((row) => row.google_message_id === id);
const deliveryRow = async (id: string) => (await db.pool.query(`SELECT status,error_code,finished_at FROM gmail_digest_deliveries WHERE id=$1`, [id])).rows[0];

it("ADR 0037 §10: with no maintenance drain, a round the previous release left in flight settles with that release's repair — its ordinary launch's review flag waits again — while a round this release started keeps its flags", async () => {
  const automation = await providerAutomation();
  const { digest } = automation;
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const item = (id: string) => mailItem(digest.id, id);
  // This release's round: its contract says it was started for the conversation's launch; its flag stays as made.
  const current = await providerReviewRound(automation, eth);
  expect((await loadRunRow(current.delivery.run_id)).contract_snapshot_json).toMatchObject({ workflow_input_json: { gmail_digest: { conversation_launch: true } } });
  await failAndSettle(current.delivery.run_id);
  expect(await item(current.mail.id)).toMatchObject({ status: "review", reason: "unclear_fact", candidate_application_ids: [eth] });
  // A round the previous release started (no marker in its contract) on the authorization confirmed then (no
  // `conversation_launch`), its server stopped by an ordinary update mid-round: the flag its ordinary launch made is
  // undone as that release's settlement undid it, the delivery ends as a rule change and nothing counts an attempt.
  const earlier = await providerReviewRound(automation, eth);
  await asPreviousReleaseRound(earlier.delivery.run_id, digest.id);
  await failAndSettle(earlier.delivery.run_id);
  expect((await deliveryRow(earlier.delivery.id)).error_code).toBe("gmail_digest_rule_changed");
  expect(await item(earlier.mail.id)).toMatchObject({ status: "pending", reason: null, candidate_application_ids: [], attempts: 0 });
  expect(await item(current.mail.id)).toMatchObject({ status: "review" });
});

it("ADR 0037 §10 review: a scheduled start that ends a previous-release round before its settlement applies that release's repair in its own transaction, once — the fact, audit and read logs stay", async () => {
  const automation = await providerAutomation();
  const { digest, connectionId } = automation;
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const item = (id: string) => mailItem(digest.id, id);
  const earlier = await providerReviewRound(automation, eth, true);
  const runId = earlier.delivery.run_id;
  await asPreviousReleaseRound(runId, digest.id);
  const facts = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM plugin_phd_application.application_mail_facts WHERE application_id=$1`, [eth])).rows[0].n as number;
  const kept = async () => ({ fact: await item(earlier.factMail!.id), facts: await facts(), audits: await auditRows(runId), logs: await readLogs(runId), application: await appRow(eth) });
  const before = await kept();
  // The fact is recorded; its message settles only with the round (it stays as it is, and a later read replays it).
  expect(before.facts).toBe(1);
  expect(before.application).toMatchObject({ status: "interview" });
  // This release's scheduler looks before the Run settles (its server was restarted by the update with the round in
  // flight): the start ends that delivery as a rule change and pauses the automation for a new card — and in the same
  // transaction its ordinary launch's flag waits again, as that release's settlement would have left it.
  await newMail(connectionId, digest.id, 1);
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(0);
  const ended = await deliveryRow(earlier.delivery.id);
  expect(ended).toMatchObject({ status: "failed", error_code: "gmail_digest_rule_changed" });
  expect((await db.pool.query(`SELECT status,last_error_code,failure_count FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0])
    .toEqual({ status: "paused", last_error_code: "gmail_digest_launch_reconfirm_required", failure_count: 0 });
  expect(await item(earlier.mail.id)).toMatchObject({ status: "pending", reason: null, candidate_application_ids: [], attempts: 0 });
  expect(await kept()).toEqual(before);
  // Its settlement afterwards finds the delivery ended and settles nothing; an owner command that ends no further
  // delivery changes nothing either: the repair is applied once.
  await failAndSettle(runId);
  await withTransaction(db.pool, (tx) => endGmailDigestIn(tx, { spaceId: space, userId: owner }, digest.id));
  expect(await deliveryRow(earlier.delivery.id)).toEqual(ended);
  expect(await item(earlier.mail.id)).toMatchObject({ status: "pending", reason: null, candidate_application_ids: [], attempts: 0 });
  expect(await kept()).toEqual(before);
});

it("ADR 0037 §10 review: a new card accepted before a previous-release round settles applies that release's repair at acceptance and the next round reads the mail again; a round this release started keeps its flag", async () => {
  const automation = await providerAutomation();
  const { digest, connectionId } = automation;
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const item = (id: string) => mailItem(digest.id, id);
  const newCard = async () => {
    const changed = await proposeGmailApplicationUpdates(db.pool, config, automation.run, space, { effects: ["interview"] }, randomUUID());
    const cardId = String(changed.modelResult.proposal_id);
    const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: cardId, agent_id: digest.agent_id,
      runtime_profile_id: digest.runtime_binding.runtime_profile_id, model: "synthetic-provider-a" }));
    const accepted = await accept(cardId, chosen.card_revision);
    expect(accepted.statusCode, accepted.body).toBe(200);
  };
  // This release's round, ended by a new card before it settles: its flag stays as made, at acceptance and after.
  const current = await providerReviewRound(automation, eth);
  await newCard();
  expect(await deliveryRow(current.delivery.id)).toMatchObject({ status: "failed", error_code: "gmail_digest_rule_changed" });
  expect(await item(current.mail.id)).toMatchObject({ status: "review", reason: "unclear_fact", candidate_application_ids: [eth] });
  await failAndSettle(current.delivery.run_id);
  expect(await item(current.mail.id)).toMatchObject({ status: "review" });
  // A previous-release round, ended by the owner's new card before it settles: the acceptance applies the repair.
  const earlier = await providerReviewRound(automation, eth);
  await asPreviousReleaseRound(earlier.delivery.run_id, digest.id);
  const logs = await readLogs(earlier.delivery.run_id), audits = await auditRows(earlier.delivery.run_id);
  await newCard();
  expect(await deliveryRow(earlier.delivery.id)).toMatchObject({ status: "failed", error_code: "gmail_digest_rule_changed" });
  expect(await item(earlier.mail.id)).toMatchObject({ status: "pending", reason: null, candidate_application_ids: [], attempts: 0 });
  expect(await item(current.mail.id)).toMatchObject({ status: "review", reason: "unclear_fact", candidate_application_ids: [eth] });
  expect([await readLogs(earlier.delivery.run_id), await auditRows(earlier.delivery.run_id)]).toEqual([logs, audits]);
  await failAndSettle(earlier.delivery.run_id);
  expect(await item(earlier.mail.id)).toMatchObject({ status: "pending", attempts: 0 });
  // The mail is no longer stranded: the next round of the new card takes it.
  await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [digest.id]);
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(1);
  const next = await runningDelivery(digest.id);
  expect((await db.pool.query(`SELECT message_ids FROM gmail_digest_deliveries WHERE id=$1`, [next.id])).rows[0].message_ids).toEqual([earlier.mail.id]);
  expect((await db.pool.query(`SELECT last_delivery_id FROM gmail_digest_mail_items WHERE digest_id=$1 AND google_message_id=$2`, [digest.id, earlier.mail.id])).rows[0].last_delivery_id)
    .toBe(next.id);
});

it("ADR 0037 §7 review: the combined Gmail card never lists an earlier authorization awaiting a new card as already allowed — it drafts the application part again, changing that automation in place", async () => {
  const { run, digest } = await confirmedAutomation(["interview"]);
  expect((await proposeGmailSetup(db.pool, config, run, space, { application_updates: { effects: ["interview"] } }, randomUUID())).modelResult)
    .toMatchObject({ ok: true, already_allowed: ["application_updates"] });
  // As confirmed before cards said it runs as the conversation runs: still active until its next start pauses it.
  await db.pool.query(`UPDATE gmail_digests SET runtime_binding=runtime_binding - 'conversation_launch' WHERE id=$1`, [digest.id]);
  const redrafted = await proposeGmailSetup(db.pool, config, run, space, { application_updates: { effects: ["interview"] } }, randomUUID());
  expect(redrafted.modelResult, JSON.stringify(redrafted.modelResult)).toMatchObject({ ok: true, reused: [] });
  expect(redrafted.modelResult).not.toHaveProperty("already_allowed");
  const card = (await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [redrafted.modelResult.proposal_id])).rows[0].payload_json;
  expect(card.parts).toEqual([expect.objectContaining({ kind: "application", replaces_digest_id: digest.id })]);
});

it("taints a Run that only reads the ledger or the automation's outcomes, and keeps its arguments and results out of event logs", async () => {
  const { PRIVATE_TOOL_CALL_ACTIONS } = await import("../src/modules/runtimeAdapters/privateToolCalls.js");
  expect(PRIVATE_TOOL_CALL_ACTIONS).toEqual(expect.arrayContaining(["plugin.phd_application.mail_fact.list", "source.gmail.application_updates.list"]));
  const { run, session } = await confirmedAutomation(["interview"]);
  const plugins = async (id: string) => ((await loadRunRow(id)).context_taint_json as { plugin_reads?: unknown[] } | null)?.plugin_reads ?? [];
  // A fresh private conversation of the Project that never read Gmail and holds no earlier read.
  const other = randomUUID();
  await db.pool.query(`INSERT INTO sessions (id,space_id,user_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [other, space, owner, project]);
  const ledgerTurn = await ownerTurn(run, other, ["plugin.phd_application.mail_fact.list"]);
  expect(await plugins(ledgerTurn)).toEqual([]);
  const read = await toolCall(await loadRunRow(ledgerTurn), "plugin.phd_application.mail_fact.list", { project_id: project });
  expect(read instanceof OperationToolResponse ? read.httpStatus : read, JSON.stringify(read)).toBe(200);
  expect(await plugins(ledgerTurn)).toEqual([{ plugin_id: "core:gmail_digest", data_class: "sensitive", owner_user_id: owner }]);
  // The conversation tool listing per-message outcomes holds the same.
  const listTurn = await ownerTurn(run, other, ["source.gmail.application_updates.list"]);
  expect((await listGmailApplicationUpdates(db.pool, listTurn, space)).modelResult).toMatchObject({ ok: true });
  expect(await plugins(listTurn)).toEqual(expect.arrayContaining([{ plugin_id: "core:gmail_digest", data_class: "sensitive", owner_user_id: owner }]));
  // From then on that Run's outward writes are refused (ADR 0030 §7): here, an ordinary Applications write.
  const { sensitiveTaintEgressContext } = await import("../src/modules/plugins/egress.js");
  expect(await sensitiveTaintEgressContext(db.pool, space, ledgerTurn, { id: "plugin.phd_application.application.create", side_effects: "durable" }))
    .toEqual({ sensitive_plugin_read_taint: true, outward_action: true });
  void session;
});

it("ends a running delivery of another rule version — none recorded before an upgrade — without counting an attempt, and starts the current one", async () => {
  const { connectionId, run, digest, session } = await confirmedAutomation(["interview"]);
  const [mail] = await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const old = await runningDelivery(digest.id);
  // As a Run started before deliveries carried their rule version: it is not even claimed any more.
  await db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- '{workflow_input_json,gmail_digest,rule_version}' WHERE id=$1`, [old.run_id]);
  await db.pool.query(`UPDATE runs target SET runtime_profile_id=source.runtime_profile_id,runtime_key=source.runtime_key,runtime_profile_snapshot_json=source.runtime_profile_snapshot_json
      FROM runs source WHERE target.id=$1 AND source.id=$2`, [old.run_id, run]);
  expect(await new PgRunRepository(db.pool, config).markRunRunning({ run_id: old.run_id, space_id: space, started_at: new Date().toISOString() })).toBeNull();
  const loadRun = () => loadRunRow(old.run_id);
  // Its settlement (here a failed Run) ends the delivery, counting nothing on the mail or the automation.
  await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [old.run_id]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRun(), null, async () => null)).toBeNull();
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE id=$1`, [old.id])).rows[0]).toEqual({ status: "failed", error_code: "gmail_digest_rule_changed" });
  expect((await items(digest.id))[0]).toMatchObject({ google_message_id: mail!.id, status: "pending", attempts: 0 });
  expect((await db.pool.query(`SELECT failure_count,retry_not_before FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0]).toEqual({ failure_count: 0, retry_not_before: null });
  // One still running when the scheduler next looks is ended by the start, which then starts this version.
  const ended = await loadRun();
  expect((await recordHostThreadOutcome(config, ended.host_task_thread_id!, ended, false)).claim).toBe("released");
  await db.pool.query(`INSERT INTO run_events (id,space_id,run_id,event_index,event_type,status,summary,metadata_json,created_at)
    VALUES ($1,$2,$3,9999,'chat_completed','failed','',$4::jsonb,now())`, [randomUUID(), space, ended.id, "{}"]);
  await db.pool.query(`UPDATE gmail_digest_deliveries SET status='running',error_code=NULL,finished_at=NULL WHERE id=$1`, [old.id]);
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBe(1);
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE id=$1`, [old.id])).rows[0]).toEqual({ status: "failed", error_code: "gmail_digest_rule_changed" });
  const current = await runningDelivery(digest.id);
  expect(current.id).not.toBe(old.id);
  expect((await items(digest.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
  void session;
});

it("admits concurrent facts of one Run and a disconnect racing them without a deadlock, and refuses facts once the connection is gone", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview", "rejected"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const oxford = await application("University of Oxford", "DPhil in Engineering");
  const [first, second, third] = await newMail(connectionId, digest.id, 3);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call } = await launch(run, runId, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const apply = async (applicationId: string, message: Mail, status: string) => call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: applicationId,
    expected_revision: (await appRow(applicationId)).revision, source: { kind: "gmail", message_id: message.id, received_at: iso(message.at) }, effect: { kind: "status", status } });
  // Two facts of the same Run at once: each holds the Run FOR SHARE and reads its taint without upgrading.
  const [a, b] = await Promise.all([apply(eth, first!, "interview"), apply(oxford, second!, "rejected")]);
  expect([a.httpStatus, b.httpStatus], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
  // A fact racing the owner's disconnect: one commits first; neither deadlocks, and afterwards nothing is recorded.
  const [fact, disconnected] = await Promise.all([
    apply(eth, third!, "rejected"),
    action("source.gmail.connection.disconnect", { connection_id: connectionId }),
  ]);
  expect([200, 404]).toContain(fact.httpStatus);
  expect(disconnected.statusCode, disconnected.body).toBe(200);
  expect((await apply(oxford, third!, "rejected")).httpStatus).toBe(404);
});

/** Holds Gmail's full-message answers until `open()` (the read is then inside its Gmail page, past its proof wait). */
function holdGmailMessages(delayMs?: number) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let reached!: () => void;
  const fetching = new Promise<void>((resolve) => { reached = resolve; });
  vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
    if (/\/messages\/[0-9a-f]+\?/.test(String(url)) && new URL(String(url)).searchParams.get("format") === "full") {
      reached();
      // A slow answer ends when the request is aborted, as a real fetch does.
      await (delayMs === undefined ? opened : new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
      }));
    }
    return stub(String(url), init);
  });
  return { open, fetching };
}
const readLogs = async (runId: string) => (await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1`, [runId])).rows[0].n as number;
const lockWaiters = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n as number;
async function until(condition: () => Promise<boolean>, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!await condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it("stores each Run tool token with the launch it is issued for: in a relaunch's window, with real Run token authentication, the new token is its own launch and never the earlier one", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { launchId } = await launch(run, runId, hostId);
  const identities = new PgRunToolIdentityRepository(db.pool);
  const read = (token: string) => callRunTool(config, runId, token, "source.gmail.digest.read", {});
  // The first launch's token, issued with its nonce (bound on the attempt).
  const l1 = launchId();
  const first = await identities.issue({ id: runId, space_id: space }, 60_000, null, l1);
  expect((await identities.resolve(first, runId))?.launch_id).toBe(l1);
  // A relaunch issues its token for its new nonce before binding that nonce on the attempt. In that window the
  // attempt still names the earlier launch, which may read — yet the new token resolves to its
  // own launch only, so its request is not admitted as the earlier launch's; the earlier token stops at once.
  const l2 = randomUUID();
  const second = await identities.issue({ id: runId, space_id: space }, 60_000, null, l2);
  expect(await identities.resolve(first, runId)).toBeNull();
  expect((await identities.resolve(second, runId))?.launch_id).toBe(l2);
  expect((await read(first)).statusCode).toBe(401);
  const early = await read(second);
  expect(early.statusCode, early.body).toBe(409);
  expect(early.body).toContain("gmail_digest_runtime_changed");
  expect(early.body).not.toContain(BODY_MARK);
  expect(await readLogs(runId)).toBe(0);
  // Bound, the same token's launch reads.
  expect(await new PgRunRepository(db.pool, config).bindAttemptLaunch({ space_id: space, run_id: runId, launch_id: l2, expected_launch_id: l1,
    isolation: { host_id: hostId, host_kind: "server", egress_profile: "default", sandbox_mode: "read_write" } as never })).toBe(true);
  const bound = await read(second);
  expect(bound.statusCode, bound.body).toBe(200);
  expect((await db.pool.query(`SELECT launch_id FROM agent_data_read_logs WHERE run_id=$1`, [runId])).rows).toEqual([{ launch_id: l2 }]);
  // A token without a launch (a row from before tokens carried one, that the upgrade could not bind) never resolves.
  await db.pool.query(`UPDATE run_tool_identities SET launch_id=NULL WHERE run_id=$1`, [runId]);
  expect(await identities.resolve(second, runId)).toBeNull();
  expect((await read(second)).statusCode).toBe(401);
});

it("binds a mail read, its release, facts and flags to the launch the request came from: a relaunch never admits an earlier launch's request", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const [mail] = await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call, tool, relaunch, launchId } = await launch(run, runId, hostId);
  const first = launchId();
  // In flight: the first launch's read is inside Gmail when the Run is relaunched. The earlier request's release is
  // withheld: no mail, no log.
  const held = holdGmailMessages();
  const inFlight = call("source.gmail.digest.read", {}, first);
  await held.fetching;
  const second = await relaunch();
  held.open();
  const withheld = await inFlight;
  expect(withheld.httpStatus, JSON.stringify(withheld.body)).not.toBe(200);
  expect(JSON.stringify(withheld.body)).not.toContain(BODY_MARK);
  expect(await readLogs(runId)).toBe(0);
  expect((await db.pool.query(`SELECT message_count FROM gmail_digest_deliveries WHERE run_id=$1`, [runId])).rows[0].message_count).toBe(0);
  // Nor does a new request of the earlier launch read, record or flag anything; the current launch does.
  expect((await call("source.gmail.digest.read", {}, first)).httpStatus).toBe(409);
  const current = await call("source.gmail.digest.read", {}, second);
  expect(current.httpStatus, JSON.stringify(current.body)).toBe(200);
  const fact = (from: string) => call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: 1,
    source: { kind: "gmail", message_id: mail!.id, received_at: iso(mail!.at) }, effect: { kind: "status", status: "interview" } }, from);
  expect((await fact(first)).httpStatus).toBe(404);
  expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: mail!.id, reason: "unclear_fact" }, first))).toContain("gmail_digest_unavailable");
  expect((await fact(second)).httpStatus).toBe(200);
  expect(await appRow(eth)).toMatchObject({ status: "interview" });
});

it("holds the Gmail page to the read's one end-to-end budget, inside the caller's 65-second timeout", async () => {
  // `toolRequestTimeoutMs` (packages/agent-cli/src/toolRequest.ts) gives this tool 65 s; 10 s stay for the release and response.
  expect(GMAIL_DIGEST_READ_BUDGET_MS).toBeLessThanOrEqual(65_000 - 10_000);
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  __setGmailDigestReadBudgetForTests(1_500);
  const { call } = await launch(run, runId, hostId);
  // Gmail answers slowly: the read ends within its one budget (a timeout, no mail).
  holdGmailMessages(4_000);
  const started = Date.now();
  const slow = await call("source.gmail.digest.read", {});
  // The page the budget ended is the 504 timeout with its own code and guidance, not a generic 503.
  expect(slow.httpStatus, JSON.stringify(slow.body)).toBe(504);
  expect(slow.body).toMatchObject({ error: { metadata: { code: "gmail_upstream_timeout" } } });
  expect(JSON.stringify(slow.body)).toContain("Gmail did not answer within this read's time limit");
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(await readLogs(runId)).toBe(0);
});

it("takes the Project before the Run for a fact as the next page's release does: concurrent across pages, no deadlock", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const mails = await newMail(connectionId, digest.id, 11);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call } = await launch(run, runId, hostId);
  const page1 = await call("source.gmail.digest.read", {});
  expect(page1.httpStatus, JSON.stringify(page1.body)).toBe(200);
  const token = (page1.body as { data: { next_page_token: string | null } }).data.next_page_token;
  expect(token).toBeTruthy();
  // Interleave deterministically: a reader holds the Run FOR SHARE, so page 2's release waits for the Run
  // FOR UPDATE while holding the Project FOR SHARE; then page 1's fact starts. Locking the Run before the
  // Project, the fact would hold the Run FOR SHARE and wait for that Project: a deadlock once the reader ends.
  const blocker = await db.pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM runs WHERE id=$1 FOR SHARE", [runId]);
    const page2 = call("source.gmail.digest.read", { page_token: token });
    await until(async () => await lockWaiters() >= 1, "page 2's release to wait for the Run");
    const fact = call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: 1,
      source: { kind: "gmail", message_id: mails[0]!.id, received_at: iso(mails[0]!.at) }, effect: { kind: "status", status: "interview" } });
    await until(async () => await lockWaiters() >= 2, "the fact to wait");
    await blocker.query("COMMIT");
    const [second, recorded] = await Promise.all([page2, fact]);
    expect([second.httpStatus, recorded.httpStatus], JSON.stringify([second.body, recorded.body])).toEqual([200, 200]);
    expect((second.body as { data: { items: unknown[] } }).data.items).toHaveLength(1);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  expect(await appRow(eth)).toMatchObject({ status: "interview" });
});

it("ends an earlier rule version's delivery after a disconnect, and one frozen before its model was pinned, without counting an attempt", async () => {
  // Disconnected while an earlier version's Run is still running: the rule ended it, not its mail.
  const first = await confirmedAutomation(["interview"]);
  await newMail(first.connectionId, first.digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, first.digest.id)).toBe("started");
  const old = await runningDelivery(first.digest.id);
  await db.pool.query(`UPDATE runs SET contract_snapshot_json=jsonb_set(contract_snapshot_json,'{workflow_input_json,gmail_digest,rule_version}','"an-earlier-card"') WHERE id=$1`, [old.run_id]);
  await ok(action("source.gmail.connection.disconnect", { connection_id: first.connectionId }));
  await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [old.run_id]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRunRow(old.run_id), null, async () => null)).toBeNull();
  expect((await db.pool.query(`SELECT error_code FROM gmail_digest_deliveries WHERE id=$1`, [old.id])).rows[0].error_code).toBe("gmail_digest_rule_changed");
  expect((await items(first.digest.id))[0]).toMatchObject({ attempts: 0 });
  expect((await db.pool.query(`SELECT failure_count FROM gmail_digests WHERE id=$1`, [first.digest.id])).rows[0].failure_count).toBe(0);
});

it("never claims a Run whose contract lacks the confirmed model, ends it at the next start, and counts no attempt", async () => {
  const { connectionId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const old = await runningDelivery(digest.id);
  // As a Run started before Runs carried their confirmed model (the merged baseline): current rule version, no model.
  await db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- '{workflow_input_json,gmail_digest,pinned_model}' WHERE id=$1`, [old.run_id]);
  const authorization = await new PgRunRepository(db.pool, config).checkRunExecutionAuthorization(await loadRunRow(old.run_id));
  expect(authorization).toMatchObject({ allowed: false, error_code: "gmail_digest_rule_changed" });
  // The scheduler is not held by it; the start ends it without an attempt and starts the current one.
  await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [old.run_id]);
  expect(await startDueGmailDigests(db.pool, config, 20, connectionId)).toBeGreaterThanOrEqual(0);
  expect((await db.pool.query(`SELECT status,error_code FROM gmail_digest_deliveries WHERE id=$1`, [old.id])).rows[0]).toEqual({ status: "failed", error_code: "gmail_digest_rule_changed" });
  expect((await items(digest.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
});

it("counts a failed delivery against its mail only when a launch of its Run actually had it", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const unproven = await runningDelivery(digest.id);
  // The launch failed before it read anything: the runtime failed, not the mail.
  await launch(run, unproven.run_id, hostId);
  await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [unproven.run_id]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRunRow(unproven.run_id), null, async () => null)).toBeNull();
  expect((await db.pool.query(`SELECT error_code FROM gmail_digest_deliveries WHERE id=$1`, [unproven.id])).rows[0].error_code).toBe("gmail_digest_run_failed");
  expect((await items(digest.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
  expect((await db.pool.query(`SELECT failure_count FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].failure_count).toBe(1);
});

it("ADR 0036: opens the card although the conversation's own binding cannot run it, names each candidate's reason, and lets only the owner choose another Agent and model, frozen in their private execution conversation", async () => {
  await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  // This conversation's Agent runs on a runtime its Host has no installation of: its private conversation cannot run it now.
  await useRuntime(conversation.agent, conversation.run, "codex_cli");
  await db.pool.query(`UPDATE session_conversation_backends SET runtime_key_snapshot='codex_cli',session_config_json='[]'::jsonb WHERE session_id=$1`, [conversation.session]);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  expect(drafted.modelResult).toMatchObject({ ok: true, execution: { preselected: null, available_choices: 0, unavailable_choices: 1 } });
  expect(String(drafted.modelResult.next_step)).toContain("lists each configuration with the reason");
  const proposalId = String(drafted.modelResult.proposal_id);
  const card = (await db.pool.query(`SELECT summary,payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0];
  expect(card.payload_json.runtime_binding).toBeNull();
  expect(card.summary).toContain("No Agent and model is chosen yet");
  expect((await accept(proposalId)).json().error).toMatchObject({ metadata: { code: "gmail_digest_execution_unselected" } });

  // Another Agent of the Project that its owner's conversation can run, with two models in its picker.
  const other = await ownerConversation(conversation.hostId);
  const options = (id = proposalId) => app.inject({ method: "GET", url: `/api/v1/queries/source.gmail.application_updates.execution_options?input=${encodeURIComponent(JSON.stringify({ proposal_id: id }))}` });
  const listed = await options();
  expect(listed.statusCode, listed.body).toBe(200);
  expect(listed.json().data).toMatchObject({ applies: true, selected: null, scope: { mailbox_email: expect.any(String), effects: ["interview"], results_to: "private", reader_count: 0 } });
  expect(modelRows(listed.json().data).map((row) => [row.agent_id, row.model, row.available, row.reason])).toEqual([
    [conversation.agent, null, false, "runtime_unavailable"],
    [other.agent, "synthetic-model-a", true, null],
    [other.agent, "synthetic-model-b", true, null],
  ]);
  const profile = listed.json().data.configurations[1].runtime_profile_id;
  // Only the owner sees and changes their card; an unavailable candidate is never chosen.
  as(admin);
  expect((await options()).statusCode).toBe(404);
  expect((await action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: other.agent, runtime_profile_id: profile, model: "synthetic-model-b" })).statusCode).toBe(404);
  as(owner);
  const refused = await action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: conversation.agent,
    runtime_profile_id: listed.json().data.configurations[0].runtime_profile_id, model: "synthetic-model-a" });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toMatchObject({ metadata: { code: "gmail_digest_execution_unavailable", reason: "runtime_unavailable" } });
  const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: other.agent, runtime_profile_id: profile, model: "synthetic-model-b" }));
  expect(chosen).toMatchObject({ selected: { agent_id: other.agent, model: "synthetic-model-b" }, summary: expect.stringContaining("synthetic-model-b") });
  const revised = (await db.pool.query(`SELECT id,status,summary,payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0];
  expect(revised).toMatchObject({ status: "pending", payload_json: { agent_id: other.agent, session_id: conversation.session, runtime_binding: { pinned_model: "synthetic-model-b", runtime_key: "claude_code" } } });
  expect(revised.summary).toContain("synthetic-model-b");

  // Acceptance rechecks the choice: once its Host went offline it is refused with why; back online it is frozen.
  await db.pool.query(`UPDATE hosts SET status='offline' WHERE id=$1`, [other.hostId]);
  const offline = await accept(proposalId);
  expect(offline.statusCode).toBe(409);
  expect(offline.json().error).toMatchObject({ metadata: { code: "gmail_digest_execution_unavailable" } });
  expect(offline.json().error.message).toContain("offline");
  await db.pool.query(`UPDATE hosts SET status='online',last_heartbeat_at=now() WHERE id=$1`, [other.hostId]);
  const accepted = await accept(proposalId);
  expect(accepted.statusCode, accepted.body).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
  expect(digest).toMatchObject({ agent_id: other.agent, runtime_binding: { pinned_model: "synthetic-model-b" } });
  expect(digest.session_id).not.toBe(conversation.session);
  expect((await db.pool.query(`SELECT agent_id,session_config_json FROM session_conversation_backends WHERE session_id=$1`, [digest.session_id])).rows)
    .toEqual([{ agent_id: other.agent, session_config_json: [{ id: "model", type: "select", value: "synthetic-model-b", category: "model" }] }]);
  // The conversation it was asked in is untouched, and a decided card is no longer changed.
  expect((await db.pool.query(`SELECT runtime_key_snapshot FROM session_conversation_backends WHERE session_id=$1`, [conversation.session])).rows[0].runtime_key_snapshot).toBe("codex_cli");
  expect((await action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: other.agent, runtime_profile_id: profile, model: "synthetic-model-a" })).statusCode).toBe(409);

  // With no Agent of its own on the Project's list, the Project's Assistant is the default.
  await db.pool.query(`UPDATE project_agent_links SET status='removed',removed_at=now() WHERE project_id=$1`, [project]);
  await db.pool.query(`UPDATE agents SET agent_kind='system_assistant',project_id=$2 WHERE id=$1`, [other.agent, project]);
  const assistantCard = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  expect(assistantCard.modelResult).toMatchObject({ ok: true, execution: { preselected: { model: "synthetic-model-b" } } });
  const assistantOptions = (await options(String(assistantCard.modelResult.proposal_id))).json().data;
  expect(assistantOptions.selected).toMatchObject({ agent_id: other.agent });
  expect(new Set(assistantOptions.configurations.map((row: { agent_kind: string }) => row.agent_kind))).toEqual(new Set(["system_assistant"]));
});

it("ADR 0036: the combined card's application part is chosen the same way, its line redrawn in the one card, and accepted on the choice", async () => {
  await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const drafted = await proposeGmailSetup(db.pool, config, conversation.run, space, { read: true, application_updates: { effects: ["offer"] } }, randomUUID());
  expect(drafted.modelResult, JSON.stringify(drafted)).toMatchObject({ ok: true });
  const proposalId = String(drafted.modelResult.proposal_id);
  const before = (await db.pool.query(`SELECT summary,payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0];
  expect(before.summary).toContain("synthetic-model-a");
  expect(before.payload_json.parts[0].card_summary).toContain("synthetic-model-a");
  const listed = await app.inject({ method: "GET", url: `/api/v1/queries/source.gmail.application_updates.execution_options?input=${encodeURIComponent(JSON.stringify({ proposal_id: proposalId }))}` });
  expect(listed.json().data).toMatchObject({ applies: true, selected: { model: "synthetic-model-a" }, scope: { effects: ["offer"], results_to: "private" } });
  const profile = listed.json().data.configurations[0].runtime_profile_id;
  await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: conversation.agent, runtime_profile_id: profile, model: "synthetic-model-b" }));
  const after = (await db.pool.query(`SELECT summary,payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0];
  expect(after.summary).toContain("synthetic-model-b");
  expect(after.summary).toContain("On request: Agents may read and search");
  expect(after.payload_json.parts[0]).toMatchObject({ runtime_binding: { pinned_model: "synthetic-model-b" }, card_summary: expect.stringContaining("synthetic-model-b") });
  const accepted = await accept(proposalId);
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect((await db.pool.query(`SELECT runtime_binding FROM gmail_digests WHERE proposal_id=$1 AND kind='application'`, [proposalId])).rows[0].runtime_binding).toMatchObject({ pinned_model: "synthetic-model-b" });
});

// ---------------------------------------------------------------------------
// Regressions of the first review of ADR 0036 (one or more per finding)
// ---------------------------------------------------------------------------

const executionOptions = (proposalId: string) =>
  app.inject({ method: "GET", url: `/api/v1/queries/source.gmail.application_updates.execution_options?input=${encodeURIComponent(JSON.stringify({ proposal_id: proposalId }))}` });
/** The page of the card's candidates that `cursor` (a page's `next_cursor`) starts. */
const executionOptionsAt = (proposalId: string, cursor: string) =>
  app.inject({ method: "GET", url: `/api/v1/queries/source.gmail.application_updates.execution_options?input=${encodeURIComponent(JSON.stringify({ proposal_id: proposalId, cursor }))}` });
/** Makes the conversation's Agent the Project's own Assistant (off the Project's list, as an Assistant is). */
async function makeProjectAssistant(agent: string) {
  await db.pool.query(`UPDATE project_agent_links SET status='removed',removed_at=now() WHERE project_id=$1 AND agent_id=$2`, [project, agent]);
  await db.pool.query(`UPDATE agents SET agent_kind='system_assistant',project_id=$2 WHERE id=$1`, [agent, project]);
}
const removeFromProject = (agent: string) =>
  db.pool.query(`UPDATE project_agent_links SET status='removed',removed_at=now() WHERE project_id=$1 AND agent_id=$2`, [project, agent]);

it("ADR 0036 review: the Project's Assistant chosen on the card is confirmed, scheduled and read for end to end in the owner's private execution conversation", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  await makeProjectAssistant(conversation.agent);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  expect(drafted.modelResult).toMatchObject({ ok: true, execution: { preselected: { model: "synthetic-model-a" } } });
  const proposalId = String(drafted.modelResult.proposal_id);
  expect((await accept(proposalId)).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
  expect(digest).toMatchObject({ agent_id: conversation.agent, status: "active" });
  // The scheduler starts its turn on the Assistant (the person's own chat stays closed to it), owner-only.
  const mail = await newMail(connectionId, digest.id, 2);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const delivery = await runningDelivery(digest.id);
  expect((await db.pool.query(`SELECT agent_id,session_id,trigger_origin,visibility,owner_user_id FROM runs WHERE id=$1`, [delivery.run_id])).rows[0])
    .toEqual({ agent_id: conversation.agent, session_id: digest.session_id, trigger_origin: "automation", visibility: "private", owner_user_id: owner });
  // The Run exactly as the scheduler queued it: it requests the execution conversation's profile the card froze and
  // pins its model; the dispatcher's own routing (`routeRun`, as the orchestrator runs it) then resolves its runtime
  // and snapshot from that request — never copied from the drafting Run here.
  const profile = (await db.pool.query(`SELECT id FROM agent_runtime_profiles WHERE agent_id=$1 AND is_default`, [conversation.agent])).rows[0].id;
  expect(digest.runtime_binding).toMatchObject({ runtime_profile_id: profile, runtime_key: "claude_code", pinned_model: "synthetic-model-a" });
  const queued = await loadRunRow(delivery.run_id);
  expect(queued).toMatchObject({ requested_runtime_profile_id: profile, runtime_profile_id: null, runtime_profile_snapshot_json: null });
  expect((queued.model_override_json as { acp_session_config?: unknown }).acp_session_config).toMatchObject([{ id: "model", value: "synthetic-model-a" }]);
  const routed = await new PgRouteDecisionRepository(db.pool).routeRun(queued);
  expect(routed).toMatchObject({ runtime_profile_id: profile, runtime_key: "claude_code" });
  expect(routed.runtime_profile_snapshot_json).toMatchObject({ runtime_key: "claude_code", execution_host_id: conversation.hostId });
  // Its mail is released to that Run only after its launch proved the confirmed model. Synthetic Host: the echoed
  // option, the launch binding and the model proof are recorded here as the ACP controller would; no runtime runs.
  const { call } = await launch(null, delivery.run_id, conversation.hostId);
  const read = await call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  expect((read.body as { data: { items: { id: string }[] } }).data.items.map((item) => item.id)).toEqual(mail.map((m) => m.id));
  expect(await readLogs(delivery.run_id)).toBe(1);
});

it("ADR 0036 review: another Project's Assistant is never admitted to the owner's automation turn", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  await makeProjectAssistant(conversation.agent);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  expect((await accept(proposalId)).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
  const otherProject = randomUUID();
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Other','active',now(),now())`, [otherProject, space, owner]);
  await db.pool.query(`UPDATE agents SET project_id=$2 WHERE id=$1`, [conversation.agent, otherProject]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("waiting");
  expect((await db.pool.query(`SELECT last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].last_error_code).toBe("gmail_digest_agent_not_in_project");
  expect(await runningDelivery(digest.id)).toBeUndefined();
});

it("ADR 0036 review: an Agent removed from the Project starts nothing and has no mail released, whatever its earlier turns", async () => {
  const { connectionId, agent, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  // Removed before the start: the execution conversation's earlier turns keep nothing running.
  await removeFromProject(agent);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("waiting");
  expect((await db.pool.query(`SELECT last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].last_error_code).toBe("gmail_digest_agent_not_in_project");
  expect(await runningDelivery(digest.id)).toBeUndefined();
  // Added again, it starts; removed while its Run is running, its mail is not released.
  await new PgProjectAgentRepository(db.pool).upsertActive({ spaceId: space, projectId: project, agentId: agent, userId: owner });
  await db.pool.query(`UPDATE gmail_digests SET retry_not_before=NULL WHERE id=$1`, [digest.id]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const delivery = await runningDelivery(digest.id);
  const { call } = await launch(run, delivery.run_id, hostId);
  await removeFromProject(agent);
  const refused = await call("source.gmail.digest.read", {});
  expect(refused.httpStatus).toBe(409);
  expect(JSON.stringify(refused.body)).toContain("gmail_digest_agent_not_in_project");
  expect(await readLogs(delivery.run_id)).toBe(0);
});

it("ADR 0036 review: acceptance is bound to the card revision the owner saw — never one changed in another tab, nor one without a revision", async () => {
  await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  const shown = (await executionOptions(proposalId)).json().data;
  expect(shown).toMatchObject({ selected: { model: "synthetic-model-a" }, next_cursor: null, card_revision: await cardRevision(proposalId) });
  // Another tab chooses another model: the first tab's revision no longer applies.
  const key = randomUUID();
  const select = () => app.inject({ method: "POST", url: "/api/v1/actions/source.gmail.application_updates.select_execution", headers: { "idempotency-key": key },
    payload: { proposal_id: proposalId, agent_id: conversation.agent, runtime_profile_id: shown.configurations[0].runtime_profile_id, model: "synthetic-model-b" } });
  const other = await ok(select());
  expect(other.card_revision).not.toBe(shown.card_revision);
  const stale = await accept(proposalId, shown.card_revision);
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error).toMatchObject({ metadata: { code: "proposal_revision_changed" } });
  const unbound = await accept(proposalId, null);
  expect(unbound.statusCode).toBe(409);
  expect(unbound.json().error).toMatchObject({ metadata: { code: "gmail_card_revision_required" } });
  expect((await db.pool.query(`SELECT status FROM proposals WHERE id=$1`, [proposalId])).rows[0].status).toBe("pending");
  expect((await accept(proposalId, other.card_revision)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT runtime_binding FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0].runtime_binding).toMatchObject({ pinned_model: "synthetic-model-b" });
  // A decided card shows no choices any more; a replayed choice is shown again, but only while the owner reads the Project.
  expect((await executionOptions(proposalId)).json().error).toMatchObject({ metadata: { code: "gmail_card_not_pending" } });
  expect((await select()).statusCode).toBe(200);
  await db.pool.query(`UPDATE projects SET owner_user_id=$2 WHERE id=$1`, [project, peer]);
  await db.pool.query(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [project, owner]);
  expect((await select()).statusCode).toBe(404);
  expect((await executionOptions(proposalId)).statusCode).toBe(404);
});

it("ADR 0036 review: a card freezes the rule it changes — an older card never overwrites a newer rule or revives an ended one", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const draft = async () => String((await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID())).modelResult.proposal_id);
  const first = await draft(), second = await draft();
  expect((await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [first])).rows[0].payload_json).toMatchObject({ replaces_digest_id: null, replaces_proposal_id: null });
  expect((await accept(first)).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [first])).rows[0];
  // Drafted when there was none: it would overwrite the rule accepted since.
  const overwrite = await accept(second);
  expect(overwrite.statusCode).toBe(409);
  expect(overwrite.json().error).toMatchObject({ metadata: { code: "gmail_digest_changed" } });
  // A change card is drafted against this version; once the owner ended the rule it revives nothing.
  const change = await draft();
  expect((await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [change])).rows[0].payload_json).toMatchObject({ replaces_digest_id: digest.id, replaces_proposal_id: first });
  const unversioned = await draft();
  await db.pool.query(`UPDATE proposals SET payload_json=payload_json-'replaces_digest_id'-'replaces_proposal_id' WHERE id=$1`, [unversioned]);
  await withTransaction(db.pool, (tx) => endGmailDigestIn(tx, { spaceId: space, userId: owner }, digest.id));
  for (const card of [change, unversioned]) {
    const revived = await accept(card);
    expect(revived.statusCode).toBe(409);
    expect(revived.json().error).toMatchObject({ metadata: { code: "gmail_digest_changed" } });
  }
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digests WHERE gmail_connection_id=$1 AND status<>'ended'`, [connectionId])).rows[0].n).toBe(0);
  // A card drafted before cards froze the version, after the rule had ended: a new automation, as it said.
  const later = await draft();
  await db.pool.query(`UPDATE proposals SET payload_json=payload_json-'replaces_digest_id'-'replaces_proposal_id' WHERE id=$1`, [later]);
  expect((await accept(later)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT id FROM gmail_digests WHERE proposal_id=$1 AND status='active'`, [later])).rows[0].id).not.toBe(digest.id);
});

it("ADR 0036 review: of two first cards, the second never starts the rule again once the first was accepted and ended; one drafted after the end still does", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const draft = async () => String((await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID())).modelResult.proposal_id);
  const a = await draft(), b = await draft();
  for (const card of [a, b]) expect((await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [card])).rows[0].payload_json).toMatchObject({ replaces_digest_id: null, replaces_proposal_id: null });
  expect((await accept(a)).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [a])).rows[0];
  await withTransaction(db.pool, (tx) => endGmailDigestIn(tx, { spaceId: space, userId: owner }, digest.id));
  // No automation is live now, but one was since B was drafted: "none" was B's version, and it no longer holds.
  const revived = await accept(b);
  expect(revived.statusCode).toBe(409);
  expect(revived.json().error).toMatchObject({ metadata: { code: "gmail_digest_changed" } });
  expect((await db.pool.query(`SELECT status FROM proposals WHERE id=$1`, [b])).rows[0].status).toBe("pending");
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digests WHERE gmail_connection_id=$1 AND status<>'ended'`, [connectionId])).rows[0].n).toBe(0);
  // A first card drafted after the owner ended the rule is a new automation, as it says.
  const fresh = await draft();
  expect((await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [fresh])).rows[0].payload_json).toMatchObject({ replaces_digest_id: null });
  expect((await accept(fresh)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT id FROM gmail_digests WHERE proposal_id=$1 AND status='active'`, [fresh])).rows[0].id).not.toBe(digest.id);
});

it("ADR 0036 review: a card whose choice is made on it says so on every Proposal entry; an ordinary summary card does not", async () => {
  await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const card = String((await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID())).modelResult.proposal_id);
  const combined = await proposeGmailSetup(db.pool, config, conversation.run, space, { read: true, application_updates: { effects: ["offer"] } }, randomUUID());
  const setupCard = String((combined.modelResult as { proposal_id?: string }).proposal_id ?? "");
  const summary = await proposeGmailDigest(db.pool, conversation.run, space, { kind: "daily", local_time: "08:00", time_zone: "Europe/London" }, randomUUID());
  const summaryCard = String((summary.modelResult as { proposal_id?: string }).proposal_id ?? "");
  const detail = async (id: string) => (await app.inject({ method: "GET", url: `/api/v1/proposals/${id}` })).json();
  expect((await detail(card)).chosen_on_card).toBe(true);
  expect((await detail(setupCard)).chosen_on_card).toBe(true);
  expect((await detail(summaryCard)).chosen_on_card).toBeUndefined();
  // The detail page offers the choice only to the card's owner: the DTO names the canonical owner of the row, although a
  // strict Gmail payload (standalone or combined) carries no owner field of its own.
  for (const id of [card, setupCard, summaryCard]) {
    expect(Object.keys((await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [id])).rows[0].payload_json)).not.toContain("owner_user_id");
    const shown = ProposalOutSchema.parse(await detail(id));
    expect(shown).toMatchObject({ visibility: "private", owner_user_id: owner });
  }
  const listed = (await app.inject({ method: "GET", url: `/api/v1/proposals?status=pending&limit=50` })).json().items as { id: string; chosen_on_card?: boolean; owner_user_id: string | null }[];
  expect(listed.find((row) => row.id === card)).toMatchObject({ chosen_on_card: true, owner_user_id: owner });
  expect(listed.find((row) => row.id === setupCard)).toMatchObject({ chosen_on_card: true, owner_user_id: owner });
  // Naming the owner opens nothing to anyone else: another member reads neither the card nor its choices.
  as(peer);
  for (const id of [card, setupCard]) {
    expect((await app.inject({ method: "GET", url: `/api/v1/proposals/${id}` })).statusCode).toBe(404);
    expect((await executionOptions(id)).statusCode).toBe(404);
  }
  as(owner);
  const home = await new PgFrontendSupportService(db.pool).homeSummary({ spaceId: space, userId: owner }, { pending_preview_limit: "50" } as never);
  const homeRows = home.pending_proposals.items as { id: string; chosen_on_card: boolean }[];
  expect(homeRows.find((row) => row.id === card)?.chosen_on_card).toBe(true);
  expect(homeRows.find((row) => row.id === summaryCard)?.chosen_on_card).toBe(false);
});

it("ADR 0036 review: past 200 available candidates the Project's Assistant is still on the first page and chosen there, and a candidate on a later page is reached by its cursor, chosen and accepted", async () => {
  await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  // Every model below is available: 9 Agents × 25 models = 225 rows of ordinary Agents (226 with the model saved in the
  // drafting conversation, offered for its Agent too) before the Assistant would come.
  const models = Array.from({ length: 25 }, (_, index) => `synthetic-model-${String(index).padStart(2, "0")}`);
  await advertiseModels(conversation.hostId, models);
  const agents: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const extra = await ownerConversation(conversation.hostId);
    agents.push(extra.agent);
  }
  const assistant = await ownerConversation(conversation.hostId);
  await makeProjectAssistant(assistant.agent);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  // The drafting conversation's own Agent and saved model stay the default (the Assistant only when no Agent of the Project's can).
  expect((await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0].payload_json).toMatchObject({ agent_id: conversation.agent });
  const first = (await executionOptions(proposalId)).json().data;
  // A page is at most 200 rows — a configuration and each of its models one each — and never splits a configuration.
  expect(first.configurations.reduce((n: number, c: { models: unknown[] }) => n + 1 + c.models.length, 0)).toBeLessThanOrEqual(200);
  expect(first.next_cursor).toMatch(/^[01]\.\d{20}\.[A-Za-z0-9_-]+\.\d+$/);
  const assistantRows = modelRows(first).filter((row) => row.agent_kind === "system_assistant" && row.available);
  expect(assistantRows).toHaveLength(25);
  expect(modelRows(first).every((row) => row.available)).toBe(true);
  // The Assistant is chosen on the first page.
  await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: assistant.agent, runtime_profile_id: assistantRows[3]!.runtime_profile_id, model: assistantRows[3]!.model }));
  // Every page continues the one before; together they list every candidate once, the last Agent's last model included —
  // also when an Agent shown on an earlier page leaves the Project between pages (the cursor is keyed, not an offset:
  // the page continuing mid-Agent still continues that Agent at its next candidate).
  expect(modelRows(first).filter((row) => row.agent_id === agents[0])).toHaveLength(25);
  await removeFromProject(agents[0]!);
  const seen = new Set<string>(modelRows(first).map((row) => `${row.agent_id}|${row.model}`));
  let cursor: string | null = first.next_cursor;
  let pages = 1;
  const later: ExecutionModelRow[] = [];
  while (cursor) {
    const page = (await executionOptionsAt(proposalId, cursor)).json().data;
    for (const row of modelRows(page)) { seen.add(`${row.agent_id}|${row.model}`); later.push(row); }
    cursor = page.next_cursor;
    pages += 1;
    expect(pages).toBeLessThan(10);
  }
  expect(seen.size).toBe(10 * 25 + 1);
  const last = later.find((row) => row.agent_id === agents[agents.length - 1] && row.model === models[models.length - 1]);
  expect(last).toBeDefined();
  // A candidate found only on a later page is chosen, shown first on the card's first page, and accepted.
  const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: last!.agent_id, runtime_profile_id: last!.runtime_profile_id, model: last!.model }));
  // Its whole configuration is shown first, and the saved choice is echoed on both levels.
  expect(chosen.configurations[0]).toMatchObject({ agent_id: last!.agent_id, runtime_profile_id: last!.runtime_profile_id });
  expect(chosen.configurations[0].models.map((m: { model: string }) => m.model)).toContain(last!.model);
  expect(chosen.selected).toEqual({ agent_id: last!.agent_id, runtime_profile_id: last!.runtime_profile_id, model: last!.model });
  expect((await accept(proposalId, chosen.card_revision)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT agent_id,runtime_binding FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0])
    .toMatchObject({ agent_id: last!.agent_id, runtime_binding: { pinned_model: last!.model } });
});
it("ADR 0036 review: a long Agent list never displaces the Project's Assistant or hides a configuration silently, and a choice is checked by itself", async () => {
  await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  // Fifty Agents on the Project's list first, none of which can run it; then one that can, past what the card lists.
  for (let index = 0; index < 50; index += 1) {
    const filler = randomUUID();
    await seedAgentWithVersion(db.pool, { agent: filler, version: randomUUID(), space, owner, name: `Filler ${index}`, seedDefaultRuntimeProfile: false });
    await new PgProjectAgentRepository(db.pool).upsertActive({ spaceId: space, projectId: project, agentId: filler, userId: owner });
  }
  await removeFromProject(conversation.agent);
  await new PgProjectAgentRepository(db.pool).upsertActive({ spaceId: space, projectId: project, agentId: conversation.agent, userId: owner });
  const assistant = await ownerConversation(conversation.hostId);
  await makeProjectAssistant(assistant.agent);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  const listed = (await executionOptions(proposalId)).json().data;
  // The drafting conversation's own Agent is preselected, checked by itself although the first page stops before it
  // (the Assistant and 49 Agents): it is shown first, and the rest of the list continues on the next page.
  expect(listed.selected).toMatchObject({ agent_id: conversation.agent, model: "synthetic-model-a" });
  expect(modelRows(listed)[0]).toMatchObject({ agent_id: conversation.agent, model: "synthetic-model-a" });
  expect(listed.next_cursor).toMatch(/^1\./);
  // Agents shown on the first page leave the Project before the next page is read: nothing after them is skipped.
  const firstPageFillers = [...new Set(modelRows(listed).filter((row) => row.agent_kind === "standard" && row.agent_id !== conversation.agent)
    .map((row) => row.agent_id))] as string[];
  expect(firstPageFillers).toHaveLength(49);
  for (const agent of firstPageFillers.slice(0, 3)) await removeFromProject(agent);
  const next = (await executionOptionsAt(proposalId, listed.next_cursor)).json().data;
  expect(modelRows(next).map((row) => [row.agent_id === conversation.agent ? "drafting" : "filler", row.model]))
    .toEqual([["filler", null], ["drafting", "synthetic-model-a"], ["drafting", "synthetic-model-b"]]);
  expect(next.next_cursor).toBeNull();
  // The Agent the cursor names leaves too: the same cursor continues at the next Agent, from its first candidate.
  await removeFromProject(next.configurations[0].agent_id);
  const again = (await executionOptionsAt(proposalId, listed.next_cursor)).json().data;
  expect(modelRows(again).map((row) => [row.agent_id === conversation.agent ? "drafting" : "filler", row.model]))
    .toEqual([["drafting", "synthetic-model-a"], ["drafting", "synthetic-model-b"]]);
  const assistantRows = modelRows(listed).filter((row) => row.agent_kind === "system_assistant");
  expect(assistantRows.map((row) => [row.model, row.available])).toEqual([["synthetic-model-a", true], ["synthetic-model-b", true]]);
  // Choosing the Assistant, and then the unlisted Agent's other model, works and is accepted.
  await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: assistant.agent, runtime_profile_id: assistantRows[1]!.runtime_profile_id, model: "synthetic-model-b" }));
  const profile = (await db.pool.query(`SELECT id FROM agent_runtime_profiles WHERE agent_id=$1 AND is_default`, [conversation.agent])).rows[0].id;
  await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: conversation.agent, runtime_profile_id: profile, model: "synthetic-model-b" }));
  expect((await accept(proposalId)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT agent_id,runtime_binding FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0])
    .toMatchObject({ agent_id: conversation.agent, runtime_binding: { pinned_model: "synthetic-model-b" } });
});

// ---------------------------------------------------------------------------
// Two levels on the card: a configuration (Agent + runtime profile), then one of its models
// ---------------------------------------------------------------------------

it("two levels: a configuration's reason is given once and every model its picker offers is listed under it; the saved choice is echoed on both levels by acceptance's own check, and concurrent choices bind acceptance to the revision that won", async () => {
  await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  await advertiseModels(conversation.hostId, ["default", "opus", "synthetic-model-a", "synthetic-model-b", "synthetic-model-c"]);
  // Another Agent of the Project on the owner's own paired Host, which is offline: its picker would offer the same models,
  // but the whole configuration cannot run it, so it is said once, with no models.
  const offline = await ownerConversation(conversation.hostId);
  const paired = randomUUID();
  await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,environment_kind,name,kind,status,last_heartbeat_at,capabilities_json,created_at,updated_at)
    SELECT $2,$3,machine_id,'linux_native','Laptop','remote','offline',now()-interval '1 day',capabilities_json,now(),now() FROM hosts WHERE id=$1`, [conversation.hostId, paired, owner]);
  await db.pool.query(`UPDATE agent_runtime_profiles SET execution_host_id=$2 WHERE agent_id=$1 AND is_default`, [offline.agent, paired]);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  expect(drafted.modelResult).toMatchObject({ execution: { available_choices: 5, unavailable_choices: 1 } });
  const shown = (await executionOptions(proposalId)).json().data;
  const profile = (await db.pool.query(`SELECT id FROM agent_runtime_profiles WHERE agent_id=$1 AND is_default`, [conversation.agent])).rows[0].id;
  expect(shown.configurations).toEqual([
    expect.objectContaining({ agent_id: conversation.agent, runtime_profile_id: profile, runtime_key: "claude_code", available: true, reason: null, omitted_models: 0,
      models: ["default", "opus", "synthetic-model-a", "synthetic-model-b", "synthetic-model-c"].map((model) => ({ model, name: model })) }),
    expect.objectContaining({ agent_id: offline.agent, available: false, reason: "host_offline", models: [] }),
  ]);
  // The saved choice names both levels: its configuration and its model.
  expect(shown.selected).toEqual({ agent_id: conversation.agent, runtime_profile_id: profile, model: "synthetic-model-a" });
  // A model of a configuration that cannot run it is never chosen; a model its picker does not offer is not offered.
  const offlineProfile = shown.configurations[1].runtime_profile_id;
  for (const [agent, runtimeProfile, model, reason] of [[offline.agent, offlineProfile, "synthetic-model-a", "host_offline"], [conversation.agent, profile, "synthetic-model-x", undefined]] as const) {
    const refused = await action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: agent, runtime_profile_id: runtimeProfile, model });
    expect(refused.statusCode, model).toBe(409);
    expect(refused.json().error).toMatchObject({ metadata: { code: "gmail_digest_execution_unavailable", ...(reason ? { reason } : {}) } });
  }
  // Two choices sent at once (two tabs), each of a model other than the one shown: the card takes one at a time — a choice
  // racing another is either saved after it or refused as retryable. A card's revision is its content (`proposalRevisionSql`:
  // payload and summary), not a counter: each saved answer names the revision of the card holding its own choice, the card
  // now holds the choice saved last, and acceptance takes exactly the revision of what the card holds — the revision shown
  // before either and a choice it replaced are refused, so nothing is accepted that the owner was not shown last.
  const select = (model: string) => action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: conversation.agent, runtime_profile_id: profile, model });
  const answers = await Promise.all([select("synthetic-model-b"), select("synthetic-model-c")]);
  const saved = answers.filter((answer) => answer.statusCode === 200).map((answer) => answer.json().data as { card_revision: string; selected: { model: string } });
  for (const answer of answers.filter((answer) => answer.statusCode !== 200)) expect(answer.json().error, answer.body).toMatchObject({ code: "idempotency_in_progress", retryable: true });
  expect(saved.length).toBeGreaterThan(0);
  const current = await cardRevision(proposalId);
  const won = (await executionOptions(proposalId)).json().data.selected.model as string;
  expect(saved.map((answer) => answer.selected.model)).toContain(won);
  // Same content, same revision; another content, another revision — whichever order the two were saved in.
  for (const answer of saved) expect(answer.card_revision === current, answer.selected.model).toBe(answer.selected.model === won);
  expect(shown.card_revision).not.toBe(current);
  for (const stale of [shown.card_revision, ...saved.filter((answer) => answer.selected.model !== won).map((answer) => answer.card_revision)]) {
    expect((await accept(proposalId, stale)).json().error).toMatchObject({ metadata: { code: "proposal_revision_changed" } });
  }
  // Choosing the shown model again restores the shown content, so its revision is the card's again (a counter would have
  // moved on); choosing the winner again brings back the winner's revision. The card is left holding the winner.
  expect((await ok(select("synthetic-model-a"))).card_revision).toBe(shown.card_revision);
  expect(await cardRevision(proposalId)).toBe(shown.card_revision);
  expect((await ok(select(won))).card_revision).toBe(current);
  expect(await cardRevision(proposalId)).toBe(current);
  // A saved binding that is no longer exactly what its configuration offers is not echoed, and acceptance refuses it by
  // the same check: what the card shows as chosen is what can be accepted.
  const card = (await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [proposalId])).rows[0].payload_json;
  await db.pool.query(`UPDATE proposals SET payload_json=jsonb_set(payload_json,'{runtime_binding,session_config,0,id}','"other-option"') WHERE id=$1`, [proposalId]);
  expect((await executionOptions(proposalId)).json().data.selected).toBeNull();
  const unechoed = await accept(proposalId);
  expect(unechoed.statusCode).toBe(409);
  expect(unechoed.json().error).toMatchObject({ metadata: { code: "gmail_digest_execution_unavailable" } });
  await db.pool.query(`UPDATE proposals SET payload_json=$2::jsonb WHERE id=$1`, [proposalId, JSON.stringify(card)]);
  expect((await accept(proposalId)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT runtime_binding FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0].runtime_binding).toMatchObject({ pinned_model: won });
});

it("ADR 0036 §9: past 200 models of one configuration every model is reached by its keyed cursor, and the saved one is always listed with its configuration", async () => {
  await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  // 205 full model ids in the Host's picker; the asking conversation's saved model (synthetic-model-a) comes after them.
  const models = Array.from({ length: 205 }, (_, index) => `synthetic-model-${String(index).padStart(3, "0")}`);
  await advertiseModels(conversation.hostId, models);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  const own = (data: { configurations: { agent_id: string; models: { model: string }[]; omitted_models: number; models_cursor: string | null }[] }) =>
    data.configurations.find((c) => c.agent_id === conversation.agent)!;
  const first = (await executionOptions(proposalId)).json().data;
  // The default is the asking conversation's model, the 206th: listed with its configuration although past the first 200.
  expect(first.selected).toEqual({ agent_id: conversation.agent, runtime_profile_id: expect.any(String), model: "synthetic-model-a" });
  const listed = own(first);
  expect(listed.models).toHaveLength(201);
  expect(listed.models[0]!.model).toBe("synthetic-model-a");
  expect(listed.models.slice(1).map((m) => m.model)).toEqual(models.slice(0, 200));
  expect(listed.omitted_models).toBe(6);
  expect(listed.models_cursor).toEqual(expect.any(String));
  // A model removed from the picker before the next page skips nothing after it: the cursor names the model listed last.
  await advertiseModels(conversation.hostId, models.filter((model) => model !== "synthetic-model-010"));
  const more = (selection: { runtime_profile_id: string }, cursor: string) => app.inject({ method: "GET", url: `/api/v1/queries/source.gmail.application_updates.execution_options?input=${encodeURIComponent(JSON.stringify({
    proposal_id: proposalId, models_of: { agent_id: conversation.agent, runtime_profile_id: selection.runtime_profile_id, models_cursor: cursor } }))}` });
  const next = (await more(first.selected, listed.models_cursor!)).json().data;
  expect(next.next_cursor).toBeNull();
  expect(next.card_revision).toBe(first.card_revision);
  expect(next.configurations).toHaveLength(1);
  expect(own(next)).toMatchObject({ omitted_models: 0, models_cursor: null });
  expect(own(next).models.map((m) => m.model)).toEqual([...models.slice(200), "synthetic-model-a"]);
  expect(next.models_restarted).toBeUndefined();
  // The model the cursor continued after (the 200th listed) is itself removed: its old place now names a later model, so
  // the answer lists that configuration's models from the first again — saying so — and none is skipped.
  await advertiseModels(conversation.hostId, models.filter((model) => model !== "synthetic-model-010" && model !== "synthetic-model-199"));
  const restarted = (await more(first.selected, listed.models_cursor!)).json().data;
  expect(restarted.models_restarted).toBe(true);
  const fresh = own(restarted).models.map((m) => m.model);
  expect(fresh[0]).toBe("synthetic-model-a");
  expect(fresh.slice(1)).toEqual(models.filter((model) => model !== "synthetic-model-010" && model !== "synthetic-model-199").slice(0, 200));
  expect(fresh).toEqual(expect.arrayContaining(["synthetic-model-200", "synthetic-model-201"]));
  expect(own(restarted)).toMatchObject({ omitted_models: 4, models_cursor: expect.any(String) });
  await advertiseModels(conversation.hostId, models.filter((model) => model !== "synthetic-model-010"));
  // A model of the second page is chosen; the card then lists it first wherever it falls, and is accepted on it.
  const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: conversation.agent, runtime_profile_id: first.selected.runtime_profile_id, model: "synthetic-model-203" }));
  expect(own(chosen).models[0]!.model).toBe("synthetic-model-203");
  expect(own((await executionOptions(proposalId)).json().data).models[0]!.model).toBe("synthetic-model-203");
  expect((await accept(proposalId, chosen.card_revision)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT runtime_binding FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0].runtime_binding).toMatchObject({ pinned_model: "synthetic-model-203" });
});

it("a non-Claude configuration admitted through the public paths: OpenCode on a ModelProvider is chosen, accepted and run in the background on the conversation's own launch, its lease held to the chosen model; Codex CLI on a Provider is never offered", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const hostId = conversation.hostId;
  // The built-in strict Host (seeded `kind = 'server'`) reports an OpenCode copy and its daemon's model-only channel —
  // Host-side and synthetic, as its heartbeat would report them. No OpenCode, daemon or Provider runs here.
  await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,opencode}',$2::jsonb)||'{"model_channel":1}'::jsonb WHERE id=$1`,
    [hostId, JSON.stringify([{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, options: null, health_check_protocol: "acp" }])]);
  // The Provider and each Profile through the public commands, so Profile admission (`assertBackendModeBinding`, the Host,
  // installation and grant checks) decides what exists: nothing is written around it.
  const made = async (response: ReturnType<typeof action>) => { const r = await response; expect(r.statusCode, r.body).toBe(201); return r.json().data; };
  const provider = await made(action("provider.create", { name: "Synthetic", provider_type: "openai", base_url: "https://models.example/v1",
    openai_compatible_base_url: "https://models.example/v1", api_key: "sk-synthetic-fixture", default_model: "synthetic-provider-default" })) as { id: string };
  const profileOn = async (agent: string, body: Record<string, unknown>) => action("agent.runtime_profile.create", {
    agent_id: agent, name: `${String(body.runtime_key)} on Synthetic`, backend_mode: "model_provider", model_provider_id: provider.id, model_name: "synthetic-provider-a",
    execution_host_id: hostId, workspace_mode: "managed", runtime_installation: "managed:1.0.0", ...body });
  const openCode = await ownerConversation(hostId);
  const openCodeProfile = (await made(profileOn(openCode.agent, { runtime_key: "opencode", is_default: true }))).profile_id as string;
  // Codex CLI cannot be bound to a ModelProvider (its catalog: `cli_profile` only): admission refuses the Profile, and one
  // written around admission (an older row) is listed with that reason, never offered.
  const codex = await ownerConversation(hostId);
  const refusedProfile = await profileOn(codex.agent, { runtime_key: "codex_cli" });
  expect(refusedProfile.statusCode, refusedProfile.body).toBe(422);
  expect(refusedProfile.body).toContain("does not support model_provider mode");
  await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_key='codex_cli',backend_mode='model_provider',model_provider_id=$2,model_name='synthetic-provider-a' WHERE agent_id=$1 AND is_default`, [codex.agent, provider.id]);

  // The built-in Host's in-network proxy listener, as the server sets it when it starts (`providers/proxy/server.ts`).
  setProviderProxyBaseUrlForProcess("http://server:8021", null);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  const configurationOf = async (agent: string) =>
    (await executionOptions(proposalId)).json().data.configurations.find((c: { agent_id: string; runtime_key: string }) => c.agent_id === agent && c.runtime_key !== "claude_code");
  expect(await configurationOf(codex.agent)).toMatchObject({ runtime_key: "codex_cli", available: false, reason: "provider_unsupported", models: [] });
  // Its configuration carries the one model its lease is held to, checked as the lease checks it.
  expect(await configurationOf(openCode.agent)).toMatchObject({
    runtime_profile_id: openCodeProfile, runtime_key: "opencode", backend_mode: "model_provider", available: true, reason: null,
    models: [{ model: "synthetic-provider-a", name: null }],
  });
  // What production would refuse is never offered: a Provider without the endpoint its protocol needs, or one not usable
  // here any more.
  await ok(action("provider.update", { provider_id: provider.id, openai_compatible_base_url: null }));
  expect(await configurationOf(openCode.agent)).toMatchObject({ available: false, reason: "provider_endpoint_missing", models: [] });
  await ok(action("provider.update", { provider_id: provider.id, openai_compatible_base_url: "https://models.example/v1", enabled: false }));
  expect(await configurationOf(openCode.agent)).toMatchObject({ available: false, reason: "provider_unavailable" });
  await ok(action("provider.update", { provider_id: provider.id, enabled: true }));
  // ADR 0037: it launches as the conversation launches it, so neither a Host without the model-only channel nor a
  // profile working in a shared Workspace Location keeps it from being offered.
  await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json-'model_channel' WHERE id=$1`, [hostId]);
  expect(await configurationOf(openCode.agent)).toMatchObject({ available: true, reason: null });
  const folder = randomUUID(), location = randomUUID();
  await db.pool.query(`INSERT INTO project_folders (id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES ($1,$2,$3,'repo','code','active',false,false,now(),now())`, [folder, space, project]);
  await db.pool.query(`INSERT INTO workspace_locations (id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,execution_ready,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'server','/workspace/repo',true,'active',now(),now())`, [location, space, folder, hostId]);
  await db.pool.query(`UPDATE agent_runtime_profiles SET workspace_mode='location',workspace_location_id=$2 WHERE id=$1`, [openCodeProfile, location]);
  expect(await configurationOf(openCode.agent)).toMatchObject({ runtime_profile_id: openCodeProfile, available: true, reason: null });
  await db.pool.query(`UPDATE agent_runtime_profiles SET workspace_mode='managed',workspace_location_id=NULL WHERE id=$1`, [openCodeProfile]);

  const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: openCode.agent, runtime_profile_id: openCodeProfile, model: "synthetic-provider-a" }));
  expect(chosen.selected).toEqual({ agent_id: openCode.agent, runtime_profile_id: openCodeProfile, model: "synthetic-provider-a" });
  const accepted = await accept(proposalId, chosen.card_revision);
  expect(accepted.statusCode, accepted.body).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
  expect(digest).toMatchObject({ agent_id: openCode.agent, status: "active", runtime_binding: {
    runtime_profile_id: openCodeProfile, runtime_key: "opencode", backend_mode: "model_provider", model_provider_id: provider.id, pinned_model: "synthetic-provider-a", session_config: [] } });

  expect(digest.runtime_binding).toMatchObject({ conversation_launch: true });

  // The scheduler starts it; the dispatcher's own routing resolves the frozen OpenCode profile, and its launch is the
  // conversation's ordinary one: no model-only channel is selected for it.
  const mail = await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const delivery = await runningDelivery(digest.id);
  const routed = await new PgRouteDecisionRepository(db.pool).routeRun(await loadRunRow(delivery.run_id));
  expect(routed).toMatchObject({ runtime_profile_id: openCodeProfile, runtime_key: "opencode" });
  const runRow = await loadRunRow(delivery.run_id);
  expect(runRow.contract_snapshot_json).toMatchObject({ workflow_input_json: { gmail_digest: { kind: "application", pinned_model: "synthetic-provider-a" } } });
  expect(JSON.stringify(runRow.contract_snapshot_json)).not.toContain("model_channel");
  await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json||'{"model_channel":1}'::jsonb WHERE id=$1`, [hostId]);
  expect(await selectModelChannelLaunch(db.pool, hostId, runRow, true)).toBeNull();
  const fullReads = () => google.calls.filter((c) => c.url.includes("format=full")).length;

  // Late: the launch's nonce is bound, but its lease has not bound a model yet.
  const { call, relaunch, launchId } = await launch(null, delivery.run_id, hostId, "synthetic-provider-a");
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(409);
  // Another model bound for the launch (a Provider default that moved): nothing either — nothing switches silently.
  await recordRemoteRunBackend(db.pool, delivery.run_id, { provider_id: provider.id, model: "synthetic-provider-default" }, space);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(409);
  expect(fullReads()).toBe(0);
  // The lease itself, built as the Host adapter builds it for this Run on ordinary egress: held to the chosen model,
  // refused before any lease once the profile names another one.
  const leases = new ProviderProxyLeaseRegistry();
  const allow = async () => ({ status: "allow" as const, policy_decision_record_id: null });
  const lease = async () => {
    const run = await loadRunRow(delivery.run_id);
    const bound = await resolveRemoteRunBinding(db.pool, run);
    expect(bound).toMatchObject({ provider_id: provider.id });
    return buildRemoteProviderBinding({ config, run, hostId, runtimeKey: "opencode", binding: bound!, scope: await resolveRuntimeProfileScope(db.pool, run, null),
      ttlSeconds: 60, leaseRegistry: leases, db: db.pool, enforcer: allow as never });
  };
  await db.pool.query(`UPDATE runs SET runtime_profile_snapshot_json=runtime_profile_snapshot_json||'{"model_name":"synthetic-provider-default"}'::jsonb WHERE id=$1`, [delivery.run_id]);
  await expect(lease()).rejects.toMatchObject({ code: "gmail_application_model_required" });
  expect(leases.size()).toBe(0);
  await db.pool.query(`UPDATE runs SET runtime_profile_snapshot_json=runtime_profile_snapshot_json||'{"model_name":"synthetic-provider-a"}'::jsonb WHERE id=$1`, [delivery.run_id]);
  const binding = await lease();
  try {
    expect(binding.used_model).toBe("synthetic-provider-a");
    expect(binding.model_channel ?? null).toBeNull();
    // A request of an earlier launch is never admitted on a later one's lease.
    const earlier = launchId();
    await relaunch();
    await recordRemoteRunBackend(db.pool, delivery.run_id, { provider_id: provider.id, model: binding.used_model }, space);
    expect((await call("source.gmail.digest.read", {}, earlier)).httpStatus).toBe(409);
    expect(fullReads()).toBe(0);
    const read = await call("source.gmail.digest.read", {});
    expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
    expect((read.body as { data: { items: { id: string }[] } }).data.items.map((item) => item.id)).toEqual(mail.map((m) => m.id));
    expect(await readLogs(delivery.run_id)).toBe(1);
  } finally {
    binding.revoke();
  }
});

/** An OpenCode-on-ModelProvider automation on the built-in strict Host, confirmed through the public paths (as the §9 case). */
async function providerAutomation() {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const conversation = await ownerConversation();
  const hostId = conversation.hostId;
  await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,opencode}',$2::jsonb)||'{"model_channel":1}'::jsonb WHERE id=$1`,
    [hostId, JSON.stringify([{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, options: null, health_check_protocol: "acp" }])]);
  setProviderProxyBaseUrlForProcess("http://server:8021", null);
  const created = await action("provider.create", { name: "Synthetic", provider_type: "openai", base_url: "https://models.example/v1",
    openai_compatible_base_url: "https://models.example/v1", api_key: "sk-synthetic-fixture", default_model: "synthetic-provider-default" });
  expect(created.statusCode, created.body).toBe(201);
  const provider = created.json().data.id as string;
  const openCode = await ownerConversation(hostId);
  const profile = await action("agent.runtime_profile.create", { agent_id: openCode.agent, name: "OpenCode on Synthetic", backend_mode: "model_provider", model_provider_id: provider,
    model_name: "synthetic-provider-a", execution_host_id: hostId, workspace_mode: "managed", runtime_installation: "managed:1.0.0", runtime_key: "opencode", is_default: true });
  expect(profile.statusCode, profile.body).toBe(201);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, conversation.run, space, { effects: ["interview"] }, randomUUID());
  const proposalId = String(drafted.modelResult.proposal_id);
  const chosen = await ok(action("source.gmail.application_updates.select_execution", { proposal_id: proposalId, agent_id: openCode.agent,
    runtime_profile_id: profile.json().data.profile_id, model: "synthetic-provider-a" }));
  expect((await accept(proposalId, chosen.card_revision)).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [proposalId])).rows[0];
  expect(digest.runtime_binding).toMatchObject({ backend_mode: "model_provider", pinned_model: "synthetic-provider-a" });
  return { connectionId, hostId, provider, digest, run: conversation.run };
}

it("ADR 0036 §11: an ordinary launch never resumes the vendor session an isolated automation launch held — it is refused before the frame and only that session retired", async () => {
  const { connectionId, hostId, digest } = await providerAutomation();
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const delivery = await runningDelivery(digest.id);
  await new PgRouteDecisionRepository(db.pool).routeRun(await loadRunRow(delivery.run_id));
  const automation = await loadRunRow(delivery.run_id);
  // The automation's isolated launch left its session (with the mail it read) as the execution conversation's pointer.
  const isolatedLaunch = randomUUID();
  expect(await new PgRunRepository(db.pool, config).markRunRunning({ run_id: automation.id, space_id: space, started_at: new Date().toISOString() })).not.toBeNull();
  expect(await new PgRunRepository(db.pool, config).bindAttemptLaunch({ space_id: space, run_id: automation.id, launch_id: isolatedLaunch, expected_launch_id: null,
    isolation: { host_id: hostId, host_kind: "server", egress_profile: "none", sandbox_mode: "read_write", model_channel: "provider_lease" } as never })).toBe(true);
  await db.pool.query(`UPDATE host_threads SET vendor_session_id='vendor-mail',vendor_session_launch_id=$2,status='active' WHERE id=$1`, [automation.host_task_thread_id, isolatedLaunch]);
  // A Run of that conversation admitted to resume it on a launch with network (as code before this check admitted one):
  // the launch refuses it before any frame, and retires exactly that session.
  const ordinary = randomUUID();
  await seedRun(db.pool, { id: ordinary, space, owner, agent: automation.agent_id!, version: automation.agent_version_id!, existingAgent: true, now: new Date().toISOString() });
  await db.pool.query(`UPDATE runs SET session_id=$2,host_task_thread_id=$3,runtime_key='opencode',instructed_by_user_id=$4 WHERE id=$1`, [ordinary, automation.session_id, automation.host_task_thread_id, owner]);
  class Sink implements HostFrameSink { sent: Record<string, unknown>[] = []; send(frame: Record<string, unknown>) { this.sent.push(frame); } close() {} }
  const registry = new HostConnectionRegistry(), sink = new Sink();
  registry.registerConnection(hostId, sink);
  const result = await executeRemoteHostCliAdapter({ run: await loadRunRow(ordinary), prompt: "What did you find?", model: null, resume_session_id: "vendor-mail" }, hostId, null,
    { connectionRegistry: registry, config, db: db.pool, bindings: NO_PROVIDER_BINDINGS });
  expect(result).toMatchObject({ success: false, error_code: "isolated_session_resume_refused" });
  expect(sink.sent.filter((frame) => frame.type === "launch")).toEqual([]);
  expect((await db.pool.query(`SELECT vendor_session_id,vendor_session_launch_id,retired_vendor_session_ids FROM host_threads WHERE id=$1`, [automation.host_task_thread_id])).rows[0])
    .toEqual({ vendor_session_id: null, vendor_session_launch_id: null, retired_vendor_session_ids: ["vendor-mail"] });
  // A retry of that Run, its frozen session unchanged: the pointer that traced the session to the isolated launch is gone
  // (the automation started it fresh, resuming none), so nothing on record says "held" any more — it is still refused,
  // being neither the thread's current session nor this Run's own, and still before any frame.
  const retry = await executeRemoteHostCliAdapter({ run: await loadRunRow(ordinary), prompt: "What did you find?", model: null, resume_session_id: "vendor-mail" }, hostId, null,
    { connectionRegistry: registry, config, db: db.pool, bindings: NO_PROVIDER_BINDINGS });
  expect(retry).toMatchObject({ success: false, error_code: "resume_session_unconfirmed" });
  expect(sink.sent.filter((frame) => frame.type === "launch")).toEqual([]);
  expect((await db.pool.query(`SELECT retired_vendor_session_ids FROM host_threads WHERE id=$1`, [automation.host_task_thread_id])).rows[0].retired_vendor_session_ids).toEqual(["vendor-mail"]);
});

it("ADR 0036 §13: a parked Run's same attempt relaunched still resumes its session through the Host adapter; a pointer in another directory is refused before any frame", async () => {
  const { connectionId, hostId, digest } = await providerAutomation();
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const automation = await loadRunRow((await runningDelivery(digest.id)).run_id);
  const thread = automation.host_task_thread_id!;
  const runs = new PgRunRepository(db.pool, config);
  const ordinaryRun = async () => {
    const id = randomUUID();
    await seedRun(db.pool, { id, space, owner, agent: automation.agent_id!, version: automation.agent_version_id!, existingAgent: true, now: new Date().toISOString() });
    await db.pool.query(`UPDATE runs SET session_id=$2,host_task_thread_id=$3,runtime_key='opencode',instructed_by_user_id=$4,model_override_json='{"host_thread":{}}'::jsonb WHERE id=$1`,
      [id, automation.session_id, thread, owner]);
    // Its open attempt, as a running Run has one.
    await db.pool.query(`UPDATE runs SET status='running' WHERE id=$1`, [id]);
    await db.pool.query(`INSERT INTO run_attempts (id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, id]);
    return id;
  };
  // The directory the adapter gives this Agent's unbound OpenCode launch (`NO_PROVIDER_BINDINGS`: the Agent container).
  const ambient = `agents/${automation.agent_id}/agent/${automation.agent_id}/opencode/ambient`;
  const open = (profile_key: string) => ({ host_id: hostId, host_kind: "server", egress_profile: "default", sandbox_mode: "read_write", profile_key }) as never;
  // A daemon whose earlier launch of the attempt has exited: it confirms a `terminate` by reporting that launch complete.
  class Sink implements HostFrameSink {
    sent: Record<string, unknown>[] = [];
    constructor(private readonly registry: HostConnectionRegistry) {}
    send(frame: Record<string, unknown>) {
      this.sent.push(frame);
      if (frame.type === "terminate") queueMicrotask(() => this.registry.receiveComplete(hostId, String(frame.run_id), { exit_code: 0, timed_out: false, error: null }, String(frame.launch_id)));
    }
    close() {}
  }
  const launch = async (runId: string, resume: string) => {
    const registry = new HostConnectionRegistry(), sink = new Sink(registry);
    registry.registerConnection(hostId, sink);
    const execution = executeRemoteHostCliAdapter({ run: await loadRunRow(runId), prompt: "Continue.", model: null, resume_session_id: resume }, hostId, null,
      { connectionRegistry: registry, config, db: db.pool, bindings: NO_PROVIDER_BINDINGS });
    const ended = await Promise.race([vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"), { timeout: 30000 }).then(() => null), execution]);
    const frame = sink.sent.find((f) => f.type === "launch");
    if (frame) { registry.receiveComplete(hostId, runId, { exit_code: 0, timed_out: false, error: null }, String(frame.launch_id)); await execution.catch(() => undefined); }
    return { ended, frame };
  };
  // A networked launch parked on a review in the session it started (the pointer names nothing yet).
  const parked = await ordinaryRun();
  const reporting = randomUUID();
  expect(await runs.bindAttemptLaunch({ space_id: space, run_id: parked, launch_id: reporting, expected_launch_id: null, isolation: open(ambient) })).toBe(true);
  await db.pool.query(`UPDATE runs SET status='waiting_for_review' WHERE id=$1`, [parked]);
  await runs.recordParkedHostThreadSession({ run_id: parked, space_id: space, vendor_session_id: "vendor-parked", launch_id: reporting });
  await db.pool.query(`UPDATE runs SET status='running' WHERE id=$1`, [parked]);
  // Its resume relaunched the same attempt (a new nonce replaced the reporting one) and failed before parking again.
  expect(await runs.bindAttemptLaunch({ space_id: space, run_id: parked, launch_id: randomUUID(), expected_launch_id: reporting, isolation: open(ambient) })).toBe(true);
  // The retry is not refused: its launch frame leaves, and nothing was excluded.
  const retry = await launch(parked, "vendor-parked");
  expect(retry.ended, JSON.stringify(retry.ended)?.slice(0, 800)).toBeNull();
  expect(retry.frame).toBeDefined();
  expect((await db.pool.query(`SELECT retired_vendor_session_ids FROM host_threads WHERE id=$1`, [thread])).rows[0].retired_vendor_session_ids).toEqual([]);
  // A pointer a launch recorded in another directory (here the channel-less ModelProvider one from before the split): a
  // Run admitted to resume it is refused before any frame, and only that session excluded.
  const earlier = await ordinaryRun(), before = randomUUID();
  expect(await runs.bindAttemptLaunch({ space_id: space, run_id: earlier, launch_id: before, expected_launch_id: null,
    isolation: open(`agents/${automation.agent_id}/agent/${automation.agent_id}/opencode/prov-1`) })).toBe(true);
  await db.pool.query(`UPDATE host_threads SET vendor_session_id='vendor-shared-dir',vendor_session_launch_id=$2,status='active' WHERE id=$1`, [thread, before]);
  const queued = await ordinaryRun();
  const refused = await launch(queued, "vendor-shared-dir");
  expect(refused.frame).toBeUndefined();
  expect(refused.ended).toMatchObject({ success: false, error_code: "resume_session_unconfirmed" });
  expect((await db.pool.query(`SELECT vendor_session_id,retired_vendor_session_ids FROM host_threads WHERE id=$1`, [thread])).rows[0])
    .toEqual({ vendor_session_id: null, retired_vendor_session_ids: ["vendor-shared-dir"] });
});

it("ADR 0036 §14: a reset that commits after the adapter's early check but before its bind stops the parked Run's resume before any launch frame", async () => {
  const { connectionId, hostId, digest } = await providerAutomation();
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const automation = await loadRunRow((await runningDelivery(digest.id)).run_id);
  const thread = automation.host_task_thread_id!;
  const runs = new PgRunRepository(db.pool, config);
  const parked = randomUUID();
  await seedRun(db.pool, { id: parked, space, owner, agent: automation.agent_id!, version: automation.agent_version_id!, existingAgent: true, now: new Date().toISOString() });
  await db.pool.query(`UPDATE runs SET session_id=$2,host_task_thread_id=$3,runtime_key='opencode',instructed_by_user_id=$4,model_override_json='{"host_thread":{}}'::jsonb,status='running' WHERE id=$1`,
    [parked, automation.session_id, thread, owner]);
  await db.pool.query(`INSERT INTO run_attempts (id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, parked]);
  const ambient = `agents/${automation.agent_id}/agent/${automation.agent_id}/opencode/ambient`;
  const reporting = randomUUID();
  expect(await runs.bindAttemptLaunch({ space_id: space, run_id: parked, launch_id: reporting, expected_launch_id: null,
    isolation: { host_id: hostId, host_kind: "server", egress_profile: "default", sandbox_mode: "read_write", profile_key: ambient } as never })).toBe(true);
  await db.pool.query(`UPDATE runs SET status='waiting_for_review' WHERE id=$1`, [parked]);
  await runs.recordParkedHostThreadSession({ run_id: parked, space_id: space, vendor_session_id: "vendor-parked", launch_id: reporting });
  await db.pool.query(`UPDATE runs SET status='running' WHERE id=$1`, [parked]);
  // The resume first stops the attempt's earlier launch; while it does, a reset of this session commits.
  class Sink implements HostFrameSink {
    sent: Record<string, unknown>[] = [];
    constructor(private readonly registry: HostConnectionRegistry) {}
    send(frame: Record<string, unknown>) {
      this.sent.push(frame);
      if (frame.type === "terminate") {
        void new PgHostThreadRepository(db.pool).excludeVendorSession(thread, "vendor-parked")
          .then(() => this.registry.receiveComplete(hostId, String(frame.run_id), { exit_code: 0, timed_out: false, error: null }, String(frame.launch_id)));
      }
    }
    close() {}
  }
  const registry = new HostConnectionRegistry(), sink = new Sink(registry);
  registry.registerConnection(hostId, sink);
  const execution = executeRemoteHostCliAdapter({ run: await loadRunRow(parked), prompt: "Continue.", model: null, resume_session_id: "vendor-parked" }, hostId, null,
    { connectionRegistry: registry, config, db: db.pool, bindings: NO_PROVIDER_BINDINGS });
  const ended = await Promise.race([vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"), { timeout: 30000 }).then(() => null), execution]);
  const frame = sink.sent.find((f) => f.type === "launch");
  if (frame) { registry.receiveComplete(hostId, parked, { exit_code: 0, timed_out: false, error: null }, String(frame.launch_id)); await execution.catch(() => undefined); }
  expect(sink.sent.some((f) => f.type === "terminate")).toBe(true);
  expect(frame).toBeUndefined();
  expect(ended).toMatchObject({ success: false, error_code: "resume_session_unconfirmed" });
  // Nothing was bound: the attempt still carries the reporting launch's nonce.
  expect((await db.pool.query(`SELECT launch_id FROM run_attempts WHERE run_id=$1`, [parked])).rows[0].launch_id).toBe(reporting);
});

it("ADR 0036 §15: a park a launch reports after a Host reset of its Agent never resumes through the Host adapter; a launch bound after the reset parks and resumes", async () => {
  const { connectionId, hostId, digest } = await providerAutomation();
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const automation = await loadRunRow((await runningDelivery(digest.id)).run_id);
  const thread = automation.host_task_thread_id!;
  const runs = new PgRunRepository(db.pool, config);
  const ambient = `agents/${automation.agent_id}/agent/${automation.agent_id}/opencode/ambient`;
  /** A running Run of the automation's Agent on its thread whose open attempt the real bind launched. */
  const launchedRun = async () => {
    const id = randomUUID(), launchId = randomUUID();
    await seedRun(db.pool, { id, space, owner, agent: automation.agent_id!, version: automation.agent_version_id!, existingAgent: true, now: new Date().toISOString() });
    await db.pool.query(`UPDATE runs SET session_id=$2,host_task_thread_id=$3,runtime_key='opencode',instructed_by_user_id=$4,model_override_json='{"host_thread":{}}'::jsonb,status='running' WHERE id=$1`,
      [id, automation.session_id, thread, owner]);
    await db.pool.query(`INSERT INTO run_attempts (id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, id]);
    expect(await runs.bindAttemptLaunch({ space_id: space, run_id: id, launch_id: launchId, expected_launch_id: null,
      isolation: { host_id: hostId, host_kind: "server", egress_profile: "default", sandbox_mode: "read_write", profile_key: ambient } as never })).toBe(true);
    return { id, launchId };
  };
  /** The orchestrator parks the Run in the session its launch reported, once the adapter returned. */
  const park = async (run: { id: string; launchId: string }, session: string) => {
    await db.pool.query(`UPDATE runs SET status='waiting_for_review' WHERE id=$1`, [run.id]);
    await runs.recordParkedHostThreadSession({ run_id: run.id, space_id: space, vendor_session_id: session, launch_id: run.launchId });
    await db.pool.query(`UPDATE runs SET status='running' WHERE id=$1`, [run.id]);
  };
  class Sink implements HostFrameSink {
    sent: Record<string, unknown>[] = [];
    constructor(private readonly registry: HostConnectionRegistry) {}
    send(frame: Record<string, unknown>) {
      this.sent.push(frame);
      if (frame.type === "terminate") queueMicrotask(() => this.registry.receiveComplete(hostId, String(frame.run_id), { exit_code: 0, timed_out: false, error: null }, String(frame.launch_id)));
    }
    close() {}
  }
  const resume = async (runId: string, session: string) => {
    const registry = new HostConnectionRegistry(), sink = new Sink(registry);
    registry.registerConnection(hostId, sink);
    const execution = executeRemoteHostCliAdapter({ run: await loadRunRow(runId), prompt: "Continue.", model: null, resume_session_id: session }, hostId, null,
      { connectionRegistry: registry, config, db: db.pool, bindings: NO_PROVIDER_BINDINGS });
    const ended = await Promise.race([vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"), { timeout: 30000 }).then(() => null), execution]);
    const frame = sink.sent.find((f) => f.type === "launch");
    if (frame) { registry.receiveComplete(hostId, runId, { exit_code: 0, timed_out: false, error: null }, String(frame.launch_id)); await execution.catch(() => undefined); }
    return { ended, frame };
  };
  // The Run's launch is still reporting when a reset of its Agent's state on this Host is admitted (and settled).
  const early = await launchedRun();
  await db.pool.query(`INSERT INTO host_command_intents (id,space_id,host_id,user_id,agent_id,kind,scope_key,status,frozen_json,effect_json,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,'agent_host_state_reset',$6,'succeeded','{}'::jsonb,'{}'::jsonb,now(),now())`,
    [randomUUID(), space, hostId, owner, automation.agent_id, randomUUID().replace(/-/g, "")]);
  // Only then is the park recorded; even with that session's retirement undone, its launch's record refuses it.
  await park(early, "vendor-late");
  expect((await db.pool.query(`SELECT retired_vendor_session_ids FROM host_threads WHERE id=$1`, [thread])).rows[0].retired_vendor_session_ids).toEqual(["vendor-late"]);
  await db.pool.query(`UPDATE host_threads SET retired_vendor_session_ids='[]'::jsonb WHERE id=$1`, [thread]);
  const refused = await resume(early.id, "vendor-late");
  expect(refused.frame).toBeUndefined();
  expect(refused.ended).toMatchObject({ success: false, error_code: "resume_session_unconfirmed" });
  expect((await db.pool.query(`SELECT launch_id FROM run_attempts WHERE run_id=$1`, [early.id])).rows[0].launch_id).toBe(early.launchId);
  // A Run launched after the reset carries the new generation: its park resumes and its frame leaves.
  const later = await launchedRun();
  await park(later, "vendor-after");
  const resumed = await resume(later.id, "vendor-after");
  expect(resumed.ended, JSON.stringify(resumed.ended)?.slice(0, 800)).toBeNull();
  expect(resumed.frame).toMatchObject({ type: "launch" });
  expect((await db.pool.query(`SELECT retired_vendor_session_ids FROM host_threads WHERE id=$1`, [thread])).rows[0].retired_vendor_session_ids).toEqual(["vendor-late"]);
});

// ---------------------------------------------------------------------------
// Regressions of the fourth review of ADR 0034 (Codex and Antigravity, one or more per finding)
// ---------------------------------------------------------------------------

const fullFetches = () => google.calls.filter((c) => /\/messages\/[0-9a-f]+\?/.test(c.url) && new URL(c.url).searchParams.get("format") === "full").length;
const auditRows = async (runId: string) => (await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events WHERE run_id=$1`, [runId])).rows[0].n as number;

it("lets a launch cite only mail released to it: after a relaunch an earlier launch's read admits no fact or flag, and success leaves that mail pending", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const [mail] = await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call, tool, relaunch, loadRun } = await launch(run, runId, hostId);
  const before = await appRow(eth);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  // The Run is relaunched; the new launch runs on the chosen configuration but never read the mail itself.
  await relaunch();
  const fact = await call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: 1,
    source: { kind: "gmail", message_id: mail!.id, received_at: iso(mail!.at) }, effect: { kind: "status", status: "interview" } });
  expect(fact.httpStatus).toBe(404);
  expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: mail!.id, reason: "unclear_fact" }))).toContain("gmail_digest_message_unknown");
  expect(await appRow(eth)).toEqual(before);
  // A successful finish of the new launch does not settle mail only the earlier launch had: it waits for the next delivery.
  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [runId]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRun(), "Nothing recorded.", async () => ({ id: "reply" }))).toEqual({ id: "reply" });
  expect((await items(digest.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
});

it("checks the request's own launch before every Gmail send: a relaunch mid-page stops the read before its next message", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 3);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call, relaunch, launchId } = await launch(run, runId, hostId);
  const first = launchId();
  const held = holdGmailMessages();
  const reading = call("source.gmail.digest.read", {}, first);
  await held.fetching;
  await relaunch();
  held.open();
  const refused = await reading;
  expect(refused.httpStatus).toBe(409);
  expect(JSON.stringify(refused.body)).toContain("gmail_digest_runtime_changed");
  // Only the message already in flight was requested; none after the relaunch.
  expect(fullFetches()).toBe(1);
  expect(await readLogs(runId)).toBe(0);
});

it("keeps the release inside the read's budget: a release waiting on a lock past it, or one whose caller went away, commits no audit, log or progress", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call } = await launch(run, runId, hostId);
  const nothingCommitted = async () => {
    expect(await readLogs(runId)).toBe(0);
    expect(await auditRows(runId)).toBe(0);
    expect((await db.pool.query(`SELECT message_count,read_complete FROM gmail_digest_deliveries WHERE run_id=$1`, [runId])).rows[0]).toEqual({ message_count: 0, read_complete: false });
  };
  const blocker = await db.pool.connect();
  try {
    // The page is fetched, then its release waits for the Run FOR UPDATE held by another transaction.
    __setGmailDigestReadBudgetForTests(1_500);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM runs WHERE id=$1 FOR SHARE", [runId]);
    let started = Date.now();
    const late = await call("source.gmail.digest.read", {});
    expect(late.httpStatus, JSON.stringify(late.body)).not.toBe(200);
    expect(JSON.stringify(late.body)).not.toContain(BODY_MARK);
    expect(Date.now() - started).toBeLessThan(3_000);
    await blocker.query("COMMIT");
    await nothingCommitted();
    // The caller goes away while the release waits: it is cancelled at once, long before the budget ends.
    __setGmailDigestReadBudgetForTests(null);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM runs WHERE id=$1 FOR SHARE", [runId]);
    const caller = new AbortController();
    started = Date.now();
    const leaving = call("source.gmail.digest.read", {}, undefined, caller.signal);
    await until(async () => await lockWaiters() >= 1, "the release to wait for the Run");
    caller.abort();
    const gone = await leaving;
    expect(gone.httpStatus).not.toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    await blocker.query("COMMIT");
    await nothingCommitted();
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  // Nothing advanced: the same first page is read and released normally afterwards.
  const read = await call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  expect(await readLogs(runId)).toBe(1);
});

it("holds the whole release to the read's absolute deadline: lock waits one after another end at it, not each at the time left when the release began", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { id: deliveryId, run_id: runId } = await runningDelivery(digest.id);
  const { call } = await launch(run, runId, hostId);
  const runLock = await db.pool.connect(), deliveryLock = await db.pool.connect();
  let freeRun: NodeJS.Timeout | undefined;
  try {
    // The release first waits for the Run, held for most of the budget; then for its delivery, held past it.
    // Each wait alone fits the time left when the release began; together they would overrun the deadline.
    __setGmailDigestReadBudgetForTests(3_000);
    await runLock.query("BEGIN");
    await runLock.query("SELECT id FROM runs WHERE id=$1 FOR SHARE", [runId]);
    await deliveryLock.query("BEGIN");
    await deliveryLock.query("SELECT id FROM gmail_digest_deliveries WHERE id=$1 FOR SHARE", [deliveryId]);
    const started = Date.now();
    freeRun = setTimeout(() => { void runLock.query("COMMIT"); }, 2_200);
    const late = await call("source.gmail.digest.read", {});
    const elapsed = Date.now() - started;
    expect(late.httpStatus, JSON.stringify(late.body)).not.toBe(200);
    expect(JSON.stringify(late.body)).not.toContain(BODY_MARK);
    // It got past the Run's lock, and ended at the deadline instead of a second full wait for the delivery.
    expect(elapsed).toBeGreaterThanOrEqual(2_100);
    expect(elapsed).toBeLessThan(4_200);
    expect(await lockWaiters()).toBe(0);
  } finally {
    clearTimeout(freeRun);
    for (const client of [runLock, deliveryLock]) { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
  }
  expect(await readLogs(runId)).toBe(0);
  expect(await auditRows(runId)).toBe(0);
  expect((await db.pool.query(`SELECT message_count,read_complete FROM gmail_digest_deliveries WHERE id=$1`, [deliveryId])).rows[0]).toEqual({ message_count: 0, read_complete: false });
  // The release's connection went back clean: the same page is released normally afterwards.
  __setGmailDigestReadBudgetForTests(null);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  expect(await readLogs(runId)).toBe(1);
});

it("cancels a release whose caller went away while its backend marker was being read, before any lock wait", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call } = await launch(run, runId, hostId);
  // The caller aborts exactly while the release transaction reads its backend marker (on the audit pool, which
  // only the release gate and policy audit use; only the release reads `pg_backend_pid()` there).
  const caller = new AbortController();
  let armed = true;
  const audit = getOperationAuditPool(config.databaseUrl!);
  const connect = audit.connect.bind(audit) as () => Promise<PoolClient>;
  // The pool hands a released client out again: wrap each one once, around its own query, never around the spy.
  const wrapped = new WeakSet<object>();
  const watched = async () => {
    const client = await connect();
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
      const pending = query(...args);
      if (armed && typeof args[0] === "string" && args[0].includes("pg_backend_pid()")) { armed = false; caller.abort(); }
      return pending;
    }) as never);
    return client;
  };
  // `pool.query` (the policy audit's) checks a client out through `connect(callback)`: answer that form too,
  // or the call never gets its connection and the request waits forever.
  vi.spyOn(audit, "connect").mockImplementation(((callback?: (error: Error | undefined, client?: PoolClient, done?: (release?: unknown) => void) => void) => {
    const checkout = watched();
    if (typeof callback !== "function") return checkout;
    checkout.then((client) => callback(undefined, client, (release) => client.release(release as boolean)), (error: Error) => callback(error));
    return undefined;
  }) as never);
  const blocker = await db.pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM runs WHERE id=$1 FOR SHARE", [runId]);
    const started = Date.now();
    const gone = await call("source.gmail.digest.read", {}, undefined, caller.signal);
    expect(armed).toBe(false);
    expect(gone.httpStatus).not.toBe(200);
    // The release itself stopped waiting for the Run long before the 55 s budget, not only its caller.
    await until(async () => await lockWaiters() === 0, "the release to stop waiting", 3_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  expect(await readLogs(runId)).toBe(0);
  expect(await auditRows(runId)).toBe(0);
});

it("records ordinary and automatic correspondence without a status update and keeps unmatched replies for the owner", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const change = await proposeGmailApplicationUpdates(db.pool, config, run, space, { effects: ["interview", "contact"] }, randomUUID());
  const changeId = String(change.modelResult.proposal_id);
  const rule = async () => (await db.pool.query(`SELECT proposal_id,grant_id,effects,runtime_binding FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0];
  expect(await rule()).toMatchObject({ proposal_id: digest.proposal_id, effects: ["interview"] });
  expect((await accept(changeId)).statusCode).toBe(200);
  expect(await rule()).toMatchObject({ proposal_id: changeId, grant_id: digest.grant_id, effects: ["interview", "contact"], runtime_binding: { sent_from: digest.runtime_binding.sent_from } });
  const appId = await application("ETH Zurich", "PhD in Computer Science");
  const sentFrom = Date.parse(digest.runtime_binding.sent_from);
  expect(sentFrom).toBe(new Date(digest.covered_until).getTime());
  const email = "supervisor@uni.example";
  const contactId = randomUUID();
  await db.pool.query(`INSERT INTO plugin_phd_application.application_contacts(space_id,user_id,project_id,id,name,role,email,project_shared)
    VALUES ($1,$2,$3,$4,'Existing supervisor','supervisor',$5,false)`, [space, owner, project, contactId, email]);
  deliver({ at: sentFrom - 1000, labels: ["SENT"] });
  const sent = deliver({ at: sentFrom, labels: ["SENT", "INBOX"], from: "owner@gmail.example", to: email });
  const reply = deliver({ at: sentFrom + 1, from: email, body: "Our funded places are filled this year.", headers: [{ name: "In-Reply-To", value: "<inquiry@example.test>" }] });
  const automatic = deliver({ at: sentFrom + 2, from: email, body: "I am out of the office.", headers: [{ name: "Auto-Submitted", value: "auto-replied; owner-email=supervisor@uni.example" }] });
  const unmatched = deliver({ at: sentFrom + 3, from: "researcher@other.example", subject: "Re: prospective PhD", body: "Please check our funding website." });
  deliver({ at: sentFrom, labels: ["SENT", "DRAFT"] });
  expect(await syncGmailMailbox(config, db.pool, connectionId)).toMatchObject({ status: "synced" });
  expect((await items(digest.id)).map((item) => item.google_message_id)).toEqual([sent.id, reply.id, automatic.id, unmatched.id]);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call, tool, loadRun } = await launch(run, runId, hostId);
  const read = await call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  expect(read.body).toMatchObject({ data: { items: [
    { id: sent.id, direction: "sent", to: email }, { id: reply.id, from: email, reply: true },
    { id: automatic.id, automatic_reply: true }, { id: unmatched.id },
  ] } });
  const before = await appRow(appId);
  const apply = (message: Mail, effect: Record<string, unknown>, revision: number) => call("plugin.phd_application.mail_fact.apply", {
    project_id: project, application_id: appId, expected_revision: revision,
    source: { kind: "gmail", message_id: message.id, received_at: iso(message.at) }, effect,
  });
  expect((await apply(sent, { kind: "status", status: "interview" }, before.revision)).httpStatus).toBe(404);
  expect((await apply(sent, { kind: "contact", email, direction: "inbound" }, before.revision)).httpStatus).toBe(404);
  const outbound = { kind: "contact", email, direction: "outbound", name: "A. Supervisor", role: "supervisor" };
  const first = await apply(sent, outbound, before.revision);
  expect(first.httpStatus, JSON.stringify(first.body)).toBe(200);
  expect(first.body).toMatchObject({ data: { effect: "contact", outcome: "recorded", after: "outbound", revision: before.revision + 1 } });
  const replay = await apply(sent, outbound, before.revision);
  expect(replay.body).toMatchObject({ data: { id: (first.body.data as { id: string }).id, replayed: true } });
  expect((await apply(reply, { kind: "contact", email: email.toUpperCase(), direction: "inbound" }, before.revision + 1)).body)
    .toMatchObject({ data: { effect: "contact", outcome: "recorded", after: "inbound", revision: before.revision + 2 } });
  const inbound = { kind: "contact", email, direction: "inbound" };
  expect((await apply(automatic, { kind: "status", status: "interview" }, before.revision + 2)).httpStatus).toBe(404);
  expect((await apply(automatic, inbound, before.revision + 2)).httpStatus).toBe(404);
  expect((await apply(automatic, { ...inbound, automatic_reply: true }, before.revision + 2)).body)
    .toMatchObject({ data: { effect: "contact", outcome: "recorded", after: "inbound", revision: before.revision + 3 } });
  expect(await tool("source.gmail.application_updates.flag", { message_id: unmatched.id, reason: "no_matching_application" }))
    .toMatchObject({ ok: true, status: "review" });
  const events = (await db.pool.query(`SELECT c.id AS contact_id,c.email,c.role,c.project_shared,l.application_id,e.channel,e.direction,e.summary
    FROM plugin_phd_application.application_contact_events e
    JOIN plugin_phd_application.application_contacts c ON c.id=e.contact_id
    JOIN plugin_phd_application.application_contact_links l ON l.contact_id=c.id
    WHERE l.application_id=$1 ORDER BY e.created_at`, [appId])).rows;
  expect(events).toEqual([
    { contact_id: contactId, email, role: "supervisor", project_shared: false, application_id: appId, channel: "email", direction: "outbound", summary: "Email sent" },
    { contact_id: contactId, email, role: "supervisor", project_shared: false, application_id: appId, channel: "email", direction: "inbound", summary: "Email received" },
    { contact_id: contactId, email, role: "supervisor", project_shared: false, application_id: appId, channel: "email", direction: "inbound", summary: "Automatic email reply received" },
  ]);
  expect(await appRow(appId)).toMatchObject({ status: before.status, status_changed_at: before.status_changed_at });
  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [runId]);
  const report = await settleGmailDigestRun(db.pool, config, await loadRun(), "Correspondence recorded for ETH Zurich.", (tx, content) =>
    new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, digest.session_id, runId, { content }));
  expect(report).toMatchObject({ session_id: digest.session_id });
  expect(await items(digest.id)).toMatchObject([
    { google_message_id: sent.id, status: "done", attempts: 0 },
    { google_message_id: reply.id, status: "done", attempts: 0 },
    { google_message_id: automatic.id, status: "done", attempts: 0 },
    { google_message_id: unmatched.id, status: "review", reason: "no_matching_application" },
  ]);
  const list = (query = "") => app.inject({ method: "GET", url: `/api/v1/sources/gmail/digests${query}` });
  const reviewQuery = `?application_review_project_id=${project}`;
  const ownerList = await list(reviewQuery);
  expect(ownerList.statusCode, ownerList.body).toBe(200);
  expect(GmailDigestListSchema.parse(ownerList.json()).digests[0]?.review_items).toEqual([{
    message_id: unmatched.id, received_at: iso(unmatched.at), reason: "no_matching_application",
    gmail_url: expect.stringMatching(new RegExp(`#all/${unmatched.id}$`)),
  }]);
  expect(GmailDigestListSchema.parse((await list()).json()).digests[0]?.review_items).toBeUndefined();
  for (const user of [peer, admin]) {
    as(user);
    expect(GmailDigestListSchema.parse((await list(reviewQuery)).json()).digests).toEqual([]);
  }
});

it("settles frozen mail that turned spam, trash, sent or draft before it was read as examined and not eligible, never as citable released mail", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  // A card accepted before sent-mail support still grants inbox-only access.
  await db.pool.query(`UPDATE gmail_digests SET runtime_binding=runtime_binding-'sent_from' WHERE id=$1`, [digest.id]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const mails = await newMail(connectionId, digest.id, 5);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  // After the delivery froze them, the owner moved four of them: to spam, to trash, one is their own sent copy,
  // one became a draft. Only the fifth is still eligible.
  const [spam, trash, sent, draft, kept] = mails as [Mail, Mail, Mail, Mail, Mail];
  spam.labels = ["SPAM", "UNREAD"]; trash.labels = ["TRASH"]; sent.labels = ["INBOX", "SENT"]; draft.labels = ["DRAFT"];
  const ineligible = [spam, trash, sent, draft].map((mail) => mail.id);
  const { call, tool, loadRun } = await launch(run, runId, hostId);
  const read = await call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  expect((read.body as any).data.items.map((item: { id: string }) => item.id)).toEqual([kept.id]);
  // The release credential names only the eligible message.
  const released = (await db.pool.query(`SELECT resource_ids_json FROM agent_data_read_logs WHERE run_id=$1`, [runId])).rows.map((row) => row.resource_ids_json);
  expect(released).toEqual([[kept.id]]);
  const byId = async () => new Map((await items(digest.id)).map((item: { google_message_id: string }) => [item.google_message_id, item]));
  for (const id of ineligible) expect((await byId()).get(id)).toMatchObject({ status: "done", reason: "not_eligible", attempts: 0 });
  expect((await byId()).get(kept.id)).toMatchObject({ status: "pending" });
  // None of them can be cited: no fact, no flag.
  const before = await appRow(eth);
  for (const mail of [spam, sent]) {
    const fact = await call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: before.revision,
      source: { kind: "gmail", message_id: mail.id, received_at: iso(mail.at) }, effect: { kind: "status", status: "interview" } });
    expect(fact.httpStatus).toBe(404);
    expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: mail.id, reason: "unclear_fact" }))).toContain("gmail_digest_message_unknown");
  }
  expect(await appRow(eth)).toEqual(before);
  // A successful finish settles the eligible message; nothing stays pending for a next delivery.
  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [runId]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRun(), "Nothing recorded.", async () => ({ id: "reply" }))).toEqual({ id: "reply" });
  const settled = await byId();
  expect(settled.get(kept.id)).toMatchObject({ status: "done", reason: null });
  for (const id of ineligible) expect(settled.get(id)).toMatchObject({ status: "done", reason: "not_eligible", attempts: 0 });
  expect([...settled.values()].filter((item: any) => item.status === "pending")).toEqual([]);
  // The owner's list shows them as settled, without the internal reason.
  const listed = await listGmailApplicationUpdates(db.pool, run, space);
  const recent = (listed.modelResult as any).automations[0].recent as { message_id: string; status: string; reason: string | null }[];
  for (const id of ineligible) expect(recent.find((item) => item.message_id === id)).toMatchObject({ status: "done", reason: null });
});

it("gives up a frozen message Gmail answers with 404 at its read, uncitable, while the other mail of the batch is read, recorded and settled", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const [gone, kept] = await newMail(connectionId, digest.id, 2) as [Mail, Mail];
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  // After the delivery froze both, the owner deleted one for good: Gmail answers its get with 404.
  google.messages.delete(gone.id);
  const { call, tool, loadRun } = await launch(run, runId, hostId);
  const read = await call("source.gmail.digest.read", {});
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  expect((read.body as any).data.items.map((item: { id: string }) => item.id)).toEqual([kept.id]);
  // Released, and so citable, is only the message that was read.
  expect((await db.pool.query(`SELECT resource_ids_json FROM agent_data_read_logs WHERE run_id=$1`, [runId])).rows.map((row) => row.resource_ids_json)).toEqual([[kept.id]]);
  const byId = async () => new Map((await items(digest.id)).map((item: { google_message_id: string }) => [item.google_message_id, item]));
  expect((await byId()).get(gone.id)).toMatchObject({ status: "failed", reason: "read_failed", attempts: 0 });
  expect((await byId()).get(kept.id)).toMatchObject({ status: "pending" });
  const fact = (mail: Mail, revision: number) => call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: revision,
    source: { kind: "gmail", message_id: mail.id, received_at: iso(mail.at) }, effect: { kind: "status", status: "interview" } });
  const before = await appRow(eth);
  expect((await fact(gone, before.revision)).httpStatus).toBe(404);
  expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: gone.id, reason: "unclear_fact" }))).toContain("gmail_digest_message_unknown");
  expect(await appRow(eth)).toEqual(before);
  // The other message of the same batch goes on as usual.
  const recorded = await fact(kept, before.revision);
  expect(recorded.httpStatus, JSON.stringify(recorded.body)).toBe(200);
  expect((recorded.body as { data: Record<string, unknown> }).data).toMatchObject({ outcome: "recorded", after: "interview" });
  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [runId]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRun(), "Interview recorded.", async () => ({ id: "reply" }))).toEqual({ id: "reply" });
  const settled = await byId();
  expect(settled.get(kept.id)).toMatchObject({ status: "done", reason: null });
  expect(settled.get(gone.id)).toMatchObject({ status: "failed", reason: "read_failed", attempts: 0 });
  // Nothing waits on it any more, and the automation neither failed nor paused.
  expect((await db.pool.query(`SELECT status,failure_count,last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0]).toEqual({ status: "active", failure_count: 0, last_error_code: null });
  expect([...settled.values()].filter((item: any) => item.status === "pending")).toEqual([]);
});

it("keeps a frozen message Gmail answers with a 5xx waiting and the page failing, so the same Run's read retries it", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const [flaky, kept] = await newMail(connectionId, digest.id, 2) as [Mail, Mail];
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  google.failing.set(flaky.id, 500);
  const { call } = await launch(run, runId, hostId);
  const failed = await call("source.gmail.digest.read", {});
  expect(failed.httpStatus, JSON.stringify(failed.body)).toBe(503);
  // Nothing was released or settled: both still wait, with no attempt counted on mail the model never had.
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1`, [runId])).rows[0].n).toBe(0);
  for (const item of await items(digest.id)) expect(item).toMatchObject({ status: "pending", reason: null, attempts: 0 });
  // Gmail recovers: the retry reads both.
  google.failing.delete(flaky.id);
  const retried = await call("source.gmail.digest.read", {});
  expect(retried.httpStatus, JSON.stringify(retried.body)).toBe(200);
  expect((retried.body as any).data.items.map((item: { id: string }) => item.id).sort()).toEqual([flaky.id, kept.id].sort());
});

it("counts a failure only against mail released to the Run: none for a launch that read nothing", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const proven = await runningDelivery(digest.id);
  // The launch started, then failed (a read timed out, the runtime crashed) before any mail was released.
  const { loadRun } = await launch(run, proven.run_id, hostId);
  await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [proven.run_id]);
  expect(await settleGmailDigestRun(db.pool, config, await loadRun(), null, async () => null)).toBeNull();
  expect((await db.pool.query(`SELECT error_code FROM gmail_digest_deliveries WHERE id=$1`, [proven.id])).rows[0].error_code).toBe("gmail_digest_run_failed");
  expect((await items(digest.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
});

it("takes the Project first for an application read's release too: mail_fact.apply and application.get of one Run never deadlock", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const [mail] = await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call } = await launch(run, runId, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  // Interleave deterministically: another transaction holds the Project, the fact queues for it first, then the
  // application read's release. Taking people and the Run before the Project, that release would hold the Run
  // FOR UPDATE while waiting for the Project the fact then holds FOR UPDATE while waiting for the Run.
  const blocker = await db.pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [project]);
    const fact = call("plugin.phd_application.mail_fact.apply", { project_id: project, application_id: eth, expected_revision: 1,
      source: { kind: "gmail", message_id: mail!.id, received_at: iso(mail!.at) }, effect: { kind: "status", status: "interview" } });
    await until(async () => await lockWaiters() >= 1, "the fact to wait for the Project");
    const get = call("plugin.phd_application.application.get", { project_id: project, application_id: eth });
    await until(async () => await lockWaiters() >= 2, "the read's release to wait");
    await blocker.query("COMMIT");
    const [recorded, read] = await Promise.all([fact, get]);
    expect([recorded.httpStatus, read.httpStatus], JSON.stringify([recorded.body, read.body])).toEqual([200, 200]);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  expect(await appRow(eth)).toMatchObject({ status: "interview" });
});

it("takes the Project first for an ordinary application.update too: it races the owner's on-demand Gmail read release in one Run without a deadlock", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const { run: source, session } = await ownerConversation();
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const generation = (await db.pool.query(`SELECT generation FROM gmail_connections WHERE id=$1`, [connectionId])).rows[0].generation;
  const { PluginDataGrantRepository } = await import("../src/modules/plugins/dataGrantRepository.js");
  await new PluginDataGrantRepository(db.pool, config).createCoreProjectConsent({ spaceId: space, userId: owner },
    { consentId: "core:gmail", projectId: project, connectionId, generation, purpose: "on_demand_read" });
  deliver({ subject: "Interview invitation" });
  // An ordinary turn of the owner's private conversation with both tools, as the conversation grants them, launched isolated.
  const tools = ["source.gmail.mail.read", "plugin.phd_application.application.update"];
  const turnId = await ownerTurn(source, session, tools);
  const { buildRunToolGrants } = await import("../src/modules/systemActions/runToolGrants.js");
  const { pluginToolPins } = await import("../src/modules/plugins/dataAccess.js");
  const snapshot = await buildRunToolGrants(tools, { allowed_tools: tools }, { db: db.pool, spaceId: space, userId: owner, config,
    scenario: { origin: "manual", instructingUserId: owner, audience: [owner] }, sessionId: session });
  await db.pool.query(`UPDATE runs SET permission_snapshot_json=$2::jsonb WHERE id=$1`, [turnId, JSON.stringify({ tool_grants: snapshot, plugin_tool_pins: pluginToolPins(config, snapshot) })]);
  const launchId = randomUUID(), hostId = (await db.pool.query(`SELECT execution_host_id FROM agent_runtime_profiles p JOIN runs r ON r.agent_id=p.agent_id WHERE r.id=$1 AND p.is_default`, [turnId])).rows[0].execution_host_id;
  await db.pool.query(`UPDATE run_attempts SET launch_id=$2,launch_isolation_json=$3::jsonb WHERE run_id=$1`, [turnId, launchId,
    JSON.stringify({ launch_id: launchId, host_id: hostId, host_kind: "server", egress_profile: "none", sandbox_mode: "read_write" })]);
  const turn = await loadRunRow(turnId);
  // Interleave deterministically: a reader holds the Run FOR SHARE, so the mail read's release (Project FOR SHARE →
  // person → Run FOR UPDATE) waits for the Run while holding the Project; then the update starts. Pinning person and
  // Run before its Project, the update would hold the Run FOR SHARE and wait for that Project: a deadlock.
  const blocker = await db.pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM runs WHERE id=$1 FOR SHARE", [turn.id]);
    const read = toolCall(turn, "source.gmail.mail.read", { query: "interview", max_messages: 1 }) as Promise<OperationToolResponse>;
    await until(async () => await lockWaiters() >= 1, "the mail read's release to wait for the Run");
    const update = toolCall(turn, "plugin.phd_application.application.update", { project_id: project, application_id: eth, revision: 1, notes: "Ask about funding" }) as Promise<OperationToolResponse>;
    await until(async () => await lockWaiters() >= 2, "the update to wait");
    await blocker.query("COMMIT");
    const [mail, updated] = await Promise.all([read, update]);
    expect(mail.httpStatus, JSON.stringify(mail.body)).toBe(200);
    // A write into this Project after the owner's own mail of it is allowed: both succeed, neither deadlocks.
    expect(updated.httpStatus, JSON.stringify(updated.body)).toBe(200);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  expect((await db.pool.query(`SELECT notes,revision FROM plugin_phd_application.applications WHERE id=$1`, [eth])).rows[0]).toMatchObject({ notes: "Ask about funding", revision: 2 });
});

it("refuses a flag once the runtime reported a fallback to another model", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const [mail] = await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call, tool, fallBack } = await launch(run, runId, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  await fallBack();
  expect(JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: mail!.id, reason: "unclear_fact" }))).toContain("gmail_digest_unavailable");
  expect((await items(digest.id))[0]).toMatchObject({ status: "pending" });
});

it("refuses a flag once the Run's audience widened or the owner's consent ended", async () => {
  const { connectionId, run, hostId, digest } = await confirmedAutomation(["interview"]);
  const [first, second] = await newMail(connectionId, digest.id, 2);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const { run_id: runId } = await runningDelivery(digest.id);
  const { call, tool } = await launch(run, runId, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const flag = async (mail: Mail) => JSON.stringify(await tool("source.gmail.application_updates.flag", { message_id: mail.id, reason: "unclear_fact" }));
  await db.pool.query(`UPDATE runs SET visibility='space_shared' WHERE id=$1`, [runId]);
  expect(await flag(first!)).toContain("gmail_digest_unavailable");
  await db.pool.query(`UPDATE runs SET visibility='private' WHERE id=$1`, [runId]);
  expect(await flag(first!)).toContain('"status":"review"');
  await ok(action("source.gmail.connection.set_agent_read", { connection_id: connectionId, enabled: false }));
  expect(await flag(second!)).toContain("gmail_digest_unavailable");
  expect((await items(digest.id)).map((row) => row.status)).toEqual(["review", "pending"]);
});

async function grantRunReaders(run: string, members: string[]) {
  for (const user of members.filter((id) => id !== owner)) await db.pool.query(`INSERT INTO content_access_grants (id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,access_level,created_at,updated_at)
    VALUES ($1,$2,'run',$3,$4,$5,'full',now(),now())`, [randomUUID(), space, run, user, owner]);
}

/** The owner's Room of the Project with `members`, its Agent bound as in the owner's private conversation, and a turn of the owner there. */
async function ownerRoomTurn(privateRun: string, privateSession: string, members: string[], mainline = false) {
  const conversation = mainline
    ? { room: (await db.pool.query(`SELECT id FROM rooms WHERE project_id=$1 AND is_mainline`, [project])).rows[0].id as string, session: randomUUID() }
    : await roomConversation(members);
  if (mainline) await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [conversation.session, space, conversation.room, project]);
  await db.pool.query(`INSERT INTO session_conversation_backends (id,space_id,session_id,bound_by_user_id,agent_id,runtime_profile_id,runtime_key_snapshot,backend_mode_snapshot,
      model_name_snapshot,model_provider_id_snapshot,runtime_config_snapshot_json,runtime_policy_snapshot_json,session_config_json,participating,created_at,updated_at)
    SELECT gen_random_uuid()::text,space_id,$2,bound_by_user_id,agent_id,runtime_profile_id,runtime_key_snapshot,backend_mode_snapshot,model_name_snapshot,model_provider_id_snapshot,
      runtime_config_snapshot_json,runtime_policy_snapshot_json,session_config_json,true,now(),now() FROM session_conversation_backends WHERE session_id=$1`, [privateSession, conversation.session]);
  const run = randomUUID();
  const source = (await db.pool.query(`SELECT agent_id,agent_version_id,runtime_profile_id,runtime_key,runtime_profile_snapshot_json FROM runs WHERE id=$1`, [privateRun])).rows[0];
  await seedRun(db.pool, { id: run, space, owner, agent: source.agent_id, version: source.agent_version_id, existingAgent: true });
  // A Room turn is read by the Room's members: `selected_users` with a grant for each of them, as Room Runs are.
  await db.pool.query(`UPDATE runs SET visibility='selected_users',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,project_id=$3,session_id=$4,runtime_key=$5 WHERE id=$1`,
    [run, owner, project, conversation.session, source.runtime_key]);
  await grantRunReaders(run, members);
  return { ...conversation, run };
}

it("ADR 0035 §1: enabled from a Room on one card naming its readers, runs privately and posts only structured results on applications the Project reads", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const { run: privateRun, session: privateSession, hostId } = await ownerConversation();
  const room = await ownerRoomTurn(privateRun, privateSession, [owner, peer]);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, room.run, space, { effects: ["interview", "rejected", "contact"] }, randomUUID());
  expect(drafted.modelResult, JSON.stringify(drafted)).toMatchObject({ ok: true });
  expect(String(drafted.modelResult.next_step)).toContain("Only the mailbox owner sees and decides the card");
  const card = (await db.pool.query(`SELECT * FROM proposals WHERE id=$1`, [drafted.modelResult.proposal_id])).rows[0];
  // Owner-only card: mailbox, fixed Agent and model, the facts it may record, and who reads the results — now and later.
  expect(card).toMatchObject({ proposal_type: "gmail_digest_create", visibility: "private", owner_user_id: owner });
  expect(card.payload_json).toMatchObject({ kind: "application", shared_conversation: true, effects: ["interview", "rejected", "contact"],
    runtime_binding: { pinned_model: "synthetic-model-a" }, audience: { kind: "room", reader_user_ids: [owner, peer].sort() } });
  expect(card.summary).toContain("owner@gmail.example");
  expect(card.summary).toContain("synthetic-model-a");
  expect(card.summary).toContain("interview invitations, rejections");
  expect(card.summary).toContain("Mail text, the Agent's report and unclear messages stay with you");
  expect(card.summary).toContain("everyone who joins this Room later");

  // A reader added after drafting was never shown on the card: it cannot be accepted until a new card names them.
  const late = randomUUID();
  await seedSpaceMember(db.pool, { space, user: late });
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, late]);
  const lateRow = randomUUID();
  await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [lateRow, space, room.room, late]);
  as(peer);
  expect((await accept(card.id)).statusCode).toBe(404);
  as(owner);
  const refused = await accept(card.id);
  expect(refused.statusCode, refused.body).toBe(409);
  expect(refused.body).toContain("gmail_digest_audience_changed");
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digests`)).rows[0].n).toBe(0);
  await db.pool.query(`DELETE FROM room_user_members WHERE id=$1`, [lateRow]);
  const res = await accept(card.id);
  expect(res.statusCode, res.body).toBe(200);

  // The automation runs in the owner's own private execution conversation; the Room only receives notices.
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [card.id])).rows[0];
  expect(digest).toMatchObject({ kind: "application", status: "active", notice_session_id: room.session });
  expect(digest.session_id).not.toBe(room.session);
  const execution = (await db.pool.query(`SELECT user_id,room_id,project_id,metadata_json FROM sessions WHERE id=$1`, [digest.session_id])).rows[0];
  expect(execution).toMatchObject({ user_id: owner, room_id: null, project_id: project, metadata_json: { gmail_application_execution: true } });
  expect((await db.pool.query(`SELECT bound_by_user_id,session_config_json FROM session_conversation_backends WHERE session_id=$1`, [digest.session_id])).rows[0])
    .toMatchObject({ bound_by_user_id: owner, session_config_json: [{ id: "model", value: "synthetic-model-a" }] });

  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const oxford = await application("University of Oxford", "DPhil in Engineering");
  // New records are shared with the Project; an older record only its owner reads stays private.
  await db.pool.query(`UPDATE plugin_phd_application.applications SET project_shared=false WHERE id=$1`, [oxford]);
  const recipient = "private-supervisor@uni.example";
  const sent = deliver({ at: Date.parse(digest.runtime_binding.sent_from), labels: ["SENT"], to: recipient, from: "owner@gmail.example" });
  const [invite, rejection] = await newMail(connectionId, digest.id, 2);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const delivery = (await db.pool.query(`SELECT dl.id,r.id AS run_id,r.session_id,r.visibility FROM gmail_digest_deliveries dl JOIN runs r ON r.id=dl.run_id WHERE dl.digest_id=$1`, [digest.id])).rows[0];
  expect(delivery).toMatchObject({ session_id: digest.session_id, visibility: "private" });
  const { loadRun, call } = await launch(privateRun, delivery.run_id, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const apply = async (applicationId: string, message: Mail, status: string) => call("plugin.phd_application.mail_fact.apply", {
    project_id: project, application_id: applicationId, expected_revision: (await appRow(applicationId)).revision,
    source: { kind: "gmail", message_id: message.id, received_at: iso(message.at) }, effect: { kind: "status", status } });
  expect((await apply(eth, invite!, "interview")).httpStatus).toBe(200);
  expect((await apply(oxford, rejection!, "rejected")).httpStatus).toBe(200);
  const correspondence = await call("plugin.phd_application.mail_fact.apply", {
    project_id: project, application_id: eth, expected_revision: (await appRow(eth)).revision,
    source: { kind: "gmail", message_id: sent.id, received_at: iso(sent.at) }, effect: { kind: "contact", direction: "outbound", email: recipient },
  });
  expect(correspondence.httpStatus, JSON.stringify(correspondence.body)).toBe(200);
  // A replay keeps nothing new.
  expect((await apply(eth, invite!, "interview")).httpStatus).toBe(200);
  const kept = (await db.pool.query(`SELECT application_id,effect,before_value,after_value,application_label FROM gmail_application_shared_results WHERE digest_id=$1 ORDER BY recorded_at,id`, [digest.id])).rows;
  expect(kept).toEqual([
    { application_id: eth, effect: "interview", before_value: "planning", after_value: "interview", application_label: "ETH Zurich · PhD in Computer Science" },
    { application_id: eth, effect: "contact", before_value: null, after_value: "outbound", application_label: "ETH Zurich · PhD in Computer Science" },
  ]);
  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [delivery.run_id]);
  await settleGmailDigestRun(db.pool, config, await loadRun(), `${SUBJECT_MARK} recorded an interview; ${BODY_MARK}`, (tx, content) =>
    new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, digest.session_id, delivery.run_id, { content }));
  // The Room's one notice: the shared application's change only — never mail text, the model's report or the private application.
  const notices = (await db.pool.query(`SELECT role,content,metadata_json FROM messages WHERE session_id=$1`, [room.session])).rows;
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ role: "system", metadata_json: { room_display: "system_notice", execution_event: "gmail_application_updates" } });
  expect(notices[0].content).toContain("ETH Zurich · PhD in Computer Science: status interview (was planning)");
  expect(notices[0].content).toContain("ETH Zurich · PhD in Computer Science: email sent");
  for (const hidden of ["Oxford", SUBJECT_MARK, BODY_MARK, "owner@gmail.example", recipient]) expect(notices[0].content).not.toContain(hidden);
  expect((await db.pool.query(`SELECT content FROM messages WHERE session_id=$1 AND role='assistant'`, [digest.session_id])).rows[0].content).toContain(SUBJECT_MARK);

  // Managed from the Room: content-free status (no mailbox, no per-message outcomes) and pausing; resuming is a new card.
  const turn = await ownerTurn(privateRun, room.session, ["source.gmail.application_updates.list", "source.gmail.application_updates.set_status"], "selected_users");
  await grantRunReaders(turn, [owner, peer]);
  const listing = await listGmailApplicationUpdates(db.pool, turn, space);
  expect(listing.modelResult).toMatchObject({ ok: true, automations: [expect.objectContaining({ digest_id: digest.id, results_to: "shared" })] });
  expect(JSON.stringify(listing.modelResult)).not.toMatch(/owner@gmail\.example|recent|mail_items/);
  expect((await db.pool.query(`SELECT context_taint_json FROM runs WHERE id=$1`, [turn])).rows[0].context_taint_json?.plugin_reads ?? []).toEqual([]);
  expect((await setGmailApplicationUpdatesStatus(db.pool, turn, space, { digest_id: digest.id, status: "paused" })).modelResult).toMatchObject({ ok: true, status: "paused" });
});

it("ADR 0035 §2: one card in a Room confirms reading, a rule digest and application updates together, each kept, paused and ended on its own; what is allowed is reused", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const { run: privateRun, session: privateSession } = await ownerConversation();
  const room = await ownerRoomTurn(privateRun, privateSession, [owner, peer]);
  const proposals = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM proposals WHERE proposal_type='gmail_setup'`)).rows[0].n as number;
  const drafted = await proposeGmailSetup(db.pool, config, room.run, space, { read: true, rule_digest: true, application_updates: { effects: ["interview"] } }, randomUUID());
  expect(drafted.modelResult, JSON.stringify(drafted)).toMatchObject({ ok: true, reused: [] });
  const card = (await db.pool.query(`SELECT * FROM proposals WHERE id=$1`, [drafted.modelResult.proposal_id])).rows[0];
  expect(card).toMatchObject({ proposal_type: "gmail_setup", visibility: "private", owner_user_id: owner });
  expect(card.payload_json).toMatchObject({ on_demand_read: true, shared_conversation: true, audience: { kind: "room" },
    parts: [expect.objectContaining({ kind: "rule", runtime_binding: expect.any(Object) }), expect.objectContaining({ kind: "application", effects: ["interview"] })] });
  for (const text of ["read and search owner@gmail.example", "5 messages per page by default and up to 500", "monitors match", "interview invitations", "Runs on ", "everyone who joins this Room later", "kept, paused and ended on its own"])
    expect(card.summary).toContain(text);
  as(peer);
  expect((await accept(card.id)).statusCode).toBe(404);
  as(owner);
  const res = await accept(card.id);
  expect(res.statusCode, res.body).toBe(200);
  // Three separate records, each with its own consent.
  const grants = (await db.pool.query(`SELECT plugin_id,purpose FROM plugin_data_grants WHERE status='active' ORDER BY purpose`)).rows;
  expect(grants).toEqual([{ plugin_id: "core:gmail_digest", purpose: "application_update" }, { plugin_id: "core:gmail", purpose: "on_demand_read" }, { plugin_id: "core:gmail_digest", purpose: "rule_digest" }]);
  const digests = (await db.pool.query(`SELECT id,kind,status,session_id,notice_session_id FROM gmail_digests WHERE proposal_id=$1 ORDER BY kind`, [card.id])).rows;
  expect(digests.map((row) => [row.kind, row.status])).toEqual([["application", "active"], ["rule", "active"]]);
  expect(digests.find((row) => row.kind === "rule").session_id).toBe(room.session);
  expect(digests.find((row) => row.kind === "application").notice_session_id).toBe(room.session);

  // The same request again needs no card: everything is reused.
  const again = await proposeGmailSetup(db.pool, config, room.run, space, { read: true, rule_digest: true, application_updates: { effects: ["interview"] } }, randomUUID());
  expect(again.modelResult).toMatchObject({ ok: true, already_allowed: ["read", "rule_digest", "application_updates"] });
  expect(await proposals()).toBe(1);
  // Something new is the only thing on the next card.
  const wider = await proposeGmailSetup(db.pool, config, room.run, space, { read: true, daily_digest: { local_time: "08:00", time_zone: "Europe/Berlin" } }, randomUUID());
  expect(wider.modelResult).toMatchObject({ ok: true, reused: ["read"] });
  expect((await db.pool.query(`SELECT payload_json FROM proposals WHERE id=$1`, [wider.modelResult.proposal_id])).rows[0].payload_json)
    .toMatchObject({ on_demand_read: false, parts: [expect.objectContaining({ kind: "daily", local_time: "08:00" })] });
  // Pausing one part leaves the others as they are.
  const application = digests.find((row) => row.kind === "application").id;
  const turn = await ownerTurn(privateRun, room.session, ["source.gmail.application_updates.set_status"], "selected_users");
  await grantRunReaders(turn, [owner, peer]);
  expect((await setGmailApplicationUpdatesStatus(db.pool, turn, space, { digest_id: application, status: "paused" })).modelResult).toMatchObject({ ok: true });
  expect((await db.pool.query(`SELECT kind,status FROM gmail_digests WHERE proposal_id=$1 ORDER BY kind`, [card.id])).rows).toEqual([{ kind: "application", status: "paused" }, { kind: "rule", status: "active" }]);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE status='active' AND plugin_id='core:gmail'`)).rows[0].n).toBe(1);
  void connectionId;
});

/** A running `manual` turn of `user` in `sessionId`, with the snapshot the server builds for it (offering included). */
async function memberTurn(agentRun: string, user: string, sessionId: string, tools: string[]) {
  const id = randomUUID();
  const source = (await db.pool.query(`SELECT agent_id,agent_version_id FROM runs WHERE id=$1`, [agentRun])).rows[0];
  await seedRun(db.pool, { id, space, owner: user, agent: source.agent_id, version: source.agent_version_id, existingAgent: true });
  const { buildRunToolGrants } = await import("../src/modules/systemActions/runToolGrants.js");
  const snapshot = await buildRunToolGrants(tools, { allowed_tools: tools }, { db: db.pool, spaceId: space, userId: user, config,
    scenario: { origin: "manual", instructingUserId: user, audience: [user] }, sessionId });
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',visibility='private',instructed_by_user_id=$2,owner_user_id=$2,project_id=$3,session_id=$4,permission_snapshot_json=$5::jsonb WHERE id=$1`,
    [id, user, project, sessionId, JSON.stringify({ tool_grants: snapshot })]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, id]);
  return { id, offered: snapshot.map((grant) => grant.action_id) };
}

it("ADR 0035 §4: the owner lets one Project member read within a scope on one card; every read is scoped, rechecked per send and at release, and ends at once", async () => {
  const connectionId = await connect();
  const { run: ownerRun, agent } = await ownerConversation();
  await db.pool.query(`UPDATE users SET display_name='Lin Peer' WHERE id=$1`, [peer]);
  await new PgProjectAgentRepository(db.pool).upsertActive({ spaceId: space, projectId: project, agentId: agent, userId: owner });
  // Only a member who reads the Project, named as the owner said it.
  expect((await proposeGmailDelegation(db.pool, ownerRun, space, { member: admin, query_scope: "label:applications" }, randomUUID())).modelResult).toMatchObject({ ok: false, error: "gmail_delegation_member_unknown" });
  expect((await proposeGmailDelegation(db.pool, ownerRun, space, { member: "lin peer", query_scope: "label:apps) OR (in:anywhere" }, randomUUID())).modelResult).toMatchObject({ ok: false, error: "gmail_delegation_scope_invalid" });
  const drafted = await proposeGmailDelegation(db.pool, ownerRun, space, { member: "lin peer", query_scope: "label:applications" }, randomUUID());
  expect(drafted.modelResult, JSON.stringify(drafted)).toMatchObject({ ok: true });
  const card = (await db.pool.query(`SELECT * FROM proposals WHERE id=$1`, [drafted.modelResult.proposal_id])).rows[0];
  expect(card).toMatchObject({ proposal_type: "gmail_read_delegation", visibility: "private", owner_user_id: owner });
  for (const text of ["Lets Lin Peer read and search owner@gmail.example", "“label:applications”", "Read-only", "including people who join later", "ends by itself when either of you leaves the Project"])
    expect(card.summary).toContain(text);
  // Before acceptance the member is not offered the tool; only the owner decides the card.
  const peerSession = randomUUID();
  await db.pool.query(`INSERT INTO sessions (id,space_id,user_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [peerSession, space, peer, project]);
  expect((await memberTurn(ownerRun, peer, peerSession, ["source.gmail.delegated.read"])).offered).not.toContain("source.gmail.delegated.read");
  as(peer);
  expect((await accept(card.id)).statusCode).toBe(404);
  as(owner);
  expect((await accept(card.id)).statusCode).toBe(200);
  const delegation = (await db.pool.query(`SELECT * FROM gmail_read_delegations WHERE proposal_id=$1`, [card.id])).rows[0];
  expect(delegation).toMatchObject({ status: "active", grantee_user_id: peer, query_scope: "label:applications", project_id: project });

  // The member's own turn in their conversation of the Project: offered, and every search carries the owner's scope.
  deliver({ subject: `${SUBJECT_MARK} Interview`, body: `${BODY_MARK} Interview on Friday` });
  const first = await memberTurn(ownerRun, peer, peerSession, ["source.gmail.delegated.read"]);
  expect(first.offered).toContain("source.gmail.delegated.read");
  const before = google.calls.length;
  const read = await toolCall(await loadRunRow(first.id), "source.gmail.delegated.read", { query: "interview", max_messages: 1 }) as OperationToolResponse;
  expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
  expect(JSON.stringify(read.body)).toContain(BODY_MARK);
  const list = google.calls.slice(before).map((call) => new URL(call.url)).find((url) => url.pathname.endsWith("/messages"))!;
  expect(list.searchParams.get("q")).toBe("(label:applications) (interview) -in:drafts -in:chats -in:spam -in:trash");
  // The owner's mail in the member's Run: the owner is its data owner, so the member's outward writes are refused.
  const taint = (await loadRunRow(first.id)).context_taint_json as { plugin_reads: unknown[]; non_instructing_owner_user_ids: string[] };
  expect(taint.plugin_reads).toEqual([expect.objectContaining({ plugin_id: "core:gmail", owner_user_id: owner, gmail_scope: { project_id: project, grant_id: delegation.id } })]);
  expect(taint.non_instructing_owner_user_ids).toContain(owner);
  expect((await db.pool.query(`SELECT owner_user_id,actor_user_id,operation,delegation_id,item_count FROM gmail_read_audit_events WHERE operation='delegated_read'`)).rows)
    .toEqual([{ owner_user_id: owner, actor_user_id: peer, operation: "delegated_read", delegation_id: delegation.id, item_count: 1 }]);
  expect((await listGmailDelegations(db.pool, { spaceId: space, userId: owner }))[0]).toMatchObject({ delegation_id: delegation.id, read_count: 1, grantee_name: "Lin Peer", last_used_at: expect.any(String) });
  // Words that could close the owner's scope never reach Google.
  const sent = google.calls.length;
  const escape = await toolCall(await loadRunRow(first.id), "source.gmail.delegated.read", { query: "x) OR (in:anywhere" }) as OperationToolResponse;
  expect(escape.httpStatus).toBe(422);
  expect(JSON.stringify(escape.body)).toContain("gmail_delegation_query_invalid");
  expect(google.calls.length).toBe(sent);
  // The owner's own turn is not a delegated read.
  expect((await memberTurn(ownerRun, owner, peerSession, ["source.gmail.delegated.read"])).offered).not.toContain("source.gmail.delegated.read");

  // Revoked between Gmail's answer and the release: the read delivers nothing.
  const second = await memberTurn(ownerRun, peer, peerSession, ["source.gmail.delegated.read"]);
  beforeGoogle = async (url) => {
    if (!/\/messages\/[0-9a-f]+$/.test(new URL(url).pathname)) return;
    beforeGoogle = null;
    as(owner);
    expect((await action("source.gmail.delegation.revoke", { delegation_id: delegation.id })).statusCode).toBe(200);
  };
  const late = await toolCall(await loadRunRow(second.id), "source.gmail.delegated.read", { query: "interview", max_messages: 1 }) as OperationToolResponse;
  expect(late.httpStatus).not.toBe(200);
  expect(JSON.stringify(late.body)).not.toContain(BODY_MARK);
  expect(((await loadRunRow(second.id)).context_taint_json as { plugin_reads?: unknown[] } | null)?.plugin_reads ?? []).toEqual([]);
  expect((await db.pool.query(`SELECT status,end_reason FROM gmail_read_delegations WHERE id=$1`, [delegation.id])).rows[0]).toEqual({ status: "revoked", end_reason: "gmail_delegation_revoked" });
  // After revocation: not offered, and nothing is sent to Google.
  const third = await memberTurn(ownerRun, peer, peerSession, ["source.gmail.delegated.read"]);
  expect(third.offered).not.toContain("source.gmail.delegated.read");

  // A new card: then the member leaving the Project ends it in the membership writer's transaction, before the next send.
  const redraft = await proposeGmailDelegation(db.pool, ownerRun, space, { member: "lin peer", query_scope: "label:applications" }, randomUUID());
  expect((await accept(String(redraft.modelResult.proposal_id))).statusCode).toBe(200);
  const renewed = (await db.pool.query(`SELECT id FROM gmail_read_delegations WHERE status='active'`)).rows[0].id;
  const fourth = await memberTurn(ownerRun, peer, peerSession, ["source.gmail.delegated.read"]);
  beforeGoogle = async (url) => {
    if (!new URL(url).pathname.endsWith("/messages")) return;
    beforeGoogle = null;
    await new PgProjectRepository(db.pool).removeMember({ spaceId: space, userId: owner }, project, peer);
  };
  const removed = await toolCall(await loadRunRow(fourth.id), "source.gmail.delegated.read", { query: "interview", max_messages: 1 }) as OperationToolResponse;
  expect(removed.httpStatus).not.toBe(200);
  expect(JSON.stringify(removed.body)).not.toContain(BODY_MARK);
  expect((await db.pool.query(`SELECT status,end_reason FROM gmail_read_delegations WHERE id=$1`, [renewed])).rows[0]).toEqual({ status: "revoked", end_reason: "gmail_delegation_member_left" });

  // Turning Agent reads off ends every delegation of the mailbox.
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, peer]);
  const third_ = await proposeGmailDelegation(db.pool, ownerRun, space, { member: "lin peer", query_scope: "from:@uni.example" }, randomUUID());
  expect((await accept(String(third_.modelResult.proposal_id))).statusCode).toBe(200);
  await ok(action("source.gmail.connection.set_agent_read", { connection_id: connectionId, enabled: false }));
  expect((await db.pool.query(`SELECT status,end_reason FROM gmail_read_delegations WHERE query_scope='from:@uni.example'`)).rows[0]).toEqual({ status: "revoked", end_reason: "gmail_delegation_connection_ended" });
});

it("ADR 0035 §1: continues facts unlocked by a later successful delivery using live application visibility and Room audience", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const { run: privateRun, session: privateSession, hostId } = await ownerConversation();
  const room = await ownerRoomTurn(privateRun, privateSession, [owner, peer]);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, room.run, space, { effects: ["interview", "rejected"] }, randomUUID());
  expect((await accept(String(drafted.modelResult.proposal_id))).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE proposal_id=$1`, [drafted.modelResult.proposal_id])).rows[0];
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const oxford = await application("University of Oxford", "DPhil in Engineering");
  const mit = await application("MIT", "SM in EECS");
  const notices = async () => (await db.pool.query(`SELECT content,metadata_json FROM messages WHERE session_id=$1 AND role='system' ORDER BY created_at`, [room.session])).rows;
  const kept = async () => (await db.pool.query(`SELECT application_id,posted_delivery_id FROM gmail_application_shared_results WHERE digest_id=$1 ORDER BY recorded_at,id`, [digest.id])).rows;
  /** One delivery of the automation: started, launched and its frozen mail read, as the scheduler and runtime do. */
  const delivery = async () => {
    await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [digest.id]);
    const started = await startGmailDigestDelivery(db.pool, config, digest.id);
    expect(started, JSON.stringify({ digest: (await db.pool.query(`SELECT status,last_error_code FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0], mail: await items(digest.id) })).toBe("started");
    const row = (await db.pool.query(`SELECT id,run_id FROM gmail_digest_deliveries WHERE digest_id=$1 AND status='running'`, [digest.id])).rows[0];
    const { loadRun, call } = await launch(privateRun, row.run_id, hostId);
    expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
    const apply = async (applicationId: string, message: Mail, status: string) => expect((await call("plugin.phd_application.mail_fact.apply", {
      project_id: project, application_id: applicationId, expected_revision: (await appRow(applicationId)).revision,
      source: { kind: "gmail", message_id: message.id, received_at: iso(message.at) }, effect: { kind: "status", status } })).httpStatus).toBe(200);
    const settle = async (status: "succeeded" | "failed") => {
      await db.pool.query(`UPDATE runs SET status=$2 WHERE id=$1`, [row.run_id, status]);
      const settled = await settleGmailDigestRun(db.pool, config, await loadRun(), status === "succeeded" ? "Checked the new mail." : null, (tx, content) =>
        new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, digest.session_id, row.run_id, { content }));
      // The conversation's turn ends with the Run, as the runtime's outcome and the chat finalizer release it.
      const ended = await loadRun();
      expect((await recordHostThreadOutcome(config, ended.host_task_thread_id!, ended, status === "succeeded")).claim).toBe("released");
      if (status === "succeeded") await db.pool.query(`INSERT INTO run_events (id,space_id,run_id,event_index,event_type,status,created_at)
        VALUES ($1,$2,$3::varchar,(SELECT COALESCE(max(event_index),0)+1 FROM run_events WHERE run_id=$3::varchar),'chat_completed','succeeded',now())`, [randomUUID(), space, row.run_id]);
      return settled;
    };
    return { id: row.id as string, apply, settle };
  };

  // A: two facts are committed on shared applications, then the delivery fails: nothing is posted, and nothing is lost.
  const [m1, m2, m3] = await newMail(connectionId, digest.id, 3);
  const a = await delivery();
  await a.apply(eth, m1!, "interview");
  await a.apply(oxford, m2!, "rejected");
  await a.settle("failed");
  expect(await notices()).toEqual([]);
  expect(await kept()).toEqual([{ application_id: eth, posted_delivery_id: null }, { application_id: oxford, posted_delivery_id: null }]);

  // Oxford is made private before any notice: its committed result is never posted. B retries the same mail (the
  // earlier fact is a replay and keeps nothing twice) and records a new one; then a reader outside the Project joins
  // the Room before B settles, so B's success posts nothing and every result waits.
  await db.pool.query(`UPDATE plugin_phd_application.applications SET project_shared=false WHERE id=$1`, [oxford]);
  const b = await delivery();
  await b.apply(eth, m1!, "interview");
  await b.apply(mit, m3!, "interview");
  const outsider = randomUUID();
  await seedSpaceMember(db.pool, { space, user: outsider });
  const outsiderRow = randomUUID();
  await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [outsiderRow, space, room.room, outsider]);
  expect(await b.settle("succeeded")).not.toBeNull();
  expect(await notices()).toEqual([]);
  expect((await kept()).map((row) => row.posted_delivery_id)).toEqual([null, null, null]);

  // The outsider leaves and ETH is renamed. The scheduler continues B's notice using current labels
  // for ETH and MIT and drops the result for Oxford, which is now private.
  await db.pool.query(`DELETE FROM room_user_members WHERE id=$1`, [outsiderRow]);
  await db.pool.query(`UPDATE plugin_phd_application.applications SET program='PhD in Informatics' WHERE id=$1`, [eth]);
  await newMail(connectionId, digest.id, 1);
  await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL WHERE id=$1`, [digest.id]);
  expect(await startDueGmailDigests(db.pool, config)).toBe(0);
  const posted = await notices();
  expect(posted).toHaveLength(1);
  expect(posted[0].metadata_json).toMatchObject({ execution_event: "gmail_application_updates", execution_details: { delivery_id: b.id, results: 2 } });
  expect(posted[0].content).toContain("ETH Zurich · PhD in Informatics: status interview (was planning)");
  expect(posted[0].content).toContain("MIT · SM in EECS: status interview");
  for (const hidden of ["Oxford", "rejected", "PhD in Computer Science"]) expect(posted[0].content).not.toContain(hidden);
  expect(await kept()).toEqual([{ application_id: eth, posted_delivery_id: b.id }, { application_id: mit, posted_delivery_id: b.id }]);

  // The waiting mail can now settle without repeating the notice.
  const c = await delivery();
  expect(await c.settle("succeeded")).not.toBeNull();
  expect(await notices()).toHaveLength(1);
});

it("ADR 0035 §1: continues settled notices under live authority before new Runs can fail and pause the automation", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const { run, session, hostId } = await ownerConversation();
  const room = await ownerRoomTurn(run, session, [owner, peer]);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, room.run, space, { effects: ["interview", "deadline"] }, randomUUID());
  expect((await accept(String(drafted.modelResult.proposal_id))).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT id,session_id FROM gmail_digests WHERE proposal_id=$1`, [drafted.modelResult.proposal_id])).rows[0];
  const target = await application("Example University", "PhD");
  const [mail] = await newMail(connectionId, digest.id, 1);
  expect(await startGmailDigestDelivery(db.pool, config, digest.id)).toBe("started");
  const delivery = await runningDelivery(digest.id);
  const { call, loadRun } = await launch(run, delivery.run_id, hostId);
  expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
  const apply = async (applicationId: string, effect: Record<string, string>) => {
    const result = await call("plugin.phd_application.mail_fact.apply", {
      project_id: project, application_id: applicationId, expected_revision: (await appRow(applicationId)).revision,
      source: { kind: "gmail", message_id: mail!.id, received_at: iso(mail!.at) }, effect,
    });
    expect(result.httpStatus).toBe(200);
    return (result.body as { data: Record<string, unknown> }).data;
  };

  // Same message, application and date: only the business fact distinguishes these deadlines.
  const dueOn = "2027-01-20";
  const funding = { kind: "deadline", deadline_kind: "funding", due_on: dueOn };
  const references = { kind: "deadline", deadline_kind: "references", due_on: dueOn };
  for (const effect of [funding, references]) {
    expect(await apply(target, effect)).toMatchObject({ outcome: "recorded", replayed: false, deadline_kind: effect.deadline_kind });
  }
  for (let i = 0; i < 49; i++) {
    const other = await application(`Synthetic university ${i}`, "PhD");
    expect(await apply(other, { kind: "status", status: "interview" })).toMatchObject({ outcome: "recorded", replayed: false });
  }
  const legacy = await application("Legacy University", "PhD");
  expect(await apply(legacy, funding)).toMatchObject({ outcome: "recorded", replayed: false });
  for (const effect of [funding, references]) {
    expect(await apply(target, effect)).toMatchObject({ outcome: "recorded", replayed: true });
  }
  const rows = async () => (await db.pool.query(`SELECT id,fact_id,deadline_kind,posted_delivery_id
    FROM gmail_application_shared_results WHERE digest_id=$1 ORDER BY recorded_at,id`, [digest.id])).rows;
  const notices = async () => (await db.pool.query(`SELECT content,metadata_json FROM messages WHERE session_id=$1 AND role='system'`, [room.session])).rows;
  const before = await rows();
  expect(before).toHaveLength(52);
  expect(new Set(before.map(row => row.fact_id)).size).toBe(52);
  expect(before.slice(0, 2).map(row => row.deadline_kind)).toEqual(["funding", "references"]);
  // An existing row from before the migration remains deliverable with its original effect and posting state.
  await db.pool.query(`UPDATE gmail_application_shared_results SET fact_id=NULL,deadline_kind=NULL WHERE id=$1`, [before[51].id]);

  await db.pool.query(`UPDATE runs SET status='succeeded' WHERE id=$1`, [delivery.run_id]);
  const settledRun = await loadRun();
  const settle = () => settleGmailDigestRun(db.pool, config, settledRun, "Checked the new mail.", (tx, content) =>
    new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, digest.session_id, delivery.run_id, { content }));
  await ok(action("official_plugin.project_binding.unbind", { plugin_id: "phd_application", project_id: project }));
  expect(await settle()).not.toBeNull();
  await settle();
  expect((await rows()).filter(row => row.posted_delivery_id === null)).toHaveLength(52);
  expect(await notices()).toHaveLength(0);
  expect(await items(digest.id)).toEqual([expect.objectContaining({ status: "done" })]);

  const tick = async () => {
    await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL WHERE id=$1`, [digest.id]);
    expect(await startDueGmailDigests(db.pool, config)).toBe(0);
  };
  const requestsBeforeRecovery = google.calls.length;
  await tick();
  expect(await notices()).toHaveLength(0);
  expect((await db.pool.query(`SELECT next_run_at > now() AS deferred FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].deferred).toBe(true);

  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  await tick();
  expect((await notices()).map(row => row.metadata_json.execution_details.results)).toEqual([50]);

  await withTransaction(db.pool, (tx) => pluginServiceFor(config).disablePlugin(tx, "phd_application", space, owner));
  await tick();
  expect(await notices()).toHaveLength(1);
  expect((await rows()).filter(row => row.posted_delivery_id === null)).toHaveLength(2);
  expect((await db.pool.query(`SELECT next_run_at > now() AS deferred FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0].deferred).toBe(true);
  await withTransaction(db.pool, (tx) => pluginServiceFor(config).enablePlugin(tx, "phd_application", space, owner, {}));
  const outsider = randomUUID(), membership = randomUUID();
  await seedSpaceMember(db.pool, { space, user: outsider });
  await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [membership, space, room.room, outsider]);
  await tick();
  expect(await notices()).toHaveLength(1);
  expect(google.calls).toHaveLength(requestsBeforeRecovery);
  await db.pool.query(`DELETE FROM room_user_members WHERE id=$1`, [membership]);

  // The next mail can start on the confirmed runtime, but its Run will never succeed.
  const [laterMail] = await newMail(connectionId, digest.id, 1);
  const settled = await loadRun();
  expect((await recordHostThreadOutcome(config, settled.host_task_thread_id!, settled, true)).claim).toBe("released");
  await db.pool.query(`INSERT INTO run_events (id,space_id,run_id,event_index,event_type,status,created_at)
    VALUES ($1,$2,$3::varchar,(SELECT COALESCE(max(event_index),0)+1 FROM run_events WHERE run_id=$3::varchar),'chat_completed','succeeded',now())`, [randomUUID(), space, settled.id]);
  const requests = google.calls.length;
  await tick();
  expect(await notices()).toHaveLength(2);
  expect(google.calls).toHaveLength(requests);
  expect(await runningDelivery(digest.id)).toBeUndefined();
  expect((await items(digest.id)).find(row => row.google_message_id === laterMail!.id)?.status).toBe("pending");
  // The continuation consumed this interval even though mail is waiting.
  expect(await startDueGmailDigests(db.pool, config)).toBe(0);

  for (let attempt = 1; attempt <= 3; attempt++) {
    await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [digest.id]);
    expect(await startDueGmailDigests(db.pool, config)).toBe(1);
    const fresh = await runningDelivery(digest.id);
    const failed = await launch(run, fresh.run_id, hostId);
    expect((await failed.call("source.gmail.digest.read", {})).httpStatus).toBe(200);
    await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [fresh.run_id]);
    const failedRun = await failed.loadRun();
    expect(await settleGmailDigestRun(db.pool, config, failedRun, null, async () => null)).toBeNull();
    expect((await recordHostThreadOutcome(config, failedRun.host_task_thread_id!, failedRun, false)).claim).toBe("released");
  }
  expect((await db.pool.query(`SELECT status,failure_count FROM gmail_digests WHERE id=$1`, [digest.id])).rows[0])
    .toEqual({ status: "paused", failure_count: 3 });
  expect((await items(digest.id)).find(row => row.google_message_id === laterMail!.id)).toMatchObject({ status: "failed", attempts: 3 });
  await tick();
  expect((await rows()).every(row => row.posted_delivery_id === delivery.id)).toBe(true);
  const posted = await notices();
  expect(posted.map(row => row.metadata_json.execution_details.results).sort((a, b) => a - b)).toEqual([2, 50]);
  expect(new Set(posted.map(row => row.metadata_json.execution_event_key)).size).toBe(2);
  const body = posted.map(row => row.content).join("\n");
  for (const kind of ["funding", "references"]) expect(body).toContain(`${kind} deadline added for ${dueOn}`);
  expect(body).toContain(`Legacy University · PhD: deadline added for ${dueOn}`);
  for (const marker of [SUBJECT_MARK, BODY_MARK]) expect(body).not.toContain(marker);
});

it("ADR 0035 §4: in a Room, a reader outside the Project who joins between two Gmail sends of a delegated read stops it before the next send; nothing is released", async () => {
  await connect();
  const { run: ownerRun } = await ownerConversation();
  await db.pool.query(`UPDATE users SET display_name='Lin Peer' WHERE id=$1`, [peer]);
  const drafted = await proposeGmailDelegation(db.pool, ownerRun, space, { member: "lin peer", query_scope: "label:applications" }, randomUUID());
  expect((await accept(String(drafted.modelResult.proposal_id))).statusCode).toBe(200);
  const delegation = (await db.pool.query(`SELECT id FROM gmail_read_delegations WHERE status='active'`)).rows[0].id as string;
  // The member's own turn in a Room of the Project, read by the Room's members.
  const room = await roomConversation([owner, peer]);
  const turn = await memberTurn(ownerRun, peer, room.session, ["source.gmail.delegated.read"]);
  expect(turn.offered).toContain("source.gmail.delegated.read");
  await db.pool.query(`UPDATE runs SET visibility='selected_users' WHERE id=$1`, [turn.id]);
  deliver({ subject: `${SUBJECT_MARK} Interview one`, body: `${BODY_MARK} first interview` });
  deliver({ subject: `${SUBJECT_MARK} Interview two`, body: `${BODY_MARK} second interview` });
  const outsider = randomUUID();
  await seedSpaceMember(db.pool, { space, user: outsider });
  const outsiderRow = randomUUID();
  let messageSends = 0;
  beforeGoogle = async (url) => {
    if (!/\/messages\/[0-9a-f]+$/.test(new URL(url).pathname)) return;
    messageSends += 1;
    // Between the page's first and second message: someone who is not in the Project joins the Room.
    if (messageSends === 1) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [outsiderRow, space, room.room, outsider]);
  };
  const read = await toolCall(await loadRunRow(turn.id), "source.gmail.delegated.read", { query: "interview", max_messages: 2 }) as OperationToolResponse;
  beforeGoogle = null;
  expect(read.httpStatus).not.toBe(200);
  expect(JSON.stringify(read.body)).not.toContain(BODY_MARK);
  expect(messageSends).toBe(1);
  expect(((await loadRunRow(turn.id)).context_taint_json as { plugin_reads?: unknown[] } | null)?.plugin_reads ?? []).toEqual([]);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_read_audit_events WHERE operation='delegated_read'`)).rows[0].n).toBe(0);
  expect((await db.pool.query(`SELECT read_count FROM gmail_read_delegations WHERE id=$1`, [delegation])).rows[0].read_count).toBe(0);
  // While the outsider reads the Room nothing is sent at all; once they leave, the member reads again.
  const before = google.calls.length;
  const blocked = await toolCall(await loadRunRow(turn.id), "source.gmail.delegated.read", { query: "interview", max_messages: 2 }) as OperationToolResponse;
  expect(JSON.stringify(blocked.body)).toContain("gmail_delegation_audience_outside_project");
  expect(google.calls.length).toBe(before);
  await db.pool.query(`DELETE FROM room_user_members WHERE id=$1`, [outsiderRow]);
  const again = await toolCall(await loadRunRow(turn.id), "source.gmail.delegated.read", { query: "interview", max_messages: 2 }) as OperationToolResponse;
  expect(again.httpStatus, JSON.stringify(again.body)).toBe(200);
  expect((again.body.data as { items: unknown[] }).items).toHaveLength(2);
});

it("ADR 0035 §2: a live digest is reused only for this conversation, time, time zone and configuration; otherwise the one card changes it in place, keeping its history", async () => {
  await connect();
  const { run: privateRun, session: privateSession } = await ownerConversation();
  const setup = (run: string, input: Record<string, unknown>) => proposeGmailSetup(db.pool, config, run, space, input as never, randomUUID());
  const card = async (result: Awaited<ReturnType<typeof setup>>) => (await db.pool.query(`SELECT * FROM proposals WHERE id=$1`, [result.modelResult.proposal_id])).rows[0];
  const digestGrants = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE plugin_id='core:gmail_digest' AND status='active'`)).rows[0].n as number;
  const berlin = { daily_digest: { local_time: "08:00", time_zone: "Europe/Berlin" } };
  const first = await setup(privateRun, berlin);
  expect(first.modelResult, JSON.stringify(first)).toMatchObject({ ok: true, reused: [] });
  expect((await accept(String(first.modelResult.proposal_id))).statusCode).toBe(200);
  const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE kind='daily' AND status='active'`)).rows[0];
  // Its history: an earlier delivered window.
  await db.pool.query(`INSERT INTO gmail_digest_deliveries (id,digest_id,space_id,owner_user_id,window_start,window_end,gap_before,message_ids,run_id,status,message_count,read_complete,created_at,finished_at)
    VALUES ($1,$2,$3,$4,now()-interval '2 days',now()-interval '1 day',false,NULL,NULL,'delivered',3,true,now()-interval '1 day',now()-interval '1 day')`, [randomUUID(), digest.id, space, owner]);

  // Exactly what is allowed: reused, no card.
  expect((await setup(privateRun, berlin)).modelResult).toMatchObject({ ok: true, already_allowed: ["daily_digest"] });

  // Another time and time zone: not "already allowed" — a card that says what the digest is now and changes it in place.
  const shanghai = { daily_digest: { local_time: "09:00", time_zone: "Asia/Shanghai" } };
  const retimed = await setup(privateRun, shanghai);
  expect(retimed.modelResult, JSON.stringify(retimed)).toMatchObject({ ok: true, reused: [] });
  const retimedCard = await card(retimed);
  expect(retimedCard.payload_json.parts).toEqual([expect.objectContaining({ kind: "daily", local_time: "09:00", time_zone: "Asia/Shanghai", replaces_digest_id: digest.id })]);
  expect(retimedCard.summary).toContain("Changes your existing daily digest (now at 08:00 (Europe/Berlin)) in place, keeping its history");
  expect((await accept(retimedCard.id)).statusCode).toBe(200);
  const retimedRow = (await db.pool.query(`SELECT * FROM gmail_digests WHERE kind='daily' AND status<>'ended'`)).rows;
  expect(retimedRow).toHaveLength(1);
  expect(retimedRow[0]).toMatchObject({ id: digest.id, local_time: "09:00", time_zone: "Asia/Shanghai", status: "active", session_id: privateSession, proposal_id: retimedCard.id });
  expect((await db.pool.query(`SELECT status FROM plugin_data_grants WHERE id=$1`, [digest.grant_id])).rows[0].status).toBe("revoked");
  expect(await digestGrants()).toBe(1);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digest_deliveries WHERE digest_id=$1`, [digest.id])).rows[0].n).toBe(1);
  expect((await setup(privateRun, shanghai)).modelResult).toMatchObject({ ok: true, already_allowed: ["daily_digest"] });

  // Asked for in a Room: delivered elsewhere today, so the card moves the same digest there.
  const room = await ownerRoomTurn(privateRun, privateSession, [owner, peer]);
  const moved = await setup(room.run, shanghai);
  expect(moved.modelResult, JSON.stringify(moved)).toMatchObject({ ok: true, reused: [] });
  const movedCard = await card(moved);
  expect(movedCard.payload_json.parts).toEqual([expect.objectContaining({ replaces_digest_id: digest.id, session_id: room.session })]);
  expect(movedCard.summary).toContain("delivered in another conversation");
  expect((await accept(movedCard.id)).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT id,session_id,status FROM gmail_digests WHERE kind='daily' AND status<>'ended'`)).rows).toEqual([{ id: digest.id, session_id: room.session, status: "active" }]);
  expect(await digestGrants()).toBe(1);

  // The Room's model changed since its card: not reused, the card names the change; and once the digest ends, that
  // card no longer changes anything.
  await db.pool.query(`UPDATE session_conversation_backends SET session_config_json=$2::jsonb WHERE session_id=$1`,
    [room.session, JSON.stringify([{ id: "model", type: "select", value: "synthetic-model-b", category: "model" }])]);
  const reconfigured = await setup(room.run, shanghai);
  expect(reconfigured.modelResult, JSON.stringify(reconfigured)).toMatchObject({ ok: true, reused: [] });
  const reconfiguredCard = await card(reconfigured);
  expect(reconfiguredCard.summary).toContain("now on another Agent runtime, Provider, model or session options");
  await ok(action("source.gmail.digest.end", { digest_id: digest.id }));
  const stale = await accept(reconfiguredCard.id);
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.body).toContain("gmail_digest_changed");
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM gmail_digests WHERE status<>'ended'`)).rows[0].n).toBe(0);
});

it("ADR 0035 §2: two cards changing one digest in place are bound to the version they were drafted against: accepted out of order, the older never overwrites the newer", async () => {
  await connect();
  const { run: privateRun, session: privateSession } = await ownerConversation();
  const setup = (run: string, input: Record<string, unknown>) => proposeGmailSetup(db.pool, config, run, space, input as never, randomUUID());
  const card = async (result: Awaited<ReturnType<typeof setup>>) => (await db.pool.query(`SELECT * FROM proposals WHERE id=$1`, [result.modelResult.proposal_id])).rows[0];
  const live = async () => (await db.pool.query(`SELECT id,proposal_id,session_id,local_time,time_zone,status FROM gmail_digests WHERE kind='daily' AND status<>'ended'`)).rows;
  const first = await setup(privateRun, { daily_digest: { local_time: "08:00", time_zone: "Europe/Berlin" } });
  expect((await accept(String(first.modelResult.proposal_id))).statusCode).toBe(200);
  const [digest] = await live();

  // Card A (here, 09:00 Shanghai) and card B (in a Room, 10:00 Tokyo) are both drafted against the digest as first confirmed.
  const a = await card(await setup(privateRun, { daily_digest: { local_time: "09:00", time_zone: "Asia/Shanghai" } }));
  const room = await ownerRoomTurn(privateRun, privateSession, [owner, peer]);
  const b = await card(await setup(room.run, { daily_digest: { local_time: "10:00", time_zone: "Asia/Tokyo" } }));
  for (const drafted of [a, b]) expect(drafted.payload_json.parts).toEqual([expect.objectContaining({ replaces_digest_id: digest.id, replaces_proposal_id: digest.proposal_id, replaces_local_time: "08:00" })]);

  // B is accepted first; A, accepted after, describes a digest that no longer exists and changes nothing.
  expect((await accept(b.id)).statusCode).toBe(200);
  const stale = await accept(a.id);
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.body).toContain("gmail_digest_changed");
  expect(await live()).toEqual([{ id: digest.id, proposal_id: b.id, session_id: room.session, local_time: "10:00", time_zone: "Asia/Tokyo", status: "active" }]);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE plugin_id='core:gmail_digest' AND status='active'`)).rows[0].n).toBe(1);

  // A card drafted against B's digest is also refused once the owner changed its time themselves (no new card).
  const c = await card(await setup(privateRun, { daily_digest: { local_time: "07:00", time_zone: "Europe/Berlin" } }));
  expect(c.payload_json.parts).toEqual([expect.objectContaining({ replaces_proposal_id: b.id, replaces_local_time: "10:00" })]);
  await ok(action("source.gmail.digest.set_time", { digest_id: digest.id, local_time: "11:30" }));
  const retimed = await accept(c.id);
  expect(retimed.statusCode, retimed.body).toBe(409);
  expect(retimed.body).toContain("gmail_digest_changed");
  expect(await live()).toEqual([expect.objectContaining({ proposal_id: b.id, session_id: room.session, local_time: "11:30", time_zone: "Asia/Tokyo" })]);

  // A card that carries the digest id without the version it was drafted against is never accepted.
  const d = await card(await setup(privateRun, { daily_digest: { local_time: "06:00", time_zone: "Europe/Berlin" } }));
  const parts = (d.payload_json.parts as Record<string, unknown>[]).map(({ replaces_proposal_id: _drop, ...part }) => part);
  await db.pool.query(`UPDATE proposals SET payload_json=jsonb_set(payload_json,'{parts}',$2::jsonb) WHERE id=$1`, [d.id, JSON.stringify(parts)]);
  expect((await accept(d.id)).statusCode).toBeGreaterThanOrEqual(400);
  expect(await live()).toEqual([expect.objectContaining({ proposal_id: b.id, local_time: "11:30" })]);
});

it("ADR 0035 §1: a result waiting from a failed delivery is posted only to the conversation and card it was recorded under; re-carded to another Room it is deleted, never carried there", async () => {
  const connectionId = await connect();
  await ok(action("official_plugin.project_binding.bind", { plugin_id: "phd_application", project_id: project }));
  const { run: privateRun, session: privateSession, hostId } = await ownerConversation();
  const first = await ownerRoomTurn(privateRun, privateSession, [owner, peer]);
  const drafted = await proposeGmailApplicationUpdates(db.pool, config, first.run, space, { effects: ["interview", "rejected"] }, randomUUID());
  expect((await accept(String(drafted.modelResult.proposal_id))).statusCode).toBe(200);
  const digestId = (await db.pool.query(`SELECT id FROM gmail_digests WHERE proposal_id=$1`, [drafted.modelResult.proposal_id])).rows[0].id as string;
  const eth = await application("ETH Zurich", "PhD in Computer Science");
  const mit = await application("MIT", "SM in EECS");
  const notices = async (session: string) => (await db.pool.query(`SELECT content FROM messages WHERE session_id=$1 AND role='system' ORDER BY created_at`, [session])).rows;
  const kept = async () => (await db.pool.query(`SELECT application_id,notice_session_id,rule_version,posted_delivery_id FROM gmail_application_shared_results WHERE digest_id=$1 ORDER BY recorded_at,id`, [digestId])).rows;
  const delivery = async () => {
    const digest = (await db.pool.query(`SELECT * FROM gmail_digests WHERE id=$1`, [digestId])).rows[0];
    await db.pool.query(`UPDATE gmail_digests SET next_run_at=NULL,retry_not_before=NULL WHERE id=$1`, [digestId]);
    expect(await startGmailDigestDelivery(db.pool, config, digestId)).toBe("started");
    const row = (await db.pool.query(`SELECT id,run_id FROM gmail_digest_deliveries WHERE digest_id=$1 AND status='running'`, [digestId])).rows[0];
    const { loadRun, call } = await launch(privateRun, row.run_id, hostId);
    expect((await call("source.gmail.digest.read", {})).httpStatus).toBe(200);
    const apply = async (applicationId: string, message: Mail) => expect((await call("plugin.phd_application.mail_fact.apply", {
      project_id: project, application_id: applicationId, expected_revision: (await appRow(applicationId)).revision,
      source: { kind: "gmail", message_id: message.id, received_at: iso(message.at) }, effect: { kind: "status", status: "interview" } })).httpStatus).toBe(200);
    const settle = async (status: "succeeded" | "failed") => {
      await db.pool.query(`UPDATE runs SET status=$2 WHERE id=$1`, [row.run_id, status]);
      const settled = await settleGmailDigestRun(db.pool, config, await loadRun(), status === "succeeded" ? "Checked the new mail." : null, (tx, content) =>
        new PgSessionRepository(tx).addAssistantMessageForRun(space, owner, digest.session_id, row.run_id, { content }));
      const ended = await loadRun();
      expect((await recordHostThreadOutcome(config, ended.host_task_thread_id!, ended, status === "succeeded")).claim).toBe("released");
      if (status === "succeeded") await db.pool.query(`INSERT INTO run_events (id,space_id,run_id,event_index,event_type,status,created_at)
        VALUES ($1,$2,$3::varchar,(SELECT COALESCE(max(event_index),0)+1 FROM run_events WHERE run_id=$3::varchar),'chat_completed','succeeded',now())`, [randomUUID(), space, row.run_id]);
      return settled;
    };
    return { id: row.id as string, apply, settle };
  };

  // Recorded for the first Room under its card, then the delivery fails: the result waits, bound to both.
  const [m1, m2] = await newMail(connectionId, digestId, 2);
  const a = await delivery();
  await a.apply(eth, m1!);
  await a.settle("failed");
  expect(await kept()).toEqual([{ application_id: eth, notice_session_id: first.session, rule_version: drafted.modelResult.proposal_id, posted_delivery_id: null }]);

  // The owner re-cards the automation to post into another Room (its readers are not the first Room's).
  const third = randomUUID();
  await seedSpaceMember(db.pool, { space, user: third });
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, third]);
  const second = await ownerRoomTurn(privateRun, privateSession, [owner, third]);
  const moved = await proposeGmailApplicationUpdates(db.pool, config, second.run, space, { effects: ["interview", "rejected"] }, randomUUID());
  expect(moved.modelResult, JSON.stringify(moved)).toMatchObject({ ok: true });
  expect((await accept(String(moved.modelResult.proposal_id))).statusCode).toBe(200);
  expect((await db.pool.query(`SELECT id,notice_session_id,proposal_id FROM gmail_digests WHERE kind='application' AND status<>'ended'`)).rows)
    .toEqual([{ id: digestId, notice_session_id: second.session, proposal_id: moved.modelResult.proposal_id }]);

  // The next successful delivery posts only what it recorded under the new card into the new Room; the first Room's
  // waiting result is deleted unposted and appears in neither conversation.
  const b = await delivery();
  await b.apply(mit, m2!);
  expect(await b.settle("succeeded")).not.toBeNull();
  const posted = await notices(second.session);
  expect(posted).toHaveLength(1);
  expect(posted[0].content).toContain("MIT · SM in EECS: status interview");
  expect(posted[0].content).not.toContain("ETH");
  expect(await notices(first.session)).toEqual([]);
  expect(await kept()).toEqual([{ application_id: mit, notice_session_id: second.session, rule_version: moved.modelResult.proposal_id, posted_delivery_id: b.id }]);
});
