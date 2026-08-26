import { randomUUID } from "node:crypto";
import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import {
  assertAssetAllowsTargetScope,
  assertCanWriteAssetOwnerScope,
  normalizeVersionScopeForWrite,
  type EvolvableAssetAccessRow,
} from "./assetAccess.js";
import { lockEvolutionAssets } from "./assetLocks.js";

interface PromotePayload {
  asset_id: string;
  candidate_version_id: string;
  target_scope_type: "project" | "space" | "system" | "user" | "agent";
  target_scope_id?: string | null;
  pin_after_approval?: boolean;
  deprecate_previous?: boolean;
  evaluation_run_ids?: string[];
  evaluation_policy?: { hard_gate?: boolean; mode?: string };
  reason?: string;
  deployment_label?: string | null;
}

interface AssetPromotionRow extends EvolvableAssetAccessRow {
  id: string;
  asset_type: string;
}

/**
 * Applies an `evolvable_asset_version_promote` proposal: the only path a
 * candidate/testing asset version can reach `approved` status (see
 * assetRepository.transitionVersionStatus, which rejects direct
 * draft/candidate/testing -> approved transitions). Approval always goes
 * through the standard proposal review trail, never a direct write.
 */
export function registerEvolvableAssetPromotionProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register("evolvable_asset_version_promote", applyEvolvableAssetVersionPromote);
}

