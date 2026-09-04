import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedServerHost, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { ConversationExecutionContextService } from "../src/modules/sessions/executionContextService.js";
import { PgProjectFolderRepository } from "../src/modules/projectFolders/repository.js";
import { PgWorkspaceLocationRepository } from "../src/modules/projectFolders/workspaceLocations.js";
import { loadConfig } from "../src/config.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { seedAgentWithVersion, seedRoomManager } from "./support/domainSeeds.js";

const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOLDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LOCATION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ATTACHED_FOLDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
const ATTACHED_LOCATION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeea";
const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER_HOST = "22222222-2222-4222-8222-222222222222";
const OTHER_MACHINE = "99999999-9999-4999-8999-999999999999";
const REMOTE_FOLDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddc";
const REMOTE_LOCATION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeec";
const SESSION = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const VERSION = "55555555-5555-4555-8555-555555555555";
const RUNTIME = "66666666-6666-4666-8666-666666666666";

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    [
      "conversation_folder_access_grants",
      "conversation_execution_contexts",
      "host_threads",
      "session_conversation_backends",
      "room_agent_members",
      "agent_runtime_profiles",
      "agent_versions",
      "agents",
      "sessions",
      "workspace_locations",
      "project_folders",
      "rooms",
      "projects",
      "hosts",
      "machines",
      "space_memberships",
      "users",
      "spaces",
    ],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedServerHost(db.pool, { id: HOST, now });
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'Other machine', 'desktop', $3, $3)`,
    [OTHER_MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Other host', 'remote', 'linux_native', 'online', $4, $4)`,
    [OTHER_HOST, OWNER, OTHER_MACHINE, now],
  );
  const room = await db.pool.query<{ id: string }>(
    `SELECT id FROM rooms WHERE space_id = $1 AND project_id = $2 AND is_mainline = true LIMIT 1`,
    [SPACE, PROJECT],
  );
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [SESSION, SPACE, PROJECT, room.rows[0]!.id, now],
  );
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status,
       kind, protected, system_managed, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'repo', 'active', 'code', false, false, $5, $5)`,
    [FOLDER, SPACE, PROJECT, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       root_path, execution_ready, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'server', '/workspace/repo', true, 'active', $5, $5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  await db.pool.query(
    `UPDATE agents
        SET project_id = $1, agent_kind = 'system_assistant'
      WHERE id = $2`,
    [PROJECT, AGENT],
  );
  await seedRoomManager(db.pool, { space: SPACE, room: room.rows[0]!.id, agent: AGENT, now });
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, execution_host_id,
       workspace_mode, runtime_installation, runtime_config_json, runtime_policy_json,
       enabled, is_default, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Host CLI', 'claude_code', $4, 'managed', 'own', '{}', '{}', true, true, $5, $5)`,
    [RUNTIME, SPACE, AGENT, HOST, now],
  );
});

