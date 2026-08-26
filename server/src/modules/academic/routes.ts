import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { HttpError, dbPool, jsonBody, optionalString, params, parsePage, query, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { applyContentCreationContext, resolveContentCreationContext } from "../access/creationContext.js";
import { AcademicService } from "./service.js";

let serviceFactoryOverride: ((context: ModuleContext) => AcademicService) | null = null;

export function __setAcademicServiceFactoryForTests(factory: ((context: ModuleContext) => AcademicService) | null): void {
  serviceFactoryOverride = factory;
}

function service(context: ModuleContext): AcademicService {
  if (serviceFactoryOverride) return serviceFactoryOverride(context);
  return AcademicService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/api/v1/academic/papers", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.code(201).send(await service(context).createPaper(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/academic/papers", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await service(context).listPapers(identity, { q: optionalString(q.q), ...parsePage(q) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/academic/papers/:objectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).getPaper(identity, requireParam(request, "objectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/academic/papers/:objectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).updatePaper(identity, requireParam(request, "objectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/academic/papers/:objectId/authors", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(202)
        .send(await service(context).linkAuthor(identity, requireParam(request, "objectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/academic/papers/:objectId/authors", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listAuthors(identity, requireParam(request, "objectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/academic/papers/:objectId/citations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(202)
        .send(await service(context).linkCitation(identity, requireParam(request, "objectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/academic/papers/:objectId/citations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listCitations(identity, requireParam(request, "objectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/academic/papers/:objectId/cited-by", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listCitedBy(identity, requireParam(request, "objectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function requireParam(request: Parameters<typeof params>[0], name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}
