import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  HttpError,
  jsonBody,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common";
import { FocusAreaService } from "./service";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
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

  app.post("/api/v1/focus-areas", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await service().create(identity, jsonBody(request)));
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

  app.patch("/api/v1/focus-areas/:focusAreaId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().update(identity, params(request).focusAreaId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Classification lives with this module rather than with each content module:
  // it is one concept applied to several object kinds, not a property of any.
  /**
   * `null` clears the classification and is meaningful, so a missing or
   * malformed field must not be read as one — that would silently unfile
   * content and answer 204.
   */
  const focusAreaIdFromBody = (body: Record<string, unknown>): string | null => {
    if (!("focus_area_id" in body)) throw new HttpError(422, "focus_area_id is required");
    const value = body.focus_area_id;
    if (value === null) return null;
    const parsed = optionalString(value);
    if (!parsed) throw new HttpError(422, "focus_area_id must be a non-empty string or null");
    return parsed;
  };

  app.put("/api/v1/space-objects/:objectId/focus-area", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await service().setObjectFocusArea(
        identity,
        params(request).objectId ?? "",
        focusAreaIdFromBody(jsonBody(request)),
      );
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/projects/:projectId/focus-area", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await service().setProjectFocusArea(
        identity,
        params(request).projectId ?? "",
        focusAreaIdFromBody(jsonBody(request)),
      );
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/focus-areas/:focusAreaId/contents", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().contents(identity, params(request).focusAreaId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
