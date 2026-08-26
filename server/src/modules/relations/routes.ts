import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  intQuery,
  jsonBody,
  optionalString,
  params,
  parsePage,
  query,
  resolveIdentity,
  sendRouteError,
  dbPool,
} from "../routeUtils/common.js";
import { applyContentCreationContext, resolveContentCreationContext } from "../access/creationContext.js";
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
  app.post("/api/v1/relations/people", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.code(201).send(await service(context).createPerson(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

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

  app.patch("/api/v1/relations/people/:objectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await service(context).updatePerson(identity, requireParam(request, "objectId"), jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/relations/people/:objectId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await service(context).archivePerson(identity, requireParam(request, "objectId"));
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/relations/organizations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.code(201).send(await service(context).createOrganization(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
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

  app.post("/api/v1/relations/:objectId/identities", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await service(context).createIdentity(identity, requireParam(request, "objectId"), jsonBody(request)));
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

  app.delete("/api/v1/relations/identities/:identityId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await service(context).deleteIdentity(identity, requireParam(request, "identityId"));
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/relations/affiliations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(202).send(await service(context).createAffiliation(identity, jsonBody(request)));
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

  app.post("/api/v1/relations/affiliations/:affiliationId/end", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      return reply.code(202).send(
        await service(context).endAffiliation(identity, requireParam(request, "affiliationId"), optionalString(body.end_date)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/relations/:objectId/notes", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await service(context).createNote(identity, requireParam(request, "objectId"), jsonBody(request)));
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

  app.post("/api/v1/relations/:objectId/source-links", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await service(context).createSourceLink(identity, requireParam(request, "objectId"), jsonBody(request)));
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
