import type { RetrievalEvalReportRequest } from "@agent-space/protocol";
import type { ProposalApplyContext, ProposalApplyResult } from "../../proposals/applierRegistry.js";
import type { Queryable } from "../../routeUtils/common.js";
import {
  acceptReviewPacket,
  insertProposalRow,
  reviewScopeValue,
  visibilityForReviewScope,
} from "../../proposals/reviewPackets.js";

export const RETRIEVAL_DIAGNOSTICS_PACKET_PROPOSAL_TYPE = "retrieval_diagnostics_packet";

export interface RetrievalDiagnosticsPacketContext {
  spaceId: string;
  ownerUserId: string;
  artifactId: string;
  report: RetrievalEvalReportRequest;
  settingsSnapshot?: Record<string, unknown>;
  reviewScope?: "private" | "space_ops";
}

export async function createRetrievalDiagnosticsProposalPacket(
  db: Queryable,
  input: RetrievalDiagnosticsPacketContext,
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const payload = diagnosticsPacketPayload(input, ownerUserId);
  return (await insertProposalRow(db, {
    spaceId: input.spaceId,
    proposalType: RETRIEVAL_DIAGNOSTICS_PACKET_PROPOSAL_TYPE,
    title: titleForReport(input.report),
    summary: summaryForReport(input.report),
    payload,
    rationale:
      "Review this retrieval diagnostics packet. Accepting the packet records review acknowledgement only; it does not write canonical Knowledge or Memory.",
    createdByUserId: ownerUserId,
    visibility: visibilityForReviewScope(input.reviewScope),
  })).id;
}

export function registerRetrievalDiagnosticsProposalAppliers(registry: {
  register(proposalType: string, applier: (context: ProposalApplyContext) => Promise<ProposalApplyResult>): void;
}): void {
  registry.register(RETRIEVAL_DIAGNOSTICS_PACKET_PROPOSAL_TYPE, applyRetrievalDiagnosticsPacketProposal);
}

function applyRetrievalDiagnosticsPacketProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  // Diagnostics packets are acknowledge-only: they create no child proposals.
  return acceptReviewPacket(context, {
    expectedOperation: "retrieval_diagnostics_packet",
    resultType: "retrieval_diagnostics_packet",
    privateMessage: "retrieval diagnostics packet is private to its creator",
    invalidPayload: () => new RetrievalDiagnosticsPacketApplyError("retrieval diagnostics packet payload is invalid"),
    build: (payload) => ({
      children: [],
      finalPayloadExtra: { canonical_write_performed: false },
      resultExtra: {
        report_artifact_id: stringValue(payload.report_artifact_id),
        recommended_action_count: Array.isArray(payload.recommended_actions)
          ? payload.recommended_actions.length
          : 0,
        canonical_write_performed: false,
      },
    }),
  });
}

function diagnosticsPacketPayload(
  input: RetrievalDiagnosticsPacketContext,
  ownerUserId: string,
): Record<string, unknown> {
  return {
    operation: "retrieval_diagnostics_packet",
    target_scope: "knowledge_retrieval",
    target_namespace: "knowledge.retrieval.diagnostics",
    review_scope: reviewScopeValue(input.reviewScope),
    proposed_content: summaryForReport(input.report),
    report_artifact_id: input.artifactId,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    source: input.report.source,
    suite: input.report.suite ?? null,
    report_label: input.report.report_label ?? null,
    counts: input.report.counts,
    metrics: input.report.metrics,
    diagnostic_codes: input.report.diagnostic_codes,
    recommended_actions: recommendedActions(input.report.diagnostic_codes),
    settings_snapshot: input.settingsSnapshot ?? {},
    canonical_write_performed: false,
  };
}

function recommendedActions(codes: readonly string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const has = (code: string) => codes.includes(code);
  if (has("low_coverage") || has("missing_topics")) {
    out.push({
      kind: "retrieval_quality_review",
      label: "Review low-coverage topics and source coverage",
      canonical_write: false,
    });
  }
  if (has("uncited_claims") || has("contradictions")) {
    out.push({
      kind: "claim_review_work",
      label: "Convert concrete Context Brief findings into claim review packets",
      canonical_write: false,
    });
  }
  if (has("stale_sources") || has("thin_sources") || has("maintenance_findings_present")) {
    out.push({
      kind: "knowledge_maintenance_review",
      label: "Run or review Knowledge retrieval maintenance packets",
      canonical_write: false,
    });
  }
  if (codes.some((code) => code.startsWith("trend_") && code.endsWith("_worse"))) {
    out.push({
      kind: "diagnostics_trend_review",
      label: "Compare recent diagnostics against the previous window before tuning",
      canonical_write: false,
    });
  }
  if (!out.length) {
    out.push({
      kind: "no_action_required",
      label: "No immediate retrieval quality action was detected",
      canonical_write: false,
    });
  }
  return out;
}

function titleForReport(report: RetrievalEvalReportRequest): string {
  const label = report.report_label?.trim() || report.suite?.trim();
  return label ? `Retrieval Diagnostics Packet: ${label}` : "Retrieval Diagnostics Packet";
}

function summaryForReport(report: RetrievalEvalReportRequest): string {
  const codes = report.diagnostic_codes.length ? report.diagnostic_codes.join(", ") : "no diagnostic codes";
  return `Aggregate retrieval diagnostics: ${codes}.`;
}

function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("retrieval diagnostics packets require owner_user_id");
  return owner;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

class RetrievalDiagnosticsPacketApplyError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = "RetrievalDiagnosticsPacketApplyError";
  }
}
