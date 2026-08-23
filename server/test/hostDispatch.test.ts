import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth";
import { __setAuthIdentityForTests, sessionTokenFromRequest, type CurrentUser } from "../src/modules/auth/identity";
import { sharedHostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry";
import { PgJobQueueRepository } from "../src/modules/jobs/repository";
import { JobWorker } from "../src/modules/jobs/worker";
import { registerAgentRunHandler } from "../src/modules/runs/agentRunHandler";
import { PgHostThreadEventRepository } from "../src/modules/hosts/threadEventRepository";
import { advanceThreadQueue } from "../src/modules/hosts/queueAdvance";
import { PgHostThreadMessageRepository } from "../src/modules/hosts/threadMessageRepository";

// Real-Postgres, real-orchestration coverage for the dispatch endpoint
// (ADR 0016 D10/D14): the one place a control-center "run this for me"
// intent turns into an actual Run, bypassing route selection, bound to an
// explicit workspace/runtime/thread.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_TOKEN = "owner-session-token";
const OUTSIDER_TOKEN = "outsider-session-token";
const SPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const AGENT_VERSION = "44444444-4444-4444-8444-444444444444";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let app: FastifyInstance | undefined;
let jobWorker: JobWorker | undefined;
let available = false;

/**
 * control-center-phase2-plan.md P1 (C3): dispatch now enqueues an
 * `agent_run` job instead of awaiting `executeRun` inline — `buildServer`
 * does not start the background `JobWorker` (only the real process
 * bootstrap does), so a test that needs the dispatched Run to actually
 * finish has to drive the queue itself, the same way
 * `runToolGrantProvisioningDb.test.ts` does for other job-queue coverage.
 */
async function driveOneJob(): Promise<void> {
  const result = await jobWorker!.processOne();
  if (result.status === "idle") throw new Error("driveOneJob: no job was queued");
}

function stubAuth(): AuthRepository {
  const users: Record<string, CurrentUser> = {
    [OWNER_TOKEN]: { id: OWNER, email: null, display_name: "Owner", avatar_url: null, is_instance_admin: false, created_at: new Date().toISOString(), last_login_at: null },
    [OUTSIDER_TOKEN]: { id: OUTSIDER, email: null, display_name: "Outsider", avatar_url: null, is_instance_admin: false, created_at: new Date().toISOString(), last_login_at: null },
  };
  const notImplemented = () => { throw new Error("not implemented in this fake"); };
  return {
    resolveIdentity: notImplemented,
    async getCurrentUser(sessionToken?: string) {
      const user = sessionToken ? users[sessionToken] : undefined;
      return user ?? { statusCode: 401, detail: "Not authenticated" };
    },
    getUserSpaces: notImplemented,
    getSpaceForUser: notImplemented,
    logout: notImplemented,
    findOrCreateFromGoogle: notImplemented,
  } as unknown as AuthRepository;
}

function authCookie(token: string): string {
  return `session_id=${token}`;
}

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
    const config = loadConfig({ SERVER_DATABASE_URL: container.getConnectionUri() });
    app = buildServer(config, { logger: false });
    const jobRegistry = new JobHandlerRegistry();
    registerAgentRunHandler(jobRegistry, config);
    jobWorker = new JobWorker(new PgJobQueueRepository(pool), jobRegistry, "test-worker", ["agent_run"]);
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[host-dispatch] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  __setAuthRepositoryForTests(null);
  await app?.close();
  await pool?.end();
  await container?.stop();
});

afterEach(() => {
  __setAuthRepositoryForTests(null);
  __setAuthIdentityForTests(null);
});

