import { createHash, randomUUID } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import type { ClaimCandidatePacketCreateRequest } from "@agent-space/protocol";
import type { ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import type { Queryable } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import {
  acceptReviewPacket,
  insertProposalRow,
  lookupExistingPendingPacket,
  visibilityForReviewScope,
  type ChildProposalDraft,
} from "../proposals/reviewPackets.js";
import { loadSourcePolicySnapshots } from "../retrieval/sourcePolicy.js";
import { CLAIM_KINDS } from "./knowledgeRepositoryRows.js";
import {
  contentOwnerFilterSql,
  contentReadSql,
  contentVisibilityFilterSql,
} from "../access/contentAccessSql.js";

export const CLAIM_CANDIDATE_PACKET_ARTIFACT_TYPE = "claim_candidate_packet";
export const CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE = "claim_candidate_packet";

type ReviewScope = "private" | "space_ops";

interface SourceArtifactRow {
  id: string;
  artifact_type: string;
  title: string;
  visibility: "private" | "space_shared";
  metadata_json: unknown;
}

interface ClaimCandidateAction {
  id: string;
  kind: "claim_candidate" | "object_relation_candidate" | "review_note";
  title: string;
  reason: string;
  origin: {
    source_artifact_id: string;
    source_artifact_type: string;
    source_section: string;
  };
  evidence_refs: Array<Record<string, unknown>>;
  source_connection_ids: string[];
  source_policy_snapshots: Record<string, unknown>;
  markers: Record<string, unknown>;
  confidence: number | null;
  proposed_action: {
    proposal_type: "claim_create" | "object_relation_create";
    title: string;
    payload: Record<string, unknown>;
  } | null;
}

export interface ClaimCandidatePacketCreateResult {
  artifactId: string;
  proposalId: string;
  candidateCount: number;
  sourceArtifactCount: number;
  generatedChildProposalCount: number;
}

export async function createClaimCandidatePacketFromArtifacts(
  db: Queryable,
  input: {
    spaceId: string;
    ownerUserId: string;
    request: ClaimCandidatePacketCreateRequest;
  },
): Promise<ClaimCandidatePacketCreateResult> {
  const ownerUserId = normalizedOwner(input.ownerUserId);
  const artifactIds = uniqueStrings(input.request.source_artifact_ids);
  if (artifactIds.length === 0) throw new HttpError(422, "source_artifact_ids is required");
  assertPrivateSourcePromotionConfirmed(input.request);
  const rows = await loadVisibleSourceArtifacts(
    db,
    input.spaceId,
    ownerUserId,
    artifactIds,
    input.request.review_scope,
    input.request.promote_private_sources_to_space_ops,
  );
  if (rows.length !== artifactIds.length) {
    throw new HttpError(404, "source artifact not found or not visible");
  }
  const candidates = await buildCandidates(db, input.spaceId, rows, input.request.max_candidates);
  const artifactId = await persistClaimCandidatePacketArtifact(db, {
    spaceId: input.spaceId,
    ownerUserId,
    sourceArtifacts: rows,
    candidates,
    reviewScope: input.request.review_scope,
  });
  const proposalId = await createClaimCandidatePacketProposal(db, {
    spaceId: input.spaceId,
    ownerUserId,
    artifactId,
    sourceArtifacts: rows,
    candidates,
    reviewScope: input.request.review_scope,
  });
  return {
    artifactId,
    proposalId,
    candidateCount: candidates.length,
    sourceArtifactCount: rows.length,
    generatedChildProposalCount: 0,
  };
}

function assertPrivateSourcePromotionConfirmed(request: ClaimCandidatePacketCreateRequest): void {
  if (!request.promote_private_sources_to_space_ops) return;
  if (request.review_scope !== "space_ops") {
    throw new HttpError(422, "private source promotion is only valid for space_ops review");
  }
  if (!request.private_source_promotion_confirmed) {
    throw new HttpError(422, "private source promotion requires explicit confirmation");
  }
}

export function registerClaimCandidatePacketProposalAppliers(registry: {
  register(proposalType: string, applier: (context: ProposalApplyContext) => Promise<ProposalApplyResult>): void;
}): void {
  registry.register(CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE, applyClaimCandidatePacketProposal);
}

function applyClaimCandidatePacketProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  return acceptReviewPacket(context, {
    expectedOperation: "claim_candidate_packet",
    resultType: "claim_candidate_packet",
    privateMessage: "claim candidate packet is private to its creator",
    invalidPayload: () => new ClaimCandidatePacketApplyError("claim candidate packet payload is invalid"),
    build: async (payload, ctx) => {
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      const children: ChildProposalDraft[] = [];
      const skipped: Array<Record<string, unknown>> = [];
      for (const candidate of candidates) {
        const action = proposedAction(candidate);
        if (!action) {
          const candidateRecord = record(candidate);
          if (Object.prototype.hasOwnProperty.call(candidateRecord, "proposed_action") && candidateRecord.proposed_action !== null) {
            skipped.push(skipCandidate(candidateRecord, "invalid_proposed_action"));
          }
          continue;
        }
        const parsed = protocol.ClaimObjectProposalPayloadSchema.safeParse(action.payload);
        if (!parsed.success) {
          skipped.push(skipCandidate(record(candidate), parsed.error.issues[0]?.message ?? "payload_schema_invalid", action.proposal_type));
          continue;
        }
        if (parsed.data.operation !== action.proposal_type) {
          skipped.push(skipCandidate(
            record(candidate),
            `proposal_type ${action.proposal_type} does not match payload operation ${parsed.data.operation}`,
            action.proposal_type,
          ));
          continue;
        }
        children.push(claimChildDraft(ctx, action, payload));
      }
      return {
        children,
        skipped,
        finalPayloadExtra: { canonical_write_performed: false },
        resultExtra: {
          packet_artifact_id: stringValue(payload.packet_artifact_id),
          canonical_write_performed: false,
        },
      };
    },
  });
}

