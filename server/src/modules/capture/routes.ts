import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { jsonBody, params, resolveIdentity, sendRouteError } from "../routeUtils/common";
import { loadProtocol } from "../providers/protocolRuntime";
import { CaptureService } from "./service";
import { RelocationService } from "./relocationService";

type RouteService = Pick<CaptureService, "capture">;
type ServiceFactory = (context: ModuleContext) => RouteService;
let serviceFactoryOverride: ServiceFactory | null = null;

type RelocationRouteService = Pick<RelocationService, "preview" | "relocate">;
type RelocationFactory = (context: ModuleContext) => RelocationRouteService;
let relocationFactoryOverride: RelocationFactory | null = null;

export function __setCaptureServiceFactoryForTests(factory: ServiceFactory | null): void {
  serviceFactoryOverride = factory;
}

export function __setRelocationServiceFactoryForTests(factory: RelocationFactory | null): void {
  relocationFactoryOverride = factory;
}

function service(context: ModuleContext): RouteService {
  return serviceFactoryOverride?.(context) ?? CaptureService.fromConfig(context.config);
}

function relocation(context: ModuleContext): RelocationRouteService {
  return relocationFactoryOverride?.(context) ?? RelocationService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/api/v1/captures", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const body = protocol.CaptureRequestSchema.parse(jsonBody(request));
      const result = await service(context).capture({
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        destination: body.destination,
        text: body.text,
        ...(body.project_id === undefined ? {} : { projectId: body.project_id }),
        ...(body.target_id === undefined ? {} : { targetId: body.target_id }),
      });
      return reply.code(201).send(protocol.CaptureResponseSchema.parse(result));
    } catch (error) {
      // A rejected body is the client's error, not a server fault. Without
      // this a paste over the length limit — the most ordinary way to hit it —
      // would come back as a 500.
      if (error instanceof Error && error.name === "ZodError") {
        return reply.code(422).send({ detail: error.message });
      }
      return sendRouteError(reply, error);
    }
  });

  // The preview, not the act: what a relocation *would* carry, so the user
  // decides which of the blocks around the anchor belong to the thought.
  app.get("/api/v1/captures/:activityId/relocation", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const result = await relocation(context).preview({
        userId: identity.userId,
        activityId: params(request).activityId ?? "",
      });
      return reply.send(protocol.RelocationPreviewSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/captures/:activityId/relocation", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const body = protocol.RelocationRequestSchema.parse(jsonBody(request));
      const result = await relocation(context).relocate({
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        activityId: params(request).activityId ?? "",
        destination: body.destination,
        mode: body.mode,
        blockIds: body.block_ids,
        ...(body.project_id === undefined ? {} : { projectId: body.project_id }),
        ...(body.target_id === undefined ? {} : { targetId: body.target_id }),
      });
      return reply.send(protocol.RelocationResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return reply.code(422).send({ detail: error.message });
      }
      return sendRouteError(reply, error);
    }
  });
}
