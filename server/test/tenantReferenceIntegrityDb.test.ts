import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const USER = "tenant-integrity-user";
const SPACE_A = "tenant-integrity-space-a";
const SPACE_B = "tenant-integrity-space-b";
const PROJECT_A = "tenant-integrity-project-a";
const PROJECT_B = "tenant-integrity-project-b";
const AGENT_A = "tenant-integrity-agent-a";
const AGENT_B = "tenant-integrity-agent-b";
const VERSION_A = "tenant-integrity-version-a";
const VERSION_B = "tenant-integrity-version-b";
const SOURCE_A = "tenant-integrity-source-a";
const SOURCE_B = "tenant-integrity-source-b";
const OPERATION_B = "tenant-integrity-operation-b";
const RUN_A = "tenant-integrity-run-a";
const RUN_B = "tenant-integrity-run-b";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(
      `[tenant-reference-integrity-db] skipped — Docker/Postgres unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(`TRUNCATE spaces, users CASCADE`);
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Tenant tester', 'active', $2, $2)`,
    [USER, now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Space A', 'team', $3, $3), ($2, 'Space B', 'team', $3, $3)`,
    [SPACE_A, SPACE_B, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES
       ('tenant-membership-a', $1, $3, 'owner', 'active', $4, $4),
       ('tenant-membership-b', $2, $3, 'owner', 'active', $4, $4)`,
    [SPACE_A, SPACE_B, USER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES
       ($1, $3, $5, 'Project A', 'active', $6, $6),
       ($2, $4, $5, 'Project B', 'active', $6, $6)`,
    [PROJECT_A, PROJECT_B, SPACE_A, SPACE_B, USER, now],
  );
  await pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, current_version_id,
       visibility, created_at, updated_at
     ) VALUES
       ($1, $3, $5, 'Agent A', 'active', NULL, 'space_shared', $6, $6),
       ($2, $4, $5, 'Agent B', 'active', NULL, 'space_shared', $6, $6)`,
    [AGENT_A, AGENT_B, SPACE_A, SPACE_B, USER, now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, model_config_json, runtime_config_json,
       context_policy_json, memory_policy_json, capabilities_json,
       tool_permissions_json, runtime_policy_json, created_at
     ) VALUES
       ($1, $3, $5, 'v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $7),
       ($2, $4, $6, 'v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $7)`,
    [VERSION_A, VERSION_B, AGENT_A, AGENT_B, SPACE_A, SPACE_B, now],
  );
  await pool.query(
    `UPDATE agents
        SET current_version_id = CASE id WHEN $1 THEN $3 ELSE $4 END
      WHERE id IN ($1, $2)`,
    [AGENT_A, AGENT_B, VERSION_A, VERSION_B],
  );
  await pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, item_type, title,
       first_seen_at, last_seen_at, content_state, retention_policy,
       created_at, updated_at
     ) VALUES
       ($1, $3, $5, 'space_shared', 'external_url', 'Source A', $6, $6,
        'metadata_only', 'metadata_only', $6, $6),
       ($2, $4, $5, 'space_shared', 'external_url', 'Source B', $6, $6,
        'metadata_only', 'metadata_only', $6, $6)`,
    [SOURCE_A, SOURCE_B, SPACE_A, SPACE_B, USER, now],
  );
  await pool.query(
    `INSERT INTO project_operations (
       id, space_id, project_id, kind, title, status, progress_json,
       created_at, updated_at
     ) VALUES ($1, $2, $3, 'research', 'Operation B', 'active', '{}'::jsonb, $4, $4)`,
    [OPERATION_B, SPACE_B, PROJECT_B, now],
  );
  await insertRun(RUN_A, SPACE_A, AGENT_A, VERSION_A, now);
  await insertRun(RUN_B, SPACE_B, AGENT_B, VERSION_B, now);
});

describe("tenant reference integrity", () => {
  it("binds Agent.current_version_id and Run.agent_version_id to the same Agent and Space", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const now = new Date().toISOString();

    await expect(pool.query(
      `UPDATE agents SET current_version_id = $2 WHERE id = $1`,
      [AGENT_A, VERSION_B],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(insertRun("tenant-integrity-invalid-run", SPACE_A, AGENT_A, VERSION_B, now))
      .rejects.toMatchObject({ code: "23503" });

    await pool.query(
      `INSERT INTO agent_versions (
         id, agent_id, space_id, version_label, model_config_json,
         runtime_config_json, context_policy_json, memory_policy_json,
         capabilities_json, tool_permissions_json, runtime_policy_json, created_at
       ) VALUES ('tenant-current-only-v2', $1, $2, 'v2',
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $3)`,
      [AGENT_A, SPACE_A, now],
    );
    await pool.query(
      `UPDATE agents SET current_version_id = 'tenant-current-only-v2'
        WHERE id = $1`,
      [AGENT_A],
    );
    await expect(pool.query(
      `DELETE FROM agent_versions WHERE id = 'tenant-current-only-v2'`,
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("binds capability versions, enablements, and runtime bindings to one Space", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO capability_versions (
         id, capability_key, space_id, version, source, status,
         metadata_json, created_at, updated_at
       ) VALUES
         ('tenant-capability-a', 'research.search', $1, '1.0.0', 'builtin',
          'draft', '{}'::jsonb, $3, $3),
         ('tenant-capability-b', 'research.search', $2, '1.0.0', 'builtin',
          'draft', '{}'::jsonb, $3, $3)`,
      [SPACE_A, SPACE_B, now],
    );

    await expect(pool.query(
      `INSERT INTO capability_enablements (
         id, space_id, capability_key, capability_version_id, enabled,
         config_json, created_at, updated_at
       ) VALUES ('cross-space-capability-enablement', $1, 'research.search',
                 'tenant-capability-b', true, '{}'::jsonb, $2, $2)`,
      [SPACE_A, now],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `INSERT INTO capability_runtime_bindings (
         id, space_id, capability_key, capability_version_id,
         runtime_adapter_type, render_mode, binding_json, enabled,
         created_at, updated_at
       ) VALUES ('cross-space-runtime-binding', $1, 'research.search',
                 'tenant-capability-b', 'model_api', 'inline_prompt',
                 '{}'::jsonb, true, $2, $2)`,
      [SPACE_A, now],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects cross-space references in every Research Area layer", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const now = new Date().toISOString();

    // A project's notes are ordinary Notes tagged with primary_project_id;
    // the same compound FK (space_objects.primary_project_id, space_id ->
    // projects.id, space_id) that scopes every other space-owned object is
    // what keeps Project Chat's note candidates from ever crossing spaces.
    await expect(pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, visibility, primary_project_id, created_at, updated_at) VALUES ('cross-space-note', $1, 'note', 'Cross-space note',
                 'space_shared', $2, $3, $3)`,
      [SPACE_A, PROJECT_B, now],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `INSERT INTO research_evidence_cards (
         id, space_id, project_id, source_item_id, created_at, updated_at
       ) VALUES ('cross-space-card', $1, $2, $3, $4, $4)`,
      [SPACE_A, PROJECT_A, SOURCE_B, now],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `INSERT INTO research_checklist_items (
         id, space_id, project_id, text, status, sort_order, origin,
         origin_run_id, created_at, updated_at
       ) VALUES ('cross-space-check', $1, $2, 'Check', 'open', 0, 'agent', $3, $4, $4)`,
      [SPACE_A, PROJECT_A, RUN_B, now],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("clears only optional target IDs and never the non-null tenant key", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO tasks (
         id, space_id, project_id, task_role, title, task_type, status, priority,
         risk_level, visibility, access_level, created_at, updated_at
       ) VALUES ('project-delete-task', $1, $2, 'source', 'Task', 'general',
                 'inbox', 'normal', 'low', 'space_shared', 'full', $3, $3)`,
      [SPACE_A, PROJECT_A, now],
    );
    await pool.query(
      `INSERT INTO artifacts (
         id, space_id, project_id, artifact_type, title, export_formats_json,
         visibility, access_level, created_at, updated_at
       ) VALUES ('project-delete-artifact', $1, $2, 'result', 'Artifact', '[]'::jsonb,
                 'space_shared', 'full', $3, $3)`,
      [SPACE_A, PROJECT_A, now],
    );
    await pool.query(
      `INSERT INTO automations (
         id, space_id, project_id, owner_user_id, agent_id, name, trigger_type,
         status, config_json, created_at, updated_at
       ) VALUES ('project-delete-automation', $1, $2, $3, $4, 'Automation',
                 'manual', 'active', '{}'::jsonb, $5, $5)`,
      [SPACE_A, PROJECT_A, USER, AGENT_A, now],
    );

    await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_A]);
    for (const table of ["tasks", "artifacts", "automations"] as const) {
      const row = await pool.query<{ space_id: string; project_id: string | null }>(
        `SELECT space_id, project_id FROM ${table} WHERE space_id = $1`,
        [SPACE_A],
      );
      expect(row.rows[0]).toEqual({ space_id: SPACE_A, project_id: null });
    }
  });

  it("preserves tenant keys when optional Run and SourceItem targets are deleted", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, visibility, primary_project_id, created_at, updated_at) VALUES ('run-delete-note', $1, 'note', 'Run-authored note',
                 'space_shared', $2, $3, $3)`,
      [SPACE_A, PROJECT_A, now],
    );
    await pool.query(
      `INSERT INTO notes (
         object_id, space_id, content_json, content_format, content_schema_version,
         version, updated_by_run_id
       ) VALUES ('run-delete-note', $1, '{}'::jsonb, 'prosemirror_json', 1, 1, $2)`,
      [SPACE_A, RUN_A],
    );
    await pool.query(
      `INSERT INTO research_integrity_alerts (
         id, space_id, project_id, source_item_id, doi, event_key, event_type,
         source, detail_json, detected_at
       ) VALUES ('source-delete-alert', $1, $2, $3, '10.test/a', 'event-a',
                 'correction', 'test', '{}'::jsonb, $4)`,
      [SPACE_A, PROJECT_A, SOURCE_A, now],
    );

    await pool.query(`DELETE FROM runs WHERE id = $1`, [RUN_A]);
    await pool.query(`DELETE FROM source_items WHERE id = $1`, [SOURCE_A]);

    const note = await pool.query<{ space_id: string; updated_by_run_id: string | null }>(
      `SELECT space_id, updated_by_run_id FROM notes WHERE object_id = 'run-delete-note'`,
    );
    expect(note.rows[0]).toEqual({ space_id: SPACE_A, updated_by_run_id: null });
    const alert = await pool.query<{ space_id: string; source_item_id: string | null }>(
      `SELECT space_id, source_item_id FROM research_integrity_alerts WHERE id = 'source-delete-alert'`,
    );
    expect(alert.rows[0]).toEqual({ space_id: SPACE_A, source_item_id: null });
  });

  it("clears an Inquiry Step's round pointer without clearing its tenant key", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const now = new Date().toISOString();
    await seedInquiryRound(pool, "round-clear", SPACE_A, PROJECT_A, now);

    await pool.query(`DELETE FROM inquiry_iterations WHERE id = 'round-clear-iteration'`);

    const step = await pool.query<{ space_id: string; project_id: string; iteration_id: string | null }>(
      `SELECT space_id, project_id, iteration_id FROM inquiry_thread_steps WHERE id = 'round-clear-step'`,
    );
    expect(step.rows[0]).toEqual({ space_id: SPACE_A, project_id: PROJECT_A, iteration_id: null });
  });

  it("still deletes an Inquiry Thread's Steps and Iterations with the Thread", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const now = new Date().toISOString();
    await seedInquiryRound(pool, "round-cascade", SPACE_A, PROJECT_A, now);

    await pool.query(`DELETE FROM space_objects WHERE id = 'round-cascade-thread'`);

    const steps = await pool.query(`SELECT id FROM inquiry_thread_steps WHERE id = 'round-cascade-step'`);
    const iterations = await pool.query(`SELECT id FROM inquiry_iterations WHERE id = 'round-cascade-iteration'`);
    expect(steps.rowCount).toBe(0);
    expect(iterations.rowCount).toBe(0);
  });

  it("has no SET NULL foreign key that includes the tenant column", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const constraints = await pool.query<{ conname: string }>(
      `SELECT DISTINCT constraint_row.conname
         FROM pg_constraint constraint_row
         JOIN LATERAL unnest(constraint_row.conkey) AS key_column(attnum) ON true
         JOIN pg_attribute attribute_row
           ON attribute_row.attrelid = constraint_row.conrelid
          AND attribute_row.attnum = key_column.attnum
        WHERE constraint_row.contype = 'f'
          AND constraint_row.confdeltype = 'n'
          AND attribute_row.attname = 'space_id'
        ORDER BY constraint_row.conname`,
    );
    expect(constraints.rows).toEqual([]);
  });
});

async function insertRun(
  id: string,
  spaceId: string,
  agentId: string,
  agentVersionId: string,
  now: string,
): Promise<void> {
  await pool!.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin,
       status, mode, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'agent', 'manual', 'queued', 'live', $5, $5)`,
    [id, spaceId, agentId, agentVersionId, now],
  );
}

