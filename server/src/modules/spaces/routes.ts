import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import {
  authRepositoryFromConfig,
  sessionTokenFromRequest,
  type AuthFailure, sessionRefreshSink } from "../auth/identity.js";
import { spaceRepositoryFromConfig, type SpaceFailure } from "./repository.js";
import { registerSpaceOperationRoutes } from "./operationRoutes.js";

function isFailure(value: unknown): value is AuthFailure {
  return Boolean(value && typeof value === "object" && "statusCode" in value);
}

function isSpaceFailure(value: unknown): value is SpaceFailure {
  return Boolean(value && typeof value === "object" && "statusCode" in value);
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/spaces/:spaceId/members", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope("identity_db_unavailable", "Identity database is unavailable", requestId),
      );
    }
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request), sessionRefreshSink(reply));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.listMembers(user.id, params(request).spaceId ?? "");
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.get("/api/v1/spaces/:spaceId", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, requestId);
    const repository = authRepositoryFromConfig(context.config);
    if (!repository) {
      return sendErrorEnvelope(
        reply,
        502,
        errorEnvelope(
          "identity_db_unavailable",
          "Identity database is unavailable",
          requestId,
        ),
      );
    }
    const user = await repository.getCurrentUser(sessionTokenFromRequest(request), sessionRefreshSink(reply));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const space = await repository.getSpaceForUser(user.id, params(request).spaceId ?? "");
    if (space === null) return reply.code(404).send({ detail: "Space not found" });
    if (isFailure(space)) return reply.code(space.statusCode).send({ detail: space.detail });
    return reply.send(space);
  });

  app.get("/api/v1/spaces/:spaceId/snapshot-defaults", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request), sessionRefreshSink(reply));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.getSnapshotDefaults(user.id, params(request).spaceId ?? "");
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.get("/api/v1/spaces/:spaceId/content-egress", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request), sessionRefreshSink(reply));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.getContentEgressSetting(user.id, params(request).spaceId ?? "");
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  app.get("/api/v1/spaces/:spaceId/retrieval-settings", async (request, reply) => {
    const auth = authRepositoryFromConfig(context.config);
    const spaces = spaceRepositoryFromConfig(context.config);
    if (!auth || !spaces) return reply.code(502).send({ detail: "Database unavailable" });
    const user = await auth.getCurrentUser(sessionTokenFromRequest(request), sessionRefreshSink(reply));
    if (isFailure(user)) return reply.code(user.statusCode).send({ detail: user.detail });
    const result = await spaces.getRetrievalSettings(user.id, params(request).spaceId ?? "");
    if (isSpaceFailure(result)) return reply.code(result.statusCode).send({ detail: result.detail });
    return reply.send(result);
  });

  registerSpaceOperationRoutes(app, context);
}
