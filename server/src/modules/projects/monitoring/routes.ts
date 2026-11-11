import {registerProjectIngressOperationRoutes} from './operationRoutes.js';
import type { FastifyInstance } from 'fastify';
import type { ModuleContext } from '../../../gateway/routeRegistry.js';
import { dbPool, resolveIdentity, sendRouteError, HttpError } from '../../routeUtils/common.js';
import { ProjectMonitoringService } from './service.js';
/** Monitoring writes are core operation adapters; only current-state reads remain here. */
export function registerMonitoringRoutes(app: FastifyInstance, context: ModuleContext) {
  registerProjectIngressOperationRoutes(app,context);
  const base = '/api/v1/projects/:projectId/information-monitoring';
  const service = () => new ProjectMonitoringService(dbPool(context.config), context.config);
  const read = (path: string, handle: (s: ProjectMonitoringService, i: {
    spaceId: string;
    userId: string;
  }, p: Record<string, string>, query: unknown) => Promise<unknown>) => {
    app.get<{
      Params: Record<string, string>;
    }>(base + path, async (req, reply) => {
      const identity = await resolveIdentity(context.config, req, reply);
      if (!identity) return reply;
      try {
        return reply.send(await handle(service(), identity, req.params, req.query));
      } catch (e) {
        return sendRouteError(reply, e);
      }
    });
  };
  read('', (s, i, p, q) => {
    const offset = Number((q as Record<string, unknown>)?.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new HttpError(422, 'Invalid candidate offset');
    return s.state(i, p.projectId!, undefined, offset);
  });
  read('/runs/:operationId', (s, i, p) => s.state(i, p.projectId!, p.operationId));
}
