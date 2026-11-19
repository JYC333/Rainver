import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { HostLaunchIsolation, LaunchWorkspace } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedRun, seedServerHost, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { prepareHostConversationDispatch } from "../src/modules/agentGroups/service.js";
import { resolveRuntimeProfileScope, runtimeProfileKey, type RuntimeProfileScope } from "../src/modules/runs/remoteProviderBinding.js";
import { directChatMayReadSensitive, sensitiveLaunchRefusal, sensitiveThreadResumable } from "../src/modules/runs/sensitiveRuntimeProfile.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";

// ADR 0032 host-state isolation contract on real PostgreSQL, synthetic rows only: which
// container a direct chat that may read sensitive data is admitted into, when its turn
// replays as fresh, and what its launch must state. No mailbox, Host process or CLI is involved.
const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const HOST = "33333333-3333-4333-8333-333333333333";
const GMAIL_PIN = { plugin_tool_pins: { "source.gmail.mail.read": { data_class: "sensitive" } } };
const PROFILE = (session: string, provider = "prov-1") => `agents/${AGENT}/conversation/${session}/claude_code/${provider}`;

const db = useTestDatabase(import.meta.filename);
let tick = 0;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["run_attempts", "runs", "host_threads", "sessions", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"], { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT, now: new Date().toISOString() });
  await seedServerHost(db.pool, { id: HOST, now });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
});

async function directSession(projectId: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO sessions (id, space_id, user_id, project_id, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [id, SPACE, OWNER, projectId]);
  return id;
}

/** A Run of the Session on a thread, created in order, with one attempt launched as stated (or not launched). */
async function run(sessionId: string, snapshot: Record<string, unknown>, thread: string | null, launch: Record<string, unknown> | null) {
  const id = randomUUID();
  tick += 1;
  await seedRun(db.pool, { id, space: SPACE, owner: OWNER, agent: AGENT, version: VERSION, existingAgent: true,
    now: new Date(Date.UTC(2026, 10, 18, 0, 0, tick)).toISOString() });
  await db.pool.query("UPDATE runs SET session_id=$2, permission_snapshot_json=$3::jsonb, host_task_thread_id=$4, instructed_by_user_id=$5 WHERE id=$1",
    [id, sessionId, JSON.stringify(snapshot), thread, OWNER]);
  const launchId = launch ? randomUUID() : null;
  await db.pool.query(`INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, launch_id, launch_isolation_json, created_at, updated_at)
    VALUES ($1,$2,$3,1,'failed',$4,$5::jsonb,now(),now())`,
    [randomUUID(), SPACE, id, launchId, launch ? JSON.stringify({ launch_id: launchId, host_id: HOST, ...launch }) : null]);
  return id;
}
const isolatedLaunch = (profile_key: string) => ({ host_kind: "server", egress_profile: "none", sandbox_mode: "read_write", model_channel: "provider_lease", profile_key });
const openLaunch = { host_kind: "server", egress_profile: "default", sandbox_mode: "read_write" };

const backend = {
  execution_host_id: HOST, workspace_mode: "managed", workspace_location_id: null,
  runtime_key: "claude_code", runtime_installation: "managed:1.0.0",
} as never;
const admit = (sessionId: string, container: Parameters<typeof prepareHostConversationDispatch>[0]["container"]) =>
  prepareHostConversationDispatch({ db: db.pool, backend, container, sessionId, spaceId: SPACE, projectId: null, agentId: AGENT, userId: OWNER });
const own = (sessionId: string) => ({ kind: "conversation" as const, conversation_id: sessionId, direct: true as const, sensitive: true as const });
/**
 * A dispatch that ended, as the thread records it: the claim released and the Run's outcome
 * recorded through the real repository, which binds a reported session to the Run's launch.
 */
async function settle(threadId: string, runId: string, vendorSessionId: string | null) {
  await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL, last_session_id=(SELECT session_id FROM runs WHERE id=$2::varchar) WHERE id=$1",
    [threadId, runId]);
  return new PgHostThreadRepository(db.pool).recordRunOutcome(threadId, { lastRunId: runId, vendorSessionId, sessionReset: false });
}
const pointer = async (threadId: string) => (await db.pool.query<{ vendor_session_id: string | null; vendor_session_launch_id: string | null; status: string }>(
  "SELECT vendor_session_id, vendor_session_launch_id, status FROM host_threads WHERE id=$1", [threadId])).rows[0];
