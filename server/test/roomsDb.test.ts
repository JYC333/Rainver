import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "../src/config";
import { RoomService } from "../src/modules/rooms/service";
import { PgRunRepository } from "../src/modules/runs/repository";
import { AgentGroupRunService } from "../src/modules/agentGroups/service";
import { PgSessionRepository } from "../src/modules/sessions/repository";
import { finalizeChatTurn } from "../src/modules/runs/chatTurnFinalizer";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let service: RoomService | undefined;
let groupService: AgentGroupRunService | undefined;
let available = false;
let testRoot: string | undefined;
let credentialOne: string;
let credentialTwo: string;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    const databaseUrl = database.getConnectionUri();
    pool = new Pool({ connectionString: databaseUrl });
    testRoot = await mkdtemp(join(tmpdir(), "agent-space-room-db-"));
    credentialOne = join(testRoot, "credential-one");
    credentialTwo = join(testRoot, "credential-two");
    await Promise.all([
      mkdir(credentialOne, { recursive: true }),
      mkdir(credentialTwo, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(credentialOne, ".credentials.json"), "{}"),
      writeFile(join(credentialTwo, ".credentials.json"), "{}"),
    ]);
    service = new RoomService(loadConfig({
      SERVER_DATABASE_URL: databaseUrl,
      AGENT_SPACE_HOME: testRoot,
    }), pool);
    groupService = new AgentGroupRunService(loadConfig({
      SERVER_DATABASE_URL: databaseUrl,
      AGENT_SPACE_HOME: testRoot,
    }), pool);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(
      `[rooms-db] skipped — Docker/Postgres unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!available || !pool) return;
  const now = new Date().toISOString();
  await pool.query("TRUNCATE spaces, users CASCADE");
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES
       ('user-1', 'Room Owner', 'active', $1, $1),
       ('user-2', 'Room Member', 'active', $1, $1),
       ('user-3', 'Outside Member', 'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ('space-1', 'Room Space', 'team', 'user-1', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO space_memberships (
       id, space_id, user_id, role, status, created_at, updated_at
     ) VALUES
       ('membership-1', 'space-1', 'user-1', 'owner', 'active', $1, $1),
       ('membership-2', 'space-1', 'user-2', 'member', 'active', $1, $1),
       ('membership-3', 'space-1', 'user-3', 'member', 'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO projects (
       id, space_id, owner_user_id, name, status, created_at, updated_at
     ) VALUES ('project-1', 'space-1', 'user-1', 'Room Project', 'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO project_members (
       id, space_id, project_id, user_id, role, status, created_at, updated_at
     ) VALUES (
       'project-member-2', 'space-1', 'project-1', 'user-2',
       'viewer', 'active', $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, name, status, created_by_user_id, kind,
       is_primary, execution_enabled, protected, system_managed,
       created_at, updated_at
     ) VALUES (
       'folder-1', 'space-1', 'project-1', 'Room Folder', 'active', 'user-1',
       'code', true, true, false, false, $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, agent_kind,
       current_version_id, visibility, created_at, updated_at
     ) VALUES (
       'agent-1', 'space-1', 'user-1', 'Room Manager', 'active',
       'standard', NULL, 'space_shared', $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES (
       'version-1', 'agent-1', 'space-1', 'v1', 'Coordinate the Room.',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $1
     )`,
    [now],
  );
  await pool.query(
    "UPDATE agents SET current_version_id = 'version-1' WHERE id = 'agent-1'",
  );
  await pool.query(
    `INSERT INTO actors (
       id, space_id, actor_type, user_id, agent_id, service_name,
       display_name, status, metadata_json, created_at, updated_at
     ) VALUES (
       'agent-1', 'space-1', 'agent', NULL, 'agent-1', NULL,
       'Room Manager', 'active', '{}'::jsonb, $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, runtime_config_json,
       runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES (
       'runtime-cli', 'space-1', 'agent-1', 'Subscription',
       'claude_code', '{}'::jsonb, '{}'::jsonb, true, true, $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO cli_credential_profiles (
       id, owner_user_id, runtime, name, source_path, target_path,
       readonly, notes, created_at, updated_at
     ) VALUES
       ('credential-user-1', 'user-1', 'claude_code', 'Owner login',
        $2, '.claude', true, '', $1, $1),
       ('credential-user-2', 'user-2', 'claude_code', 'Member login',
        $3, '.claude', true, '', $1, $1)`,
    [now, credentialOne, credentialTwo],
  );
  await pool.query(
    `INSERT INTO cli_credential_space_grants (
       id, profile_id, space_id, owner_user_id, granted_by_user_id,
       enabled, is_default, created_at, updated_at
     ) VALUES
       ('grant-user-1', 'credential-user-1', 'space-1', 'user-1', 'user-1',
        true, true, $1, $1),
       ('grant-user-2', 'credential-user-2', 'space-1', 'user-2', 'user-1',
        true, true, $1, $1)`,
    [now],
  );
});

