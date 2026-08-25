import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PgHostRepository } from "../src/modules/hosts/repository";
import { PgWorkspaceLocationRepository } from "../src/modules/projectFolders/workspaceLocations";
import { projectTaskStatusFromRun } from "../src/modules/tasks/taskRunStatusProjection";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const FOLDER = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const RUN = "77777777-7777-4777-8777-777777777777";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["task_runs", "runs", "tasks", "workspace_locations", "project_folders", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces", "hosts", "machines"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now())`,
    [USER],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Topology Space', 'personal', $2, now(), now())`,
    [SPACE, USER],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
    [randomUUID(), SPACE, USER],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Topology Project', 'active', now(), now())`,
    [PROJECT, SPACE, USER],
  );
  await db.pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, created_by_user_id, name, status, kind,
       is_primary, protected, system_managed, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Logical Folder', 'active', 'code', true, false, false, now(), now())`,
    [FOLDER, SPACE, PROJECT, USER],
  );
});

describe("P1 execution topology database invariants", () => {
  it("keeps Machine, Host, Location readiness, and daemon heartbeat distinct", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const serverHostId = await hosts.ensureServerHostId();
    const server = await db.pool.query<{ machine_id: string; environment_kind: string }>(
      `SELECT machine_id, environment_kind FROM hosts WHERE id = $1`,
      [serverHostId],
    );
    expect(server.rows[0]).toMatchObject({ machine_id: expect.any(String), environment_kind: "server" });

    const locations = new PgWorkspaceLocationRepository(db.pool);
    const serverLocation = await locations.create({
      spaceId: SPACE,
      projectFolderId: FOLDER,
      executionHostId: serverHostId,
      executionHostKind: "server",
      rootPath: "/tmp/topology-server",
    });
    expect(serverLocation.preferred).toBe(true);
    expect(serverLocation.execution_ready).toBe(false);

    const pairing = await hosts.issuePairingCode(USER, "Topology Laptop");
    if ("statusCode" in pairing) throw new Error("expected pairing code");
    const registered = await hosts.registerViaPairingCode(pairing.pairing_code, {
      platform: "linux",
      environment_kind: "linux_native",
      capabilities_json: { runtimes: ["codex"] },
    });
    if ("statusCode" in registered) throw new Error("expected registered host");
    const remoteLocation = await locations.create({
      spaceId: SPACE,
      projectFolderId: FOLDER,
      executionHostId: registered.host_id,
      executionHostKind: "remote",
      displayPath: "/home/owner/topology",
    });
    expect(remoteLocation.execution_ready).toBe(false);

    await hosts.recordHeartbeat(registered.host_id, {
      workspace_reports: [{
        location_id: remoteLocation.id,
        branch: "main",
        git_head: "abc123",
        dirty: false,
        execution_ready: true,
      }],
    });
    const ready = await locations.get({ spaceId: SPACE, userId: USER }, FOLDER, remoteLocation.id);
    expect(ready).toMatchObject({ execution_ready: true, branch: "main", git_head: "abc123", dirty: false });

    await hosts.recordHeartbeat(registered.host_id, { workspace_reports: [] });
    const stale = await locations.get({ spaceId: SPACE, userId: USER }, FOLDER, remoteLocation.id);
    expect(stale?.execution_ready).toBe(false);
  });

  it("projects a terminal Run into the Task exactly once for success or failure", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const hostId = await hosts.ensureServerHostId();
    const locations = new PgWorkspaceLocationRepository(db.pool);
    const location = await locations.create({
      spaceId: SPACE,
      projectFolderId: FOLDER,
      executionHostId: hostId,
      executionHostKind: "server",
      rootPath: "/tmp/topology-projector",
    });
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
       VALUES ($1, $2, $3, 'Topology Agent', 'active', 'standard', 'private', now(), now())`,
      [AGENT, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (
         id, agent_id, space_id, version_label, model_config_json, runtime_config_json,
         context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json,
         runtime_policy_json, created_at
       ) VALUES ($1, $2, $3, 'v1', '{}', '{}', '{}', '{}', '[]', '{}', '{}', now())`,
      [VERSION, AGENT, SPACE],
    );
    await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
    await db.pool.query(
      `INSERT INTO tasks (
         id, space_id, project_id, project_folder_id, title, status,
         created_by_user_id, owner_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Topology task', 'ready', $5, $5, now(), now())`,
      [TASK, SPACE, PROJECT, FOLDER, USER],
    );
    await db.pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, project_id, project_folder_id,
         workspace_location_id, trust_mode, run_type, trigger_origin, status, mode,
         owner_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'sandboxed', 'agent', 'manual', 'succeeded', 'live', $8, now(), now())`,
      [RUN, SPACE, AGENT, VERSION, PROJECT, FOLDER, location.id, USER],
    );
    await db.pool.query(
      `INSERT INTO task_runs (id, space_id, task_id, run_id, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [randomUUID(), SPACE, TASK, RUN],
    );

    await projectTaskStatusFromRun(db.pool, SPACE, RUN);
    let task = await db.pool.query<{ status: string; blocked_reason: string | null }>(
      `SELECT status, blocked_reason FROM tasks WHERE id = $1`,
      [TASK],
    );
    expect(task.rows[0]).toMatchObject({ status: "done", blocked_reason: null });

    await db.pool.query(`UPDATE tasks SET status = 'ready', completed_at = NULL WHERE id = $1`, [TASK]);
    await db.pool.query(`UPDATE runs SET status = 'failed' WHERE id = $1`, [RUN]);
    await projectTaskStatusFromRun(db.pool, SPACE, RUN);
    task = await db.pool.query<{ status: string; blocked_reason: string | null }>(
      `SELECT status, blocked_reason FROM tasks WHERE id = $1`,
      [TASK],
    );
    expect(task.rows[0]).toMatchObject({ status: "blocked", blocked_reason: "A linked Run ended unsuccessfully" });
  });
});
