import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  jsonBody,
  optionalString,
  params,
  parsePage,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common";
import { loadProtocol } from "../providers/protocolRuntime";
import { RoomService } from "./service";

type RoomServicePort = Pick<
  RoomService,
  | "createRoom"
  | "listRooms"
  | "getRoom"
  | "createConversation"
  | "listConversations"
  | "listMessages"
  | "sendMessage"
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
      const protocol = await loadProtocol();
      const body = protocol.CreateRoomRequestSchema.parse(jsonBody(request));
      return reply.code(201).send(await service(context).createRoom(identity, body));
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

  app.get("/api/v1/rooms/:roomId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).getRoom(identity, roomId(request)));
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/rooms/:roomId/conversations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const body = protocol.CreateRoomConversationRequestSchema.parse(jsonBody(request));
      return reply.code(201).send(
        await service(context).createConversation(identity, roomId(request), body),
      );
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
            parsePage(query(request), 200),
          ),
        );
      } catch (error) {
        return sendRoomError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/rooms/:roomId/conversations/:sessionId/messages",
    async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        const protocol = await loadProtocol();
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
