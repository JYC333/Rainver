import type { MemoryMaintenanceReport } from "@agent-space/protocol" with {
  "resolution-mode": "import",
};
import type { ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter";
import {
  acceptReviewPacket,
  insertProposalRow,
  reviewScopeValue,
  visibilityForReviewScope,
  type ChildProposalDraft,
} from "../proposals/reviewPackets";
import type { Queryable } from "./repository";

export const MEMORY_MAINTENANCE_REPORT_ARTIFACT_TYPE = "memory_maintenance_report";
export const MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE = "memory_maintenance_packet";

export interface MemoryMaintenanceReportContext {
  spaceId: string;
  ownerUserId: string;
  report: MemoryMaintenanceReport;
  scanOptions?: Record<string, unknown>;
  reviewScope?: "private" | "space_ops";
}

export async function persistMemoryMaintenanceReportArtifact(
  db: Queryable,
  input: MemoryMaintenanceReportContext,
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const now = new Date().toISOString();
  const payload = reportPayload(input, ownerUserId, now);
  return insertArtifactRow(db, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: MEMORY_MAINTENANCE_REPORT_ARTIFACT_TYPE,
    title: titleForReport(input.report),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "memory_maintenance_report.v1",
    visibility: visibilityForReviewScope(input.reviewScope),
    createdAt: now,
  });
}

export async function createMemoryMaintenanceProposalPacket(
  db: Queryable,
  input: MemoryMaintenanceReportContext & { artifactId: string },
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const payload = packetPayload(input, ownerUserId);
  return (await insertProposalRow(db, {
    spaceId: input.spaceId,
    proposalType: MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE,
    title: titleForReport(input.report),
    summary: summaryForReport(input.report),
    payload,
    rationale:
      "Review this Memory maintenance packet. Accepting the packet may create child Memory archive or update proposals; it does not write canonical Memory directly.",
    createdByUserId: ownerUserId,
    visibility: visibilityForReviewScope(input.reviewScope),
  })).id;
}

export function registerMemoryMaintenanceProposalAppliers(registry: {
  register(proposalType: string, applier: (context: ProposalApplyContext) => Promise<ProposalApplyResult>): void;
}): void {
  registry.register(MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE, applyMemoryMaintenancePacketProposal);
}

function applyMemoryMaintenancePacketProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  return acceptReviewPacket(context, {
    expectedOperation: "memory_maintenance_packet",
    resultType: "memory_maintenance_packet",
    privateMessage: "memory maintenance packet is private to its creator",
    invalidPayload: () => new MemoryMaintenancePacketApplyError("memory maintenance packet payload is invalid"),
    build: (payload, ctx) => ({
      children: memoryChildDrafts(payload, ctx),
      finalPayloadExtra: { canonical_write_performed: false },
      resultExtra: {
        report_artifact_id: stringValue(payload.report_artifact_id),
        canonical_write_performed: false,
      },
    }),
  });
}

const MAX_CHILD_MEMORY_PROPOSALS = 25;

function memoryChildDrafts(
  payload: Record<string, unknown>,
  context: ProposalApplyContext,
): ChildProposalDraft[] {
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const drafts: ChildProposalDraft[] = [];
  for (const finding of findings) {
    for (const draft of childDraftsForFinding(record(finding), payload, context)) {
      if (drafts.length >= MAX_CHILD_MEMORY_PROPOSALS) return drafts;
      drafts.push(draft);
    }
  }
  return drafts;
}

