import { registerOperationAdapterRoutes } from "../projects/monitoring/operationRoutes.js";
import type { FastifyInstance } from "fastify";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  params,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { ImportedSessionService } from "./service.js";
import { ImportedHistoryExtractionService } from "./extraction.js";
import { importedSessionRecordToWire, importedSessionToWire } from "./wire.js";

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
  registerOperationAdapterRoutes(app, context, [['POST', '/api/v1/projects/:projectId/imported-sessions/extraction', 'project.imported_sessions.extract']]);
  // Consent, import and session changes are core operations (`operations.ts`, `hosts/operations.ts`);
  // a sync is a durable Host command whose report is read from its status.
  const location = { locationId: 'location_id' };
  registerOperationAdapters(app, context.config, [
    { method: 'PUT', url: '/api/v1/workspace-locations/:locationId/ambient-sessions/policy', operation: 'host.location.ambient.policy.set', params: location },
    { method: 'POST', url: '/api/v1/workspace-locations/:locationId/ambient-sessions/dismiss', operation: 'host.location.ambient.dismiss', params: location },
    { method: 'POST', url: '/api/v1/workspace-locations/:locationId/ambient-sessions/sync', operation: 'host.location.ambient.sync', params: location },
    { method: 'PATCH', url: '/api/v1/imported-sessions/:sessionId', operation: 'imported_session.visibility.set', params: { sessionId: 'session_id' } },
    { method: 'POST', url: '/api/v1/imported-sessions/delete', operation: 'imported_session.delete' },
  ]);
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



  app.get("/api/v1/workspace-locations/:locationId/ambient-sessions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send({ sessions: (await service().list(identity, locationId(request))).map(importedSessionToWire) });
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
      return reply.send({ sessions: (await service().listForProject(identity, projectId)).map(importedSessionToWire) });
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


  app.get("/api/v1/imported-sessions/:sessionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const read = await service().records(identity, sessionId(request));
      return reply.send({
        session: importedSessionToWire(read.session),
        records: read.records.map(importedSessionRecordToWire),
        truncated: read.truncated,
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


}