async function loadVisibleSourceArtifacts(
  db: Queryable,
  spaceId: string,
  ownerUserId: string,
  artifactIds: readonly string[],
  reviewScope: ReviewScope,
  promotePrivateSourcesToSpaceOps: boolean,
): Promise<SourceArtifactRow[]> {
  const allowedVisibilities = reviewScope === "space_ops"
    ? promotePrivateSourcesToSpaceOps
      ? (["space_shared", "private"] as const)
      : (["space_shared"] as const)
    : (["private"] as const);
  const result = await db.query<SourceArtifactRow>(
    `SELECT a.id, a.artifact_type, a.title, a.visibility, a.metadata_json
       FROM artifacts a
      WHERE a.space_id = $1
        AND ${contentReadSql("artifact", "a", "$2")}
        AND ${contentOwnerFilterSql("artifact", "a", "$2")}
        AND ${contentVisibilityFilterSql("a", allowedVisibilities)}
        AND a.id = ANY($3::varchar[])
        AND a.artifact_type = ANY($4::varchar[])
      ORDER BY array_position($3::varchar[], a.id)`,
    [
      spaceId,
      ownerUserId,
      artifactIds,
      [
        "retrieval_brief",
        "retrieval_maintenance_report",
        "retrieval_eval_report",
        "memory_maintenance_report",
        "claim_contradiction_report",
      ],
    ],
  );
  return result.rows;
}

async function buildCandidates(
  db: Queryable,
  spaceId: string,
  rows: readonly SourceArtifactRow[],
  maxCandidates: number,
): Promise<ClaimCandidateAction[]> {
  const out: ClaimCandidateAction[] = [];
  for (const row of rows) {
    if (out.length >= maxCandidates) break;
    const metadata = record(row.metadata_json);
    const sourceConnectionIds = sourceConnectionIdsFromMetadata(metadata);
    const snapshots = await sourcePolicySnapshotMap(db, spaceId, sourceConnectionIds);
    const remaining = maxCandidates - out.length;
    if (row.artifact_type === "retrieval_brief") {
      out.push(...briefCandidates(row, metadata, snapshots).slice(0, remaining));
      continue;
    }
    if (row.artifact_type === "retrieval_maintenance_report") {
      out.push(...maintenanceCandidates(row, metadata, snapshots).slice(0, remaining));
      continue;
    }
    if (row.artifact_type === "retrieval_eval_report") {
      out.push(...diagnosticsCandidates(row, metadata, snapshots).slice(0, remaining));
      continue;
    }
    if (row.artifact_type === "memory_maintenance_report") {
      out.push(...memoryMaintenanceCandidates(row, metadata, snapshots).slice(0, remaining));
      continue;
    }
    if (row.artifact_type === "claim_contradiction_report") {
      out.push(...contradictionReportCandidates(row, metadata, snapshots).slice(0, remaining));
    }
  }
  return out.slice(0, maxCandidates);
}

/**
 * Slice E bridge: a contradiction-discovery report already carries concrete
 * `from_object_id` / `to_object_id` pairs (the scan only judged visible claims), so
 * each finding becomes a real `object_relation_create` (contradicts) candidate
 * rather than a review note. Accepting the packet still only creates child
 * pending proposals.
 */
function contradictionReportCandidates(
  row: SourceArtifactRow,
  metadata: Record<string, unknown>,
  sourcePolicySnapshots: Record<string, unknown>,
): ClaimCandidateAction[] {
  const candidates: ClaimCandidateAction[] = [];
  for (const finding of arrayValue(metadata.findings).map(record)) {
    const action = record(finding.proposed_action);
    const fromClaimId = stringValue(action.from_object_id);
    const toClaimId = stringValue(action.to_object_id);
    if (!fromClaimId || !toClaimId || fromClaimId === toClaimId) continue;
    const fromTitle = stringValue(record(finding.from_claim).title);
    const toTitle = stringValue(record(finding.to_claim).title);
    candidates.push(claimRelationAction({
      row,
      sourceSection: "claim_contradiction.findings",
      title: `Review contradiction: ${shortTitle(fromTitle ?? "claim")} ⇄ ${shortTitle(toTitle ?? "claim")}`,
      reason: stringValue(finding.reason)
        ?? "Contradiction scan flagged two visible active claims about the same subject as conflicting.",
      fromClaimId,
      toClaimId,
      linkType: "contradicts",
      confidence: numericValue(action.confidence, 0.4),
      markers: {
        contradiction: true,
        signal: stringValue(finding.signal),
        confidence_tier: stringValue(finding.confidence_tier),
        cluster_key: stringValue(finding.cluster_key),
      },
      sourcePolicySnapshots,
    }));
  }
  return candidates;
}

