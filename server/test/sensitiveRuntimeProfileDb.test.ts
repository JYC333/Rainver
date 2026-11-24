import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLaunchIsolation, LaunchWorkspace } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedRun, seedServerHost, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { prepareHostConversationDispatch } from "../src/modules/agentGroups/service.js";
import { resolveRuntimeProfileScope, runtimeProfileKey, type RuntimeProfileScope } from "../src/modules/runs/remoteProviderBinding.js";
import { directChatMayReadSensitive, networkedResumeVerdict, sensitiveLaunchRefusal, sensitiveThreadResumable, vendorSessionHeldIsolated } from "../src/modules/runs/sensitiveRuntimeProfile.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
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
/** An isolated launch's own CLI directory (`runtimeProfileKey`, ADR 0036 §11); the networked one is `.network`. */
const PROFILE = (session: string, provider = "prov-1") => `agents/${AGENT}/conversation/${session}/claude_code/${provider}.isolated`;

const db = useTestDatabase(import.meta.filename);
let tick = 0;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["host_command_intents", "run_attempts", "runs", "host_threads", "model_providers", "sessions", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"], { cascade: true });
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
    expect(runtimeProfileKey(scope, "claude_code", "prov-1", true)).toBe(PROFILE(a));
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

describe("a vendor session an isolated launch held, on a turn that may launch with network (ADR 0036 §11)", () => {
  const project = async () => {
    const p = await directSession(PROJECT);
    const container = { kind: "conversation" as const, conversation_id: p, direct: true as const };
    const admitProject = () => prepareHostConversationDispatch({ db: db.pool, backend, container, sessionId: p, spaceId: SPACE, projectId: PROJECT, agentId: AGENT, userId: OWNER });
    return { p, admitProject, thread: (await admitProject())!.host_thread.id };
  };
  /** The session a Run was handed to resume, as its admission froze it (`model_override_json.host_thread`). */
  const resumed = (runId: string, vendorSessionId: string) => db.pool.query(
    `UPDATE runs SET model_override_json=jsonb_build_object('host_thread',jsonb_build_object('runtime_session_id',$2::text)) WHERE id=$1`, [runId, vendorSessionId]);
  const retired = async (threadId: string) => (await db.pool.query("SELECT retired_vendor_session_ids FROM host_threads WHERE id=$1", [threadId])).rows[0].retired_vendor_session_ids;

  it("is retired before an ordinary turn's prompt is rendered, so that turn replays fresh; one a launch with network started is resumed", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, admitProject, thread } = await project();
    // A provider-bound Gmail automation's isolated launch (a Project-bound read: no `sensitive_conversation`) left its session.
    await settle(thread, await run(p, GMAIL_PIN, thread, isolatedLaunch(PROFILE(p))), "vendor-mail");
    expect(await vendorSessionHeldIsolated(db.pool, thread, "vendor-mail")).toBe(true);
    // The owner's next ordinary turn in that conversation may launch with network: fresh, and the session retired.
    expect(await admitProject()).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    expect(await pointer(thread)).toEqual({ vendor_session_id: null, vendor_session_launch_id: null, status: "session_reset" });
    expect(await retired(thread)).toEqual(["vendor-mail"]);
    // A session that turn started on ordinary egress, and continued so, is resumed as before.
    const fresh = await run(p, {}, thread, openLaunch);
    await settle(thread, fresh, "vendor-open");
    const next = await run(p, {}, thread, openLaunch);
    await resumed(next, "vendor-open");
    await settle(thread, next, "vendor-open");
    expect(await vendorSessionHeldIsolated(db.pool, thread, "vendor-open")).toBe(false);
    expect(await admitProject()).toMatchObject({ host_prompt_fresh: false, host_resume_attempted: true });
  });

  it("counts a session an isolated launch started and an ordinary launch already continued — before this check — as held, whoever the pointer names now", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, admitProject, thread } = await project();
    await settle(thread, await run(p, GMAIL_PIN, thread, isolatedLaunch(PROFILE(p))), "vendor-mail");
    // As the earlier code left it: an ordinary launch resumed that session, and the pointer is now bound to that launch.
    const continued = await run(p, {}, thread, openLaunch);
    await resumed(continued, "vendor-mail");
    await settle(thread, continued, "vendor-mail");
    expect(await pointer(thread)).toMatchObject({ vendor_session_id: "vendor-mail", vendor_session_launch_id: await launchOf(continued) });
    expect(await vendorSessionHeldIsolated(db.pool, thread, "vendor-mail")).toBe(true);
    expect(await admitProject()).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    expect(await retired(thread)).toEqual(["vendor-mail"]);
  });

  it("keeps it for a conversation whose turns launch isolated anyway, and retires it on any thread kind", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, admitProject, thread } = await project();
    // A conversation holding a plugin's sensitive read: every later turn launches isolated or not at all, and its launch
    // judges the session (`sensitiveThreadResumable`).
    await settle(thread, await run(p, { sensitive_conversation: true }, thread, isolatedLaunch(PROFILE(p))), "vendor-plugin");
    expect(await admitProject()).toMatchObject({ host_prompt_fresh: false, host_resume_attempted: true });
    // The launch's refusal retires it on a thread that is not a conversation's too (here: the person's direct thread).
    const d = await directSession();
    const direct = (await admit(d, { kind: "direct", user_id: OWNER }))!.host_thread.id;
    await settle(direct, await run(d, {}, direct, isolatedLaunch(PROFILE(d))), "vendor-direct");
    expect(await new PgHostThreadRepository(db.pool).resetConversationAgent(direct, "vendor-direct")).toBeNull();
    expect(await admit(d, { kind: "direct", user_id: OWNER })).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    expect(await retired(direct)).toEqual(["vendor-direct"]);
  });
});

