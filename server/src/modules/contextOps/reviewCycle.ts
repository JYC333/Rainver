import { randomUUID } from "node:crypto";
import type { ContextReviewCycleRequest } from "@agent-space/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import { visibilityForReviewScope } from "../proposals/reviewPackets.js";
import { createClaimCandidatePacketFromArtifacts } from "../knowledge/claimCandidatePackets.js";
import { knowledgeRetrievalRegistry } from "../knowledge/retrievalAdapter.js";
import { MemoryMaintenanceService } from "../memory/maintenance.js";
import {
  createMemoryMaintenanceProposalPacket,
  persistMemoryMaintenanceReportArtifact,
} from "../memory/maintenanceArtifacts.js";
import { PgMemoryReadRepository } from "../memory/repository.js";
import {
  RetrievalMaintenanceService,
  buildRetrievalEvalDiagnosticsReport,
  createRetrievalDiagnosticsProposalPacket,
  createRetrievalMaintenanceProposalPacket,
  persistRetrievalEvalReportArtifact,
  persistRetrievalMaintenanceReportArtifact,
} from "../retrieval/index.js";
import { readSpaceRetrievalSettings } from "../retrieval/settings.js";
import { ContextOpsService } from "./service.js";

export const CONTEXT_REVIEW_CYCLE_REPORT_ARTIFACT_TYPE = "context_review_cycle_report";

export interface ContextReviewCycleWarning {
  stage: string;
  error_code: string;
  message: string;
}

interface OptionalPacketError {
  error_code: string;
  error_message: string;
}

export interface ContextReviewCycleResult {
  artifact_id: string;
  review_scope: "private" | "space_ops";
  retrieval_maintenance: {
    artifact_id: string;
    proposal_id: string | null;
    finding_count: number;
    counts: Record<string, number>;
    scanned: number;
    truncated: boolean;
    error_code?: string;
    error_message?: string;
  };
  diagnostics: {
    artifact_id: string;
    proposal_id: string | null;
    diagnostic_codes: string[];
    counts: Record<string, number>;
    error_code?: string;
    error_message?: string;
  };
  memory_maintenance: {
    artifact_id: string | null;
    proposal_id: string | null;
    finding_count: number;
    counts: Record<string, number>;
    scanned: number;
    truncated: boolean;
    error_code?: string;
    error_message?: string;
  };
  claim_candidates: {
    artifact_id: string | null;
    proposal_id: string | null;
    candidate_count: number;
    generated_child_proposal_count: number;
    error_code?: string;
    error_message?: string;
  };
  source_health: Record<string, unknown>;
  projection_freshness: Record<string, unknown>;
  embedding_backlog: Record<string, unknown>;
  degraded: boolean;
  warnings: ContextReviewCycleWarning[];
  canonical_write_performed: false;
}