function briefCandidates(
  row: SourceArtifactRow,
  metadata: Record<string, unknown>,
  sourcePolicySnapshots: Record<string, unknown>,
): ClaimCandidateAction[] {
  const gap = record(metadata.gap_analysis);
  const sourceConnectionIds = sourceConnectionIdsFromMetadata(metadata);
  const candidates: ClaimCandidateAction[] = [];
  for (const entry of arrayValue(gap.uncited_claims)) {
    const hint = claimCandidateHint(entry);
    const claimText = clampText(hint.claimText, 1000);
    if (!claimText) continue;
    candidates.push(claimAction({
      row,
      sourceSection: "gap_analysis.uncited_claims",
      title: `Review uncited claim: ${shortTitle(claimText)}`,
      reason: "Context Brief emitted an uncited claim; reviewer must supply evidence or reject it.",
      claimText,
      claimKind: hint.claimKind,
      status: "active",
      resolutionState: "needs_source",
      confidence: 0.35,
      confidenceMethod: "llm_extracted",
      holderObjectId: hint.holderObjectId,
      holderType: hint.holderType,
      holderId: hint.holderId,
      validFrom: hint.validFrom,
      validUntil: hint.validUntil,
      observedAt: hint.observedAt,
      markers: { needs_source: true, ...hint.markers },
      sourceConnectionIds: uniqueStrings([...sourceConnectionIds, ...hint.sourceConnectionIds]),
      sourcePolicySnapshots,
    }));
  }
  for (const item of arrayValue(gap.contradictions)) {
    const relation = contradictionRelation(row, item, sourcePolicySnapshots);
    if (relation) {
      candidates.push(relation);
      continue;
    }
    const text = typeof item === "string" ? clampText(item, 1000) : firstString(record(item), ["text", "claim", "reason", "summary"]);
    if (!text) continue;
    candidates.push(reviewNote({
      row,
      sourceSection: "gap_analysis.contradictions",
      title: `Review contradiction: ${shortTitle(text)}`,
      reason: "Context Brief detected a contradiction signal, but the brief does not identify two canonical claim ids; reviewer must inspect the sources before creating claim relations.",
      markers: { contradiction: true, text },
      sourceConnectionIds,
      sourcePolicySnapshots,
    }));
  }
  for (const text of stringArray(gap.missing_topics)) {
    const topic = clampText(text, 500);
    if (!topic) continue;
    candidates.push(reviewNote({
      row,
      sourceSection: "gap_analysis.missing_topics",
      title: `Missing topic: ${shortTitle(topic)}`,
      reason: "Context Brief reported a missing topic; this needs human scoping before it can become a claim.",
      markers: { missing_topic: true, topic },
      sourceConnectionIds,
      sourcePolicySnapshots,
    }));
  }
  for (const item of arrayValue(gap.stale).map(record)) {
    const title = firstString(item, ["title", "object_id"]) ?? "object";
    candidates.push(reviewNote({
      row,
      sourceSection: "gap_analysis.stale",
      title: `Stale reference: ${shortTitle(title)}`,
      reason: stringValue(item.reason) ?? "Context Brief flagged this cited object as stale.",
      markers: {
        stale: true,
        object_id: stringValue(item.object_id),
        object_type: stringValue(item.object_type),
      },
      sourceConnectionIds,
      sourcePolicySnapshots,
    }));
  }
  for (const item of arrayValue(gap.thin).map(record)) {
    const title = firstString(item, ["title", "object_id"]) ?? "object";
    candidates.push(reviewNote({
      row,
      sourceSection: "gap_analysis.thin",
      title: `Thin reference: ${shortTitle(title)}`,
      reason: stringValue(item.reason) ?? "Context Brief flagged this cited object as thin.",
      markers: {
        thin: true,
        enrichment_suggestion: true,
        object_id: stringValue(item.object_id),
        object_type: stringValue(item.object_type),
      },
      sourceConnectionIds,
      sourcePolicySnapshots,
    }));
  }
  return candidates;
}

function maintenanceCandidates(
  row: SourceArtifactRow,
  metadata: Record<string, unknown>,
  sourcePolicySnapshots: Record<string, unknown>,
): ClaimCandidateAction[] {
  const candidates: ClaimCandidateAction[] = [];
  for (const finding of arrayValue(metadata.findings).map(record)) {
    const kind = stringValue(finding.kind);
    const objects = arrayValue(finding.objects).map(record);
    const first = objects[0];
    if (kind === "stale" && first) {
      const title = stringValue(first.title) ?? stringValue(first.object_id) ?? "object";
      candidates.push(reviewNote({
        row,
        sourceSection: "maintenance.stale",
        title: `Review stale object: ${shortTitle(title)}`,
        reason: stringValue(finding.reason) ?? "Maintenance flagged stale canonical content.",
        markers: { stale: true, object_id: stringValue(first.object_id), object_type: stringValue(first.object_type) },
        sourceConnectionIds: [],
        sourcePolicySnapshots,
      }));
      continue;
    }
    if (kind === "thin" && first) {
      const title = stringValue(first.title) ?? stringValue(first.object_id) ?? "object";
      candidates.push(reviewNote({
        row,
        sourceSection: "maintenance.thin",
        title: `Review thin object: ${shortTitle(title)}`,
        reason: stringValue(finding.reason) ?? "Maintenance flagged thin canonical content.",
        markers: { thin: true, enrichment_suggestion: true, object_id: stringValue(first.object_id), object_type: stringValue(first.object_type) },
        sourceConnectionIds: [],
        sourcePolicySnapshots,
      }));
      continue;
    }
    if (kind === "orphan" && first) {
      const title = stringValue(first.title) ?? stringValue(first.object_id) ?? "object";
      candidates.push(reviewNote({
        row,
        sourceSection: "maintenance.orphan",
        title: `Review orphan object: ${shortTitle(title)}`,
        reason: stringValue(finding.reason) ?? "Maintenance flagged an object with no retrieval graph edges.",
        markers: { orphan: true, object_id: stringValue(first.object_id), object_type: stringValue(first.object_type) },
        sourceConnectionIds: [],
        sourcePolicySnapshots,
      }));
      continue;
    }
    if (kind === "duplicate" && objects.length >= 2) {
      const from = objects[0];
      const to = objects[1];
      const fromId = stringValue(from.object_id);
      const toId = stringValue(to.object_id);
      if (!fromId || !toId) continue;
      candidates.push(objectRelationAction({
        row,
        sourceSection: "maintenance.duplicate",
        title: "Review duplicate object relation",
        reason: stringValue(finding.reason) ?? "Maintenance found likely duplicate objects.",
        fromObjectId: fromId,
        toObjectId: toId,
        linkType: "same_as",
        confidence: 0.55,
        markers: { duplicate: true },
        sourcePolicySnapshots,
      }));
      continue;
    }
    if (kind === "relation_suggestion" && objects.length >= 2) {
      const from = objects[0];
      const to = objects[1];
      const fromId = stringValue(from.object_id);
      const toId = stringValue(to.object_id);
      if (!fromId || !toId) continue;
      candidates.push(objectRelationAction({
        row,
        sourceSection: "maintenance.relation_suggestion",
        title: "Review object relation suggestion",
        reason: stringValue(finding.reason) ?? "Maintenance found a relation candidate.",
        fromObjectId: fromId,
        toObjectId: toId,
        linkType: "related_to",
        confidence: 0.5,
        markers: { relation_suggestion: true },
        sourcePolicySnapshots,
      }));
    }
  }
  return candidates;
}

