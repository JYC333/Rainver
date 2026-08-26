import { randomUUID } from "node:crypto";
import {
  HttpError,
  dateIso,
  objectValue,
  optionalObject,
  optionalString,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import {
  assertAssetAllowsTargetScope,
  assertCanReadAssetOwnerScope,
  assertCanWriteAssetOwnerScope,
  canViewScopedRef,
  normalizeVersionScopeForWrite,
  type EvolvableAssetAccessRow,
} from "./assetAccess.js";

const EVALUATION_STATUSES = new Set(["queued", "running", "passed", "failed", "blocked", "cancelled"]);
const EVALUATION_HARD_GATE_CASE_THRESHOLD = 5;

function requiredDateIso(value: unknown): string {
  return dateIso(value) ?? new Date(0).toISOString();
}

function enumValue(value: unknown, allowed: Set<string>, field: string): string | null {
  const text = optionalString(value);
  if (!text) return null;
  if (!allowed.has(text)) throw new HttpError(422, `${field} must be one of ${[...allowed].join(", ")}`);
  return text;
}

interface EvaluationRunRow {
  id: string;
  asset_id: string;
  candidate_version_id: string;
  baseline_version_id: string | null;
  evolution_target_id: string | null;
  run_id: string | null;
  eval_suite_ref_json: unknown;
  evaluator_version: string;
  model_provider_ref_json: unknown;
  status: string;
  metrics_json: unknown;
  blockers_json: unknown;
  output_artifact_id: string | null;
  report_artifact_id: string | null;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  candidate_space_id?: string | null;
  candidate_scope_type?: string;
  candidate_scope_id?: string | null;
}

const EVALUATION_RUN_COLUMN_NAMES = [
  "id",
  "asset_id",
  "candidate_version_id",
  "baseline_version_id",
  "evolution_target_id",
  "run_id",
  "eval_suite_ref_json",
  "evaluator_version",
  "model_provider_ref_json",
  "status",
  "metrics_json",
  "blockers_json",
  "output_artifact_id",
  "report_artifact_id",
  "created_by_user_id",
  "created_at",
  "updated_at",
] as const;

const EVALUATION_RUN_COLUMNS = EVALUATION_RUN_COLUMN_NAMES.join(", ");
const EVALUATION_RUN_COLUMNS_FROM_RUN = EVALUATION_RUN_COLUMN_NAMES.map((name) => `r.${name}`).join(", ");

interface AssetRow extends EvolvableAssetAccessRow {
  id: string;
  asset_key: string;
}

const ASSET_COLUMNS = `
  id, asset_key, space_id, owner_scope_type, owner_scope_id, metadata_json
`;

interface VersionRefRow {
  status: string;
  version: number;
  space_id: string | null;
  scope_type: string;
  scope_id: string | null;
}

function evaluationRunOut(row: EvaluationRunRow): Record<string, unknown> {
  return {
    id: row.id,
    asset_id: row.asset_id,
    candidate_version_id: row.candidate_version_id,
    baseline_version_id: row.baseline_version_id,
    evolution_target_id: row.evolution_target_id,
    run_id: row.run_id,
    eval_suite_ref: row.eval_suite_ref_json,
    evaluator_version: row.evaluator_version,
    model_provider_ref: row.model_provider_ref_json ?? null,
    status: row.status,
    metrics: objectValue(row.metrics_json),
    blockers: Array.isArray(row.blockers_json) ? row.blockers_json : [],
    output_artifact_id: row.output_artifact_id,
    report_artifact_id: row.report_artifact_id,
    created_by_user_id: row.created_by_user_id,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

/**
 * Evaluation-run metadata and promotion-proposal creation for evolvable
 * assets. The evaluation harness owns Verification Engine execution; this
 * repository remains the durable metadata boundary for executor results and
 * externally reported evidence.
 */
export class EvolvableAssetEvaluationRepository {
  constructor(private readonly db: Queryable) {}

  async listEvaluationRuns(identity: SpaceUserIdentity, assetId: string): Promise<Record<string, unknown>[]> {
    await this.requireReadableAsset(identity, assetId);
    const result = await this.db.query<EvaluationRunRow>(
      `SELECT ${EVALUATION_RUN_COLUMNS_FROM_RUN},
              v.space_id AS candidate_space_id,
              v.scope_type AS candidate_scope_type,
              v.scope_id AS candidate_scope_id
         FROM evolvable_asset_evaluation_runs r
         JOIN evolvable_asset_versions v ON v.id = r.candidate_version_id AND v.asset_id = r.asset_id
        WHERE r.asset_id = $1
        ORDER BY r.created_at DESC, r.id ASC`,
      [assetId],
    );
    const out: Record<string, unknown>[] = [];
    for (const row of result.rows) {
      if (await canViewVersionRef(this.db, identity, row)) out.push(evaluationRunOut(row));
    }
    return out;
  }

  async recordEvaluationRun(
    identity: SpaceUserIdentity,
    assetId: string,
    versionId: string,
    body: Record<string, unknown>,
    options: { trustedExecutor?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireWritableAsset(identity, assetId);
    const version = await this.versionRow(assetId, versionId);
    if (!version) throw new HttpError(422, "versionId does not reference a version of this asset");
    await normalizeVersionScopeForWrite(this.db, identity, version.scope_type, version.scope_id);
    assertAssetAllowsTargetScope(asset, identity, version.scope_type, version.scope_id);
    if (version.status !== "candidate" && version.status !== "testing") {
      throw new HttpError(422, "Only a candidate or testing version can record an evaluation run");
    }
    const evalSuiteRef = optionalObject(body.eval_suite_ref);
    if (!evalSuiteRef) throw new HttpError(422, "eval_suite_ref is required");
    const evaluatorVersion = optionalString(body.evaluator_version);
    if (!evaluatorVersion) throw new HttpError(422, "evaluator_version is required");
    const status = enumValue(body.status, EVALUATION_STATUSES, "status") ?? "queued";
    if (
      !options.trustedExecutor
      && status === "passed"
      && evaluatorVersion === "verification_engine.v1"
      && evalSuiteRef.kind === "evaluation_case"
    ) {
      throw new HttpError(403, "Evaluation Engine results can only be marked passed by the evaluation job");
    }
    const baselineVersionId = optionalString(body.baseline_version_id);
    if (baselineVersionId) {
      const baseline = await this.versionRow(assetId, baselineVersionId);
      if (!baseline) throw new HttpError(422, "baseline_version_id does not reference a version of this asset");
      if (!(await canViewVersionRef(this.db, identity, baseline))) {
        throw new HttpError(422, "baseline_version_id does not reference a visible version of this asset");
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO evolvable_asset_evaluation_runs (
         id, space_id, asset_id, candidate_version_id, baseline_version_id, run_id,
         eval_suite_ref_json, evaluator_version, model_provider_ref_json, status, metrics_json,
         blockers_json, output_artifact_id, report_artifact_id, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $16)`,
      [
        id,
        identity.spaceId,
        assetId,
        versionId,
        baselineVersionId,
        optionalString(body.run_id),
        JSON.stringify(evalSuiteRef),
        evaluatorVersion,
        optionalObject(body.model_provider_ref) ? JSON.stringify(body.model_provider_ref) : null,
        status,
        JSON.stringify(objectValue(body.metrics)),
        JSON.stringify(Array.isArray(body.blockers) ? body.blockers : []),
        optionalString(body.output_artifact_id),
        optionalString(body.report_artifact_id),
        identity.userId,
        now,
      ],
    );
    // Recording an evaluation run against a still-candidate version means
    // review/evaluation is now in progress — advance it to 'testing'.
    if (version.status === "candidate") {
      await this.db.query(`UPDATE evolvable_asset_versions SET status = 'testing', updated_at = $3 WHERE asset_id = $1 AND id = $2`, [
        assetId,
        versionId,
        now,
      ]);
    }
    const result = await this.db.query<EvaluationRunRow>(
      `SELECT ${EVALUATION_RUN_COLUMNS} FROM evolvable_asset_evaluation_runs WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(500, "Failed to record evaluation run");
    return evaluationRunOut(row);
  }

  async createPromotionProposal(
    identity: SpaceUserIdentity,
    assetId: string,
    versionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireWritableAsset(identity, assetId);
    const version = await this.versionRow(assetId, versionId);
    if (!version) throw new HttpError(422, "versionId does not reference a version of this asset");
    await normalizeVersionScopeForWrite(this.db, identity, version.scope_type, version.scope_id);
    assertAssetAllowsTargetScope(asset, identity, version.scope_type, version.scope_id);
    if (version.status !== "candidate" && version.status !== "testing") {
      throw new HttpError(422, "Only a candidate or testing version can be proposed for promotion");
    }
    const targetScopeType = optionalString(body.target_scope_type);
    if (!targetScopeType || !["project", "space", "system", "user", "agent"].includes(targetScopeType)) {
      throw new HttpError(422, "target_scope_type must be one of project, space, system, user, agent");
    }
    const targetScopeId = optionalString(body.target_scope_id);
    if (targetScopeType !== "system" && !targetScopeId) {
      throw new HttpError(422, "target_scope_id is required for non-system target_scope_type");
    }
    if (targetScopeType === "system" && targetScopeId) {
      throw new HttpError(422, "target_scope_id must be omitted for target_scope_type system");
    }
    const normalizedTargetScopeId = await normalizeVersionScopeForWrite(this.db, identity, targetScopeType, targetScopeId ?? null);
    assertAssetAllowsTargetScope(asset, identity, targetScopeType, normalizedTargetScopeId);
    const evaluationRunIds = Array.isArray(body.evaluation_run_ids)
      ? [...new Set(body.evaluation_run_ids.filter((value): value is string => typeof value === "string" && value.length > 0))].slice(0, 50)
      : [];
    const evaluationRows = await this.db.query<{
      id: string;
      status: string;
      metrics_json: unknown;
      created_at: unknown;
    }>(
      `SELECT id, status, metrics_json, created_at
         FROM evolvable_asset_evaluation_runs
        WHERE asset_id = $1 AND candidate_version_id = $2 AND space_id = $3
          ${evaluationRunIds.length > 0 ? "AND id = ANY($4::varchar[])" : ""}
        ORDER BY created_at DESC, id ASC`,
      evaluationRunIds.length > 0 ? [assetId, versionId, identity.spaceId, evaluationRunIds] : [assetId, versionId, identity.spaceId],
    );
    if (evaluationRunIds.length > 0 && evaluationRows.rows.length !== evaluationRunIds.length) {
      throw new HttpError(422, "evaluation_run_ids must reference evaluation runs for this candidate version");
    }
    const evaluationSummary = summarizeEvaluationRows(evaluationRows.rows);
    const caseCountResult = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM evaluation_cases WHERE asset_id = $1 AND space_id = $2 AND status = 'active'`,
      [assetId, identity.spaceId],
    );
    const caseCount = Number(caseCountResult.rows[0]?.count ?? 0);
    const assetRisk = optionalString(objectValue(asset.metadata_json).risk_level);
    const riskLevel = higherRisk(assetRisk, targetScopeType === "system" ? "high" : "medium");
    const autoHardGate = (riskLevel === "high" || riskLevel === "critical") && caseCount >= EVALUATION_HARD_GATE_CASE_THRESHOLD;
    const hardGate = body.hard_gate === true || body.evaluation_hard_gate === true || autoHardGate;
    const payload = {
      proposal_type: "evolvable_asset_version_promote",
      asset_id: assetId,
      candidate_version_id: versionId,
      target_scope_type: targetScopeType,
      target_scope_id: normalizedTargetScopeId,
      pin_after_approval: body.pin_after_approval === true,
      deprecate_previous: body.deprecate_previous === true,
      evaluation_run_ids: evaluationRunIds,
      evaluation_policy: {
        mode: hardGate ? "hard_gate" : "warn_only",
        hard_gate: hardGate,
      },
      evaluation_summary: evaluationSummary,
      evaluation_case_count: caseCount,
      evaluation_hard_gate_threshold: EVALUATION_HARD_GATE_CASE_THRESHOLD,
      evaluation_risk_level: riskLevel,
      reason: optionalString(body.reason),
      deployment_label: optionalString(body.deployment_label),
    };
    const row = await insertProposalRow(this.db, {
      spaceId: identity.spaceId,
      proposalType: "evolvable_asset_version_promote",
      title: `Promote ${asset.asset_key} v${version.version} to ${targetScopeType}${normalizedTargetScopeId ? `:${normalizedTargetScopeId}` : ""}`,
      summary: optionalString(body.reason),
      payload,
      rationale: optionalString(body.reason) ?? "Asset version promotion",
      createdByUserId: identity.userId,
      visibility: "space_shared",
      riskLevel,
      projectId: targetScopeType === "project" ? normalizedTargetScopeId : null,
    });
    return {
      proposal_id: row.id,
      status: row.status,
      proposal_type: row.proposal_type,
    };
  }

  private async requireReadableAsset(identity: SpaceUserIdentity, assetId: string): Promise<AssetRow> {
    const result = await this.db.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM evolvable_assets WHERE id = $1 AND (space_id = $2 OR space_id IS NULL) LIMIT 1`,
      [assetId, identity.spaceId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Evolvable asset not found");
    await assertCanReadAssetOwnerScope(this.db, identity, row);
    return row;
  }

  private async requireWritableAsset(identity: SpaceUserIdentity, assetId: string): Promise<AssetRow> {
    const row = await this.requireReadableAsset(identity, assetId);
    await assertCanWriteAssetOwnerScope(this.db, identity, row);
    return row;
  }

  private async versionRow(assetId: string, versionId: string): Promise<VersionRefRow | null> {
    const result = await this.db.query<VersionRefRow>(
      `SELECT status, version, space_id, scope_type, scope_id FROM evolvable_asset_versions WHERE asset_id = $1 AND id = $2 LIMIT 1`,
      [assetId, versionId],
    );
    return result.rows[0] ?? null;
  }
}

function higherRisk(left: string | null, right: string): string {
  const order = ["low", "medium", "high", "critical"];
  const leftValue = left && order.includes(left) ? left : "low";
  return order[Math.max(order.indexOf(leftValue), order.indexOf(right))] ?? right;
}

function summarizeEvaluationRows(rows: Array<{ id: string; status: string; metrics_json: unknown; created_at: unknown }>): Record<string, unknown> {
  const counts = rows.reduce<Record<string, number>>((out, row) => {
    out[row.status] = (out[row.status] ?? 0) + 1;
    return out;
  }, {});
  const latest = rows[0];
  return {
    evaluator_version: rows.length > 0 ? "verification_engine.v1" : null,
    total: rows.length,
    passed: counts.passed ?? 0,
    failed: counts.failed ?? 0,
    blocked: counts.blocked ?? 0,
    queued: counts.queued ?? 0,
    running: counts.running ?? 0,
    latest_run_id: latest?.id ?? null,
    latest_status: latest?.status ?? null,
    latest_metrics: latest ? objectValue(latest.metrics_json) : {},
    recorded_at: latest ? dateIso(latest.created_at) : null,
  };
}

async function canViewVersionRef(
  db: Queryable,
  identity: SpaceUserIdentity,
  version: {
    space_id?: string | null;
    scope_type?: string;
    scope_id?: string | null;
    candidate_space_id?: string | null;
    candidate_scope_type?: string;
    candidate_scope_id?: string | null;
  },
): Promise<boolean> {
  const spaceId = version.space_id ?? version.candidate_space_id ?? null;
  const scopeType = version.scope_type ?? version.candidate_scope_type;
  const scopeId = version.scope_id ?? version.candidate_scope_id ?? null;
  if (!scopeType) return false;
  if (spaceId === null) return scopeType === "system";
  if (spaceId !== identity.spaceId) return false;
  return canViewScopedRef(db, identity, scopeType, scopeId);
}