/**
 * A Thread, one round, and one Step pointing at it. The Step's round pointer is
 * the only optional cross-reference here, so it is what the two Inquiry cases
 * above watch: cleared on its own when the round goes, gone entirely when the
 * Thread does.
 */
async function seedInquiryRound(
  pool: Pool,
  prefix: string,
  spaceId: string,
  projectId: string,
  now: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO space_objects (
       id, space_id, object_type, title, visibility, access_level,
       owner_user_id, primary_project_id, created_at, updated_at
     ) VALUES ($1, $2, 'inquiry_thread', 'Thread', 'space_shared', 'full', $3, $4, $5, $5)`,
    [`${prefix}-thread`, spaceId, USER, projectId, now],
  );
  await pool.query(
    `INSERT INTO inquiry_threads (
       object_id, space_id, project_id, statement, kind, lifecycle_status,
       attention_state, priority, version
     ) VALUES ($1, $2, $3, 'Statement', 'question', 'active', 'backlog', 0, 1)`,
    [`${prefix}-thread`, spaceId, projectId],
  );
  await pool.query(
    `INSERT INTO inquiry_iterations (
       id, space_id, project_id, thread_id, trigger_kind,
       previous_position_json, new_position_json, change_summary, created_at
     ) VALUES ($1, $2, $3, $4, 'user_edit', '{}'::jsonb, '{}'::jsonb, 'Change', $5)`,
    [`${prefix}-iteration`, spaceId, projectId, `${prefix}-thread`, now],
  );
  await pool.query(
    `INSERT INTO inquiry_thread_steps (
       id, space_id, project_id, thread_id, iteration_id, kind, status, slot,
       origin, started_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, 'synthesize', 'in_progress', 'primary', 'user', $6, $6)`,
    [`${prefix}-step`, spaceId, projectId, `${prefix}-thread`, `${prefix}-iteration`, now],
  );
}
