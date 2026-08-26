import type { RetrievalEvalReportRequest } from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { insertArtifactRow } from "../../artifacts/reviewArtifactWriter.js";

export const RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE = "retrieval_eval_report";

export interface RetrievalEvalReportArtifactContext {
  spaceId: string;
  ownerUserId: string;
  report: RetrievalEvalReportRequest;
  settingsSnapshot?: Record<string, unknown>;
  reviewScope?: "private" | "space_ops";
}

export interface RetrievalEvalReportArtifactSpec {
  artifact_type: typeof RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE;
  visibility: "private" | "space_shared";
  title: string;
  content: string;
  mime_type: string;
  metadata_json: Record<string, unknown>;
}

export function buildRetrievalEvalReportArtifactSpec(
  input: RetrievalEvalReportArtifactContext,
): RetrievalEvalReportArtifactSpec {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const generatedAt = new Date().toISOString();
  const payload = {
    kind: RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE,
    version: 1,
    visibility: visibilityForReviewScope(input.reviewScope),
    review_scope: reviewScopeValue(input.reviewScope),
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    source: input.report.source,
    suite: input.report.suite ?? null,
    report_label: input.report.report_label ?? null,
    k: input.report.k ?? null,
    generated_at: generatedAt,
    metrics: input.report.metrics,
    counts: input.report.counts,
    cases: input.report.cases,
    rank_attribution: input.report.rank_attribution,
    diagnostic_codes: input.report.diagnostic_codes,
    settings_snapshot: input.settingsSnapshot ?? {},
    access_safety: {
      aggregate_only: true,
      candidate_ids_included: false,
      content_included: false,
    },
    retention_policy: {
      class: "aggregate_private_artifact",
      owner_scoped: true,
      raw_private_content_included: false,
    },
  };

  return {
    artifact_type: RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE,
    visibility: visibilityForReviewScope(input.reviewScope),
    title: titleForReport(input.report),
    content: JSON.stringify(payload, null, 2),
    mime_type: "application/json; charset=utf-8",
    metadata_json: payload,
  };
}

function reviewScopeValue(value: "private" | "space_ops" | undefined): "private" | "space_ops" {
  return value === "space_ops" ? "space_ops" : "private";
}

function visibilityForReviewScope(value: "private" | "space_ops" | undefined): "private" | "space_shared" {
  return value === "space_ops" ? "space_shared" : "private";
}

export async function persistRetrievalEvalReportArtifact(
  db: Queryable,
  input: RetrievalEvalReportArtifactContext,
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const spec = buildRetrievalEvalReportArtifactSpec(input);
  return insertArtifactRow(db, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: spec.artifact_type,
    title: spec.title,
    content: spec.content,
    metadata: spec.metadata_json,
    canonicalFormat: "retrieval_eval_report.v1",
    visibility: spec.visibility,
    mimeType: spec.mime_type,
  });
}

function titleForReport(report: RetrievalEvalReportRequest): string {
  const label = report.report_label?.trim() || report.suite?.trim();
  return label ? `Retrieval Eval Report: ${label}` : "Retrieval Eval Report";
}

function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("retrieval eval report artifacts require owner_user_id");
  return owner;
}
