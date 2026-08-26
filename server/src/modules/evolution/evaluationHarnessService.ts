import { randomUUID } from "node:crypto";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import {
  HttpError,
  objectValue,
  optionalString,
  withQueryableTransaction,
} from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { PgRunRepository } from "../runs/repository.js";
import { sanitizeEvidenceJson } from "../runs/evidenceRedaction.js";
import { verifyEvaluationOutput, VERIFICATION_ENGINE_VERSION } from "../runs/verification/index.js";
import {
  assertAssetAllowsTargetScope,
  assertCanReadAssetOwnerScope,
  assertCanWriteAssetOwnerScope,
  canViewScopedRef,
  type EvolvableAssetAccessRow,
} from "./assetAccess.js";
import { EvolvableAssetEvaluationRepository } from "./assetEvaluationRepository.js";

export const EVOLVABLE_ASSET_EVALUATION_JOB = "evolvable_asset_evaluation";
export const EVALUATION_CASE_EVALUATOR_VERSION = VERIFICATION_ENGINE_VERSION;
const MAX_FIXTURE_BYTES = 128_000;

interface AssetRow extends EvolvableAssetAccessRow {
  id: string;
  asset_key: string;
  asset_type: string;
}

interface VersionRow {
  id: string;
  asset_id: string;
  status: string;
  version: number;
  scope_type: string;
  scope_id: string | null;
  content_json: unknown;
}

interface EvaluationCaseRow {
  id: string;
  space_id: string;
  asset_id: string;
  name: string;
  description: string | null;
  input_json: unknown;
  expectation_json: unknown;
  verification_recipe_json: unknown;
  baseline_output_json: unknown;
  baseline_version_id: string;
  source_run_id: string | null;
  status: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EvaluationRunRow {
  id: string;
  asset_id: string;
  candidate_version_id: string;
  baseline_version_id: string | null;
  run_id: string | null;
  eval_suite_ref_json: unknown;
  evaluator_version: string;
  status: string;
  metrics_json: unknown;
  blockers_json: unknown;
  created_at: string;
  updated_at: string;
}

const CASE_COLUMNS = `
  id, space_id, asset_id, name, description, input_json, expectation_json,
  verification_recipe_json, baseline_output_json, baseline_version_id,
  source_run_id, status, created_by_user_id, created_at, updated_at
`;

const EVALUATION_COLUMNS = `
  id, asset_id, candidate_version_id, baseline_version_id, run_id,
  eval_suite_ref_json, evaluator_version, status, metrics_json, blockers_json,
  created_at, updated_at
`;

export interface CreateEvaluationCaseInput {
  name?: string | null;
  description?: string | null;
  input_json?: Record<string, unknown> | null;
  expectation_json?: Record<string, unknown> | null;
  verification_recipe_json?: Record<string, unknown> | null;
  baseline_version_id?: string | null;
  baseline_output_json?: unknown;
  source_run_id?: string | null;
}

export interface StartEvaluationInput {
  candidate_run_id?: string | null;
}

export class EvaluationHarnessService {
  constructor(private readonly db: Queryable) {}

  async listCases(identity: SpaceUserIdentity, assetId: string): Promise<Record<string, unknown>[]> {
    await this.requireReadableAsset(identity, assetId);
    const result = await this.db.query<EvaluationCaseRow>(
      `SELECT ${CASE_COLUMNS}
         FROM evaluation_cases
        WHERE space_id = $1 AND asset_id = $2
        ORDER BY created_at DESC, id ASC`,
      [identity.spaceId, assetId],
    );
    return result.rows.map(caseOut);
  }

  async createCase(
    identity: SpaceUserIdentity,
    assetId: string,
    input: CreateEvaluationCaseInput,
  ): Promise<Record<string, unknown>> {
    if (input.source_run_id) {
      throw new HttpError(422, "Use the from-run endpoint when source_run_id is provided");
    }
    const baselineOutput = input.baseline_output_json;
    if (baselineOutput === undefined) {
      throw new HttpError(422, "baseline_output_json is required unless creating a case from a run");
    }
    return this.insertCase(identity, assetId, input, baselineOutput);
  }

  async createCaseFromRun(
    identity: SpaceUserIdentity,
    assetId: string,
    input: CreateEvaluationCaseInput & { source_run_id: string },
  ): Promise<Record<string, unknown>> {
    const run = await new PgRunRepository(this.db).getVisibleRun(identity.spaceId, identity.userId, input.source_run_id);
    if (!run) throw new HttpError(404, "Source run not found");
    if (run.status !== "succeeded" && run.status !== "degraded") {
      throw new HttpError(422, "Only a successful or degraded terminal run can create an evaluation case");
    }
    const evaluation = await new PgRunRepository(this.db).getLatestRunEvaluation(identity.spaceId, run.id);
    if (!evaluation || evaluation.outcome_status !== "passed") {
      throw new HttpError(422, "Source run must have a passed post-run evaluation");
    }
    return this.insertCase(identity, assetId, input, run.output_json);
  }

