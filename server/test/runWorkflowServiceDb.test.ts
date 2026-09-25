import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { RunWorkflowService } from "../src/modules/evolution/runWorkflowService.js";
import { createDefaultProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { seedServerRuntimeProfile } from "./support/domainSeeds.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SERVER_HOST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const IDENTITY = { spaceId: SPACE, userId: USER };


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["evolvable_asset_pins", "evolvable_asset_versions", "evolvable_assets", "agent_runtime_profiles", "hosts", "machines", "spaces", "users"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Workflow User', 'active', $2, $2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [USER, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Workflow Space', 'team', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Workflow Agent', 'active', NULL, 'space_shared', $4, $4)`,
    [AGENT, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       -- The low-risk path this file asserts on is the AgentVersion's own
       -- classification, not a routing workaround: the contract takes the
       -- stricter of the request and the Version, so the product default
       -- would make every "low-risk draft" assertion here medium.
       risk_level,
       created_at
     ) VALUES (
       $1,
       $2,
       $3,
       'v1',
       'Test',
       '{}'::jsonb,
       '{}'::jsonb,
       '[]'::jsonb,
       '{}'::jsonb,
       'low',
       $4
     )`,
    [VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
  await seedServerRuntimeProfile(db.pool, {
    agent: AGENT,
    space: SPACE,
    hostId: SERVER_HOST,
    now,
  });
  await db.pool.query(
    `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, display_name, status, metadata_json, created_at, updated_at)
     VALUES ($1, $2, 'agent', $3, $4, 'Workflow actor', 'active', '{}'::jsonb, $5, $5)`,
    [ACTOR, SPACE, USER, AGENT, now],
  );
});

async function seedRun(riskLevel: "low" | "high"): Promise<string> {
  const prompt = "Inspect /tmp/private-output using sk-testSecretValue1234567890";
  const contractSnapshot = {
    source: { kind: "direct" as const, id: null },
    risk_level: riskLevel,
    required_outputs_json: { artifact_type: "report" },
  };
  let runId: string;
  const runs = new PgRunRepository(db.pool);
  const now = new Date().toISOString();
  if (riskLevel === "high") {
    // This approval test consumes an already-completed historical Run. The
    // current ACP admission policy correctly rejects high-risk CLI dispatch,
    // so seed its frozen execution snapshot instead of bypassing routing.
    const inserted = await db.pool.query<{ id: string }>(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, execution_kind,
         runtime_profile_id, runtime_profile_selection_source, runtime_key,
         runtime_profile_snapshot_json, run_type, trigger_origin, status, mode,
         prompt, contract_snapshot_json, started_at, ended_at, output_json,
         instructed_by_user_id, owner_user_id, visibility, access_level,
         created_at, updated_at
       )
       SELECT $1::varchar(36), $2::varchar(36), $3::varchar(36), $4::varchar(36), 'agent', profile.id, 'default', profile.runtime_key,
              jsonb_build_object(
                'id', profile.id, 'runtime_key', profile.runtime_key,
                'backend_mode', profile.backend_mode,
                'model_provider_id', profile.model_provider_id,
                'model_name', profile.model_name,
                'runtime_config_json', profile.runtime_config_json,
                'runtime_policy_json', profile.runtime_policy_json
              ), 'agent', 'manual', 'succeeded', 'live', $5, $6::jsonb,
              $7, $7, '{"result":"ok"}'::jsonb, $8, $8,
              'space_shared', 'full', $7, $7
         FROM agent_runtime_profiles profile
        WHERE profile.space_id = $2::varchar(36) AND profile.agent_id = $3::varchar(36)
          AND profile.is_default = TRUE AND profile.enabled = TRUE
       RETURNING id`,
      [randomUUID(), SPACE, AGENT, VERSION, prompt, JSON.stringify(contractSnapshot), now, USER],
    );
    if (!inserted.rows[0]) throw new Error("Historical workflow-save Run requires the default Runtime Profile");
    runId = inserted.rows[0].id;
  } else {
    const run = await runs.createQueuedRun({
      execution_kind: "agent",
      agent_id: AGENT,
      space_id: SPACE,
      user_id: USER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      capability_id: "research.search",
      prompt,
      contract_snapshot: contractSnapshot,
    });
    await new PgRouteDecisionRepository(db.pool).routeRun(run);
    await runs.markRunRunning({ run_id: run.id, space_id: SPACE, started_at: now });
    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = $2, updated_at = $2, output_json = '{"result":"ok"}'::jsonb WHERE id = $1`,
      [run.id, now],
    );
    runId = run.id;
  }
  await db.pool.query(
    `INSERT INTO run_evaluations (
       id, space_id, run_id, evaluator_type, evaluator_version, outcome_status,
       trajectory_status, evidence_json, rule_trace_json, evaluated_at
     ) VALUES ($1, $2, $3, 'deterministic_harness', 'test', 'passed', 'acceptable', '{}'::jsonb, '[]'::jsonb, $4)`,
    [randomUUID(), SPACE, runId, now],
  );
  await db.pool.query(
    `INSERT INTO run_steps (
       id, space_id, run_id, actor_id, step_index, step_type, status, title,
       input_summary, output_summary, metadata_json, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 0, 'completed', 'succeeded', 'Inspect /tmp/private-output using sk-testSecretValue1234567890',
       'input', 'done at /tmp/private-output', '{}'::jsonb, $5, $5)`,
    [randomUUID(), SPACE, runId, ACTOR, now],
  );
  await db.pool.query(
    `INSERT INTO verification_results (
       id, space_id, run_id, verifier_type, verifier_version, status, summary,
       evidence_refs_json, details_json, started_at, completed_at, created_at
     ) VALUES ($1, $2, $3, 'output_schema', 'v1', 'passed', 'Schema passed',
       '[]'::jsonb, '{}'::jsonb, $4, $4, $4)`,
    [randomUUID(), SPACE, runId, now],
  );
  await db.pool.query(
    `INSERT INTO artifacts (
       id, space_id, run_id, artifact_type, title, content, mime_type,
       export_formats_json, created_at, updated_at, visibility, access_level
     ) VALUES ($1, $2, $3, 'report', 'Report', 'safe', 'text/plain', '[]'::jsonb, $4, $4, 'space_shared', 'full')`,
    [randomUUID(), SPACE, runId, now],
  );
  return runId;
}

describe("save run as workflow (real Postgres)", () => {
  it("previews and saves a sanitized low-risk draft with evidence", async () => {
    if (!db.available) return;
    const runId = await seedRun("low");
    const service = new RunWorkflowService(db.pool);
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
    const row = await db.pool.query<{ asset_type: string; status: string; version_status: string }>(
      `SELECT a.asset_type, a.status, v.status AS version_status
         FROM evolvable_assets a JOIN evolvable_asset_versions v ON v.asset_id = a.id
        WHERE a.id = $1`,
      [String(saved.asset_id)],
    );
    expect(row.rows[0]).toEqual({ asset_type: "workflow_template", status: "active", version_status: "draft" });
  });

  it("requires a proposal for high-risk extraction and applies it as a draft", async () => {
    if (!db.available) return;
    const runId = await seedRun("high");
    const saved = await new RunWorkflowService(db.pool).save(IDENTITY, {
      run_id: runId,
      asset_key: "workflow.saved.review",
    });
    expect(saved).toMatchObject({ status: "proposal_required", proposal_type: "workflow_save", risk_level: "high" });
    const proposal = await db.pool.query<{ id: string; space_id: string; proposal_type: string; payload_json: Record<string, unknown>; status: string }>(
      `SELECT id, space_id, proposal_type, payload_json, status FROM proposals WHERE id = $1`,
      [String(saved.proposal_id)],
    );
    expect(proposal.rows[0]?.status).toBe("pending");
    const client = await db.pool.connect();
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
          owner_user_id: null,
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
      const version = await db.pool.query<{ status: string }>(
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