function childDraftsForFinding(
  finding: Record<string, unknown>,
  packetPayload: Record<string, unknown>,
  context: ProposalApplyContext,
): ChildProposalDraft[] {
  const action = record(finding.proposed_action);
  if (!action) return [];
  const kind = stringValue(finding.kind) ?? "memory_maintenance";
  const objects = Array.isArray(finding.objects) ? finding.objects.map(record) : [];
  const basePayload = {
    source_maintenance_packet_id: context.proposal.id,
    source_report_artifact_id: stringValue(packetPayload.report_artifact_id),
    source_finding_kind: kind,
    maintenance_confidence_tier: stringValue(finding.confidence_tier),
    maintenance_reason: stringValue(finding.reason),
    evidence_refs: objects.map((object) => ({
      object_type: "memory_entry",
      object_id: stringValue(object.object_id),
      title: stringValue(object.title),
    })).filter((ref) => ref.object_id),
    canonical_write_performed: false,
  };
  const proposalType = stringValue(action.proposal_type);
  if (proposalType === "memory_archive") {
    const targetIds = stringArray(action.target_memory_ids);
    return targetIds.map((targetId) => ({
      proposalType: "memory_archive",
      riskLevel: "medium",
      title: `Archive duplicate memory: ${titleForTarget(objects, targetId)}`,
      summary: `Review archival for duplicate Memory finding (${kind}).`,
      rationale: "Generated from accepted Memory maintenance packet; accepting this child proposal archives the target memory.",
      // Preserve the packet's own visibility for child memory_archive proposals.
      visibility: context.proposal.visibility ?? "private",
      projectFolderId: context.proposal.project_folder_id ?? null,
      projectId: null,
      payload: {
        ...basePayload,
        operation: "memory_archive",
        target_memory_id: targetId,
      },
    }));
  }
  if (proposalType === "memory_update") {
    const targetId = stringValue(action.target_memory_id);
    if (!targetId) return [];
    const targetScope = stringValue(action.target_scope);
    const projectId = stringValue(action.project_id);
    const requiresOperatorEdit = action.requires_operator_edit === true;
    return [{
      proposalType: "memory_update",
      riskLevel: requiresOperatorEdit ? "medium" : "low",
      title: `Review memory update: ${titleForTarget(objects, targetId)}`,
      summary: `Review Memory update for maintenance finding (${kind}).`,
      rationale: requiresOperatorEdit
        ? "Generated from accepted Memory maintenance packet; edit this child proposal before accepting if canonical Memory should change."
        : "Generated from accepted Memory maintenance packet; accepting this child proposal applies the reviewed Memory update.",
      visibility: context.proposal.visibility ?? "private",
      projectFolderId: context.proposal.project_folder_id ?? null,
      projectId: projectId ?? context.proposal.project_id ?? null,
      payload: {
        ...basePayload,
        operation: "update",
        target_memory_id: targetId,
        ...(targetScope ? { target_scope: targetScope } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        maintenance_action: stringValue(action.maintenance_action),
        related_memory_ids: stringArray(action.related_memory_ids),
        requires_operator_edit: requiresOperatorEdit,
        provenance_entries: [{
          source_type: "memory_maintenance_packet",
          source_id: context.proposal.id,
          artifact_id: stringValue(packetPayload.report_artifact_id),
          finding_kind: kind,
          reason: stringValue(finding.reason),
        }],
      },
    }];
  }
  return [];
}

function reportPayload(
  input: MemoryMaintenanceReportContext,
  ownerUserId: string,
  generatedAt: string,
): Record<string, unknown> {
  return {
    kind: MEMORY_MAINTENANCE_REPORT_ARTIFACT_TYPE,
    version: 1,
    visibility: visibilityForReviewScope(input.reviewScope),
    review_scope: reviewScopeValue(input.reviewScope),
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    generated_at: generatedAt,
    findings: input.report.findings,
    counts: input.report.counts,
    candidate_limit: input.report.candidate_limit,
    candidates_examined: input.report.candidates_examined,
    scanned: input.report.scanned,
    truncated: input.report.truncated,
    scan_mode: input.report.scan_mode ?? null,
    next_cursor: input.report.next_cursor ?? null,
    scan_options: input.scanOptions ?? {},
    access_safety: {
      ...(input.report.access_safety ?? {}),
      owner_private: true,
      raw_content_included: false,
      snippets_included: false,
      hidden_row_counts_included: false,
    },
    retention_policy: {
      class: "owner_private_memory_maintenance",
      owner_scoped: true,
      raw_private_content_included: false,
    },
  };
}

function packetPayload(
  input: MemoryMaintenanceReportContext & { artifactId: string },
  ownerUserId: string,
): Record<string, unknown> {
  return {
    operation: "memory_maintenance_packet",
    target_scope: "memory",
    target_namespace: "memory.maintenance",
    review_scope: reviewScopeValue(input.reviewScope),
    proposed_content: summaryForReport(input.report),
    report_artifact_id: input.artifactId,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    findings: input.report.findings,
    counts: input.report.counts,
    candidate_limit: input.report.candidate_limit,
    candidates_examined: input.report.candidates_examined,
    scanned: input.report.scanned,
    truncated: input.report.truncated,
    scan_mode: input.report.scan_mode ?? null,
    next_cursor: input.report.next_cursor ?? null,
    generated_child_proposal_ids: [],
    canonical_write_performed: false,
  };
}


function titleForReport(report: MemoryMaintenanceReport): string {
  return `Memory Maintenance Report: ${report.findings.length} findings`;
}

function summaryForReport(report: MemoryMaintenanceReport): string {
  const counts = Object.entries(report.counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(", ");
  return counts || "No memory maintenance findings.";
}

function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("memory maintenance artifacts require owner_user_id");
  return owner;
}

function titleForTarget(objects: readonly Record<string, unknown>[], targetId: string): string {
  const object = objects.find((entry) => stringValue(entry.object_id) === targetId);
  return stringValue(object?.title) ?? targetId;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = stringValue(item);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

class MemoryMaintenancePacketApplyError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = "MemoryMaintenancePacketApplyError";
  }
}