async function seedProjectAndAgent(): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,'Owner','active',$3,$3), ($2,'Outsider','active',$3,$3)`, [OWNER, OUTSIDER, now]);
  await pool!.query(`INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1,'Space','household',$2,$3,$3)`, [SPACE, OWNER, now]);
  await pool!.query(`INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Project','active',$4,$4)`, [PROJECT, SPACE, OWNER, now]);
  await pool!.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', $3, $3)`,
    [SPACE, OWNER, now],
  );
  await pool!.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at) VALUES (gen_random_uuid()::varchar, $1, $2, $3, 'owner', 'active', $4, $4)`,
    [SPACE, PROJECT, OWNER, now],
  );
  await pool!.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
     VALUES ($1,$2,NULL,'Agent','active','standard','space_shared',$3,$3)`,
    [AGENT, SPACE, now],
  );
  await pool!.query(
    `INSERT INTO agent_versions (id, agent_id, space_id, version_label, system_prompt, model_config_json, runtime_config_json, context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, runtime_policy_json, created_at)
     VALUES ($1,$2,$3,'v1','x','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await pool!.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, AGENT_VERSION]);
  // Every Space gets a Runtime Context Policy version at creation time via
  // `seedSpaceDefaults` (spaceSeeds.ts) in production — this test inserts
  // the `spaces` row directly, bypassing that, so it seeds the same
  // minimal policy scaffolding by hand (the Runtime Context Gateway
  // requires at least one governing policy version to exist for any scope).
  const policyVersionId = "99999999-9999-4999-8999-999999999999";
  await pool!.query(
    `INSERT INTO runtime_context_policy_versions (
       id, space_id, scope_type, scope_id, version, policy_json, base_version_id,
       typed_diff_json, reason, created_by_user_id, created_at
     ) VALUES ($1,$2,'space',$2,1,'{"constraints":{},"preferences":{}}'::jsonb,NULL,'{}'::jsonb,'test seed',$3,now())`,
    [policyVersionId, SPACE, OWNER],
  );
  await pool!.query(
    `INSERT INTO runtime_context_policy_bindings (
       space_id, scope_type, scope_id, active_version_id, updated_by_user_id, updated_at
     ) VALUES ($1,'space',$1,$2,$3,now())`,
    [SPACE, policyVersionId, OWNER],
  );
}

async function pairAndRegister(name: string, capabilities: Record<string, unknown> = { runtimes: ["claude"] }): Promise<{ hostId: string; token: string }> {
  const issue = await app!.inject({
    method: "POST",
    url: "/api/v1/hosts/pairing-codes",
    headers: { cookie: authCookie(OWNER_TOKEN) },
    payload: { name },
  });
  const register = await app!.inject({
    method: "POST",
    url: "/api/v1/hosts/register",
    payload: { pairing_code: issue.json().pairing_code, ...capabilities },
  });
  const registerBody = register.json();
  // Registration only reports platform/arch/daemon_version; capabilities are
  // reported via hello/heartbeat in the real protocol. Set them directly for
  // this test so the dispatch guard's capability check has something to see.
  await pool!.query(`UPDATE hosts SET capabilities_json = $2::jsonb, status = 'online', last_heartbeat_at = now() WHERE id = $1`, [
    registerBody.host_id,
    JSON.stringify(capabilities),
  ]);
  return { hostId: registerBody.host_id as string, token: registerBody.token as string };
}

/**
 * ACP runtime replatform P4: claude_code speaks ACP on the remote path now —
 * a duplex `initialize` / `session/{new,resume}` / `session/prompt`
 * handshake over `stdin` frames with `keep_stdin_open`, not a one-shot
 * stream-json dump on the `launch` frame's own output. This drives that
 * handshake to completion for a fake daemon connection, mirroring
 * remoteHostCliAdapter.test.ts's own ACP-driving fixtures.
 *
 * `resolveSession` is called once per launch (dispatch), with the 1-based
 * launch count and whether this launch requested a resume (a
 * `runtime_session_id` was set) — it returns the session id to report back
 * (or `null` to report a successful response with no session id), or
 * `"error"` to make the `session/new`/`session/resume` call itself fail
 * with a JSON-RPC error (simulating a broken resume, not just an empty one).
 */
function claudeAcpSink(
  hostId: string,
  options: {
    resolveSession?: (launchNumber: number, isResume: boolean) => string | null | "error";
    events?: Record<string, unknown>[];
    text?: string;
    onLaunch?: (runId: string) => void;
    onResumeRequest?: (requestedSessionId: string | null) => void;
    stderr?: string;
  } = {},
): HostFrameSink {
  let launchCount = 0;
  let sessionId: string | null = null;
  const sink: HostFrameSink = { send: () => {}, close: () => {} };
  sink.send = (frame) => {
    const runId = frame.run_id as string | undefined;
    if (frame.type === "launch") {
      launchCount += 1;
      if (runId) {
        options.onLaunch?.(runId);
        queueMicrotask(() => { sharedHostConnectionRegistry.receiveLaunched(hostId, runId); });
      }
      return;
    }
    if (frame.type !== "stdin" || !runId) return;
    const message = JSON.parse(frame.value as string) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    queueMicrotask(() => {
      if (message.method === "initialize") {
        sharedHostConnectionRegistry.receiveOutput(hostId, runId, `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
        return;
      }
      if (message.method === "session/new" || message.method === "session/resume") {
        const isResume = message.method === "session/resume";
        if (isResume) {
          const requestedSessionId = message.params?.sessionId;
          options.onResumeRequest?.(typeof requestedSessionId === "string" ? requestedSessionId : null);
        }
        const resolved = options.resolveSession?.(launchCount, isResume) ?? `vendor-session-${launchCount}`;
        if (resolved === "error") {
          sharedHostConnectionRegistry.receiveOutput(hostId, runId, `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32000, message: "session not found" },
          })}\n`);
          sharedHostConnectionRegistry.receiveComplete(hostId, runId, { exit_code: 1, timed_out: false, error: "session not found" });
          return;
        }
        sessionId = resolved;
        sharedHostConnectionRegistry.receiveOutput(hostId, runId, `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: resolved ? { sessionId: resolved } : {},
        })}\n`);
        return;
      }
      if (message.method === "session/prompt") {
        for (const event of options.events ?? []) {
          sharedHostConnectionRegistry.receiveOutput(hostId, runId, `${JSON.stringify(event)}\n`);
        }
        if (options.text) {
          sharedHostConnectionRegistry.receiveOutput(hostId, runId, `${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: options.text } },
            },
          })}\n`);
        }
        sharedHostConnectionRegistry.receiveOutput(hostId, runId, `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })}\n`);
        if (options.stderr) sharedHostConnectionRegistry.receiveStderr(hostId, runId, options.stderr);
        sharedHostConnectionRegistry.receiveComplete(hostId, runId, { exit_code: 0, timed_out: false, error: null });
      }
    });
  };
  return sink;
}

async function createWorkspace(token: string, name: string): Promise<string> {
  const created = await app!.inject({
    method: "POST",
    url: "/api/v1/hosts/me/workspaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { project_id: PROJECT, name },
  });
  return created.json().id as string;
}

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE runs, jobs, host_thread_messages, host_thread_events, host_task_threads, project_folders, agent_versions, agents, hosts, projects, spaces, users CASCADE");
});

