import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { AgentGroupRunService } from "./service.js";

type AgentGroupsServicePort = Pick<
  AgentGroupRunService,
  | "listGroups"
  | "getGroup"
  | "getTimeline"
  | "getTrace"
>;

type AgentGroupsServiceFactory = (context: ModuleContext) => AgentGroupsServicePort;

let serviceFactoryOverride: AgentGroupsServiceFactory | null = null;

export function __setAgentGroupsServiceFactoryForTests(
  factory: AgentGroupsServiceFactory | null,
): void {
  serviceFactoryOverride = factory;
}

function service(context: ModuleContext): AgentGroupsServicePort {
  return serviceFactoryOverride?.(context) ?? AgentGroupRunService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {

  app.get("/api/v1/agent-groups", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 50);
      const result = await service(context).listGroups(identity, {
        status: optionalString(q.status),
        limit,
        offset,
      });
      return reply.send(result);
    } catch (error) {
      return sendAgentGroupError(reply, error);
    }
  });

  app.get("/api/v1/agent-groups/:groupId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).getGroup(identity, routeGroupId(request)));
    } catch (error) {
      return sendAgentGroupError(reply, error);
    }
  });



  app.get("/api/v1/agent-groups/:groupId/timeline", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 100);
      return reply.send(
        await service(context).getTimeline(identity, routeGroupId(request), { limit, offset }),
      );
    } catch (error) {
      return sendAgentGroupError(reply, error);
    }
  });

  app.get("/api/v1/agent-groups/:groupId/trace", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).getTrace(identity, routeGroupId(request)));
    } catch (error) {
      return sendAgentGroupError(reply, error);
    }
  });

  const group = { groupId: "group_id" };
  registerOperationAdapters(app, context.config, [
    { method: "POST", url: "/api/v1/agent-groups", operation: "agent_group.create" },
    { method: "PATCH", url: "/api/v1/agent-groups/:groupId", operation: "agent_group.update", params: group },
    // The message body has always carried its group id; it must equal the URL's.
    { method: "POST", url: "/api/v1/agent-groups/:groupId/messages", operation: "agent_group.message.send", params: group, restated: ["group_id"] },
    { method: "POST", url: "/api/v1/agent-groups/:groupId/pause", operation: "agent_group.status.set", params: group, fixed: { status: "paused" } },
    { method: "POST", url: "/api/v1/agent-groups/:groupId/resume", operation: "agent_group.status.set", params: group, fixed: { status: "active" } },
    { method: "POST", url: "/api/v1/agent-groups/:groupId/cancel", operation: "agent_group.status.set", params: group, fixed: { status: "cancelled" } },
  ]);
}


function routeGroupId(request: FastifyRequest): string {
  return params(request).groupId ?? "";
}


function sendAgentGroupError(reply: FastifyReply, error: unknown): FastifyReply {
  if (isZodError(error)) {
    return reply.code(422).send({ detail: error.message });
  }
  return sendRouteError(reply, error);
}

function isZodError(error: unknown): error is Error {
  return error instanceof Error && error.name === "ZodError";
}
