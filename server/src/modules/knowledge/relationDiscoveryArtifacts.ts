import { randomUUID } from "node:crypto";
import type { RelationDiscoveryReport } from "@agent-space/protocol";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import type { ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import {
  acceptReviewPacket,
  insertProposalRow,
  reviewScopeValue,
  visibilityForReviewScope,
  type ChildProposalDraft,
} from "../proposals/reviewPackets.js";
import type { Queryable } from "../routeUtils/common.js";

/**
 * Slice F packetization: the discovery report becomes an owner-private (or
 * `space_ops`) artifact plus a single batched `relation_discovery_packet`
 * proposal. Accepting the packet creates child pending `object_relation_create`
 * / `knowledge_create` proposals — it never writes a canonical edge or item
 * directly. This is the one shared "review-scaling" packet entry point for
 * discovery, mirroring the Memory maintenance and Claim Candidate Packet flows.
 */
export const RELATION_DISCOVERY_REPORT_ARTIFACT_TYPE = "relation_discovery_report";
export const RELATION_DISCOVERY_PACKET_PROPOSAL_TYPE = "relation_discovery_packet";

const MAX_CHILD_PROPOSALS = 40;

export interface RelationDiscoveryReportContext {
  spaceId: string;
  ownerUserId: string;
  report: RelationDiscoveryReport;
  scanOptions?: Record<string, unknown>;
  reviewScope?: "private" | "space_ops";
}

export async function persistRelationDiscoveryReportArtifact(
  db: Queryable,
  input: RelationDiscoveryReportContext,
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const id = randomUUID();
  const now = new Date().toISOString();
  const payload = reportPayload(input, ownerUserId, now, id);
  return insertArtifactRow(db, {
    id,
    spaceId: input.spaceId,
    ownerUserId,
    artifactType: RELATION_DISCOVERY_REPORT_ARTIFACT_TYPE,
    title: titleForReport(input.report),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "relation_discovery_report.v1",
    visibility: visibilityForReviewScope(input.reviewScope),
    createdAt: now,
  });
}

export async function createRelationDiscoveryProposalPacket(
  db: Queryable,
  input: RelationDiscoveryReportContext & { artifactId: string },
): Promise<string> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const payload = packetPayload(input, ownerUserId);
  return (await insertProposalRow(db, {
    spaceId: input.spaceId,
    proposalType: RELATION_DISCOVERY_PACKET_PROPOSAL_TYPE,
    title: titleForReport(input.report),
    summary: summaryForReport(input.report),
    payload,
    rationale:
      "Review this candidate-relation discovery packet. Accepting creates child pending Knowledge relation/item proposals only; it does not write canonical Knowledge directly.",
    createdByUserId: ownerUserId,
    visibility: visibilityForReviewScope(input.reviewScope),
  })).id;
}

export function registerRelationDiscoveryProposalAppliers(registry: {
  register(proposalType: string, applier: (context: ProposalApplyContext) => Promise<ProposalApplyResult>): void;
}): void {
  registry.register(RELATION_DISCOVERY_PACKET_PROPOSAL_TYPE, applyRelationDiscoveryPacketProposal);
}

function applyRelationDiscoveryPacketProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  return acceptReviewPacket(context, {
    expectedOperation: "relation_discovery_packet",
    resultType: "relation_discovery_packet",
    privateMessage: "relation discovery packet is private to its creator",
    invalidPayload: () => new RelationDiscoveryPacketApplyError("relation discovery packet payload is invalid"),
    build: (payload, ctx) => {
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      const children: ChildProposalDraft[] = [];
      const skipped: Array<Record<string, unknown>> = [];
      let reviewOnlyCandidateCount = 0;
      for (const candidate of candidates) {
        const candidateRecord = record(candidate);
        if (!candidateRecord.proposed_action) {
          reviewOnlyCandidateCount += 1;
          skipped.push(cleanRecord({
            candidate_id: stringValue(candidateRecord.id),
            reason: "review_only_candidate",
            candidate_kind: stringValue(candidateRecord.kind),
          }));
          continue;
        }
        if (children.length >= MAX_CHILD_PROPOSALS) {
          skipped.push(cleanRecord({
            candidate_id: stringValue(candidateRecord.id),
            reason: "max_child_proposals_reached",
            candidate_kind: stringValue(candidateRecord.kind),
          }));
          continue;
        }
        const draft = childDraft(candidateRecord, ctx);
        if (!draft) {
          skipped.push(cleanRecord({
            candidate_id: stringValue(candidateRecord.id),
            reason: "invalid_proposed_action",
            candidate_kind: stringValue(candidateRecord.kind),
          }));
          continue;
        }
        children.push(draft);
      }
      return {
        children,
        skipped,
        finalPayloadExtra: {
          canonical_write_performed: false,
          review_only_candidate_count: reviewOnlyCandidateCount,
        },
        resultExtra: {
          report_artifact_id: stringValue(payload.report_artifact_id),
          canonical_write_performed: false,
          review_only_candidate_count: reviewOnlyCandidateCount,
        },
      };
    },
  });
}