describe("what a launch with network may resume, on the record only (ADR 0036 §11 review)", () => {
  const project = async () => {
    const p = await directSession(PROJECT);
    const container = { kind: "conversation" as const, conversation_id: p, direct: true as const };
    const admitProject = () => prepareHostConversationDispatch({ db: db.pool, backend, container, sessionId: p, spaceId: SPACE, projectId: PROJECT, agentId: AGENT, userId: OWNER });
    return { p, admitProject, thread: (await admitProject())!.host_thread.id };
  };
  const NETWORK = (session: string) => `agents/${AGENT}/conversation/${session}/claude_code/prov-1.network`;
  const networkLaunch = (profile_key: string) => ({ ...openLaunch, profile_key });
  /** The session a Run was handed to resume, as its admission froze it. */
  const resumed = (runId: string, vendorSessionId: string | null) => db.pool.query(
    `UPDATE runs SET model_override_json=jsonb_build_object('host_thread',jsonb_build_object('schema_version','host_thread.v1','runtime_session_id',$2::text)) WHERE id=$1`, [runId, vendorSessionId]);
  const AMBIENT = (session: string) => `agents/${AGENT}/conversation/${session}/claude_code/ambient`;
  /** The launch's verdict in the CLI directory it will use (by default the conversation's networked one). */
  const verdict = async (threadId: string, runId: string, vendorSessionId: string, profileKey?: string) => {
    const session = (await db.pool.query<{ session_id: string }>("SELECT session_id FROM runs WHERE id=$1", [runId])).rows[0]?.session_id;
    return networkedResumeVerdict(db.pool, { threadId, runId, vendorSessionId, profileKey: profileKey ?? NETWORK(session) });
  };
  /** A turn parked on a review after its launch (by default the attempt's current one) reported `vendorSessionId`, as
   * the orchestrator records it from the adapter's result. */
  const park = async (runId: string, vendorSessionId: string, launchId?: string) => {
    await db.pool.query("UPDATE runs SET status='waiting_for_review' WHERE id=$1", [runId]);
    await new PgRunRepository(db.pool).recordParkedHostThreadSession({ run_id: runId, space_id: SPACE, vendor_session_id: vendorSessionId,
      launch_id: launchId ?? await launchOf(runId) });
  };
  /** A relaunch of the Run's same attempt: a new nonce and record replace the old ones (`bindAttemptLaunch`). */
  const relaunch = async (runId: string, launch: Record<string, unknown>) => {
    const nonce = randomUUID();
    await db.pool.query("UPDATE run_attempts SET launch_id=$2::text, launch_isolation_json=$3::jsonb WHERE run_id=$1",
      [runId, nonce, JSON.stringify({ launch_id: nonce, host_id: HOST, ...launch })]);
    return nonce;
  };
  const retired = async (threadId: string) => (await db.pool.query("SELECT retired_vendor_session_ids FROM host_threads WHERE id=$1", [threadId])).rows[0].retired_vendor_session_ids;

  it("keeps the isolated and the networked launch of one backend in separate CLI directories, and neither in the one they shared", () => {
    const scope: RuntimeProfileScope = { agent_id: AGENT, container_kind: "conversation", container_id: "s" };
    const isolated = runtimeProfileKey(scope, "claude_code", "prov-1", true), network = runtimeProfileKey(scope, "claude_code", "prov-1");
    expect(isolated).toBe(`agents/${AGENT}/conversation/s/claude_code/prov-1.isolated`);
    expect(network).toBe(`agents/${AGENT}/conversation/s/claude_code/prov-1.network`);
    expect(new Set([isolated, network, `agents/${AGENT}/conversation/s/claude_code/prov-1`]).size).toBe(3);
    // The machine's own login is never isolated: one directory, as before.
    expect(runtimeProfileKey(scope, "claude_code", null)).toBe(`agents/${AGENT}/conversation/s/claude_code/ambient`);
  });

  it("replays fresh a pointer recorded in the directory both channels shared; one in the networked directory resumes; a sensitive turn resumes only the isolated one", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, admitProject, thread } = await project();
    await settle(thread, await run(p, {}, thread, networkLaunch(`agents/${AGENT}/conversation/${p}/claude_code/prov-1`)), "vendor-shared-dir");
    expect(await admitProject()).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
    expect(await retired(thread)).toEqual(["vendor-shared-dir"]);
    await settle(thread, await run(p, {}, thread, networkLaunch(NETWORK(p))), "vendor-network");
    expect(await admitProject()).toMatchObject({ host_prompt_fresh: false, host_resume_attempted: true });
    // A sensitive direct chat's admission: an isolated launch's pointer outside its own directory is not resumed.
    const a = await directSession();
    const direct = (await admit(a, own(a)))!.host_thread.id;
    await settle(direct, await run(a, GMAIL_PIN, direct, isolatedLaunch(`agents/${AGENT}/conversation/${a}/claude_code/prov-1`)), "vendor-old-isolated");
    expect(await resumable(direct, "vendor-old-isolated")).toBe(false);
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1", [direct]);
    expect(await admit(a, own(a))).toMatchObject({ host_prompt_fresh: true, host_resume_attempted: false });
  });

  it("refuses a session an isolated launch created fresh once the pointer was cleared or replaced, and on a retry after the refusal", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, thread } = await project();
    // The automation's isolated launch started the session fresh (it resumed none) and set the pointer.
    await settle(thread, await run(p, GMAIL_PIN, thread, isolatedLaunch(PROFILE(p))), "vendor-mail");
    const ordinary = await run(p, {}, thread, null);
    await resumed(ordinary, "vendor-mail");
    expect(await verdict(thread, ordinary, "vendor-mail")).toBe("held_isolated");
    // Cleared after admission (no retired record either): no pointer is left to trace the session to its isolated origin,
    // so the earlier check found it "not held". It is not this Run's own session, so it is refused.
    await db.pool.query("UPDATE host_threads SET vendor_session_id=NULL,vendor_session_launch_id=NULL,status='session_reset' WHERE id=$1", [thread]);
    expect(await vendorSessionHeldIsolated(db.pool, thread, "vendor-mail")).toBe(false);
    expect(await verdict(thread, ordinary, "vendor-mail")).toBe("unconfirmed");
    // Replaced by a newer session a networked launch started: the stale one is refused, the newer pointer resumes.
    const newer = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await settle(thread, newer, "vendor-newer");
    expect(await verdict(thread, ordinary, "vendor-mail")).toBe("unconfirmed");
    const next = await run(p, {}, thread, null);
    await resumed(next, "vendor-newer");
    expect(await verdict(thread, next, "vendor-newer")).toBe("resumable");
    // The refusal excludes only the stale session; the newer pointer stays.
    await new PgHostThreadRepository(db.pool).excludeVendorSession(thread, "vendor-mail");
    expect(await pointer(thread)).toMatchObject({ vendor_session_id: "vendor-newer", status: "active" });
    expect(await retired(thread)).toEqual(["vendor-mail"]);
    // A retry of the refused Run (its frozen session unchanged) is refused again, retired now; so is a closed thread's.
    expect(await verdict(thread, ordinary, "vendor-mail")).toBe("unconfirmed");
    await db.pool.query("UPDATE host_threads SET status='closed' WHERE id=$1", [thread]);
    expect(await verdict(thread, next, "vendor-newer")).toBe("unconfirmed");
    expect(await verdict(randomUUID(), next, "vendor-newer")).toBe("unconfirmed");
  });

  it("resumes a Run's own parked session on its reporting launch's frozen record, across relaunches of the same attempt", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, thread } = await project();
    // A networked first turn parked on a review in the session it started; the pointer names nothing yet.
    const parked = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await resumed(parked, null);
    const reporting = await launchOf(parked);
    await park(parked, "vendor-parked");
    expect((await db.pool.query("SELECT model_override_json->'host_thread' AS h FROM runs WHERE id=$1", [parked])).rows[0].h)
      .toMatchObject({ runtime_session_id: "vendor-parked",
        runtime_session_launch: { launch_id: reporting, profile_key: NETWORK(p), egress_profile: "default" } });
    expect(await verdict(thread, parked, "vendor-parked")).toBe("resumable");
    // Its resume relaunches the same attempt with a new nonce and record, then fails before parking again (a Host
    // disconnect): the retry still continues the session, and nothing was excluded.
    await relaunch(parked, networkLaunch(NETWORK(p)));
    expect(await verdict(thread, parked, "vendor-parked")).toBe("resumable");
    await relaunch(parked, networkLaunch(NETWORK(p)));
    expect(await verdict(thread, parked, "vendor-parked")).toBe("resumable");
    expect(await retired(thread)).toEqual([]);
    // Parked again by the latest launch: the record follows it.
    const latest = await launchOf(parked);
    await park(parked, "vendor-parked");
    expect((await db.pool.query("SELECT model_override_json#>>'{host_thread,runtime_session_launch,launch_id}' AS l FROM runs WHERE id=$1", [parked])).rows[0].l).toBe(latest);
    expect(await verdict(thread, parked, "vendor-parked")).toBe("resumable");
    // Not in another directory: the channel-less one both channels shared, or another backend's.
    expect(await verdict(thread, parked, "vendor-parked", `agents/${AGENT}/conversation/${p}/claude_code/prov-1`)).toBe("unconfirmed");
    expect(await verdict(thread, parked, "vendor-parked", AMBIENT(p))).toBe("unconfirmed");
    // Another Run handed that session is not its owner.
    const other = await run(p, {}, thread, null);
    await resumed(other, "vendor-parked");
    expect(await verdict(thread, other, "vendor-parked")).toBe("unconfirmed");
    // A launch of the Run that states the model-only channel now: it may have written the session, so it is refused.
    await relaunch(parked, isolatedLaunch(PROFILE(p)));
    expect(await verdict(thread, parked, "vendor-parked")).toBe("held_isolated");
  });

  it("refuses a parked session without a trusted record: unrecorded, reported by a nonce no attempt carries, or an isolated launch's", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, thread } = await project();
    // Parked before its launch was recorded with it (as before this record existed).
    const legacy = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await db.pool.query(`UPDATE runs SET model_override_json=jsonb_build_object('host_thread',jsonb_build_object('runtime_session_id','vendor-legacy','runtime_session_launch_id',$2::text)) WHERE id=$1`,
      [legacy, await launchOf(legacy)]);
    expect(await verdict(thread, legacy, "vendor-legacy")).toBe("unconfirmed");
    // The reporting nonce was already replaced when the park was recorded: nothing vouches for it, so it is unknown.
    const rotated = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await resumed(rotated, null);
    const stale = await launchOf(rotated);
    await relaunch(rotated, networkLaunch(NETWORK(p)));
    await park(rotated, "vendor-rotated", stale);
    expect((await db.pool.query("SELECT model_override_json->'host_thread' AS h FROM runs WHERE id=$1", [rotated])).rows[0].h)
      .toMatchObject({ runtime_session_id: "vendor-rotated", runtime_session_launch: null });
    expect(await verdict(thread, rotated, "vendor-rotated")).toBe("unconfirmed");
    // No reporting nonce at all (an adapter that names none).
    const unnamed = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await resumed(unnamed, null);
    await db.pool.query("UPDATE runs SET status='waiting_for_review' WHERE id=$1", [unnamed]);
    await new PgRunRepository(db.pool).recordParkedHostThreadSession({ run_id: unnamed, space_id: SPACE, vendor_session_id: "vendor-unnamed" });
    expect(await verdict(thread, unnamed, "vendor-unnamed")).toBe("unconfirmed");
    // An isolated first launch parked in the session it started, and the next attempt would launch with network.
    const isolated = await run(p, GMAIL_PIN, thread, isolatedLaunch(PROFILE(p)));
    await resumed(isolated, null);
    await park(isolated, "vendor-isolated-parked");
    expect(await verdict(thread, isolated, "vendor-isolated-parked")).toBe("held_isolated");
  });

  it("resumes a pointer only in the directory its launch recorded: a Run queued before the split, or a Task's, never tries the old one", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, thread } = await project();
    // The pointer a launch recorded in the channel-less directory both channels shared. A Run admitted before the split
    // (or one no conversation admission judged, such as a Task's) still names it at launch: it is refused in the
    // networked directory instead of handing the CLI a session that directory does not hold.
    await settle(thread, await run(p, {}, thread, networkLaunch(`agents/${AGENT}/conversation/${p}/claude_code/prov-1`)), "vendor-shared-dir");
    const queued = await run(p, {}, thread, null);
    await resumed(queued, "vendor-shared-dir");
    expect(await verdict(thread, queued, "vendor-shared-dir")).toBe("unconfirmed");
    // A pointer in the networked directory resumes there, and nowhere else.
    await settle(thread, await run(p, {}, thread, networkLaunch(NETWORK(p))), "vendor-network");
    const next = await run(p, {}, thread, null);
    await resumed(next, "vendor-network");
    expect(await verdict(thread, next, "vendor-network")).toBe("resumable");
    expect(await verdict(thread, next, "vendor-network", AMBIENT(p))).toBe("unconfirmed");
    // A bound pointer whose launch recorded no directory is not assumed to be the machine-login one (§14), nor is one
    // whose bound record is gone (a relaunch replaced its nonce).
    await settle(thread, await run(p, {}, thread, openLaunch), "vendor-unprofiled");
    const unprofiled = await run(p, {}, thread, null);
    await resumed(unprofiled, "vendor-unprofiled");
    expect(await verdict(thread, unprofiled, "vendor-unprofiled", AMBIENT(p))).toBe("unconfirmed");
    expect(await verdict(thread, unprofiled, "vendor-unprofiled")).toBe("unconfirmed");
    const ambientRun = await run(p, {}, thread, networkLaunch(AMBIENT(p)));
    await settle(thread, ambientRun, "vendor-ambient");
    const stale = await run(p, {}, thread, null);
    await resumed(stale, "vendor-ambient");
    expect(await verdict(thread, stale, "vendor-ambient", AMBIENT(p))).toBe("resumable");
    await relaunch(ambientRun, networkLaunch(AMBIENT(p)));
    expect(await verdict(thread, stale, "vendor-ambient", AMBIENT(p))).toBe("unconfirmed");
    // A pointer no launch vouches for, on a thread that ran in ModelProvider directories: not native history either.
    await db.pool.query("UPDATE host_threads SET vendor_session_id='vendor-imported', vendor_session_launch_id=NULL WHERE id=$1", [thread]);
    const imported = await run(p, {}, thread, null);
    await resumed(imported, "vendor-imported");
    expect(await verdict(thread, imported, "vendor-imported", AMBIENT(p))).toBe("unconfirmed");
    expect(await verdict(thread, imported, "vendor-imported")).toBe("unconfirmed");
  });

  it("resumes an unbound pointer in the ambient directory only on native history: never after a ModelProvider-bound, isolated or other-directory launch", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, thread } = await project();
    const unbound = async (session: string) => {
      await db.pool.query("UPDATE host_threads SET vendor_session_id=$2, vendor_session_launch_id=NULL, status='active' WHERE id=$1", [thread, session]);
      const next = await run(p, {}, thread, null);
      await resumed(next, session);
      return verdict(thread, next, session, AMBIENT(p));
    };
    // Imported CLI history on a thread whose launches were all the machine's own login, including one recorded
    // before records named a directory: it resumes there, and only there.
    await run(p, {}, thread, networkLaunch(AMBIENT(p)));
    await run(p, {}, thread, openLaunch);
    expect(await unbound("vendor-native")).toBe("resumable");
    const there = await run(p, {}, thread, null);
    await resumed(there, "vendor-native");
    expect(await verdict(thread, there, "vendor-native")).toBe("unconfirmed");
    // Earlier ModelProvider history whose launch recorded no directory (before records named one): not ambient.
    const provider = randomUUID();
    await db.pool.query(`INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
      VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,now(),now())`, [provider, SPACE, OWNER]);
    const bound = await run(p, {}, thread, openLaunch);
    await db.pool.query("UPDATE runs SET model_provider_id=$2 WHERE id=$1", [bound, provider]);
    expect(await unbound("vendor-provider")).toBe("unconfirmed");
    // Nor after a launch in another directory, or an isolated one, on a thread that never had a provider-bound Run.
    const other = await project();
    await run(other.p, {}, other.thread, networkLaunch(NETWORK(other.p)));
    await db.pool.query("UPDATE host_threads SET vendor_session_id='vendor-x', vendor_session_launch_id=NULL WHERE id=$1", [other.thread]);
    const x = await run(other.p, {}, other.thread, null);
    await resumed(x, "vendor-x");
    expect(await verdict(other.thread, x, "vendor-x", AMBIENT(other.p))).toBe("unconfirmed");
  });

  it("counts a Run from before launch nonces and another ambient directory against native history (ADR 0036 §15)", async (ctx) => {
    if (!db.available) return ctx.skip();
    const unbound = async (t: string, p: string, session: string) => {
      await db.pool.query("UPDATE host_threads SET vendor_session_id=$2, vendor_session_launch_id=NULL, status='active' WHERE id=$1", [t, session]);
      const next = await run(p, {}, t, null);
      await resumed(next, session);
      return verdict(t, next, session, AMBIENT(p));
    };
    // A ModelProvider-bound Run that started before launch nonces existed: its attempt carries none.
    const legacy = await project();
    const old = await run(legacy.p, {}, legacy.thread, null);
    await db.pool.query("UPDATE runs SET started_at=now(), runtime_profile_snapshot_json=jsonb_build_object('backend_mode','model_provider') WHERE id=$1", [old]);
    expect(await unbound(legacy.thread, legacy.p, "vendor-legacy")).toBe("unconfirmed");
    // The same Run never started (queued, refused before launch) says nothing about the pointer.
    await db.pool.query("UPDATE runs SET started_at=NULL WHERE id=$1", [old]);
    expect(await unbound(legacy.thread, legacy.p, "vendor-legacy")).toBe("resumable");
    // A launch recorded in another ambient directory (another Agent's or container's): not this one's history.
    const shared = await project();
    await run(shared.p, {}, shared.thread, networkLaunch(`agents/${randomUUID()}/conversation/${shared.p}/claude_code/ambient`));
    expect(await unbound(shared.thread, shared.p, "vendor-shared")).toBe("unconfirmed");
  });

  it("an isolated resume is refused on an archived thread and for a pointer whose launch predates a Host reset (ADR 0036 §15)", async (ctx) => {
    if (!db.available) return ctx.skip();
    const s = await directSession();
    const thread = (await admit(s, own(s)))!.host_thread.id;
    const first = await run(s, GMAIL_PIN, thread, isolatedLaunch(PROFILE(s)));
    await db.pool.query("UPDATE run_attempts SET started_at=now() - interval '1 minute' WHERE run_id=$1", [first]);
    await settle(thread, first, "vendor-iso");
    expect(await resumable(thread, "vendor-iso", PROFILE(s))).toBe(true);
    // A reset of another Agent on this Host leaves it; one of this Agent on the launch's Host does not.
    const intent = (agent: string) => db.pool.query(`INSERT INTO host_command_intents (id, space_id, host_id, user_id, agent_id, kind, scope_key, status, frozen_json, effect_json, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'agent_host_state_reset', $6, 'succeeded', '{}'::jsonb, '{}'::jsonb, now(), now())`, [randomUUID(), SPACE, HOST, OWNER, agent, randomUUID().replace(/-/g, "")]);
    await intent(randomUUID());
    expect(await resumable(thread, "vendor-iso", PROFILE(s))).toBe(true);
    await intent(AGENT);
    expect(await resumable(thread, "vendor-iso", PROFILE(s))).toBe(false);
    // An archived thread refuses whatever its pointer still names.
    await db.pool.query("DELETE FROM host_command_intents");
    expect(await resumable(thread, "vendor-iso", PROFILE(s))).toBe(true);
    await db.pool.query("UPDATE host_threads SET status='closed' WHERE id=$1", [thread]);
    expect(await resumable(thread, "vendor-iso", PROFILE(s))).toBe(false);
  });

  it("host-state reset retires a session a Task Run of this Agent parked in that no pointer names; another Agent's parked session keeps its record", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, thread } = await project();
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1", [thread]);
    // The pointer names one session; a Run waiting for review parked in another its launch reported.
    await settle(thread, await run(p, {}, thread, networkLaunch(NETWORK(p))), "vendor-pointer");
    const parked = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await resumed(parked, null);
    await park(parked, "vendor-parked");
    // Another Agent's Run on the same thread, parked likewise, and a parked Run of this Agent already settled.
    const OTHER_AGENT = randomUUID(), OTHER_VERSION = randomUUID();
    await seedAgentWithVersion(db.pool, { agent: OTHER_AGENT, version: OTHER_VERSION, space: SPACE, owner: OWNER, now: new Date().toISOString() });
    const foreign = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await db.pool.query("UPDATE runs SET agent_id=$2, agent_version_id=$3 WHERE id=$1", [foreign, OTHER_AGENT, OTHER_VERSION]);
    await resumed(foreign, null);
    await park(foreign, "vendor-foreign");
    const settled = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await resumed(settled, "vendor-settled");
    await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1", [settled]);
    expect(await verdict(thread, parked, "vendor-parked")).toBe("resumable");
    expect(await verdict(thread, foreign, "vendor-foreign")).toBe("resumable");

    expect(await new PgHostThreadRepository(db.pool).retireAgentSessionsOnHost(AGENT, HOST)).toBe(1);
    expect(await pointer(thread)).toMatchObject({ vendor_session_id: null, status: "session_reset" });
    expect(await retired(thread)).toEqual(["vendor-pointer", "vendor-parked"]);
    expect(await verdict(thread, parked, "vendor-parked")).toBe("unconfirmed");
    expect(await verdict(thread, foreign, "vendor-foreign")).toBe("resumable");
    // A second reset adds nothing twice.
    await new PgHostThreadRepository(db.pool).retireAgentSessionsOnHost(AGENT, HOST);
    expect(await retired(thread)).toEqual(["vendor-pointer", "vendor-parked"]);
    // Another Host's reset of this Agent leaves the thread alone.
    await new PgHostThreadRepository(db.pool).retireAgentSessionsOnHost(OTHER_AGENT, randomUUID());
    expect(await verdict(thread, foreign, "vendor-foreign")).toBe("resumable");
  });

  describe("judged again under the thread's lock, in the bind's own transaction (ADR 0036 §14)", () => {
    /** A Run running on its open attempt, not bound yet, handed `session` to resume. */
    const runningRun = async (p: string, thread: string, session: string) => {
      const id = await run(p, {}, thread, null);
      await resumed(id, session);
      await db.pool.query("UPDATE runs SET status='running' WHERE id=$1", [id]);
      await db.pool.query("UPDATE run_attempts SET status='running' WHERE run_id=$1", [id]);
      return id;
    };
    const guardedBind = (runId: string, thread: string, session: string, p: string, gate?: Promise<void>) =>
      new PgRunRepository(db.pool).bindAttemptLaunchAfterResumeCheck(
        { space_id: SPACE, run_id: runId, launch_id: randomUUID(), isolation: { host_id: HOST, ...openLaunch, profile_key: NETWORK(p) } as never },
        { thread_id: thread, refusal: async (tx) => {
          const v = await networkedResumeVerdict(tx, { threadId: thread, runId, vendorSessionId: session, profileKey: NETWORK(p) });
          await gate;
          return v === "resumable" ? null : v;
        } });
    const waitingOnLock = async () => vi.waitUntil(async () => Number((await db.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n) > 0,
      { timeout: 10000, interval: 20 });
    const launchIdOf = async (runId: string) => (await db.pool.query<{ launch_id: string | null }>("SELECT launch_id FROM run_attempts WHERE run_id=$1", [runId])).rows[0].launch_id;

    it("a reset or archive that commits first is seen: nothing is bound, so no frame leaves", async (ctx) => {
      if (!db.available) return ctx.skip();
      const { p, thread } = await project();
      await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1", [thread]);
      await settle(thread, await run(p, {}, thread, networkLaunch(NETWORK(p))), "vendor-a");
      const next = await runningRun(p, thread, "vendor-a");
      // The person's reset holds the thread row when the launch reaches its bind; the bind waits and then sees it.
      const resetter = await db.pool.connect();
      try {
        await resetter.query("BEGIN");
        expect(await new PgHostThreadRepository(resetter).resetConversationAgent(thread)).not.toBeNull();
        const binding = guardedBind(next, thread, "vendor-a", p);
        await waitingOnLock();
        await resetter.query("COMMIT");
        expect(await binding).toEqual({ bound: false, refusal: "unconfirmed" });
      } finally { await resetter.query("ROLLBACK").catch(() => undefined); resetter.release(); }
      expect(await launchIdOf(next)).toBeNull();
      // An archive likewise.
      await settle(thread, await run(p, {}, thread, networkLaunch(NETWORK(p))), "vendor-b");
      const after = await runningRun(p, thread, "vendor-b");
      await db.pool.query("UPDATE host_threads SET status='closed', vendor_session_id=NULL, vendor_session_launch_id=NULL WHERE id=$1", [thread]);
      expect(await guardedBind(after, thread, "vendor-b", p)).toEqual({ bound: false, refusal: "unconfirmed" });
      expect(await launchIdOf(after)).toBeNull();
    });

    it("a reset that comes after the bind waits for it; the launch stays bound and its session never becomes the pointer again", async (ctx) => {
      if (!db.available) return ctx.skip();
      const { p, thread } = await project();
      await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1", [thread]);
      await settle(thread, await run(p, {}, thread, networkLaunch(NETWORK(p))), "vendor-a");
      const next = await runningRun(p, thread, "vendor-a");
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const binding = guardedBind(next, thread, "vendor-a", p, gate);
      let resetDone = false;
      // The gate always opens, so a failed expectation never leaves the bind's transaction open.
      try {
        await vi.waitUntil(async () => Number((await db.pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'host_threads' AND l.mode = 'RowShareLock'")).rows[0].n) > 0,
          { timeout: 10000, interval: 20 });
        const reset = new PgHostThreadRepository(db.pool).resetConversationAgent(thread).then((row) => { resetDone = true; return row; });
        await waitingOnLock();
        expect(resetDone).toBe(false);
        open();
        expect(await binding).toEqual({ bound: true, refusal: null });
        expect(await reset).not.toBeNull();
      } finally { open(); await binding.catch(() => undefined); }
      expect(await launchIdOf(next)).not.toBeNull();
      // The launch reports the retired session when it ends: it is not brought back as the pointer.
      await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1", [next]);
      await settle(thread, next, "vendor-a");
      expect(await pointer(thread)).toMatchObject({ vendor_session_id: null });
    });
  });

  it("refuses after a reset or an archive, for the pointer and for a parked Run whose session the reset retired", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, thread } = await project();
    const threads = new PgHostThreadRepository(db.pool);
    const first = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await settle(thread, first, "vendor-a");
    // A Run parked in the session the pointer names: the person resets the conversation.
    const parked = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await resumed(parked, "vendor-a");
    await park(parked, "vendor-a");
    expect(await verdict(thread, parked, "vendor-a")).toBe("resumable");
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1", [thread]);
    expect(await threads.resetConversationAgent(thread)).not.toBeNull();
    expect(await verdict(thread, parked, "vendor-a")).toBe("unconfirmed");
    // A session parked that the reset did not name keeps its own record until the conversation is archived.
    const other = await run(p, {}, thread, networkLaunch(NETWORK(p)));
    await resumed(other, null);
    await park(other, "vendor-b");
    expect(await verdict(thread, other, "vendor-b")).toBe("resumable");
    await db.pool.query("UPDATE host_threads SET status='closed' WHERE id=$1", [thread]);
    expect(await verdict(thread, other, "vendor-b")).toBe("unconfirmed");
  });

  it("judges thread, pointer, isolation history and records in one statement, so one snapshot", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { p, thread } = await project();
    await settle(thread, await run(p, {}, thread, networkLaunch(NETWORK(p))), "vendor-one");
    const next = await run(p, {}, thread, null);
    await resumed(next, "vendor-one");
    let statements = 0;
    const counted = { query: (...args: Parameters<typeof db.pool.query>) => { statements += 1; return db.pool.query(...args); } } as typeof db.pool;
    expect(await networkedResumeVerdict(counted, { threadId: thread, runId: next, vendorSessionId: "vendor-one", profileKey: NETWORK(p) })).toBe("resumable");
    expect(statements).toBe(1);
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