  async startEvaluation(
    identity: SpaceUserIdentity,
    assetId: string,
    candidateVersionId: string,
    caseId: string,
    input: StartEvaluationInput,
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireWritableAsset(identity, assetId);
    const candidate = await this.versionRow(assetId, candidateVersionId);
    if (!candidate) throw new HttpError(404, "Candidate version not found");
    if (candidate.status !== "candidate" && candidate.status !== "testing") {
      throw new HttpError(422, "Only a candidate or testing version can be evaluated");
    }
    await this.assertVisibleVersion(identity, asset, candidate);
    const evaluationCase = await this.caseRow(identity, assetId, caseId);
    const candidateRunId = optionalString(input.candidate_run_id);
    if (!candidateRunId) throw new HttpError(422, "candidate_run_id is required");
    const candidateRun = await new PgRunRepository(this.db).getVisibleRun(identity.spaceId, identity.userId, candidateRunId);
    if (!candidateRun) throw new HttpError(404, "Candidate run not found");
    if (candidateRun.status !== "succeeded" && candidateRun.status !== "degraded") {
      throw new HttpError(422, "Candidate run must be successful or degraded before evaluation");
    }
    const candidateEvaluation = await new PgRunRepository(this.db).getLatestRunEvaluation(identity.spaceId, candidateRun.id);
    if (!candidateEvaluation || candidateEvaluation.outcome_status !== "passed") {
      throw new HttpError(422, "Candidate run must have a passed post-run evaluation");
    }
    if (candidateRun.workflow_version_id !== candidateVersionId) {
      throw new HttpError(422, "Candidate run must execute the requested candidate asset version");
    }
    const evalSuiteRef = {
      kind: "evaluation_case",
      case_id: evaluationCase.id,
      baseline_run_id: evaluationCase.source_run_id,
      candidate_run_id: candidateRun.id,
      connector_mode: "mock_read_only",
      verification_engine: EVALUATION_CASE_EVALUATOR_VERSION,
    };

    return withQueryableTransaction(this.db, async (client) => {
      const recorded = await new EvolvableAssetEvaluationRepository(client).recordEvaluationRun(
        identity,
        assetId,
        candidateVersionId,
        {
          baseline_version_id: evaluationCase.baseline_version_id,
          run_id: candidateRun.id,
          eval_suite_ref: evalSuiteRef,
          evaluator_version: EVALUATION_CASE_EVALUATOR_VERSION,
          status: "queued",
          metrics: {},
          blockers: [],
        },
        { trustedExecutor: true },
      );
      const job = await new PgJobQueueRepository(client).enqueue({
        job_type: EVOLVABLE_ASSET_EVALUATION_JOB,
        payload: {
          evaluation_run_id: recorded.id,
          evaluation_case_id: evaluationCase.id,
          asset_id: assetId,
          candidate_version_id: candidateVersionId,
          candidate_run_id: candidateRun.id,
        },
        space_id: identity.spaceId,
        user_id: identity.userId,
        max_attempts: 2,
      });
      return { evaluation_run: recorded, job_id: job.id, connector_mode: "mock_read_only" };
    });
  }

