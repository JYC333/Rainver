import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  jsonBody,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import {
  isContentAccessLevel,
  isContentVisibility,
  type ContentAccessLevel,
} from "../access/contentAccessTypes.js";
import { ContentAccessService, type ContentAccessUpdate } from "./service.js";

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

  app.post("/api/v1/content-access/:resourceType/:resourceId/demotion-disclosures", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const route = params(request);
      const visibility = optionalString(jsonBody(request).target_visibility);
      if (!isContentVisibility(visibility) || visibility === "space_shared") {
        throw new HttpError(422, "Invalid demotion target_visibility");
      }
      return reply.code(201).send(await service().discloseDemotion(
        identity,
        requiredParam(route.resourceType, "resourceType"),
        requiredParam(route.resourceId, "resourceId"),
        visibility,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/content-access/:resourceType/:resourceId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const route = params(request);
      return reply.send(await service().updatePolicy(
        identity,
        requiredParam(route.resourceType, "resourceType"),
        requiredParam(route.resourceId, "resourceId"),
        updateInput(jsonBody(request)),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/content-access/:resourceType/:resourceId/publication-proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const route = params(request);
      return reply.code(201).send(await service().requestPublication(
        identity,
        requiredParam(route.resourceType, "resourceType"),
        requiredParam(route.resourceId, "resourceId"),
        updateInput(jsonBody(request)),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function updateInput(body: Record<string, unknown>): ContentAccessUpdate {
  const visibility = optionalString(body.visibility);
  const accessLevel = optionalString(body.access_level);
  if (!Object.hasOwn(body, "project_id") || (body.project_id !== null && typeof body.project_id !== "string")) {
    throw new HttpError(422, "project_id must be a string or null");
  }
  const projectId = optionalString(body.project_id);
  if (typeof body.project_id === "string" && !projectId) throw new HttpError(422, "project_id must not be empty");
  if (!isContentVisibility(visibility)) throw new HttpError(422, "Invalid visibility");
  if (!isContentAccessLevel(accessLevel)) throw new HttpError(422, "Invalid access_level");
  if (!Array.isArray(body.grants)) throw new HttpError(422, "grants must be an array");
  const grants = body.grants.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(422, "Invalid content grant");
    }
    const item = value as Record<string, unknown>;
    const userId = optionalString(item.user_id);
    const grantLevel = optionalString(item.access_level) ?? "full";
    if (!userId || !isContentAccessLevel(grantLevel)) throw new HttpError(422, "Invalid content grant");
    return { user_id: userId, access_level: grantLevel as ContentAccessLevel };
  });
  const demotionConfirmationId = optionalString(body.demotion_confirmation_id);
  return {
    visibility,
    access_level: accessLevel,
    project_id: projectId,
    grants,
    ...(demotionConfirmationId ? { demotion_confirmation_id: demotionConfirmationId } : {}),
  };
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
