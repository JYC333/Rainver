import {registerAcademicOperationRoutes} from './operations.js';
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { HttpError, optionalString, params, parsePage, query, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
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
  registerAcademicOperationRoutes(app,context);

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



  app.get("/api/v1/academic/papers/:objectId/authors", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listAuthors(identity, requireParam(request, "objectId")));
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