function diagnosticsCandidates(
  row: SourceArtifactRow,
  metadata: Record<string, unknown>,
  sourcePolicySnapshots: Record<string, unknown>,
): ClaimCandidateAction[] {
  const sourceConnectionIds = sourceConnectionIdsFromMetadata(metadata);
  const out: ClaimCandidateAction[] = [];
  const counts = record(metadata.counts);
  const uncited = integerValue(counts.uncited_claims_total);
  if (uncited > 0) {
    out.push(reviewNote({
      row,
      sourceSection: "diagnostics.uncited_claims_total",
      title: "Diagnostics reported uncited claim candidates",
      reason: `${uncited} uncited claim signal(s) were observed in aggregate diagnostics; open the source briefs before creating concrete claims.`,
      markers: { needs_source: true, uncited_claims_total: uncited },
      sourceConnectionIds,
      sourcePolicySnapshots,
    }));
  }
  const contradictions = integerValue(counts.contradictions_total);
  if (contradictions > 0) {
    out.push(reviewNote({
      row,
      sourceSection: "diagnostics.contradictions_total",
      title: "Diagnostics reported contradiction candidates",
      reason: `${contradictions} contradiction signal(s) were observed in aggregate diagnostics; open the source briefs before creating concrete claim relations.`,
      markers: { contradiction: true, contradictions_total: contradictions },
      sourceConnectionIds,
      sourcePolicySnapshots,
    }));
  }
  for (const code of stringArray(metadata.diagnostic_codes)) {
    if (!["uncited_claims", "contradictions", "missing_topics", "stale_sources", "thin_sources"].includes(code)) continue;
    out.push(reviewNote({
      row,
      sourceSection: "diagnostics.diagnostic_codes",
      title: `Diagnostics code: ${code}`,
      reason: "Aggregate diagnostics flagged claim work but does not contain raw claim text.",
      markers: { diagnostic_code: code },
      sourceConnectionIds,
      sourcePolicySnapshots,
    }));
  }
  return out;
}

function contradictionRelation(
  row: SourceArtifactRow,
  value: unknown,
  sourcePolicySnapshots: Record<string, unknown>,
): ClaimCandidateAction | null {
  const item = record(value);
  const claimIds = stringArray(item.claim_ids);
  const fromClaimId = stringValue(item.from_claim_id) ?? claimIds[0] ?? null;
  const toClaimId = stringValue(item.to_claim_id) ?? claimIds[1] ?? null;
  if (!fromClaimId || !toClaimId || fromClaimId === toClaimId) return null;
  return claimRelationAction({
    row,
    sourceSection: "gap_analysis.contradictions",
    title: firstString(item, ["title", "summary", "reason"]) ?? "Review contradicting claims",
    reason: firstString(item, ["reason", "summary", "text"]) ?? "Context Brief identified two claims that may contradict each other.",
    fromClaimId,
    toClaimId,
    linkType: "contradicts",
    confidence: numericValue(item.confidence, 0.4),
    markers: { contradiction: true },
    sourcePolicySnapshots,
  });
}

function claimRelationAction(input: {
  row: SourceArtifactRow;
  sourceSection: string;
  title: string;
  reason: string;
  fromClaimId: string;
  toClaimId: string;
  linkType: string;
  confidence: number;
  markers: Record<string, unknown>;
  sourcePolicySnapshots: Record<string, unknown>;
}): ClaimCandidateAction {
  const evidenceRefs = artifactEvidenceRefs(input.row);
  const payload = {
    operation: "object_relation_create",
    from_object_id: input.fromClaimId,
    to_object_id: input.toClaimId,
    link_type: input.linkType,
    status: "candidate",
    confidence: input.confidence,
    evidence_summary: input.reason,
    metadata: {
      candidate_origin: "claim_candidate_packet",
      endpoint_type: "claim",
      source_artifact_ids: [input.row.id],
      source_section: input.sourceSection,
      evidence_refs: evidenceRefs,
      markers: input.markers,
    },
  };
  return {
    id: randomUUID(),
    kind: "object_relation_candidate",
    title: input.title,
    reason: input.reason,
    origin: origin(input.row, input.sourceSection),
    evidence_refs: evidenceRefs,
    source_connection_ids: [],
    source_policy_snapshots: input.sourcePolicySnapshots,
    markers: input.markers,
    confidence: input.confidence,
    proposed_action: {
      proposal_type: "object_relation_create",
      title: input.title,
      payload,
    },
  };
}

