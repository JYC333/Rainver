import { randomUUID } from "node:crypto";
import type {
  RetrievalCalibrationDecisionRequest,
} from "@agent-space/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { insertArtifactRow } from "../../artifacts/reviewArtifactWriter.js";
import {
  contentOwnerFilterSql,
  contentReadSql,
  contentVisibilityFilterSql,
} from "../../access/contentAccessSql.js";

export const RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE = "retrieval_calibration_decision";

const EVIDENCE_ARTIFACT_TYPES = [
  "retrieval_eval_report",
  "retrieval_explain_report",
  "retrieval_maintenance_report",
  "memory_maintenance_report",
  "retrieval_brief",
] as const;

interface CalibrationEvidenceRow {
  id: string;
  artifact_type: string;
  visibility: string;
}

export interface RetrievalCalibrationDecisionArtifactContext {
  spaceId: string;
  ownerUserId: string;
  request: RetrievalCalibrationDecisionRequest;
  settingsSnapshot?: Record<string, unknown>;
}

export async function persistRetrievalCalibrationDecisionArtifact(
  db: Queryable,
  input: RetrievalCalibrationDecisionArtifactContext,
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const evidenceIds = uniqueEvidenceArtifactIds(input.request);
  const reviewScope = reviewScopeValue(input.request.review_scope);
  const evidenceRows = await loadVisibleEvidenceArtifacts(
    db,
    input.spaceId,
    ownerUserId,
    evidenceIds,
    reviewScope,
  );
  if (evidenceRows.length !== evidenceIds.length) {
    throw new RetrievalCalibrationDecisionError("evidence artifact not found or not visible", 404);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const visibility = visibilityForReviewScope(input.request.review_scope);
  const payload = {
    kind: RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE,
    version: 1,
    visibility,
    review_scope: reviewScope,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    generated_at: now,
    report_label: input.request.report_label ?? null,
    suite: input.request.suite ?? null,
    decisions: input.request.decisions.map((decision) => ({
      ...decision,
      runtime_state: decision.decision === "adopt" ? "adopted" : decision.decision,
      shipped: false,
    })),
    evidence_artifacts: evidenceRows.map((row) => ({
      artifact_id: row.id,
      artifact_type: row.artifact_type,
      visibility: row.visibility,
    })),
    decision_summary: decisionSummary(input.request),
    runtime_summary: runtimeSummary(input.request),
    settings_snapshot: input.settingsSnapshot ?? {},
    access_safety: {
      aggregate_only: true,
      evidence_refs_only: true,
      content_included: false,
      snippets_included: false,
      hidden_ids_included: false,
      private_backlink_counts_included: false,
      dropped_candidate_ids_included: false,
      ranking_behavior_changed: false,
      shipped_by_settings: false,
    },
    retention_policy: {
      class: visibility === "space_shared" ? "aggregate_space_artifact" : "aggregate_private_artifact",
      owner_scoped: visibility !== "space_shared",
      raw_private_content_included: false,
    },
  };

  return insertArtifactRow(db, {
    id,
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE,
    title: titleForDecision(input.request),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "retrieval_calibration_decision.v1",
    visibility,
    createdAt: now,
  });
}

async function loadVisibleEvidenceArtifacts(
  db: Queryable,
  spaceId: string,
  ownerUserId: string,
  artifactIds: readonly string[],
  reviewScope: "private" | "space_ops",
): Promise<CalibrationEvidenceRow[]> {
  if (artifactIds.length === 0) return [];
  const allowedVisibilities = reviewScope === "space_ops"
    ? (["space_shared"] as const)
    : (["private", "space_shared"] as const);
  const result = await db.query<CalibrationEvidenceRow>(
    `SELECT a.id, a.artifact_type, a.visibility
       FROM artifacts a
      WHERE a.space_id = $1
        AND a.id = ANY($2::varchar[])
        AND a.artifact_type = ANY($3::varchar[])
        AND ${contentReadSql("artifact", "a", "$4")}
        AND ${contentOwnerFilterSql("artifact", "a", "$4")}
        AND ${contentVisibilityFilterSql("a", allowedVisibilities)}
      ORDER BY array_position($2::varchar[], a.id)`,
    [spaceId, artifactIds, [...EVIDENCE_ARTIFACT_TYPES], ownerUserId],
  );
  return result.rows;
}

function uniqueEvidenceArtifactIds(request: RetrievalCalibrationDecisionRequest): string[] {
  const ids: string[] = [];
  for (const decision of request.decisions) {
    for (const id of decision.evidence_artifact_ids ?? []) {
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function decisionSummary(request: RetrievalCalibrationDecisionRequest): Record<string, number> {
  const summary = { adopt: 0, defer: 0, reject: 0 };
  for (const decision of request.decisions) {
    summary[decision.decision] += 1;
  }
  return summary;
}

function runtimeSummary(request: RetrievalCalibrationDecisionRequest): Record<string, number> {
  const summary = { adopted: 0, deferred: 0, rejected: 0, shipped: 0 };
  for (const decision of request.decisions) {
    if (decision.decision === "adopt") summary.adopted += 1;
    if (decision.decision === "defer") summary.deferred += 1;
    if (decision.decision === "reject") summary.rejected += 1;
  }
  return summary;
}

function titleForDecision(request: RetrievalCalibrationDecisionRequest): string {
  const label = request.report_label?.trim() || request.suite?.trim();
  return label ? `Retrieval Calibration Decision: ${label}` : "Retrieval Calibration Decision";
}

function reviewScopeValue(value: "private" | "space_ops" | undefined): "private" | "space_ops" {
  return value === "space_ops" ? "space_ops" : "private";
}

function visibilityForReviewScope(value: "private" | "space_ops" | undefined): "private" | "space_shared" {
  return value === "space_ops" ? "space_shared" : "private";
}

function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("retrieval calibration artifacts require owner_user_id");
  return owner;
}

export class RetrievalCalibrationDecisionError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = "RetrievalCalibrationDecisionError";
  }
}