export async function runContextReviewCycle(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    request: ContextReviewCycleRequest;
    runId?: string | null;
  },
): Promise<ContextReviewCycleResult> {
  const reviewScope = input.request.review_scope;
  const warnings: ContextReviewCycleWarning[] = [];
  const settings = await readSpaceRetrievalSettings(db, input.spaceId);
  const settingsSnapshot = {
    default_search_mode: settings.defaultSearchMode,
    rerank_enabled: settings.rerankEnabled,
    query_rewrite_enabled: settings.queryRewriteEnabled,
    use_query_cache: settings.useQueryCache,
    include_trace: settings.includeTrace,
    external_egress_enabled: settings.externalEgressEnabled,
    retrieval_tool_mode: settings.retrievalToolMode,
    embedding_dimensions: settings.embeddingDimensions,
    max_results_default: settings.maxResultsDefault,
  };

  const summary = await new ContextOpsService(db).getSummary({
    spaceId: input.spaceId,
    userId: input.userId,
    windowDays: input.request.window_days,
    limit: input.request.artifact_limit,
    includeSpaceOpsReports: reviewScope === "space_ops",
  });

  const retrievalReport = await new RetrievalMaintenanceService(
    db,
    knowledgeRetrievalRegistry,
  ).scan(input.spaceId, input.userId);
  const retrievalArtifactId = await persistRetrievalMaintenanceReportArtifact(db, {
    spaceId: input.spaceId,
    ownerUserId: input.userId,
    runId: input.runId ?? null,
    report: retrievalReport,
    source: "context_ops_review_cycle",
    settingsSnapshot,
    reviewScope,
  });
  let retrievalProposalId: string | null = null;
  let retrievalProposalError: OptionalPacketError | null = null;
  if (input.request.create_packets) {
    const step = await captureOptionalCheckpoint(warnings, "retrieval_maintenance_packet", () =>
      createRetrievalMaintenanceProposalPacket(db, {
        spaceId: input.spaceId,
        ownerUserId: input.userId,
        runId: input.runId ?? null,
        report: retrievalReport,
        source: "context_ops_review_cycle",
        settingsSnapshot,
        reviewScope,
        artifactId: retrievalArtifactId,
      }));
    retrievalProposalId = step.value;
    retrievalProposalError = step.error;
  }

  let memoryArtifactId: string | null = null;
  let memoryProposalId: string | null = null;
  let memoryProposalError: OptionalPacketError | null = null;
  let memoryReportSummary = {
    finding_count: 0,
    counts: {} as Record<string, number>,
    scanned: 0,
    truncated: false,
  };
  if (input.request.include_memory_maintenance) {
    const memoryScan = await new MemoryMaintenanceService(db).scan({
      spaceId: input.spaceId,
      userId: input.userId,
      limit: input.request.memory_limit,
      staleAfterDays: input.request.memory_stale_after_days,
      thinContentChars: input.request.memory_thin_content_chars,
      maxFindings: input.request.memory_max_findings,
    });
    const scanOptions = {
      limit: input.request.memory_limit,
      stale_after_days: input.request.memory_stale_after_days,
      thin_content_chars: input.request.memory_thin_content_chars,
      max_findings: input.request.memory_max_findings,
      source: "context_ops_review_cycle",
    };
    memoryArtifactId = await persistMemoryMaintenanceReportArtifact(db, {
      spaceId: input.spaceId,
      ownerUserId: input.userId,
      report: memoryScan.report,
      scanOptions,
      reviewScope,
    });
    if (input.request.create_packets) {
      const createdMemoryArtifactId = memoryArtifactId;
      const step = await captureOptionalCheckpoint(warnings, "memory_maintenance_packet", () =>
        createMemoryMaintenanceProposalPacket(db, {
          spaceId: input.spaceId,
          ownerUserId: input.userId,
          report: memoryScan.report,
          scanOptions,
          reviewScope,
          artifactId: createdMemoryArtifactId,
        }));
      memoryProposalId = step.value;
      memoryProposalError = step.error;
    }
    await new PgMemoryReadRepository(db).recordMaintenanceReads(
      memoryScan.contributingMemoryIds,
      input.spaceId,
      input.userId,
      memoryArtifactId,
    );
    memoryReportSummary = {
      finding_count: memoryScan.report.findings.length,
      counts: memoryScan.report.counts,
      scanned: memoryScan.report.scanned,
      truncated: memoryScan.report.truncated,
    };
  }

  const diagnosticsReport = await buildRetrievalEvalDiagnosticsReport(db, {
    spaceId: input.spaceId,
    ownerUserId: input.userId,
    windowDays: input.request.window_days,
    limit: input.request.artifact_limit,
    reportLabel: "Context Review Cycle diagnostics",
    includeMaintenanceReports: true,
    comparePreviousWindow: true,
  });
  const diagnosticsArtifactId = await persistRetrievalEvalReportArtifact(db, {
    spaceId: input.spaceId,
    ownerUserId: input.userId,
    report: diagnosticsReport,
    settingsSnapshot,
    reviewScope,
  });
  let diagnosticsProposalId: string | null = null;
  let diagnosticsProposalError: OptionalPacketError | null = null;
  if (input.request.create_packets) {
    const step = await captureOptionalCheckpoint(warnings, "retrieval_diagnostics_packet", () =>
      createRetrievalDiagnosticsProposalPacket(db, {
        spaceId: input.spaceId,
        ownerUserId: input.userId,
        artifactId: diagnosticsArtifactId,
        report: diagnosticsReport,
        settingsSnapshot,
        reviewScope,
      }));
    diagnosticsProposalId = step.value;
    diagnosticsProposalError = step.error;
  }

  const claimSourceArtifactIds = uniqueStrings([
    ...(reviewScope === "private" ? recentBriefArtifactIds(summary) : []),
    retrievalArtifactId,
    diagnosticsArtifactId,
    memoryArtifactId,
  ]).slice(0, 12);
  let claimPacket: Awaited<ReturnType<typeof createClaimCandidatePacketFromArtifacts>> | null = null;
  let claimPacketError: OptionalPacketError | null = null;
  if (input.request.create_packets && claimSourceArtifactIds.length > 0) {
    const step = await captureOptionalCheckpoint(warnings, "claim_candidate_packet", () =>
      createClaimCandidatePacketFromArtifacts(db, {
        spaceId: input.spaceId,
        ownerUserId: input.userId,
        request: {
          source_artifact_ids: claimSourceArtifactIds,
          max_candidates: input.request.max_claim_candidates,
          review_scope: reviewScope,
          promote_private_sources_to_space_ops: false,
        },
      }));
    claimPacket = step.value;
    claimPacketError = step.error;
  }

  const resultWithoutArtifact: Omit<ContextReviewCycleResult, "artifact_id"> = {
    review_scope: reviewScope,
    retrieval_maintenance: {
      artifact_id: retrievalArtifactId,
      proposal_id: retrievalProposalId,
      finding_count: retrievalReport.findings.length,
      counts: retrievalReport.counts,
      scanned: retrievalReport.scanned,
      truncated: retrievalReport.truncated,
      ...(retrievalProposalError ?? {}),
    },
    diagnostics: {
      artifact_id: diagnosticsArtifactId,
      proposal_id: diagnosticsProposalId,
      diagnostic_codes: diagnosticsReport.diagnostic_codes,
      counts: diagnosticsReport.counts,
      ...(diagnosticsProposalError ?? {}),
    },
    memory_maintenance: {
      artifact_id: memoryArtifactId,
      proposal_id: memoryProposalId,
      ...memoryReportSummary,
      ...(memoryProposalError ?? {}),
    },
    claim_candidates: {
      artifact_id: claimPacket?.artifactId ?? null,
      proposal_id: claimPacket?.proposalId ?? null,
      candidate_count: claimPacket?.candidateCount ?? 0,
      generated_child_proposal_count: claimPacket?.generatedChildProposalCount ?? 0,
      ...(claimPacketError ?? {}),
    },
    source_health: summary.source_policy_warnings,
    projection_freshness: summary.index_freshness,
    embedding_backlog: summary.embedding_backlog,
    degraded: warnings.length > 0,
    warnings,
    canonical_write_performed: false,
  };
  const artifactId = await persistContextReviewCycleReportArtifact(db, {
    spaceId: input.spaceId,
    ownerUserId: input.userId,
    runId: input.runId ?? null,
    reviewScope,
    result: resultWithoutArtifact,
  });
  return { artifact_id: artifactId, ...resultWithoutArtifact };
}

