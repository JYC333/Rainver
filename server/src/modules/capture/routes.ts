import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { params, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { RelocationService } from "./relocationService.js";

type RelocationRouteService = Pick<RelocationService, "preview">;
type RelocationFactory = (context: ModuleContext) => RelocationRouteService;
let relocationFactoryOverride: RelocationFactory | null = null;

export function __setRelocationServiceFactoryForTests(factory: RelocationFactory | null): void {
  relocationFactoryOverride = factory;
}

function relocation(context: ModuleContext): RelocationRouteService {
  return relocationFactoryOverride?.(context) ?? RelocationService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/captures',operation:'capture.create'}]);

  // The preview, not the act: what a relocation *would* carry, so the user
  // decides which of the blocks around the anchor belong to the thought.
  app.get("/api/v1/captures/:activityId/relocation", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const result = await relocation(context).preview({
        userId: identity.userId,
        activityId: params(request).activityId ?? "",
      });
      return reply.send(protocol.RelocationPreviewSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/captures/:activityId/relocation',operation:'capture.relocate',params:{activityId:'activity_id'}}]);
}