const launchOf = async (runId: string) => (await db.pool.query<{ launch_id: string }>("SELECT launch_id FROM run_attempts WHERE run_id=$1", [runId])).rows[0].launch_id;
/** Whether the launch may resume exactly `vendorSessionId`, the session it hands the CLI. */
const resumable = (threadId: string, vendorSessionId: string, profileKey?: string) =>
  sensitiveThreadResumable(db.pool, threadId, { vendorSessionId, profileKey });
const unisolatedHistory = async (threadId: string) => Number((await db.pool.query<{ n: string }>(
  `SELECT count(*) AS n FROM run_attempts a JOIN runs r ON r.id = a.run_id
    WHERE r.host_task_thread_id = $1 AND a.launch_id IS NOT NULL AND a.launch_isolation_json->>'egress_profile' <> 'none'`, [threadId])).rows[0].n);

describe("host state of a direct chat that may read sensitive data", () => {
  it("is admitted into its own Session's container: thread, managed cwd and profile, never the owner's direct ones", async (ctx) => {
    if (!db.available) return ctx.skip();
    const a = await directSession();
    const b = await directSession();
    // An ordinary direct chat keeps the owner's shared container, as before.
    expect(await directChatMayReadSensitive(db.pool, { spaceId: SPACE, userId: OWNER, sessionId: a })).toBe(false);
    const shared = await admit(b, { kind: "direct", user_id: OWNER });
    expect(shared!.workspace).toEqual({ kind: "managed", agent_id: AGENT, container: { kind: "direct", user_id: OWNER } });
    await settle(shared!.host_thread.id, await run(b, {}, shared!.host_thread.id, openLaunch), "vendor-shared");

    // Once a Run of A pinned a sensitive tool, A may read from then on.
    await run(a, GMAIL_PIN, null, null);
    expect(await directChatMayReadSensitive(db.pool, { spaceId: SPACE, userId: OWNER, sessionId: a })).toBe(true);
    const first = await admit(a, own(a));
    expect(first!.host_thread.id).not.toBe(shared!.host_thread.id);
    expect(first!.workspace).toEqual({ kind: "managed", agent_id: AGENT, container: { kind: "conversation", conversation_id: a } });
    // Fresh, decided before any context exists: the shared thread's vendor session is not this thread's.
    expect(first).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    const scope = await resolveRuntimeProfileScope(db.pool, { agent_id: AGENT, host_task_thread_id: first!.host_thread.id }, null);
    expect(runtimeProfileKey(scope, "claude_code", "prov-1")).toBe(PROFILE(a));
    // B's container is untouched by A.
    expect((await db.pool.query("SELECT vendor_session_id FROM host_threads WHERE id=$1", [shared!.host_thread.id])).rows[0].vendor_session_id).toBe("vendor-shared");
  });

  it("replays as fresh after a first turn that failed before its runtime started a session, and resumes only an isolated one", async (ctx) => {
    if (!db.available) return ctx.skip();
    const a = await directSession();
    const thread = (await admit(a, own(a)))!.host_thread.id;
    // The first turn failed before launch (no session): the next turn is still fresh.
    await settle(thread, await run(a, GMAIL_PIN, thread, null), null);
    expect(await admit(a, own(a))).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    // An isolated turn in this profile started a session: the next turn resumes it.
    await settle(thread, await run(a, GMAIL_PIN, thread, isolatedLaunch(PROFILE(a))), "vendor-isolated");
    expect(await admit(a, own(a))).toMatchObject({ host_prompt_fresh: false, host_resume_attempted: true });
    expect(await resumable(thread, "vendor-isolated", PROFILE(a))).toBe(true);
    // The same session under another backend's profile is not the current profile's.
    expect(await resumable(thread, "vendor-isolated", PROFILE(a, "prov-2"))).toBe(false);
  });

  it("retires a vendor session that any unisolated launch on the thread could have started", async (ctx) => {
    if (!db.available) return ctx.skip();
    const a = await directSession();
    const thread = (await admit(a, own(a)))!.host_thread.id;
    await settle(thread, await run(a, {}, thread, openLaunch), "vendor-open");
    const next = await admit(a, own(a));
    expect(next).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    expect((await db.pool.query("SELECT vendor_session_id, status, retired_vendor_session_ids FROM host_threads WHERE id=$1", [thread])).rows[0])
      .toEqual({ vendor_session_id: null, status: "session_reset", retired_vendor_session_ids: ["vendor-open"] });
  });
});

