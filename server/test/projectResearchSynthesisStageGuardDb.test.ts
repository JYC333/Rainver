import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";

// Real-Postgres coverage for a regression where reconcileOperation's
// backfill->screening transition block has no stage guard: once backfill
// plans are 'completed' and the pipeline is drained, it unconditionally
// re-runs on every periodic tick — including AFTER the user has already
// approved the screening_gate checkpoint and the workflow has advanced to
// synthesis. That clobbers current_stage back to "screening" and creates a
// brand-new pending screening_gate checkpoint (the approved one no longer
// matches createCheckpoint's "status='pending'" upsert lookup), which is
// exactly what an "Approve screening did nothing, the checkpoint came back
// after refresh" report looks like from the outside.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "88888888-8888-4888-8888-888888888888";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const PLAN = "aaaaaaaa-1111-4111-8111-111111111111";
const AGENT = "99999999-9999-4999-8999-999999999999";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    console.warn(`[project-research-synthesis-stage-guard-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE runs, agent_versions, agents, project_research_checkpoints, project_research_workflows,
       source_backfill_segments, source_backfill_plans,
       project_operations, source_channels, source_connections, source_provider_connectors, source_providers,
       source_connectors, project_members, projects, space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO source_connectors (id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'arxiv_api','arXiv','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [CONNECTOR, now],
  );
  const providerId = randomUUID();
  const mappingId = randomUUID();
  await pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'arxiv','arXiv','generic','academic','active','{}'::jsonb,$2,$2)`,
    [providerId, now],
  );
  await pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [mappingId, providerId, CONNECTOR, now],
  );
  await pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'arXiv','active','reference_only','normal',$5::jsonb,$6::jsonb,'{}'::jsonb,$7,$7)`,
    [
      CONNECTION, SPACE, mappingId, OWNER,
      JSON.stringify({ schema_version: 1, owner_user_id: OWNER, allowed_reader_user_ids: [], allowed_agent_ids: [], allow_space_admins: true, allow_local_provider_egress: true, allow_external_model_egress: true }),
      JSON.stringify({ schema_version: 1, source_egress_class: "external_provider_allowed" }),
      now,
    ],
  );
  await pool.query(
    `INSERT INTO source_channels (
       id, space_id, source_connection_id, created_by_user_id, name, channel_type, endpoint_url,
       query_json, provider_query_json, query_fingerprint, status, fetch_frequency, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'Monitor','search','https://export.arxiv.org/api/query','{}'::jsonb,'{}'::jsonb,'fp-a','active','daily',$5,$5)`,
    [CHANNEL, SPACE, CONNECTION, OWNER, now],
  );
  await pool.query(
    `INSERT INTO project_research_workflows (id, space_id, project_id, workflow_type, current_stage, status, mode, state_json, created_at, updated_at)
     VALUES ($1,$2,$3,'literature_review','synthesis','active','agent_assisted','{}'::jsonb,$4,$4)`,
    [WORKFLOW, SPACE, PROJECT, now],
  );
  await seedOperationInSynthesis();
  await pool.query(
    `INSERT INTO source_backfill_plans (
       id, space_id, source_channel_id, project_operation_id, requested_by_user_id, origin,
       strategy_json, quota_policy_json, status, segments_total, segments_completed, segments_failed,
       items_ingested, idempotency_key, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'user',$6::jsonb,$7::jsonb,'completed',1,1,0,3,$8,$9,$9)`,
    [
      PLAN, SPACE, CHANNEL, OPERATION, OWNER,
      JSON.stringify({ window_unit: "date_window", history_mode: "bounded_range", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", window_size: 30, max_items: 10, direction: "backward" }),
      JSON.stringify({ window: "minute", limit_count: 10 }),
      `idem-${PLAN}`, now,
    ],
  );
  const versionId = randomUUID();
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Research Agent','active',NULL,$4,$4,'space_shared')`,
    [AGENT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'Test agent.',
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [versionId, AGENT, SPACE, now],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, versionId]);
  // The synthesis run the operation points at is still executing — reconcile
  // must report on it, not clobber the operation back to screening.
  await pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       adapter_type, instructed_by_user_id, owner_user_id, project_id,
       contract_snapshot_json, created_at, updated_at, started_at
     ) VALUES ($1,$2,$3,$4,'agent','system','running','live','model_api',$5,$5,$6,'{}'::jsonb,$7,$7,$7)`,
    ["run-already-queued", SPACE, AGENT, versionId, OWNER, PROJECT, now],
  );
});

async function seedOperationInSynthesis(): Promise<void> {
  const now = new Date().toISOString();
  const progress = {
    schema_version: "project_research_operation.v1",
    run_kind: "baseline",
    workflow_id: WORKFLOW,
    agent_id: AGENT,
    source_backfill_plan_ids: [PLAN],
    source_backfill_plan_id: PLAN,
    current_stage: "synthesis",
    stage_state: "running",
    partial: false,
    channel_ids: [CHANNEL],
    source_item_ids: [],
    checkpoint_ids: [],
    source_post_processing_rule_ids: [],
    source_post_processing_rule_id: null,
    synthesis_run_id: "run-already-queued",
    watermark: { before: null, after: null, overlap_hours: 48 },
  };
  await pool!.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake','active',$4,$5::jsonb,$6,$6)`,
    [OPERATION, SPACE, PROJECT, OWNER, JSON.stringify(progress), now],
  );
}

async function seedApprovedScreeningCheckpoint(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO project_research_checkpoints (
       id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status,
       user_decision, decided_by_user_id, decided_at, machine_result_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'screening','screening_gate','approved','approved',$5,$6,$7::jsonb,$6,$6)`,
    [id, SPACE, PROJECT, WORKFLOW, OWNER, now, JSON.stringify({ operation_id: OPERATION, total: 3 })],
  );
  return id;
}

describe("ProjectResearchOrchestrator.reconcileOperation stage guard after synthesis has started (real Postgres)", () => {
  it("does not reset an operation back to 'screening' or recreate the screening_gate checkpoint once synthesis has already been queued", async () => {
    if (!available || !pool) return;
    const checkpointId = await seedApprovedScreeningCheckpoint();

    await new ProjectResearchOrchestrator(pool!).reconcileOperation(SPACE, OPERATION);

    const operation = await pool!.query<{ progress_json: { current_stage?: string; synthesis_run_id?: string } }>(
      `SELECT progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.progress_json.current_stage).toBe("synthesis");
    expect(operation.rows[0]!.progress_json.synthesis_run_id).toBe("run-already-queued");

    const checkpoints = await pool!.query<{ id: string; status: string }>(
      `SELECT id, status FROM project_research_checkpoints WHERE space_id=$1 AND project_id=$2 AND checkpoint_type='screening_gate'`,
      [SPACE, PROJECT],
    );
    expect(checkpoints.rows).toHaveLength(1);
    expect(checkpoints.rows[0]).toMatchObject({ id: checkpointId, status: "approved" });
  });
});
