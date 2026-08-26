import type { ProposalApplyContext, ProposalApplyResult } from "../../proposals/applierRegistry.js";
import type { Queryable } from "../../routeUtils/common.js";
import { insertArtifactRow } from "../../artifacts/reviewArtifactWriter.js";
import {
  acceptReviewPacket,
  insertProposalRow,
  lookupExistingPendingPacket,
  reviewScopeValue,
  visibilityForReviewScope,
  type ChildProposalDraft,
} from "../../proposals/reviewPackets.js";
import type { MaintenanceReport } from "./service.js";

export const RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE = "retrieval_maintenance_report";
export const RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE = "retrieval_maintenance_packet";

export interface RetrievalMaintenanceReportContext {
  spaceId: string;
  ownerUserId: string;
  runId?: string | null;
  report: MaintenanceReport;
  source: string;
  settingsSnapshot?: Record<string, unknown>;
  reviewScope?: "private" | "space_ops";
}

export async function persistRetrievalMaintenanceReportArtifact(
  db: Queryable,
  input: RetrievalMaintenanceReportContext,
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const now = new Date().toISOString();
  const payload = maintenanceReportPayload(input, ownerUserId);
  return insertArtifactRow(db, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE,
    title: titleForReport(input.report),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "retrieval_maintenance_report.v1",
    visibility: visibilityForReviewScope(input.reviewScope),
    runId: input.runId ?? null,
    createdAt: now,
  });
}

export async function createRetrievalMaintenanceProposalPacket(
  db: Queryable,
  input: RetrievalMaintenanceReportContext & { artifactId: string },
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const lineageKey = maintenanceLineageKey(input.spaceId, input.source);
  const existing = await lookupExistingPendingPacket(
    db, input.spaceId, RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE, lineageKey,
  );
  if (existing) return existing;
  const payload = packetPayload(input, ownerUserId, lineageKey);
  return (await insertProposalRow(db, {
    spaceId: input.spaceId,
    proposalType: RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE,
    title: titleForReport(input.report),
    summary: summaryForReport(input.report),
    payload,
    rationale:
      "Review this retrieval maintenance packet. Accepting the packet creates child proposals for supported actions; it does not write canonical Knowledge directly.",
    createdByUserId: ownerUserId,
    visibility: visibilityForReviewScope(input.reviewScope),
    createdByRunId: input.runId ?? null,
  })).id;
}

export function registerRetrievalMaintenanceProposalAppliers(registry: {
  register(proposalType: string, applier: (context: ProposalApplyContext) => Promise<ProposalApplyResult>): void;
}): void {
  registry.register(RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE, applyRetrievalMaintenancePacketProposal);
}

function applyRetrievalMaintenancePacketProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  return acceptReviewPacket(context, {
    expectedOperation: "retrieval_maintenance_packet",
    resultType: "retrieval_maintenance_packet",
    privateMessage: "retrieval maintenance packet is private to its creator",
    invalidPayload: () => new RetrievalMaintenancePacketApplyError("retrieval maintenance packet payload is invalid"),
    build: (payload, ctx) => {
      const findings = Array.isArray(payload.findings) ? payload.findings : [];
      const reportArtifactId = stringValue(payload.report_artifact_id);
      const children: ChildProposalDraft[] = [];
      for (const finding of findings) {
        const action = proposedAction(finding);
        if (!action || action.proposal_type !== "object_relation_create") continue;
        children.push({
          proposalType: "object_relation_create",
          title: action.title,
          rationale: "Generated from an accepted retrieval maintenance packet.",
          visibility: "private",
          projectId: ctx.proposal.project_id,
          payload: {
            ...action.payload,
            source_maintenance_packet_proposal_id: ctx.proposal.id,
            source_maintenance_report_artifact_id: reportArtifactId,
            provenance_entries: [
              { source_type: "proposal", source_id: ctx.proposal.id, source_trust: "derived_review" },
              ...(reportArtifactId
                ? [{ source_type: "artifact", source_id: reportArtifactId, source_trust: "derived_review" }]
                : []),
            ],
          },
        });
      }
      // Note: retrieval maintenance intentionally omits canonical_write_performed
      // and skipped tracking from its result/payload — match that exactly.
      return { children, resultExtra: { report_artifact_id: reportArtifactId } };
    },
  });
}

function maintenanceReportPayload(
  input: RetrievalMaintenanceReportContext,
  ownerUserId: string,
): Record<string, unknown> {
  return {
    kind: RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE,
    version: 1,
    visibility: visibilityForReviewScope(input.reviewScope),
    review_scope: reviewScopeValue(input.reviewScope),
    source: input.source,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    run_id: input.runId ?? null,
    findings: input.report.findings,
    counts: input.report.counts,
    scanned: input.report.scanned,
    truncated: input.report.truncated,
    settings_snapshot: input.settingsSnapshot ?? {},
  };
}

function maintenanceLineageKey(spaceId: string, source: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `ret_maint:${spaceId}:${source}:${date}`;
}

function packetPayload(
  input: RetrievalMaintenanceReportContext & { artifactId: string },
  ownerUserId: string,
  lineageKey: string,
): Record<string, unknown> {
  return {
    operation: "retrieval_maintenance_packet",
    lineage_key: lineageKey,
    target_scope: "knowledge",
    target_namespace: "knowledge.retrieval.maintenance",
    review_scope: reviewScopeValue(input.reviewScope),
    proposed_content: summaryForReport(input.report),
    report_artifact_id: input.artifactId,
    source: input.source,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    run_id: input.runId ?? null,
    findings: input.report.findings,
    counts: input.report.counts,
    scanned: input.report.scanned,
    truncated: input.report.truncated,
    generated_child_proposal_ids: [],
  };
}


function proposedAction(value: unknown): { proposal_type: string; title: string; payload: Record<string, unknown> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const finding = value as { proposed_action?: unknown };
  const action = finding.proposed_action;
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const record = action as Record<string, unknown>;
  const proposalType = stringValue(record.proposal_type);
  const title = stringValue(record.title) ?? "Knowledge relation suggestion";
  const payload = record.payload;
  if (!proposalType || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return { proposal_type: proposalType, title, payload: payload as Record<string, unknown> };
}

function titleForReport(report: MaintenanceReport): string {
  return `Retrieval Maintenance Report: ${report.findings.length} findings`;
}

function summaryForReport(report: MaintenanceReport): string {
  const counts = Object.entries(report.counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(", ");
  return counts || "No maintenance findings.";
}

function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("retrieval maintenance artifacts require owner_user_id");
  return owner;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

class RetrievalMaintenancePacketApplyError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = "RetrievalMaintenancePacketApplyError";
  }
}