function memoryMaintenanceCandidates(
  row: SourceArtifactRow,
  metadata: Record<string, unknown>,
  sourcePolicySnapshots: Record<string, unknown>,
): ClaimCandidateAction[] {
  const candidates: ClaimCandidateAction[] = [];
  for (const finding of arrayValue(metadata.findings).map(record)) {
    const kind = stringValue(finding.kind);
    if (!kind) continue;
    const target = firstMemoryTarget(finding);
    candidates.push(reviewNote({
      row,
      sourceSection: `memory_maintenance.${kind}`,
      title: `Review Memory ${kind}: ${shortTitle(target.title ?? target.id ?? "memory")}`,
      reason: stringValue(finding.reason) ?? "Memory maintenance flagged this review item.",
      markers: {
        memory_maintenance: true,
        kind,
        memory_id: target.id,
      },
      sourceConnectionIds: [],
      sourcePolicySnapshots,
    }));
  }
  return candidates;
}

function claimAction(input: {
  row: SourceArtifactRow;
  sourceSection: string;
  title: string;
  reason: string;
  claimText: string;
  subjectObjectId?: string | null;
  claimKind: string;
  status: string;
  resolutionState: string;
  confidence: number;
  confidenceMethod: string;
  holderObjectId?: string | null;
  holderType?: string | null;
  holderId?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  observedAt?: string | null;
  markers: Record<string, unknown>;
  sourceConnectionIds: string[];
  sourcePolicySnapshots: Record<string, unknown>;
}): ClaimCandidateAction {
  const evidenceRefs = artifactEvidenceRefs(input.row);
  const payload = {
    operation: "claim_create",
    subject_object_id: input.subjectObjectId ?? undefined,
    subject_text: input.subjectObjectId ? undefined : subjectFromClaimText(input.claimText),
    claim_kind: input.claimKind,
    claim_text: input.claimText,
    title: shortTitle(input.claimText),
    holder_object_id: input.holderObjectId ?? undefined,
    holder_type: input.holderObjectId ? undefined : input.holderType ?? undefined,
    holder_id: input.holderObjectId ? undefined : input.holderId ?? undefined,
    confidence: input.confidence,
    confidence_method: input.confidenceMethod,
    status: input.status,
    resolution_state: input.resolutionState,
    valid_from: input.validFrom ?? undefined,
    valid_until: input.validUntil ?? undefined,
    observed_at: input.observedAt ?? undefined,
    visibility: input.row.visibility,
    sources: claimSourcesFromConnections(input.sourceConnectionIds, input.sourcePolicySnapshots, input),
    metadata: {
      candidate_origin: "claim_candidate_packet",
      source_artifact_ids: [input.row.id],
      source_section: input.sourceSection,
      evidence_refs: evidenceRefs,
      markers: input.markers,
      source_connection_ids: input.sourceConnectionIds,
      claim_enrichment: cleanRecord({
        holder_object_id: input.holderObjectId ?? undefined,
        holder_type: input.holderObjectId ? undefined : input.holderType ?? undefined,
        holder_id: input.holderObjectId ? undefined : input.holderId ?? undefined,
        valid_from: input.validFrom ?? undefined,
        valid_until: input.validUntil ?? undefined,
        observed_at: input.observedAt ?? undefined,
      }),
    },
  };
  return {
    id: randomUUID(),
    kind: "claim_candidate",
    title: input.title,
    reason: input.reason,
    origin: origin(input.row, input.sourceSection),
    evidence_refs: evidenceRefs,
    source_connection_ids: input.sourceConnectionIds,
    source_policy_snapshots: input.sourcePolicySnapshots,
    markers: input.markers,
    confidence: input.confidence,
    proposed_action: {
      proposal_type: "claim_create",
      title: `Claim candidate: ${shortTitle(input.claimText)}`,
      payload: cleanRecord(payload),
    },
  };
}

function objectRelationAction(input: {
  row: SourceArtifactRow;
  sourceSection: string;
  title: string;
  reason: string;
  fromObjectId: string;
  toObjectId: string;
  linkType: string;
  confidence: number;
  markers: Record<string, unknown>;
  sourcePolicySnapshots: Record<string, unknown>;
}): ClaimCandidateAction {
  const evidenceRefs = artifactEvidenceRefs(input.row);
  const payload = {
    operation: "object_relation_create",
    from_object_id: input.fromObjectId,
    to_object_id: input.toObjectId,
    link_type: input.linkType,
    status: "candidate",
    confidence: input.confidence,
    evidence_summary: input.reason,
    metadata: {
      candidate_origin: "claim_candidate_packet",
      source_artifact_ids: [input.row.id],
      source_section: input.sourceSection,
      evidence_refs: evidenceRefs,
      markers: input.markers,
    },
  };
  return {
    id: randomUUID(),
    kind: "object_relation_candidate",
    title: input.title,
    reason: input.reason,
    origin: origin(input.row, input.sourceSection),
    evidence_refs: evidenceRefs,
    source_connection_ids: [],
    source_policy_snapshots: input.sourcePolicySnapshots,
    markers: input.markers,
    confidence: input.confidence,
    proposed_action: {
      proposal_type: "object_relation_create",
      title: input.title,
      payload,
    },
  };
}

