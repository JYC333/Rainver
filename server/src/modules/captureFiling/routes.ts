import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { jsonBody, resolveIdentity, sendRouteError } from "../routeUtils/common";
import { loadProtocol } from "../providers/protocolRuntime";
import { CaptureFilingService } from "./service";

type RouteService = Pick<CaptureFilingService, "file">;
type ServiceFactory = (context: ModuleContext) => RouteService;
let serviceFactoryOverride: ServiceFactory | null = null;

export function __setCaptureFilingServiceFactoryForTests(factory: ServiceFactory | null): void {
  serviceFactoryOverride = factory;
}

function service(context: ModuleContext): RouteService {
  return serviceFactoryOverride?.(context) ?? CaptureFilingService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  // Cross-Space by design: the capture is in the caller's personal Space and the
  // target Project is elsewhere, so the request Space is not the authority here.
  // Authority is the caller's ownership of the capture plus writer role on the
  // target Project — see CaptureFilingService.
  app.post("/api/v1/me/filings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const body = protocol.CaptureFilingRequestSchema.parse(jsonBody(request));
      const result = await service(context).file({
        userId: identity.userId,
        activityId: body.activity_id,
        targetProjectId: body.target_project_id,
        ...(body.title === undefined ? {} : { title: body.title }),
      });
      return reply.send(protocol.CaptureFilingResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
