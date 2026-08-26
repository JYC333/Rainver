import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@agent-space/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  HttpError,
  jsonBody,
  optionalString,
  parsePage,
  params,
  query,
  requiredString,
  resolveIdentity,
  sendRouteError,
  toDbDate,
} from "../routeUtils/common.js";
import { requireSpaceOwnerOrAdmin, requireInstanceAdmin } from "../routeUtils/access.js";
import { enforceSources } from "./enforceSources.js";
import { PgSourcesRepository } from "./repository.js";
import { SourcePostProcessingService } from "./postProcessing/service.js";
import { registerCustomSourceRoutes } from "./customSources/customSourceRoutes.js";
import { registerSourceRecipeRoutes } from "./sourceRecipeRoutes.js";
import { listSourceRuns } from "./sourceRunReadModel.js";
import {
  RetrievalProjectionService,
  RetrievalSearchService,
  persistRetrievalBriefArtifact,
  type RetrievalObjectType,
} from "../retrieval/index.js";
import { readSpaceRetrievalSettings, resolveRetrievalSearchControls } from "../retrieval/settings.js";
import { ProviderQueryEmbedder } from "../retrieval/embedding/queryEmbedder.js";
import { ProviderQueryRewriter } from "../retrieval/queryRewriteProvider/providerQueryRewriter.js";
import { ProviderReranker } from "../retrieval/rerankProvider/providerReranker.js";
import { ProviderSynthesizer } from "../retrieval/synthesisProvider/providerSynthesizer.js";
import { resolveProviderCommandStore } from "../providers/commands/store.js";
import { enqueueRetrievalEmbeddingBackfill } from "../retrieval/embedding/job.js";
import { sourceRetrievalRegistry } from "./retrievalAdapter.js";
import { SourceBackfillPlanningService } from "./sourceBackfillService.js";
import { SourceChannelService } from "./channels/sourceChannelService.js";
import { SourceProviderCatalogService } from "./catalog/sourceProviderCatalogService.js";
import { SourceQueryPreviewService } from "./sourceQueryPreviewService.js";
import { applyContentCreationContext, resolveContentCreationContext } from "../access/creationContext.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new PgSourcesRepository(dbPool(context.config), context.config);
  const backfills = () => new SourceBackfillPlanningService(dbPool(context.config), context.config);
  const channels = () => new SourceChannelService(dbPool(context.config), context.config);
  const catalog = () => new SourceProviderCatalogService(dbPool(context.config));
  const queryPreviews = () => new SourceQueryPreviewService(dbPool(context.config), context.config);

  app.get("/api/v1/sources/providers", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await catalog().listPublicProviders());
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      const creationIdentity = { spaceId: creation.spaceId, userId: identity.userId };
      const gate = await enforceSources(context, creationIdentity, "source.connection.manage", "source_channel");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await channels().create(
        creationIdentity,
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/query-preview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.connection.manage", "source_channel");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await queryPreviews().preview(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await channels().list(identity, { status: optionalString(q.status), providerKey: optionalString(q.provider_key) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/recommendations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await channels().listRecommendations(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/recommendations/:channelId/decision", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const decision = requiredString(jsonBody(request).decision, "decision");
      if (!(["subscribed", "dismissed", "muted"] as string[]).includes(decision)) {
        throw new HttpError(422, "decision must be subscribed, dismissed, or muted");
      }
      return reply.send(await channels().decideRecommendation(
        identity,
        params(request).channelId ?? "",
        decision as "subscribed" | "dismissed" | "muted",
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const channel = await channels().get(identity, params(request).channelId ?? "");
      if (!channel) return reply.code(404).send({ detail: "Source channel not found" });
      return reply.send(channel);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/sources/channels/:channelId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.connection.manage", "source_channel", params(request).channelId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await channels().update(identity, params(request).channelId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/scan", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.connection.manage", "source_channel", params(request).channelId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(202).send(await channels().scan(identity, params(request).channelId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/instance/source-catalog", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try {
      return reply.send(await catalog().listCatalog());
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/instance/source-catalog/providers/:providerId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try { return reply.send(await catalog().updateProvider(params(request).providerId ?? "", { status: optionalString(jsonBody(request).status) ?? undefined })); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.patch("/api/v1/instance/source-catalog/connectors/:connectorId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try { return reply.send(await catalog().updateConnector(params(request).connectorId ?? "", { status: optionalString(jsonBody(request).status) ?? undefined })); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.patch("/api/v1/instance/source-catalog/mappings/:mappingId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try {
      const body = jsonBody(request);
      const priority = body.priority === undefined ? undefined : Number(body.priority);
      return reply.send(await catalog().updateMapping(params(request).mappingId ?? "", { status: optionalString(body.status) ?? undefined, priority }));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.post("/api/v1/sources/channels/:channelId/backfill/plans/preview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await backfills().preview(identity, requiredString(params(request).channelId, "source_channel_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/backfill/plans", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await backfills().create(identity, requiredString(params(request).channelId, "source_channel_id"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/backfill/plans", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await backfills().list(identity, requiredString(params(request).channelId, "source_channel_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/backfill/plans/:planId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan", p.planId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await backfills().get(identity, requiredString(p.channelId, "source_channel_id"), requiredString(p.planId, "plan_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/backfill/plans/:planId/propose-start", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan", p.planId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await backfills().proposeStart(identity, requiredString(p.channelId, "source_channel_id"), requiredString(p.planId, "plan_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/backfill/plans/:planId/pause", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const gate = await enforceSources(context, identity, "source.backfill.manage", "source_backfill_plan", p.planId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await backfills().setPaused(identity, requiredString(p.channelId, "source_channel_id"), requiredString(p.planId, "plan_id"), true));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/backfill/plans/:planId/resume", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const gate = await enforceSources(context, identity, "source.backfill.manage", "source_backfill_plan", p.planId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await backfills().setPaused(identity, requiredString(p.channelId, "source_channel_id"), requiredString(p.planId, "plan_id"), false));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  const postProcessing = () => new SourcePostProcessingService(dbPool(context.config), context.config);
  registerCustomSourceRoutes(app, context);
  registerSourceRecipeRoutes(app, context);

  app.get("/api/v1/sources", sourcesHealth(context));
  app.get("/api/v1/sources/", sourcesHealth(context));

  app.post("/api/v1/sources/retrieval/search", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const parsed = protocol.RetrievalSearchRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) throw new HttpError(422, validationMessage(parsed.error.issues));
      const body = parsed.data;
      const objectTypes = sourceObjectTypes(body.object_types);
      const pool = dbPool(context.config);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const controls = resolveRetrievalSearchControls(body, retrievalSettings);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, sourceRetrievalRegistry, {
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
              surface: "source_search",
              egressPolicy,
            })
          : undefined,
        queryRewriter: retrievalSettings.queryRewriteEnabled
          ? new ProviderQueryRewriter(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "source_search",
              egressPolicy,
            })
          : undefined,
      });
      return reply.send(await search.search({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        query: body.query,
        objectTypes,
        objectProfiles: body.object_profiles,
        maxResults: controls.maxResults,
        includeTrace: controls.includeTrace,
        feedbackSurface: "source_search",
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

  app.post("/api/v1/sources/retrieval/brief", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const parsed = protocol.RetrievalBriefRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) throw new HttpError(422, validationMessage(parsed.error.issues));
      const body = parsed.data;
      const objectTypes = sourceObjectTypes(body.object_types);
      const pool = dbPool(context.config);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, sourceRetrievalRegistry, {
        egressPolicy,
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          retrievalSettings.embeddingDimensions,
          egressPolicy,
        ),
        reranker: retrievalSettings.rerankEnabled
          ? new ProviderReranker(store, { databaseUrl: context.config.databaseUrl, surface: "source_brief", egressPolicy })
          : undefined,
        synthesizer: new ProviderSynthesizer(store, {
          databaseUrl: context.config.databaseUrl,
          surface: "source_brief",
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
        objectTypes,
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
          objectTypes,
          objectProfiles: body.object_profiles,
          maxResults,
          includeTrace,
          mode,
          surface: "source_brief",
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
      } catch {
        return reply.send({ ...response, artifact_error: "retrieval_brief_persist_failed" });
      }
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/retrieval/reindex", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context, identity, reply))) return reply;
    try {
      const projection = new RetrievalProjectionService(dbPool(context.config), sourceRetrievalRegistry);
      const summary = await projection.reindexAll(identity.spaceId);
      const embeddingBackfill = await enqueueRetrievalEmbeddingBackfill(context.config, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        trigger: "source_retrieval_reindex",
      }).catch((error) => {
        process.stderr.write(
          `[source.retrieval] embedding backfill enqueue failed: ${String((error as Error)?.message ?? error)}\n`,
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

  app.get("/api/v1/sources/connections", async (request, reply) => {
    return reply.code(410).send({ detail: "Source connections are internal provenance; use Source Channels" });
  });

  app.post("/api/v1/sources/connections", async (request, reply) => {
    return reply.code(410).send({ detail: "Source connections are not user-created resources; create a Source Channel" });
  });

  app.post("/api/v1/sources/connections/drafts", async (request, reply) => {
    return reply.code(410).send({ detail: "Source connection drafts were replaced by Source Channels" });
  });

  app.post("/api/v1/sources/connections/proposals", async (request, reply) => {
    return reply.code(410).send({ detail: "Source connection proposals were replaced by Source Channel activation proposals" });
  });

  app.get("/api/v1/sources/connections/:connectionId", async (request, reply) => {
    return reply.code(410).send({ detail: "Source connections are internal provenance; use Source Channels" });
  });

  app.post("/api/v1/sources/connections/:connectionId/recommendations", async (request, reply) => {
    return reply.code(410).send({ detail: "Subscriptions are managed at Source Channel level" });
  });

  app.post("/api/v1/sources/connections/:connectionId/subscription", async (request, reply) => {
    return reply.code(410).send({ detail: "Subscriptions are managed at Source Channel level" });
  });

  app.get("/api/v1/sources/channels/:channelId/source-runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await listSourceRuns(dbPool(context.config), identity, params(request).channelId ?? "", {
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/post-processing/rules", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await postProcessing().listRules(identity, params(request).channelId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/post-processing/rules", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).channelId ?? "";
      const gate = await enforceSources(context, identity, "source.connection.manage", "source_channel", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await postProcessing().createRule(identity, connectionId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/sources/channels/:channelId/post-processing/rules/:ruleId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).channelId ?? "";
      const gate = await enforceSources(context, identity, "source.connection.manage", "source_channel", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await postProcessing().updateRule(
        identity,
        connectionId,
        params(request).ruleId ?? "",
        jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/post-processing/rules/:ruleId/run", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).channelId ?? "";
      const gate = await enforceSources(context, identity, "source.connection.manage", "source_channel", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(202).send(await postProcessing().runRuleNow(
        identity,
        connectionId,
        params(request).ruleId ?? "",
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/post-processing/runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await postProcessing().listRuns(identity, params(request).channelId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/post-processing/backlog", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await postProcessing().backlog(identity, params(request).channelId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/channels/:channelId/post-processing/decisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await postProcessing().listDecisions(identity, {
        connectionId: params(request).channelId ?? "",
        ruleId: optionalString(q.rule_id),
        relevance: optionalString(q.relevance),
        reviewStatus: optionalString(q.review_status),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/channels/:channelId/post-processing/rules/:ruleId/drain", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).channelId ?? "";
      const gate = await enforceSources(context, identity, "source.connection.manage", "source_channel", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(202).send(await postProcessing().drainRuleNow(
        identity,
        connectionId,
        params(request).ruleId ?? "",
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/post-processing/decisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await postProcessing().listDecisions(identity, {
        connectionId: optionalString(q.channel_id),
        projectId: optionalString(q.project_id),
        ruleId: optionalString(q.rule_id),
        relevance: optionalString(q.relevance),
        reviewStatus: optionalString(q.review_status),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/briefings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await postProcessing().listBriefings(identity, {
        connectionId: optionalString(q.channel_id),
        projectId: optionalString(q.project_id),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/briefings/:channelId/:date", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await postProcessing().getBriefing(
        identity,
        params(request).channelId ?? "",
        params(request).date ?? "",
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/post-processing/decisions/:decisionId/actions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const action = optionalString(body.action);
      const policyAction = action === "queue_content" || action === "extract_evidence"
        ? "source.item_create"
        : "source.item_update";
      const gate = await enforceSources(context, identity, policyAction, "source_item");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await postProcessing().decisionAction(identity, params(request).decisionId ?? "", body));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/sources/connections/:connectionId", async (request, reply) => {
    return reply.code(410).send({ detail: "Source connections are internal provenance; update the Source Channel" });
  });

  app.delete("/api/v1/sources/connections/:connectionId", async (request, reply) => {
    return reply.code(410).send({ detail: "Source connections are internal provenance; archive the Source Channel" });
  });

  app.post("/api/v1/sources/connections/:connectionId/scan", async (request, reply) => {
    return reply.code(410).send({ detail: "Scan the Source Channel instead" });
  });

  app.get("/api/v1/sources/items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listItems(identity, {
        libraryStatus: optionalString(q.library_status),
        readStatus: optionalString(q.read_status),
        contentState: optionalString(q.content_state),
        connectionId: optionalString(q.connection_id),
        itemType: optionalString(q.item_type),
        libraryType: optionalString(q.library_type),
        sourceDomain: optionalString(q.source_domain),
        createdAfter: toDbDate(q.created_after),
        occurredAfter: toDbDate(q.occurred_after),
        q: optionalString(q.q),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/items/manual-url", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const connectionId = optionalString(body.connection_id);
      const creation = connectionId ? null : await resolveContentCreationContext(dbPool(context.config), {
            userId: identity.userId,
            requestSpaceId: identity.spaceId,
            projectId: optionalString(body.project_id),
          });
      const creationIdentity = creation
        ? { spaceId: creation.spaceId, userId: identity.userId }
        : identity;
      const gate = await enforceSources(context, creationIdentity, "source.item_create", "source_item");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await repository().createManualUrl(
        creationIdentity,
        creation ? applyContentCreationContext(body, creation) : body,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/items/:itemId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const item = await repository().getItem(identity, params(request).itemId ?? "");
      if (!item) return reply.code(404).send({ detail: "Source item not found" });
      return reply.send(item);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/sources/items/:itemId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const itemId = params(request).itemId ?? "";
      const gate = await enforceSources(context, identity, "source.item_update", "source_item", itemId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await repository().updateItem(identity, itemId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/items/:itemId/actions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const itemId = params(request).itemId ?? "";
      const body = jsonBody(request);
      const action = typeof body.action === "string" ? body.action : "";
      const policyAction =
        action === "queue_content" || action === "archive_snapshot"
          ? "source.item_create"
          : "source.item_update";
      const gate = await enforceSources(context, identity, policyAction, "source_item", itemId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await repository().itemAction(identity, itemId, body));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/jobs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listJobs(identity, {
        status: optionalString(q.status),
        sourceItemId: optionalString(q.source_item_id),
        connectionId: optionalString(q.connection_id),
        jobType: optionalString(q.job_type),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/jobs/:jobId/run", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const jobId = params(request).jobId ?? "";
      const gate = await enforceSources(context, identity, "source.item_create", "extraction_job", jobId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await repository().runJob(identity, jobId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/evidence", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listEvidence(identity, {
        status: optionalString(q.status),
        evidenceType: optionalString(q.evidence_type),
        sourceItemId: optionalString(q.source_item_id),
        projectId: optionalString(q.project_id),
        connectionId: optionalString(q.connection_id),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/evidence", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const hasSource = Boolean(optionalString(body.source_item_id) || optionalString(body.artifact_id));
      const creation = hasSource ? null : await resolveContentCreationContext(dbPool(context.config), {
            userId: identity.userId,
            requestSpaceId: identity.spaceId,
            projectId: optionalString(body.project_id),
          });
      const creationIdentity = creation
        ? { spaceId: creation.spaceId, userId: identity.userId }
        : identity;
      const gate = await enforceSources(context, creationIdentity, "evidence.create", "evidence");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await repository().createEvidence(
        creationIdentity,
        creation ? applyContentCreationContext(body, creation) : body,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/evidence/:evidenceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const evidence = await repository().getEvidence(identity, params(request).evidenceId ?? "");
      if (!evidence) return reply.code(404).send({ detail: "Evidence not found" });
      return reply.send(evidence);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/sources/evidence/:evidenceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const evidenceId = params(request).evidenceId ?? "";
      const gate = await enforceSources(context, identity, "evidence.update", "evidence", evidenceId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await repository().updateEvidence(identity, evidenceId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/evidence-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 100);
      return reply.send(await repository().listEvidenceLinks(identity, {
        evidenceId: optionalString(q.evidence_id),
        targetType: optionalString(q.target_type),
        targetId: optionalString(q.target_id),
        status: optionalString(q.status),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/evidence-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "evidence.link", "evidence");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await repository().createEvidenceLink(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/project-items", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listProjectItems(identity, {
        projectId: requiredString(q.project_id, "project_id"),
        sourceChannelId: optionalString(q.source_channel_id),
        itemType: optionalString(q.item_type),
        sourceDomain: optionalString(q.source_domain),
        matchedDate: optionalString(q.matched_date),
        createdAfter: toDbDate(q.created_after),
        occurredAfter: toDbDate(q.occurred_after),
        q: optionalString(q.q),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/project-source-summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await repository().projectSourceSummary(identity, requiredString(q.project_id, "project_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/source-health", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await repository().sourceHealth(identity, { channelId: optionalString(q.channel_id) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/post-processing/run-once", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await postProcessing().runOneOff(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

}

function sourcesHealth(context: ModuleContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    return reply.send({ ok: true });
  };
}

const SOURCE_RETRIEVAL_OBJECT_TYPES = ["source_item", "extracted_evidence"] as const;

function sourceObjectTypes(values: RetrievalObjectType[] | undefined): RetrievalObjectType[] {
  if (!values || values.length === 0) return [...SOURCE_RETRIEVAL_OBJECT_TYPES];
  const invalid = values.filter((value) => !(SOURCE_RETRIEVAL_OBJECT_TYPES as readonly string[]).includes(value));
  if (invalid.length > 0) {
    throw new HttpError(422, "source retrieval only supports source_item and extracted_evidence");
  }
  return [...new Set(values)];
}

async function requireSpaceMaintenanceRole(
  context: ModuleContext,
  identity: { spaceId: string; userId: string },
  reply: FastifyReply,
): Promise<boolean> {
  return requireSpaceOwnerOrAdmin(context.config, identity, reply);
}

function validationMessage(issues: Array<{ path: Array<string | number>; message: string }>): string {
  const issue = issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
