import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { RunWorkflowService } from "../src/modules/evolution/runWorkflowService.js";
import { seedMainlineRoomsForAllProjects, seedServerRuntimeProfile } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository.js";
import { EvolvableAssetEvaluationRepository } from "../src/modules/evolution/assetEvaluationRepository.js";
import { AutomationService } from "../src/modules/automations/service.js";
import { PgAutomationRepository } from "../src/modules/automations/repository.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SERVER_HOST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROJECT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PROJECT_FOLDER = "f0000000-0000-4000-8000-000000000001";
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

const SOURCE_SECRET = "sk-testSecretValue1234567890";
const SOURCE_PATH = "/tmp/private-output";

function serverConfig() {
  return loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test-internal-token" });
}

/** Asserts none of the source Run's transient or secret facts reached a definition. */
function expectSanitizedDefinition(definition: unknown, sourceRunId: string): void {
  const text = JSON.stringify(definition);
  expect(text).not.toContain(sourceRunId);
  expect(text).not.toContain(SOURCE_SECRET);
  expect(text).not.toContain(SOURCE_PATH);
  expect(text).toContain("[REDACTED_SECRET]");
  expect(text).toContain("[PATH]");
}

/**
 * The rest of the journey every saved draft takes: the existing promotion
 * lifecycle (draft → candidate → promotion Proposal accepted through the
 * standard apply gate → approved), then a Workflow Automation launch of the
 * approved version. Returns what the launch created.
 */