async function applyEvolvableAssetVersionPromote(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json as unknown as PromotePayload;
  const spaceId = context.proposal.space_id;
  const db = context.db;
  await lockEvolutionAssets(db, [payload.asset_id]);

  const identity = { spaceId, userId: context.userId };
  const assetResult = await db.query<AssetPromotionRow>(
    `SELECT id, asset_type, space_id, owner_scope_type, owner_scope_id, metadata_json
       FROM evolvable_assets
      WHERE id = $1 AND (space_id = $2 OR space_id IS NULL)
      LIMIT 1`,
    [payload.asset_id, spaceId],
  );
  const asset = assetResult.rows[0];
  if (!asset) throw new Error(`evolvable asset ${payload.asset_id} not found in this space`);
  await assertCanWriteAssetOwnerScope(db, identity, asset);

  const versionResult = await db.query<{
    id: string;
    status: string;
    space_id: string | null;
    scope_type: string;
    scope_id: string | null;
  }>(
    `SELECT id, status, space_id, scope_type, scope_id FROM evolvable_asset_versions WHERE asset_id = $1 AND id = $2 LIMIT 1`,
    [payload.asset_id, payload.candidate_version_id],
  );
  const candidate = versionResult.rows[0];
  if (!candidate) throw new Error(`candidate_version_id ${payload.candidate_version_id} does not belong to asset ${payload.asset_id}`);
  if (candidate.status !== "candidate" && candidate.status !== "testing") {
    throw new Error(`candidate version must be in status 'candidate' or 'testing', found '${candidate.status}'`);
  }
  await normalizeVersionScopeForWrite(db, identity, candidate.scope_type, candidate.scope_id);
  assertAssetAllowsTargetScope(asset, identity, candidate.scope_type, candidate.scope_id);

  // Evaluation is warn-only by default. A proposal can opt into the hard
  // gate, but the applier always recomputes the decision from the database;
  // the proposal's embedded summary is evidence, not authority.
  const evalParams: unknown[] = [payload.asset_id, payload.candidate_version_id, spaceId];
  let evalClause = "asset_id = $1 AND candidate_version_id = $2 AND space_id = $3";
  if (payload.evaluation_policy?.hard_gate === true) {
    evalClause += " AND status = 'passed' AND evaluator_version = 'verification_engine.v1' AND eval_suite_ref_json->>'kind' = 'evaluation_case'";
  }
  if (payload.evaluation_run_ids && payload.evaluation_run_ids.length > 0) {
    evalParams.push(payload.evaluation_run_ids);
    evalClause += ` AND id = ANY($${evalParams.length})`;
  }
  const evaluationRows = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM evolvable_asset_evaluation_runs WHERE ${evalClause} ORDER BY created_at DESC, id ASC`,
    evalParams,
  );
  const passedEvaluation = evaluationRows.rows.some((row) => row.status === "passed");
  const hardGate = payload.evaluation_policy?.hard_gate === true;
  if (hardGate && !passedEvaluation) {
    throw new Error("Promotion hard gate requires at least one passed evaluation run for this candidate version");
  }
  const evaluationSummary = summarizeEvaluationRows(evaluationRows.rows);

  const targetScopeType = payload.target_scope_type;
  const targetScopeId = payload.target_scope_id ?? null;
  if (!["project", "space", "system", "user", "agent"].includes(targetScopeType)) {
    throw new Error("target_scope_type must be one of project, space, system, user, agent");
  }
  if (targetScopeType !== "system" && !targetScopeId) {
    throw new Error(`target_scope_id is required for target_scope_type '${targetScopeType}'`);
  }
  if (targetScopeType === "space" && targetScopeId !== spaceId) {
    throw new Error("space-scoped asset promotion target_scope_id must match the proposal space_id");
  }
  if (targetScopeType === "system" && targetScopeId) {
    throw new Error("system-scoped asset promotion must not include target_scope_id");
  }
  const normalizedTargetScopeId = await normalizeVersionScopeForWrite(db, identity, targetScopeType, targetScopeId);
  assertAssetAllowsTargetScope(asset, identity, targetScopeType, normalizedTargetScopeId);

  const now = new Date().toISOString();
  await db.query(
    `UPDATE evolvable_asset_versions
        SET status = 'approved', scope_type = $3, scope_id = $4, promotion_proposal_id = $5,
            approved_by_user_id = $6, updated_at = $7
      WHERE asset_id = $1 AND id = $2`,
    [payload.asset_id, payload.candidate_version_id, targetScopeType, normalizedTargetScopeId, context.proposal.id, context.userId, now],
  );

  if (payload.deprecate_previous) {
    await db.query(
      `UPDATE evolvable_asset_versions
          SET status = 'deprecated', updated_at = $5
        WHERE asset_id = $1 AND scope_type = $2 AND scope_id IS NOT DISTINCT FROM $3
          AND status = 'approved' AND id <> $4`,
      [payload.asset_id, targetScopeType, normalizedTargetScopeId, payload.candidate_version_id, now],
    );
  }

  if (targetScopeType === "system") {
    await db.query(`UPDATE evolvable_assets SET current_system_version_id = $2, updated_at = $3 WHERE id = $1`, [
      payload.asset_id,
      payload.candidate_version_id,
      now,
    ]);
  }

  const deploymentLabel = payload.deployment_label?.trim() || null;
  if (deploymentLabel) {
    if (asset.asset_type !== "prompt_template") {
      throw new Error("deployment_label is only valid for prompt_template asset promotions");
    }
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(deploymentLabel)) {
      throw new Error("deployment_label is invalid");
    }
    await db.query(
      `UPDATE prompt_deployment_refs
          SET status = 'archived', updated_at = $6
        WHERE asset_id = $1
          AND scope_type = $2
          AND scope_id IS NOT DISTINCT FROM $3
          AND label = $4
          AND status = 'active'
          AND space_id IS NOT DISTINCT FROM $5`,
      [
        payload.asset_id,
        targetScopeType,
        normalizedTargetScopeId,
        deploymentLabel,
        targetScopeType === "system" ? null : spaceId,
        now,
      ],
    );
    await db.query(
      `INSERT INTO prompt_deployment_refs (
         id, space_id, asset_id, scope_type, scope_id, label, version_id, status,
         promoted_by_user_id, promoted_from_proposal_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $10)`,
      [
        randomUUID(),
        targetScopeType === "system" ? null : spaceId,
        payload.asset_id,
        targetScopeType,
        normalizedTargetScopeId,
        deploymentLabel,
        payload.candidate_version_id,
        context.userId,
        context.proposal.id,
        now,
      ],
    );
  }

  if (payload.pin_after_approval && targetScopeType !== "system" && normalizedTargetScopeId) {
    await db.query(
      `UPDATE evolvable_asset_pins
          SET status = 'archived', updated_at = $5
        WHERE space_id = $1 AND asset_id = $2 AND scope_type = $3 AND scope_id = $4 AND status = 'active'`,
      [spaceId, payload.asset_id, targetScopeType, normalizedTargetScopeId, now],
    );
    await db.query(
      `INSERT INTO evolvable_asset_pins (
         id, space_id, asset_id, scope_type, scope_id, version_id, status, pinned_by_user_id, reason, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $9)`,
      [
        randomUUID(),
        spaceId,
        payload.asset_id,
        targetScopeType,
        normalizedTargetScopeId,
        payload.candidate_version_id,
        context.userId,
        payload.reason ?? null,
        now,
      ],
    );
  }

  await db.query(
    `INSERT INTO evolution_experiences (
       id, space_id, source_proposal_id, experience_key, summary, trigger_signals_json,
       outcome_status, confidence_score, blast_radius_json, validation_trace_json,
       execution_trace_json, lessons_json, anti_patterns_json, environment_fingerprint_json,
       provenance_type, created_at
     ) VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, 'success', 0.7, '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'proposal_accepted', $6)
     ON CONFLICT (space_id, experience_key) DO NOTHING`,
    [
      randomUUID(),
      spaceId,
      context.proposal.id,
      `evolvable_asset_promotion:${payload.candidate_version_id}`,
      `Promoted asset ${payload.asset_id} version ${payload.candidate_version_id} to ${targetScopeType}${normalizedTargetScopeId ? `:${normalizedTargetScopeId}` : ""}`,
      now,
    ],
  );

  return {
    result_type: "evolvable_asset_version",
    result: {
      asset_id: payload.asset_id,
      version_id: payload.candidate_version_id,
      target_scope_type: targetScopeType,
      target_scope_id: normalizedTargetScopeId,
      pinned: Boolean(payload.pin_after_approval && targetScopeType !== "system" && normalizedTargetScopeId),
      deployment_label: deploymentLabel,
      evaluation: {
        policy: hardGate ? "hard_gate" : "warn_only",
        passed: passedEvaluation,
        summary: evaluationSummary,
        warning: !passedEvaluation ? "No passed evaluation run was available at promotion time." : null,
      },
    },
  };
}

function summarizeEvaluationRows(rows: Array<{ id: string; status: string }>): Record<string, unknown> {
  const counts = rows.reduce<Record<string, number>>((out, row) => {
    out[row.status] = (out[row.status] ?? 0) + 1;
    return out;
  }, {});
  return {
    total: rows.length,
    passed: counts.passed ?? 0,
    failed: counts.failed ?? 0,
    blocked: counts.blocked ?? 0,
    queued: counts.queued ?? 0,
    running: counts.running ?? 0,
    latest_run_id: rows[0]?.id ?? null,
    latest_status: rows[0]?.status ?? null,
  };
}
