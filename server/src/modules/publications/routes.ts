import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  jsonBody,
  optionalString,
  params,
  query,
  requiredString,
  resolveIdentity,
  sendRouteError,
  stringArray,
} from "../routeUtils/common.js";
import { PublicationService, type CreatePublicationInput } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = () => PublicationService.fromConfig(context.config);

  app.get("/api/v1/publications", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const view = optionalString(query(request).view) ?? "received";
      if (view === "received") return reply.send(await service().listReceived(identity));
      if (view === "published") return reply.send(await service().listPublished(identity));
      throw new HttpError(422, "view must be received or published");
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/publications", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const result = await service().create(identity, createInput(jsonBody(request)));
      return reply.code(201).send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/publications/:publicationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().get(identity, requiredParam(request, "publicationId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/publications/:publicationId/import", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const result = await service().import(identity, requiredParam(request, "publicationId"));
      return reply.code(201).send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/publications/:publicationId/revoke", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().revoke(identity, requiredParam(request, "publicationId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function createInput(body: Record<string, unknown>): CreatePublicationInput {
  const targetSpaceIds = [...new Set(stringArray(body.target_space_ids).map((value) => value.trim()).filter(Boolean))];
  if (!Array.isArray(body.target_space_ids) || targetSpaceIds.length !== body.target_space_ids.length) {
    throw new HttpError(422, "target_space_ids must contain unique non-empty strings");
  }
  return {
    resource_type: requiredString(body.resource_type, "resource_type"),
    resource_id: requiredString(body.resource_id, "resource_id"),
    target_space_ids: targetSpaceIds,
  };
}

function requiredParam(request: Parameters<typeof params>[0], name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}
