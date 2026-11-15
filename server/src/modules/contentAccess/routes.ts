import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { ContentAccessService } from "./service.js";
import { registerContentAccessOperationRoutes } from "./operationRoutes.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = () => ContentAccessService.fromConfig(context.config);

  app.get("/api/v1/content-access/:resourceType/:resourceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const route = params(request);
      return reply.send(await service().getPolicy(
        identity,
        requiredParam(route.resourceType, "resourceType"),
        requiredParam(route.resourceId, "resourceId"),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/content-access/:resourceType/:resourceId/access-logs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const route = params(request);
      const q = query(request);
      const limit = boundedInteger(q.limit, 50, 1, 100, "limit");
      const offset = boundedInteger(q.offset, 0, 0, 10_000, "offset");
      return reply.send(await service().listAccessLogs(
        identity,
        requiredParam(route.resourceType, "resourceType"),
        requiredParam(route.resourceId, "resourceId"),
        limit,
        offset,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /** The disclosure a `content.demotion.disclose` receipt names, released to the current owner only. */
  app.get("/api/v1/content-access/:resourceType/:resourceId/demotion-disclosures/:confirmationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const route = params(request);
      reply.header("cache-control", "private, no-store");
      return reply.send(await service().readDemotionDisclosure(
        identity,
        requiredParam(route.resourceType, "resourceType"),
        requiredParam(route.resourceId, "resourceId"),
        requiredParam(route.confirmationId, "confirmationId"),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  registerContentAccessOperationRoutes(app, context);
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(422, `${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}
