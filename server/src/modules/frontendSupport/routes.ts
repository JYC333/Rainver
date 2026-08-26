/**
 * Frontend-support read model routes.
 *
 * These aggregation surfaces are native server/Postgres read models. `/home/*`
 * remains scoped to the active space; `/me/*` aggregates across the current
 * user's active memberships and intentionally ignores active-space query
 * parameters.
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveIdentity, sendRouteError, type SpaceUserIdentity } from "../routeUtils/common.js";
import { PgFrontendSupportService } from "./service.js";

type FrontendSupportService = Pick<
  PgFrontendSupportService,
  "homeSummary" | "meSummary" | "meTimeline" | "mePending"
>;

type ServiceFactory = (context: ModuleContext) => FrontendSupportService;

let serviceFactoryOverride: ServiceFactory | null = null;

export function __setFrontendSupportServiceFactoryForTests(
  factory: ServiceFactory | null,
): void {
  serviceFactoryOverride = factory;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = (): FrontendSupportService =>
    serviceFactoryOverride?.(context) ?? PgFrontendSupportService.fromConfig(context.config);

  app.get("/api/v1/home/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().homeSummary(identity, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/me/summary", async (request, reply) => {
    const identity = await resolveAnySpaceIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().meSummary(identity.userId, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/me/timeline", async (request, reply) => {
    const identity = await resolveAnySpaceIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().meTimeline(identity.userId, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/me/pending", async (request, reply) => {
    const identity = await resolveAnySpaceIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().mePending(identity.userId, query(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

async function resolveAnySpaceIdentity(
  context: ModuleContext,
  request: Parameters<typeof resolveIdentity>[1],
  reply: Parameters<typeof resolveIdentity>[2],
): Promise<SpaceUserIdentity | null> {
  return resolveIdentity(context.config, request, reply);
}

function query(request: { query: unknown }): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}
