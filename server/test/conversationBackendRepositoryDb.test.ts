import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import {
  ConversationBackendError,
  PgConversationBackendRepository,
} from "../src/modules/sessions/conversationBackendRepository";
import {
  ConversationTurnInProgressError,
  PgConversationRuntimeSessionRepository,
} from "../src/modules/sessions/conversationRuntimeSessionRepository";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository";
import { PgRunRepository } from "../src/modules/runs/repository";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let repository: PgConversationBackendRepository | undefined;
let available = false;
const loggedInProfileIds = new Set<string>();

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri() });
    const testPool = pool;
    repository = new PgConversationBackendRepository(testPool, {
      availableProfiles: async (spaceId, userId) => {
        const result = await testPool.query<{ id: string }>(
          `SELECT profile.id
             FROM cli_credential_space_grants credential_grant
             JOIN cli_credential_profiles profile
               ON profile.id = credential_grant.profile_id
            WHERE credential_grant.space_id = $1
              AND credential_grant.owner_user_id = $2
              AND credential_grant.enabled = true`,
          [spaceId, userId],
        );
        return result.rows.map((row) => ({
          id: row.id,
          logged_in: loggedInProfileIds.has(row.id),
        }));
      },
    });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(
      `[conversation-backend-db] skipped — Docker/Postgres unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  loggedInProfileIds.clear();
  loggedInProfileIds.add("credential-user-1");
  loggedInProfileIds.add("credential-user-2");
  const now = new Date().toISOString();
  await resetTables(pool, ["spaces", "users"], { cascade: true });
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES
       ('user-1', 'Conversation Owner', 'active', $1, $1),
       ('user-2', 'Other Member', 'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ('space-1', 'Conversation Space', 'team', 'user-1', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, agent_kind,
       current_version_id, visibility, created_at, updated_at
     ) VALUES (
       'agent-1', 'space-1', 'user-1', 'Shared Assistant', 'active',
       'standard', NULL, 'space_shared', $1, $1
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
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES (
       'version-1', 'agent-1', 'space-1', 'v1', 'Be useful.',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $1
     )`,
    [now],
  );
  await pool.query(
    "UPDATE agents SET current_version_id = 'version-1' WHERE id = 'agent-1'",
  );
  await pool.query(
    `INSERT INTO cli_credential_profiles (
       id, owner_user_id, runtime, name, source_path, target_path,
       readonly, notes, created_at, updated_at
     ) VALUES
       ('credential-user-1', 'user-1', 'claude_code', 'Owner login',
        '/outside/one', '.claude', true, '', $1, $1),
       ('credential-user-2', 'user-2', 'claude_code', 'Other login',
        '/outside/two', '.claude', true, '', $1, $1)`,
    [now],
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
  await pool.query(
    `INSERT INTO sessions (
       id, space_id, user_id, agent_id, title, status, created_at, updated_at
     ) VALUES (
       'session-1', 'space-1', 'user-1', 'agent-1', 'Thread', 'active', $1, $1
     )`,
    [now],
  );
});