describe("resuming the current vendor session of a conversation that may read sensitive data", () => {
  it("direct chat: after a reset, a session an isolated launch started resumes although unisolated history remains", async (ctx) => {
    if (!db.available) return ctx.skip();
    const a = await directSession();
    const thread = (await admit(a, own(a)))!.host_thread.id;
    await settle(thread, await run(a, {}, thread, openLaunch), "vendor-open");
    // Admission retires the session the unisolated launch reported, binding included.
    expect(await admit(a, own(a))).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    expect(await pointer(thread)).toEqual({ vendor_session_id: null, vendor_session_launch_id: null, status: "session_reset" });
    // The fresh turn launched isolated in this profile and started a new session, bound to that launch.
    const isolated = await run(a, GMAIL_PIN, thread, isolatedLaunch(PROFILE(a)));
    await settle(thread, isolated, "vendor-isolated");
    expect(await pointer(thread)).toMatchObject({ vendor_session_id: "vendor-isolated", vendor_session_launch_id: await launchOf(isolated) });
    expect(await unisolatedHistory(thread)).toBe(1);
    // The next turn resumes it, at admission and at launch, in exactly this profile only.
    expect(await admit(a, own(a))).toMatchObject({ host_prompt_fresh: false, host_resume_attempted: true });
    expect(await resumable(thread, "vendor-isolated", PROFILE(a))).toBe(true);
    expect(await resumable(thread, "vendor-isolated", PROFILE(a, "prov-2"))).toBe(false);
  });

  it("Project conversation: a launch-time refusal resets the thread and the next isolated session resumes", async (ctx) => {
    if (!db.available) return ctx.skip();
    const p = await directSession(PROJECT);
    const container = { kind: "conversation" as const, conversation_id: p, direct: true as const };
    const admitProject = () => prepareHostConversationDispatch({ db: db.pool, backend, container, sessionId: p, spaceId: SPACE, projectId: PROJECT, agentId: AGENT, userId: OWNER });
    const thread = (await admitProject())!.host_thread.id;
    const threads = new PgHostThreadRepository(db.pool);
    await settle(thread, await run(p, {}, thread, openLaunch), "vendor-open");
    // A Run of this conversation that must launch isolated finds the pointer bound to an
    // unisolated launch: the launch refuses the resume and retires that session, as the adapter does.
    expect(await resumable(thread, "vendor-open", PROFILE(p))).toBe(false);
    await threads.resetConversationAgent(thread, "vendor-open");
    expect(await pointer(thread)).toEqual({ vendor_session_id: null, vendor_session_launch_id: null, status: "session_reset" });
    expect(await admitProject()).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    await settle(thread, await run(p, { sensitive_conversation: true }, thread, isolatedLaunch(PROFILE(p))), "vendor-isolated");
    expect(await unisolatedHistory(thread)).toBe(1);
    expect(await resumable(thread, "vendor-isolated", PROFILE(p))).toBe(true);
    expect(await admitProject()).toMatchObject({ host_prompt_fresh: false, host_resume_attempted: true });
  });

  it("keeps the binding through a failed turn and a late report of a retired session, and moves it with the pointer", async (ctx) => {
    if (!db.available) return ctx.skip();
    const a = await directSession();
    const thread = (await admit(a, own(a)))!.host_thread.id;
    const open = await run(a, {}, thread, openLaunch);
    await settle(thread, open, "vendor-open");
    await admit(a, own(a)); // retires vendor-open
    const isolated = await run(a, GMAIL_PIN, thread, isolatedLaunch(PROFILE(a)));
    await settle(thread, isolated, "vendor-isolated");
    const bound = await launchOf(isolated);
    // A later turn that failed, even one launched unisolated, reports no session: pointer and binding stay.
    await settle(thread, await run(a, {}, thread, openLaunch), null);
    expect(await pointer(thread)).toMatchObject({ vendor_session_id: "vendor-isolated", vendor_session_launch_id: bound });
    expect(await resumable(thread, "vendor-isolated", PROFILE(a))).toBe(true);
    // A late report of the retired session does not bring it, or its launch, back.
    await settle(thread, await run(a, {}, thread, openLaunch), "vendor-open");
    expect(await pointer(thread)).toMatchObject({ vendor_session_id: "vendor-isolated", vendor_session_launch_id: bound });
    // A launch that reports the current session rebinds it: an unisolated one is then not resumed.
    const reopened = await run(a, {}, thread, openLaunch);
    await settle(thread, reopened, "vendor-isolated");
    expect(await pointer(thread)).toMatchObject({ vendor_session_id: "vendor-isolated", vendor_session_launch_id: await launchOf(reopened) });
    expect(await resumable(thread, "vendor-isolated", PROFILE(a))).toBe(false);
  });

  it("judges the exact session handed to the CLI, and a refusal retires only that one, never a newer pointer", async (ctx) => {
    if (!db.available) return ctx.skip();
    const a = await directSession();
    const thread = (await admit(a, own(a)))!.host_thread.id;
    await settle(thread, await run(a, GMAIL_PIN, thread, isolatedLaunch(PROFILE(a))), "vendor-first");
    const newer = await run(a, GMAIL_PIN, thread, isolatedLaunch(PROFILE(a)));
    await settle(thread, newer, "vendor-newer");
    // A Run whose frozen resume id predates the newer turn: not resumable, though the current pointer is.
    expect(await resumable(thread, "vendor-first", PROFILE(a))).toBe(false);
    expect(await resumable(thread, "vendor-newer", PROFILE(a))).toBe(true);
    // Its refusal retires only the session it was handed: the newer pointer and its binding stay.
    expect(await new PgHostThreadRepository(db.pool).resetConversationAgent(thread, "vendor-first")).toBeNull();
    expect(await pointer(thread)).toEqual({ vendor_session_id: "vendor-newer", vendor_session_launch_id: await launchOf(newer), status: "active" });
    expect(await admit(a, own(a))).toMatchObject({ host_prompt_fresh: false, host_resume_attempted: true });
    // Retiring the session the thread does point at clears it, binding included.
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1", [thread]);
    expect(await new PgHostThreadRepository(db.pool).resetConversationAgent(thread, "vendor-newer")).not.toBeNull();
    expect(await pointer(thread)).toEqual({ vendor_session_id: null, vendor_session_launch_id: null, status: "session_reset" });
  });

  it("does not resume a pointer with no binding, even when every launch of the thread was isolated", async (ctx) => {
    if (!db.available) return ctx.skip();
    const a = await directSession();
    const thread = (await admit(a, own(a)))!.host_thread.id;
    await settle(thread, await run(a, GMAIL_PIN, thread, isolatedLaunch(PROFILE(a))), "vendor-isolated");
    // A pointer recorded before the binding existed, or by a Run with no recorded launch.
    await db.pool.query("UPDATE host_threads SET vendor_session_launch_id=NULL WHERE id=$1", [thread]);
    expect(await resumable(thread, "vendor-isolated", PROFILE(a))).toBe(false);
    expect(await resumable(thread, "vendor-isolated")).toBe(false);
    expect(await admit(a, own(a))).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    expect(await pointer(thread)).toEqual({ vendor_session_id: null, vendor_session_launch_id: null, status: "session_reset" });
    // A Run with no launch that reports a session leaves it unbound too.
    await settle(thread, await run(a, GMAIL_PIN, thread, null), "vendor-unlaunched");
    expect(await pointer(thread)).toMatchObject({ vendor_session_id: "vendor-unlaunched", vendor_session_launch_id: null });
    expect(await resumable(thread, "vendor-unlaunched", PROFILE(a))).toBe(false);
  });
});