describe("Room workflow (real Postgres)", () => {
  it("enforces Project ACL when creating and continuing a Room", async () => {
    if (!available || !pool || !service || !groupService) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    await expect(service.createRoom(owner, {
      project_id: "project-1",
      title: "Inaccessible roster",
      manager_agent_id: "agent-1",
      agent_ids: [],
      user_ids: ["user-3"],
    })).rejects.toMatchObject({ statusCode: 404 });

    const created = await service.createRoom(owner, {
      project_id: "project-1",
      project_folder_id: "folder-1",
      title: "ACL Room",
      manager_agent_id: "agent-1",
      agent_ids: [],
      user_ids: ["user-2"],
    });
    const conversation = await service.createConversation(
      member,
      created.room.id,
      { title: "Before revocation" },
    );
    expect(conversation.project_folder_id).toBe("folder-1");
    const sessions = new PgSessionRepository(pool);
    await expect(
      sessions.getConversationForBackendSelection(
        "space-1",
        "user-2",
        conversation.id,
      ),
    ).resolves.toMatchObject({ id: conversation.id, room_id: created.room.id });
    await expect(sessions.getSession("space-1", "user-2", conversation.id))
      .resolves.toBeNull();
    await expect(sessions.listMessages(
      "space-1",
      "user-2",
      conversation.id,
      20,
      0,
    )).resolves.toBeNull();
    await expect(sessions.addMessage(
      "space-1",
      "user-2",
      conversation.id,
      { role: "user", content: "Generic Session writes must reject Room." },
    )).resolves.toBeNull();
    await expect(sessions.reflectSession("space-1", "user-2", conversation.id))
      .resolves.toBeNull();
    const dispatched = await service.sendMessage(
      member,
      created.room.id,
      conversation.id,
      {
        content: "Create a member-owned task before revocation.",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
          credential_profile_id: "credential-user-2",
        }],
      },
    );
    const groupId = dispatched.task_group_ids[0]!;
    const runId = dispatched.run_ids[0]!;
    await expect(pool.query<{ project_folder_id: string | null }>(
      "SELECT project_folder_id FROM runs WHERE id = $1",
      [runId],
    )).resolves.toMatchObject({
      rows: [{ project_folder_id: "folder-1" }],
    });
    const runRepository = new PgRunRepository(pool);
    const queuedRun = await runRepository.getRun("space-1", runId);
    expect(queuedRun).not.toBeNull();
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toEqual({ allowed: true });
    await pool.query(
      `UPDATE project_folders
          SET execution_enabled = FALSE, updated_at = now()
        WHERE space_id = 'space-1' AND id = 'folder-1'`,
    );
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toMatchObject({
        allowed: false,
        error_code: "run_execution_authorization_revoked",
      });
    await pool.query(
      `UPDATE project_folders
          SET execution_enabled = TRUE, updated_at = now()
        WHERE space_id = 'space-1' AND id = 'folder-1'`,
    );
    await pool.query(
      `UPDATE project_members
          SET status = 'revoked', updated_at = now()
        WHERE space_id = 'space-1'
          AND project_id = 'project-1'
          AND user_id = 'user-2'`,
    );

    await expect(service.getRoom(member, created.room.id))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(
      sessions.getConversationForBackendSelection(
        "space-1",
        "user-2",
        conversation.id,
      ),
    ).resolves.toBeNull();
    await expect(service.listRooms(member, { limit: 20, offset: 0 }))
      .resolves.toMatchObject({ total: 0, items: [] });
    await expect(service.sendMessage(member, created.room.id, conversation.id, {
      content: "This must be rejected.",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.getTimeline(member, groupId, { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.updateGroup(member, {
      space_id: "space-1",
      group_id: groupId,
      title: "Must not update",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.changeStatus(member, groupId, "cancelled"))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.sendUserMessage(member, {
      space_id: "space-1",
      group_id: groupId,
      content: "Must not extend",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.listGroups(member, { limit: 20, offset: 0 }))
      .resolves.toMatchObject({ items: [], total: 0 });
    await expect(new PgRunRepository(pool).getVisibleRun("space-1", "user-2", runId))
      .resolves.toBeNull();
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toMatchObject({
        allowed: false,
        error_code: "run_execution_authorization_revoked",
      });

    await pool.query(
      `UPDATE runs
          SET status = 'succeeded',
              output_json = $2::jsonb,
              ended_at = now(),
              updated_at = now()
        WHERE space_id = 'space-1' AND id = $1`,
      [
        runId,
        JSON.stringify({
          schema_version: "run_output.v1",
          status: "succeeded",
          summary: "Result persisted after speaker revocation.",
          result: {},
          output_manifest: [],
        }),
      ],
    );
    const terminalRun = await runRepository.getRun("space-1", runId);
    expect(terminalRun).not.toBeNull();
    const finalizerConfig = loadConfig({
      SERVER_DATABASE_URL: database!.getConnectionUri(),
      AGENT_SPACE_HOME: testRoot,
    });
    const continuity = {
      async finalizeChatTurn() {
        return { space_id: "space-1", work_context_scope_id: runId } as never;
      },
      async runSemanticExtraction() { return null; },
    };
    await expect(finalizeChatTurn(
      finalizerConfig,
      runRepository,
      terminalRun!,
      {
        loadActionPreviews: async () => [],
        continuity,
      },
    )).resolves.toMatchObject({ ok: true });
    await expect(finalizeChatTurn(
      finalizerConfig,
      runRepository,
      terminalRun!,
      {
        loadActionPreviews: async () => [],
        continuity,
      },
    )).resolves.toBeNull();
    const ownerMessages = await service.listMessages(
      owner,
      created.room.id,
      conversation.id,
      { limit: 20, offset: 0 },
    );
    expect(ownerMessages.items.filter((message) =>
      message.metadata_json?.run_id === runId
    )).toHaveLength(1);
    await expect(service.listMessages(
      member,
      created.room.id,
      conversation.id,
      { limit: 20, offset: 0 },
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets Room members read another speaker's task but not manage or extend it", async () => {
    if (!available || !service || !groupService) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Task authority Room",
      manager_agent_id: "agent-1",
      agent_ids: [],
      user_ids: ["user-2"],
    });
    const conversation = await service.createConversation(
      owner,
      created.room.id,
      { title: "Task ownership" },
    );
    const dispatched = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Owner task.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      }],
    });
    const groupId = dispatched.task_group_ids[0]!;

    await expect(groupService.getTimeline(member, groupId, { limit: 20, offset: 0 }))
      .resolves.toMatchObject({ group: { id: groupId } });
    await expect(groupService.updateGroup(member, {
      space_id: "space-1",
      group_id: groupId,
      title: "Hijacked",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.changeStatus(member, groupId, "cancelled"))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.sendUserMessage(member, {
      space_id: "space-1",
      group_id: groupId,
      content: "Extend the old task.",
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("opens one auditable task per message under the speaking user's CLI identity", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Delivery Room",
      manager_agent_id: "agent-1",
      agent_ids: [],
      user_ids: ["user-2"],
    });
    const conversation = await service.createConversation(
      owner,
      created.room.id,
      { title: "Main thread" },
    );
    const secondConversation = await service.createConversation(
      member,
      created.room.id,
      { title: "Follow-up" },
    );

    const first = await service.sendMessage(
      owner,
      created.room.id,
      conversation.id,
      {
        content: "Prepare the first result.",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
          credential_profile_id: "credential-user-1",
        }],
      },
    );
    const second = await service.sendMessage(
      member,
      created.room.id,
      conversation.id,
      {
        content: "Review it from my account.",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
          credential_profile_id: "credential-user-2",
        }],
      },
    );

    expect(first.task_group_ids).toHaveLength(1);
    expect(second.task_group_ids).toHaveLength(1);
    expect(second.task_group_ids[0]).not.toBe(first.task_group_ids[0]);
    expect(secondConversation.id).not.toBe(conversation.id);
    await expect(service.listRooms(member, { limit: 20, offset: 0 })).resolves
      .toMatchObject({ total: 1 });
    await expect(
      service.getRoom({ spaceId: "space-1", userId: "user-3" }, created.room.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    const tasks = await pool.query<{
      id: string;
      manager_user_id: string;
      room_id: string;
      session_id: string;
      project_id: string;
      trigger_message_id: string;
    }>(
      `SELECT id, manager_user_id, room_id, session_id, project_id,
              trigger_message_id
         FROM agent_run_groups
        WHERE room_id = $1
        ORDER BY created_at ASC, id ASC`,
      [created.room.id],
    );
    expect(tasks.rows).toHaveLength(2);
    expect(tasks.rows.map((row) => row.manager_user_id).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(tasks.rows.every((row) =>
      row.room_id === created.room.id &&
      row.session_id === conversation.id &&
      row.project_id === "project-1" &&
      Boolean(row.trigger_message_id)
    )).toBe(true);

    const runs = await pool.query<{
      instructed_by_user_id: string;
      session_id: string;
      project_id: string;
      run_group_id: string;
      required_outputs: unknown;
      message_cursor_id: string | null;
      visibility: string;
      agent_version_id: string | null;
    }>(
      `SELECT instructed_by_user_id, session_id, project_id, run_group_id,
              contract_snapshot_json->'required_outputs_json' AS required_outputs,
              model_override_json->'conversation_runtime'->>'message_cursor_id'
                AS message_cursor_id,
              model_override_json->'chat_turn'->>'agent_version_id'
                AS agent_version_id,
              visibility
         FROM runs
        WHERE run_group_id = ANY($1::varchar[])
        ORDER BY created_at ASC, id ASC`,
      [tasks.rows.map((row) => row.id)],
    );
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows.map((row) => row.instructed_by_user_id).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(runs.rows.every((row) =>
      row.session_id === conversation.id &&
      row.project_id === "project-1" &&
      row.visibility === "selected_users" &&
      row.agent_version_id === "version-1" &&
      Boolean(row.message_cursor_id) &&
      Array.isArray(row.required_outputs) &&
      row.required_outputs.some((output) =>
        typeof output === "object" &&
        output !== null &&
        (output as { name?: unknown }).name === "conversation_capture"
      )
    )).toBe(true);
    const runAccess = new PgRunRepository(pool);
    await expect(
      runAccess.getVisibleRun("space-1", "user-2", first.run_ids[0]!),
    ).resolves.toMatchObject({ id: first.run_ids[0] });
    await expect(
      runAccess.getVisibleRun("space-1", "user-3", first.run_ids[0]!),
    ).resolves.toBeNull();

    const bindings = await pool.query<{
      user_id: string;
      credential_profile_id: string;
      agent_id: string;
    }>(
      `SELECT user_id, credential_profile_id, agent_id
         FROM session_conversation_backends
        WHERE session_id = $1
        ORDER BY user_id ASC`,
      [conversation.id],
    );
    expect(bindings.rows).toEqual([
      {
        user_id: "user-1",
        credential_profile_id: "credential-user-1",
        agent_id: "agent-1",
      },
      {
        user_id: "user-2",
        credential_profile_id: "credential-user-2",
        agent_id: "agent-1",
      },
    ]);
  });

  it("keeps healthy CLI state stable as bounded raw history advances", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Resume Room",
      manager_agent_id: "agent-1",
      agent_ids: [],
      user_ids: ["user-2"],
    });
    const conversation = await service.createConversation(
      owner,
      created.room.id,
      { title: "Resume thread" },
    );
    const first = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Start the shared analysis.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      }],
    });
    const firstRun = await pool.query<{
      id: string;
      context_fingerprint: string;
      binding_id: string;
      runtime_state_key: string;
    }>(
      `SELECT id,
              model_override_json->'conversation_runtime'->>'context_fingerprint'
                AS context_fingerprint,
              model_override_json->'conversation_runtime'->>'binding_id' AS binding_id,
              model_override_json->'conversation_runtime'->>'runtime_state_key'
                AS runtime_state_key
         FROM runs
        WHERE id = $1`,
      [first.run_ids[0]],
    );
    const firstRuntime = firstRun.rows[0]!;
    await pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now()
        WHERE id = $1`,
      [firstRuntime.id],
    );
    await pool.query(
      `UPDATE messages
          SET created_at = '2026-01-01T00:00:00.000Z'
        WHERE id = $1`,
      [first.message.id],
    );
    await pool.query(
      `UPDATE session_conversation_backends
          SET runtime_session_id = 'vendor-session-1',
              runtime_context_fingerprint = $2,
              runtime_message_cursor_id = $3,
              runtime_session_updated_at = now(),
              updated_at = now()
        WHERE id = $1 AND runtime_state_key = $4`,
      [
        firstRuntime.binding_id,
        firstRuntime.context_fingerprint,
        first.message.id,
        firstRuntime.runtime_state_key,
      ],
    );
    await pool.query(
      `INSERT INTO messages (
         id, space_id, session_id, user_id, sender_agent_id, role,
         content, metadata_json, created_at
       ) VALUES (
         'agent-message-1', 'space-1', $1, NULL, 'agent-1', 'assistant',
         'My own prior answer.', jsonb_build_object('run_id', $2::text),
         '2026-01-01T00:00:01.000Z'
       )`,
      [conversation.id, firstRuntime.id],
    );
    await pool.query(
      `INSERT INTO messages (
         id, space_id, session_id, user_id, sender_agent_id, role,
         content, metadata_json, created_at
       )
       SELECT 'bulk-' || lpad(value::text, 3, '0'),
              'space-1', $1, 'user-2', NULL, 'user',
              'Bulk Room context ' || value::text,
              '{}'::jsonb,
              '2026-01-01T00:00:02.000Z'::timestamptz
                + value * interval '1 millisecond'
         FROM generate_series(0, 84) value`,
      [conversation.id],
    );
    const memberTurn = await service.sendMessage(member, created.room.id, conversation.id, {
      content: "Add the member-specific constraint.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-2",
      }],
    });
    await pool.query(
      `INSERT INTO messages (
         id, space_id, session_id, user_id, sender_agent_id, role,
         content, metadata_json, created_at
       ) VALUES (
         'agent-message-2', 'space-1', $1, NULL, 'agent-1', 'assistant',
         'Member-owned answer from the same agent.',
         jsonb_build_object('run_id', $2::text), now()
       )`,
      [conversation.id, memberTurn.run_ids[0]],
    );
    const resumed = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Continue with the new constraint.",
      recipient_segments: [{
        recipient_agent_ids: ["agent-1"],
        content: "Apply the owner-specific assigned constraint.",
      }],
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      }],
    });
    const resumedRun = await pool.query<{
      prompt: string;
      runtime_session_id: string | null;
      replay_prompt: string;
      context_fingerprint: string;
    }>(
      `SELECT prompt,
              model_override_json->'conversation_runtime'->>'runtime_session_id'
                AS runtime_session_id,
              model_override_json->'conversation_runtime'->>'replay_prompt'
                AS replay_prompt,
              model_override_json->'conversation_runtime'->>'context_fingerprint'
                AS context_fingerprint
         FROM runs
        WHERE id = $1`,
      [resumed.run_ids[0]],
    );

    expect(resumedRun.rows[0]?.runtime_session_id).toBe("vendor-session-1");
    expect(resumedRun.rows[0]?.context_fingerprint)
      .toBe(firstRuntime.context_fingerprint);
    expect(resumedRun.rows[0]?.prompt).toBe("Apply the owner-specific assigned constraint.");
    expect(resumedRun.rows[0]?.replay_prompt).toContain("Bulk Room context 84");
    expect(resumedRun.rows[0]?.replay_prompt).toContain("Member-owned answer from the same agent.");
    expect(resumedRun.rows[0]?.replay_prompt).toContain("Continue with the new constraint.");
    expect(resumedRun.rows[0]?.replay_prompt).not.toContain("Start the shared analysis.");
    expect(resumedRun.rows[0]?.replay_prompt)
      .toContain("Apply the owner-specific assigned constraint.");
  });

  it("rejects duplicate recipient runs before persisting a Room turn", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Single recipient Room",
      manager_agent_id: "agent-1",
      agent_ids: [],
      user_ids: [],
    });
    const conversation = await service.createConversation(
      owner,
      created.room.id,
      { title: "Concurrent safety" },
    );

    await expect(service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Run two overlapping segments.",
      recipient_segments: [
        { recipient_agent_ids: ["agent-1"], content: "First segment." },
        { recipient_agent_ids: ["agent-1"], content: "Second segment." },
      ],
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      }],
    })).rejects.toMatchObject({ statusCode: 422 });

    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM messages
        WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_run_groups
        WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("rejects task links that cross Room conversation aggregates", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const firstRoom = await service.createRoom(owner, {
      project_id: "project-1",
      title: "First aggregate",
      manager_agent_id: "agent-1",
      agent_ids: [],
      user_ids: [],
    });
    const secondRoom = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Second aggregate",
      manager_agent_id: "agent-1",
      agent_ids: [],
      user_ids: [],
    });
    const firstConversation = await service.createConversation(
      owner,
      firstRoom.room.id,
      { title: "First conversation" },
    );
    const secondConversation = await service.createConversation(
      owner,
      secondRoom.room.id,
      { title: "Second conversation" },
    );
    const firstTask = await service.sendMessage(
      owner,
      firstRoom.room.id,
      firstConversation.id,
      { content: "First task." },
    );
    const secondTask = await service.sendMessage(
      owner,
      secondRoom.room.id,
      secondConversation.id,
      { content: "Second task." },
    );

    await expect(pool.query(
      `UPDATE agent_run_groups SET room_id = $2 WHERE id = $1`,
      [firstTask.task_group_ids[0], secondRoom.room.id],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `UPDATE agent_run_groups SET trigger_message_id = $2 WHERE id = $1`,
      [firstTask.task_group_ids[0], secondTask.message.id],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `UPDATE runs SET session_id = $2 WHERE id = $1`,
      [firstTask.run_ids[0], secondConversation.id],
    )).rejects.toMatchObject({ code: "23503" });
  });
});
