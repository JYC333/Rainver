import type { ClaimContradictionReport } from "@rainver/protocol";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import type { Queryable } from "../routeUtils/common.js";

/**
 * Owner-private (or `space_ops`) artifact for a contradiction-discovery scan.
 *
 * The findings are stored in `metadata_json` so the existing Claim Candidate
 * Packet builder can read them and turn each finding's `proposed_action` into a
 * child `object_relation_create` (contradicts) proposal — keeping the only
 * canonical-write path on the proposal-gated packet flow. No raw private claim
 * text or hidden claim counts are persisted; the report carries only the
 * findings the access-safe scan already surfaced.
 */
export const CLAIM_CONTRADICTION_REPORT_ARTIFACT_TYPE = "claim_contradiction_report";

export interface ClaimContradictionReportContext {
  spaceId: string;
  ownerUserId: string;
  report: ClaimContradictionReport;
  scanOptions?: Record<string, unknown>;
  reviewScope?: "private" | "space_ops";
}

export async function persistClaimContradictionReportArtifact(
  db: Queryable,
  input: ClaimContradictionReportContext,
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const now = new Date().toISOString();
  const payload = reportPayload(input, ownerUserId, now);
  return insertArtifactRow(db, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: CLAIM_CONTRADICTION_REPORT_ARTIFACT_TYPE,
    title: titleForReport(input.report),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "claim_contradiction_report.v1",
    visibility: visibilityForReviewScope(input.reviewScope),
    createdAt: now,
  });
}

function reportPayload(
  input: ClaimContradictionReportContext,
  ownerUserId: string,
  generatedAt: string,
): Record<string, unknown> {
  return {
    kind: CLAIM_CONTRADICTION_REPORT_ARTIFACT_TYPE,
    version: 1,
    visibility: visibilityForReviewScope(input.reviewScope),
    review_scope: reviewScopeValue(input.reviewScope),
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    generated_at: generatedAt,
    findings: input.report.findings,
    counts: input.report.counts,
    candidates_examined: input.report.candidates_examined,
    scanned: input.report.scanned,
    truncated: input.report.truncated,
    scan_options: input.scanOptions ?? {},
    access_safety: {
      ...input.report.access_safety,
      raw_private_content_included: false,
      hidden_claim_counts_included: false,
    },
    retention_policy: {
      class: "owner_private_claim_contradiction_report",
      owner_scoped: true,
      raw_private_content_included: false,
    },
  };
}

function reviewScopeValue(value: "private" | "space_ops" | undefined): "private" | "space_ops" {
  return value === "space_ops" ? "space_ops" : "private";
}

function visibilityForReviewScope(value: "private" | "space_ops" | undefined): "private" | "space_shared" {
  return value === "space_ops" ? "space_shared" : "private";
}

function titleForReport(report: ClaimContradictionReport): string {
  return `Claim Contradiction Report: ${report.findings.length} findings`;
}

function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("claim contradiction report requires owner_user_id");
  return owner;
}
