import {GrantRepository} from './repository.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {dbPool,optionalString,params,query,resolveIdentity,sendRouteError} from '../routeUtils/common.js';

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new GrantRepository(dbPool(context.config));

  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/personal-memory-grants/preview',operation:'personal_memory_grant.preview',admission:'person'},
    {method:'POST',url:'/api/v1/personal-memory-grants',operation:'personal_memory_grant.create',admission:'person'},
    {method:'POST',url:'/api/v1/personal-memory-grants/:grantId/revoke',operation:'personal_memory_grant.revoke',admission:'person',params:{grantId:'grant_id'}},
  ]);

  app.get("/api/v1/personal-memory-grants", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository().list(identity, {
          status: optionalString(query(request).status),
          targetSpaceId: optionalString(query(request).target_space_id),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/personal-memory-grants/:grantId/audit", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().audit(identity, params(request).grantId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
