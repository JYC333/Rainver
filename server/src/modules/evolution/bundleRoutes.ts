import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  params,
  parsePage,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { EvolutionBundleRepository } from "./bundleRepository.js";


export function registerEvolutionBundleRoutes(app: FastifyInstance, context: ModuleContext): void {
  const base = "/api/v1/evolution/bundles";
  const repository = () => new EvolutionBundleRepository(dbPool(context.config));

  app.get(base, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const page = parsePage(request.query as Record<string, string | undefined>, 50);
      return reply.send(await repository().list(identity, page.limit, page.offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get(`${base}/:bundleId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const result = await repository().get(identity, params(request).bundleId ?? "");
      if (!result) return reply.code(404).send({ detail: "Evolution bundle not found" });
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  registerOperationAdapters(app,context.config,(['decide','approve','reject','rollback'] as const).map(action=>({method:'POST',url:`${base}/:bundleId/${action}`,operation:`evolution.bundle.${action}`,params:{bundleId:'bundle_id'}})));
}
