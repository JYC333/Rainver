import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, optionalString, params, parsePage, query, requiredString, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import { ProjectAgentReadService } from "./projectAgents.js";

/** The Project's Agent list: three Project-read gated reads and the two retained command URLs. */
export function registerProjectAgentRoutes(app: FastifyInstance, context: ModuleContext): void {
  const reads = () => {
    if (!context.config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new ProjectAgentReadService(getDbPool(context.config.databaseUrl));
  };

  app.get("/api/v1/projects/:projectId/agents", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await reads().list(identity, projectId, { ...parsePage(q, 50), q: optionalString(q.q) ?? null }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // One link: 404 when the Agent is not on the list or not readable by the viewer — no existence hint.
  app.get("/api/v1/projects/:projectId/agents/:agentId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const agentId = requiredString(params(request).agentId, "agent_id");
      const agent = await reads().get(identity, projectId, agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      return reply.send(agent);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/agent-candidates", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await reads().candidates(identity, projectId, { ...parsePage(q, 50), q: optionalString(q.q) ?? null }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  registerOperationAdapters(app, context.config, [
    { method: "POST", url: "/api/v1/projects/:projectId/agents", operation: "project.agent.add", params: { projectId: "project_id" } },
    { method: "DELETE", url: "/api/v1/projects/:projectId/agents/:agentId", operation: "project.agent.remove", params: { projectId: "project_id", agentId: "agent_id" } },
  ]);
}
