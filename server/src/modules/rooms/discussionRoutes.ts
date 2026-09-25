import type { FastifyInstance, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, jsonBody, params, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { RoomDiscussionService } from "./discussionService.js";

/**
 * Room discussions (`discussionService.ts`): open one explicitly, read them,
 * stop one, or give one stopped at its cap more rounds. Discussions that open
 * on their own — an Agent addressing another — have no route; they start from
 * a finished turn.
 */
export function registerDiscussionRoutes(app: FastifyInstance, context: ModuleContext): void {
  const base = "/api/v1/rooms/:roomId/conversations/:sessionId/discussions";

  app.post(base, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.OpenRoomDiscussionRequestSchema.parse(jsonBody(request));
      const opened = await service(context).open(identity, roomId(request), sessionId(request), body);
      return reply.code(201).send(protocol.OpenRoomDiscussionResponseSchema.parse(opened));
    } catch (error) {
      return sendDiscussionError(reply, error);
    }
  });

  app.get(base, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(protocol.RoomDiscussionListResponseSchema.parse(
        await service(context).list(identity, roomId(request), sessionId(request)),
      ));
    } catch (error) {
      return sendDiscussionError(reply, error);
    }
  });

  app.get(`${base}/:discussionId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(protocol.RoomDiscussionDetailSchema.parse(
        await service(context).get(identity, roomId(request), sessionId(request), discussionId(request)),
      ));
    } catch (error) {
      return sendDiscussionError(reply, error);
    }
  });

  app.post(`${base}/:discussionId/stop`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(protocol.RoomDiscussionSchema.parse(
        await service(context).stop(identity, roomId(request), sessionId(request), discussionId(request)),
      ));
    } catch (error) {
      return sendDiscussionError(reply, error);
    }
  });

  app.post(`${base}/:discussionId/extend`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.ExtendRoomDiscussionRequestSchema.parse(jsonBody(request));
      return reply.send(protocol.RoomDiscussionSchema.parse(
        await service(context).extend(identity, roomId(request), sessionId(request), discussionId(request), body.rounds),
      ));
    } catch (error) {
      return sendDiscussionError(reply, error);
    }
  });
}

function service(context: ModuleContext): RoomDiscussionService {
  if (!context.config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  return new RoomDiscussionService(context.config, getDbPool(context.config.databaseUrl));
}

function roomId(request: FastifyRequest): string {
  return params(request).roomId ?? "";
}

function sessionId(request: FastifyRequest): string {
  return params(request).sessionId ?? "";
}

function discussionId(request: FastifyRequest): string {
  return params(request).discussionId ?? "";
}

function sendDiscussionError(reply: Parameters<typeof sendRouteError>[0], error: unknown) {
  if (error instanceof Error && error.name === "ZodError") {
    return reply.code(422).send({ detail: error.message });
  }
  return sendRouteError(reply, error);
}