async function captureOptionalCheckpoint<T>(
  warnings: ContextReviewCycleWarning[],
  stage: string,
  run: () => Promise<T>,
): Promise<{ value: T | null; error: OptionalPacketError | null }> {
  try {
    return { value: await run(), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = `${stage}_failed`;
    warnings.push({ stage, error_code: errorCode, message });
    return {
      value: null,
      error: {
        error_code: errorCode,
        error_message: message,
      },
    };
  }
}

async function persistContextReviewCycleReportArtifact(
  db: Queryable,
  input: {
    spaceId: string;
    ownerUserId: string;
    runId: string | null;
    reviewScope: "private" | "space_ops";
    result: Omit<ContextReviewCycleResult, "artifact_id">;
  },
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const payload = {
    kind: CONTEXT_REVIEW_CYCLE_REPORT_ARTIFACT_TYPE,
    version: 1,
    artifact_id: id,
    space_id: input.spaceId,
    owner_user_id: input.ownerUserId,
    run_id: input.runId,
    generated_at: now,
    ...input.result,
    access_safety: {
      aggregate_or_review_refs_only: true,
      raw_private_content_included: false,
      canonical_write_performed: false,
    },
  };
  return insertArtifactRow(db, {
    id,
    spaceId: input.spaceId,
    ownerUserId: input.ownerUserId,
    artifactType: CONTEXT_REVIEW_CYCLE_REPORT_ARTIFACT_TYPE,
    title: "Context Review Cycle Report",
    content: JSON.stringify(payload, null, 2),
    metadata: payload,
    canonicalFormat: "context_review_cycle_report.v1",
    visibility: visibilityForReviewScope(input.reviewScope),
    runId: input.runId,
    createdAt: now,
  });
}

function recentBriefArtifactIds(summary: { recent_context_briefs?: unknown }): string[] {
  const briefs = Array.isArray(summary.recent_context_briefs) ? summary.recent_context_briefs : [];
  return briefs
    .map((brief) => {
      if (!brief || typeof brief !== "object" || Array.isArray(brief)) return null;
      const id = (brief as Record<string, unknown>).artifact_id;
      return typeof id === "string" && id.trim() ? id.trim() : null;
    })
    .filter((id): id is string => Boolean(id));
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value.trim()) out.add(value.trim());
  }
  return [...out];
}
