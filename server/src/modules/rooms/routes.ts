import type { FastifyInstance, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  jsonBody,
  optionalString,
  params,
  parsePage,
  query,
  resolveIdentity,
  sendRouteError, requiredString } from "../routeUtils/common.js";
import { RoomService } from "./service.js";

type RoomServicePort = Pick<
  RoomService,
  | "createRoom"
  | "listRooms"
  | "getRoom"
  | "getProjectMainline"
  | "listProjectConversations"
  | "listAgentCandidates"
  | "addAgent"
  | "addAgentPreset"
  | "removeAgent"
  | "resetAgentContext"
  | "inviteUser"
  | "listInvitations"
  | "listPendingApprovals"
  | "decideInvitation"
  | "removeUser"
  | "transferOwner"
  | "claimOwner"
  | "listConversations"
  | "createConversationDraft"
  | "listMessages"
  | "getConversationSummary"
  | "sendMessage"
  | "attachConversationReferences"
  | "continueAfterProposal"
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

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/api/v1/rooms", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.CreateRoomRequestSchema.parse(jsonBody(request));
      const rawIdempotencyKey = request.headers["idempotency-key"];
      const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : null;
      return reply.code(201).send(await service(context).createRoom(identity, {
        ...body,
        idempotency_key: idempotencyKey,
      }));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

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

  app.post("/api/v1/rooms/:roomId/agents", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await service(context).addAgent(
        identity,
        roomId(request),
        protocol.RoomAgentAddRequestSchema.parse(jsonBody(request)),
      ));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/rooms/:roomId/agent-presets", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const rawIdempotencyKey = request.headers["idempotency-key"];
      const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : null;
      return reply.code(201).send(await service(context).addAgentPreset(
        identity,
        roomId(request),
        {
          ...protocol.RoomAgentPresetRequestSchema.parse(jsonBody(request)),
          idempotency_key: idempotencyKey,
        },
      ));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.delete("/api/v1/rooms/:roomId/agents/:agentId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).removeAgent(identity, roomId(request), agentId(request)));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/rooms/:roomId/agents/:agentId/reset-context", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).resetAgentContext(identity, roomId(request), agentId(request)));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.get("/api/v1/rooms/:roomId/invitations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listInvitations(
        identity,
        roomId(request),
        parsePage(query(request), 50),
      ));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/rooms/:roomId/invitations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await service(context).inviteUser(
        identity,
        roomId(request),
        protocol.RoomInvitationCreateRequestSchema.parse(jsonBody(request)),
      ));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/rooms/:roomId/invitations/:invitationId/decision", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).decideInvitation(
        identity,
        roomId(request),
        invitationId(request),
        protocol.RoomInvitationDecisionRequestSchema.parse(jsonBody(request)),
      ));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.delete("/api/v1/rooms/:roomId/members/:userId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).removeUser(identity, roomId(request), userId(request)));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/rooms/:roomId/owner-transfer", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.RoomOwnerTransferRequestSchema.parse(jsonBody(request));
      return reply.send(await service(context).transferOwner(identity, roomId(request), body.user_id));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/rooms/:roomId/owner-claim", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).claimOwner(identity, roomId(request)));
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

  /**
   * Explicitly open a Conversation draft so its execution context can be
   * reviewed and initialized before the first message. Opening the draft is a
   * visible user action, and it never changes a Host or Primary Workspace
   * implicitly.
   */
  app.post("/api/v1/rooms/:roomId/conversations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await service(context).createConversationDraft(identity, roomId(request)),
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
            parsePage(query(request), 200),
          ),
        );
      } catch (error) {
        return sendRoomError(reply, error);
      }
    },
  );

  app.get(
    "/api/v1/rooms/:roomId/conversations/:sessionId/summary",
    async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        return reply.send(await service(context).getConversationSummary(
          identity,
          roomId(request),
          sessionId(request),
        ));
      } catch (error) {
        return sendRoomError(reply, error);
      }
    },
  );

  /**
   * Copy content picked elsewhere into this conversation.
   */
  app.post("/api/v1/rooms/:roomId/conversations/:sessionId/references", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.AttachThreadReferencesRequestSchema.parse(jsonBody(request));
      return reply.code(201).send(
        await service(context).attachConversationReferences(
          identity,
          roomId(request),
          sessionId(request),
          body,
        ),
      );
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post(
    "/api/v1/rooms/:roomId/conversations/:sessionId/messages",
    async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        const body = protocol.SendRoomMessageRequestSchema.parse(jsonBody(request));
        return reply.code(201).send(
          await service(context).sendMessage(
            identity,
            roomId(request),
            sessionId(request),
            body,
          ),
        );
      } catch (error) {
        return sendRoomError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/rooms/:roomId/conversations/:sessionId/proposal-continuations",
    async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        const body = protocol.ContinueRoomAfterProposalRequestSchema.parse(jsonBody(request));
        return reply.code(201).send(
          await service(context).continueAfterProposal(
            identity,
            roomId(request),
            sessionId(request),
            body,
          ),
        );
      } catch (error) {
        return sendRoomError(reply, error);
      }
    },
  );
}

function roomId(request: FastifyRequest): string {
  return params(request).roomId ?? "";
}

function sessionId(request: FastifyRequest): string {
  return params(request).sessionId ?? "";
}

function agentId(request: FastifyRequest): string {
  return params(request).agentId ?? "";
}

function userId(request: FastifyRequest): string {
  return params(request).userId ?? "";
}

function invitationId(request: FastifyRequest): string {
  return params(request).invitationId ?? "";
}

function sendRoomError(reply: Parameters<typeof sendRouteError>[0], error: unknown) {
  if (error instanceof Error && error.name === "ZodError") {
    return reply.code(422).send({ detail: error.message });
  }
  return sendRouteError(reply, error);
}
