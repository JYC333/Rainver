import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { dbPool, jsonBody, resolveIdentity, sendRouteError, withQueryableTransaction } from "../routeUtils/common";
import { enforceSources } from "../sources/enforceSources";
import { AdaptiveQueryOrchestrator } from "./queryPlanning/adaptiveQueryOrchestrator";
import { ResearchMonitorMaterializer } from "./discovery/monitorMaterializer";
import { loadProtocol } from "../providers/protocolRuntime";
import { assertProjectReadable, assertProjectWriter } from "../projects/access";
import { ResearchStrategyActivationService } from "./discovery/strategyActivationService";
import { ResearchQueryRepository } from "./queryPlanning/repository";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/research/query-strategies", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const db = dbPool(context.config);
      await assertProjectReadable(db, identity.spaceId, request.params.projectId, identity.userId);
      const result = await new ResearchQueryRepository(db).listStrategies(identity.spaceId, request.params.projectId);
      return reply.send(protocol.ListResearchQueryStrategiesResponseSchema.parse({
        active_strategy_ids: result.activeStrategyIds,
        strategies: result.strategies,
      }));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.post("/api/v1/research/query-strategies/evaluate", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const input = protocol.EvaluateResearchQueryStrategyRequestSchema.parse(jsonBody(request));
      const db = dbPool(context.config);
      await assertProjectWriter(db, identity.spaceId, input.project_id, identity.userId);
      const strategy = await new AdaptiveQueryOrchestrator(db, context.config).evaluate(identity, {
        projectId: input.project_id,
        researchContextVersionId: input.research_context_version_id,
        providers: input.providers,
        candidateBudget: input.candidate_budget,
        credentials: input.credentials,
        execution: input.execution ? {
          modelProviderId: input.execution.model_provider_id,
          modelName: input.execution.model_name,
        } : undefined,
      });
      return reply.send(protocol.EvaluateResearchQueryStrategyResponseSchema.parse({ strategy }));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.post<{ Params: { strategyId: string; providerKey: string } }>("/api/v1/research/query-strategies/:strategyId/providers/:providerKey/retry", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const input = protocol.RetryResearchQueryProviderRequestSchema.parse(jsonBody(request));
      const providerKey = protocol.ResearchProviderKeySchema.parse(request.params.providerKey);
      const db = dbPool(context.config);
      await assertProjectWriter(db, identity.spaceId, input.project_id, identity.userId);
      const strategy = await new AdaptiveQueryOrchestrator(db, context.config).retryProvider(identity, {
        projectId: input.project_id,
        strategyId: request.params.strategyId,
        providerKey,
        credentials: input.credentials,
        execution: input.execution ? {
          modelProviderId: input.execution.model_provider_id,
          modelName: input.execution.model_name,
        } : undefined,
      });
      return reply.send(protocol.RetryResearchQueryProviderResponseSchema.parse({ strategy }));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.post<{ Params: { strategyId: string } }>("/api/v1/research/query-strategies/:strategyId/materialize", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const sourceGate = await enforceSources(context, identity, "source.connection.manage", "source_channel");
      if (sourceGate.blocked) return reply.code(403).send(sourceGate.reply403);
      const bindingGate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (bindingGate.blocked) return reply.code(403).send(bindingGate.reply403);
      const protocol = await loadProtocol();
      const input = protocol.MaterializeResearchQueryStrategyRequestSchema.parse(jsonBody(request));
      return reply.code(201).send(await new ResearchMonitorMaterializer(dbPool(context.config), context.config).materialize(identity, request.params.strategyId, {
        providerKeys: input.provider_keys,
        credentials: input.credentials,
      }));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.post<{ Params: { strategyId: string } }>("/api/v1/research/query-strategies/:strategyId/activate", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const sourceGate = await enforceSources(context, identity, "source.connection.manage", "source_channel");
      if (sourceGate.blocked) return reply.code(403).send(sourceGate.reply403);
      const bindingGate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (bindingGate.blocked) return reply.code(403).send(bindingGate.reply403);
      const protocol = await loadProtocol();
      const input = protocol.ActivateResearchQueryStrategyRequestSchema.parse(jsonBody(request));
      const result = await withQueryableTransaction(dbPool(context.config), (db) =>
        new ResearchStrategyActivationService(db).activate({
          identity,
          strategyId: request.params.strategyId,
          reason: input.reason,
        }));
      return reply.send(protocol.ActivateResearchQueryStrategyResponseSchema.parse(result));
    } catch (error) { return sendRouteError(reply, error); }
  });
}