function reviewNote(input: {
  row: SourceArtifactRow;
  sourceSection: string;
  title: string;
  reason: string;
  markers: Record<string, unknown>;
  sourceConnectionIds: string[];
  sourcePolicySnapshots: Record<string, unknown>;
}): ClaimCandidateAction {
  return {
    id: randomUUID(),
    kind: "review_note",
    title: input.title,
    reason: input.reason,
    origin: origin(input.row, input.sourceSection),
    evidence_refs: artifactEvidenceRefs(input.row),
    source_connection_ids: input.sourceConnectionIds,
    source_policy_snapshots: input.sourcePolicySnapshots,
    markers: input.markers,
    confidence: null,
    proposed_action: null,
  };
}

interface ClaimCandidateHint {
  claimText: string;
  claimKind: string;
  holderObjectId: string | null;
  holderType: string | null;
  holderId: string | null;
  validFrom: string | null;
  validUntil: string | null;
  observedAt: string | null;
  sourceConnectionIds: string[];
  markers: Record<string, unknown>;
}

function claimCandidateHint(value: unknown): ClaimCandidateHint {
  const item = record(value);
  const claimText = typeof value === "string"
    ? value
    : firstString(item, ["claim_text", "text", "claim", "summary"]) ?? "";
  const inferred = inferClaimEnrichment(claimText);
  const explicitClaimKind = stringValue(item.claim_kind);
  const holderObjectId = stringValue(item.holder_object_id);
  const explicitHolderType = stringValue(item.holder_type);
  const explicitHolderId = stringValue(item.holder_id);
  return {
    claimText,
    claimKind: explicitClaimKind && CLAIM_KINDS.has(explicitClaimKind)
      ? explicitClaimKind
      : inferred.claimKind,
    holderObjectId,
    holderType: holderObjectId ? null : explicitHolderType ?? inferred.holderType,
    holderId: holderObjectId ? null : explicitHolderId ?? inferred.holderId,
    validFrom: dateIsoValue(item.valid_from) ?? inferred.validFrom,
    validUntil: dateIsoValue(item.valid_until) ?? inferred.validUntil,
    observedAt: dateIsoValue(item.observed_at) ?? inferred.observedAt,
    sourceConnectionIds: uniqueStrings([
      ...stringArray(item.source_connection_ids),
      ...stringArray(record(item.metadata).source_connection_ids),
    ]),
    markers: cleanRecord({
      holder_inferred: Boolean(!holderObjectId && !explicitHolderType && inferred.holderType),
      validity_inferred: Boolean(inferred.validFrom || inferred.validUntil || inferred.observedAt),
      structured_claim_hint: Object.keys(item).length > 0,
    }),
  };
}

function inferClaimEnrichment(text: string): Omit<ClaimCandidateHint, "claimText" | "sourceConnectionIds" | "markers"> {
  const holder = inferHolder(text);
  const validity = inferValidity(text);
  return {
    claimKind: holder?.claimKind ?? "hypothesis",
    holderObjectId: null,
    holderType: holder ? "actor" : null,
    holderId: holder?.holderId ?? null,
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    observedAt: validity.observedAt,
  };
}

function inferHolder(text: string): { holderId: string; claimKind: string } | null {
  const match = text.match(/^\s*(?<holder>[A-Z][\w .'-]{1,80}|the\s+team|this\s+source|the\s+source|the\s+user)\s+(?<verb>believes|thinks|argues|claims|says|prefers|wants|committed|commits|expects)\s+(?<rest>.+)$/i);
  const holder = match?.groups?.holder?.trim();
  const verb = match?.groups?.verb?.toLowerCase();
  if (!holder || !verb) return null;
  return {
    holderId: holderIdFromLabel(holder),
    claimKind: claimKindForPerspectiveVerb(verb),
  };
}

function claimKindForPerspectiveVerb(verb: string): string {
  if (verb === "prefers" || verb === "wants") return "preference";
  if (verb === "committed" || verb === "commits" || verb === "expects") return "commitment";
  if (verb === "argues" || verb === "claims" || verb === "says") return "interpretation";
  return "belief";
}

function holderIdFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128) || "actor";
}

function inferValidity(text: string): { validFrom: string | null; validUntil: string | null; observedAt: string | null } {
  const date = String.raw`(\d{4}-\d{2}-\d{2})`;
  const range = new RegExp(String.raw`\b(?:from|between)\s+${date}\s+(?:to|until|through|and)\s+${date}\b`, "i").exec(text);
  const validFrom = range ? dateTokenToIso(range[1]) : null;
  const validUntil = range ? dateTokenToIso(range[2]) : dateTokenToIso(new RegExp(String.raw`\buntil\s+${date}\b`, "i").exec(text)?.[1]);
  const observedAt = dateTokenToIso(new RegExp(String.raw`\b(?:as of|observed on|on)\s+${date}\b`, "i").exec(text)?.[1]);
  return { validFrom, validUntil, observedAt };
}

function claimSourcesFromConnections(
  sourceConnectionIds: readonly string[],
  sourcePolicySnapshots: Record<string, unknown>,
  input: {
    row: SourceArtifactRow;
    sourceSection: string;
    confidence: number;
    markers: Record<string, unknown>;
  },
): Array<Record<string, unknown>> | undefined {
  const sources = uniqueStrings(sourceConnectionIds)
    .filter((sourceConnectionId) =>
      Object.prototype.hasOwnProperty.call(sourcePolicySnapshots, sourceConnectionId))
    .map((sourceConnectionId) => ({
      source_connection_id: sourceConnectionId,
      source_policy_snapshot: record(sourcePolicySnapshots[sourceConnectionId]),
      evidence_role: "mentions",
      confidence: input.confidence,
      metadata: {
        candidate_origin: "claim_candidate_packet",
        source_artifact_id: input.row.id,
        source_artifact_type: input.row.artifact_type,
        source_section: input.sourceSection,
        markers: input.markers,
      },
    }));
  return sources.length > 0 ? sources : undefined;
}

function dateIsoValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return dateTokenToIso(value.trim()) ?? dateTimeToIso(value.trim());
}

