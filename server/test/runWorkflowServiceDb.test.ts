import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { PgRunRepository } from "../src/modules/runs/repository";
import { RunWorkflowService } from "../src/modules/evolution/runWorkflowService";
import { createDefaultProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const IDENTITY = { spaceId: SPACE, userId: USER };

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[run-workflow-db] skipped — Docker/Postgres unavailable: ${String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["evolvable_asset_pins", "evolvable_asset_versions", "evolvable_assets", "spaces", "users"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Workflow User', 'active', $2, $2)`,
    [USER, now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Workflow Space', 'team', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Workflow Agent', 'active', NULL, 'space_shared', $4, $4)`,
    [AGENT, SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'Test', '{}'::jsonb, '{"adapter_type":"model_api"}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [VERSION, AGENT, SPACE, now],
  );
  await pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, runtime_config_json,
       runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Default', 'model_api', '{"adapter_type":"model_api"}'::jsonb,
       '{}'::jsonb, true, true, $4, $4)`,
    [randomUUID(), SPACE, AGENT, now],
  );
  await pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
  await pool.query(
    `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, display_name, status, metadata_json, created_at, updated_at)
     VALUES ($1, $2, 'agent', $3, $4, 'Workflow actor', 'active', '{}'::jsonb, $5, $5)`,
    [ACTOR, SPACE, USER, AGENT, now],
  );
});

async function seedRun(riskLevel: string): Promise<string> {
  const run = await new PgRunRepository(pool!).createQueuedRun({
    agent_id: AGENT,
    space_id: SPACE,
    user_id: USER,
    mode: "live",
    run_type: "agent",
    trigger_origin: "manual",
    capability_id: "research.search",
    prompt: "Inspect /tmp/private-output using sk-testSecretValue1234567890",
    contract_snapshot: {
      source: { kind: "direct", id: null },
      risk_level: riskLevel,
      required_outputs_json: { artifact_type: "report" },
    },
  });
  const now = new Date().toISOString();
  await pool!.query(
    `UPDATE runs SET status = 'succeeded', ended_at = $2, updated_at = $2, output_json = '{"result":"ok"}'::jsonb WHERE id = $1`,
    [run.id, now],
  );
  await pool!.query(
    `INSERT INTO run_evaluations (
       id, space_id, run_id, evaluator_type, evaluator_version, outcome_status,
       trajectory_status, evidence_json, rule_trace_json, evaluated_at
     ) VALUES ($1, $2, $3, 'deterministic_harness', 'test', 'passed', 'acceptable', '{}'::jsonb, '[]'::jsonb, $4)`,
    [randomUUID(), SPACE, run.id, now],
  );
  await pool!.query(
    `INSERT INTO run_steps (
       id, space_id, run_id, actor_id, step_index, step_type, status, title,
       input_summary, output_summary, metadata_json, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 0, 'completed', 'succeeded', 'Inspect /tmp/private-output using sk-testSecretValue1234567890',
       'input', 'done at /tmp/private-output', '{}'::jsonb, $5, $5)`,
    [randomUUID(), SPACE, run.id, ACTOR, now],
  );
  await pool!.query(
    `INSERT INTO verification_results (
       id, space_id, run_id, verifier_type, verifier_version, status, summary,
       evidence_refs_json, details_json, started_at, completed_at, created_at
     ) VALUES ($1, $2, $3, 'output_schema', 'v1', 'passed', 'Schema passed',
       '[]'::jsonb, '{}'::jsonb, $4, $4, $4)`,
    [randomUUID(), SPACE, run.id, now],
  );
  await pool!.query(
    `INSERT INTO artifacts (
       id, space_id, run_id, artifact_type, title, content, mime_type,
       export_formats_json, created_at, updated_at, visibility, access_level
     ) VALUES ($1, $2, $3, 'report', 'Report', 'safe', 'text/plain', '[]'::jsonb, $4, $4, 'space_shared', 'full')`,
    [randomUUID(), SPACE, run.id, now],
  );
  return run.id;
}

describe("save run as workflow (real Postgres)", () => {
  it("previews and saves a sanitized low-risk draft with evidence", async () => {
    if (!available) return;
    const runId = await seedRun("low");
    const service = new RunWorkflowService(pool!);
    const preview = await service.preview(IDENTITY, {
      run_id: runId,
      asset_key: "workflow.saved.safe",
      display_name: "Saved workflow",
    });
    expect(preview).toMatchObject({ source_kind: "run", risk_level: "low", requires_proposal: false });
    expect(preview.evidence.artifact_types).toEqual(["report"]);
    expect(preview.definition.nodes[0]?.title).toContain("[PATH]");
    expect(JSON.stringify(preview.definition)).not.toContain(runId);
    expect(JSON.stringify(preview.definition)).not.toContain("sk-testSecretValue1234567890");
    expect(JSON.stringify(preview.definition)).toContain("[REDACTED_SECRET]");

    const saved = await service.save(IDENTITY, {
      run_id: runId,
      asset_key: "workflow.saved.safe",
      display_name: "Saved workflow",
    });
    expect(saved).toMatchObject({ status: "draft_saved", version_status: "draft" });
    const row = await pool!.query<{ asset_type: string; status: string; version_status: string }>(
      `SELECT a.asset_type, a.status, v.status AS version_status
         FROM evolvable_assets a JOIN evolvable_asset_versions v ON v.asset_id = a.id
        WHERE a.id = $1`,
      [String(saved.asset_id)],
    );
    expect(row.rows[0]).toEqual({ asset_type: "workflow_template", status: "active", version_status: "draft" });
  });

  it("requires a proposal for high-risk extraction and applies it as a draft", async () => {
    if (!available) return;
    const runId = await seedRun("high");
    const saved = await new RunWorkflowService(pool!).save(IDENTITY, {
      run_id: runId,
      asset_key: "workflow.saved.review",
    });
    expect(saved).toMatchObject({ status: "proposal_required", proposal_type: "workflow_save", risk_level: "high" });
    const proposal = await pool!.query<{ id: string; space_id: string; proposal_type: string; payload_json: Record<string, unknown>; status: string }>(
      `SELECT id, space_id, proposal_type, payload_json, status FROM proposals WHERE id = $1`,
      [String(saved.proposal_id)],
    );
    expect(proposal.rows[0]?.status).toBe("pending");
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      const result = await createDefaultProposalApplierRegistry().apply({
        config: {} as never,
        db: client,
        proposal: {
          id: proposal.rows[0]!.id,
          space_id: proposal.rows[0]!.space_id,
          proposal_type: proposal.rows[0]!.proposal_type,
          status: "accepted",
          risk_level: "high",
          preview: false,
          payload_json: proposal.rows[0]!.payload_json,
          project_folder_id: null,
          visibility: "space_shared",
          created_by_user_id: USER,
          created_by_agent_id: null,
          created_by_run_id: runId,
          project_id: null,
          title: "Save workflow",
          required_approver_role: null,
        },
        userId: USER,
      });
      await client.query("COMMIT");
      expect(result.result).toMatchObject({ status: "draft" });
      const versionId = String(result.result.version_id);
      expect(versionId).toBeTruthy();
      const version = await pool!.query<{ status: string }>(
        `SELECT status FROM evolvable_asset_versions WHERE id = $1`,
        [versionId],
      );
      expect(version.rows[0]?.status).toBe("draft");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
});
