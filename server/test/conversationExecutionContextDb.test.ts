// Test-only cross-package contract probe: runtimeChoice is a browser-safe pure
// four-field DTO projection (no React, browser globals, API or server imports).
// Production server dependencies and runtime ownership remain unchanged.
import { runtimeChoice } from '../../apps/web/src/modules/conversation/runtimeChoice.js';
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedServerHost, seedSpaceOwnerProject, seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { ConversationExecutionContextService } from "../src/modules/sessions/executionContextService.js";
import { PgProjectFolderRepository } from "../src/modules/projectFolders/repository.js";
import { PgWorkspaceLocationRepository } from "../src/modules/projectFolders/workspaceLocations.js";
import { loadConfig } from "../src/config.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { seedAgentWithVersion, seedRoomManager, seedRun } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { agentsModule } from "../src/modules/agents/index.js";
import { sessionsModule } from "../src/modules/sessions/index.js";
import { __setSessionIdentityForTests } from "../src/modules/sessions/routes.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { PgProjectAgentRepository } from "../src/modules/projects/projectAgents.js";
import { prepareHostConversationDispatch } from "../src/modules/agentGroups/service.js";
import { PgConversationBackendRepository } from "../src/modules/sessions/conversationBackendRepository.js";

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
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, seedDefaultRuntimeProfile: false, now });
  // The ACP adapter's effective trust is intentionally low until host-side
  // subagent restrictions are enforced; this is a low-risk conversation test.
  await db.pool.query(`UPDATE agent_versions SET risk_level = 'low' WHERE id = $1`, [VERSION]);
  await db.pool.query(
    `UPDATE agents
        SET project_id = $1, agent_kind = 'system_assistant'
      WHERE id = $2`,
    [PROJECT, AGENT],
  );
  await seedRoomManager(db.pool, { space: SPACE, room: room.rows[0]!.id, agent: AGENT, now });
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       name,
       runtime_key,
       backend_mode,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, 'Host CLI', 'claude_code', 'runtime_native', $4, 'managed', 'managed:1.0.0', '{}', '{}', true, true, $5, $5)`,
    [RUNTIME, SPACE, AGENT, HOST, now],
  );
  await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"execution_workspaces":{"version":2}}'::jsonb`);
});

afterEach(() => {
  __setSessionIdentityForTests(null);
});