function dateTokenToIso(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return dateTimeToIso(`${value}T00:00:00.000Z`);
}

function dateTimeToIso(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstMemoryTarget(finding: Record<string, unknown>): { id: string | null; title: string | null } {
  const memories = arrayValue(finding.memories).map(record);
  const objects = arrayValue(finding.objects).map(record);
  const first = memories[0] ?? objects[0] ?? finding;
  return {
    id: stringValue(first.memory_id) ?? stringValue(first.object_id) ?? stringValue(first.id),
    title: firstString(first, ["title", "summary", "content_preview", "memory_id", "object_id", "id"]),
  };
}

async function persistClaimCandidatePacketArtifact(
  db: Queryable,
  input: {
    spaceId: string;
    ownerUserId: string;
    sourceArtifacts: readonly SourceArtifactRow[];
    candidates: readonly ClaimCandidateAction[];
    reviewScope: ReviewScope;
  },
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const payload = packetArtifactPayload(input, id, now);
  return insertArtifactRow(db, {
    id,
    spaceId: input.spaceId,
    ownerUserId: input.ownerUserId,
    artifactType: CLAIM_CANDIDATE_PACKET_ARTIFACT_TYPE,
    title: titleForPacket(input.candidates.length),
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "claim_candidate_packet.v1",
    visibility: visibilityForReviewScope(input.reviewScope),
    createdAt: now,
  });
}

async function createClaimCandidatePacketProposal(
  db: Queryable,
  input: {
    spaceId: string;
    ownerUserId: string;
    artifactId: string;
    sourceArtifacts: readonly SourceArtifactRow[];
    candidates: readonly ClaimCandidateAction[];
    reviewScope: ReviewScope;
  },
): Promise<string> {
  const lineageKey = claimCandidateLineageKey(input.spaceId, input.sourceArtifacts);
  const existing = await lookupExistingPendingPacket(
    db, input.spaceId, CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE, lineageKey,
  );
  if (existing) return existing;
  const payload = packetProposalPayload(input, lineageKey);
  return (await insertProposalRow(db, {
    spaceId: input.spaceId,
    proposalType: CLAIM_CANDIDATE_PACKET_PROPOSAL_TYPE,
    title: titleForPacket(input.candidates.length),
    summary: summaryForPacket(input.candidates),
    payload,
    rationale:
      "Review this Claim Candidate Packet. Accepting creates child pending claim/object-relation proposals only; it does not write canonical Claims.",
    createdByUserId: input.ownerUserId,
    visibility: visibilityForReviewScope(input.reviewScope),
  })).id;
}

function claimChildDraft(
  context: ProposalApplyContext,
  action: NonNullable<ClaimCandidateAction["proposed_action"]>,
  packetPayloadValue: Record<string, unknown>,
): ChildProposalDraft {
  const packetArtifactId = stringValue(packetPayloadValue.packet_artifact_id);
  const packetContext = cleanRecord({
    source_candidate_packet_proposal_id: context.proposal.id,
    source_candidate_packet_artifact_id: packetArtifactId,
    provenance_entries: [
      { source_type: "proposal", source_id: context.proposal.id, source_trust: "derived_review" },
      ...(packetArtifactId
        ? [{ source_type: "artifact", source_id: packetArtifactId, source_trust: "derived_review" }]
        : []),
    ],
  });
  return {
    proposalType: action.proposal_type,
    title: action.title,
    payload: childPayloadWithPacketContext(action.payload, packetContext),
    rationale: "Generated from an accepted Claim Candidate Packet.",
    visibility: "private",
    projectId: context.proposal.project_id,
  };
}

function childPayloadWithPacketContext(
  payload: Record<string, unknown>,
  packetContext: Record<string, unknown>,
): Record<string, unknown> {
  const operation = stringValue(payload.operation);
  if (operation === "claim_create" || operation === "object_relation_create") {
    return {
      ...payload,
      metadata: {
        ...record(payload.metadata),
        claim_candidate_packet: packetContext,
      },
    };
  }
  return payload;
}

function packetArtifactPayload(input: {
  spaceId: string;
  ownerUserId: string;
  sourceArtifacts: readonly SourceArtifactRow[];
  candidates: readonly ClaimCandidateAction[];
  reviewScope: ReviewScope;
}, artifactId: string, generatedAt: string): Record<string, unknown> {
  return {
    kind: CLAIM_CANDIDATE_PACKET_ARTIFACT_TYPE,
    version: 1,
    artifact_id: artifactId,
    visibility: visibilityForReviewScope(input.reviewScope),
    review_scope: input.reviewScope,
    space_id: input.spaceId,
    owner_user_id: input.ownerUserId,
    generated_at: generatedAt,
    source_artifacts: input.sourceArtifacts.map(sourceArtifactRef),
    private_source_promotion: privateSourcePromotion(input.sourceArtifacts, input.reviewScope),
    promoted_source_artifact_ids: promotedSourceArtifactIds(input.sourceArtifacts, input.reviewScope),
    candidates: input.candidates,
    candidate_count: input.candidates.length,
    access_safety: {
      private_review_material: true,
      raw_source_content_included: false,
      hidden_object_counts_included: false,
      canonical_write_performed: false,
    },
  };
}

function claimCandidateLineageKey(spaceId: string, sourceArtifacts: readonly SourceArtifactRow[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const idsHash = createHash("sha256")
    .update([...sourceArtifacts].map((a) => a.id).sort().join(":"))
    .digest("hex")
    .slice(0, 16);
  return `claim_cand:${spaceId}:${idsHash}:${date}`;
}

function packetProposalPayload(input: {
  spaceId: string;
  ownerUserId: string;
  artifactId: string;
  sourceArtifacts: readonly SourceArtifactRow[];
  candidates: readonly ClaimCandidateAction[];
  reviewScope: ReviewScope;
}, lineageKey: string): Record<string, unknown> {
  return {
    operation: "claim_candidate_packet",
    lineage_key: lineageKey,
    target_scope: "claim",
    target_namespace: "knowledge.claim_candidates",
    review_scope: input.reviewScope,
    proposed_content: summaryForPacket(input.candidates),
    packet_artifact_id: input.artifactId,
    source_artifacts: input.sourceArtifacts.map(sourceArtifactRef),
    private_source_promotion: privateSourcePromotion(input.sourceArtifacts, input.reviewScope),
    promoted_source_artifact_ids: promotedSourceArtifactIds(input.sourceArtifacts, input.reviewScope),
    candidates: input.candidates,
    candidate_count: input.candidates.length,
    generated_child_proposal_ids: [],
    generated_child_proposal_count: 0,
    canonical_write_performed: false,
    space_id: input.spaceId,
    owner_user_id: input.ownerUserId,
  };
}

function proposedAction(value: unknown): NonNullable<ClaimCandidateAction["proposed_action"]> | null {
  const candidate = record(value);
  const action = record(candidate.proposed_action);
  const proposalType = stringValue(action.proposal_type);
  if (
    proposalType !== "claim_create" &&
    proposalType !== "object_relation_create"
  ) {
    return null;
  }
  const payload = record(action.payload);
  if (Object.keys(payload).length === 0) return null;
  return {
    proposal_type: proposalType,
    title: stringValue(action.title) ?? "Claim candidate child proposal",
    payload,
  };
}

function skipCandidate(
  candidate: Record<string, unknown>,
  reason: string,
  proposalType?: string,
): Record<string, unknown> {
  return cleanRecord({
    candidate_id: stringValue(candidate.id),
    title: stringValue(candidate.title),
    proposal_type: proposalType,
    reason,
  });
}

async function sourcePolicySnapshotMap(
  db: Queryable,
  spaceId: string,
  sourceConnectionIds: readonly string[],
): Promise<Record<string, unknown>> {
  const snapshots = await loadSourcePolicySnapshots(db, spaceId, sourceConnectionIds);
  const out: Record<string, unknown> = {};
  for (const [id, snapshot] of snapshots.entries()) {
    out[id] = snapshot;
  }
  return out;
}

function sourceConnectionIdsFromMetadata(metadata: Record<string, unknown>): string[] {
  const ids = [
    ...stringArray(metadata.source_connection_ids),
    ...arrayValue(metadata.item_refs).flatMap((item) =>
      arrayValue(record(item).source_refs).map((sourceRef) => stringValue(record(sourceRef).source_connection_id))),
  ];
  return uniqueStrings(ids);
}

function origin(row: SourceArtifactRow, sourceSection: string): ClaimCandidateAction["origin"] {
  return {
    source_artifact_id: row.id,
    source_artifact_type: row.artifact_type,
    source_section: sourceSection,
  };
}

function artifactEvidenceRefs(row: SourceArtifactRow): Array<Record<string, unknown>> {
  return [{ source_type: "artifact", source_id: row.id, artifact_type: row.artifact_type, title: row.title }];
}

function sourceArtifactRef(row: SourceArtifactRow): Record<string, unknown> {
  return { artifact_id: row.id, artifact_type: row.artifact_type, title: row.title, visibility: row.visibility };
}

function privateSourcePromotion(
  rows: readonly SourceArtifactRow[],
  reviewScope: ReviewScope,
): boolean {
  return reviewScope === "space_ops" && rows.some((row) => row.visibility === "private");
}

function promotedSourceArtifactIds(
  rows: readonly SourceArtifactRow[],
  reviewScope: ReviewScope,
): string[] {
  if (reviewScope !== "space_ops") return [];
  return rows.filter((row) => row.visibility === "private").map((row) => row.id);
}

function subjectFromClaimText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Unresolved claim candidate";
  const first = trimmed.split(/[.:;\n]/)[0]?.trim();
  return clampText(first || trimmed, 180) || "Unresolved claim candidate";
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const item = stringValue(value[key]);
    if (item) return item;
  }
  return null;
}

function numericValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.min(1, Math.max(0, value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.min(1, Math.max(0, parsed));
  }
  return fallback;
}

function titleForPacket(count: number): string {
  return `Claim Candidate Packet: ${count} candidate${count === 1 ? "" : "s"}`;
}

function summaryForPacket(candidates: readonly ClaimCandidateAction[]): string {
  const claimCreates = candidates.filter((candidate) => candidate.proposed_action?.proposal_type === "claim_create").length;
  const objectRelations = candidates.filter((candidate) => candidate.proposed_action?.proposal_type === "object_relation_create").length;
  const notes = candidates.filter((candidate) => candidate.proposed_action === null).length;
  return `Review ${candidates.length} claim candidate(s): ${claimCreates} claim proposal(s), ${objectRelations} object relation proposal(s), ${notes} review note(s).`;
}


function normalizedOwner(ownerUserId: string): string {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error("claim candidate packets require owner_user_id");
  return owner;
}

function cleanRecord<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value.trim()) out.add(value.trim());
  }
  return [...out];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerValue(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function clampText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function shortTitle(value: string): string {
  return clampText(value, 96);
}

class ClaimCandidatePacketApplyError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = "ClaimCandidatePacketApplyError";
  }
}
