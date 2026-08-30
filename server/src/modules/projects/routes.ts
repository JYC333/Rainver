import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type {
  ProjectPublicSummaryDraftRequest,
  ProjectPublicSummaryUpsertRequest,
  RetrievalBriefRequest,
  RetrievalFeedbackRequest,
  RetrievalSearchRequest,
} from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  HttpError,
  jsonBody,
  requiredString,
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { projectReaders } from "./access.js";
import {
  RetrievalFeedbackService,
  RetrievalSearchService,
  persistRetrievalBriefArtifact,
} from "../retrieval/index.js";
import { readSpaceRetrievalSettings, resolveRetrievalSearchControls } from "../retrieval/settings.js";
import { ProviderReranker } from "../retrieval/rerankProvider/providerReranker.js";
import { ProviderQueryRewriter } from "../retrieval/queryRewriteProvider/providerQueryRewriter.js";
import { ProviderQueryEmbedder } from "../retrieval/embedding/queryEmbedder.js";
import { enqueueRetrievalEmbeddingBackfill } from "../retrieval/embedding/job.js";
import { ProviderSynthesizer } from "../retrieval/synthesisProvider/providerSynthesizer.js";
import { resolveProviderCommandStore } from "../providers/commands/store.js";
import { projectRetrievalRegistry } from "./retrievalAdapter.js";
import { ProjectCorpusRepository } from "./corpusRepository.js";
import { ProjectPublicSummaryGenerator } from "./publicSummaryGenerator.js";
import { PgProjectRepository } from "./repository.js";
import { ProjectSourceBindingService } from "./projectSourceBindingService.js";
import { ProjectSourceProposalService } from "./projectSourceProposalService.js";
import { ProjectKernelService } from "./kernelService.js";
import { ProjectAttentionService, registerBuiltInAttentionAdapters } from "./attentionService.js";
import { ProjectOverviewService } from "./overviewService.js";
import { enforceSources } from "../sources/enforceSources.js";
import { ProjectOperationService } from "./projectOperationService.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => PgProjectRepository.fromConfig(context.config);
  const corpusRepository = () => new ProjectCorpusRepository(dbPool(context.config));
  const summaryGenerator = () => ProjectPublicSummaryGenerator.fromConfig(context.config);
  const sourceBindings = () => new ProjectSourceBindingService(dbPool(context.config));
  const sourceProposals = () => new ProjectSourceProposalService(dbPool(context.config), context.config);
  const operations = () => new ProjectOperationService(dbPool(context.config));

  app.get("/api/v1/projects/:projectId/operations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await operations().list(identity, requiredString(p.projectId, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/operations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const gate = await enforceSources(context, identity, "project.operation.manage", "project_operation");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await operations().create(identity, requiredString(p.projectId, "project_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/operations/:operationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await operations().get(identity, requiredString(p.projectId, "project_id"), requiredString(p.operationId, "operation_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/operations/:operationId/cancel", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const gate = await enforceSources(context, identity, "project.operation.manage", "project_operation", p.operationId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await operations().cancel(identity, requiredString(p.projectId, "project_id"), requiredString(p.operationId, "operation_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/sources/bindings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const q = query(request);
      return reply.send(await sourceBindings().listBindings(identity, { projectId: requiredString(p.projectId, "project_id"), sourceChannelId: optionalString(q.source_channel_id) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/sources/extraction-profiles", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await sourceBindings().listExtractionProfiles(identity, requiredString(p.projectId, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/sources/health", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await sourceBindings().health(identity, requiredString(p.projectId, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/sources/bindings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      const p = params(request);
      return reply.code(201).send(await sourceBindings().createBinding(identity, { ...jsonBody(request), project_id: requiredString(p.projectId, "project_id") }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/sources/propose-bind", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      const p = params(request);
      return reply.code(201).send(await sourceProposals().proposeBind(identity, requiredString(p.projectId, "project_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/sources/propose-setup", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const sourceGate = await enforceSources(context, identity, "source.connection.manage", "source_connection");
      if (sourceGate.blocked) return reply.code(403).send(sourceGate.reply403);
      const projectGate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (projectGate.blocked) return reply.code(403).send(projectGate.reply403);
      const p = params(request);
      return reply.code(201).send(await sourceProposals().proposeSourceSetup(identity, requiredString(p.projectId, "project_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/projects/:projectId/sources/bindings/:bindingId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      const p = params(request);
      return reply.send(await sourceBindings().updateBinding(identity, requiredString(p.bindingId, "binding_id"), jsonBody(request), requiredString(p.projectId, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/projects/:projectId/sources/bindings/:bindingId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      const p = params(request);
      return reply.send(await sourceBindings().deleteBinding(identity, requiredString(p.bindingId, "binding_id"), requiredString(p.projectId, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/sources/bindings/:bindingId/backfill", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      const p = params(request);
      return reply.send(await sourceBindings().backfillBinding(identity, requiredString(p.bindingId, "binding_id"), requiredString(p.projectId, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/sources/bindings/:bindingId/propose-backfill", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      const p = params(request);
      return reply.code(201).send(await sourceProposals().proposeBackfill(identity, requiredString(p.projectId, "project_id"), requiredString(p.bindingId, "binding_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 50);
      const status = optionalString(q.status);
      if (status && !["active", "archived"].includes(status)) {
        return reply.code(422).send({ detail: "status must be active or archived" });
      }
      return reply.send(await repository().list(identity, { status, limit, offset }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository().create(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/public-summaries", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 50);
      return reply.send(
        await repository().listPublicSummaries(identity, {
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/public-summaries/search", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseRetrievalSearchBody(protocol.RetrievalSearchRequestSchema, jsonBody(request));
      const objectTypes = body.object_types ?? ["project_public_summary"];
      if (objectTypes.some((objectType) => objectType !== "project_public_summary")) {
        throw new HttpError(422, "project public summary search only supports project_public_summary");
      }
      const pool = dbPool(context.config);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const controls = resolveRetrievalSearchControls(body, retrievalSettings);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, projectRetrievalRegistry, {
        egressPolicy,
        // Vector recall arm (parity with knowledge/memory): provider egress is
        // checked at invocation time, so local providers remain usable when
        // external egress is disabled.
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          retrievalSettings.embeddingDimensions,
          egressPolicy,
        ),
        feedbackService: new RetrievalFeedbackService(pool, projectRetrievalRegistry),
        // Reranker is off unless this space enables it; degrades to the fused order otherwise.
        reranker: retrievalSettings.rerankEnabled
          ? new ProviderReranker(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "project_public_summary_search",
              egressPolicy,
            })
          : undefined,
        // Query rewriter is off unless this space enables it; degrades to the original query.
        queryRewriter: retrievalSettings.queryRewriteEnabled
          ? new ProviderQueryRewriter(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "project_public_summary_search",
              egressPolicy,
            })
          : undefined,
      });
      return reply.send(await search.search({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        query: body.query,
        objectTypes: ["project_public_summary"],
        objectProfiles: body.object_profiles,
        maxResults: controls.maxResults,
        includeTrace: controls.includeTrace,
        feedbackSurface: "project_public_summary_search",
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

  app.post("/api/v1/projects/retrieval/brief", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseRetrievalBriefBody(protocol.RetrievalBriefRequestSchema, jsonBody(request));
      const objectTypes = body.object_types ?? ["project_public_summary"];
      if (objectTypes.some((objectType) => objectType !== "project_public_summary")) {
        throw new HttpError(422, "project retrieval brief only supports project_public_summary");
      }
      const pool = dbPool(context.config);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, projectRetrievalRegistry, {
        egressPolicy,
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          retrievalSettings.embeddingDimensions,
          egressPolicy,
        ),
        reranker: retrievalSettings.rerankEnabled
          ? new ProviderReranker(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "project_public_summary_brief",
              egressPolicy,
            })
          : undefined,
        synthesizer: new ProviderSynthesizer(store, {
          databaseUrl: context.config.databaseUrl,
          surface: "project_public_summary_brief",
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
        objectTypes: ["project_public_summary"],
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
          objectTypes: ["project_public_summary"],
          objectProfiles: body.object_profiles,
          maxResults,
          includeTrace,
          mode,
          surface: "project_public_summary_brief",
          response,
          persistTrace: false,
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
          },
        });
        return reply.send({ ...response, artifact_id: artifactId });
      } catch (error) {
        request.log.warn(
          { err: error },
          "project retrieval brief artifact persistence failed",
        );
        return reply.send({ ...response, artifact_error: "retrieval_brief_persist_failed" });
      }
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/public-summaries/feedback", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseBodyWith<RetrievalFeedbackRequest>(
        protocol.RetrievalFeedbackRequestSchema,
        jsonBody(request),
      );
      if (body.object_type !== "project_public_summary") {
        throw new HttpError(422, "project public summary feedback only supports project_public_summary");
      }
      const recorded = await new RetrievalFeedbackService(
        dbPool(context.config),
        projectRetrievalRegistry,
      ).record({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        surface: "project_public_summary_search",
        query: body.query,
        objectType: "project_public_summary",
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

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const project = await repository().get(identity, params(request).projectId ?? "");
      if (!project) return reply.code(404).send({ detail: "Project not found" });
      return reply.send(project);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/public-summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const summary = await repository().getPublicSummary(identity, params(request).projectId ?? "");
      if (!summary) return reply.code(404).send({ detail: "Project public summary not found" });
      return reply.send(summary);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/projects/:projectId/public-summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseBodyWith<ProjectPublicSummaryUpsertRequest>(
        protocol.ProjectPublicSummaryUpsertRequestSchema,
        jsonBody(request),
      );
      const summary = await repository().upsertPublicSummary(
        identity,
        params(request).projectId ?? "",
        body,
      );
      // Best-effort: the upsert recreates the chunk with embedding=NULL, so enqueue
      // a backfill to embed it for the vector arm (matches knowledge/memory).
      await enqueueRetrievalEmbeddingBackfill(context.config, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        trigger: "project_public_summary_upsert",
      }).catch((error) => {
        process.stderr.write(
          `[projects.retrieval] embedding backfill enqueue failed: ${String((error as Error)?.message ?? error)}\n`,
        );
        return null;
      });
      return reply.send(summary);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/public-summary/draft", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parseBodyWith<ProjectPublicSummaryDraftRequest>(
        protocol.ProjectPublicSummaryDraftRequestSchema,
        jsonBody(request),
      );
      return reply.send(
        await summaryGenerator().generateDraft(identity, params(request).projectId ?? "", {
          providerId: optionalString(body.model_provider_id) ?? optionalString(body.provider_id),
          model: optionalString(body.model),
          maxTokens: body.max_tokens ?? null,
          generatedByRunId: optionalString(body.generated_by_run_id),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/projects/:projectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().update(identity, params(request).projectId ?? "", jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/archive", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().archive(identity, params(request).projectId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().summary(identity, params(request).projectId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/corpus", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 50);
      return reply.send(await corpusRepository().list(identity, params(request).projectId ?? "", {
        status: optionalString(q.status),
        triageStatus: optionalString(q.triage_status),
        readStatus: optionalString(q.read_status),
        role: optionalString(q.role),
        q: optionalString(q.q),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/corpus", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await corpusRepository().upsert(identity, params(request).projectId ?? "", jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/corpus/backfill-source-items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await corpusRepository().backfillFromSources(identity, params(request).projectId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/projects/:projectId/corpus/:corpusItemId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await corpusRepository().update(
          identity,
          params(request).projectId ?? "",
          params(request).corpusItemId ?? "",
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Project membership = the project-level memory access ACL. List is open to
  // any space member; add/remove require the project owner or a space owner/admin.
  app.get("/api/v1/projects/:projectId/members", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listMembers(identity, params(request).projectId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /**
   * Everyone who can read this Project.
   *
   * Distinct from `/members`, which is the Project-level memory ACL and omits
   * the owner. This is the roster picker's candidate source: a Room's audience
   * is chosen from it, and offering anyone outside it produces an invitation
   * the server then refuses.
   *
   * The gate is the answer itself. A caller who is not among the readers
   * cannot read the Project, and so gets the same 404 a Project that does not
   * exist would give — no roster, and no signal that there was one.
   */
  app.get("/api/v1/projects/:projectId/readers", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = params(request).projectId ?? "";
      const readers = await projectReaders(dbPool(context.config), identity.spaceId, projectId);
      if (!readers.some((reader) => reader.user_id === identity.userId)) {
        throw new HttpError(404, "Project not found");
      }
      return reply.send({ readers });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/members", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await repository().addMember(identity, params(request).projectId ?? "", jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/projects/:projectId/members/:userId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await repository().removeMember(
        identity,
        params(request).projectId ?? "",
        params(request).userId ?? "",
      );
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Folder listing/creation/update/deletion all live in the projectFolders
  // module under this same `/api/v1/projects/:projectId/folders` path.

  registerBuiltInAttentionAdapters();
  const kernel = () => ProjectKernelService.fromConfig(context.config);
  const attention = () => ProjectAttentionService.fromConfig(context.config);
  const overview = () => ProjectOverviewService.fromConfig(context.config);

  app.get("/api/v1/projects/:projectId/brief-versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await kernel().listBriefVersions(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/brief-versions/active", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await kernel().getActiveBriefVersion(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/brief-versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await kernel().createBriefVersion(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/brief-versions/:versionId/submit-review", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { const p = params(request); return reply.send(await kernel().submitBriefForReview(identity, requiredString(p.projectId, "project_id"), requiredString(p.versionId, "version_id"))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.post("/api/v1/projects/:projectId/brief-versions/:versionId/publish", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { const p = params(request); return reply.send(await kernel().publishBrief(identity, requiredString(p.projectId, "project_id"), requiredString(p.versionId, "version_id"))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.get("/api/v1/projects/:projectId/instruction-versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await kernel().listInstructionVersions(identity, requiredString(params(request).projectId, "project_id"))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.get("/api/v1/projects/:projectId/instruction-versions/active", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await kernel().getActiveInstructionVersion(identity, requiredString(params(request).projectId, "project_id"))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.post("/api/v1/projects/:projectId/instruction-versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.code(201).send(await kernel().createInstructionVersion(identity, requiredString(params(request).projectId, "project_id"), jsonBody(request))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  for (const [path, publish] of [["submit-review", false], ["publish", true]] as const) {
    app.post(`/api/v1/projects/:projectId/instruction-versions/:versionId/${path}`, async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
      try { const p = params(request); return reply.send(await kernel().transitionInstruction(identity, requiredString(p.projectId, "project_id"), requiredString(p.versionId, "version_id"), publish)); }
      catch (error) { return sendRouteError(reply, error); }
    });
  }

  app.get("/api/v1/projects/:projectId/mode-transitions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await kernel().listModeTransitions(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/mode-transitions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await kernel().transitionMode(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/attention", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await attention().listAttentionItems(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/projects/:projectId/attention/:sourceType/:sourceId/state", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const projectId = requiredString(p.projectId, "project_id");
      const sourceType = requiredString(p.sourceType, "source_type");
      const sourceId = requiredString(p.sourceId, "source_id");
      const body = jsonBody(request);
      const patch: { seen_at?: string | null; snoozed_until?: string | null; pinned_at?: string | null } = {};
      if (Object.prototype.hasOwnProperty.call(body, "seen_at")) patch.seen_at = optionalString(body.seen_at) ?? null;
      if (Object.prototype.hasOwnProperty.call(body, "snoozed_until")) patch.snoozed_until = optionalString(body.snoozed_until) ?? null;
      if (Object.prototype.hasOwnProperty.call(body, "pinned_at")) patch.pinned_at = optionalString(body.pinned_at) ?? null;
      return reply.send(
        await attention().setUserState(identity, projectId, sourceType, sourceId, patch),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/overview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await overview().getOverview(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
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
  return parseBodyWith(schema, value);
}

function parseRetrievalBriefBody(
  schema: ProtocolSchema<RetrievalBriefRequest>,
  value: unknown,
): RetrievalBriefRequest {
  return parseBodyWith(schema, value);
}

function parseBodyWith<T>(schema: ProtocolSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, validationMessage(parsed.error.issues));
  return parsed.data;
}

function validationMessage(issues: Array<{ path: Array<string | number>; message: string }>): string {
  const issue = issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
