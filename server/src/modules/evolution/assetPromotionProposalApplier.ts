import { randomUUID } from "node:crypto";
import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import {
  assertAssetAllowsTargetScope,
  assertCanWriteAssetOwnerScope,
  normalizeVersionScopeForWrite,
  versionServesScope,
  type EvolvableAssetAccessRow,
} from "./assetAccess.js";
import { lockEvolutionAssets } from "./assetLocks.js";

interface PromotePayload {
  asset_id: string;
  candidate_version_id: string;
  /** The content the reviewer approved; promotion refuses any other. */
  candidate_content_hash: string;
  /** Where a pin or deployment ref lands. The version keeps its own scope. */
  target_scope_type: "project" | "space" | "user" | "agent";
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

interface CandidateRow {
  id: string;
  status: string;
  space_id: string | null;
  scope_type: string;
  scope_id: string | null;
  content_hash: string | null;
}

/** Statuses of a Run that is still going to read the version it names. */
const LIVE_RUN_STATUSES = ["queued", "running", "cancelling", "waiting_for_review", "waiting_for_dependency"];

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
  if (!asset) throw new HttpError(404, "Evolvable asset not found in this space");
  await assertCanWriteAssetOwnerScope(db, identity, asset);
  const reading=(await db.query(`SELECT 1 FROM evolvable_assets WHERE id=$1 AND asset_key IN ('reading.project_investigation','prompt.revision.method')`,[payload.asset_id])).rows[0];
  if(reading){
    // The original trial owner must still have the frozen material/context. Approval is not an export grant.
    const owner=(await db.query<{created_by_user_id:string}>(`SELECT created_by_user_id FROM evolvable_asset_evaluation_runs WHERE id=$1 AND space_id=$2`,[payload.evaluation_run_ids?.[0],spaceId])).rows[0];
    if(!owner)throw new HttpError(409,'Reading comparison missing');
    const ref=(await db.query<{eval_suite_ref_json:{baseline_run_id:string}}>(`SELECT eval_suite_ref_json FROM evolvable_asset_evaluation_runs WHERE id=$1 AND space_id=$2`,[payload.evaluation_run_ids?.[0],spaceId])).rows[0];
    const run=ref?await new (await import('../runs/repository.js')).PgRunRepository(db).getRun(spaceId,ref.eval_suite_ref_json.baseline_run_id):null;
    if(!run)throw new HttpError(409,'Reading comparison Run missing');
    await (await import('../runtimeContext/index.js')).lockReadingRunAuthority(db,run);
    await (await import('../prompts/reading/workspace.js')).assertReadingPromotion(db,{spaceId,userId:owner.created_by_user_id},payload.candidate_version_id,payload.evaluation_run_ids,{type:payload.target_scope_type,id:payload.target_scope_id??null});
  }


  const candidateResult = await db.query<CandidateRow>(
    `SELECT id, status, space_id, scope_type, scope_id, content_hash
       FROM evolvable_asset_versions
      WHERE asset_id = $1 AND id = $2
      FOR UPDATE`,
    [payload.asset_id, payload.candidate_version_id],
  );
  const candidate = candidateResult.rows[0];
  if (!candidate) throw new HttpError(409, "The candidate version no longer belongs to this asset");
  if (candidate.status !== "candidate" && candidate.status !== "testing") {
    throw new HttpError(409, `The candidate version is ${candidate.status}, not candidate or testing`);
  }
  // The reviewer approved this content. A version's content is frozen once it
  // leaves draft; a mismatch means the proposal names other content.
  if (!payload.candidate_content_hash || candidate.content_hash !== payload.candidate_content_hash) {
    throw new HttpError(409, "The candidate version's content differs from what was proposed; propose it again");
  }
  await normalizeVersionScopeForWrite(db, identity, candidate.scope_type, candidate.scope_id);
  assertAssetAllowsTargetScope(asset, identity, candidate.scope_type, candidate.scope_id);

  const targetScopeType = payload.target_scope_type;
  if (!["project", "space", "user", "agent"].includes(targetScopeType)) {
    throw new HttpError(422, "target_scope_type must be one of project, space, user, agent");
  }
  const targetScopeId = await normalizeVersionScopeForWrite(db, identity, targetScopeType, payload.target_scope_id ?? null);
  assertAssetAllowsTargetScope(asset, identity, targetScopeType, targetScopeId);
  if (!versionServesScope(identity, { scopeType: targetScopeType, scopeId: targetScopeId }, candidate)) {
    throw new HttpError(422, "The version's scope does not cover the promotion target");
  }