  async executeEvaluation(input: {
    evaluationRunId: string;
    evaluationCaseId: string;
    assetId: string;
    candidateVersionId: string;
    candidateRunId: string;
  }): Promise<Record<string, unknown>> {
    const loaded = await this.db.query<{
      evaluation_run_id: string;
      evaluation_case_id: string;
      asset_id: string;
      candidate_version_id: string;
      baseline_version_id: string;
      baseline_output_json: unknown;
      verification_recipe_json: unknown;
      candidate_content_json: unknown;
      candidate_output_json: unknown;
      status: string;
    }>(
      `SELECT r.id AS evaluation_run_id, c.id AS evaluation_case_id,
              r.asset_id, r.candidate_version_id, c.baseline_version_id,
              c.baseline_output_json, c.verification_recipe_json,
              v.content_json AS candidate_content_json, cr.output_json AS candidate_output_json, r.status
         FROM evolvable_asset_evaluation_runs r
         JOIN evaluation_cases c
           ON c.id = $2 AND c.asset_id = r.asset_id
          AND c.baseline_version_id = r.baseline_version_id
          AND c.status = 'active'
         JOIN evolvable_asset_versions v
           ON v.id = r.candidate_version_id AND v.asset_id = r.asset_id
         JOIN runs cr
           ON cr.id = r.run_id AND cr.space_id = r.space_id AND cr.id = $5
        WHERE r.id = $1 AND r.asset_id = $3 AND r.candidate_version_id = $4
        LIMIT 1`,
      [input.evaluationRunId, input.evaluationCaseId, input.assetId, input.candidateVersionId, input.candidateRunId],
    );
    const row = loaded.rows[0];
    if (!row) throw new Error("Evaluation run or case no longer exists");
    if (["passed", "failed", "blocked", "cancelled"].includes(row.status)) {
      return this.evaluationOut(input.evaluationRunId);
    }
    await this.db.query(
      `UPDATE evolvable_asset_evaluation_runs SET status = 'running', updated_at = now() WHERE id = $1`,
      [input.evaluationRunId],
    );

    try {
      const recipe = objectValue(row.verification_recipe_json);
      const baseline = verifyEvaluationOutput(row.baseline_output_json, recipe);
      const candidate = verifyEvaluationOutput(row.candidate_output_json, recipe);
      const regressionDetected = baseline.status === "passed"
        && (candidate.status !== "passed" || candidate.score < baseline.score);
      const blockers: Array<Record<string, unknown>> = [];
      if (baseline.status !== "passed") {
        blockers.push({ code: "baseline_verification_failed", status: baseline.status });
      }
      if (regressionDetected) {
        blockers.push({ code: "candidate_regression", baseline_score: baseline.score, candidate_score: candidate.score });
      }
      const status = baseline.status !== "passed"
        ? "blocked"
        : regressionDetected
          ? "failed"
          : candidate.status === "passed" ? "passed" : "failed";
      const metrics = {
        baseline_score: baseline.score,
        candidate_score: candidate.score,
        score_delta: candidate.score - baseline.score,
        baseline_status: baseline.status,
        candidate_status: candidate.status,
        regression_detected: regressionDetected,
        baseline_checks: baseline.checks,
        candidate_checks: candidate.checks,
        connector_mode: "mock_read_only",
        candidate_content_present: row.candidate_content_json !== null,
      };
      await this.db.query(
        `UPDATE evolvable_asset_evaluation_runs
            SET status = $2, metrics_json = $3::jsonb, blockers_json = $4::jsonb, updated_at = now()
          WHERE id = $1`,
        [input.evaluationRunId, status, JSON.stringify(metrics), JSON.stringify(blockers)],
      );
      await this.db.query(
        `UPDATE evolvable_asset_versions
            SET eval_summary_json = $2::jsonb, updated_at = now()
          WHERE id = $1`,
        [input.candidateVersionId, JSON.stringify({ evaluator_version: EVALUATION_CASE_EVALUATOR_VERSION, status, metrics, blockers })],
      );
    } catch (error) {
      await this.db.query(
        `UPDATE evolvable_asset_evaluation_runs
            SET status = 'failed', blockers_json = $2::jsonb, updated_at = now()
          WHERE id = $1`,
        [input.evaluationRunId, JSON.stringify([{ code: "evaluation_executor_error", message: error instanceof Error ? error.message : String(error) }])],
      );
      throw error;
    }
    return this.evaluationOut(input.evaluationRunId);
  }

  private async insertCase(
    identity: SpaceUserIdentity,
    assetId: string,
    input: CreateEvaluationCaseInput,
    baselineOutput: unknown,
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireWritableAsset(identity, assetId);
    const name = optionalString(input.name);
    if (!name) throw new HttpError(422, "name is required");
    const baselineVersionId = optionalString(input.baseline_version_id);
    if (!baselineVersionId) throw new HttpError(422, "baseline_version_id is required");
    const baselineVersion = await this.versionRow(assetId, baselineVersionId);
    if (!baselineVersion || baselineVersion.status !== "approved") {
      throw new HttpError(422, "baseline_version_id must reference an approved version of this asset");
    }
    await this.assertVisibleVersion(identity, asset, baselineVersion);
    const recipe = objectFixture(input.verification_recipe_json, "verification_recipe_json");
    if (!Array.isArray(recipe.checks) || recipe.checks.length === 0) {
      throw new HttpError(422, "verification_recipe_json.checks must contain at least one check");
    }
    const caseInput = objectFixture(input.input_json ?? {}, "input_json");
    const expectation = objectFixture(input.expectation_json ?? {}, "expectation_json");
    const fixture = fixtureValue(baselineOutput, "baseline_output_json");
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO evaluation_cases (
         id, space_id, asset_id, name, description, input_json, expectation_json,
         verification_recipe_json, baseline_output_json, baseline_version_id,
         source_run_id, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, 'active', $12, $13, $13)`,
      [
        id,
        identity.spaceId,
        assetId,
        name,
        optionalString(input.description),
        JSON.stringify(caseInput),
        JSON.stringify(expectation),
        JSON.stringify(recipe),
        JSON.stringify(fixture),
        baselineVersionId,
        optionalString(input.source_run_id),
        identity.userId,
        now,
      ],
    );
    const result = await this.db.query<EvaluationCaseRow>(`SELECT ${CASE_COLUMNS} FROM evaluation_cases WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw new HttpError(500, "Failed to create evaluation case");
    return caseOut(row);
  }