describe("PgConversationBackendRepository (real Postgres)", () => {
  it("lists and persists only the signed-in user's CLI credential", async () => {
    if (!available || !repository || !pool) return;

    expect(await repository.listOptions("space-1", "user-1", "agent-1")).toEqual([
      expect.objectContaining({
        runtime_profile_id: "runtime-cli",
        adapter_type: "claude_code",
        credential_profiles: [{
          id: "credential-user-1",
          name: "Owner login",
          is_default: true,
        }],
      }),
    ]);

    const binding = await repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
      requested: {
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      },
    });
    expect(binding).toMatchObject({
      runtime_profile_id: "runtime-cli",
      adapter_type: "claude_code",
      credential_profile_id: "credential-user-1",
      binding_id: expect.any(String),
      runtime_state_key: expect.any(String),
      runtime_session_id: null,
      runtime_context_fingerprint: null,
      model_name: null,
    });
    expect(
      await repository.findBinding("space-1", "user-1", "session-1", "agent-1"),
    ).toEqual({
      runtime_profile_id: "runtime-cli",
      adapter_type: "claude_code",
      credential_profile_id: "credential-user-1",
    });
    expect(
      await pool.query(
        `SELECT runtime_profile_id, credential_profile_id
           FROM session_conversation_backends
          WHERE session_id = 'session-1' AND user_id = 'user-1'`,
      ),
    ).toMatchObject({
      rows: [{
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      }],
    });
  });

  it("records an opaque runtime session and rotates isolated state when context changes", async () => {
    if (!available || !repository || !pool) return;
    const runtimeSessions = new PgConversationRuntimeSessionRepository(pool);
    const binding = await repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
      requested: {
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      },
    });

    expect(await runtimeSessions.record({
      binding_id: binding.binding_id,
      runtime_state_key: binding.runtime_state_key,
      runtime_session_id: "ses_opaque-runtime-id",
      context_fingerprint: "fingerprint-a",
    })).toBe(true);
    await expect(runtimeSessions.prepare({
      binding_id: binding.binding_id,
      space_id: "space-1",
      session_id: "session-1",
      user_id: "user-1",
      agent_id: "agent-1",
      runtime_state_key: binding.runtime_state_key,
      context_fingerprint: "fingerprint-a",
    })).resolves.toMatchObject({
      runtime_state_key: binding.runtime_state_key,
      runtime_session_id: "ses_opaque-runtime-id",
      runtime_context_fingerprint: "fingerprint-a",
    });

    const invalidated = await runtimeSessions.prepare({
      binding_id: binding.binding_id,
      space_id: "space-1",
      session_id: "session-1",
      user_id: "user-1",
      agent_id: "agent-1",
      runtime_state_key: binding.runtime_state_key,
      context_fingerprint: "fingerprint-b",
    });
    expect(invalidated).toMatchObject({
      runtime_session_id: null,
      runtime_context_fingerprint: null,
      retired_runtime_state_key: binding.runtime_state_key,
    });
    expect(invalidated.runtime_state_key).not.toBe(binding.runtime_state_key);
    expect(await runtimeSessions.record({
      binding_id: binding.binding_id,
      runtime_state_key: binding.runtime_state_key,
      runtime_session_id: "stale-session",
      context_fingerprint: "fingerprint-a",
    })).toBe(false);

    expect(await runtimeSessions.record({
      binding_id: invalidated.binding_id,
      runtime_state_key: invalidated.runtime_state_key,
      runtime_session_id: "session-before-backend-switch",
      context_fingerprint: "fingerprint-b",
    })).toBe(true);
    await pool.query(
      `INSERT INTO cli_credential_profiles (
         id, owner_user_id, runtime, name, source_path, target_path,
         readonly, notes, created_at, updated_at
       ) VALUES (
         'credential-user-1b', 'user-1', 'claude_code', 'Second owner login',
         '/outside/one-b', '.claude', true, '', now(), now()
       );
       INSERT INTO cli_credential_space_grants (
         id, profile_id, space_id, owner_user_id, granted_by_user_id,
         enabled, is_default, created_at, updated_at
       ) VALUES (
         'grant-user-1b', 'credential-user-1b', 'space-1', 'user-1', 'user-1',
         true, false, now(), now()
       )`,
    );
    loggedInProfileIds.add("credential-user-1b");
    const switched = await repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
      requested: {
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1b",
      },
    });
    expect(switched).toMatchObject({
      binding_id: binding.binding_id,
      credential_profile_id: "credential-user-1b",
      runtime_session_id: null,
      runtime_context_fingerprint: null,
      retired_runtime_state_key: invalidated.runtime_state_key,
    });
    expect(switched.runtime_state_key).not.toBe(invalidated.runtime_state_key);
  });

  it("rejects a second turn while the user's previous chat Run is active", async () => {
    if (!available || !pool) return;
    const runs = new PgRunRepository(pool);
    await runs.createQueuedRun({
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      runtime_profile_id: "runtime-cli",
      runtime_profile_selection_source: "explicit",
      session_id: "session-1",
      prompt: "first turn",
      model_override_json: {
        chat_turn: {
          schema_version: "chat_turn.v1",
          user_id: "user-1",
        },
      },
    });

    await expect(new PgConversationRuntimeSessionRepository(pool).claimTurn({
      space_id: "space-1",
      session_id: "session-1",
      user_id: "user-1",
    })).rejects.toEqual(expect.objectContaining({
      name: ConversationTurnInProgressError.name,
      statusCode: 409,
    }));
  });

  it("atomically invalidates the conversation binding with terminal Run visibility", async () => {
    if (!available || !repository || !pool) return;
    const binding = await repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
      requested: {
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      },
    });
    const runtimeSessions = new PgConversationRuntimeSessionRepository(pool);
    await runtimeSessions.record({
      binding_id: binding.binding_id,
      runtime_state_key: binding.runtime_state_key,
      runtime_session_id: "session-before-failure",
      context_fingerprint: "fingerprint-before-failure",
    });
    const runs = new PgRunRepository(pool);
    const queued = await runs.createQueuedRun({
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      runtime_profile_id: "runtime-cli",
      runtime_profile_selection_source: "explicit",
      session_id: "session-1",
      prompt: "failing turn",
      model_override_json: {
        conversation_runtime: {
          schema_version: "conversation_runtime.v1",
          binding_id: binding.binding_id,
          runtime_state_key: binding.runtime_state_key,
          runtime_session_id: "session-before-failure",
          context_fingerprint: "fingerprint-before-failure",
          replay_prompt: "failing turn",
        },
      },
    });

    await expect(runs.markRunTerminalWithConversationSession({
      run_id: queued.id,
      space_id: "space-1",
      status: "failed",
      output_json: {},
      error_json: { error_code: "test_failure" },
      exit_code: 1,
      completed_at: new Date().toISOString(),
    }, {
      binding_id: binding.binding_id,
      runtime_state_key: binding.runtime_state_key,
      keep_session: false,
      runtime_session_id: null,
      context_fingerprint: null,
    })).resolves.toMatchObject({ status: "failed" });

    const persisted = await pool.query<{
      status: string;
      runtime_state_key: string;
      runtime_session_id: string | null;
      run_state_key: string;
    }>(
      `SELECT run_row.status, binding.runtime_state_key, binding.runtime_session_id,
              run_row.model_override_json->'conversation_runtime'->>'runtime_state_key'
                AS run_state_key
         FROM runs run_row
         JOIN session_conversation_backends binding
           ON binding.id = $2
        WHERE run_row.id = $1`,
      [queued.id, binding.binding_id],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "failed",
      runtime_session_id: null,
    });
    expect(persisted.rows[0]?.runtime_state_key).not.toBe(binding.runtime_state_key);
    expect(persisted.rows[0]?.run_state_key).toBe(persisted.rows[0]?.runtime_state_key);

    const retryStateKey = persisted.rows[0]!.runtime_state_key;
    await runs.requeueRunForRetry({
      run_id: queued.id,
      space_id: "space-1",
      updated_at: new Date().toISOString(),
      reason_code: "test_failure",
      attempt_number: 2,
    });
    await runs.markRunRunning({
      run_id: queued.id,
      space_id: "space-1",
      started_at: new Date().toISOString(),
    });
    await expect(runs.markRunTerminalWithConversationSession({
      run_id: queued.id,
      space_id: "space-1",
      status: "succeeded",
      output_json: {},
      error_json: {},
      exit_code: 0,
      completed_at: new Date().toISOString(),
    }, {
      binding_id: binding.binding_id,
      runtime_state_key: retryStateKey,
      keep_session: true,
      runtime_session_id: "session-after-retry",
      context_fingerprint: "fingerprint-before-failure",
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(pool.query<{
      status: string;
      runtime_state_key: string;
      runtime_session_id: string | null;
    }>(
      `SELECT run_row.status, binding.runtime_state_key, binding.runtime_session_id
         FROM runs run_row
         JOIN session_conversation_backends binding ON binding.id = $2
        WHERE run_row.id = $1`,
      [queued.id, binding.binding_id],
    )).resolves.toMatchObject({
      rows: [{
        status: "succeeded",
        runtime_state_key: retryStateKey,
        runtime_session_id: "session-after-retry",
      }],
    });
  });

  it("allows only the winning terminal update to mutate the runtime binding", async () => {
    if (!available || !repository || !pool) return;
    const binding = await repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
      requested: {
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      },
    });
    const runs = new PgRunRepository(pool);
    const queued = await runs.createQueuedRun({
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      runtime_profile_id: "runtime-cli",
      runtime_profile_selection_source: "explicit",
      session_id: "session-1",
      prompt: "racing turn",
    });
    const completedAt = new Date().toISOString();
    const [success, cancellation] = await Promise.all([
      runs.markRunTerminalWithConversationSession({
        run_id: queued.id,
        space_id: "space-1",
        status: "succeeded",
        output_json: {},
        error_json: {},
        exit_code: 0,
        completed_at: completedAt,
      }, {
        binding_id: binding.binding_id,
        runtime_state_key: binding.runtime_state_key,
        keep_session: true,
        runtime_session_id: "winning-success-session",
        context_fingerprint: "winning-fingerprint",
      }),
      runs.markRunTerminalWithConversationSession({
        run_id: queued.id,
        space_id: "space-1",
        status: "cancelled",
        output_json: {},
        error_json: { error_code: "run_cancelled" },
        exit_code: 1,
        completed_at: completedAt,
      }, {
        binding_id: binding.binding_id,
        runtime_state_key: binding.runtime_state_key,
        keep_session: false,
        runtime_session_id: null,
        context_fingerprint: null,
      }),
    ]);
    expect([success, cancellation].filter(Boolean)).toHaveLength(1);

    const persisted = await pool.query<{
      status: string;
      runtime_state_key: string;
      runtime_session_id: string | null;
    }>(
      `SELECT run_row.status, binding.runtime_state_key, binding.runtime_session_id
         FROM runs run_row
         JOIN session_conversation_backends binding ON binding.id = $2
        WHERE run_row.id = $1`,
      [queued.id, binding.binding_id],
    );
    if (persisted.rows[0]?.status === "succeeded") {
      expect(persisted.rows[0]).toEqual({
        status: "succeeded",
        runtime_state_key: binding.runtime_state_key,
        runtime_session_id: "winning-success-session",
      });
    } else {
      expect(persisted.rows[0]?.status).toBe("cancelled");
      expect(persisted.rows[0]?.runtime_state_key).not.toBe(binding.runtime_state_key);
      expect(persisted.rows[0]?.runtime_session_id).toBeNull();
    }
  });

  it("terminates an old Run without overwriting a binding that has moved to new state", async () => {
    if (!available || !repository || !pool) return;
    const binding = await repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
      requested: {
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      },
    });
    const runs = new PgRunRepository(pool);
    const queued = await runs.createQueuedRun({
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      runtime_profile_id: "runtime-cli",
      runtime_profile_selection_source: "explicit",
      session_id: "session-1",
      prompt: "old turn",
    });
    const replacementStateKey = randomUUID();
    await pool.query(
      `UPDATE session_conversation_backends
          SET runtime_state_key = $2
        WHERE id = $1`,
      [binding.binding_id, replacementStateKey],
    );

    await expect(runs.markRunTerminalWithConversationSession({
      run_id: queued.id,
      space_id: "space-1",
      status: "failed",
      output_json: {},
      error_json: { error_code: "stale_turn_failure" },
      exit_code: 1,
      completed_at: new Date().toISOString(),
    }, {
      binding_id: binding.binding_id,
      runtime_state_key: binding.runtime_state_key,
      keep_session: false,
      runtime_session_id: null,
      context_fingerprint: null,
    })).resolves.toMatchObject({ status: "failed" });

    const persisted = await pool.query<{
      status: string;
      runtime_state_key: string;
    }>(
      `SELECT run_row.status, binding.runtime_state_key
         FROM runs run_row
         JOIN session_conversation_backends binding
           ON binding.id = $2
        WHERE run_row.id = $1`,
      [queued.id, binding.binding_id],
    );
    expect(persisted.rows[0]).toEqual({
      status: "failed",
      runtime_state_key: replacementStateKey,
    });
  });

  it("rejects another member's credential instead of falling back", async () => {
    if (!available || !repository) return;
    await expect(repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
      requested: {
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-2",
      },
    })).rejects.toEqual(expect.objectContaining({
      name: ConversationBackendError.name,
      statusCode: 403,
    }));
  });

  it("hides logged-out credentials and refuses to silently replace a stale binding", async () => {
    if (!available || !repository) return;
    await repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
      requested: {
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      },
    });

    loggedInProfileIds.delete("credential-user-1");
    expect(await repository.listOptions("space-1", "user-1", "agent-1")).toEqual([]);
    await expect(repository.resolveBinding({
      space_id: "space-1",
      user_id: "user-1",
      session_id: "session-1",
      agent_id: "agent-1",
    })).rejects.toEqual(expect.objectContaining({
      name: ConversationBackendError.name,
      statusCode: 409,
    }));
  });

  it("routes CLI capacity through the Run owner's grant and honors an explicit credential", async () => {
    if (!available || !pool) return;
    const routing = new PgRouteDecisionRepository(pool, undefined, {
      availableProfiles: async () => [
        { id: "credential-user-1", logged_in: true },
      ],
    });

    const ownerCandidates = await routing.listCandidates(
      "space-1",
      "agent-1",
      "user-1",
      "credential-user-1",
    );
    expect(ownerCandidates).toEqual([
      expect.objectContaining({
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
        credential_available: true,
      }),
    ]);
    expect(
      await routing.listCandidates(
        "space-1",
        "agent-1",
        "user-1",
        "credential-user-2",
      ),
    ).toEqual([]);

    const runs = new PgRunRepository(pool);
    const queued = await runs.createQueuedRun({
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      runtime_profile_id: "runtime-cli",
      runtime_profile_selection_source: "explicit",
      session_id: "session-1",
      prompt: "hello",
      model_override_json: {
        conversation_backend: {
          schema_version: "conversation_backend.v1",
          runtime_profile_id: "runtime-cli",
          adapter_type: "claude_code",
          credential_profile_id: "credential-user-1",
        },
      },
    });
    await routing.routeRun(queued);
    const stamped = await pool.query<{ runtime_profile_snapshot_json: unknown }>(
      "SELECT runtime_profile_snapshot_json FROM runs WHERE id = $1",
      [queued.id],
    );
    expect(stamped.rows[0]?.runtime_profile_snapshot_json).toMatchObject({
      credential_profile_id: "credential-user-1",
      runtime_config_json: {
        credential_profile_id: "credential-user-1",
      },
    });
  });
});
