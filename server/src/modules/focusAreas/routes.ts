import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {registerProjectManagementOperationRoutes} from '../projects/managementOperationRoutes.js';
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  intQuery,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { FOCUS_AREA_CONTENTS_PAGE_SIZE, FocusAreaService } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerProjectManagementOperationRoutes(app,context,'focusAreas');
  registerOperationAdapters(app,context.config,[{"method": "POST", "url": "/api/v1/focus-areas", "operation": "focus_area.create"}, {"method": "PATCH", "url": "/api/v1/focus-areas/:focusAreaId", "operation": "focus_area.update", "params": {"focusAreaId": "focus_area_id"}}, {"method": "PUT", "url": "/api/v1/space-objects/:objectId/focus-area", "operation": "focus_area.object.set", "params": {"objectId": "object_id"}}]);
  const service = () => FocusAreaService.fromConfig(context.config);

  app.get("/api/v1/focus-areas", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const includeArchived = optionalString(query(request).include_archived) === "true";
      return reply.send(await service().list(identity, includeArchived));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/focus-areas/:focusAreaId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().get(identity, params(request).focusAreaId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/focus-areas/:focusAreaId/contents", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const limit = intQuery(q.limit, FOCUS_AREA_CONTENTS_PAGE_SIZE);
      if (limit === null) throw new HttpError(422, "limit must be an integer");
      return reply.send(await service().contents(identity, params(request).focusAreaId ?? "", {
        projectsCursor: optionalString(q.projects_cursor) ?? undefined,
        objectsCursor: optionalString(q.objects_cursor) ?? undefined,
        limit,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
