import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  jsonBody,
  params,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { ImportedSessionService } from "./service.js";
import { ImportedHistoryExtractionService } from "./extraction.js";

/**
 * Ambient session import lives on the Location, because consent is about one
 * folder on one machine; reading lives on the Project and the session,
 * because that is what a person opens.
 *
 * The two halves are gated differently and deliberately. Importing, changing
 * a policy, and deleting resolve the Location first and require the host's
 * registered owner (ADR 0016) plus Project write — importing is the owner's
 * act on their own machine. Reading goes through the canonical content
 * predicate instead: a session shared into the Project is ordinary Project
 * content that a teammate reads like anything else, and a private one stays
 * with its owner by the same predicate.
 */
export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = () => ImportedSessionService.fromConfig(context.config);
  const extraction = () => new ImportedHistoryExtractionService(dbPool(context.config), context.config);
  const locationId = (request: Parameters<typeof params>[0]): string => {
    const value = params(request).locationId;
    if (typeof value !== "string" || !value) throw new HttpError(422, "locationId is required");
    return value;
  };
  const sessionId = (request: Parameters<typeof params>[0]): string => {
    const value = params(request).sessionId;
    if (typeof value !== "string" || !value) throw new HttpError(422, "sessionId is required");
    return value;
  };
  const visibility = (value: unknown): "private" | "space_shared" | undefined => {
    if (value === undefined || value === null) return undefined;
    if (value === "private" || value === "space_shared") return value;
    throw new HttpError(422, "visibility must be private or space_shared");
  };

  app.get("/api/v1/workspace-locations/:locationId/ambient-sessions/offer", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const id = locationId(request);
      const [policy, counts] = await Promise.all([
        service().policy(identity, id),
        service().counts(identity, id),
      ]);
      return reply.send({ policy, counts });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/workspace-locations/:locationId/ambient-sessions/policy", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const adapterType = body.adapter_type;
      if (typeof adapterType !== "string" || !adapterType) throw new HttpError(422, "adapter_type is required");
      if (typeof body.sync !== "boolean") throw new HttpError(422, "sync must be a boolean");
      return reply.send(await service().setPolicy(identity, locationId(request), {
        adapter_type: adapterType,
        installation: typeof body.installation === "string" ? body.installation : undefined,
        sync: body.sync,
        default_visibility: visibility(body.default_visibility),
        auto_extract: typeof body.auto_extract === "boolean" ? body.auto_extract : undefined,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/workspace-locations/:locationId/ambient-sessions/dismiss", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().dismissOffer(identity, locationId(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/workspace-locations/:locationId/ambient-sessions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send({ sessions: await service().list(identity, locationId(request)) });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/workspace-locations/:locationId/ambient-sessions/sync", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const adapterType = body.adapter_type;
      if (typeof adapterType !== "string" || !adapterType) throw new HttpError(422, "adapter_type is required");
      const sessionIds = Array.isArray(body.session_ids)
        ? body.session_ids.filter((value): value is string => typeof value === "string")
        : null;
      return reply.send(await service().sync(identity, locationId(request), {
        adapter_type: adapterType,
        installation: typeof body.installation === "string" ? body.installation : undefined,
        session_ids: sessionIds,
        visibility: visibility(body.visibility),
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/imported-sessions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = params(request).projectId;
      if (typeof projectId !== "string" || !projectId) throw new HttpError(422, "projectId is required");
      return reply.send({ sessions: await service().listForProject(identity, projectId) });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/imported-sessions/extraction", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = params(request).projectId;
      if (typeof projectId !== "string" || !projectId) throw new HttpError(422, "projectId is required");
      return reply.send(await extraction().pending(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/imported-sessions/extraction", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = params(request).projectId;
      if (typeof projectId !== "string" || !projectId) throw new HttpError(422, "projectId is required");
      return reply.send(await extraction().extract(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/imported-sessions/:sessionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().records(identity, sessionId(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/imported-sessions/:sessionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const wanted = visibility(jsonBody(request).visibility);
      if (!wanted) throw new HttpError(422, "visibility is required");
      return reply.send(await service().setVisibility(identity, sessionId(request), wanted));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/imported-sessions/delete", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const ids = jsonBody(request).session_ids;
      if (!Array.isArray(ids) || ids.some((value) => typeof value !== "string")) {
        throw new HttpError(422, "session_ids must be an array of ids");
      }
      return reply.send({ deleted: await service().remove(identity, ids as string[]) });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
