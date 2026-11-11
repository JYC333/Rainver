import { registerOperationAdapters, type OperationAdapterRoute } from "../systemActions/operations/routeAdapter.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  optionalString,
  params,
  parsePage,
  query,
  resolveIdentity,
  sendRouteError, requiredString } from "../routeUtils/common.js";
import { RoomService } from "./service.js";

type RoomServicePort = Pick<
  RoomService,
  | "listRooms"
  | "getRoom"
  | "getProjectMainline"
  | "listProjectConversations"
  | "listAgentCandidates"
  | "listInvitations"
  | "listPendingApprovals"
  | "listConversations"
  | "listMessages"
  | "prepareReferenceSummaries"
>;
type RoomServiceFactory = (context: ModuleContext) => RoomServicePort;
let serviceFactoryOverride: RoomServiceFactory | null = null;

export function __setRoomServiceFactoryForTests(
  factory: RoomServiceFactory | null,
): void {
  serviceFactoryOverride = factory;
}

function service(context: ModuleContext): RoomServicePort {
  return serviceFactoryOverride?.(context) ?? RoomService.fromConfig(context.config);
}

/** Retained Room URLs; each is a formal adapter for one core operation. */
export function roomOperationRoutes(context: ModuleContext): readonly OperationAdapterRoute[] {
  const room = { roomId: "room_id" };
  const conversation = { roomId: "room_id", sessionId: "session_id" };
  return [
    { method: "POST", url: "/api/v1/rooms", operation: "room.create" },
    { method: "POST", url: "/api/v1/rooms/:roomId/agents", operation: "room.agent.add", params: room },
    { method: "POST", url: "/api/v1/rooms/:roomId/agent-presets", operation: "room.agent.add_preset", params: room },
    { method: "DELETE", url: "/api/v1/rooms/:roomId/agents/:agentId", operation: "room.agent.remove", params: { ...room, agentId: "agent_id" } },
    { method: "POST", url: "/api/v1/rooms/:roomId/agents/:agentId/reset-context", operation: "room.agent.reset_context", params: { ...room, agentId: "agent_id" } },
    { method: "POST", url: "/api/v1/rooms/:roomId/agents/:agentId/summarize-context", operation: "room.agent.summarize_context", params: { ...room, agentId: "agent_id" } },
    { method: "POST", url: "/api/v1/rooms/:roomId/agents/:agentId/restart-from-summary", operation: "room.agent.restart_from_summary", params: { ...room, agentId: "agent_id" } },
    { method: "POST", url: "/api/v1/rooms/:roomId/invitations", operation: "room.invitation.create", params: room },
    { method: "POST", url: "/api/v1/rooms/:roomId/invitations/:invitationId/decision", operation: "room.invitation.decide", params: { ...room, invitationId: "invitation_id" } },
    { method: "DELETE", url: "/api/v1/rooms/:roomId/members/:userId", operation: "room.member.remove", params: { ...room, userId: "user_id" } },
    { method: "POST", url: "/api/v1/rooms/:roomId/owner-transfer", operation: "room.owner.transfer", params: room },
    { method: "POST", url: "/api/v1/rooms/:roomId/owner-claim", operation: "room.owner.claim", params: room },
    { method: "POST", url: "/api/v1/rooms/:roomId/conversations", operation: "room.conversation.create", params: room },
    {
      method: "POST", url: "/api/v1/rooms/:roomId/conversations/:sessionId/references", operation: "room.conversation.attach_references", params: conversation,
      // Owner-funded imported-session summaries are generated here, before the
      // operation's transaction, exactly where the attach always prepared them.
      prepare: (identity, input) => service(context).prepareReferenceSummaries(identity, String(input.room_id), (Array.isArray(input.references) ? input.references : []) as never),
    },
    { method: "POST", url: "/api/v1/rooms/:roomId/conversations/:sessionId/messages", operation: "room.message.send", params: conversation },
    { method: "DELETE", url: "/api/v1/rooms/:roomId/conversations/:sessionId/queued-messages/:queuedId", operation: "room.message.withdraw_queued", params: { ...conversation, queuedId: "queued_id" } },
    { method: "POST", url: "/api/v1/rooms/:roomId/conversations/:sessionId/retry", operation: "room.message.retry", params: conversation },
    { method: "POST", url: "/api/v1/rooms/:roomId/conversations/:sessionId/proposal-continuations", operation: "room.message.continue_after_proposal", params: conversation },
    { method: "POST", url: "/api/v1/rooms/:roomId/conversations/:sessionId/quota/continue", operation: "room.quota.continue", params: conversation },
    { method: "POST", url: "/api/v1/rooms/:roomId/conversations/:sessionId/discussions", operation: "room.discussion.start", params: conversation },
    { method: "POST", url: "/api/v1/rooms/:roomId/conversations/:sessionId/discussions/:discussionId/stop", operation: "room.discussion.stop", params: { ...conversation, discussionId: "discussion_id" } },
    { method: "POST", url: "/api/v1/rooms/:roomId/conversations/:sessionId/discussions/:discussionId/extend", operation: "room.discussion.extend", params: { ...conversation, discussionId: "discussion_id" } },
  ];
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {

  app.get("/api/v1/rooms", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const page = parsePage(q, 50);
      return reply.send(await service(context).listRooms(identity, {
        ...page,
        project_id: optionalString(q.project_id),
      }));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.get("/api/v1/rooms/pending-approvals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listPendingApprovals(
        identity,
        parsePage(query(request), 50),
      ));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.get("/api/v1/rooms/:roomId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).getRoom(identity, roomId(request)));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/mainline-room", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await service(context).getProjectMainline(identity, projectId));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/conversations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const page = parsePage(query(request), 50);
      return reply.send(await service(context).listProjectConversations(identity, projectId, page));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.get("/api/v1/rooms/:roomId/agent-candidates", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listAgentCandidates(
        identity,
        roomId(request),
        parsePage(query(request), 50),
      ));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });







  app.get("/api/v1/rooms/:roomId/invitations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      // `invitation_id` reads one exact invitation (a command receipt's), under the same access as the page.
      const invitationId = query(request).invitation_id;
      return reply.send(await service(context).listInvitations(
        identity,
        roomId(request),
        { ...parsePage(query(request), 50), ...(invitationId ? { invitation_id: invitationId } : {}) },
      ));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });






  app.get("/api/v1/rooms/:roomId/conversations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await service(context).listConversations(
          identity,
          roomId(request),
          parsePage(query(request), 50),
        ),
      );
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });


  app.get(
    "/api/v1/rooms/:roomId/conversations/:sessionId/messages",
    async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        return reply.send(
          await service(context).listMessages(
            identity,
            roomId(request),
            sessionId(request),
            // `message_id` reads one exact message (a command receipt's) however old it is.
            { ...parsePage(query(request), 200), ...(query(request).message_id ? { message_id: query(request).message_id } : {}) },
          ),
        );
      } catch (error) {
        return sendRoomError(reply, error);
      }
    },
  );
  registerOperationAdapters(app, context.config, roomOperationRoutes(context));
}

function roomId(request: FastifyRequest): string {
  return params(request).roomId ?? "";
}

function sessionId(request: FastifyRequest): string {
  return params(request).sessionId ?? "";
}

function sendRoomError(reply: Parameters<typeof sendRouteError>[0], error: unknown) {
  if (error instanceof Error && error.name === "ZodError") {
    return reply.code(422).send({ detail: error.message });
  }
  return sendRouteError(reply, error);
}
