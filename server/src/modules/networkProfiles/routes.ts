import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { registerOperationAdapters, type OperationAdapterRoute } from "../systemActions/operations/routeAdapter.js";
import { requireSpaceOwnerOrAdmin } from "../routeUtils/access.js";
import {
  NetworkProfileError,
  resolveNetworkProfileRepository,
} from "./repository.js";

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}




async function resolveIdentity(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ spaceId: string; userId: string } | null> {
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(config, request, reply);
  if (identity.ok) return { spaceId: identity.spaceId, userId: identity.userId };
  if (identity.reason === "denied") {
    reply.code(identity.statusCode);
    reply.header("content-type", "application/json");
    reply.send(identity.body);
    return null;
  }
  await sendErrorEnvelope(
    reply,
    502,
    errorEnvelope(
      identity.reason === "contract_violation"
        ? "introspect_contract_violation"
        : "identity_unavailable",
      "Identity introspection failed",
      requestId,
    ),
  );
  return null;
}

function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  const statusCode = error instanceof NetworkProfileError ? error.statusCode : 400;
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(statusCode).send({ detail: message });
}

/** Retained write URLs bound to `network_profile.*` (`operations.ts`). */
export const NETWORK_PROFILE_OPERATION_ROUTES: readonly OperationAdapterRoute[] = [
  { method: "POST", url: "/api/v1/network-profiles", operation: "network_profile.create" },
  { method: "PATCH", url: "/api/v1/network-profiles/:profileId", operation: "network_profile.update", params: { profileId: "profile_id" } },
  { method: "DELETE", url: "/api/v1/network-profiles/:profileId", operation: "network_profile.delete", params: { profileId: "profile_id" } },
];

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerOperationAdapters(app, context.config, NETWORK_PROFILE_OPERATION_ROUTES);
  app.get("/api/v1/network-profiles", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceOwnerOrAdmin(context.config, identity, reply))) return reply;
    try {
      return reply.send(await resolveNetworkProfileRepository(context.config).list(identity.spaceId));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/network-profiles/:profileId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceOwnerOrAdmin(context.config, identity, reply))) return reply;
    try {
      const value = await resolveNetworkProfileRepository(context.config).get(
        identity.spaceId,
        params(request).profileId ?? "",
      );
      if (!value) return reply.code(404).send({ detail: "Network profile not found" });
      return reply.send(value);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

}