function childDraft(candidate: Record<string, unknown>, context: ProposalApplyContext): ChildProposalDraft | null {
  const action = record(candidate.proposed_action);
  const proposalType = stringValue(action.proposal_type);
  const baseMeta = {
    relation_discovery_packet: {
      source_packet_proposal_id: context.proposal.id,
      source_report_artifact_id: stringValue((context.proposal.payload_json ?? {}).report_artifact_id),
      cluster_key: stringValue(candidate.cluster_key),
      confidence_tier: stringValue(candidate.confidence_tier),
    },
  };
  const common = {
    rationale: "Generated from an accepted candidate-relation discovery packet.",
    visibility: "private",
    projectFolderId: context.proposal.project_folder_id ?? null,
    projectId: context.proposal.project_id,
  };
  if (proposalType === "object_relation_create") {
    const fromObjectId = stringValue(action.from_object_id);
    const toObjectId = stringValue(action.to_object_id);
    const linkType = stringValue(action.link_type);
    if (!fromObjectId || !toObjectId || fromObjectId === toObjectId || !linkType) return null;
    return {
      ...common,
      proposalType: "object_relation_create",
      title: stringValue(candidate.title) ?? "Discovered object relation",
      payload: {
        operation: "object_relation_create",
        from_object_id: fromObjectId,
        to_object_id: toObjectId,
        link_type: linkType,
        status: "active",
        confidence: numericOrNull(action.confidence),
        evidence_summary: stringValue(action.evidence_summary) ?? "Discovered candidate relation.",
        metadata: baseMeta,
      },
    };
  }
  if (proposalType === "knowledge_create") {
    const title = stringValue(action.title);
    const content = stringValue(action.content);
    if (!title || !content) return null;
    return {
      ...common,
      proposalType: "knowledge_create",
      title: `Create: ${title}`,
      payload: {
        operation: "create",
        knowledge_kind: stringValue(action.knowledge_kind) ?? "concept",
        title,
        content,
        content_format: stringValue(action.content_format) ?? "markdown",
        visibility: stringValue(action.visibility) ?? "space_shared",
        tags: [],
        source_refs: [],
        metadata: baseMeta,
      },
    };
  }
  return null;
}

function reportPayload(
  input: RelationDiscoveryReportContext,
  ownerUserId: string,
  generatedAt: string,
  artifactId: string,
): Record<string, unknown> {
  return {
    kind: RELATION_DISCOVERY_REPORT_ARTIFACT_TYPE,
    version: 1,
    artifact_id: artifactId,
    visibility: visibilityForReviewScope(input.reviewScope),
    review_scope: reviewScopeValue(input.reviewScope),
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    generated_at: generatedAt,
    candidates: input.report.candidates,
    counts: input.report.counts,
    sources_scanned: input.report.sources_scanned,
    links_extracted: input.report.links_extracted,
    truncated: input.report.truncated,
    scan_options: input.scanOptions ?? {},
    access_safety: input.report.access_safety,
  };
}

function packetPayload(
  input: RelationDiscoveryReportContext & { artifactId: string },
  ownerUserId: string,
): Record<string, unknown> {
  return {
    operation: "relation_discovery_packet",
    target_scope: "knowledge",
    target_namespace: "knowledge.relation_discovery",
    review_scope: reviewScopeValue(input.reviewScope),
    proposed_content: summaryForReport(input.report),
    report_artifact_id: input.artifactId,
    space_id: input.spaceId,
    owner_user_id: ownerUserId,
    candidates: input.report.candidates,
    candidate_count: input.report.candidates.length,
    proposal_candidate_count: proposalCandidateCount(input.report),
    review_only_candidate_count: reviewOnlyCandidateCount(input.report),
    counts: input.report.counts,
    generated_child_proposal_ids: [],
    canonical_write_performed: false,
  };
}


function titleForReport(report: RelationDiscoveryReport): string {
  const proposals = proposalCandidateCount(report);
  return `Relation Discovery Report: ${report.candidates.length} candidates, ${proposals} proposal-ready`;
}

function summaryForReport(report: RelationDiscoveryReport): string {
  const counts = Object.entries(report.counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
  return counts || "No relation discovery candidates.";
}

function proposalCandidateCount(report: RelationDiscoveryReport): number {
  return report.candidates.filter((candidate) => candidate.proposed_action != null).length;
}

function reviewOnlyCandidateCount(report: RelationDiscoveryReport): number {
  return report.candidates.filter((candidate) => candidate.proposed_action == null).length;
}

function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("relation discovery artifacts require owner_user_id");
  return owner;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanRecord<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null) out[key] = entry;
  }
  return out as T;
}

class RelationDiscoveryPacketApplyError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = "RelationDiscoveryPacketApplyError";
  }
}
