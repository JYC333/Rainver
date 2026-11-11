import { isRepositoryAcpRegistryId } from "@rainver/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { getDbPool } from "../../db/pool.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { isInstanceAdmin } from "../routeUtils/access.js";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import { AcpRegistryError, fetchAcpRegistry } from "./registry.js";
import { AcpAgentService, acpAgentRuntimeKey } from "./service.js";
import type { EnabledAcpAgent } from "./settings.js";


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
  return { ...agent, runtime_key: acpAgentRuntimeKey(agent.id), installed_on: installedOn };
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AcpRegistryError) return reply.code(error.statusCode).send({ detail: error.message, error_code: error.code });
  throw error;
}

/**
 * Enabling a registry agent is an instance-wide decision (the adapter
 * catalog is one per deployment) and so is instance-admin gated, like
 * installing a runtime tool. Installing it on a host is the host owner's
 * (`hosts` module, `POST /api/v1/hosts/:hostId/installations/:runtimeKey`).
 */
export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerOperationAdapters(app, context.config, [
    {
      method: "PUT", url: "/api/v1/acp-agents/:registryId", operation: "acp_agent.enable", params: { registryId: "registry_id" },
      // The registry is read before, never inside, the transaction, and only for the instance
      // admin (nobody else spends the fetch). A failed read leaves the operation to refuse.
      prepare: async (identity) => {
        if (await isInstanceAdmin(context.config, identity.userId)) await fetchAcpRegistry().catch(() => undefined);
      },
    },
    { method: "DELETE", url: "/api/v1/acp-agents/:registryId", operation: "acp_agent.disable", params: { registryId: "registry_id" } },
  ]);
  const service = () => {
    if (!context.config.databaseUrl) throw new AcpRegistryError("database_unavailable", "SERVER_DATABASE_URL is required.", 502);
    return new AcpAgentService(getDbPool(context.config.databaseUrl));
  };

  app.get("/api/v1/acp-agents/registry", async (request, reply) => {
    if (!(await resolveIdentity(context, request, reply))) return reply;
    try {
      return reply.send({ items: (await fetchAcpRegistry()).filter(entry => !isRepositoryAcpRegistryId(entry.id)) });
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
}