describe("Conversation execution schema", () => {
  it("rejects invalid Primary shapes and preserves one active Location", async (ctx) => {
    if (!db.available) return ctx.skip();
    await expect(db.pool.query(
      `INSERT INTO conversation_execution_contexts (
         id, space_id, session_id, execution_host_id, primary_workspace_mode,
         primary_project_folder_id, primary_workspace_location_id, state, initialized_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'managed', $5, $6, 'draft', NULL, now(), now())`,
      [randomUUID(), SPACE, SESSION, HOST, FOLDER, LOCATION],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id,
         execution_host_kind, execution_ready, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'server', true, 'active', now(), now())`,
      [randomUUID(), SPACE, FOLDER, HOST],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("binds a Location and grant to the same Space/Folder and permits one current grant", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(
      `INSERT INTO conversation_execution_contexts (
         id, space_id, session_id, execution_host_id, primary_workspace_mode,
         primary_project_folder_id, primary_workspace_location_id, state, initialized_at,
         initialized_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'location', $5, $6, 'initialized', now(), $7, now(), now())`,
      [randomUUID(), SPACE, SESSION, HOST, FOLDER, LOCATION, OWNER],
    );
    const first = randomUUID();
    await db.pool.query(
      `INSERT INTO conversation_folder_access_grants (
         id, space_id, session_id, project_folder_id, workspace_location_id,
         access_mode, status, granted_by_user_id, granted_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'read', 'active', $6, now(), now())`,
      [first, SPACE, SESSION, FOLDER, LOCATION, OWNER],
    );
    await expect(db.pool.query(
      `INSERT INTO conversation_folder_access_grants (
         id, space_id, session_id, project_folder_id, workspace_location_id,
         access_mode, status, granted_by_user_id, granted_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'write', 'active', $6, now(), now())`,
      [randomUUID(), SPACE, SESSION, FOLDER, LOCATION, OWNER],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a Primary Location paired with a different execution Host", async (ctx) => {
    if (!db.available) return ctx.skip();
    await expect(db.pool.query(
      `INSERT INTO conversation_execution_contexts (
         id, space_id, session_id, execution_host_id, primary_workspace_mode,
         primary_project_folder_id, primary_workspace_location_id, state,
         initialized_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'location', $5, $6, 'initialized', now(), now(), now())`,
      [randomUUID(), SPACE, SESSION, OTHER_HOST, FOLDER, LOCATION],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("initializes once, creates a Conversation runtime thread, and keeps the pin after profile edits", async (ctx) => {
    if (!db.available) return ctx.skip();
    const service = new ConversationExecutionContextService(db.pool);
    const initialized = await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "managed" } },
        runtime: {
          agent_id: AGENT,
          runtime_profile_id: RUNTIME,
          credential_profile_id: null,
          adapter_type: "claude_code",
          runtime_installation: "own",
        },
      },
    );
    expect(initialized).toMatchObject({ state: "initialized", host: { host_id: HOST }, primary: { kind: "managed" } });
    // The service is stateless: recreating it models a server process restart.
    // The Conversation must recover from its persisted binding and Host thread,
    // without allocating replacement identities.
    const afterRestart = await new ConversationExecutionContextService(db.pool)
      .preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(afterRestart.summary).toMatchObject({
      can_send: true,
      blocked_reason: null,
      runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME },
    });
    await db.pool.query(`UPDATE agent_runtime_profiles SET adapter_type = 'codex_cli' WHERE id = $1`, [RUNTIME]);
    const preflight = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(preflight.summary).toMatchObject({
      state: "initialized",
      runtime: { agent_id: AGENT, adapter_type: "claude_code", runtime_installation: "own" },
      can_send: false,
      blocked_reason: expect.stringContaining("no longer matches the pinned Host, CLI, or Primary Workspace"),
    });
    await expect(service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: OTHER_HOST, primary: { kind: "managed" } },
        runtime: {
          agent_id: AGENT,
          runtime_profile_id: RUNTIME,
          credential_profile_id: null,
          adapter_type: "codex_cli",
          runtime_installation: "own",
        },
      },
    )).rejects.toMatchObject({ statusCode: 409 });
  });

  it("uses Host-reported CLIs directly and reuses or creates the Agent profile in the same initialization", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(
      `UPDATE hosts
          SET last_heartbeat_at = now(),
              capabilities_json = $2::jsonb
        WHERE id = $1`,
      [OTHER_HOST, JSON.stringify({
        runtimes: ["claude", "codex"],
        versions: {},
        installations: {
          claude_code: [{ id: "own", version: "1.0.0", logged_in: true, options: null }],
          codex_cli: [{ id: "own", version: "2.0.0", logged_in: true, options: null }],
        },
      })],
    );
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status,
         kind, protected, system_managed, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'remote repo', 'active', 'code', false, false, now(), now())`,
      [REMOTE_FOLDER, SPACE, PROJECT, OWNER],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, display_path, execution_ready, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'remote', NULL, '/home/user/repo', true, 'active', now(), now())`,
      [REMOTE_LOCATION, SPACE, REMOTE_FOLDER, OTHER_HOST],
    );
    const existing = randomUUID();
    await db.pool.query(
      `UPDATE agent_runtime_profiles SET is_default = false WHERE space_id = $1 AND agent_id = $2`,
      [SPACE, AGENT],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id, space_id, agent_id, name, adapter_type, execution_host_id,
         workspace_location_id, workspace_mode, runtime_installation,
         runtime_config_json, runtime_policy_json, enabled, is_default, created_at, updated_at
       ) VALUES ($1, $2, $3, 'Project setting', 'claude_code', $4,
         $5, 'location', 'own', '{}', '{}', true, true, now(), now())`,
      [existing, SPACE, AGENT, OTHER_HOST, REMOTE_LOCATION],
    );

    const service = new ConversationExecutionContextService(db.pool);
    const preflight = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(preflight.summary).toMatchObject({
      host: { host_id: OTHER_HOST },
      primary: { kind: "location", workspace_location_id: REMOTE_LOCATION },
      runtime: { runtime_profile_id: existing, adapter_type: "claude_code", runtime_installation: "own" },
    });
    expect(preflight.available_runtime_profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent_id: AGENT,
        runtime_profile_id: existing,
        execution_host_id: OTHER_HOST,
        workspace_location_id: REMOTE_LOCATION,
        adapter_type: "claude_code",
        runtime_installation: "own",
        usable: true,
      }),
      expect.objectContaining({
        agent_id: AGENT,
        runtime_profile_id: null,
        execution_host_id: OTHER_HOST,
        workspace_location_id: REMOTE_LOCATION,
        adapter_type: "codex_cli",
        runtime_installation: "own",
        usable: true,
      }),
    ]));

    const initialized = await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: OTHER_HOST, primary: { kind: "location", workspace_location_id: REMOTE_LOCATION } },
        runtime: {
          agent_id: AGENT,
          runtime_profile_id: null,
          credential_profile_id: null,
          adapter_type: "codex_cli",
          runtime_installation: "own",
        },
      },
    );
    expect(initialized).toMatchObject({
      state: "initialized",
      host: { host_id: OTHER_HOST },
      primary: { kind: "location", workspace_location_id: REMOTE_LOCATION },
      runtime: { agent_id: AGENT, adapter_type: "codex_cli", runtime_installation: "own" },
    });
    const profiles = await db.pool.query<{ id: string }>(
      `SELECT id FROM agent_runtime_profiles
        WHERE space_id = $1 AND agent_id = $2 AND execution_host_id = $3
          AND workspace_location_id = $4 AND adapter_type = 'codex_cli'
          AND runtime_installation = 'own'`,
      [SPACE, AGENT, OTHER_HOST, REMOTE_LOCATION],
    );
    expect(profiles.rows).toHaveLength(1);
    expect(initialized.runtime?.runtime_profile_id).toBe(profiles.rows[0]!.id);
  });

  it("routes with the initialization-time runtime configuration snapshot after profile edits", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET model_name = 'initial-model',
              runtime_config_json = '{"effort":"medium","supports_live":true}',
              runtime_policy_json = '{"network":"deny"}'
        WHERE id = $1`,
      [RUNTIME],
    );
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "managed" } },
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, credential_profile_id: null, adapter_type: "claude_code", runtime_installation: "own" },
      },
    );
    const thread = await db.pool.query<{ id: string }>(
      `SELECT id FROM host_threads
        WHERE space_id = $1 AND session_id = $2 AND agent_id = $3
          AND container_kind = 'conversation'`,
      [SPACE, SESSION, AGENT],
    );
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET model_name = 'changed-model',
              runtime_config_json = '{"effort":"high","supports_live":false}',
              runtime_policy_json = '{"network":"allow"}'
        WHERE id = $1`,
      [RUNTIME],
    );
    const runs = new PgRunRepository(db.pool);
    const queued = await runs.createQueuedRun({
      agent_id: AGENT,
      space_id: SPACE,
      user_id: OWNER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      session_id: SESSION,
      project_id: PROJECT,
      prompt: "Use the pinned configuration.",
      runtime_profile_id: RUNTIME,
      runtime_profile_selection_source: "explicit",
      allow_system_assistant: true,
      model_override_json: {
        conversation_backend: { credential_profile_id: null },
        host_thread: { schema_version: "host_thread.v1", thread_id: thread.rows[0]!.id },
      },
    });
    const routed = await new PgRouteDecisionRepository(db.pool).routeRun(queued);
    expect(routed.model_override_json).toMatchObject({ model: "initial-model" });
    expect(routed.runtime_profile_snapshot_json).toMatchObject({
      model_name: "initial-model",
      runtime_config_json: { effort: "medium", supports_live: true },
      runtime_policy_json: { network: "deny" },
    });
  });

  it("allows an explicit managed Primary when several Folders are executable", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status,
         kind, protected, system_managed, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'docs', 'active', 'code', false, false, now(), now())`,
      [ATTACHED_FOLDER, SPACE, PROJECT, OWNER],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'server', '/workspace/docs', true, 'active', now(), now())`,
      [ATTACHED_LOCATION, SPACE, ATTACHED_FOLDER, HOST],
    );
    const service = new ConversationExecutionContextService(db.pool);
    const preflight = await service.preflight(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      { selection: { execution_host_id: HOST, primary: { kind: "managed" } }, runtime: null },
    );
    expect(preflight.summary).toMatchObject({ can_send: true, primary: { kind: "managed" }, host: { host_id: HOST } });
  });

  it("keeps server-host attachments read-only instead of binding a real checkout writable", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status,
         kind, protected, system_managed, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'docs', 'active', 'code', false, false, now(), now())`,
      [ATTACHED_FOLDER, SPACE, PROJECT, OWNER],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'server', '/workspace/docs', true, 'active', now(), now())`,
      [ATTACHED_LOCATION, SPACE, ATTACHED_FOLDER, HOST],
    );
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "managed" } },
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, credential_profile_id: null, adapter_type: "claude_code", runtime_installation: "own" },
      },
    );

    await expect(service.mutateAttachment(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        action: "attach",
        mutation_id: randomUUID(),
        project_folder_id: ATTACHED_FOLDER,
        workspace_location_id: ATTACHED_LOCATION,
        access_mode: "write",
      },
    )).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.mutateAttachment(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        action: "attach",
        mutation_id: randomUUID(),
        project_folder_id: ATTACHED_FOLDER,
        workspace_location_id: ATTACHED_LOCATION,
        access_mode: "read",
      },
    )).resolves.toMatchObject({ attachment: { access_mode: "read" } });
  });

  it("requires the canonical Room grant before exposing a private Agent runtime", async (ctx) => {
    if (!db.available) return ctx.skip();
    const now = new Date().toISOString();
    const room = await db.pool.query<{ id: string }>(
      `SELECT room_id AS id FROM sessions WHERE id = $1`,
      [SESSION],
    );
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
       VALUES ($1, 'viewer@example.test', 'Viewer', 'active', $2, $2)`,
      [VIEWER, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
      [randomUUID(), SPACE, VIEWER, now],
    );
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'viewer', 'active', $5, $5)`,
      [randomUUID(), SPACE, PROJECT, VIEWER, now],
    );
    await db.pool.query(
      `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', $5, $5)`,
      [randomUUID(), SPACE, room.rows[0]!.id, VIEWER, now],
    );
    await db.pool.query(`UPDATE agents SET visibility = 'private' WHERE id = $1`, [AGENT]);
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "managed" } },
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, credential_profile_id: null, adapter_type: "claude_code", runtime_installation: "own" },
      },
    );

    const hidden = await service.preflight({ spaceId: SPACE, userId: VIEWER }, SESSION);
    expect(hidden.available_runtime_profiles).toEqual([]);
    expect(hidden.summary.runtime).toBeNull();
    expect(hidden.summary.runtimes).toEqual([]);
    await db.pool.query(
      `INSERT INTO room_agent_access_grants (
         id, space_id, room_id, agent_id, grantee_user_id, granted_by_user_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), SPACE, room.rows[0]!.id, AGENT, VIEWER, OWNER, now],
    );
    const granted = await service.preflight({ spaceId: SPACE, userId: VIEWER }, SESSION);
    expect(granted.available_runtime_profiles).toEqual([
      expect.objectContaining({ runtime_profile_id: RUNTIME, agent_id: AGENT }),
    ]);
    expect(granted.summary.runtime).toEqual(expect.objectContaining({
      runtime_profile_id: RUNTIME,
      agent_id: AGENT,
    }));
    expect(granted.summary.runtimes).toEqual([
      expect.objectContaining({ runtime_profile_id: RUNTIME, agent_id: AGENT }),
    ]);
    await db.pool.query(
      `UPDATE room_agent_access_grants SET revoked_at = now(), revoked_by_user_id = $1
        WHERE room_id = $2 AND agent_id = $3 AND grantee_user_id = $4`,
      [OWNER, room.rows[0]!.id, AGENT, VIEWER],
    );
    const revoked = await service.preflight({ spaceId: SPACE, userId: VIEWER }, SESSION);
    expect(revoked.available_runtime_profiles).toEqual([]);
    expect(revoked.summary.runtime).toBeNull();
    expect(revoked.summary.runtimes).toEqual([]);
  });

  it("enforces one backend pin per Conversation and Agent independent of initializer", async (ctx) => {
    if (!db.available) return ctx.skip();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
       VALUES ($1, 'viewer@example.test', 'Viewer', 'active', $2, $2)`,
      [VIEWER, now],
    );
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "managed" } },
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, credential_profile_id: null, adapter_type: "claude_code", runtime_installation: "own" },
      },
    );
    await expect(db.pool.query(
      `INSERT INTO session_conversation_backends (
         id, space_id, session_id, bound_by_user_id, agent_id, runtime_profile_id,
         runtime_state_key, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [randomUUID(), SPACE, SESSION, VIEWER, AGENT, RUNTIME, randomUUID(), now],
    )).rejects.toMatchObject({ code: "23505" });
    const constraints = await db.pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname IN (
          'session_conversation_backends_bound_by_user_id_fkey',
          'session_conversation_backends_credential_owner_fkey'
        )
        ORDER BY conname ASC`,
    );
    expect(constraints.rows).toEqual([
      { conname: "session_conversation_backends_bound_by_user_id_fkey", confdeltype: "a" },
      { conname: "session_conversation_backends_credential_owner_fkey", confdeltype: "a" },
    ]);
  });

  it("keeps an initialized Conversation on its stale pinned Location after explicit activation", async (ctx) => {
    if (!db.available) return ctx.skip();
    const replacementLocation = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeeb";
    const draftSession = "33333333-3333-4333-8333-333333333334";
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET workspace_mode = 'location', workspace_location_id = $1
        WHERE id = $2`,
      [LOCATION, RUNTIME],
    );
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "location", workspace_location_id: LOCATION } },
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, credential_profile_id: null, adapter_type: "claude_code", runtime_installation: "own" },
      },
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'server', '/workspace/replacement', true, 'stale', now(), now())`,
      [replacementLocation, SPACE, FOLDER, HOST],
    );
    const folders = new PgProjectFolderRepository(
      db.pool,
      loadConfig({ WORKSPACE_ROOT: "/tmp/rainver-conversation-context-test", SERVER_DATABASE_URL: db.connectionUri }),
    );
    await folders.activateLocation({ spaceId: SPACE, userId: OWNER }, PROJECT, FOLDER, replacementLocation);

    const preflight = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(preflight.summary).toMatchObject({
      state: "initialized",
      can_send: true,
      primary: { kind: "location", workspace_location_id: LOCATION },
    });
    expect(preflight.available_primary_locations).toEqual([
      expect.objectContaining({ workspace_location_id: replacementLocation }),
    ]);
    const locations = new PgWorkspaceLocationRepository(db.pool);
    await expect(locations.resolveDispatchTarget(LOCATION)).resolves.toBeNull();
    await expect(locations.resolveDispatchTarget(LOCATION, { allowStale: true })).resolves.toMatchObject({
      location_id: LOCATION,
      execution_ready: true,
    });
    await db.pool.query(
      `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at)
       SELECT $1, space_id, project_id, room_id, 'active', now(), now()
         FROM sessions WHERE id = $2`,
      [draftSession, SESSION],
    );
    const draft = await service.preflight({ spaceId: SPACE, userId: OWNER }, draftSession);
    expect(draft.available_primary_locations).toEqual([
      expect.objectContaining({ workspace_location_id: replacementLocation }),
    ]);
    expect(draft.available_runtime_profiles).toEqual([
      expect.objectContaining({ runtime_profile_id: RUNTIME, usable: false }),
    ]);
    expect(draft.summary).toMatchObject({ state: "draft", can_send: false });
  });

  it("derives the Host from the sole usable runtime when several Hosts are online", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(`UPDATE workspace_locations SET execution_ready = false WHERE id = $1`, [LOCATION]);
    const service = new ConversationExecutionContextService(db.pool);
    const preflight = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(preflight.summary).toMatchObject({
      can_send: true,
      host: { host_id: HOST },
      primary: { kind: "managed" },
      runtime: { runtime_profile_id: RUNTIME },
    });
  });

  it("replays attachment mutations by client mutation id without duplicate events", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status,
         kind, protected, system_managed, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'docs', 'active', 'code', false, false, now(), now())`,
      [ATTACHED_FOLDER, SPACE, PROJECT, OWNER],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, execution_ready, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'server', '/workspace/docs', true, 'active', now(), now())`,
      [ATTACHED_LOCATION, SPACE, ATTACHED_FOLDER, HOST],
    );
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "managed" } },
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, credential_profile_id: null, adapter_type: "claude_code", runtime_installation: "own" },
      },
    );
    const mutation = { action: "attach" as const, mutation_id: randomUUID(), project_folder_id: ATTACHED_FOLDER, workspace_location_id: ATTACHED_LOCATION, access_mode: "read" as const };
    const first = await service.mutateAttachment({ spaceId: SPACE, userId: OWNER }, SESSION, mutation);
    const replay = await service.mutateAttachment({ spaceId: SPACE, userId: OWNER }, SESSION, mutation);
    expect(replay).toEqual(first);
    const events = await db.pool.query<{ count: string }>(
      `SELECT count(*) FROM messages WHERE session_id = $1 AND metadata_json->>'execution_event_key' = $2`,
      [SESSION, `execution_attachment:${mutation.mutation_id}`],
    );
    expect(events.rows[0]!.count).toBe("1");
  });
});
