import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type {
  RetrievalBriefRequest,
  ClaimCandidatePacketCreateRequest,
  ClaimContradictionScanRequest,
  ClaimTrajectoryRequest,
  RelationDiscoveryScanRequest,
  ObjectSchemaImportRequest,
  ObjectSchemaSuggestionScanRequest,
  SpaceObjectProfileCreateProposalRequest,
  SpaceObjectProfileListRequest,
  SpaceObjectProfileStatusProposalRequest,
  SpaceObjectProfileUpdateProposalRequest,
  RetrievalCalibrationDecisionRequest,
  RetrievalCreateSafetyRequest,
  RetrievalEvalDiagnosticsReportRequest,
  RetrievalEvalReportRequest,
  RetrievalExplainRequest,
  RetrievalFeedbackRequest,
  RetrievalMaintenanceScanRequest,
  RetrievalSearchRequest,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  csvQuery,
  dbPool,
  HttpError,
  jsonBody,
  numberValue,
  optionalString,
  parsePage,
  params,
  query,
  requiredString,
  resolveIdentity,
  sendRouteError,
  withDbTransaction,
} from "../routeUtils/common.js";
import { requireSpaceOwnerOrAdmin } from "../routeUtils/access.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";
import {
  applyContentCreationContext,
  resolveContentCreationContext,
} from "../access/creationContext.js";
import { authRepositoryFromConfig } from "../auth/identity.js";
import { PgKnowledgeRepository } from "./repository.js";
import { parseNotesTreeReorder, persistNotesTreeReorder } from "./notesTreeReorder.js";
import {
  RetrievalFeedbackService,
  RetrievalMaintenanceService,
  RetrievalProjectionService,
  RetrievalSearchService,
  buildRetrievalEvalDiagnosticsReport,
  createRetrievalDiagnosticsProposalPacket,
  createRetrievalMaintenanceProposalPacket,
  persistRetrievalEvalReportArtifact,
  persistRetrievalCalibrationDecisionArtifact,
  persistRetrievalExplainReportArtifact,
  persistRetrievalMaintenanceReportArtifact,
  persistRetrievalBriefArtifact,
} from "../retrieval/index.js";
import { createClaimCandidatePacketFromArtifacts } from "./claimCandidatePackets.js";
import { buildClaimTrajectory, scanClaimContradictions } from "./claimReviewLoop.js";
import { persistClaimContradictionReportArtifact } from "./claimReviewLoopArtifacts.js";
import { runRelationDiscoveryScan } from "./relationDiscovery.js";
import {
  createRelationDiscoveryProposalPacket,
  persistRelationDiscoveryReportArtifact,
} from "./relationDiscoveryArtifacts.js";
import {
  persistObjectSchemaSuggestionReportArtifact,
  scanObjectSchemaSuggestions,
} from "../ontology/objectSchemaSuggestions.js";
import { readSpaceRetrievalSettings, resolveRetrievalSearchControls } from "../retrieval/settings.js";
import { canInitiateContextOpsScan, canReviewSpaceOpsPackets } from "../contextOps/reviewPolicy.js";
import { enqueueRetrievalEmbeddingBackfill } from "../retrieval/embedding/job.js";
import { ProviderQueryEmbedder } from "../retrieval/embedding/queryEmbedder.js";
import { ProviderReranker } from "../retrieval/rerankProvider/providerReranker.js";
import { ProviderQueryRewriter } from "../retrieval/queryRewriteProvider/providerQueryRewriter.js";
import { ProviderSynthesizer } from "../retrieval/synthesisProvider/providerSynthesizer.js";
import { resolveProviderCommandStore } from "../providers/commands/store.js";
import { knowledgeRetrievalRegistry } from "./retrievalAdapter.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new PgKnowledgeRepository(dbPool(context.config));

  app.get("/api/v1/knowledge", knowledgeHealth(context));
  app.get("/api/v1/knowledge/", knowledgeHealth(context));

  app.get("/api/v1/knowledge/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().summary(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/search", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseRetrievalSearchBody(protocol.RetrievalSearchRequestSchema, jsonBody(request));
      const pool = dbPool(context.config);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const controls = resolveRetrievalSearchControls(body, retrievalSettings);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
        egressPolicy,
        // Vector recall arm; provider egress is checked at invocation time, so
        // local providers remain usable when external egress is disabled.
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          retrievalSettings.embeddingDimensions,
          egressPolicy,
        ),
        feedbackService: new RetrievalFeedbackService(pool, knowledgeRetrievalRegistry),
        // Reranker is off unless this space enables it; degrades to the fused order otherwise.
        reranker: retrievalSettings.rerankEnabled
          ? new ProviderReranker(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "knowledge_search",
              egressPolicy,
            })
          : undefined,
        // Query rewriter is off unless this space enables it; degrades to the original query.
        queryRewriter: retrievalSettings.queryRewriteEnabled
          ? new ProviderQueryRewriter(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "knowledge_search",
              egressPolicy,
            })
          : undefined,
      });
      return reply.send(await search.search({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        query: body.query,
        objectTypes: body.object_types,
        objectProfiles: body.object_profiles,
        maxResults: controls.maxResults,
        includeTrace: controls.includeTrace,
        feedbackSurface: "knowledge_search",
        mode: controls.mode,
        rewrite: controls.rewrite,
        useCache: controls.useCache,
        adaptiveReturn: controls.adaptiveReturn,
        rankingConfig: controls.rankingConfig,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/retrieval/brief", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseRetrievalBriefBody(protocol.RetrievalBriefRequestSchema, jsonBody(request));
      const pool = dbPool(context.config);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
        egressPolicy,
        // Same recall as search: vector arm + (space-gated) reranker pick the
        // sources the brief is built from. No query rewriter / feedback surface.
        // Provider egress is checked at invocation time, so local providers
        // remain usable when external egress is disabled.
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          retrievalSettings.embeddingDimensions,
          egressPolicy,
        ),
        reranker: retrievalSettings.rerankEnabled
          ? new ProviderReranker(store, { databaseUrl: context.config.databaseUrl, surface: "knowledge_brief", egressPolicy })
          : undefined,
        // Synthesis self-gates on a configured retrieval_synthesis task policy:
        // with none, the provider call fails and the brief degrades to the
        // deterministic gap analysis (no LLM answer).
        synthesizer: new ProviderSynthesizer(store, {
          databaseUrl: context.config.databaseUrl,
          surface: "knowledge_brief",
          egressPolicy,
        }),
      });
      const maxResults = body.max_results ?? retrievalSettings.maxResultsDefault;
      const includeTrace = body.include_trace ?? retrievalSettings.includeTrace;
      const mode = body.mode ?? retrievalSettings.defaultSearchMode;
      const adaptiveReturn = body.adaptive_return ?? resolveRetrievalSearchControls(body, retrievalSettings).adaptiveReturn;
      const response = await search.buildBrief({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        query: body.query,
        objectTypes: body.object_types,
        objectProfiles: body.object_profiles,
        maxResults,
        includeTrace,
        mode,
        useCache: retrievalSettings.useQueryCache,
        adaptiveReturn,
        rankingConfig: retrievalSettings.rankingConfig,
      });
      if (!body.persist_artifact) return reply.send(response);
      try {
        const artifactId = await persistRetrievalBriefArtifact(pool, {
          spaceId: identity.spaceId,
          ownerUserId: identity.userId,
          runId: null,
          projectId: null,
          query: body.query,
          objectTypes: body.object_types,
          objectProfiles: body.object_profiles,
          maxResults,
          includeTrace,
          mode,
          surface: "knowledge_brief",
          response,
          egressPolicySnapshot: {
            external_egress_enabled: retrievalSettings.externalEgressEnabled,
          },
          settingsSnapshot: {
            default_search_mode: retrievalSettings.defaultSearchMode,
            rerank_enabled: retrievalSettings.rerankEnabled,
            query_rewrite_enabled: retrievalSettings.queryRewriteEnabled,
            use_query_cache: retrievalSettings.useQueryCache,
            embedding_dimensions: retrievalSettings.embeddingDimensions,
            max_results_default: retrievalSettings.maxResultsDefault,
            ranking_config: retrievalSettings.rankingConfig,
          },
        });
        return reply.send({ ...response, artifact_id: artifactId });
      } catch (error) {
        request.log.warn(
          { err: error },
          "retrieval brief artifact persistence failed",
        );
        return reply.send({ ...response, artifact_error: "retrieval_brief_persist_failed" });
      }
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/retrieval/feedback", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseRetrievalFeedbackBody(protocol.RetrievalFeedbackRequestSchema, jsonBody(request));
      if (!knowledgeRetrievalRegistry.objectTypes().includes(body.object_type)) {
        throw new HttpError(422, `knowledge feedback only supports ${knowledgeRetrievalRegistry.objectTypes().join(", ")}`);
      }
      const recorded = await new RetrievalFeedbackService(
        dbPool(context.config),
        knowledgeRetrievalRegistry,
      ).record({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        surface: "knowledge_search",
        query: body.query,
        objectType: body.object_type,
        objectId: body.object_id,
        signalType: body.signal_type,
        dwellMs: body.dwell_ms ?? null,
        metadata: body.metadata ?? null,
      });
      if (!recorded) return reply.code(404).send({ detail: "Retrieval result not found" });
      return reply.send({ ok: true });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/create-safety", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseRetrievalCreateSafetyBody(
        protocol.RetrievalCreateSafetyRequestSchema,
        jsonBody(request),
      );
      const search = new RetrievalSearchService(dbPool(context.config), knowledgeRetrievalRegistry);
      return reply.send(await search.assessCreateSafety({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        objectType: body.object_type,
        title: optionalString(body.title),
        slug: optionalString(body.slug),
        aliases: body.aliases ?? [],
        uri: optionalString(body.uri),
        excludeObjectId: optionalString(body.exclude_object_id),
        maxResults: body.max_results,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Rebuild the derived retrieval projection for the caller's space. Derived,
  // idempotent, space-scoped; used to backfill pre-existing objects and to
  // converge stale aliases, chunks, and retrieval edges from canonical data.
  // This is a maintenance operation, so it requires space owner/admin authority.
  app.post("/api/v1/knowledge/retrieval/reindex", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      const projection = new RetrievalProjectionService(dbPool(context.config), knowledgeRetrievalRegistry);
      const summary = await projection.reindexAll(identity.spaceId);
      const embeddingBackfill = await enqueueRetrievalEmbeddingBackfill(context.config, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        trigger: "knowledge_retrieval_reindex",
      }).catch((error) => {
        process.stderr.write(
          `[knowledge.retrieval] embedding backfill enqueue failed: ${String((error as Error)?.message ?? error)}\n`,
        );
        return null;
      });
      return reply.send({
        ok: true,
        reindexed: summary,
        embedding_backfill_job_id: embeddingBackfill?.jobId ?? null,
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Maintenance scan (W7 "context review cycle"): a read-only, batched report of review
  // candidates (duplicates, orphans, thin pages, suggested relations) over the
  // derived projection. It writes NOTHING canonical — acting on a finding stays
  // on the proposal/approval flow. Owner/admin only, and every finding is
  // revalidated through the same read gate as search (no private-title leak).
  // Member/reviewer initiation is allowed only when the Space Context Ops scan
  // setting opts into member scans.
  app.post("/api/v1/knowledge/retrieval/maintenance/scan", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireContextOpsScanRole(context.config, identity, reply))) return reply;
    try {
      const body = parseRetrievalMaintenanceScanBody(
        protocol.RetrievalMaintenanceScanRequestSchema,
        jsonBody(request),
      );
      const reviewScope = body.review_scope ?? "private";
      if (reviewScope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(dbPool(context.config), identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const pool = dbPool(context.config);
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
        const persisted = await withDbTransaction(pool, async (client) => {
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
      return reply.send({
        ...report,
        ...(artifactId ? { artifact_id: artifactId } : {}),
        ...(proposalId ? { proposal_id: proposalId } : {}),
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/retrieval/eval/report", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      const body = parseRetrievalEvalReportBody(
        protocol.RetrievalEvalReportRequestSchema,
        jsonBody(request),
      );
      const pool = dbPool(context.config);
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
      return reply.code(201).send({ artifact_id: artifactId });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/retrieval/eval/calibration-decisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireContextOpsScanRole(context.config, identity, reply))) return reply;
    try {
      const body = parseRetrievalCalibrationDecisionBody(
        protocol.RetrievalCalibrationDecisionRequestSchema,
        jsonBody(request),
      );
      const reviewScope = body.review_scope ?? "private";
      const pool = dbPool(context.config);
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
      return reply.code(201).send({
        artifact_id: artifactId,
        decision_count: body.decisions.length,
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/retrieval/eval/diagnostics/report", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireContextOpsScanRole(context.config, identity, reply))) return reply;
    try {
      const body = parseRetrievalEvalDiagnosticsReportBody(
        protocol.RetrievalEvalDiagnosticsReportRequestSchema,
        jsonBody(request),
      );
      const reviewScope = body.review_scope ?? "private";
      if (reviewScope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(dbPool(context.config), identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const pool = dbPool(context.config);
      const settings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const generatedReport = await buildRetrievalEvalDiagnosticsReport(pool, {
        spaceId: identity.spaceId,
        ownerUserId: identity.userId,
        windowDays: body.window_days,
        limit: body.limit,
        reportLabel: body.report_label,
        includeMaintenanceReports: body.include_maintenance_reports,
        comparePreviousWindow: body.compare_previous_window,
      });
      const report = parseRetrievalEvalReportBody(
        protocol.RetrievalEvalReportRequestSchema,
        generatedReport,
      );
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
        ? await withDbTransaction(pool, async (client) => {
            const artifactId = await persistRetrievalEvalReportArtifact(client, {
              spaceId: identity.spaceId,
              ownerUserId: identity.userId,
              report,
              settingsSnapshot,
              reviewScope,
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
            }),
            proposalId: undefined,
          };
      return reply.code(201).send({
        artifact_id: persisted.artifactId,
        ...(persisted.proposalId ? { proposal_id: persisted.proposalId } : {}),
        counts: report.counts,
        diagnostic_codes: report.diagnostic_codes,
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/claims/candidate-packets", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireContextOpsScanRole(context.config, identity, reply))) return reply;
    try {
      const body = parseClaimCandidatePacketCreateBody(
        protocol.ClaimCandidatePacketCreateRequestSchema,
        jsonBody(request),
      );
      if (body.review_scope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(dbPool(context.config), identity.spaceId, identity.userId);
        if (!allowed) {
          throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
        }
      }
      const result = await withDbTransaction(dbPool(context.config), async (client) =>
        createClaimCandidatePacketFromArtifacts(client, {
          spaceId: identity.spaceId,
          ownerUserId: identity.userId,
          request: body,
        }));
      return reply.code(201).send({
        artifact_id: result.artifactId,
        proposal_id: result.proposalId,
        candidate_count: result.candidateCount,
        source_artifact_count: result.sourceArtifactCount,
        generated_child_proposal_count: result.generatedChildProposalCount,
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Slice E: advisory claim trajectory. Read-only and viewer-gated (the service
  // only loads visible claims), so it needs no Context Ops scan authority.
  app.get("/api/v1/knowledge/claims/trajectory", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      // optionalString returns null for missing params, but the schema fields are
      // .optional() (undefined, not null), so only include keys that are present.
      const subjectObjectId = optionalString(q.subject_object_id);
      const claimId = optionalString(q.claim_id);
      const limit = optionalString(q.limit);
      const body = parseClaimTrajectoryBody(protocol.ClaimTrajectoryRequestSchema, {
        ...(subjectObjectId ? { subject_object_id: subjectObjectId } : {}),
        ...(claimId ? { claim_id: claimId } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
      const response = await buildClaimTrajectory(dbPool(context.config), {
        spaceId: identity.spaceId,
        userId: identity.userId,
        subjectObjectId: body.subject_object_id ?? null,
        claimId: body.claim_id ?? null,
        limit: body.limit,
      });
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Slice E: deterministic, access-safe contradiction-discovery scan. Gated by
  // Context Ops scan authority; optionally fans findings into a Claim Candidate
  // Packet so the only canonical write path stays the proposal-gated packet flow.
  app.post("/api/v1/knowledge/claims/contradiction-scan", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireContextOpsScanRole(context.config, identity, reply))) return reply;
    try {
      const body = parseClaimContradictionScanBody(
        protocol.ClaimContradictionScanRequestSchema,
        jsonBody(request),
      );
      rejectUnavailableLlmFlag(body.llm_judge_enabled, "llm_judge_enabled", "Claim contradiction LLM judge");
      const pool = dbPool(context.config);
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
      const persisted = await withDbTransaction(pool, async (client) => {
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
      return reply.code(201).send({
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
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Slice F: deterministic candidate-relation discovery scan. Gated by Context Ops
  // scan authority; emits a single batched proposal packet — never a direct edge
  // or item write.
  app.post("/api/v1/knowledge/relations/discovery-scan", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireContextOpsScanRole(context.config, identity, reply))) return reply;
    try {
      const body = parseRelationDiscoveryScanBody(
        protocol.RelationDiscoveryScanRequestSchema,
        jsonBody(request),
      );
      rejectUnavailableLlmFlag(body.llm_extraction_enabled, "llm_extraction_enabled", "Relation discovery LLM extraction");
      const pool = dbPool(context.config);
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
      const persisted = await withDbTransaction(pool, async (client) => {
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
      return reply.code(201).send({
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
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/retrieval/explain", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      const body = parseRetrievalExplainBody(
        protocol.RetrievalExplainRequestSchema,
        jsonBody(request),
      );
      if (!knowledgeRetrievalRegistry.objectTypes().includes(body.object_type)) {
        throw new HttpError(422, `knowledge retrieval explain only supports ${knowledgeRetrievalRegistry.objectTypes().join(", ")}`);
      }
      const pool = dbPool(context.config);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const controls = resolveRetrievalSearchControls(body, retrievalSettings);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, knowledgeRetrievalRegistry, {
        egressPolicy,
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          retrievalSettings.embeddingDimensions,
          egressPolicy,
        ),
        reranker: retrievalSettings.rerankEnabled
          ? new ProviderReranker(store, { databaseUrl: context.config.databaseUrl, surface: "knowledge_explain", egressPolicy })
          : undefined,
        queryRewriter: retrievalSettings.queryRewriteEnabled
          ? new ProviderQueryRewriter(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "knowledge_explain",
              egressPolicy,
            })
          : undefined,
      });
      const response = await search.explainTarget({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        query: body.query,
        objectTypes: body.object_types,
        maxResults: controls.maxResults,
        mode: controls.mode,
        rewrite: controls.rewrite,
        useCache: controls.useCache,
        adaptiveReturn: controls.adaptiveReturn,
        rankingConfig: controls.rankingConfig,
        targetObjectType: body.object_type,
        targetObjectId: body.object_id,
      });
      if (!response) return reply.code(404).send({ detail: "Retrieval target not found" });
      if (!body.persist_artifact) return reply.send(response);
      const artifactId = await persistRetrievalExplainReportArtifact(pool, {
        spaceId: identity.spaceId,
        ownerUserId: identity.userId,
        query: body.query,
        mode: controls.mode,
        maxResults: controls.maxResults,
        response,
        settingsSnapshot: {
          default_search_mode: retrievalSettings.defaultSearchMode,
          rerank_enabled: retrievalSettings.rerankEnabled,
          query_rewrite_enabled: retrievalSettings.queryRewriteEnabled,
          use_query_cache: retrievalSettings.useQueryCache,
          include_trace: retrievalSettings.includeTrace,
          external_egress_enabled: retrievalSettings.externalEgressEnabled,
          retrieval_tool_mode: retrievalSettings.retrievalToolMode,
          ranking_config: retrievalSettings.rankingConfig,
          embedding_dimensions: retrievalSettings.embeddingDimensions,
          max_results_default: retrievalSettings.maxResultsDefault,
        },
      });
      return reply.send({ ...response, artifact_id: artifactId });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/object-schema/profiles", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      const body = parseSpaceObjectProfileListRequest(protocol.SpaceObjectProfileListRequestSchema, {
        ...(optionalString(q.base_object_type) ? { base_object_type: optionalString(q.base_object_type) } : {}),
        ...(optionalString(q.status) ? { status: optionalString(q.status) } : {}),
        limit,
        offset,
      });
      return reply.send(
        await repository().listObjectProfiles(identity, {
          baseObjectType: body.base_object_type ?? null,
          status: body.status ?? null,
          limit: body.limit,
          offset: body.offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/object-schema/profiles/:profileId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const kind = await repository().getObjectProfile(identity, params(request).profileId ?? "");
      if (!kind) return reply.code(404).send({ detail: "Object kind not found" });
      return reply.send(kind);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/object-schema/export", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      return reply.send(await repository().exportObjectSchema(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/object-schema/imports/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      const body = parseObjectSchemaImportRequest(
        protocol.ObjectSchemaImportRequestSchema,
        jsonBody(request),
      );
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        wholeSpace: true,
      });
      const creationIdentity = { spaceId: creation.spaceId, userId: identity.userId };
      const result = await withDbTransaction(dbPool(context.config), (client) =>
        new PgKnowledgeRepository(client).importObjectSchemaManifest(creationIdentity, body),
      );
      return reply.code(202).send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/object-schema/suggestions/scan", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireContextOpsScanRole(context.config, identity, reply))) return reply;
    try {
      const body = parseObjectSchemaSuggestionScanRequest(
        protocol.ObjectSchemaSuggestionScanRequestSchema,
        jsonBody(request),
      );
      const pool = dbPool(context.config);
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
      return reply.send({
        report,
        finding_count: report.findings.length,
        ...(artifactId ? { artifact_id: artifactId } : {}),
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/object-schema/profiles/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      const body = parseSpaceObjectProfileCreateProposalRequest(
        protocol.SpaceObjectProfileCreateProposalRequestSchema,
        jsonBody(request),
      );
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        wholeSpace: true,
      });
      return reply.code(202).send(await repository().proposeObjectProfileCreate(
        { spaceId: creation.spaceId, userId: identity.userId },
        body,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/knowledge/object-schema/profiles/:profileId/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      const body = parseSpaceObjectProfileUpdateProposalRequest(
        protocol.SpaceObjectProfileUpdateProposalRequestSchema,
        jsonBody(request),
      );
      return reply
        .code(202)
        .send(await repository().proposeObjectProfileUpdate(identity, params(request).profileId ?? "", body));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/object-schema/profiles/:profileId/deprecate-proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      const body = parseSpaceObjectProfileStatusProposalRequest(
        protocol.SpaceObjectProfileStatusProposalRequestSchema,
        jsonBody(request),
      );
      return reply
        .code(202)
        .send(await repository().proposeObjectProfileDeprecate(identity, params(request).profileId ?? "", body));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/object-schema/profiles/:profileId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    try {
      const body = parseSpaceObjectProfileStatusProposalRequest(
        protocol.SpaceObjectProfileStatusProposalRequestSchema,
        jsonBody(request),
      );
      return reply
        .code(202)
        .send(await repository().proposeObjectProfileArchive(identity, params(request).profileId ?? "", body));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(
        await repository().listItems(identity, {
          knowledgeKind: optionalString(q.knowledge_kind),
          status: optionalString(q.status) ?? "active",
          visibility: optionalString(q.visibility),
          projectId: optionalString(q.project_id),
          projectFolderId: optionalString(q.project_folder_id),
          q: optionalString(q.q),
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/items/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.code(202).send(await repository().proposeCreate(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items/:itemId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const item = await repository().getItem(identity, params(request).itemId ?? "");
      if (!item) return reply.code(404).send({ detail: "Knowledge item not found" });
      return reply.send(item);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items/:itemId/relations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().itemRelations(identity, params(request).itemId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items/:itemId/backlinks", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().entityLinks(identity, {
          target_type: "knowledge_item",
          target_id: params(request).itemId ?? "",
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/knowledge/items/:itemId/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(202)
        .send(await repository().proposeUpdate(identity, params(request).itemId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/items/:itemId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(202)
        .send(await repository().proposeArchive(identity, params(request).itemId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/claims", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(
        await repository().listClaims(identity, {
          claimKind: optionalString(q.claim_kind),
          status: optionalString(q.status) ?? "active",
          subjectObjectId: optionalString(q.subject_object_id),
          q: optionalString(q.q),
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/claims/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.code(202).send(await repository().proposeClaimCreate(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/claims/:claimId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const claim = await repository().getClaim(identity, params(request).claimId ?? "");
      if (!claim) return reply.code(404).send({ detail: "Claim not found" });
      return reply.send(claim);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/claims/:claimId/sources", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().claimSources(identity, params(request).claimId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/claims/:claimId/relations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().claimRelations(identity, params(request).claimId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/knowledge/claims/:claimId/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(202)
        .send(await repository().proposeClaimUpdate(identity, params(request).claimId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/claims/:claimId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(202)
        .send(await repository().proposeClaimArchive(identity, params(request).claimId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/object-relations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().objectRelations(identity, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/object-relations/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(202).send(await repository().proposeObjectRelation(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/object-relations/:relationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(202)
        .send(await repository().proposeObjectRelationArchive(identity, params(request).relationId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/sources", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(
        await repository().listSources(identity, {
          sourceType: optionalString(q.source_type),
          status: optionalString(q.status),
          q: optionalString(q.q),
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/sources", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.code(201).send(await repository().createSource(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/sources/:sourceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const source = await repository().getSource(identity, params(request).sourceId ?? "");
      if (!source) return reply.code(404).send({ detail: "Source not found" });
      return reply.send(source);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/knowledge/sources/:sourceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().updateSource(identity, params(request).sourceId ?? "", jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/sources/:sourceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().archiveSource(identity, params(request).sourceId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/sources/:sourceId/items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listSourceItems(identity, params(request).sourceId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/items/:itemId/sources", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listItemSources(identity, params(request).itemId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/items/:itemId/sources", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository().createItemSource(identity, params(request).itemId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/items/:itemId/sources/:linkId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await repository().deleteItemSource(identity, params(request).itemId ?? "", params(request).linkId ?? "");
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/entity-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().entityLinks(identity, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(
        await repository().listNotes(identity, {
          status: optionalString(q.status),
          projectId: optionalString(q.project_id),
          collectionId: optionalString(q.collection_id),
          collectionIds: csvQuery(q.collection_ids),
          q: optionalString(q.q),
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /**
   * The Project's notes folder, created on first use. The Project notes surface
   * is hoisted to it, so it has to exist before the surface can show anything —
   * and it is no longer the Research Area's to create, since notes are a
   * Project-level surface reachable from every Area.
   */
  app.post("/api/v1/notes/collections/project/:projectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().ensureProjectNotesCollection(identity, params(request).projectId ?? ""),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/notes/collections", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listNoteCollections(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/notes/collections", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const created = await withDbTransaction(dbPool(context.config), (client) =>
        new PgKnowledgeRepository(client).createNoteCollection(identity, jsonBody(request)),
      );
      return reply.code(201).send(created);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/notes/collections/:collectionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().updateNoteCollection(
          identity,
          params(request).collectionId ?? "",
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/notes/collections/:collectionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await repository().deleteNoteCollection(identity, params(request).collectionId ?? "");
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/notes/deleted/purge", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().purgeDeletedNotes(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/notes", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.primary_project_id),
      });
      return reply.code(201).send(await repository().createNote(
        { spaceId: creation.spaceId, userId: identity.userId },
        {
          ...body,
          primary_project_id: creation.projectId,
          visibility: creation.visibility,
        },
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // N7: "jot a note" from an evidence or material card. Creates (or appends
  // to) a note and makes the note_link in one call, so the connection is
  // recorded without a trip to the Notes page and back for an id.
  app.post("/api/v1/knowledge/notes/jot", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository().jotNoteForObject(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // The reverse of a jot: what notes cite this object. The note backlinks
  // route cannot answer it — that one is note-keyed on both sides.
  app.get("/api/v1/knowledge/objects/:objectId/note-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const objectId = params(request).objectId ?? "";
      return reply.send(await repository().notesLinkingToObject(identity, objectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/knowledge/notes/tree/reorder", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const plan = parseNotesTreeReorder(jsonBody(request));
      const result = await withDbTransaction(dbPool(context.config), async (client) =>
        persistNotesTreeReorder(client, identity, plan),
      );
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes/:noteId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const note = await repository().getNote(identity, params(request).noteId ?? "");
      if (!note) return reply.code(404).send({ detail: "Note not found" });
      return reply.send(note);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/knowledge/notes/:noteId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().updateNote(identity, params(request).noteId ?? "", jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/notes/:noteId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().deleteNote(identity, params(request).noteId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /**
   * Placements (U5). A note may sit in several folders at once; adding one is a
   * separate action from moving the note, and removing the last one is refused
   * rather than quietly leaving a note no tree can reach.
   */
  app.post("/api/v1/knowledge/notes/:noteId/placements", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      return reply.status(201).send(
        await repository().addNotePlacement(
          identity,
          params(request).noteId ?? "",
          requiredString(body.collection_id, "collection_id"),
          body.share_with_project === true,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/notes/:noteId/placements/:collectionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const routeParams = params(request);
      return reply.send(
        await repository().removeNotePlacement(
          identity,
          routeParams.noteId ?? "",
          routeParams.collectionId ?? "",
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /**
   * Cross-Project shares (U8). Listing is gated by the note's own read gate, so
   * a caller who cannot see the note cannot learn which Projects can.
   */
  app.get("/api/v1/knowledge/notes/:noteId/shares", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listNoteProjectShares(identity, params(request).noteId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/notes/:noteId/shares/:projectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const routeParams = params(request);
      return reply.send(
        await repository().revokeNoteProjectShare(
          identity,
          routeParams.noteId ?? "",
          routeParams.projectId ?? "",
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // ND: promote a selected passage into a Knowledge Item. Builds an ordinary
  // knowledge_create proposal — the review gate is unchanged — and records the
  // originating Note as provenance.
  app.post("/api/v1/knowledge/notes/:noteId/promote", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const noteId = params(request).noteId ?? "";
      return reply.code(202).send(await repository().promoteNoteToKnowledge(identity, noteId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // The reverse of a promotion: what this note produced.
  app.get("/api/v1/knowledge/notes/:noteId/promoted", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const noteId = params(request).noteId ?? "";
      return reply.send(await repository().knowledgeItemsPromotedFromNote(identity, noteId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes/:noteId/revisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const limit = numberValue(query(request).limit) ?? undefined;
      return reply.send(
        await repository().listNoteRevisions(identity, params(request).noteId ?? "", limit),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/notes/:noteId/rollback", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const toVersion = numberValue(jsonBody(request).to_version);
      if (toVersion === null || toVersion === undefined) {
        return reply.code(422).send({ detail: "to_version is required" });
      }
      return reply.send(
        await repository().rollbackNote(identity, params(request).noteId ?? "", toVersion),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes/:noteId/links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().noteLinks(identity, params(request).noteId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/knowledge/notes/:noteId/backlinks", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().noteLinks(identity, params(request).noteId ?? "", true));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/knowledge/notes/:noteId/links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository().createNoteLink(identity, params(request).noteId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/knowledge/notes/:noteId/links/:linkId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await repository().deleteNoteLink(identity, params(request).noteId ?? "", params(request).linkId ?? "");
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function knowledgeHealth(context: ModuleContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    return reply.send({ ok: true });
  };
}

async function requireSpaceMaintenanceRole(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  reply: FastifyReply,
): Promise<boolean> {
  return requireSpaceOwnerOrAdmin(config, identity, reply);
}

async function requireContextOpsScanRole(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  reply: FastifyReply,
): Promise<boolean> {
  const repository = authRepositoryFromConfig(config);
  if (!repository) {
    reply.code(502).send({ detail: "Identity database is unavailable" });
    return false;
  }
  const space = await repository.getSpaceForUser(identity.userId, identity.spaceId);
  if (!space) {
    reply.code(404).send({ detail: "Space not found" });
    return false;
  }
  if ("statusCode" in space) {
    reply.code(space.statusCode).send({ detail: space.detail });
    return false;
  }
  if (isSpaceOwnerOrAdmin(space.role)) return true;
  const allowed = await canInitiateContextOpsScan(dbPool(config), identity.spaceId, identity.userId);
  if (!allowed) {
    reply.code(403).send({ detail: "Requires space owner/admin role or enabled Context Ops member scan access" });
    return false;
  }
  return true;
}

type ProtocolSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
};

function parseRetrievalSearchBody(
  schema: ProtocolSchema<RetrievalSearchRequest>,
  value: unknown,
): RetrievalSearchRequest {
  return parseProtocolBody(schema, value);
}

function parseRetrievalBriefBody(
  schema: ProtocolSchema<RetrievalBriefRequest>,
  value: unknown,
): RetrievalBriefRequest {
  return parseProtocolBody(schema, value);
}

function parseRetrievalFeedbackBody(
  schema: ProtocolSchema<RetrievalFeedbackRequest>,
  value: unknown,
): RetrievalFeedbackRequest {
  return parseProtocolBody(schema, value);
}

function parseRetrievalCreateSafetyBody(
  schema: ProtocolSchema<RetrievalCreateSafetyRequest>,
  value: unknown,
): RetrievalCreateSafetyRequest {
  return parseProtocolBody(schema, value);
}

function parseRetrievalMaintenanceScanBody(
  schema: ProtocolSchema<RetrievalMaintenanceScanRequest>,
  value: unknown,
): RetrievalMaintenanceScanRequest {
  return parseProtocolBody(schema, value);
}

function parseRetrievalEvalReportBody(
  schema: ProtocolSchema<RetrievalEvalReportRequest>,
  value: unknown,
): RetrievalEvalReportRequest {
  return parseProtocolBody(schema, value);
}

function parseRetrievalCalibrationDecisionBody(
  schema: ProtocolSchema<RetrievalCalibrationDecisionRequest>,
  value: unknown,
): RetrievalCalibrationDecisionRequest {
  return parseProtocolBody(schema, value);
}

function parseRetrievalEvalDiagnosticsReportBody(
  schema: ProtocolSchema<RetrievalEvalDiagnosticsReportRequest>,
  value: unknown,
): RetrievalEvalDiagnosticsReportRequest {
  return parseProtocolBody(schema, value);
}

function parseClaimTrajectoryBody(
  schema: ProtocolSchema<ClaimTrajectoryRequest>,
  value: unknown,
): ClaimTrajectoryRequest {
  return parseProtocolBody(schema, value);
}

function parseClaimContradictionScanBody(
  schema: ProtocolSchema<ClaimContradictionScanRequest>,
  value: unknown,
): ClaimContradictionScanRequest {
  return parseProtocolBody(schema, value);
}

function parseRelationDiscoveryScanBody(
  schema: ProtocolSchema<RelationDiscoveryScanRequest>,
  value: unknown,
): RelationDiscoveryScanRequest {
  return parseProtocolBody(schema, value);
}

function parseSpaceObjectProfileListRequest(
  schema: ProtocolSchema<SpaceObjectProfileListRequest>,
  value: unknown,
): SpaceObjectProfileListRequest {
  return parseProtocolBody(schema, value);
}

function parseSpaceObjectProfileCreateProposalRequest(
  schema: ProtocolSchema<SpaceObjectProfileCreateProposalRequest>,
  value: unknown,
): SpaceObjectProfileCreateProposalRequest {
  return parseProtocolBody(schema, value);
}

function parseSpaceObjectProfileUpdateProposalRequest(
  schema: ProtocolSchema<SpaceObjectProfileUpdateProposalRequest>,
  value: unknown,
): SpaceObjectProfileUpdateProposalRequest {
  return parseProtocolBody(schema, value);
}

function parseSpaceObjectProfileStatusProposalRequest(
  schema: ProtocolSchema<SpaceObjectProfileStatusProposalRequest>,
  value: unknown,
): SpaceObjectProfileStatusProposalRequest {
  return parseProtocolBody(schema, value);
}

function parseObjectSchemaImportRequest(
  schema: ProtocolSchema<ObjectSchemaImportRequest>,
  value: unknown,
): ObjectSchemaImportRequest {
  return parseProtocolBody(schema, value);
}

function parseObjectSchemaSuggestionScanRequest(
  schema: ProtocolSchema<ObjectSchemaSuggestionScanRequest>,
  value: unknown,
): ObjectSchemaSuggestionScanRequest {
  return parseProtocolBody(schema, value);
}

function parseClaimCandidatePacketCreateBody(
  schema: ProtocolSchema<ClaimCandidatePacketCreateRequest>,
  value: unknown,
): ClaimCandidatePacketCreateRequest {
  return parseProtocolBody(schema, value);
}

function parseRetrievalExplainBody(
  schema: ProtocolSchema<RetrievalExplainRequest>,
  value: unknown,
): RetrievalExplainRequest {
  return parseProtocolBody(schema, value);
}

function parseProtocolBody<T>(schema: ProtocolSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, validationMessage(parsed.error.issues));
  return parsed.data;
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

function validationMessage(issues: Array<{ path: Array<string | number>; message: string }>): string {
  const issue = issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
