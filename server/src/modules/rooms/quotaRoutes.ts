import type { FastifyInstance, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { getDbPool, type PoolClient } from "../../db/pool.js";
import { assertProjectWriter } from "../projects/access.js";
import { HttpError, params, resolveIdentity, sendRouteError, withDbTransaction } from "../routeUtils/common.js";
import { continueHeldRuns, conversationQuota } from "./quotaGate.js";
import { PgRoomRepository } from "./repository.js";

/**
 * A conversation's subscription quota (`modules/rooms.md`, "Subscription
 * quota gate"): read the Space's lines, its logins' windows and what is held; and
 * "continue anyway", which admits what is held now (`quotaGate.ts`).
 *
 * - `GET  /api/v1/rooms/:roomId/conversations/:sessionId/quota` — any member
 * - `POST /api/v1/rooms/:roomId/conversations/:sessionId/quota/continue` — Project writer
 */
export function registerQuotaRoutes(app: FastifyInstance, context: ModuleContext): void {
  const base = "/api/v1/rooms/:roomId/conversations/:sessionId/quota";

  app.get(base, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const quota = await withDbTransaction(pool(context), async (client) => {
        await requireConversation(client, identity, request, false);
        return conversationQuota(client, identity.spaceId, sessionId(request), identity.userId);
      });
      return reply.send(protocol.RoomConversationQuotaSchema.parse(quota));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/continue`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const quota = await withDbTransaction(pool(context), async (client) => {
        await requireConversation(client, identity, request, true);
        await continueHeldRuns(client, { spaceId: identity.spaceId, sessionId: sessionId(request), userId: identity.userId });
        return conversationQuota(client, identity.spaceId, sessionId(request), identity.userId);
      });
      return reply.send(protocol.RoomConversationQuotaSchema.parse(quota));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

/**
 * The Room must be visible and the conversation in it; continuing anyway is
 * a decision to spend, so it takes Project writer authority like adding
 * rounds does.
 */
async function requireConversation(
  client: PoolClient,
  identity: { spaceId: string; userId: string },
  request: FastifyRequest,
  writer: boolean,
): Promise<void> {
  const rooms = new PgRoomRepository(client);
  const room = await rooms.getVisibleRoom(identity.spaceId, identity.userId, roomId(request), writer);
  if (!room) throw new HttpError(404, "Room not found in this space");
  if (writer) await assertProjectWriter(client, identity.spaceId, room.project_id, identity.userId);
  const conversation = await rooms.getConversation(identity.spaceId, room.id, sessionId(request));
  if (!conversation) throw new HttpError(404, "Room conversation not found");
}

function pool(context: ModuleContext) {
  if (!context.config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
  return getDbPool(context.config.databaseUrl);
}

function roomId(request: FastifyRequest): string {
  return params(request).roomId ?? "";
}

function sessionId(request: FastifyRequest): string {
  return params(request).sessionId ?? "";
}
