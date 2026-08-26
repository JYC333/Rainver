export { RetrievalProjectionService, objectRefKey } from "./projectionService.js";
export { RetrievalSearchService } from "./searchService.js";
export type { RetrievalSearchServiceOptions } from "./searchService.js";
export {
  RetrievalFeedbackService,
  DEFAULT_RETRIEVAL_FEEDBACK,
  feedbackBoostMultiplier,
  retrievalFeedbackQueryHash,
} from "./feedback.js";
export type {
  FeedbackEventRow,
  RetrievalFeedbackBoostInput,
  RetrievalFeedbackConfig,
  RetrievalFeedbackRecordInput,
} from "./feedback.js";
export { RetrievalEmbeddingStore, toVectorLiteral } from "./embeddingStore.js";
export type { PendingChunk } from "./embeddingStore.js";
export {
  applyRerank,
  rerankWindowSize,
  DEFAULT_RERANK_CONFIG,
} from "./reranker.js";
export type {
  Reranker,
  RerankCandidate,
  RerankConfig,
  RerankScore,
} from "./reranker.js";
export { mergeRewriteVariants, MAX_REWRITE_VARIANTS } from "./queryRewrite.js";
export type { QueryRewriter } from "./queryRewrite.js";
export {
  assembleBrief,
  buildBriefCandidates,
  DEFAULT_SYNTHESIS_CONFIG,
} from "./synthesis.js";
export {
  buildRetrievalBriefArtifactSpec,
  persistRetrievalBriefArtifact,
  RETRIEVAL_BRIEF_ARTIFACT_TYPE,
} from "./artifacts/brief.js";
export type {
  RetrievalBriefArtifactContext,
  RetrievalBriefArtifactSpec,
} from "./artifacts/brief.js";
export type {
  BriefCandidate,
  SynthesisConfig,
  SynthesisResult,
  Synthesizer,
} from "./synthesis.js";
export { classifyIntent, rankingConfigForIntent } from "./intent.js";
export type { RetrievalIntent } from "./intent.js";
export { parseRelationalIntent } from "./relationalIntent.js";
export type { RelationalIntent, RelationalIntentKind } from "./relationalIntent.js";
export {
  RetrievalMaintenanceService,
  DEFAULT_MAINTENANCE_CONFIG,
} from "./maintenance/service.js";
export {
  createRetrievalMaintenanceProposalPacket,
  persistRetrievalMaintenanceReportArtifact,
  registerRetrievalMaintenanceProposalAppliers,
  RETRIEVAL_MAINTENANCE_PACKET_PROPOSAL_TYPE,
  RETRIEVAL_MAINTENANCE_REPORT_ARTIFACT_TYPE,
} from "./maintenance/artifacts.js";
export type { RetrievalMaintenanceReportContext } from "./maintenance/artifacts.js";
export {
  buildRetrievalEvalReportArtifactSpec,
  persistRetrievalEvalReportArtifact,
  RETRIEVAL_EVAL_REPORT_ARTIFACT_TYPE,
} from "./artifacts/eval.js";
export {
  persistRetrievalCalibrationDecisionArtifact,
  RETRIEVAL_CALIBRATION_DECISION_ARTIFACT_TYPE,
  RetrievalCalibrationDecisionError,
} from "./artifacts/calibration.js";
export {
  buildRetrievalEvalDiagnosticsReport,
  buildRetrievalEvalDiagnosticsReportFromArtifactMetadata,
  buildRetrievalEvalDiagnosticsReportFromMetadata,
} from "./evalDiagnostics.js";
export {
  createRetrievalDiagnosticsProposalPacket,
  registerRetrievalDiagnosticsProposalAppliers,
  RETRIEVAL_DIAGNOSTICS_PACKET_PROPOSAL_TYPE,
} from "./artifacts/diagnostics.js";
export {
  persistRetrievalExplainReportArtifact,
  RETRIEVAL_EXPLAIN_REPORT_ARTIFACT_TYPE,
} from "./artifacts/explain.js";
export type {
  RetrievalEvalReportArtifactContext,
  RetrievalEvalReportArtifactSpec,
} from "./artifacts/eval.js";
export type {
  MaintenanceConfig,
  MaintenanceFinding,
  MaintenanceFindingKind,
  MaintenanceObjectRef,
  MaintenanceReport,
} from "./maintenance/service.js";
export { RetrievalRegistry } from "./registry.js";
export type { RetrievalDomainAdapter } from "./registry.js";
export {
  normalizeAlias,
  normalizeSlugCandidate,
  normalizeTextForSearch,
  stripMarkdownForSearch,
  tokenizeSimple,
  excerptAroundQuery,
} from "./normalize.js";
export { extractRetrievalLinks } from "./linkExtractor.js";
export type { ExtractedRetrievalLink } from "./linkExtractor.js";
export {
  loadSourceConnectionIdsForTargets,
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourceConnectionIdsFromJson,
  sourceConnectionIdsFromMetadata,
  sourceConnectionIdsFromSourceRefs,
  sourceEgressPoliciesForSnapshots,
  sourcePolicyAllowsRead,
} from "./sourcePolicy.js";
export type { SourcePolicySnapshot, SourceReadContext } from "./sourcePolicy.js";
export * from "./types.js";
