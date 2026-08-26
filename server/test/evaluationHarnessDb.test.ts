import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import type { ServerConfig } from "../src/config.js";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository.js";
import { EvolvableAssetEvaluationRepository } from "../src/modules/evolution/assetEvaluationRepository.js";
import { EvaluationHarnessService } from "../src/modules/evolution/evaluationHarnessService.js";
import { registerEvolvableAssetPromotionProposalApplier } from "../src/modules/evolution/assetPromotionProposalApplier.js";
import { registerEvaluationHarnessHandler } from "../src/modules/evolution/evaluationJob.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { JobWorker } from "../src/modules/jobs/worker.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { ProposalApplierRegistry, type ProposalApplyContext } from "../src/modules/proposals/applierRegistry.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";


const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["evaluation_cases", "evolvable_asset_evaluation_runs", "evolvable_asset_pins", "evolvable_asset_versions", "evolvable_assets", "evolution_experiences", "proposals", "jobs", "job_events", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Eval Space', 'team', $2, $2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Eval Owner', 'active', $2, $2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Evaluation Agent', 'active', NULL, 'space_shared', $4, $4)`,
    [AGENT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'Test', '{}'::jsonb, '{"adapter_type":"model_api"}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, AGENT_VERSION]);
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, runtime_config_json,
       runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Default', 'model_api', '{"adapter_type":"model_api"}'::jsonb,
       '{}'::jsonb, true, true, $4, $4)`,
    [randomUUID(), SPACE, AGENT, now],
  );
});

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

function assetRepo(): EvolvableAssetRepository {
  return new EvolvableAssetRepository(db.pool);
}

function evaluationRepo(): EvolvableAssetEvaluationRepository {
  return new EvolvableAssetEvaluationRepository(db.pool);
}

async function applyProposal(proposalId: string): Promise<Record<string, unknown>> {
  const result = await db.pool.query<{
    id: string;
    space_id: string;
    proposal_type: string;
    payload_json: Record<string, unknown>;
    status: string;
  }>(`SELECT id, space_id, proposal_type, payload_json, status FROM proposals WHERE id = $1`, [proposalId]);
  const row = result.rows[0];
  if (!row) throw new Error("proposal not found");
  const context: ProposalApplyContext = {
    config: {} as ServerConfig,
    db: db.pool as unknown as ProposalApplyContext["db"],
    proposal: {
      ...row,
      status: "accepted",
      risk_level: "medium",
      preview: false,
      project_folder_id: null,
      visibility: "space_shared",
      created_by_user_id: OWNER,
      created_by_agent_id: null,
      created_by_run_id: null,
      project_id: null,
      title: "Evaluation baseline",
      required_approver_role: null,
    } as ApplyProposal,
    userId: OWNER,
  };
  const registry = new ProposalApplierRegistry();
  registerEvolvableAssetPromotionProposalApplier(registry);
  const applied = await registry.apply(context);
  return applied.result as Record<string, unknown>;
}

async function createApprovedBaseline(): Promise<{ assetId: string; baselineId: string; candidateId: string }> {
  const asset = await assetRepo().createAsset(identity, {
    asset_type: "prompt_template",
    asset_key: "evaluation.fixture.asset",
    display_name: "Evaluation fixture asset",
  });
  const baseline = await assetRepo().createVersion(identity, asset.id as string, {
    scope_type: "space",
    content_json: { prompt: "baseline" },
  });
  await assetRepo().transitionVersionStatus(identity, asset.id as string, baseline.id as string, { status: "candidate" });
  await evaluationRepo().recordEvaluationRun(identity, asset.id as string, baseline.id as string, {
    eval_suite_ref: { kind: "bootstrap" },
    evaluator_version: "test",
    status: "passed",
    metrics: {},
  });
  const proposal = await evaluationRepo().createPromotionProposal(identity, asset.id as string, baseline.id as string, {
    target_scope_type: "space",
    target_scope_id: SPACE,
  });
  await applyProposal(proposal.proposal_id as string);

  const candidate = await assetRepo().createVersion(identity, asset.id as string, {
    scope_type: "space",
    parent_version_id: baseline.id,
    content_json: { prompt: "candidate" },
  });
  await assetRepo().transitionVersionStatus(identity, asset.id as string, candidate.id as string, { status: "candidate" });
  return { assetId: asset.id as string, baselineId: baseline.id as string, candidateId: candidate.id as string };
}

async function createSuccessfulSourceRun(workflowVersionId: string | null = null, output: Record<string, unknown> = { ok: true }): Promise<string> {
  const run = await new PgRunRepository(db.pool).createQueuedRun({
    agent_id: AGENT,
    space_id: SPACE,
    user_id: OWNER,
    mode: "live",
    run_type: "agent",
    trigger_origin: "manual",
    prompt: "evaluation fixture",
    workflow_version_id: workflowVersionId,
    contract_snapshot: { source: { kind: "direct", id: null }, risk_level: "low" },
  });
  const now = new Date().toISOString();
  await db.pool.query(
    `UPDATE runs SET status = 'succeeded', output_json = $2::jsonb, ended_at = $3, updated_at = $3 WHERE id = $1`,
    [run.id, JSON.stringify(output), now],
  );
  await db.pool.query(
    `INSERT INTO run_evaluations (
       id, space_id, run_id, evaluator_type, evaluator_version, outcome_status,
       trajectory_status, evidence_json, rule_trace_json, evaluated_at
     ) VALUES ($1, $2, $3, 'deterministic_harness', 'test', 'passed', 'acceptable', '{}'::jsonb, '[]'::jsonb, $4)`,
    [randomUUID(), SPACE, run.id, now],
  );
  return run.id;
}

async function runEvaluation(
  service: EvaluationHarnessService,
  assetId: string,
  candidateId: string,
  caseId: string,
  candidateRunId: string,
): Promise<Record<string, unknown>> {
  const started = await service.startEvaluation(identity, assetId, candidateId, caseId, {
    candidate_run_id: candidateRunId,
  });
  const registry = new JobHandlerRegistry();
  const config = { databaseUrl: db.connectionUri } as ServerConfig;
  registerEvaluationHarnessHandler(registry, config);
  const queue = new PgJobQueueRepository(db.pool);
  const worker = new JobWorker(queue, registry, "evaluation-test-worker", ["evolvable_asset_evaluation"], 0);
  const processed = await worker.processOne();
  expect(processed.status).toBe("completed");
  const row = await db.pool.query<{ status: string; metrics_json: Record<string, unknown>; blockers_json: unknown[] }>(
    `SELECT status, metrics_json, blockers_json FROM evolvable_asset_evaluation_runs WHERE id = $1`,
    [String((started.evaluation_run as Record<string, unknown>).id)],
  );
  return row.rows[0] as unknown as Record<string, unknown>;
}

describe("evaluation harness (real Postgres and job worker)", () => {
  it("creates a case, executes Verification Engine checks, and detects candidate regression", async () => {
    if (!db.available) return;
    const { assetId, baselineId, candidateId } = await createApprovedBaseline();
    const service = new EvaluationHarnessService(db.pool);
    const sourceRunId = await createSuccessfulSourceRun();
    const evaluationCase = await service.createCaseFromRun(identity, assetId, {
      name: "Result has an ok field",
      baseline_version_id: baselineId,
      source_run_id: sourceRunId,
      verification_recipe_json: {
        checks: [{ type: "output_schema", schema: { type: "object", required: ["ok"] } }],
      },
    });
    await expect(
      service.startEvaluation(identity, assetId, candidateId, String(evaluationCase.id), {
        candidate_output_json: { ok: true },
      } as unknown as { candidate_run_id: string }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const passedRunId = await createSuccessfulSourceRun(candidateId, { ok: true });
    const passed = await runEvaluation(service, assetId, candidateId, String(evaluationCase.id), passedRunId);
    expect(passed.status).toBe("passed");
    expect((passed.metrics_json as Record<string, unknown>).connector_mode).toBe("mock_read_only");

    const failedRunId = await createSuccessfulSourceRun(candidateId, { wrong: true });
    const failed = await runEvaluation(service, assetId, candidateId, String(evaluationCase.id), failedRunId);
    expect(failed.status).toBe("failed");
    expect(failed.blockers_json).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "candidate_regression" }),
    ]));
  });

  it("does not allow a public record call to forge a passed engine evaluation", async () => {
    if (!db.available) return;
    const { assetId, candidateId } = await createApprovedBaseline();
    await expect(
      evaluationRepo().recordEvaluationRun(identity, assetId, candidateId, {
        eval_suite_ref: { kind: "evaluation_case", case_id: "forged" },
        evaluator_version: "verification_engine.v1",
        status: "passed",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("embeds the evaluation summary and enforces an explicit hard gate", async () => {
    if (!db.available) return;
    const { assetId, candidateId } = await createApprovedBaseline();
    const proposal = await evaluationRepo().createPromotionProposal(identity, assetId, candidateId, {
      target_scope_type: "space",
      target_scope_id: SPACE,
      hard_gate: true,
    });
    const stored = await db.pool.query<{ payload_json: Record<string, unknown> }>(`SELECT payload_json FROM proposals WHERE id = $1`, [proposal.proposal_id]);
    expect(stored.rows[0]?.payload_json).toMatchObject({
      evaluation_policy: { mode: "hard_gate", hard_gate: true },
      evaluation_summary: { total: 0, passed: 0 },
    });
    await expect(applyProposal(proposal.proposal_id as string)).rejects.toThrow(/hard gate/i);
  });
});
