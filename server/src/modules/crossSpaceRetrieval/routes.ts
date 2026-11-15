import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { CrossSpaceRetrievalService } from "./service.js";

type RouteService = Pick<CrossSpaceRetrievalService,"listNotifications">;
type ServiceFactory = (context: ModuleContext) => RouteService;
let serviceFactoryOverride: ServiceFactory | null = null;

export function __setCrossSpaceRetrievalServiceFactoryForTests(factory: ServiceFactory | null): void {
  serviceFactoryOverride = factory;
}

function service(context: ModuleContext): RouteService {
  return serviceFactoryOverride?.(context) ?? CrossSpaceRetrievalService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/me/retrieval/search',operation:'personal.retrieval.search',admission:'person'},
    {method:'POST',url:'/api/v1/me/retrieval/pointers/resolve',operation:'personal.retrieval.resolve',admission:'person'},
    {method:'POST',url:'/api/v1/me/retrieval/summaries',operation:'personal.retrieval.summary.store',admission:'person'},
    {method:'POST',url:'/api/v1/me/retrieval/egress/disclose',operation:'personal.retrieval.egress.disclose',admission:'person'},
    {method:'POST',url:'/api/v1/me/retrieval/fused-conclusions',operation:'personal.retrieval.fused.store',admission:'person'},
  ]);

  registerOperationAdapters(app, context.config, [{method:'PATCH',url:'/api/v1/spaces/:spaceId/egress-notifications',operation:'space.egress_notifications.update',spaceParam:'spaceId'}]);

  app.get("/api/v1/me/notifications", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(protocol.SpaceMemberNotificationsResponseSchema.parse(
        await service(context).listNotifications(identity.userId),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
