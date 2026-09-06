import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { agentsModule } from "../src/modules/agents/index.js";
import { loadConfig } from "../src/config.js";
import { __setAgentChatIdentityForTests } from "../src/modules/agents/routes.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";

/**
 * `POST /api/v1/agents/:agentId/host-state/reset` — "clear this Agent's CLI
 * memory on this host".
 *
 * It is the one externally reachable write this phase adds, and the thing it
 * clears is an Agent's login, vendor sessions and CLI auto-memory on a machine
 * someone owns. What is asserted here is who may reach it and what it refuses;
 * the daemon-side archive has its own tests in `packages/host-daemon`, and the
 * session retirement is covered in `hostThreadsDb.test.ts`.
 *
 * Every case below stops before the daemon round trip or asserts the offline
 * answer, because a paired daemon is what this suite cannot have.
 */

const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VERSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MACHINE = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;

async function reset(agentId: string, body: Record<string, unknown>) {
  return app!.inject({
    method: "POST",
    url: `/api/v1/agents/${agentId}/host-state/reset`,
    payload: body,
  });
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["runs", "host_threads", "tasks", "workspace_locations", "project_folders", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(
    `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
     VALUES ($1, 'other@example.com', 'Other', 'active', $2, $2)`,
    [OTHER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
    [randomUUID(), SPACE, OTHER, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  // `seedAgentWithVersion` makes a space_shared Agent; this route's owner
  // check only bites when the Agent has one, so say so explicitly.
  await db.pool.query(`UPDATE agents SET owner_user_id = $2, visibility = 'private' WHERE id = $1`, [AGENT, OWNER]);
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'laptop', 'laptop', $3, $3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [agentsModule]);
  __setAgentChatIdentityForTests({ spaceId: SPACE, userId: OWNER });
});

afterEach(async () => {
  __setAgentChatIdentityForTests(null);
  await app?.close();
  app = undefined;
});

describe("clearing an Agent's host state", () => {
  it("requires a host, and refuses one the caller does not own", async (ctx) => {
    if (!db.available) return ctx.skip();
    expect((await reset(AGENT, {})).statusCode).toBe(422);
    // A Host is user-scoped (B63). Someone else's machine is not this
    // person's to clear, and saying "not found" rather than "forbidden" keeps
    // the existence of another user's host out of the answer.
    await db.pool.query(`UPDATE hosts SET owner_user_id = $2 WHERE id = $1`, [HOST, OTHER]);
    expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(404);
  });

  it("refuses an Agent outside the Space and one the caller does not own", async (ctx) => {
    if (!db.available) return ctx.skip();
    expect((await reset(randomUUID(), { host_id: HOST })).statusCode).toBe(404);
    // The Agent's owner decides what it remembers. A Room member who happens
    // to own the machine it runs on does not.
    __setAgentChatIdentityForTests({ spaceId: SPACE, userId: OTHER });
    await db.pool.query(`UPDATE hosts SET owner_user_id = $2 WHERE id = $1`, [HOST, OTHER]);
    const denied = await reset(AGENT, { host_id: HOST });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().detail).toMatch(/owner/i);
  });

  it("clears an ownerless Agent for whoever owns the machine", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The `space_shared` Space and Project Assistants have no owner. The state
    // being cleared is on the caller's own machine, put there by their own
    // runs, and there is no owner to defer to (ADR 0003 §4).
    await db.pool.query(
      `UPDATE agents SET owner_user_id = NULL, visibility = 'space_shared' WHERE id = $1`,
      [AGENT],
    );
    // Reaches the daemon round trip, which has no paired host in this suite.
    const response = await reset(AGENT, { host_id: HOST });
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/offline/i);
  });

  it("refuses while a dispatch holds this Agent's thread, before touching the host", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The profile is what a launching run is about to read. Archiving it out
    // from under one would kill a turn a person is waiting on.
    await db.pool.query(
      `INSERT INTO host_threads (
         id, space_id, execution_host_id, workspace_mode, agent_id, container_kind, container_user_id,
         adapter_type, runtime_installation, status, dispatch_lock_id, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, 'managed', $4, 'direct', $5, 'claude_code', 'own', 'active', $6, $5, now(), now())`,
      [randomUUID(), SPACE, HOST, AGENT, OWNER, randomUUID()],
    );

    const response = await reset(AGENT, { host_id: HOST });

    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/handling a message/i);
  });

  it("refuses while a Task Run is in flight on this Agent's Location thread", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A Task thread never claims the dispatch lock — its admission serialises
    // on the latest Run's status — so the lock alone could not see this Run.
    // Archiving the profile under it would let the Run's outcome re-arm the
    // thread with a session whose store is gone.
    const now = new Date().toISOString();
    const folder = randomUUID();
    const location = randomUUID();
    const task = randomUUID();
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
       VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`,
      [folder, SPACE, PROJECT, now],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         display_path, execution_ready, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'remote', '/workspace/repo', true, 'active', $5, $5)`,
      [location, SPACE, folder, HOST, now],
    );
    await db.pool.query(
      `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Test task', 'ready', $5, $6, $6)`,
      [task, SPACE, PROJECT, folder, OWNER, now],
    );
    const thread = await new PgHostThreadRepository(db.pool).create({
      executionHostId: HOST, workspaceLocationId: location, taskId: task, adapterType: "claude_code", createdByUserId: OWNER,
    });
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
                         owner_user_id, visibility, host_task_thread_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'system', 'manual', 'running', 'live', $5, 'private', $6, now(), now())`,
      [runId, SPACE, AGENT, VERSION, OWNER, thread.id],
    );

    const refused = await reset(AGENT, { host_id: HOST });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toMatch(/in flight/i);
    await expect(db.pool.query<{ status: string }>(`SELECT status FROM host_threads WHERE id = $1`, [thread.id]))
      .resolves.toMatchObject({ rows: [{ status: "active" }] });

    // Once the Run has settled the guard lets the reset through to the host,
    // which this suite does not have — so the offline answer is what proves
    // it passed.
    await db.pool.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [runId]);
    const passed = await reset(AGENT, { host_id: HOST });
    expect(passed.statusCode).toBe(409);
    expect(passed.json().detail).toMatch(/offline/i);
  });

  it("answers the Host being offline rather than reporting a reset that did not happen", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A live thread with a vendor session to lose. The retirement runs inside
    // the same transaction as the daemon call, so a Host that never answered
    // must leave it exactly as it was — otherwise the next turn starts fresh
    // in a profile that is still there, and the person is told nothing.
    //
    // What this does *not* prove is the ordering inside the transaction: an
    // offline Host throws before either step in one arrangement and after the
    // retire in the other, and both roll back. The ordering matters for the
    // case where the archive succeeds and the retire then fails, which needs
    // a stubbed connection registry this suite has no seam for.
    const threadId = randomUUID();
    await db.pool.query(
      `INSERT INTO host_threads (
         id, space_id, execution_host_id, workspace_mode, agent_id, container_kind, container_user_id,
         adapter_type, runtime_installation, status, vendor_session_id, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, 'managed', $4, 'direct', $5, 'claude_code', 'own', 'active', 'vendor-1', $5, now(), now())`,
      [threadId, SPACE, HOST, AGENT, OWNER],
    );

    const response = await reset(AGENT, { host_id: HOST });

    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/offline/i);
    const after = await db.pool.query<{ status: string; vendor_session_id: string | null }>(
      `SELECT status, vendor_session_id FROM host_threads WHERE id = $1`, [threadId],
    );
    expect(after.rows[0]).toMatchObject({ status: "active", vendor_session_id: "vendor-1" });
  });
});
