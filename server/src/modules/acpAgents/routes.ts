import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { getDbPool } from "../../db/pool.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { requireInstanceAdmin } from "../routeUtils/access.js";
import { AcpRegistryError, fetchAcpRegistry } from "./registry.js";
import { AcpAgentService, acpAgentAdapterType } from "./service.js";
import type { EnabledAcpAgent } from "./settings.js";

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ spaceId: string; userId: string } | null> {
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(context.config, request);
  if (identity.ok) return { spaceId: identity.spaceId, userId: identity.userId };
  if (identity.reason === "denied") {
    reply.code(identity.statusCode).header("content-type", "application/json").send(identity.body);
    return null;
  }
  await sendErrorEnvelope(reply, 502, errorEnvelope("identity_unavailable", "Identity introspection failed", requestId));
  return null;
}

function agentOut(agent: EnabledAcpAgent, installedOn: Array<{ host_id: string; name: string }> = []) {
  return { ...agent, adapter_type: acpAgentAdapterType(agent.id), installed_on: installedOn };
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AcpRegistryError) return reply.code(error.statusCode).send({ detail: error.message, error_code: error.code });
  throw error;
}

/**
 * Enabling a registry agent is an instance-wide decision (the adapter
 * catalog is one per deployment) and so is instance-admin gated, like
 * installing a runtime tool. Installing it on a host is the host owner's
 * (`hosts` module, `POST /api/v1/hosts/:hostId/installations/:adapterType`).
 */
export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = () => {
    if (!context.config.databaseUrl) throw new AcpRegistryError("database_unavailable", "SERVER_DATABASE_URL is required.", 502);
    return new AcpAgentService(getDbPool(context.config.databaseUrl));
  };

  app.get("/api/v1/acp-agents/registry", async (request, reply) => {
    if (!(await resolveIdentity(context, request, reply))) return reply;
    try {
      return reply.send({ items: await fetchAcpRegistry() });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/v1/acp-agents", async (request, reply) => {
    if (!(await resolveIdentity(context, request, reply))) return reply;
    try {
      const agents = service();
      const items = await Promise.all((await agents.listEnabled()).map(async (agent) => agentOut(agent, await agents.installedOn(agent.id))));
      return reply.send({ items });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put("/api/v1/acp-agents/:registryId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try {
      const agent = await service().enable(params(request).registryId ?? "", identity.userId);
      return reply.code(201).send(agentOut(agent));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/api/v1/acp-agents/:registryId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try {
      const removed = await service().disable(params(request).registryId ?? "", identity.userId);
      return removed ? reply.code(204).send() : reply.code(404).send({ detail: "ACP agent is not enabled" });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