  private async evaluationOut(id: string): Promise<Record<string, unknown>> {
    const result = await this.db.query<EvaluationRunRow>(`SELECT ${EVALUATION_COLUMNS} FROM evolvable_asset_evaluation_runs WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw new Error("Evaluation run disappeared");
    return {
      id: row.id,
      asset_id: row.asset_id,
      candidate_version_id: row.candidate_version_id,
      baseline_version_id: row.baseline_version_id,
      run_id: row.run_id,
      eval_suite_ref: row.eval_suite_ref_json,
      evaluator_version: row.evaluator_version,
      status: row.status,
      metrics: objectValue(row.metrics_json),
      blockers: Array.isArray(row.blockers_json) ? row.blockers_json : [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private async caseRow(identity: SpaceUserIdentity, assetId: string, caseId: string): Promise<EvaluationCaseRow> {
    const result = await this.db.query<EvaluationCaseRow>(
      `SELECT ${CASE_COLUMNS} FROM evaluation_cases WHERE id = $1 AND space_id = $2 AND asset_id = $3 AND status = 'active' LIMIT 1`,
      [caseId, identity.spaceId, assetId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Evaluation case not found");
    return row;
  }

  private async requireReadableAsset(identity: SpaceUserIdentity, assetId: string): Promise<AssetRow> {
    const result = await this.db.query<AssetRow>(
      `SELECT id, asset_key, asset_type, space_id, owner_scope_type, owner_scope_id, metadata_json
         FROM evolvable_assets WHERE id = $1 AND (space_id = $2 OR space_id IS NULL) LIMIT 1`,
      [assetId, identity.spaceId],
    );
    const asset = result.rows[0];
    if (!asset) throw new HttpError(404, "Evolvable asset not found");
    await assertCanReadAssetOwnerScope(this.db, identity, asset);
    return asset;
  }

  private async requireWritableAsset(identity: SpaceUserIdentity, assetId: string): Promise<AssetRow> {
    const asset = await this.requireReadableAsset(identity, assetId);
    await assertCanWriteAssetOwnerScope(this.db, identity, asset);
    return asset;
  }

  private async versionRow(assetId: string, versionId: string): Promise<VersionRow | null> {
    const result = await this.db.query<VersionRow>(
      `SELECT id, asset_id, status, version, scope_type, scope_id, content_json
         FROM evolvable_asset_versions WHERE asset_id = $1 AND id = $2 LIMIT 1`,
      [assetId, versionId],
    );
    return result.rows[0] ?? null;
  }

  private async assertVisibleVersion(identity: SpaceUserIdentity, asset: AssetRow, version: VersionRow): Promise<void> {
    await assertAssetAllowsTargetScope(asset, identity, version.scope_type, version.scope_id);
    if (!(await canViewScopedRef(this.db, identity, version.scope_type, version.scope_id))) {
      throw new HttpError(404, "Asset version not found");
    }
  }
}

function caseOut(row: EvaluationCaseRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    asset_id: row.asset_id,
    name: row.name,
    description: row.description,
    input_json: objectValue(row.input_json),
    expectation_json: objectValue(row.expectation_json),
    verification_recipe_json: objectValue(row.verification_recipe_json),
    baseline_output_json: row.baseline_output_json,
    baseline_version_id: row.baseline_version_id,
    source_run_id: row.source_run_id,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function fixtureValue(value: unknown, field: string): unknown {
  if (value === undefined) throw new HttpError(422, `${field} is required`);
  const sanitized = sanitizeEvidenceJson(value);
  const bytes = Buffer.byteLength(JSON.stringify(sanitized) ?? "null", "utf8");
  if (bytes > MAX_FIXTURE_BYTES) throw new HttpError(422, `${field} exceeds the ${MAX_FIXTURE_BYTES}-byte limit`);
  return sanitized;
}

function objectFixture(value: unknown, field: string): Record<string, unknown> {
  const fixture = fixtureValue(value, field);
  const object = objectValue(fixture);
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new HttpError(422, `${field} must be a JSON object`);
  }
  return object;
}