describe("the launch of a Run that may read sensitive data", () => {
  const session = "77777777-7777-4777-8777-777777777777";
  const ownScope: RuntimeProfileScope = { agent_id: AGENT, container_kind: "conversation", container_id: session };
  const ownCwd: LaunchWorkspace = { kind: "managed", agent_id: AGENT, container: { kind: "conversation", conversation_id: session } };
  const none: HostLaunchIsolation = { sandbox_mode: "read_write", egress_profile: "none" };
  /** A conversation an earlier Run read sensitive plugin data in. */
  const SENSITIVE = { sensitive_conversation: true };
  const check = (over: Partial<Parameters<typeof sensitiveLaunchRefusal>[0]> = {}) => sensitiveLaunchRefusal({
    run: { session_id: session, permission_snapshot_json: GMAIL_PIN }, scope: ownScope, workspace: ownCwd, workspaceLocationId: null,
    workspaceAccess: [], isolation: none, strictHost: true, modelChannel: true, ...over,
  })?.code ?? null;

  it("lets a Gmail-pinned turn launch on the conversation's own runtime; sensitive plugin data still needs the strict Host, model-only channel and egress none", () => {
    // A Gmail pin is Project-bound (ADR 0033 §6): the conversation's own runtime, CLI login included.
    expect(check()).toBeNull();
    expect(check({ strictHost: false, modelChannel: false, isolation: { sandbox_mode: "read_write", egress_profile: "default" } })).toBeNull();
    expect(check({ strictHost: false, modelChannel: false, scope: { agent_id: AGENT, container_kind: "direct", container_id: OWNER } })).toBeNull();
    // A conversation holding sensitive plugin data keeps the isolated launch.
    expect(check({ run: { session_id: session, permission_snapshot_json: SENSITIVE }, strictHost: false })).toBe("sensitive_conversation_isolation_required");
    expect(check({ run: { session_id: session, permission_snapshot_json: SENSITIVE }, isolation: { sandbox_mode: "read_write", egress_profile: "default" } }))
      .toBe("sensitive_conversation_isolation_required");
    expect(check({ run: { session_id: session, permission_snapshot_json: { sensitive_conversation: true } }, modelChannel: false }))
      .toBe("sensitive_conversation_isolation_required");
    // A Run of the withdrawn private Gmail check never launches.
    expect(check({ run: { session_id: null, permission_snapshot_json: {}, contract_snapshot_json: { workflow_input_json: { gmail_private_check: { check_id: randomUUID() } } } } }))
      .toBe("gmail_private_check_withdrawn");
    // A Run that pins nothing sensitive and was not selected for isolation is not this check's.
    expect(check({ run: { session_id: session, permission_snapshot_json: {} }, modelChannel: false, strictHost: false })).toBeNull();
  });

  it("needs its own Session's profile and cwd and mounts nothing shared writable", () => {
    const sensitive = (over: Partial<Parameters<typeof sensitiveLaunchRefusal>[0]> = {}) => check({ run: { session_id: session, permission_snapshot_json: SENSITIVE }, ...over });
    expect(sensitive({ scope: { agent_id: AGENT, container_kind: "direct", container_id: OWNER } })).toBe("sensitive_profile_session_unconfirmed");
    expect(sensitive({ scope: { agent_id: AGENT, container_kind: "agent", container_id: AGENT } })).toBe("sensitive_profile_session_unconfirmed");
    expect(sensitive({ scope: { ...ownScope, container_id: randomUUID() } })).toBe("sensitive_profile_session_unconfirmed");
    expect(check({ run: { session_id: null, permission_snapshot_json: SENSITIVE } })).toBe("sensitive_profile_session_unconfirmed");
    expect(sensitive({ workspace: { kind: "managed", agent_id: AGENT, container: { kind: "direct", user_id: OWNER } } })).toBe("sensitive_launch_shared_workspace_refused");
    expect(sensitive({ workspace: { kind: "location", workspace_location_id: randomUUID() } })).toBe("sensitive_launch_shared_workspace_refused");
    expect(sensitive({ workspace: undefined, workspaceLocationId: randomUUID() })).toBe("sensitive_launch_shared_workspace_refused");
    expect(sensitive({ workspaceAccess: [{ access_mode: "write" }] })).toBe("sensitive_launch_shared_workspace_refused");
    // Read-only mounts stay possible.
    expect(sensitive({ workspace: { kind: "location", workspace_location_id: randomUUID() }, isolation: { sandbox_mode: "read_only", egress_profile: "none" } })).toBeNull();
    expect(sensitive({ workspaceAccess: [{ access_mode: "read" }] })).toBeNull();
  });
});
