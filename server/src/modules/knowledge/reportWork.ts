import * as protocol from "@rainver/protocol";

import {HttpError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from "../routeUtils/common.js";

import {RetrievalMaintenanceService,buildRetrievalEvalDiagnosticsReportWithSources,createRetrievalDiagnosticsProposalPacket,createRetrievalMaintenanceProposalPacket,persistRetrievalEvalReportArtifact,persistRetrievalCalibrationDecisionArtifact,persistRetrievalMaintenanceReportArtifact} from "../retrieval/index.js";
import {createClaimCandidatePacketFromArtifacts} from "./claimCandidatePackets.js";
import {scanClaimContradictions} from "./claimReviewLoop.js";
import {persistClaimContradictionReportArtifact} from "./claimReviewLoopArtifacts.js";
import {runRelationDiscoveryScan} from "./relationDiscovery.js";
import {createRelationDiscoveryProposalPacket,persistRelationDiscoveryReportArtifact} from "./relationDiscoveryArtifacts.js";
import {persistObjectSchemaSuggestionReportArtifact,scanObjectSchemaSuggestions} from "../ontology/objectSchemaSuggestions.js";
import {readSpaceRetrievalSettings} from "../retrieval/settings.js";
import {canReviewSpaceOpsPackets} from "../contextOps/reviewPolicy.js";
import {knowledgeRetrievalRegistry} from "./retrievalAdapter.js";

/** DB-only report work. Transport and idempotency receipts never carry report bodies. */
export async function runKnowledgeReport(db: Queryable, identity: SpaceUserIdentity, operation: string, raw: unknown): Promise<unknown> {
 switch(operation) {
case 'knowledge.maintenance.scan': {
      const body = protocol.RetrievalMaintenanceScanRequestSchema.parse(raw);
      const reviewScope = body.review_scope ?? "private";
      if (reviewScope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(db, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const pool = db;
      const report = await new RetrievalMaintenanceService(
        pool,
        knowledgeRetrievalRegistry,
      ).scan(identity.spaceId, identity.userId);
      let artifactId: string | undefined;
      let proposalId: string | undefined;
      if (body.persist_report || body.create_packet) {
        const settings = await readSpaceRetrievalSettings(pool, identity.spaceId);
        const contextInput = {
          spaceId: identity.spaceId,
          ownerUserId: identity.userId,
          report,
          source: "knowledge_retrieval_maintenance",
          settingsSnapshot: {
            default_search_mode: settings.defaultSearchMode,
            rerank_enabled: settings.rerankEnabled,
            query_rewrite_enabled: settings.queryRewriteEnabled,
            use_query_cache: settings.useQueryCache,
            include_trace: settings.includeTrace,
            external_egress_enabled: settings.externalEgressEnabled,
            retrieval_tool_mode: settings.retrievalToolMode,
            embedding_dimensions: settings.embeddingDimensions,
            max_results_default: settings.maxResultsDefault,
          },
          reviewScope,
        };
        const persisted = await withQueryableTransaction(pool, async (client) => {
          const reportArtifactId = await persistRetrievalMaintenanceReportArtifact(client, contextInput);
          const packetProposalId = body.create_packet
            ? await createRetrievalMaintenanceProposalPacket(client, {
                ...contextInput,
                artifactId: reportArtifactId,
              })
            : undefined;
          return { artifactId: reportArtifactId, proposalId: packetProposalId };
        });
        artifactId = persisted.artifactId;
        proposalId = persisted.proposalId;
      }
      return ({
        ...report,
        ...(artifactId ? { artifact_id: artifactId } : {}),
        ...(proposalId ? { proposal_id: proposalId } : {}),
      });

    }
case 'knowledge.eval.report': {
      const body = protocol.RetrievalEvalReportRequestSchema.parse(raw);
      const pool = db;
      const settings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const artifactId = await persistRetrievalEvalReportArtifact(pool, {
        spaceId: identity.spaceId,
        ownerUserId: identity.userId,
        report: body,
        settingsSnapshot: {
          default_search_mode: settings.defaultSearchMode,
          rerank_enabled: settings.rerankEnabled,
          query_rewrite_enabled: settings.queryRewriteEnabled,
          use_query_cache: settings.useQueryCache,
          include_trace: settings.includeTrace,
          external_egress_enabled: settings.externalEgressEnabled,
          retrieval_tool_mode: settings.retrievalToolMode,
          embedding_dimensions: settings.embeddingDimensions,
          max_results_default: settings.maxResultsDefault,
        },
      });
      return ({ artifact_id: artifactId });

    }
case 'knowledge.eval.calibration.record': {
      const body = protocol.RetrievalCalibrationDecisionRequestSchema.parse(raw);
      const reviewScope = body.review_scope ?? "private";
      const pool = db;
      if (reviewScope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const settings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const artifactId = await persistRetrievalCalibrationDecisionArtifact(pool, {
        spaceId: identity.spaceId,
        ownerUserId: identity.userId,
        request: body,
        settingsSnapshot: {
          default_search_mode: settings.defaultSearchMode,
          rerank_enabled: settings.rerankEnabled,
          query_rewrite_enabled: settings.queryRewriteEnabled,
          use_query_cache: settings.useQueryCache,
          include_trace: settings.includeTrace,
          external_egress_enabled: settings.externalEgressEnabled,
          retrieval_tool_mode: settings.retrievalToolMode,
          embedding_dimensions: settings.embeddingDimensions,
          max_results_default: settings.maxResultsDefault,
          ranking_behavior_changed: false,
        },
      });
      return ({
        artifact_id: artifactId,
        decision_count: body.decisions.length,
      });

    }
case 'knowledge.eval.diagnostics.report': {
      const body = protocol.RetrievalEvalDiagnosticsReportRequestSchema.parse(raw);
      const reviewScope = body.review_scope ?? "private";
      if (reviewScope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(db, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const pool = db;
      const settings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const generated = await buildRetrievalEvalDiagnosticsReportWithSources(pool, {
        spaceId: identity.spaceId,
        ownerUserId: identity.userId,
        windowDays: body.window_days,
        limit: body.limit,
        reportLabel: body.report_label,
        includeMaintenanceReports: body.include_maintenance_reports,
        comparePreviousWindow: body.compare_previous_window,
      });
      const report = protocol.RetrievalEvalReportRequestSchema.parse(generated.report);
      const sourceArtifactIds = generated.sourceArtifactIds;
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
      const persisted = body.create_packet
        ? await withQueryableTransaction(pool, async (client) => {
            const artifactId = await persistRetrievalEvalReportArtifact(client, {
              spaceId: identity.spaceId,
              ownerUserId: identity.userId,
              report,
              settingsSnapshot,
              reviewScope,
              sourceArtifactIds,
            });
            const proposalId = await createRetrievalDiagnosticsProposalPacket(client, {
              spaceId: identity.spaceId,
              ownerUserId: identity.userId,
              artifactId,
              report,
              settingsSnapshot,
              reviewScope,
            });
            return { artifactId, proposalId };
          })
        : {
            artifactId: await persistRetrievalEvalReportArtifact(pool, {
              spaceId: identity.spaceId,
              ownerUserId: identity.userId,
              report,
              settingsSnapshot,
              reviewScope,
              sourceArtifactIds,
            }),
            proposalId: undefined,
          };
      return ({
        artifact_id: persisted.artifactId,
        ...(persisted.proposalId ? { proposal_id: persisted.proposalId } : {}),
        counts: report.counts,
        diagnostic_codes: report.diagnostic_codes,
        source_artifact_ids: sourceArtifactIds,
      });

    }
case 'knowledge.claim.candidate_packet.create': {
      const body = protocol.ClaimCandidatePacketCreateRequestSchema.parse(raw);
      if (body.review_scope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(db, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const result = await withQueryableTransaction(db, async (client) =>
        createClaimCandidatePacketFromArtifacts(client, {
          spaceId: identity.spaceId,
          ownerUserId: identity.userId,
          request: body,
        }));
      return ({
        artifact_id: result.artifactId,
        proposal_id: result.proposalId,
        candidate_count: result.candidateCount,
        source_artifact_count: result.sourceArtifactCount,
        generated_child_proposal_count: result.generatedChildProposalCount,
      });

    }
case 'knowledge.claim.contradictions.scan': {
      const body = protocol.ClaimContradictionScanRequestSchema.parse(raw);
      rejectUnavailableLlmFlag(body.llm_judge_enabled, "llm_judge_enabled", "Claim contradiction LLM judge");
      const pool = db;
      if (body.review_scope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const report = await scanClaimContradictions(pool, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        subjectObjectId: body.subject_object_id ?? null,
        limit: body.limit,
        maxFindings: body.max_findings,
        llmJudgeEnabled: body.llm_judge_enabled,
      });
      const persisted = await withQueryableTransaction(pool, async (client) => {
        const artifactId = await persistClaimContradictionReportArtifact(client, {
          spaceId: identity.spaceId,
          ownerUserId: identity.userId,
          report,
          reviewScope: body.review_scope,
          scanOptions: {
            subject_object_id: body.subject_object_id ?? null,
            limit: body.limit,
            max_findings: body.max_findings,
            llm_judge_enabled: body.llm_judge_enabled,
          },
        });
        if (!body.create_packet || report.findings.length === 0) {
          return { artifactId, packet: null as Awaited<ReturnType<typeof createClaimCandidatePacketFromArtifacts>> | null };
        }
        const packet = await createClaimCandidatePacketFromArtifacts(client, {
          spaceId: identity.spaceId,
          ownerUserId: identity.userId,
          request: {
            source_artifact_ids: [artifactId],
            max_candidates: body.max_findings,
            review_scope: body.review_scope,
            promote_private_sources_to_space_ops: false,
            private_source_promotion_confirmed: false,
          },
        });
        return { artifactId, packet };
      });
      return ({
        generated_at: new Date().toISOString(),
        space_id: identity.spaceId,
        report,
        artifact_id: persisted.artifactId,
        ...(persisted.packet
          ? {
              candidate_packet_proposal_id: persisted.packet.proposalId,
              candidate_packet_artifact_id: persisted.packet.artifactId,
              candidate_count: persisted.packet.candidateCount,
            }
          : {}),
        canonical_write_performed: false,
      });

    }
case 'knowledge.relation.discovery.scan': {
      const body = protocol.RelationDiscoveryScanRequestSchema.parse(raw);
      rejectUnavailableLlmFlag(body.llm_extraction_enabled, "llm_extraction_enabled", "Relation discovery LLM extraction");
      const pool = db;
      if (body.review_scope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const { report } = await runRelationDiscoveryScan(pool, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        request: body,
      });
      const persisted = await withQueryableTransaction(pool, async (client) => {
        const artifactId = await persistRelationDiscoveryReportArtifact(client, {
          spaceId: identity.spaceId,
          ownerUserId: identity.userId,
          report,
          reviewScope: body.review_scope,
          scanOptions: {
            source_object_types: body.source_object_types ?? ["knowledge_item", "note", "activity", "artifact"],
            limit: body.limit,
            max_candidates: body.max_candidates,
            include_unresolved_item_candidates: body.include_unresolved_item_candidates,
            llm_extraction_enabled: body.llm_extraction_enabled,
            llm_max_sources: body.llm_max_sources,
          },
        });
        const proposalId = body.create_packet && report.candidates.length > 0
          ? await createRelationDiscoveryProposalPacket(client, {
              spaceId: identity.spaceId,
              ownerUserId: identity.userId,
              artifactId,
              report,
              reviewScope: body.review_scope,
            })
          : undefined;
        return { artifactId, proposalId };
      });
      return ({
        generated_at: new Date().toISOString(),
        space_id: identity.spaceId,
        report,
        artifact_id: persisted.artifactId,
        ...(persisted.proposalId ? { proposal_id: persisted.proposalId } : {}),
        candidate_count: report.candidates.length,
        proposal_candidate_count: relationProposalCandidateCount(report),
        review_only_candidate_count: relationReviewOnlyCandidateCount(report),
        canonical_write_performed: false,
      });

    }
case 'knowledge.object_schema.suggestions.scan': {
      const body = protocol.ObjectSchemaSuggestionScanRequestSchema.parse(raw);
      const pool = db;
      if (body.review_scope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const report = await scanObjectSchemaSuggestions(pool, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        request: body,
      });
      const artifactId = body.persist_artifact
        ? await persistObjectSchemaSuggestionReportArtifact(pool, {
            spaceId: identity.spaceId,
            ownerUserId: identity.userId,
            report,
            request: body,
          })
        : undefined;
      return ({
        report,
        finding_count: report.findings.length,
        ...(artifactId ? { artifact_id: artifactId } : {}),
      });

    }
 default: throw new HttpError(422,'Unknown report operation');
 }
}
function rejectUnavailableLlmFlag(enabled: boolean | undefined, field: string, feature: string): void {
  if (!enabled) return;
  throw new HttpError(
    422,
    `${feature} provider adapter is not available on this route yet; omit ${field} or set it to false.`,
  );
}

function relationProposalCandidateCount(report: { candidates: Array<{ proposed_action?: unknown }> }): number {
  return report.candidates.filter((candidate) => candidate.proposed_action != null).length;
}

function relationReviewOnlyCandidateCount(report: { candidates: Array<{ proposed_action?: unknown }> }): number {
  return report.candidates.filter((candidate) => candidate.proposed_action == null).length;
}