async function promoteAndLaunch(input: { assetId: string; versionId: string; assetKey: string; expectedRisk: string }) {
  const assets = new EvolvableAssetRepository(db.pool);
  const evaluations = new EvolvableAssetEvaluationRepository(db.pool);
  const automations = new AutomationService(serverConfig(), new PgAutomationRepository(db.pool), null);
  // The seeded Agent's runtime reads files, so a launch needs a Project Folder.
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Workflow Project', 'active', $4, $4)`,
    [PROJECT, SPACE, USER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
  await db.pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, created_by_user_id, name, status,
       kind, is_primary, protected, system_managed, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Workflow code', 'active', 'code', true, false, false, $5, $5)`,
    [PROJECT_FOLDER, SPACE, PROJECT, USER, now],
  );
  const launchBody = {
    name: "Saved workflow",
    agent_id: AGENT,
    project_id: PROJECT,
    project_folder_id: PROJECT_FOLDER,
  };
  const workflowConfig = {
    target_type: "workflow",
    workflow_asset_key: input.assetKey,
    workflow_resolution: "pin",
    workflow_version_id: input.versionId,
  };
  // A draft is neither promotable nor launchable until it passes review.
  await expect(evaluations.createPromotionProposal(IDENTITY, input.assetId, input.versionId, { target_scope_type: "space" }))
    .rejects.toMatchObject({ statusCode: 422 });
  await expect(assets.transitionVersionStatus(IDENTITY, input.assetId, input.versionId, { status: "approved" }))
    .rejects.toMatchObject({ statusCode: 422 });
  await expect(automations.create({
    spaceId: SPACE,
    ownerUserId: USER,
    body: { ...launchBody, config_json: workflowConfig },
  })).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("approved version") });

  await assets.transitionVersionStatus(IDENTITY, input.assetId, input.versionId, { status: "candidate" });
  const promotion = await evaluations.createPromotionProposal(IDENTITY, input.assetId, input.versionId, {
    target_scope_type: "space",
    reason: "Reviewed workflow saved from a Run",
  });
  const promotionRow = await db.pool.query<{ status: string; risk_level: string }>(
    `SELECT status, risk_level FROM proposals WHERE id = $1`,
    [String(promotion.proposal_id)],
  );
  expect(promotionRow.rows[0]).toEqual({ status: "pending", risk_level: input.expectedRisk });
  const accepted = await PgProposalApplyService.fromConfig(serverConfig()).accept(String(promotion.proposal_id), IDENTITY);
  expect(accepted?.proposal.status).toBe("accepted");
  const approved = await db.pool.query<{ status: string; promotion_proposal_id: string | null; content_json: unknown }>(
    `SELECT status, promotion_proposal_id, content_json FROM evolvable_asset_versions WHERE id = $1`,
    [input.versionId],
  );
  expect(approved.rows[0]).toMatchObject({ status: "approved", promotion_proposal_id: String(promotion.proposal_id) });

  const automation = await automations.create({
    spaceId: SPACE,
    ownerUserId: USER,
    body: { ...launchBody, config_json: workflowConfig },
  });
  expect(automation.config_json).toMatchObject({ workflow_resolution: "pin", workflow_version_id: input.versionId });
  const fired = await automations.fire({ spaceId: SPACE, automationId: automation.id, actorUserId: USER });
  expect(fired).toMatchObject({ target_type: "workflow", workflow_version_id: input.versionId });
  const execution = await db.pool.query<{ status: string; workflow_version_id: string; definition_json: unknown }>(
    `SELECT status, workflow_version_id, definition_json FROM workflow_executions WHERE id = $1`,
    [String(fired.workflow_execution_id)],
  );
  expect(execution.rows[0]).toMatchObject({ status: "running", workflow_version_id: input.versionId });
  const children = await db.pool.query<{
    status: string;
    workflow_version_id: string;
    instruction: string | null;
    contract_snapshot_json: Record<string, unknown>;
  }>(
    `SELECT status, workflow_version_id, instruction, contract_snapshot_json
       FROM runs WHERE space_id = $1 AND parent_run_id = $2`,
    [SPACE, String(fired.root_run_id)],
  );
  expect(children.rows).toHaveLength(1);
  expect(children.rows[0]).toMatchObject({ status: "queued", workflow_version_id: input.versionId });
  return { approvedContent: approved.rows[0]!.content_json, execution: execution.rows[0]!, child: children.rows[0]! };
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

  it("refuses to extract a workflow the plan executor could never run", async () => {
    if (!db.available) return;
    // Steps become a linear chain, and the executor runs at most three layers.
    const runId = await seedRun("low");
    for (const index of [1, 2, 3]) {
      await db.pool.query(
        `INSERT INTO run_steps (
           id, space_id, run_id, actor_id, step_index, step_type, status, title,
           input_summary, output_summary, metadata_json, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'completed', 'succeeded', $6, 'input', 'done', '{}'::jsonb, now(), now())`,
        [randomUUID(), SPACE, runId, ACTOR, index, `Step ${index}`],
      );
    }
    const service = new RunWorkflowService(db.pool);
    const input = { run_id: runId, asset_key: "workflow.saved.deep", display_name: "Deep workflow" };

    await expect(service.preview(IDENTITY, input)).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.save(IDENTITY, input)).rejects.toMatchObject({ statusCode: 422 });
    const saved = await db.pool.query(`SELECT id FROM evolvable_assets WHERE asset_key = $1`, [input.asset_key]);
    expect(saved.rows).toEqual([]);
  });

  it("refuses a Run with more child Runs than a workflow holds, as 422 rather than a server error", async () => {
    if (!db.available) return;
    const runId = await seedRun("low");
    // Every child becomes a node, and `workflow_definition.v1` holds thirty.
    for (let index = 0; index < 31; index += 1) {
      await db.pool.query(
        `INSERT INTO runs
         SELECT (jsonb_populate_record(NULL::runs, to_jsonb(r) || jsonb_build_object('id', $2::text, 'parent_run_id', $1::text, 'root_run_id', $1::text))).*
           FROM runs r WHERE r.id = $1`,
        [runId, randomUUID()],
      );
    }
    const service = new RunWorkflowService(db.pool);
    const input = { run_id: runId, asset_key: "workflow.saved.wide", display_name: "Wide workflow" };

    await expect(service.preview(IDENTITY, input)).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.save(IDENTITY, input)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("carries a low-risk saved draft through promotion to an approved, launchable Workflow", async () => {
    if (!db.available) return;
    const sourceRunId = await seedRun("low");
    const saved = await new RunWorkflowService(db.pool).save(IDENTITY, {
      run_id: sourceRunId,
      asset_key: "workflow.saved.journey",
      display_name: "Journey workflow",
    });
    expect(saved).toMatchObject({ status: "draft_saved", version_status: "draft" });
    expect(saved).not.toHaveProperty("proposal_id");

    const launched = await promoteAndLaunch({
      assetId: String(saved.asset_id),
      versionId: String(saved.version_id),
      assetKey: "workflow.saved.journey",
      expectedRisk: "medium",
    });
    expectSanitizedDefinition(launched.approvedContent, sourceRunId);
    expect(launched.execution.definition_json).toEqual(launched.approvedContent);
    expect(JSON.stringify(launched.child)).not.toContain(sourceRunId);
    expect(JSON.stringify(launched.child)).not.toContain(SOURCE_SECRET);
    expect(launched.child.instruction).toContain("Workflow Node: Inspect [PATH]");
  });

  it("carries a high-risk save through its workflow_save Proposal, promotion and launch", async () => {
    if (!db.available) return;
    const sourceRunId = await seedRun("high");
    const saved = await new RunWorkflowService(db.pool).save(IDENTITY, {
      run_id: sourceRunId,
      asset_key: "workflow.saved.reviewed",
      display_name: "Reviewed workflow",
    });
    expect(saved).toMatchObject({ status: "proposal_required", proposal_type: "workflow_save", risk_level: "high" });
    // Nothing is saved until the Proposal is accepted.
    expect((await db.pool.query(`SELECT id FROM evolvable_assets WHERE asset_key = $1`, ["workflow.saved.reviewed"])).rows).toEqual([]);
    const proposal = await db.pool.query<{ payload_json: Record<string, unknown>; created_by_run_id: string | null }>(
      `SELECT payload_json, created_by_run_id FROM proposals WHERE id = $1`,
      [String(saved.proposal_id)],
    );
    // The Proposal names its source Run for review; the definition it carries does not.
    expect(proposal.rows[0]?.created_by_run_id).toBe(sourceRunId);
    expectSanitizedDefinition(proposal.rows[0]?.payload_json.content_json, sourceRunId);

    const accepted = await PgProposalApplyService.fromConfig(serverConfig()).accept(String(saved.proposal_id), IDENTITY);
    expect(accepted).toMatchObject({
      proposal: { status: "accepted" },
      result_type: "evolvable_asset_version",
      result: { status: "draft", asset_key: "workflow.saved.reviewed" },
    });
    const draft = accepted!.result as { asset_id: string; version_id: string };
    const draftRow = await db.pool.query<{ status: string; content_json: unknown }>(
      `SELECT status, content_json FROM evolvable_asset_versions WHERE id = $1 AND asset_id = $2`,
      [draft.version_id, draft.asset_id],
    );
    expect(draftRow.rows[0]?.status).toBe("draft");
    expect(draftRow.rows[0]?.content_json).toEqual(proposal.rows[0]?.payload_json.content_json);

    const launched = await promoteAndLaunch({
      assetId: draft.asset_id,
      versionId: draft.version_id,
      assetKey: "workflow.saved.reviewed",
      expectedRisk: "high",
    });
    expectSanitizedDefinition(launched.approvedContent, sourceRunId);
    expect(JSON.stringify(launched.child)).not.toContain(sourceRunId);
    expect(launched.child.contract_snapshot_json).toMatchObject({ risk_level: "high" });
  });
});
