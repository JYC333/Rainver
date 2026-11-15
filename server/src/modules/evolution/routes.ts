import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  optionalString,
  params,
  parsePage,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { EvolutionRepository } from "./repository.js";
import { registerEvolvableAssetRoutes } from "./assetRoutes.js";
import { registerEvolutionBundleRoutes } from "./bundleRoutes.js";
import { registerEvolutionOperationRoutes } from "./operations.js";
import { registerEvolutionAssetOperationRoutes } from "./assetOperations.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new EvolutionRepository(dbPool(context.config));
  registerEvolvableAssetRoutes(app, context);
  registerEvolutionBundleRoutes(app, context);
  registerEvolutionOperationRoutes(app, context.config);
  registerEvolutionAssetOperationRoutes(app, context.config);

  // Reader behind the signal receipts: this Space's signal on a target it can read.
  app.get("/api/v1/evolution/signals/:signalId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const signal = await repository().getSignal(identity, params(request).signalId ?? "");
      if (!signal) return reply.code(404).send({ detail: "Evolution signal not found" });
      return reply.send(signal);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });



  app.get("/api/v1/evolution/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().summary(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/targets", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listTargets(identity, optionalString(query(request).status)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/targets/:targetId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const target = await repository().getTarget(identity, params(request).targetId ?? "");
      if (!target) return reply.code(404).send({ detail: "Evolution target not found" });
      return reply.send(target);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/signals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listSignals(identity, null, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/targets/:targetId/signals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listSignals(identity, params(request).targetId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/strategies", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 100);
      return reply.send(await repository().listStrategies(identity, {
        status: optionalString(q.status),
        targetType: optionalString(q.target_type),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/selector-decisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listSelectorDecisions(identity, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/experiences", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listExperiences(identity, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listRuns(identity, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/evolution/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listProposals(identity, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/validation", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listValidationResults(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