describe("Conversation execution schema", () => {
  it.for(["unverified","ambiguous","removed","revoked","pending"])("does not move managed bindings on a %s Host report", async (state,ctx) => {
    if (!db.available) return ctx.skip();
    if(state==="revoked")await db.pool.query(`UPDATE hosts SET status='revoked' WHERE id=$1`,[HOST]);
    const next={id:state==="pending"?"managed:pending":"managed:2.0.0",version:state==="pending"?"pending":"2.0.0",health_check_protocol:state==="unverified"?null:"acp",logged_in:true};
    const copies=state==="removed"?[]:state==="ambiguous"?[next,{...next,id:"managed:3.0.0",version:"3.0.0"}]:[next];
    await new PgHostRepository(db.pool).recordHeartbeat(HOST,{capabilities_json:{installations:{claude_code:copies}}});
    expect((await db.pool.query(`SELECT runtime_installation FROM agent_runtime_profiles WHERE id=$1`,[RUNTIME])).rows[0].runtime_installation).toBe("managed:1.0.0");
    if(state==="revoked")expect((await db.pool.query(`SELECT status FROM hosts WHERE id=$1`,[HOST])).rows[0].status).toBe("revoked");
  });
  it("continues an initialized Conversation after managed upgrade and rollback, preserving native identity and historical Runs", async ctx => {
    if (!db.available) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const report = async (version:string) => hosts.recordHeartbeat(HOST,{capabilities_json:{installations:{claude_code:[{
      id:`managed:${version}`,version,health_check_protocol:"acp",logged_in:true,
      options:{session_available:true,config_options:[{id:"model",name:"Model",category:"model",type:"select",current_value:version,options:[{value:version,name:version}]}]},
    }]}}});
    await report("1.0.0");
    const ownProfile=randomUUID(),otherHostProfile=randomUUID();
    for(const [id,name,host,installation] of [[ownProfile,"Local CLI",HOST,"own"],[otherHostProfile,"Other Host CLI",OTHER_HOST,"managed:1.0.0"]]){
      await db.pool.query(`INSERT INTO agent_runtime_profiles (id,space_id,agent_id,name,runtime_key,backend_mode,execution_host_id,workspace_mode,runtime_installation,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'claude_code','runtime_native',$5,'managed',$6,'{}','{}',true,false,now(),now())`,[id,SPACE,AGENT,name,host,installation]);
    }
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize({spaceId:SPACE,userId:OWNER},SESSION,{
      selection:{execution_host_id:HOST,primary:{kind:"managed"}},
      runtime:{agent_id:AGENT,runtime_profile_id:RUNTIME,runtime_key:"claude_code",runtime_installation:"managed:1.0.0"},
    });
    const thread=(await db.pool.query<{id:string}>(`SELECT id FROM host_threads WHERE session_id=$1 AND agent_id=$2`,[SESSION,AGENT])).rows[0]!;
    await db.pool.query(`UPDATE host_threads SET vendor_session_id='retained-native-session' WHERE id=$1`,[thread.id]);
    const closedThread=randomUUID();
    await db.pool.query(`INSERT INTO host_threads (id,space_id,execution_host_id,workspace_mode,session_id,agent_id,container_kind,runtime_key,runtime_installation,status,created_by_user_id,created_at,updated_at)
      VALUES ($1,$2,$3,'managed',$4,$5,'conversation','claude_code','managed:1.0.0','closed',$6,now(),now())`,[closedThread,SPACE,HOST,SESSION,AGENT,OWNER]);
    const binding=async()=>(await db.pool.query(`SELECT * FROM session_conversation_backends WHERE session_id=$1`,[SESSION])).rows[0];
    const originalBinding=await binding();
    const route=async()=>new PgRouteDecisionRepository(db.pool).routeRun(await new PgRunRepository(db.pool).createQueuedRun({
      execution_kind:"agent",space_id:SPACE,agent_id:AGENT,run_type:"agent",mode:"live",
      trigger_origin:"manual",user_id:OWNER,session_id:SESSION,project_id:PROJECT,prompt:"Continue this Conversation.",
      runtime_profile_id:RUNTIME,runtime_profile_selection_source:"explicit",allow_system_assistant:true,
      model_override_json:{host_thread:{schema_version:"host_thread.v1",thread_id:thread.id}},
    }));
    const first=await route();
    expect(first.runtime_profile_snapshot_json).toMatchObject({runtime_installation:"managed:1.0.0"});
    for(const version of ["2.0.0","1.0.0"]){
      await report(version);
      expect((await service.preflight({spaceId:SPACE,userId:OWNER},SESSION)).summary.can_send).toBe(true);
      const options=await new PgConversationBackendRepository(db.pool).listOptions(SPACE,OWNER,AGENT);
      expect(options.find(option=>option.runtime_profile_id===RUNTIME)).toMatchObject({usable:true,session_config_options:[expect.objectContaining({id:"model",current_value:version})]});
      expect((await db.pool.query(`SELECT id,runtime_installation,vendor_session_id FROM host_threads WHERE id=$1`,[thread.id])).rows[0])
        .toMatchObject({id:thread.id,runtime_installation:`managed:${version}`,vendor_session_id:"retained-native-session"});
      expect((await route()).runtime_profile_snapshot_json).toMatchObject({runtime_installation:`managed:${version}`,runtime_config_json:{runtime_installation:`managed:${version}`}});
      expect(await binding()).toEqual(originalBinding);
      expect((await db.pool.query(`SELECT runtime_installation FROM agent_runtime_profiles WHERE id=$1`,[ownProfile])).rows[0].runtime_installation).toBe("own");
      expect((await db.pool.query(`SELECT runtime_installation FROM agent_runtime_profiles WHERE id=$1`,[otherHostProfile])).rows[0].runtime_installation).toBe("managed:1.0.0");
      expect((await db.pool.query(`SELECT runtime_installation FROM host_threads WHERE id=$1`,[closedThread])).rows[0].runtime_installation).toBe("managed:1.0.0");
    }
    expect((await db.pool.query(`SELECT runtime_profile_snapshot_json FROM runs WHERE id=$1`,[first.id])).rows[0].runtime_profile_snapshot_json)
      .toMatchObject({runtime_installation:"managed:1.0.0"});
  });
  it("blocks setup, as preflight promises, for a participant Agent the initializer cannot access", async (ctx) => {
    if (!db.available) return ctx.skip();
    const now = new Date().toISOString();
    const room = await db.pool.query<{ id: string }>(`SELECT room_id AS id FROM sessions WHERE id = $1`, [SESSION]);
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source)
       VALUES ($1, 'viewer@example.test', 'Viewer', 'active', $2, $2, 'system')`,
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
    // A second, shared participant the viewer selects explicitly; the Room's
    // manager Agent is private to the owner and has exactly one usable runtime.
    const sharedAgent = "44444444-4444-4444-8444-444444444445";
    const sharedVersion = "55555555-5555-4555-8555-555555555556";
    const sharedRuntime = "66666666-6666-4666-8666-666666666667";
    await seedAgentWithVersion(db.pool, { agent: sharedAgent, version: sharedVersion, space: SPACE, owner: OWNER, seedDefaultRuntimeProfile: false, now, name: "Shared Agent" });
    await db.pool.query(`UPDATE agent_versions SET risk_level = 'low' WHERE id = $1`, [sharedVersion]);
    await db.pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', $5, $5)`,
      [randomUUID(), SPACE, room.rows[0]!.id, sharedAgent, now],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id, space_id, agent_id, name, runtime_key, backend_mode, execution_host_id, workspace_mode,
         runtime_installation, runtime_config_json, runtime_policy_json, enabled, is_default, created_at, updated_at
       ) VALUES ($1, $2, $3, 'Host CLI', 'claude_code', 'runtime_native', $4, 'managed', 'managed:1.0.0', '{}', '{}', true, true, $5, $5)`,
      [sharedRuntime, SPACE, sharedAgent, HOST, now],
    );
    await db.pool.query(`UPDATE agents SET visibility = 'private' WHERE id = $1`, [AGENT]);

    const service = new ConversationExecutionContextService(db.pool);
    const request = {
      selection: { execution_host_id: HOST, primary: { kind: "managed" as const } },
      runtime: { agent_id: sharedAgent, runtime_profile_id: sharedRuntime, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
    };
    await expect(service.initialize({ spaceId: SPACE, userId: VIEWER }, SESSION, request))
      .rejects.toMatchObject({ statusCode: 403 });
    const bindings = await db.pool.query(`SELECT 1 FROM session_conversation_backends WHERE session_id = $1`, [SESSION]);
    expect(bindings.rowCount).toBe(0);

    // The owner, who can access every participant, sets it up as before.
    await service.initialize({ spaceId: SPACE, userId: OWNER }, SESSION, request);
    const bound = await db.pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM session_conversation_backends WHERE session_id = $1 ORDER BY agent_id`, [SESSION],
    );
    expect(bound.rows.map((row) => row.agent_id)).toEqual([AGENT, sharedAgent]);
  });

  it("previews without writing and initializes through the core command adapter", async (ctx) => {
    if (!db.available) return ctx.skip();
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [sessionsModule]);
    const contexts = async () => (await db.pool.query(`SELECT state FROM conversation_execution_contexts WHERE session_id = $1`, [SESSION])).rows;
    const request = {
      selection: { execution_host_id: HOST, primary: { kind: "managed" as const } },
      runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
    };
    try {
      __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
      const preview = await app.inject({ method: "POST", url: `/api/v1/sessions/${SESSION}/execution-context/preflight`, payload: request });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().data.summary).toMatchObject({ session_id: SESSION, state: "draft" });
      // Previewing (and the GET it backs) writes nothing.
      expect((await app.inject({ method: "GET", url: `/api/v1/sessions/${SESSION}/execution-context` })).statusCode).toBe(200);
      expect(await contexts()).toEqual([]);
      __setAuthIdentityForTests({ spaceId: SPACE, userId: VIEWER });
      const refused = await app.inject({ method: "POST", url: `/api/v1/sessions/${SESSION}/execution-context/initialize`, payload: request, headers: { "idempotency-key": randomUUID() } });
      expect(refused.statusCode).toBe(404);
      __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
      const key = randomUUID();
      const initialized = await app.inject({ method: "POST", url: `/api/v1/sessions/${SESSION}/execution-context/initialize`, payload: request, headers: { "idempotency-key": key } });
      expect(initialized.statusCode, initialized.body).toBe(200);
      expect(initialized.json().data).toEqual({ id: SESSION, space_id: SPACE, session_id: SESSION });
      expect((await app.inject({ method: "POST", url: `/api/v1/sessions/${SESSION}/execution-context/initialize`, payload: request, headers: { "idempotency-key": key } })).json()).toEqual(initialized.json());
      expect(await contexts()).toEqual([{ state: "initialized" }]);
    } finally {
      __setAuthIdentityForTests(null);
      await app.close();
    }
  });

  it("closes a direct thread and its workspace only with the person's last direct session of the Agent", async (ctx) => {
    if (!db.available) return ctx.skip();
    const now = new Date().toISOString();
    const first = "33333333-3333-4333-8333-333333333334";
    const second = "33333333-3333-4333-8333-333333333335";
    // A Project direct session has its own Conversation container: it neither keeps this one alive nor closes it.
    const placed = "33333333-3333-4333-8333-333333333336";
    for (const [id, projectId] of [[first, null], [second, null], [placed, PROJECT]] as const) {
      await db.pool.query(
        `INSERT INTO sessions (id, space_id, user_id, project_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
        [id, SPACE, OWNER, projectId, now],
      );
      await db.pool.query(
        `INSERT INTO session_conversation_backends (
           id, space_id, session_id, bound_by_user_id, agent_id, runtime_profile_id,
           runtime_key_snapshot, backend_mode_snapshot, runtime_config_snapshot_json, runtime_policy_snapshot_json,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'claude_code', 'runtime_native', '{}', '{}', $7, $7)`,
        [randomUUID(), SPACE, id, OWNER, AGENT, RUNTIME, now],
      );
    }
    const threads = new PgHostThreadRepository(db.pool);
    const thread = await threads.getOrCreateForDirect({
      executionHostId: HOST, workspaceMode: "managed", userId: OWNER, agentId: AGENT, runtimeKey: "claude_code", createdByUserId: OWNER,
    });
    const threadStatus = async () => (await db.pool.query<{ status: string }>(
      `SELECT status FROM host_threads WHERE id = $1`, [thread.id],
    )).rows[0]?.status;

    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test" }), [sessionsModule]);
    const pending = async () => (await db.pool.query<{ pending: boolean }>(`SELECT pending_archive_at IS NOT NULL AS pending FROM host_threads WHERE id = $1`, [thread.id])).rows[0]?.pending;
    try {
      // The older chat goes; the one still in use keeps its CLI continuity.
      const deleted = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${first}`, headers: { "idempotency-key": randomUUID() } });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json().data).toMatchObject({ session_id: first });
      expect(await threadStatus()).toBe("active");
      const project = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${placed}`, headers: { "idempotency-key": randomUUID() } });
      expect(project.statusCode, project.body).toBe(200);
      expect(await threadStatus()).toBe("active");

      const last = await app.inject({ method: "DELETE", url: `/api/v1/sessions/${second}`, headers: { "idempotency-key": randomUUID() } });
      expect(last.statusCode, last.body).toBe(200);
      // The archive intent committed with the deletion; the Host (offline here) archives it on reconnect.
      expect(await pending()).toBe(true);
      expect(await threadStatus()).toBe("closed");
    } finally {
      __setAuthIdentityForTests(null);
      await app.close();
    }
  });


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

  it("initializes once, restores its pin after restart, and still refuses an unrelated Host change", async (ctx) => {
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
          runtime_key: "claude_code",
          runtime_installation: "managed:1.0.0",
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
    await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_key = 'codex_cli' WHERE id = $1`, [RUNTIME]);
    await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"installations":{"codex_cli":[{"id":"managed:1.0.0","logged_in":true}]}}'::jsonb WHERE id=$1`,[HOST]);
    const preflight = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(preflight.summary).toMatchObject({
      state: "initialized",
      runtime: { agent_id: AGENT, runtime_key: "codex_cli", runtime_installation: "managed:1.0.0" },
      can_send: true,
      blocked_reason: null,
    });
    await expect(service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: OTHER_HOST, primary: { kind: "managed" } },
        runtime: {
          agent_id: AGENT,
          runtime_profile_id: RUNTIME,
          runtime_key: "codex_cli",
          runtime_installation: "own",
        },
      },
    )).rejects.toMatchObject({ statusCode: 409 });
  });

  it.for(['installation','cli'] as const)('continues an existing Conversation after changing its %s, without resuming the old CLI session',async(kind,ctx)=>{
    if(!db.available)return ctx.skip();
    const service=new ConversationExecutionContextService(db.pool),identity={spaceId:SPACE,userId:OWNER};
    await service.initialize(identity,SESSION,{selection:{execution_host_id:HOST,primary:{kind:'managed'}},runtime:{agent_id:AGENT,runtime_profile_id:RUNTIME,runtime_key:'claude_code',runtime_installation:'managed:1.0.0'}});
    const threads=new PgHostThreadRepository(db.pool),old=await threads.getForConversationAgent(SPACE,SESSION,AGENT);
    const historyId=randomUUID();await seedRun(db.pool,{id:historyId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
    await db.pool.query("UPDATE runs SET status='succeeded',host_task_thread_id=$2,runtime_key='claude_code',runtime_profile_snapshot_json=$3::jsonb WHERE id=$1",[historyId,old!.id,JSON.stringify({runtime_installation:'managed:1.0.0'})]);
    const history=(await db.pool.query('SELECT to_jsonb(r) AS value FROM runs r WHERE id=$1',[historyId])).rows[0].value;
    await db.pool.query("UPDATE host_threads SET vendor_session_id='old-native-session',context_tokens=120,context_window_tokens=1000,execution_workspace_json=$2::jsonb WHERE id=$1",[old!.id,JSON.stringify({id:'preserved-workspace',generation:3})]);
    const context=(await db.pool.query('SELECT to_jsonb(c) AS value FROM conversation_execution_contexts c WHERE session_id=$1',[SESSION])).rows[0].value;
    const runtime=kind==='cli'?'codex_cli':'claude_code';
    await db.pool.query("UPDATE hosts SET capabilities_json=capabilities_json||$2::jsonb WHERE id=$1",[HOST,JSON.stringify({installations:{[runtime]:[{id:'own',logged_in:true}]}})]);
    await db.pool.query("UPDATE agent_runtime_profiles SET runtime_key=$2,runtime_installation='own' WHERE id=$1",[RUNTIME,runtime]);
    const preflight=await service.preflight(identity,SESSION);
    expect(preflight.summary).toMatchObject({can_send:true,blocked_reason:null,runtime:{runtime_key:runtime,runtime_installation:'own'}});
    expect(preflight.summary.runtimes[0]).toMatchObject({runtime_key:runtime,runtime_installation:'own',context_tokens:null});
    expect((await threads.getForConversationAgent(SPACE,SESSION,AGENT))?.id).toBe(old!.id);
    const input={space_id:SPACE,user_id:OWNER,session_id:SESSION,agent_id:AGENT};
    const backend=await new PgConversationBackendRepository(db.pool).resolveBinding(input);
    expect(backend).toMatchObject({runtime_key:runtime,runtime_installation:'own'});
    const next=await threads.getForConversationAgent(SPACE,SESSION,AGENT);
    expect(next!.id).not.toBe(old!.id);expect(next).toMatchObject({runtime_key:runtime,runtime_installation:'own',vendor_session_id:null});
    expect((await db.pool.query('SELECT status,vendor_session_id FROM host_threads WHERE id=$1',[old!.id])).rows[0]).toEqual({status:'closed',vendor_session_id:'old-native-session'});
    expect((await db.pool.query('SELECT execution_workspace_json FROM host_threads WHERE id=$1',[next!.id])).rows[0].execution_workspace_json).toEqual({id:'preserved-workspace',generation:3});
    expect((await db.pool.query('SELECT to_jsonb(c) AS value FROM conversation_execution_contexts c WHERE session_id=$1',[SESSION])).rows[0].value).toEqual(context);
    expect((await db.pool.query('SELECT to_jsonb(r) AS value FROM runs r WHERE id=$1',[historyId])).rows[0].value).toEqual(history);
    expect(await threads.recordRunOutcome(old!.id,{lastRunId:historyId,vendorSessionId:'late-session',sessionReset:false})).toBe(false);
    expect((await threads.getForConversationAgent(SPACE,SESSION,AGENT))?.vendor_session_id).toBeNull();
    await new PgConversationBackendRepository(db.pool).resolveBinding(input);
    expect((await threads.getForConversationAgent(SPACE,SESSION,AGENT))?.id).toBe(next!.id);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM messages WHERE session_id=$1 AND metadata_json->>'execution_event'='execution_agent_runtime_changed'",[SESSION])).rows[0].n).toBe(1);
  });

  it('defers a runtime switch while the old thread is held and adopts it after the claim is released',async ctx=>{
    if(!db.available)return ctx.skip();
    const identity={spaceId:SPACE,userId:OWNER},service=new ConversationExecutionContextService(db.pool);
    await service.initialize(identity,SESSION,{selection:{execution_host_id:HOST,primary:{kind:'managed'}},runtime:{agent_id:AGENT,runtime_profile_id:RUNTIME,runtime_key:'claude_code',runtime_installation:'managed:1.0.0'}});
    const threads=new PgHostThreadRepository(db.pool),old=await threads.getForConversationAgent(SPACE,SESSION,AGENT);
    const activeId=randomUUID();await seedRun(db.pool,{id:activeId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
    await db.pool.query("UPDATE runs SET status='running',host_task_thread_id=$2 WHERE id=$1",[activeId,old!.id]);
    await db.pool.query('UPDATE host_threads SET dispatch_lock_id=$2 WHERE id=$1',[old!.id,randomUUID()]);
    await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json||'{"installations":{"claude_code":[{"id":"own","logged_in":true}]}}'::jsonb WHERE id=$1`,[HOST]);
    await db.pool.query("UPDATE agent_runtime_profiles SET runtime_installation='own' WHERE id=$1",[RUNTIME]);
    const input={space_id:SPACE,user_id:OWNER,session_id:SESSION,agent_id:AGENT};
    await expect(new PgConversationBackendRepository(db.pool).resolveBinding(input)).rejects.toMatchObject({statusCode:409});
    expect((await threads.getForConversationAgent(SPACE,SESSION,AGENT))?.runtime_installation).toBe('managed:1.0.0');
    await db.pool.query('UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1',[old!.id]);
    await expect(new PgConversationBackendRepository(db.pool).resolveBinding(input)).rejects.toMatchObject({statusCode:409});
    await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[activeId]);
    expect(await new PgConversationBackendRepository(db.pool).resolveBinding(input)).toMatchObject({runtime_installation:'own'});
  });

  it('requires the selected new installation to be available, then permits explicit reinitialization of the same workspace',async ctx=>{
    if(!db.available)return ctx.skip();
    const identity={spaceId:SPACE,userId:OWNER},service=new ConversationExecutionContextService(db.pool);
    const selection={execution_host_id:HOST,primary:{kind:'managed' as const}};
    await service.initialize(identity,SESSION,{selection,runtime:{agent_id:AGENT,runtime_profile_id:RUNTIME,runtime_key:'claude_code',runtime_installation:'managed:1.0.0'}});
    const threads=new PgHostThreadRepository(db.pool),old=await threads.getForConversationAgent(SPACE,SESSION,AGENT);
    await db.pool.query("UPDATE agent_runtime_profiles SET runtime_installation='own' WHERE id=$1",[RUNTIME]);
    expect((await service.preflight(identity,SESSION)).summary).toMatchObject({can_send:false,runtime:{runtime_installation:'own'}});
    await expect(new PgConversationBackendRepository(db.pool).resolveBinding({space_id:SPACE,user_id:OWNER,session_id:SESSION,agent_id:AGENT})).rejects.toMatchObject({statusCode:409});
    expect((await threads.getForConversationAgent(SPACE,SESSION,AGENT))?.id).toBe(old!.id);
    await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json||'{"installations":{"claude_code":[{"id":"own","logged_in":true}]}}'::jsonb WHERE id=$1`,[HOST]);
    expect(await service.initialize(identity,SESSION,{selection,runtime:{agent_id:AGENT,runtime_profile_id:RUNTIME,runtime_key:'claude_code',runtime_installation:'own'}})).toMatchObject({state:'initialized',runtime:{runtime_installation:'own'}});
    expect((await threads.getForConversationAgent(SPACE,SESSION,AGENT))?.id).not.toBe(old!.id);
  });

  it("accepts an existing native profile when ACP opens anonymously, then blocks if that session stops opening", async (ctx) => {
    if (!db.available) return ctx.skip();
    const report = async (sessionAvailable: boolean) => db.pool.query(
      "UPDATE hosts SET last_heartbeat_at = now(), capabilities_json = $2::jsonb WHERE id = $1",
      [HOST, JSON.stringify({ installations: { claude_code: [{
        id: "managed:1.0.0", version: "1.0.0", logged_in: false,
        options: { session_available: sessionAvailable, config_options: [] },
      }] } })],
    );
    await report(true);
    const service = new ConversationExecutionContextService(db.pool);
    const draft = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(draft.available_runtime_profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime_profile_id: RUNTIME, usable: true }),
    ]));
    await service.initialize({ spaceId: SPACE, userId: OWNER }, SESSION, {
      selection: { execution_host_id: HOST, primary: { kind: "managed" } },
      runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
    });
    await report(false);
    const blocked = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(blocked.summary).toMatchObject({ can_send: false, blocked_reason: expect.stringContaining("no signed-in account or available ACP session") });
  });

  it("offers a newly discovered CLI with an anonymous ACP session as a selectable installation", async (ctx) => {
    if (!db.available) return ctx.skip();
    const report = async (sessionAvailable: boolean) => db.pool.query(
      "UPDATE hosts SET last_heartbeat_at = now(), capabilities_json = $2::jsonb WHERE id = $1",
      [HOST, JSON.stringify({ installations: { opencode: [{
        id: "managed:1.18.31", version: "1.18.31", logged_in: false,
        options: { session_available: sessionAvailable, config_options: [] },
      }] } })],
    );
    const service = new ConversationExecutionContextService(db.pool);
    await report(false);
    const unavailable = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(unavailable.available_runtime_profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime_key: "opencode", runtime_profile_id: null, usable: false }),
    ]));
    await report(true);
    const ready = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(ready.available_runtime_profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime_key: "opencode", runtime_profile_id: null, usable: true }),
    ]));
    const initialized = await service.initialize({ spaceId: SPACE, userId: OWNER }, SESSION, {
      selection: { execution_host_id: HOST, primary: { kind: "managed" } },
      runtime: { agent_id: AGENT, runtime_profile_id: null, runtime_key: "opencode", runtime_installation: "managed:1.18.31" },
    });
    expect(initialized).toMatchObject({ state: "initialized", runtime: { runtime_key: "opencode", runtime_installation: "managed:1.18.31" } });
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
       id,
       space_id,
       agent_id,
       name,
       runtime_key,
       backend_mode,
       execution_host_id,
       workspace_location_id,
       workspace_mode,
       runtime_installation,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       $1,
       $2,
       $3,
       'Project setting',
       'claude_code',
       'runtime_native',
       $4,
       $5,
       'location',
       'own',
       '{}',
       '{}',
       true,
       true,
       now(),
       now()
     )`,
      [existing, SPACE, AGENT, OTHER_HOST, REMOTE_LOCATION],
    );

    const service = new ConversationExecutionContextService(db.pool);
    const preflight = await service.preflight({ spaceId: SPACE, userId: OWNER }, SESSION);
    expect(preflight.summary).toMatchObject({
      host: { host_id: OTHER_HOST },
      primary: { kind: "location", workspace_location_id: REMOTE_LOCATION },
      runtime: { runtime_profile_id: existing, runtime_key: "claude_code", runtime_installation: "own" },
    });
    expect(preflight.available_runtime_profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent_id: AGENT,
        runtime_profile_id: existing,
        execution_host_id: OTHER_HOST,
        workspace_location_id: REMOTE_LOCATION,
        runtime_key: "claude_code",
        runtime_installation: "own",
        usable: true,
      }),
      expect.objectContaining({
        agent_id: AGENT,
        runtime_profile_id: null,
        execution_host_id: OTHER_HOST,
        workspace_location_id: REMOTE_LOCATION,
        runtime_key: "codex_cli",
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
          runtime_key: "codex_cli",
          runtime_installation: "own",
        },
      },
    );
    expect(initialized).toMatchObject({
      state: "initialized",
      host: { host_id: OTHER_HOST },
      primary: { kind: "location", workspace_location_id: REMOTE_LOCATION },
      runtime: { agent_id: AGENT, runtime_key: "codex_cli", runtime_installation: "own" },
    });
    const profiles = await db.pool.query<{ id: string }>(
      `SELECT id FROM agent_runtime_profiles
        WHERE space_id = $1 AND agent_id = $2 AND execution_host_id = $3
          AND workspace_location_id = $4 AND runtime_key = 'codex_cli'
          AND runtime_installation = 'own'`,
      [SPACE, AGENT, OTHER_HOST, REMOTE_LOCATION],
    );
    expect(profiles.rows).toHaveLength(1);
    expect(initialized.runtime?.runtime_profile_id).toBe(profiles.rows[0]!.id);
  });

  it("routes with the initialization-time config snapshot, stripping legacy credentials after profile edits", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET runtime_config_json = '{"effort":"medium","supports_live":true,"provider":{"vendorApiKey":"legacy-secret","keep":true}}',
              runtime_policy_json = '{"network":"deny","nested":{"credential_profile_id":"legacy-credential","keep":true}}'
        WHERE id = $1`,
      [RUNTIME],
    );
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "managed" } },
      runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
      },
    );
    const thread = await db.pool.query<{ id: string }>(
      `SELECT id FROM host_threads
        WHERE space_id = $1 AND session_id = $2 AND agent_id = $3
          AND container_kind = 'conversation'`,
      [SPACE, SESSION, AGENT],
    );
    const binding = await db.pool.query<{
      runtime_key_snapshot: string;
      backend_mode_snapshot: string;
      runtime_config_snapshot_json: Record<string, unknown>;
      runtime_policy_snapshot_json: Record<string, unknown>;
    }>(
      `SELECT runtime_key_snapshot, backend_mode_snapshot,
              runtime_config_snapshot_json, runtime_policy_snapshot_json
         FROM session_conversation_backends
        WHERE space_id = $1 AND session_id = $2 AND agent_id = $3`,
      [SPACE, SESSION, AGENT],
    );
    expect(binding.rows[0]).toEqual({
      runtime_key_snapshot: "claude_code",
      backend_mode_snapshot: "runtime_native",
      runtime_config_snapshot_json: {
        effort: "medium",
        supports_live: true,
        provider: { keep: true },
      },
      runtime_policy_snapshot_json: { network: "deny", nested: { keep: true } },
    });
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET runtime_config_json = '{"effort":"high","supports_live":false}',
              runtime_policy_json = '{"network":"allow"}'
        WHERE id = $1`,
      [RUNTIME],
    );
    const runs = new PgRunRepository(db.pool);
    const queued = await runs.createQueuedRun({
      execution_kind: "agent",
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
        host_thread: { schema_version: "host_thread.v1", thread_id: thread.rows[0]!.id },
      },
    });
    const routed = await new PgRouteDecisionRepository(db.pool).routeRun(queued);
    expect(routed.model_override_json).not.toHaveProperty("model");
    expect(routed.runtime_profile_snapshot_json).toMatchObject({
      model_name: null,
      runtime_config_json: { effort: "medium", supports_live: true, provider: { keep: true } },
      runtime_policy_json: { network: "deny", nested: { keep: true } },
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

  it("allows writable attachments on the built-in server Host", async (ctx) => {
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
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
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
    )).resolves.toMatchObject({ attachment: { access_mode: "write" } });
  });

  it("requires the canonical Room grant before exposing a private Agent runtime", async (ctx) => {
    if (!db.available) return ctx.skip();
    const now = new Date().toISOString();
    const room = await db.pool.query<{ id: string }>(
      `SELECT room_id AS id FROM sessions WHERE id = $1`,
      [SESSION],
    );
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source)
       VALUES ($1, 'viewer@example.test', 'Viewer', 'active', $2, $2, 'system')`,
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
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
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
    // Asserted on the *profile* entries: the host also reports its own
    // installed copies as profile-less candidates for the same participant,
    // and enumerating them here would restate what the earlier "uses
    // Host-reported CLIs directly" test already covers. They are gated by the
    // Room grant too — the `hidden` and `revoked` assertions below are
    // unfiltered `[]` for exactly that reason.
    expect(granted.available_runtime_profiles.filter((entry) => entry.runtime_profile_id !== null)).toEqual([
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
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source)
       VALUES ($1, 'viewer@example.test', 'Viewer', 'active', $2, $2, 'system')`,
      [VIEWER, now],
    );
    const service = new ConversationExecutionContextService(db.pool);
    await service.initialize(
      { spaceId: SPACE, userId: OWNER },
      SESSION,
      {
        selection: { execution_host_id: HOST, primary: { kind: "managed" } },
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
      },
    );
    await expect(db.pool.query(
      `INSERT INTO session_conversation_backends (
         id, space_id, session_id, bound_by_user_id, agent_id, runtime_profile_id,
         runtime_key_snapshot, backend_mode_snapshot, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'claude_code', 'runtime_native', $7, $7)`,
      [randomUUID(), SPACE, SESSION, VIEWER, AGENT, RUNTIME, now],
    )).rejects.toMatchObject({ code: "23505" });
    const constraints = await db.pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname IN ('session_conversation_backends_bound_by_user_id_fkey')
        ORDER BY conname ASC`,
    );
    expect(constraints.rows).toEqual([
      { conname: "session_conversation_backends_bound_by_user_id_fkey", confdeltype: "a" },
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
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
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
    // The stale pinned Location is what this is about; the host's own
    // profile-less candidates carry no Location pin and are covered elsewhere.
    expect(draft.available_runtime_profiles.filter((entry) => entry.runtime_profile_id !== null)).toEqual([
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
        runtime: { agent_id: AGENT, runtime_profile_id: RUNTIME, runtime_key: "claude_code", runtime_installation: "managed:1.0.0" },
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


describe("Reusable Agent Project execution (real PostgreSQL)", () => {
  it("keeps two Projects' Locations, CLI choices, bindings and threads independent for one Agent", async () => {
    if (!db.available) return;
    const projectB = randomUUID(), folderB = randomUUID(), locationB = randomUUID(), sessionB = randomUUID();
    await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Second','active',now(),now())", [projectB, SPACE, OWNER]);
    await seedMainlineRoomsForAllProjects(db.pool);
    // The one identity retains its original content boundary; its execution no longer belongs to A.
    await db.pool.query("UPDATE agents SET agent_kind='standard',project_id=NULL,access_project_id=$2 WHERE id=$1", [AGENT, PROJECT]);
    const links = new PgProjectAgentRepository(db.pool);
    for (const projectId of [PROJECT, projectB]) await links.upsertActive({spaceId: SPACE, projectId, agentId: AGENT, userId: OWNER});
    await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,created_by_user_id,name,status,kind,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,$4,'Second repo','active','code',false,false,now(),now())", [folderB, SPACE, projectB, OWNER]);
    await db.pool.query("INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,root_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'server','/workspace/second',true,'active',now(),now())", [locationB, SPACE, folderB, HOST]);
    await db.pool.query("INSERT INTO sessions(id,space_id,project_id,user_id,agent_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',now(),now())", [sessionB, SPACE, projectB, OWNER, AGENT]);
    await db.pool.query("UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,codex_cli}',$2::jsonb,true) WHERE id=$1", [HOST, JSON.stringify([{id:'managed:1.0.0',version:'1.0.0',logged_in:true,health_check_protocol:'acp'}])]);
    const service = new ConversationExecutionContextService(db.pool);
    const initialize = (sessionId: string, locationId: string, runtimeKey: string) => service.initialize({spaceId: SPACE, userId: OWNER}, sessionId, {
      selection: {execution_host_id: HOST, primary: {kind: 'location', workspace_location_id: locationId}},
      runtime: {agent_id: AGENT, runtime_profile_id: null, runtime_key: runtimeKey, runtime_installation: 'managed:1.0.0'},
    });
    await initialize(SESSION, LOCATION, 'claude_code');
    const first = (await db.pool.query("SELECT * FROM session_conversation_backends WHERE session_id=$1", [SESSION])).rows[0];
    await initialize(sessionB, locationB, 'codex_cli');
    expect((await db.pool.query("SELECT * FROM session_conversation_backends WHERE session_id=$1", [SESSION])).rows[0]).toEqual(first);
    const backends = new PgConversationBackendRepository(db.pool);
    const optionsA = await backends.listOptions(SPACE, OWNER, AGENT, PROJECT);
    const optionsB = await backends.listOptions(SPACE, OWNER, AGENT, projectB);
    expect(optionsA.filter(p => p.workspace_mode === 'location').map(p => p.workspace_location_id)).toEqual([LOCATION]);
    expect(optionsB.filter(p => p.workspace_mode === 'location').map(p => p.workspace_location_id)).toEqual([locationB]);
    expect((await backends.listOptions(SPACE, OWNER, AGENT)).every(p => p.workspace_mode !== 'location')).toBe(true);
    const app = buildModuleServer(loadConfig({SERVER_DATABASE_URL: db.connectionUri}), [agentsModule]);
    __setAuthIdentityForTests({spaceId: SPACE, userId: OWNER});
    try {
      const draft = await app.inject({method: 'GET', url: `/api/v1/agents/${AGENT}/conversation-backends?project_id=${projectB}`});
      expect(draft.statusCode, draft.body).toBe(200);
      expect(draft.json().options.filter((p: {workspace_mode: string}) => p.workspace_mode === 'location').map((p: {workspace_location_id: string}) => p.workspace_location_id)).toEqual([locationB]);
      expect((await app.inject({method: 'GET', url: `/api/v1/agents/${AGENT}/conversation-backends?session_id=${sessionB}&project_id=${PROJECT}`})).statusCode).toBe(404);
      __setAuthIdentityForTests({spaceId: SPACE, userId: VIEWER});
      expect((await app.inject({method: 'GET', url: `/api/v1/agents/${AGENT}/conversation-backends?project_id=${projectB}`})).statusCode).toBe(404);
    } finally {
      __setAuthIdentityForTests(null);
      await app.close();
    }
    const bindingB = await backends.resolveBinding({space_id: SPACE, user_id: OWNER, session_id: sessionB, agent_id: AGENT});
    expect(bindingB).toMatchObject({workspace_location_id: locationB, runtime_key: 'codex_cli'});
    await expect(prepareHostConversationDispatch({db: db.pool, backend: bindingB, container: {kind: 'conversation', conversation_id: SESSION}, sessionId: SESSION, spaceId: SPACE, projectId: PROJECT, agentId: AGENT, userId: OWNER})).rejects.toThrow('Project context');
    const threads = (await db.pool.query("SELECT id,session_id,workspace_location_id,runtime_key FROM host_threads WHERE agent_id=$1 ORDER BY session_id", [AGENT])).rows;
    expect(threads).toHaveLength(2);
    expect(new Set(threads.map(t => t.id)).size).toBe(2);
    expect(threads).toEqual(expect.arrayContaining([expect.objectContaining({session_id: SESSION, workspace_location_id: LOCATION}), expect.objectContaining({session_id: sessionB, workspace_location_id: locationB})]));
    await expect(new PgAgentRepository(db.pool).ensureHostRuntimeProfile({spaceId: SPACE, projectId: PROJECT, actorUserId: VIEWER, agentId: AGENT, executionHostId: OTHER_HOST, workspaceLocationId: null, workspaceMode: 'managed', runtimeKey: 'claude_code', runtimeInstallation: 'managed:1.0.0'})).rejects.toMatchObject({statusCode: 403});
    // Another Project setup does not replace the Agent's default deployment.
    expect((await db.pool.query("SELECT id FROM agent_runtime_profiles WHERE agent_id=$1 AND is_default", [AGENT])).rows).toEqual([{id: RUNTIME}]);
    const agents = new PgAgentRepository(db.pool);
    await expect(agents.ensureHostRuntimeProfile({spaceId: SPACE, projectId: PROJECT, actorUserId: OWNER, agentId: AGENT, executionHostId: HOST, workspaceLocationId: locationB, workspaceMode: 'location', runtimeKey: 'codex_cli', runtimeInstallation: 'managed:1.0.0'})).rejects.toThrow('execution Project');
    await expect(agents.ensureHostRuntimeProfile({spaceId: SPACE, projectId: null, actorUserId: OWNER, agentId: AGENT, executionHostId: HOST, workspaceLocationId: LOCATION, workspaceMode: 'location', runtimeKey: 'claude_code', runtimeInstallation: 'managed:1.0.0'})).rejects.toThrow('execution Project');
    await db.pool.query("UPDATE project_agent_links SET status='removed',removed_at=now() WHERE project_id=$1 AND agent_id=$2", [projectB, AGENT]);
    await expect(agents.ensureHostRuntimeProfile({spaceId: SPACE, projectId: projectB, actorUserId: OWNER, agentId: AGENT, executionHostId: HOST, workspaceLocationId: locationB, workspaceMode: 'location', runtimeKey: 'codex_cli', runtimeInstallation: 'managed:1.0.0'})).rejects.toThrow('Add this Agent');
    // Existing initialized history stays pinned after list removal.
    expect(await backends.resolveBinding({space_id: SPACE, user_id: OWNER, session_id: sessionB, agent_id: AGENT})).toMatchObject({binding_id: bindingB.binding_id, workspace_location_id: locationB});
  });
});

describe('Room conversation participant snapshots (real PostgreSQL)',()=>{
  async function specialist(){
    const agent=randomUUID(),version=randomUUID(),profile=randomUUID();
    await seedAgentWithVersion(db.pool,{agent,version,space:SPACE,owner:OWNER,seedDefaultRuntimeProfile:false,name:'Optional specialist'});
    await db.pool.query(`UPDATE agent_versions SET risk_level='low' WHERE id=$1`,[version]);
    await db.pool.query(`INSERT INTO room_agent_members(id,space_id,room_id,agent_id,role,status,created_at,updated_at)
      SELECT $1,space_id,room_id,$2,'member','active',now(),now() FROM sessions WHERE id=$3`,[randomUUID(),agent,SESSION]);
    await db.pool.query(`INSERT INTO agent_runtime_profiles(id,space_id,agent_id,name,runtime_key,backend_mode,execution_host_id,workspace_mode,runtime_installation,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
      VALUES($1,$2,$3,'Optional CLI','claude_code','runtime_native',$4,'managed','managed:1.0.0','{}','{}',true,true,now(),now())`,[profile,SPACE,agent,HOST]);
    return {agent_id:agent,runtime_profile_id:profile,runtime_key:'claude_code',runtime_installation:'managed:1.0.0'};
  }
  const identity={spaceId:SPACE,userId:OWNER};
  const request={selection:{execution_host_id:HOST,primary:{kind:'managed' as const}},runtime:{agent_id:AGENT,runtime_profile_id:RUNTIME,runtime_key:'claude_code',runtime_installation:'managed:1.0.0'}};
  it('does not bind excluded Agents or silently add a later Room member; joins and removes without resetting retained threads',async ctx=>{
    if(!db.available)return ctx.skip();
    const service=new ConversationExecutionContextService(db.pool),optional=await specialist();
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT]});
    const before=(await db.pool.query(`SELECT * FROM host_threads WHERE session_id=$1 AND agent_id=$2`,[SESSION,AGENT])).rows[0];
    expect((await service.preview(identity,SESSION)).summary.runtimes.map(pin=>pin.agent_id)).toEqual([AGENT]);
    expect((await db.pool.query(`SELECT agent_id FROM session_conversation_backends WHERE session_id=$1`,[SESSION])).rows).toEqual([{agent_id:AGENT}]);
    await expect(new PgConversationBackendRepository(db.pool).resolveBinding({space_id:SPACE,user_id:OWNER,session_id:SESSION,agent_id:optional.agent_id})).rejects.toThrow('not participating');
    const later=await specialist();
    expect((await service.preview(identity,SESSION)).summary.can_send).toBe(true);
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,additional_runtimes:[optional],participant_agent_ids:[AGENT,optional.agent_id]});
    const optionalThread=(await db.pool.query(`SELECT * FROM host_threads WHERE session_id=$1 AND agent_id=$2`,[SESSION,optional.agent_id])).rows[0];
    await new PgConversationBackendRepository(db.pool).saveSessionConfig(SPACE,SESSION,optional.agent_id,[]);
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT]});
    expect((await service.preview(identity,SESSION)).summary.runtimes.map(pin=>pin.agent_id)).toEqual([AGENT]);
    await expect(new PgConversationBackendRepository(db.pool).resolveBinding({space_id:SPACE,user_id:OWNER,session_id:SESSION,agent_id:optional.agent_id})).rejects.toThrow('not participating');
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT,optional.agent_id]});
    expect((await db.pool.query(`SELECT id FROM host_threads WHERE session_id=$1 AND agent_id=$2`,[SESSION,optional.agent_id])).rows).toEqual([{id:optionalThread.id}]);
    expect((await db.pool.query(`SELECT * FROM host_threads WHERE id=$1`,[before.id])).rows[0]).toEqual(before);
    expect((await service.preview(identity,SESSION)).summary.runtimes.map(pin=>pin.agent_id)).not.toContain(later.agent_id);
  });
  it('snapshots Room model defaults once and leaves subsequent saves independent',async ctx=>{
    if(!db.available)return ctx.skip();
    const {RoomRosterService}=await import('../src/modules/rooms/rosterService.js');
    const room=(await db.pool.query(`SELECT room_id FROM sessions WHERE id=$1`,[SESSION])).rows[0].room_id;
    await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,claude_code}',$2::jsonb,true) WHERE id=$1`,[HOST,JSON.stringify([{id:'managed:1.0.0',version:'1.0.0',logged_in:true,health_check_protocol:'acp',options:{session_available:true,config_options:[{id:'model',name:'Model',category:'model',type:'select',current_value:'a',options:[{value:'a'},{value:'b'}]}]}}])]);
    const config=(value:string)=>[{id:'model',category:'model',type:'select' as const,value}];
    const roster=new RoomRosterService(db.pool),service=new ConversationExecutionContextService(db.pool);
    await roster.saveConversationDefaults(identity,room,[{agent_id:AGENT,participating:true,runtime_profile_id:RUNTIME,session_config:config('a')}],(await db.pool.query('SELECT roster_revision FROM rooms WHERE id=$1',[room])).rows[0].roster_revision);
    await service.initialize(identity,SESSION,request);
    const backends=new PgConversationBackendRepository(db.pool);
    expect(await backends.sessionConfig(SPACE,SESSION,AGENT)).toEqual(config('a'));
    await roster.saveConversationDefaults(identity,room,[{agent_id:AGENT,participating:true,runtime_profile_id:RUNTIME,session_config:config('b')}],(await db.pool.query('SELECT roster_revision FROM rooms WHERE id=$1',[room])).rows[0].roster_revision);
    await service.initialize(identity,SESSION,request);
    expect(await backends.sessionConfig(SPACE,SESSION,AGENT)).toEqual(config('a'));
    await backends.saveSessionConfig(SPACE,SESSION,AGENT,config('b'));
    expect((await service.preview(identity,SESSION)).summary.runtimes[0]?.session_config).toEqual(config('b'));
    await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,claude_code,0,options,config_options,0,options}',$2::jsonb,true) WHERE id=$1`,[HOST,JSON.stringify([{value:'a'}])]);
    expect((await service.preview(identity,SESSION)).summary.runtimes[0]).toMatchObject({session_config:[],session_config_dropped:true});
    expect(await backends.sessionConfig(SPACE,SESSION,AGENT)).toEqual(config('b'));
  });
  it('freezes each running turn, excludes nonparticipants from delegation, and confines Assistant settings to its current conversation',async ctx=>{
    if(!db.available)return ctx.skip();
    const {RoomService}=await import('../src/modules/rooms/service.js');
    const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
    const {runActor}=await import('../src/modules/systemActions/operations/actor.js');
    const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
    const service=new ConversationExecutionContextService(db.pool),optional=await specialist();
    await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,claude_code}',$2::jsonb,true) WHERE id=$1`,[HOST,JSON.stringify([{id:'managed:1.0.0',version:'1.0.0',logged_in:true,health_check_protocol:'acp',options:{session_available:true,config_options:[{id:'model',name:'Model',category:'model',type:'select',current_value:'a',options:[{value:'a'},{value:'b'}]}]}}])]);
    const modelConfig=(value:string)=>[{id:'model',type:'select' as const,category:'model',value}];
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT]});
    await new PgConversationBackendRepository(db.pool).saveSessionConfig(SPACE,SESSION,AGENT,modelConfig('a'));
    const room=(await db.pool.query(`SELECT room_id FROM sessions WHERE id=$1`,[SESSION])).rows[0].room_id;
    const rooms=new RoomService(config,db.pool),sent=await rooms.sendMessage(identity,room,SESSION,{content:'Inspect this conversation.'});
    expect((await db.pool.query(`SELECT agent_id FROM agent_run_group_members WHERE group_id=$1 ORDER BY agent_id`,[sent.task_group_ids[0]])).rows).toEqual([{agent_id:AGENT}]);
    const runs=new PgRunRepository(db.pool,config),before=await runs.getRun(SPACE,sent.run_ids[0]!);
    await new PgRouteDecisionRepository(db.pool).routeRun(before as never);
    await db.pool.query(`UPDATE runs SET status='running' WHERE id=$1`,[before!.id]);
    const run=(await runs.getRun(SPACE,before!.id))!,actor=await runActor(db.pool,run),runtime=await operationRuntime(config);
    const read=await runtime.execute('room.settings.read',{},actor,randomUUID());
    expect(read.http_status,JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({status:'succeeded',data:{room_id:room,session_id:SESSION}});
    const otherSession=randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,room_id,project_id,status,created_at,updated_at) SELECT $1,space_id,room_id,project_id,'active',now(),now() FROM sessions WHERE id=$2`,[otherSession,SESSION]);
    const forbidden=await runtime.execute('conversation.execution.initialize',{...request,session_id:otherSession},actor,randomUUID(),randomUUID());
    expect(forbidden.http_status).toBe(404);
    const saved=await runtime.execute('conversation.session_config.save',{session_id:SESSION,agent_id:AGENT,runtime_profile_id:RUNTIME,session_config:modelConfig('b')},actor,randomUUID(),randomUUID());
    expect(saved.http_status,JSON.stringify(saved.body)).toBe(200);
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT,optional.agent_id],additional_runtimes:[optional]});
    const after=(await runs.getRun(SPACE,run.id))!;
    expect(after.model_override_json).toEqual(run.model_override_json);
    expect(after.model_override_json).toMatchObject({acp_session_config:[{value:'a'}]});
    expect(await new PgConversationBackendRepository(db.pool).sessionConfig(SPACE,SESSION,AGENT)).toEqual(modelConfig('b'));
    expect(after.permission_snapshot_json).toEqual(run.permission_snapshot_json);
    expect((await db.pool.query(`SELECT agent_id FROM agent_run_group_members WHERE group_id=$1`,[sent.task_group_ids[0]])).rows).toEqual([{agent_id:AGENT}]);
    const foreignProject=randomUUID();
    await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Retained Project','active',now(),now())`,[foreignProject,SPACE,OWNER]);
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query(`UPDATE agents SET access_project_id=$2 WHERE id=$1`,[optional.agent_id,foreignProject]);
    const noRoomUseGrant=await runtime.execute('conversation.session_config.save',{session_id:SESSION,agent_id:optional.agent_id,runtime_profile_id:optional.runtime_profile_id,session_config:[]},actor,randomUUID(),randomUUID());
    expect(noRoomUseGrant.http_status).toBe(404);
    // Withdrawal is checked again, even with a previously granted Run action.
    await db.pool.query(`UPDATE room_user_members SET status='removed' WHERE space_id=$1 AND room_id=$2 AND user_id=$3`,[SPACE,room,OWNER]);
    const refused=await runtime.execute('conversation.session_config.save',{session_id:SESSION,agent_id:AGENT,runtime_profile_id:RUNTIME,session_config:modelConfig('b')},actor,randomUUID(),randomUUID());
    expect(refused.http_status).toBe(404);
  });

  it('serializes repeated joins and rechecks Room revocation after waiting for the audience lock',async ctx=>{
    if(!db.available)return ctx.skip();
    const {waitForBlockedBy}=await import('./support/lockWait.js');
    const service=new ConversationExecutionContextService(db.pool),optional=await specialist();
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT]});
    const join={...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT,optional.agent_id],additional_runtimes:[optional]};
    const outcomes=await Promise.allSettled([service.initialize(identity,SESSION,join),service.initialize(identity,SESSION,join)]);
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect((await db.pool.query(`SELECT count(*)::int count FROM host_threads WHERE space_id=$1 AND session_id=$2 AND agent_id=$3`,[SPACE,SESSION,optional.agent_id])).rows[0].count).toBe(1);
    const other=await specialist(),holder=await db.pool.connect();
    let pending:Promise<unknown>|undefined;
    try{
      await holder.query('BEGIN');
      const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const room=(await holder.query(`SELECT room_id FROM sessions WHERE id=$1`,[SESSION])).rows[0].room_id;
      await holder.query(`SELECT id FROM rooms WHERE id=$1 FOR UPDATE`,[room]);
      let settled=false;
      pending=service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT,other.agent_id],additional_runtimes:[other]}).then(()=>{settled=true;return null},error=>{settled=true;return error});
      await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
      expect(settled).toBe(false);
      await holder.query(`UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2`,[room,OWNER]);
      await holder.query('COMMIT');
      expect(await pending).toMatchObject({statusCode:404});
      expect((await db.pool.query(`SELECT 1 FROM session_conversation_backends WHERE session_id=$1 AND agent_id=$2`,[SESSION,other.agent_id])).rowCount).toBe(0);
    }finally{await holder.query('ROLLBACK');holder.release();await pending;}
  });

  it('refuses a queued recipient at the Run admission boundary after participation is removed',async ctx=>{
    if(!db.available)return ctx.skip();
    const {RoomService}=await import('../src/modules/rooms/service.js');
    const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),optional=await specialist();
    const service=new ConversationExecutionContextService(db.pool);
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT,optional.agent_id],additional_runtimes:[optional]});
    const room=(await db.pool.query(`SELECT room_id FROM sessions WHERE id=$1`,[SESSION])).rows[0].room_id;
    const sent=await new RoomService(config,db.pool).sendMessage(identity,room,SESSION,{content:'Only the specialist should inspect this.',recipient_segments:[{recipient_agent_ids:[optional.agent_id],content:'Inspect this.'}]});
    const runs=new PgRunRepository(db.pool,config),queued=(await runs.getRun(SPACE,sent.run_ids[0]!))!;
    await new PgRouteDecisionRepository(db.pool).routeRun(queued as never);
    expect(await runs.checkRunExecutionAuthorization(queued)).toMatchObject({allowed:true});
    await service.initialize(identity,SESSION,{...request,participants_revision:(await service.preview(identity,SESSION)).summary.participants_revision,participant_agent_ids:[AGENT]});
    expect(await runs.checkRunExecutionAuthorization(queued)).toMatchObject({allowed:false,error_code:'run_execution_authorization_revoked'});
    expect(await runs.markRunRunning({space_id:SPACE,run_id:queued.id,started_at:new Date().toISOString()})).toBeNull();
    expect((await runs.getRun(SPACE,queued.id))?.status).toBe('queued');
  });

  it('keeps a hidden participant, rejects unauthorized deltas and full omissions, and uses the manager after a specialist replied (actual editor payload)',async()=>{
    const service=new ConversationExecutionContextService(db.pool),optional=await specialist(),hidden=await specialist();
    await service.initialize(identity,SESSION,{...request,participant_agent_ids:[AGENT,optional.agent_id,hidden.agent_id],additional_runtimes:[optional,hidden]});
    // Make the hidden Agent inaccessible even to this Space owner through a foreign Project boundary.
    const foreign=randomUUID();
    await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Foreign','active',now(),now())`,[foreign,SPACE,OWNER]);
    await db.pool.query(`UPDATE agents SET access_project_id=$2 WHERE id=$1`,[hidden.agent_id,foreign]);
    await db.pool.query(`UPDATE host_threads SET updated_at=now()+interval '1 hour' WHERE session_id=$1 AND agent_id=$2`,[SESSION,optional.agent_id]);
    const preview=await service.preview(identity,SESSION),summary=preview.summary;
    expect(summary.runtime?.agent_id).toBe(AGENT);
    expect(summary.participant_agent_ids).toContain(hidden.agent_id);
    expect(summary.runtimes.some(pin=>pin.agent_id===hidden.agent_id)).toBe(false);
    expect(preview.available_runtime_profiles.some(pin=>pin.agent_id===hidden.agent_id)).toBe(false);
    expect(preview.available_participant_agents?.some(agent=>agent.agent_id===hidden.agent_id)).toBe(false);
    await expect(service.initialize(identity,SESSION,{...request,participants_revision:summary.participants_revision,participant_agent_ids:[AGENT,optional.agent_id]})).rejects.toMatchObject({statusCode:403});
    await expect(service.initialize(identity,SESSION,{...request,participants_revision:summary.participants_revision,participant_changes:[{agent_id:hidden.agent_id,participating:false}]})).rejects.toMatchObject({statusCode:403});
    // Consume the UI mapper with the actual rich PG read projection, through strict HTTP below.
    expect(summary.runtimes.find(pin=>pin.agent_id===AGENT)).toHaveProperty('session_config');
    const payload={selection:request.selection,runtime:runtimeChoice(summary.runtimes.find(pin=>pin.agent_id===AGENT)!),additional_runtimes:[],participants_revision:summary.participants_revision,participant_changes:[{agent_id:optional.agent_id,participating:false}]};
    const {systemActionsModule}=await import('../src/modules/systemActions/index.js');
    const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[systemActionsModule,sessionsModule]);
    __setAuthIdentityForTests(identity);
    try{
      // The web client sends this exact operation URL/body and reads preflight after its receipt.
      const response=await app.inject({method:'POST',url:'/api/v1/actions/conversation.execution.initialize',headers:{'idempotency-key':randomUUID()},payload:{session_id:SESSION,...payload}});
      expect(response.statusCode,response.body).toBe(200);
    }finally{__setAuthIdentityForTests(null);await app.close();}
    const saved=(await service.preview(identity,SESSION)).summary;
    expect(saved.participant_agent_ids?.sort()).toEqual([AGENT,hidden.agent_id].sort());
    await expect(service.initialize(identity,SESSION,payload)).rejects.toMatchObject({statusCode:409});
    await service.initialize(identity,SESSION,request);
    expect((await service.preview(identity,SESSION)).summary.participant_agent_ids?.sort()).toEqual([AGENT,hidden.agent_id].sort());
    await expect(service.initialize(identity,SESSION,{...request,runtime:optional})).rejects.toMatchObject({statusCode:403});
  });

  it('preserves inaccessible Room defaults, rejects stale saves, and never exposes their profiles in Room detail',async()=>{
    const {RoomRosterService}=await import('../src/modules/rooms/rosterService.js');
    const {RoomService}=await import('../src/modules/rooms/service.js');
    const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
    const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
    const hidden=await specialist(),room=(await db.pool.query('SELECT room_id FROM sessions WHERE id=$1',[SESSION])).rows[0].room_id;
    const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),runtime=await operationRuntime(config),actor=sessionActor(identity);
    const foreign=randomUUID();
    await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Foreign','active',now(),now())`,[foreign,SPACE,OWNER]);
    const old={agent_id:hidden.agent_id,participating:true,runtime_profile_id:hidden.runtime_profile_id,session_config:[]};
    await db.pool.query('UPDATE rooms SET conversation_defaults_json=$2 WHERE id=$1',[room,JSON.stringify([old])]);
    await db.pool.query('UPDATE agents SET access_project_id=$2 WHERE id=$1',[hidden.agent_id,foreign]);
    const read=await runtime.execute('room.settings.read',{room_id:room},actor,randomUUID());
    expect(read.http_status).toBe(200);
    const data=(read.body as {data:{revision:number;defaults:unknown[]}}).data;
    expect(data.defaults).toEqual([]);
    const patch=[{agent_id:AGENT,participating:true,runtime_profile_id:RUNTIME,session_config:[]}];
    const roster=new RoomRosterService(db.pool);
    await roster.saveConversationDefaults(identity,room,patch,data.revision);
    await expect(roster.saveConversationDefaults(identity,room,patch,data.revision)).rejects.toMatchObject({statusCode:409});
    const stale=await runtime.execute('room.defaults.save',{room_id:room,defaults:patch,expected_revision:data.revision},actor,randomUUID(),randomUUID());
    expect(stale.http_status,JSON.stringify(stale.body)).toBe(409);
    const stored=(await db.pool.query('SELECT conversation_defaults_json FROM rooms WHERE id=$1',[room])).rows[0].conversation_defaults_json;
    expect(stored).toContainEqual(old);
    const detail=await new RoomService(config,db.pool).getRoom(identity,room);
    expect(JSON.stringify(detail)).not.toContain(hidden.runtime_profile_id);
  });

  it('joins and restores retained participants through strict HTTP using the UI runtime mapper',async()=>{
    const {systemActionsModule}=await import('../src/modules/systemActions/index.js');
    const service=new ConversationExecutionContextService(db.pool),worker=await specialist();
    await service.initialize(identity,SESSION,{...request,participant_agent_ids:[AGENT]});
    const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[systemActionsModule,sessionsModule]);
    __setAuthIdentityForTests(identity);
    try{
      let thread:string|undefined;
      for(const [participating,additional] of [[true,true],[false,false],[true,false]]){
        // Removal and a retained Host thread do not require a usable new profile.
        if (!additional) await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[worker.runtime_profile_id]);
        const preview = await service.preview(identity,SESSION);
        if (!additional) expect(preview.available_participant_agents).toContainEqual({agent_id:worker.agent_id,retained_thread:true});
        const summary=preview.summary;
        const payload={session_id:SESSION,selection:request.selection,runtime:runtimeChoice(summary.runtimes.find(pin=>pin.agent_id===AGENT)!),participants_revision:summary.participants_revision,participant_changes:[{agent_id:worker.agent_id,participating}],additional_runtimes:additional?[runtimeChoice(worker)]:[]};
        const response=await app.inject({method:'POST',url:'/api/v1/actions/conversation.execution.initialize',headers:{'idempotency-key':randomUUID()},payload});
        expect(response.statusCode,response.body).toBe(200);
        const id=(await db.pool.query('SELECT id FROM host_threads WHERE session_id=$1 AND agent_id=$2',[SESSION,worker.agent_id])).rows[0].id;
        if(thread)expect(id).toBe(thread);else thread=id;
        expect((await service.preview(identity,SESSION)).summary.participant_agent_ids?.includes(worker.agent_id)).toBe(participating);
      }
      await db.pool.query('UPDATE agent_runtime_profiles SET enabled=true WHERE id=$1',[worker.runtime_profile_id]);
      await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,claude_code}',$2::jsonb,true) WHERE id=$1`,[HOST,JSON.stringify([{id:'managed:1.0.0',version:'1.0.0',logged_in:true,health_check_protocol:'acp',options:{session_available:true,config_options:[{id:'model',name:'Model',category:'model',type:'select',current_value:'a',options:[{value:'a'},{value:'b'}]}]}}])]);
      const before=(await service.preview(identity,SESSION)).summary.participant_agent_ids;
      const session_config=[{id:'model',type:'select',category:'model',value:'b'}];
      const response=await app.inject({method:'POST',url:'/api/v1/actions/conversation.session_config.save',headers:{'idempotency-key':randomUUID()},payload:{session_id:SESSION,agent_id:worker.agent_id,runtime_profile_id:worker.runtime_profile_id,session_config}});
      expect(response.statusCode,response.body).toBe(200);
      const after=(await service.preview(identity,SESSION)).summary;
      expect(after.participant_agent_ids).toEqual(before);
      expect(after.runtimes.find(pin=>pin.agent_id===worker.agent_id)?.session_config).toEqual(session_config);
    }finally{__setAuthIdentityForTests(null);await app.close();}
  });

  it.each(['foreign Host','offline Host','withdrawn model','disabled profile'])('lets B patch Y through public HTTP without revalidating A’s X default: %s',async reason=>{
    const {RoomRosterService}=await import('../src/modules/rooms/rosterService.js');
    const {systemActionsModule}=await import('../src/modules/systemActions/index.js');
    const {roomsModule}=await import('../src/modules/rooms/index.js');
    const x=await specialist(),y=await specialist();
    const room=(await db.pool.query('SELECT room_id FROM sessions WHERE id=$1',[SESSION])).rows[0].room_id;
    await db.pool.query(`INSERT INTO users(id,email,display_name,status,registration_source,created_at,updated_at) VALUES($1,'b@example.test','B','active','system',now(),now())`,[VIEWER]);
    await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`,[randomUUID(),SPACE,VIEWER]);
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),SPACE,PROJECT,VIEWER]);
    await db.pool.query(`INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),SPACE,room,VIEWER]);
    const installations=[{id:'managed:1.0.0',version:'1.0.0',logged_in:true,health_check_protocol:'acp',options:{session_available:true,config_options:[{id:'model',name:'Model',category:'model',type:'select',current_value:'a',options:[{value:'a'},{value:'b'}]}]}}];
    await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,claude_code}',$2::jsonb,true),last_heartbeat_at=now() WHERE id=$1`,[HOST,JSON.stringify(installations)]);
    await db.pool.query(`UPDATE hosts SET capabilities_json=(SELECT capabilities_json FROM hosts WHERE id=$2),last_heartbeat_at=now() WHERE id=$1`,[OTHER_HOST,HOST]);
    await db.pool.query('UPDATE agent_runtime_profiles SET execution_host_id=$2 WHERE id=$1',[x.runtime_profile_id,OTHER_HOST]);
    const model=(value:string)=>[{id:'model',type:'select' as const,category:'model',value}];
    const old={agent_id:x.agent_id,participating:true,runtime_profile_id:x.runtime_profile_id,session_config:model('a')};
    await new RoomRosterService(db.pool).saveConversationDefaults(identity,room,[old],(await db.pool.query('SELECT roster_revision FROM rooms WHERE id=$1',[room])).rows[0].roster_revision);
    if(reason==='offline Host')await db.pool.query("UPDATE hosts SET status='offline' WHERE id=$1",[OTHER_HOST]);
    if(reason==='withdrawn model')await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,claude_code,0,options,config_options,0,options}','[{"value":"b"}]'::jsonb) WHERE id=$1`,[OTHER_HOST]);
    if(reason==='disabled profile')await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[x.runtime_profile_id]);
    const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[systemActionsModule,roomsModule]);
    __setAuthIdentityForTests({spaceId:SPACE,userId:VIEWER});
    try{
      const read=await app.inject({method:'GET',url:'/api/v1/queries/room.settings.read?input='+encodeURIComponent(JSON.stringify({room_id:room}))});
      expect(read.statusCode,read.body).toBe(200);
      const data=read.json().data;
      expect(data.defaults).toContainEqual(old);
      const payload={room_id:room,expected_revision:data.revision,defaults:[{agent_id:y.agent_id,participating:true,runtime_profile_id:y.runtime_profile_id,session_config:model('b')}]};
      const response=await app.inject({method:'POST',url:'/api/v1/actions/room.defaults.save',headers:{'idempotency-key':randomUUID()},payload});
      expect(response.statusCode,response.body).toBe(200);
      const stored=(await db.pool.query('SELECT conversation_defaults_json FROM rooms WHERE id=$1',[room])).rows[0].conversation_defaults_json;
      expect(stored).toEqual(expect.arrayContaining([old,payload.defaults[0]]));
      const stale=await app.inject({method:'POST',url:'/api/v1/actions/room.defaults.save',headers:{'idempotency-key':randomUUID()},payload});
      expect(stale.statusCode,stale.body).toBe(409);
    }finally{__setAuthIdentityForTests(null);await app.close();}
  });

  it('refuses all three settings writes by a real delegated worker with a manual root, but accepts direct human instructions',async()=>{
    const {RoomService}=await import('../src/modules/rooms/service.js');
    const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
    const {runActor}=await import('../src/modules/systemActions/operations/actor.js');
    const {AgentGroupRunService}=await import('../src/modules/agentGroups/service.js');
    const optional=await specialist(),service=new ConversationExecutionContextService(db.pool);
    await service.initialize(identity,SESSION,{...request,additional_runtimes:[optional]});
    const room=(await db.pool.query('SELECT room_id FROM sessions WHERE id=$1',[SESSION])).rows[0].room_id;
    const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),runs=new PgRunRepository(db.pool,config);
    const sent=await new RoomService(config,db.pool).sendMessage(identity,room,SESSION,{content:'Inspect this.'});
    const parent=(await runs.getRun(SPACE,sent.run_ids[0]!))!;
    await new PgRouteDecisionRepository(db.pool).routeRun(parent as never);
    await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[parent.id]);
    const parentNow=(await runs.getRun(SPACE,parent.id))!,direct=await runActor(db.pool,parentNow),runtime=await operationRuntime(config);
    const rootId=parentNow.root_run_id??parentNow.id;
    const spawned=await new AgentGroupRunService(config,db.pool).spawnChildRun(identity,{space_id:SPACE,group_id:sent.task_group_ids[0]!,manager_user_id:OWNER,requesting_agent_id:AGENT,target_agent_id:optional.agent_id,parent_run_id:parent.id,root_run_id:rootId,instruction:'Inspect only',workspace_access:'read'});
    expect(spawned.child_run_id).toBeTruthy();
    const childId=spawned.child_run_id!;
    await new PgRouteDecisionRepository(db.pool).routeRun((await runs.getRun(SPACE,childId))! as never);
    await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[childId]);
    const child=(await runs.getRun(SPACE,childId))!,delegated=await runActor(db.pool,child);
    expect(delegated.effective_origin).toBe('manual');expect(delegated.origin).toBe('delegated');
    expect(child.capabilities_json).not.toContain('room.defaults.save');
    const revision=(await db.pool.query('SELECT roster_revision::int revision FROM rooms WHERE id=$1',[room])).rows[0].revision;
    const writes=[['room.defaults.save',{room_id:room,expected_revision:revision,defaults:[]}],['conversation.execution.initialize',{session_id:SESSION,...request}],['conversation.session_config.save',{session_id:SESSION,agent_id:AGENT,runtime_profile_id:RUNTIME,session_config:[]}]] as const;
    // Simulate an older granted snapshot too: the authoritative gate must still refuse.
    await db.pool.query('UPDATE runs SET permission_snapshot_json=$2 WHERE id=$1',[childId,JSON.stringify(parentNow.permission_snapshot_json)]);
    for(const [action,input] of writes){
      const refused=await runtime.execute(action,input,delegated,randomUUID(),randomUUID());
      expect(refused.http_status,JSON.stringify(refused.body)).toBe(404);
      const allowed=await runtime.execute(action,input,direct,randomUUID(),randomUUID());
      expect(allowed.http_status,JSON.stringify(allowed.body)).toBe(200);
    }
  });

  it('does not resurrect participation after Room removal/re-add, and explicitly rejoining recreates only closed runtime continuity',async()=>{
    const {RoomRosterService}=await import('../src/modules/rooms/rosterService.js');
    const optional=await specialist(),service=new ConversationExecutionContextService(db.pool);
    await service.initialize(identity,SESSION,{...request,additional_runtimes:[optional]});
    const room=(await db.pool.query('SELECT room_id FROM sessions WHERE id=$1',[SESSION])).rows[0].room_id,roster=new RoomRosterService(db.pool);
    await roster.removeAgent(identity,room,optional.agent_id);
    await service.initialize(identity,SESSION,request);
    await roster.addExistingAgent(identity,room,{agent_id:optional.agent_id});
    let state=(await service.preview(identity,SESSION)).summary;
    expect(state.participant_agent_ids).not.toContain(optional.agent_id);
    await service.initialize(identity,SESSION,request);
    state=(await service.preview(identity,SESSION)).summary;
    expect(state.participant_agent_ids).not.toContain(optional.agent_id);
    const joined=await service.initialize(identity,SESSION,{...request,participants_revision:state.participants_revision,participant_changes:[{agent_id:optional.agent_id,participating:true}]});
    expect(joined.participant_agent_ids).toContain(optional.agent_id);
    expect(joined.runtimes.some(pin=>pin.agent_id===optional.agent_id)).toBe(true);
  });

  it('refreshes delegation candidates for current participants without rewriting an existing group snapshot',async()=>{
    const {RoomService}=await import('../src/modules/rooms/service.js');
    const {resolveAgentDelegationToolBinding}=await import('../src/modules/runs/managedAgentDelegationTools.js');
    const optional=await specialist(),service=new ConversationExecutionContextService(db.pool);
    await service.initialize(identity,SESSION,{...request,participant_agent_ids:[AGENT]});
    const room=(await db.pool.query('SELECT room_id FROM sessions WHERE id=$1',[SESSION])).rows[0].room_id,config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
    const sent=await new RoomService(config,db.pool).sendMessage(identity,room,SESSION,{content:'Inspect this.'}),run=(await new PgRunRepository(db.pool,config).getRun(SPACE,sent.run_ids[0]!))!;
    const candidates=async()=>(await resolveAgentDelegationToolBinding(config,run as never,{pool:db.pool}))!.targets.map(target=>target.agent_id);
    expect(await candidates()).not.toContain(optional.agent_id);
    const revision=async()=>(await service.preview(identity,SESSION)).summary.participants_revision;
    await service.initialize(identity,SESSION,{...request,participants_revision:await revision(),participant_changes:[{agent_id:optional.agent_id,participating:true}],additional_runtimes:[optional]});
    expect(await candidates()).toContain(optional.agent_id);
    await service.initialize(identity,SESSION,{...request,participants_revision:await revision(),participant_changes:[{agent_id:optional.agent_id,participating:false}]});
    expect(await candidates()).not.toContain(optional.agent_id);
    await service.initialize(identity,SESSION,{...request,participants_revision:await revision(),participant_changes:[{agent_id:optional.agent_id,participating:true}]});
    expect(await candidates()).toContain(optional.agent_id);
    expect((await db.pool.query('SELECT agent_id FROM agent_run_group_members WHERE group_id=$1',[sent.task_group_ids[0]])).rows).toEqual([{agent_id:AGENT}]);
  });

  it('fences atomic running admission behind a concurrent participant revocation and rereads after the lock',async()=>{
    const {RoomService}=await import('../src/modules/rooms/service.js');
    const {waitForBlockedBy}=await import('./support/lockWait.js');
    const optional=await specialist(),service=new ConversationExecutionContextService(db.pool),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
    await service.initialize(identity,SESSION,{...request,additional_runtimes:[optional]});
    const room=(await db.pool.query('SELECT room_id FROM sessions WHERE id=$1',[SESSION])).rows[0].room_id;
    const sent=await new RoomService(config,db.pool).sendMessage(identity,room,SESSION,{content:'Inspect.',recipient_segments:[{recipient_agent_ids:[optional.agent_id],content:'Inspect.'}]});
    const runs=new PgRunRepository(db.pool,config),run=(await runs.getRun(SPACE,sent.run_ids[0]!))!;
    await new PgRouteDecisionRepository(db.pool).routeRun(run as never);
    const holder=await db.pool.connect();let pending:Promise<unknown>|undefined,settled=false;
    try{
      await holder.query('BEGIN');const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await holder.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE',[room]);
      pending=runs.markRunRunning({space_id:SPACE,run_id:run.id,started_at:new Date().toISOString()}).then(value=>{settled=true;return value});
      await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
      await holder.query('UPDATE session_conversation_backends SET participating=false,updated_at=clock_timestamp() WHERE session_id=$1 AND agent_id=$2',[SESSION,optional.agent_id]);
      await holder.query('COMMIT');expect(await pending).toBeNull();
      expect((await runs.getRun(SPACE,run.id))!.status).toBe('queued');
      // The structured claim says why, so its executor settles the still-queued Run from the locked refusal.
      expect(await runs.claimRunExecution({space_id:SPACE,run_id:run.id,started_at:new Date().toISOString()})).toEqual({outcome:'authorization_rejected',error_code:'run_execution_authorization_revoked',error_message:'Run execution authorization is no longer active.'});
      await db.pool.query(`UPDATE runs SET status='running',started_at=now() WHERE id=$1`,[run.id]);
      expect(await runs.claimRunExecution({space_id:SPACE,run_id:run.id,started_at:new Date().toISOString()})).toEqual({outcome:'not_claimed',reason:'status_changed',status:'running'});
    }finally{await holder.query('ROLLBACK');holder.release();await pending;}
  });

  it('keeps stale defaults on the selected Host and reconciles withdrawn models without copying foreign profile settings',async()=>{
    const optional=await specialist(),compatible=randomUUID();
    await db.pool.query(`INSERT INTO agent_runtime_profiles SELECT (jsonb_populate_record(NULL::agent_runtime_profiles,to_jsonb(p)||$2::jsonb)).* FROM agent_runtime_profiles p WHERE id=$1`,[optional.runtime_profile_id,JSON.stringify({id:compatible,name:'Compatible CLI',is_default:false})]);
    await db.pool.query('UPDATE agent_runtime_profiles SET execution_host_id=$2 WHERE id=$1',[optional.runtime_profile_id,OTHER_HOST]);
    await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{installations,claude_code}',$2::jsonb,true) WHERE id=$1`,[HOST,JSON.stringify([{id:'managed:1.0.0',version:'1.0.0',logged_in:true,health_check_protocol:'acp',options:{session_available:true,config_options:[{id:'model',name:'Model',category:'model',type:'select',current_value:'current',options:[{value:'current'}]}]}}])]);
    const stale=[{id:'model',type:'select',category:'model',value:'withdrawn'}];
    await db.pool.query(`UPDATE rooms SET conversation_defaults_json=$2 WHERE id=(SELECT room_id FROM sessions WHERE id=$1)`,[SESSION,JSON.stringify([{agent_id:AGENT,participating:true,runtime_profile_id:RUNTIME,session_config:stale},{agent_id:optional.agent_id,participating:true,runtime_profile_id:optional.runtime_profile_id,session_config:stale}])]);
    const service=new ConversationExecutionContextService(db.pool),summary=await service.initialize(identity,SESSION,request);
    expect(summary.host!.host_id).toBe(HOST);
    expect(summary.runtimes.find(pin=>pin.agent_id===optional.agent_id)!.runtime_profile_id).toBe(compatible);
    expect(await new PgConversationBackendRepository(db.pool).sessionConfig(SPACE,SESSION,AGENT)).toEqual([]);
    expect(await new PgConversationBackendRepository(db.pool).sessionConfig(SPACE,SESSION,optional.agent_id)).toEqual([]);
    expect((await service.preview(identity,SESSION)).summary.can_send).toBe(true);
  });

});
