import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  jsonBody,
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import {
  AgentGroupRunService,
  type CreateAgentGroupInput,
  type SendAgentGroupMessageInput,
  type UpdateAgentGroupInput,
} from "./service.js";

type AgentGroupsServicePort = Pick<
  AgentGroupRunService,
  | "createGroup"
  | "listGroups"
  | "getGroup"
  | "updateGroup"
  | "sendUserMessage"
  | "getTimeline"
  | "getTrace"
  | "changeStatus"
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
  app.post("/api/v1/agent-groups", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.CreateAgentRunGroupRequestSchema.parse(jsonBody(request));
      const result = await service(context).createGroup(identity, body as CreateAgentGroupInput);
      return reply.code(201).send(result);
    } catch (error) {
      return sendAgentGroupError(reply, error);
    }
  });

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

  app.patch("/api/v1/agent-groups/:groupId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.UpdateAgentRunGroupRequestSchema.parse(jsonBody(request));
      return reply.send(
        await service(context).updateGroup(identity, {
          ...(body as Omit<UpdateAgentGroupInput, "group_id">),
          group_id: routeGroupId(request),
        }),
      );
    } catch (error) {
      return sendAgentGroupError(reply, error);
    }
  });

  app.post("/api/v1/agent-groups/:groupId/messages", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.SendAgentRunGroupMessageRequestSchema.parse(jsonBody(request));
      assertBodyGroupMatchesRoute(body.group_id, routeGroupId(request));
      const result = await service(context).sendUserMessage(
        identity,
        body as SendAgentGroupMessageInput,
      );
      return reply.code(201).send(result);
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

  app.post("/api/v1/agent-groups/:groupId/pause", statusHandler(context, "paused"));
  app.post("/api/v1/agent-groups/:groupId/resume", statusHandler(context, "active"));
  app.post("/api/v1/agent-groups/:groupId/cancel", statusHandler(context, "cancelled"));
}

function statusHandler(
  context: ModuleContext,
  status: "active" | "paused" | "cancelled",
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await service(context).changeStatus(
          identity,
          routeGroupId(request),
          status,
        ),
      );
    } catch (error) {
      return sendAgentGroupError(reply, error);
    }
  };
}

function routeGroupId(request: FastifyRequest): string {
  return params(request).groupId ?? "";
}

function assertBodyGroupMatchesRoute(bodyGroupId: string, routeGroupIdValue: string): void {
  if (bodyGroupId !== routeGroupIdValue) {
    throw new HttpError(422, "group_id must match the route groupId");
  }
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
