import {registerRelationOperationRoutes} from './operationRoutes.js';
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  intQuery,
  optionalString,
  params,
  parsePage,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { RelationsService } from "./service.js";

let serviceFactoryOverride: ((context: ModuleContext) => RelationsService) | null = null;

export function __setRelationsServiceFactoryForTests(factory: ((context: ModuleContext) => RelationsService) | null): void {
  serviceFactoryOverride = factory;
}

function service(context: ModuleContext): RelationsService {
  if (serviceFactoryOverride) return serviceFactoryOverride(context);
  return RelationsService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerRelationOperationRoutes(app,context);

  app.get("/api/v1/relations/people", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(
        await service(context).listPeople(identity, { q: optionalString(q.q), ...parsePage(q) }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/relations/people/:objectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).getPerson(identity, requireParam(request, "objectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });




  app.get("/api/v1/relations/organizations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(
        await service(context).listOrganizations(identity, { q: optionalString(q.q), ...parsePage(q) }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/relations/organizations/:objectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).getOrganization(identity, requireParam(request, "objectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/relations/search", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const term = optionalString(q.q);
      if (!term) throw new HttpError(422, "q is required");
      return reply.send(await service(context).search(identity, term, intQuery(q.limit, 20) ?? 20));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/relations/:objectId/identities", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listIdentities(identity, requireParam(request, "objectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });



  app.get("/api/v1/relations/affiliations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(
        await service(context).listAffiliations(identity, {
          personObjectId: optionalString(q.person_object_id),
          organizationObjectId: optionalString(q.organization_object_id),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });



  app.get("/api/v1/relations/:objectId/notes", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listNotes(identity, requireParam(request, "objectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/relations/:objectId/source-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listSourceLinks(identity, requireParam(request, "objectId")));
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