  // Evaluation is warn-only by default. A proposal can opt into the hard
  // gate, but the applier always recomputes the decision from the database;
  // the proposal's embedded summary is evidence, not authority. Only an
  // evaluation of this exact content counts.
  const evalParams: unknown[] = [payload.asset_id, payload.candidate_version_id, spaceId, candidate.content_hash];
  let evalClause = "asset_id = $1 AND candidate_version_id = $2 AND space_id = $3 AND candidate_content_hash = $4";
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
    throw new HttpError(409, "Promotion hard gate requires at least one passed evaluation run of this version's content");
  }
  const evaluationSummary = summarizeEvaluationRows(evaluationRows.rows);

  const now = new Date().toISOString();
  const approved = await db.query(
    `UPDATE evolvable_asset_versions
        SET status = 'approved', promotion_proposal_id = $3, approved_by_user_id = $4, updated_at = $5
      WHERE asset_id = $1 AND id = $2 AND status IN ('candidate', 'testing') AND content_hash = $6`,
    [payload.asset_id, payload.candidate_version_id, context.proposal.id, context.userId, now, candidate.content_hash],
  );
  if (approved.rowCount !== 1) throw new HttpError(409, "The candidate version changed while it was being promoted");

  const deploymentLabel = payload.deployment_label?.trim() || null;
  if (deploymentLabel) {
    if (asset.asset_type !== "prompt_template") {
      throw new HttpError(422, "deployment_label is only valid for prompt_template asset promotions");
    }
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(deploymentLabel)) {
      throw new HttpError(422, "deployment_label is invalid");
    }
    await db.query(
      `UPDATE prompt_deployment_refs
          SET status = 'archived', updated_at = $6
        WHERE asset_id = $1
          AND scope_type = $2
          AND scope_id = $3
          AND label = $4
          AND status = 'active'
          AND space_id = $5`,
      [payload.asset_id, targetScopeType, targetScopeId, deploymentLabel, spaceId, now],
    );
    await db.query(
      `INSERT INTO prompt_deployment_refs (
         id, space_id, asset_id, scope_type, scope_id, label, version_id, status,
         promoted_by_user_id, promoted_from_proposal_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $10)`,
      [
        randomUUID(),
        spaceId,
        payload.asset_id,
        targetScopeType,
        targetScopeId,
        deploymentLabel,
        payload.candidate_version_id,
        context.userId,
        context.proposal.id,
        now,
      ],
    );
  }

  if (payload.pin_after_approval && targetScopeId) {
    await db.query(
      `UPDATE evolvable_asset_pins
          SET status = 'archived', updated_at = $5
        WHERE space_id = $1 AND asset_id = $2 AND scope_type = $3 AND scope_id = $4 AND status = 'active'`,
      [spaceId, payload.asset_id, targetScopeType, targetScopeId, now],
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
        targetScopeId,
        payload.candidate_version_id,
        context.userId,
        payload.reason ?? null,
        now,
      ],
    );
  }

  // After this promotion moved its own pin and deployment ref: what it
  // replaced no longer keeps the earlier version alive.
  const deprecation = payload.deprecate_previous
    ? await deprecatePreviousUnreferenced(db, payload.asset_id, candidate, now)
    : { deprecated: [] as string[], keptReferenced: [] as string[] };

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
      `Promoted asset ${payload.asset_id} version ${payload.candidate_version_id} for ${targetScopeType}:${targetScopeId}`,
      now,
    ],
  );

  return {
    result_type: "evolvable_asset_version",
    result: {
      asset_id: payload.asset_id,
      version_id: payload.candidate_version_id,
      target_scope_type: targetScopeType,
      target_scope_id: targetScopeId,
      pinned: Boolean(payload.pin_after_approval && targetScopeId),
      deployment_label: deploymentLabel,
      deprecated_version_ids: deprecation.deprecated,
      kept_referenced_version_ids: deprecation.keptReferenced,
      evaluation: {
        policy: hardGate ? "hard_gate" : "warn_only",
        passed: passedEvaluation,
        summary: evaluationSummary,
        warning: !passedEvaluation ? "No passed evaluation run was available at promotion time." : null,
      },
    },
  };
}

/**
 * Deprecates the earlier approved versions in the promoted version's own
 * scope, except any something still uses: an active pin, an active prompt
 * deployment ref, an Automation (active or paused) pinned to it, or a Run or
 * workflow execution that has not finished.
 * Those stay approved until whoever owns the reference moves it; deprecating
 * them would make that reference fail to resolve. A finished execution is
 * history, not a reference that keeps a version alive.
 */
async function deprecatePreviousUnreferenced(
  db: Queryable,
  assetId: string,
  candidate: CandidateRow,
  now: string,
): Promise<{ deprecated: string[]; keptReferenced: string[] }> {
  const previous = await db.query<{ id: string; referenced: boolean }>(
    `SELECT v.id,
            (
              EXISTS (SELECT 1 FROM evolvable_asset_pins pin WHERE pin.version_id = v.id AND pin.status = 'active')
              OR EXISTS (SELECT 1 FROM prompt_deployment_refs ref WHERE ref.version_id = v.id AND ref.status = 'active')
              OR EXISTS (SELECT 1 FROM runs run WHERE run.workflow_version_id = v.id AND run.status = ANY($5::text[]))
              OR EXISTS (SELECT 1 FROM workflow_executions execution WHERE execution.workflow_version_id = v.id AND execution.ended_at IS NULL)
              OR EXISTS (SELECT 1 FROM automations automation
                          WHERE automation.status <> 'archived'
                            AND automation.config_json->>'workflow_resolution' = 'pin'
                            AND automation.config_json->>'workflow_version_id' = v.id)
            ) AS referenced
       FROM evolvable_asset_versions v
      WHERE v.asset_id = $1 AND v.space_id = $2 AND v.scope_type = $3 AND v.scope_id = $4
        AND v.status = 'approved' AND v.id <> $6
      FOR UPDATE OF v`,
    [assetId, candidate.space_id, candidate.scope_type, candidate.scope_id, LIVE_RUN_STATUSES, candidate.id],
  );
  const deprecated = previous.rows.filter((row) => !row.referenced).map((row) => row.id);
  const keptReferenced = previous.rows.filter((row) => row.referenced).map((row) => row.id);
  if (deprecated.length > 0) {
    await db.query(
      `UPDATE evolvable_asset_versions SET status = 'deprecated', updated_at = $3 WHERE asset_id = $1 AND id = ANY($2::varchar[])`,
      [assetId, deprecated, now],
    );
  }
  return { deprecated, keptReferenced };
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