describe("hosts dispatch endpoint (ADR 0016 D10/D14)", () => {
  it("rejects dispatch without a session", async (ctx) => {
    if (!available || !app) return ctx.skip();
    const response = await app.inject({ method: "POST", url: "/api/v1/hosts/dispatch", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("validates required fields", async (ctx) => {
    if (!available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });

  it("404s for an unknown project_folder_id", async (ctx) => {
    if (!available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: "no-such-folder", adapter_type: "claude_code", prompt: "hi" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects dispatch to a server-host Folder — dispatch is for remote workspaces only", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const serverHost = await pool.query<{ id: string }>(`SELECT id FROM hosts WHERE kind = 'server' LIMIT 1`);
    // The server host bootstraps lazily; force it via a project-folder create through the normal flow instead.
    const list = await app.inject({ method: "GET", url: "/api/v1/hosts", headers: { cookie: authCookie(OWNER_TOKEN) } });
    const serverHostId = (list.json().items as Array<{ id: string; kind: string }>).find((h) => h.kind === "server")?.id ?? serverHost.rows[0]?.id;
    const folderId = "server-folder-1";
    await pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, name, root_path, status, kind, is_primary, execution_enabled, protected, system_managed, host_id, host_kind, created_at, updated_at)
       VALUES ($1,$2,$3,'Server Folder','/aspace/workspaces/x','active','code',false,true,false,false,$4,'server',now(),now())`,
      [folderId, SPACE, PROJECT, serverHostId],
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "hi" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("rejects dispatch from a caller with no Project write access", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Outsider Test Host");
    const folderId = await createWorkspace(host.token, "mapping");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OUTSIDER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "hi" },
    });
    // Not a Project member/writer at all -> the access check itself denies.
    expect(response.statusCode).toBe(403);
  });

  it("rejects dispatch when the host is offline", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Offline Host");
    const folderId = await createWorkspace(host.token, "mapping");
    await pool.query(`UPDATE hosts SET status = 'offline' WHERE id = $1`, [host.hostId]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "hi" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects dispatch for a runtime the host does not report as installed", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("No Codex Host", { runtimes: ["opencode"] });
    const folderId = await createWorkspace(host.token, "mapping");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "hi" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("dispatches end to end: creates a run, streams a live daemon's events, and starts a task thread", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Live Host");
    const folderId = await createWorkspace(host.token, "mapping");

    let capturedRunId: string | null = null;
    const sink = claudeAcpSink(host.hostId, {
      resolveSession: () => "vendor-session-xyz",
      onLaunch: (runId) => { capturedRunId = runId; },
    });
    sharedHostConnectionRegistry.registerConnection(host.hostId, sink);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "fix the failing test" },
    });
    expect(response.statusCode).toBe(201);
    const responseBody = response.json();
    // Nothing was already active on this brand-new thread and the host is
    // online, so advanceThreadQueue dispatches immediately within the
    // request — the Run/job exist before the response returns, distinct
    // from whether the job has actually *run* yet (driveOneJob, below).
    expect(responseBody.status).toBe("dispatched");
    expect(responseBody.run_id).toEqual(expect.any(String));
    await driveOneJob();
    expect(responseBody.run_id).toBe(capturedRunId);

    const runRow = await pool.query<{ run_type: string; adapter_type: string; required_sandbox_level: string; host_task_thread_id: string }>(
      `SELECT run_type, adapter_type, required_sandbox_level, host_task_thread_id FROM runs WHERE id = $1`,
      [responseBody.run_id],
    );
    expect(runRow.rows[0]).toMatchObject({ run_type: "system", adapter_type: "claude_code", required_sandbox_level: "none" });
    expect(runRow.rows[0]!.host_task_thread_id).toBe(responseBody.thread_id);

    const threadRow = await pool.query<{ vendor_session_id: string; last_run_id: string; status: string }>(
      `SELECT vendor_session_id, last_run_id, status FROM host_task_threads WHERE id = $1`,
      [responseBody.thread_id],
    );
    expect(threadRow.rows[0]).toMatchObject({
      vendor_session_id: "vendor-session-xyz",
      last_run_id: responseBody.run_id,
      status: "active",
    });

    // A follow-up dispatch with the same thread_id resumes it rather than
    // creating a second thread.
    const followUp = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: {
        project_folder_id: folderId,
        adapter_type: "claude_code",
        prompt: "now also fix the lint error",
        thread_id: responseBody.thread_id,
      },
    });
    expect(followUp.statusCode).toBe(201);
    expect(followUp.json().thread_id).toBe(responseBody.thread_id);

    sharedHostConnectionRegistry.unregisterConnection(host.hostId, sink);
  });

  it("degrades a thread to a fresh session after a resume's session/resume RPC is rejected, instead of retrying the same broken resume forever", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Resume Failure Host");
    const folderId = await createWorkspace(host.token, "mapping");

    const seenResumeRequests: Array<string | null> = [];
    const sink = claudeAcpSink(host.hostId, {
      // The first dispatch's daemon run produces a session id; the second
      // (a resume attempt) fails the session/resume RPC itself — simulating
      // a resume that the vendor rejected, not just an empty response.
      resolveSession: (launchNumber) => (
        launchNumber === 1 ? "vendor-session-1" : launchNumber === 2 ? "error" : "vendor-session-3"
      ),
      onResumeRequest: (requestedSessionId) => { seenResumeRequests.push(requestedSessionId); },
    });
    sharedHostConnectionRegistry.registerConnection(host.hostId, sink);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "start" },
    });
    expect(first.statusCode).toBe(201);
    const threadId = first.json().thread_id as string;
    await driveOneJob();

    const afterFirst = await pool.query<{ vendor_session_id: string | null; status: string }>(
      `SELECT vendor_session_id, status FROM host_task_threads WHERE id = $1`,
      [threadId],
    );
    expect(afterFirst.rows[0]).toMatchObject({ vendor_session_id: "vendor-session-1", status: "active" });

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "continue", thread_id: threadId },
    });
    expect(second.statusCode).toBe(201);
    await driveOneJob();
    // The second dispatch resumes the session captured by the first.
    expect(seenResumeRequests).toEqual(["vendor-session-1"]);

    const afterSecond = await pool.query<{ vendor_session_id: string | null; status: string }>(
      `SELECT vendor_session_id, status FROM host_task_threads WHERE id = $1`,
      [threadId],
    );
    // The resume handshake itself failed — the thread degrades, and its
    // now-stale vendor_session_id must be cleared, not preserved.
    expect(afterSecond.rows[0]).toMatchObject({ vendor_session_id: null, status: "session_reset" });

    const third = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "one more", thread_id: threadId },
    });
    expect(third.statusCode).toBe(201);
    await driveOneJob();
    // The third dispatch must start a fresh session (session/new), not
    // retry the second dispatch's already-failed resume forever.
    expect(seenResumeRequests).toEqual(["vendor-session-1"]);

    sharedHostConnectionRegistry.unregisterConnection(host.hostId, sink);
  });

  it("404s a dispatch that names a thread_id belonging to a different Folder", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Thread Isolation Host");
    const folderA = await createWorkspace(host.token, "folder-a");
    const folderB = await createWorkspace(host.token, "folder-b");
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-in-a', $1, $2, 'claude_code', 'active', $3, now(), now())`,
      [folderA, host.hostId, OWNER],
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderB, adapter_type: "claude_code", prompt: "hi", thread_id: "thread-in-a" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not retarget an existing task thread to a different runtime adapter", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Thread Runtime Host");
    const folderId = await createWorkspace(host.token, "mapping");
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-opencode', $1, $2, 'opencode', 'active', $3, now(), now())`,
      [folderId, host.hostId, OWNER],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: {
        project_folder_id: folderId,
        adapter_type: "claude_code",
        prompt: "hi",
        thread_id: "thread-opencode",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toContain("pinned to a different runtime adapter");
    const runs = await pool.query(`SELECT id FROM runs`);
    expect(runs.rows).toHaveLength(0);
  });
});

describe("GET /api/v1/hosts/threads (ADR 0016 §7 work-stream read side)", () => {
  function withIdentity(): void {
    __setAuthIdentityForTests((request) => {
      const token = sessionTokenFromRequest(request);
      if (token === OWNER_TOKEN) return { spaceId: SPACE, userId: OWNER };
      if (token === OUTSIDER_TOKEN) return { spaceId: SPACE, userId: OUTSIDER };
      return null;
    });
  }

  it("lists task threads across every remote workspace in a Project, newest first", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    await seedProjectAndAgent();
    const host = await pairAndRegister("Threads List Host");
    const folderA = await createWorkspace(host.token, "folder-a");
    const folderB = await createWorkspace(host.token, "folder-b");
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-a', $1, $2, 'claude_code', 'active', $3, now() - interval '1 hour', now() - interval '1 hour')`,
      [folderA, host.hostId, OWNER],
    );
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-b', $1, $2, 'claude_code', 'session_reset', $3, now(), now())`,
      [folderB, host.hostId, OWNER],
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/hosts/threads?project_id=${PROJECT}`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ id: string; status: string }>;
    expect(items.map((t) => t.id)).toEqual(["thread-b", "thread-a"]);
    expect(items.find((t) => t.id === "thread-b")?.status).toBe("session_reset");
  });

  it("404s for a caller with no read access to the Project", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    await seedProjectAndAgent();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/hosts/threads?project_id=${PROJECT}`,
      headers: { cookie: authCookie(OUTSIDER_TOKEN) },
    });
    expect(response.statusCode).toBe(404);
  });

  it("422s without a project_id", async (ctx) => {
    if (!available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/threads",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("GET /api/v1/hosts/threads/:threadId/events (control-center-phase2-plan.md P1, C2/C3)", () => {
  function withIdentity(): void {
    __setAuthIdentityForTests((request) => {
      const token = sessionTokenFromRequest(request);
      if (token === OWNER_TOKEN) return { spaceId: SPACE, userId: OWNER };
      if (token === OUTSIDER_TOKEN) return { spaceId: SPACE, userId: OUTSIDER };
      return null;
    });
  }

  it("returns normalized text/tool-activity/status/diagnostic events from a real dispatch, in order, and supports cursor paging", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    await seedProjectAndAgent();
    const host = await pairAndRegister("Events Host");
    const folderId = await createWorkspace(host.token, "mapping");

    const sink = claudeAcpSink(host.hostId, {
      resolveSession: () => "vendor-session-events",
      events: [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "vendor-session-events",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the file\n" } },
          },
        },
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "vendor-session-events",
            update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read" },
          },
        },
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "vendor-session-events",
            // No result content on this update, on purpose: whether ACP tool
            // result content is absorbed (and bounded) is already covered by
            // threadEventNormalization.test.ts — this test stays focused on
            // event-type ordering and cursor paging.
            update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
          },
        },
      ],
      stderr: "a warning line\n",
    });
    sharedHostConnectionRegistry.registerConnection(host.hostId, sink);

    const dispatch = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "read the file" },
    });
    expect(dispatch.statusCode).toBe(201);
    const threadId = dispatch.json().thread_id as string;
    await driveOneJob();
    sharedHostConnectionRegistry.unregisterConnection(host.hostId, sink);

    const all = await app.inject({
      method: "GET",
      url: `/api/v1/hosts/threads/${threadId}/events`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(all.statusCode).toBe(200);
    const items = all.json().items as Array<{ event_index: number; event_type: string; text: string | null; status: string | null }>;
    expect(items.map((e) => e.event_type)).toEqual([
      "status",
      "assistant_text",
      "tool_activity_started",
      "tool_activity_finished",
      "diagnostic",
      "status",
    ]);
    expect(items[0]).toMatchObject({ event_type: "status", status: "run_started" });
    expect(items[1]).toMatchObject({ event_type: "assistant_text", text: "Reading the file" });
    expect(items.at(-1)).toMatchObject({ event_type: "status", status: "run_succeeded" });
    // event_index is a strictly increasing per-thread cursor.
    expect(items.map((e) => e.event_index)).toEqual([0, 1, 2, 3, 4, 5]);

    const afterCursor = await app.inject({
      method: "GET",
      url: `/api/v1/hosts/threads/${threadId}/events?after=2`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(afterCursor.statusCode).toBe(200);
    const afterItems = afterCursor.json().items as Array<{ event_index: number }>;
    expect(afterItems.map((e) => e.event_index)).toEqual([3, 4, 5]);
  });

  it("404s for an unknown thread", async (ctx) => {
    if (!available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/threads/no-such-thread/events",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a caller with no read access to the thread's Project", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    await seedProjectAndAgent();
    const host = await pairAndRegister("Events Access Host");
    const folderId = await createWorkspace(host.token, "mapping");
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-events-access', $1, $2, 'claude_code', 'active', $3, now(), now())`,
      [folderId, host.hostId, OWNER],
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/threads/thread-events-access/events",
      headers: { cookie: authCookie(OUTSIDER_TOKEN) },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/v1/hosts/threads/:threadId/messages (control-center-phase2-plan.md P3)", () => {
  function withIdentity(): void {
    __setAuthIdentityForTests((request) => {
      const token = sessionTokenFromRequest(request);
      if (token === OWNER_TOKEN) return { spaceId: SPACE, userId: OWNER };
      if (token === OUTSIDER_TOKEN) return { spaceId: SPACE, userId: OUTSIDER };
      return null;
    });
  }

  it("returns the durable message ledger — dispatched then queued-then-withdrawn — in order", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    await seedProjectAndAgent();
    const host = await pairAndRegister("Messages Host");
    const folderId = await createWorkspace(host.token, "mapping");
    const sink: HostFrameSink = { send: () => {}, close: () => {} };
    sharedHostConnectionRegistry.registerConnection(host.hostId, sink);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "first message" },
    });
    expect(first.statusCode).toBe(201);
    const threadId = first.json().thread_id as string;
    expect(first.json().status).toBe("dispatched");

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt: "second message", thread_id: threadId },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().status).toBe("queued");
    const secondMessageId = second.json().message_id as string;

    await app.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${threadId}/messages/${secondMessageId}/withdraw`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/hosts/threads/${threadId}/messages`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ prompt: string; status: string; run_id: string | null }>;
    expect(items.map((m) => [m.prompt, m.status])).toEqual([
      ["first message", "dispatched"],
      ["second message", "withdrawn"],
    ]);
    expect(items[0].run_id).not.toBeNull();

    sharedHostConnectionRegistry.unregisterConnection(host.hostId, sink);
  });

  it("404s for a caller with no read access to the thread's Project", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    await seedProjectAndAgent();
    const host = await pairAndRegister("Messages Access Host");
    const folderId = await createWorkspace(host.token, "mapping");
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-messages-access', $1, $2, 'claude_code', 'active', $3, now(), now())`,
      [folderId, host.hostId, OWNER],
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/threads/thread-messages-access/messages",
      headers: { cookie: authCookie(OUTSIDER_TOKEN) },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/v1/hosts/threads/recent (control-center-phase2-plan.md P3, C10)", () => {
  function withIdentity(): void {
    __setAuthIdentityForTests((request) => {
      const token = sessionTokenFromRequest(request);
      if (token === OWNER_TOKEN) return { spaceId: SPACE, userId: OWNER };
      if (token === OUTSIDER_TOKEN) return { spaceId: SPACE, userId: OUTSIDER };
      return null;
    });
  }

  it("spans every Project the caller can read in the space, most-recently-updated first, and excludes a Project they cannot read", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    withIdentity();
    await seedProjectAndAgent();
    const now = new Date().toISOString();
    // A second Project the caller owns (readable) and a third Project owned
    // by someone else with no membership grant for the caller (unreadable)
    // — the regression case for the space-membership-is-not-enough bug this
    // endpoint's own authorization was built to close.
    const project2 = "22222222-2222-4222-8222-222222222223";
    const project3 = "22222222-2222-4222-8222-222222222224";
    await pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Project Two','active',$4,$4)`,
      [project2, SPACE, OWNER, now],
    );
    await pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Project Three','active',$4,$4)`,
      [project3, SPACE, OUTSIDER, now],
    );

    const host = await pairAndRegister("Recent Threads Host");
    const folder1 = await createWorkspace(host.token, "mapping");
    const folderInProject = async (projectId: string, name: string) => {
      const created = await app!.inject({
        method: "POST",
        url: "/api/v1/hosts/me/workspaces",
        headers: { authorization: `Bearer ${host.token}` },
        payload: { project_id: projectId, name },
      });
      return created.json().id as string;
    };
    const folder2 = await folderInProject(project2, "readable-two");
    const folder3 = await folderInProject(project3, "unreadable-three");

    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-project1', $1, $2, 'claude_code', 'active', $3, now() - interval '2 hour', now() - interval '2 hour')`,
      [folder1, host.hostId, OWNER],
    );
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-project2', $1, $2, 'claude_code', 'active', $3, now(), now())`,
      [folder2, host.hostId, OWNER],
    );
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-project3', $1, $2, 'claude_code', 'active', $3, now() - interval '1 hour', now() - interval '1 hour')`,
      [folder3, host.hostId, OWNER],
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/threads/recent",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{ id: string; project_id: string; project_name: string; folder_name: string }>;
    expect(items.map((t) => t.id)).toEqual(["thread-project2", "thread-project1"]);
    expect(items.find((t) => t.id === "thread-project2")).toMatchObject({ project_id: project2, project_name: "Project Two", folder_name: "readable-two" });

    // Soft-deleting a Project the caller could otherwise read must remove
    // its threads from the landing view too — the sibling project-scoped
    // `GET /hosts/threads?project_id=` route already 404s a deleted
    // Project via `assertProjectReadable`'s `deleted_at IS NULL` check, and
    // this endpoint has to honor the same boundary (discovery review, P3).
    await pool.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [project2]);
    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/threads/recent",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    const afterDeleteItems = afterDelete.json().items as Array<{ id: string }>;
    expect(afterDeleteItems.map((t) => t.id)).toEqual(["thread-project1"]);
  });

  it("rejects without a session", async (ctx) => {
    if (!available || !app) return ctx.skip();
    const response = await app.inject({ method: "GET", url: "/api/v1/hosts/threads/recent" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/v1/hosts/runtime-adapters (control-center-phase2-plan.md P3, C6)", () => {
  it("lists remote-eligible and detected-but-ineligible adapters", async (ctx) => {
    if (!available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/runtime-adapters",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<{
      adapter_type: string;
      command: string;
      capability_probe: string;
      remote_eligible: boolean;
    }>;
    expect(items.find((a) => a.adapter_type === "claude_code")).toMatchObject({
      command: "claude-agent-acp",
      capability_probe: "claude",
      remote_eligible: true,
    });
    // ACP runtime replatform P3: codex_cli's own executable is the pinned
    // `codex-acp` adapter (a daemon dependency, not something a trusted host
    // installs) — capability discovery still probes for the vendor `codex`
    // CLI it drives.
    expect(items.find((a) => a.adapter_type === "codex_cli")).toMatchObject({
      command: "codex-acp",
      capability_probe: "codex",
      remote_eligible: true,
    });
    // ACP runtime replatform P2: opencode is the first bidirectional-protocol
    // adapter to gain remote support, via the ACP duplex transport.
    expect(items.find((a) => a.adapter_type === "opencode")).toMatchObject({
      command: "opencode",
      capability_probe: "opencode",
      remote_eligible: true,
    });
  });

  it("rejects without a session", async (ctx) => {
    if (!available || !app) return ctx.skip();
    const response = await app.inject({ method: "GET", url: "/api/v1/hosts/runtime-adapters" });
    expect(response.statusCode).toBe(401);
  });
});

describe("PgHostThreadEventRepository.append() under concurrency (P1 discovery review fix)", () => {
  it("never collides on event_index when two Runs write to the same thread concurrently", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Concurrency Host");
    const folderId = await createWorkspace(host.token, "mapping");

    const threadId = "thread-concurrency";
    const runIdA = "run-concurrency-a";
    const runIdB = "run-concurrency-b";
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'claude_code', 'active', $4, now(), now())`,
      [threadId, folderId, host.hostId, OWNER],
    );
    for (const runId of [runIdA, runIdB]) {
      await pool.query(
        `INSERT INTO runs (
           id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
           project_id, project_folder_id, host_task_thread_id, adapter_type, required_sandbox_level,
           prompt, owner_user_id, instructed_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'system', 'manual', 'queued', 'live', $5, $6, $7, 'claude_code', 'none', $8, $9, $9, $10, $10)`,
        [runId, SPACE, AGENT, AGENT_VERSION, PROJECT, folderId, threadId, "concurrent test prompt", OWNER, now],
      );
    }

    const events = new PgHostThreadEventRepository(pool);
    // Two independent sink instances (one per Run, matching how
    // orchestrationService.ts constructs one per execution) both writing a
    // multi-event batch to the same thread at the same time — exactly the
    // scenario the per-Run promise chain alone cannot serialize, and the
    // append()-level advisory lock exists to close.
    const [resultA, resultB] = await Promise.all([
      events.append(threadId, runIdA, [
        { event_type: "status", status: "run_started" },
        { event_type: "assistant_text", text: "from run A, segment 1" },
        { event_type: "assistant_text", text: "from run A, segment 2" },
      ]),
      events.append(threadId, runIdB, [
        { event_type: "status", status: "run_started" },
        { event_type: "assistant_text", text: "from run B, segment 1" },
        { event_type: "assistant_text", text: "from run B, segment 2" },
      ]),
    ]);
    expect(resultA).toHaveLength(3);
    expect(resultB).toHaveLength(3);

    const all = await events.listAfter(threadId, -1);
    expect(all).toHaveLength(6);
    // No collision: every event_index is unique, and the full set is a dense
    // 0..5 run — no gaps, no duplicates, no silently dropped events from the
    // for-loop-with-no-per-item-try/catch failure mode discovery review
    // flagged.
    const indices = all.map((e) => e.event_index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(indices).size).toBe(6);
    // Each Run's own three events stayed in the order that Run produced them
    // relative to each other, even though the two Runs interleaved.
    const runAIndices = all.filter((e) => e.run_id === runIdA).map((e) => e.event_index);
    const runBIndices = all.filter((e) => e.run_id === runIdB).map((e) => e.event_index);
    expect(runAIndices).toEqual([...runAIndices].sort((a, b) => a - b));
    expect(runBIndices).toEqual([...runBIndices].sort((a, b) => a - b));
  });
});

describe("dispatch timeout_ms on the async job-queue path (P1 discovery review fix)", () => {
  it("actually times out a queued dispatch, proving timeout_ms still has an effect after the sync→async migration", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Timeout Host");
    const folderId = await createWorkspace(host.token, "mapping");

    // The daemon receives the launch frame and never responds — the only
    // way this run ever resolves is the executor's own timeout firing.
    const sink: HostFrameSink = { send: () => {}, close: () => {} };
    sharedHostConnectionRegistry.registerConnection(host.hostId, sink);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: {
        project_folder_id: folderId,
        adapter_type: "claude_code",
        prompt: "this should time out",
        timeout_ms: 200,
      },
    });
    expect(response.statusCode).toBe(201);
    const runId = response.json().run_id as string;
    await driveOneJob();

    const runRow = await pool.query<{ status: string; error_message: string | null; error_json: unknown }>(
      `SELECT status, error_message, error_json FROM runs WHERE id = $1`,
      [runId],
    );
    expect(runRow.rows[0]!.status).not.toBe("running");
    expect(JSON.stringify(runRow.rows[0])).toContain("runtime_timeout");

    sharedHostConnectionRegistry.unregisterConnection(host.hostId, sink);
  });
});

describe("message queue (control-center-phase2-plan.md P2, C4)", () => {
  async function dispatch(folderId: string, prompt: string, threadId?: string): Promise<{
    statusCode: number;
    message_id: string;
    thread_id: string;
    run_id: string | null;
    status: "dispatched" | "queued";
  }> {
    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/hosts/dispatch",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { project_folder_id: folderId, adapter_type: "claude_code", prompt, thread_id: threadId ?? null },
    });
    return { statusCode: response.statusCode, ...response.json() };
  }

  it("dispatches without naming an agent, reusing one system-managed agent across every dispatch in the space (C8)", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("No Agent Host");
    const folderId = await createWorkspace(host.token, "mapping");

    const first = await dispatch(folderId, "first");
    expect(first.statusCode).toBe(201);
    const second = await dispatch(folderId, "second", first.thread_id);

    const systemAgents = await pool.query<{ id: string; agent_kind: string; owner_user_id: string | null; visibility: string }>(
      `SELECT id, agent_kind, owner_user_id, visibility FROM agents WHERE agent_kind = 'system_remote_dispatch' AND space_id = $1`,
      [SPACE],
    );
    expect(systemAgents.rows).toHaveLength(1);
    expect(systemAgents.rows[0]).toMatchObject({ owner_user_id: null, visibility: "space_shared" });

    const runAgents = await pool.query<{ agent_id: string }>(`SELECT agent_id FROM runs WHERE id = ANY($1)`, [
      [first.run_id, second.status === "dispatched" ? second.run_id : null].filter(Boolean),
    ]);
    for (const row of runAgents.rows) expect(row.agent_id).toBe(systemAgents.rows[0]!.id);
  });

  it("queues a second message while the thread's first run is still active, instead of dispatching immediately", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Queue Host");
    const folderId = await createWorkspace(host.token, "mapping");
    // No daemon frame handling needed here — a dispatched Run is "active"
    // (blocks the queue) the instant its row exists as `queued`, before the
    // job worker has even claimed it.
    sharedHostConnectionRegistry.registerConnection(host.hostId, { send: () => {}, close: () => {} });

    const first = await dispatch(folderId, "first message");
    expect(first).toMatchObject({ statusCode: 201, status: "dispatched" });
    expect(first.run_id).toEqual(expect.any(String));

    const second = await dispatch(folderId, "second message", first.thread_id);
    expect(second).toMatchObject({ statusCode: 201, status: "queued", run_id: null });
    expect(second.message_id).toEqual(expect.any(String));

    const messages = await pool.query<{ status: string; prompt: string }>(
      `SELECT status, prompt FROM host_thread_messages WHERE host_task_thread_id = $1 ORDER BY created_at ASC`,
      [first.thread_id],
    );
    expect(messages.rows.map((m) => m.status)).toEqual(["dispatched", "queued"]);
  });

  it("auto-advances the queue when the active run succeeds", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Auto Advance Host");
    const folderId = await createWorkspace(host.token, "mapping");
    const sink = claudeAcpSink(host.hostId);
    sharedHostConnectionRegistry.registerConnection(host.hostId, sink);

    const first = await dispatch(folderId, "first message");
    const second = await dispatch(folderId, "second message", first.thread_id);
    expect(second.status).toBe("queued");

    await driveOneJob();

    const messages = await pool.query<{ status: string; run_id: string | null }>(
      `SELECT status, run_id FROM host_thread_messages WHERE id = $1`,
      [second.message_id],
    );
    expect(messages.rows[0]).toMatchObject({ status: "dispatched" });
    expect(messages.rows[0]!.run_id).toEqual(expect.any(String));
    expect(messages.rows[0]!.run_id).not.toBe(first.run_id);

    const thread = await pool.query<{ queue_paused_at: string | null }>(
      `SELECT queue_paused_at FROM host_task_threads WHERE id = $1`,
      [first.thread_id],
    );
    expect(thread.rows[0]!.queue_paused_at).toBeNull();

    sharedHostConnectionRegistry.unregisterConnection(host.hostId, sink);
  });

  it("pauses the queue instead of auto-advancing when the active run fails", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Pause Host");
    const folderId = await createWorkspace(host.token, "mapping");
    const sink: HostFrameSink = { send: () => {}, close: () => {} };
    sink.send = (frame) => {
      if (frame.type === "launch") {
        const runId = frame.run_id as string;
        queueMicrotask(() => {
          sharedHostConnectionRegistry.receiveComplete(host.hostId, runId, { exit_code: 1, timed_out: false, error: "boom" });
        });
      }
    };
    sharedHostConnectionRegistry.registerConnection(host.hostId, sink);

    const first = await dispatch(folderId, "first message");
    const second = await dispatch(folderId, "second message", first.thread_id);
    expect(second.status).toBe("queued");

    await driveOneJob();

    const thread = await pool.query<{ queue_paused_at: string | null }>(
      `SELECT queue_paused_at FROM host_task_threads WHERE id = $1`,
      [first.thread_id],
    );
    expect(thread.rows[0]!.queue_paused_at).not.toBeNull();

    // Paused — the second message stays queued, not auto-dispatched.
    const messages = await pool.query<{ status: string }>(
      `SELECT status FROM host_thread_messages WHERE id = $1`,
      [second.message_id],
    );
    expect(messages.rows[0]).toMatchObject({ status: "queued" });

    // Explicit resume advances it.
    const resumeResponse = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${first.thread_id}/resume-queue`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(resumeResponse.statusCode).toBe(200);
    expect(resumeResponse.json()).toMatchObject({ status: "dispatched" });

    const threadAfterResume = await pool.query<{ queue_paused_at: string | null }>(
      `SELECT queue_paused_at FROM host_task_threads WHERE id = $1`,
      [first.thread_id],
    );
    expect(threadAfterResume.rows[0]!.queue_paused_at).toBeNull();
    const messagesAfterResume = await pool.query<{ status: string }>(
      `SELECT status FROM host_thread_messages WHERE id = $1`,
      [second.message_id],
    );
    expect(messagesAfterResume.rows[0]).toMatchObject({ status: "dispatched" });

    sharedHostConnectionRegistry.unregisterConnection(host.hostId, sink);
  });

  it("resume-queue requires Project write access", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Resume Access Host");
    const folderId = await createWorkspace(host.token, "mapping");
    sharedHostConnectionRegistry.registerConnection(host.hostId, { send: () => {}, close: () => {} });
    const first = await dispatch(folderId, "hello");

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${first.thread_id}/resume-queue`,
      headers: { cookie: authCookie(OUTSIDER_TOKEN) },
    });
    expect(response.statusCode).toBe(403);
  });

  it("withdraws a still-queued message but rejects withdrawing one already dispatched", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Withdraw Host");
    const folderId = await createWorkspace(host.token, "mapping");
    sharedHostConnectionRegistry.registerConnection(host.hostId, { send: () => {}, close: () => {} });

    const first = await dispatch(folderId, "active one");
    const second = await dispatch(folderId, "withdraw me", first.thread_id);
    expect(second.status).toBe("queued");

    const withdraw = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${first.thread_id}/messages/${second.message_id}/withdraw`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(withdraw.statusCode).toBe(200);
    expect(withdraw.json()).toMatchObject({ status: "withdrawn" });

    const alreadyDispatched = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${first.thread_id}/messages/${first.message_id}/withdraw`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(alreadyDispatched.statusCode).toBe(409);

    const doubleWithdraw = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${first.thread_id}/messages/${second.message_id}/withdraw`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(doubleWithdraw.statusCode).toBe(409);
  });

  it("cancels the thread's active run, which then pauses the queue via the ordinary terminal hook", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Cancel Host");
    const folderId = await createWorkspace(host.token, "mapping");
    // The job is deliberately never driven before cancel — cancelRun's
    // processRegistry.terminate() finds nothing registered for a Run whose
    // job hasn't started executing yet, so confirmedExit stays at its
    // default `true` and cancellation resolves immediately, synchronously,
    // with no daemon round trip needed.
    sharedHostConnectionRegistry.registerConnection(host.hostId, { send: () => {}, close: () => {} });

    const first = await dispatch(folderId, "cancel me");
    const second = await dispatch(folderId, "should stay queued", first.thread_id);
    expect(second.status).toBe("queued");

    const noActiveRun = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/nonexistent-thread/cancel`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(noActiveRun.statusCode).toBe(404);

    const cancel = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${first.thread_id}/cancel`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ run_id: first.run_id, status: "cancelled" });

    const runRow = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [first.run_id]);
    expect(runRow.rows[0]).toMatchObject({ status: "cancelled" });

    // The job worker eventually claims the (already-cancelled) job — its
    // handler re-reads the run's real terminal state from the DB rather
    // than trusting executeRun's own short-circuited return, so the
    // post-terminal pause hook still fires correctly.
    await driveOneJob();

    const thread = await pool.query<{ queue_paused_at: string | null }>(
      `SELECT queue_paused_at FROM host_task_threads WHERE id = $1`,
      [first.thread_id],
    );
    expect(thread.rows[0]!.queue_paused_at).not.toBeNull();

    const secondNoLongerActive = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${first.thread_id}/cancel`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(secondNoLongerActive.statusCode).toBe(409);
  });

  it("cancel requires Project write access", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Cancel Access Host");
    const folderId = await createWorkspace(host.token, "mapping");
    sharedHostConnectionRegistry.registerConnection(host.hostId, { send: () => {}, close: () => {} });
    const first = await dispatch(folderId, "hello");

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/hosts/threads/${first.thread_id}/cancel`,
      headers: { cookie: authCookie(OUTSIDER_TOKEN) },
    });
    expect(response.statusCode).toBe(403);
  });

  it("never dispatches the same queued message twice when advanceThreadQueue is called concurrently (P2 discovery review fix)", async (ctx) => {
    if (!available || !app || !pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await seedProjectAndAgent();
    const host = await pairAndRegister("Concurrent Advance Host");
    const folderId = await createWorkspace(host.token, "mapping");
    sharedHostConnectionRegistry.registerConnection(host.hostId, { send: () => {}, close: () => {} });

    // Seed the precondition directly rather than through the dispatch route
    // (which 409s outright on an offline host, never reaching the queue) —
    // this test is about advanceThreadQueue's own concurrency safety, not
    // the route: a thread with exactly one `queued` message and no run yet,
    // ready for two callers to race "nothing blocking, pop this message".
    const threadId = "thread-concurrent-advance";
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO host_task_threads (id, project_folder_id, host_id, adapter_type, status, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'claude_code', 'active', $4, $5, $5)`,
      [threadId, folderId, host.hostId, OWNER, now],
    );
    const messages = new PgHostThreadMessageRepository(pool);
    const message = await messages.enqueue(threadId, "race me", OWNER);

    const [first, second] = await Promise.all([
      advanceThreadQueue(pool, threadId),
      advanceThreadQueue(pool, threadId),
    ]);
    const advancedResults = [first, second].filter((r) => r.advanced);
    // Exactly one of the two concurrent calls actually advanced the queue —
    // the other correctly observes "already handled" (queue_empty, since
    // the only queued message is now dispatched) rather than also creating
    // a second Run for the same message.
    expect(advancedResults).toHaveLength(1);
    expect(advancedResults[0]).toMatchObject({ message_id: message.id });

    const runs = await pool.query<{ id: string }>(
      `SELECT id FROM runs WHERE host_task_thread_id = $1`,
      [threadId],
    );
    expect(runs.rows).toHaveLength(1);

    const messageRow = await pool.query<{ status: string; run_id: string | null }>(
      `SELECT status, run_id FROM host_thread_messages WHERE id = $1`,
      [message.id],
    );
    expect(messageRow.rows[0]).toMatchObject({ status: "dispatched", run_id: runs.rows[0]!.id });
  });
});
