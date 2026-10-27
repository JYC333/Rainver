import { enforceSources } from "../../sources/enforceSources.js";
import type { FastifyInstance } from 'fastify';
import type { ModuleContext } from '../../../gateway/routeRegistry.js';
import { MonitoringFeedbackSchema } from '@rainver/protocol';
import { dbPool, resolveIdentity, sendRouteError, jsonBody, HttpError, parseBody } from '../../routeUtils/common.js';
import { ProjectMonitoringService } from './service.js';
export function registerMonitoringRoutes(app: FastifyInstance, context: ModuleContext) {
  const base = '/api/v1/projects/:projectId/information-monitoring';
  const service = () => new ProjectMonitoringService(dbPool(context.config), context.config);
  const route = (method: 'get' | 'post' | 'patch', path: string, handle: (s: ProjectMonitoringService, i: {
    spaceId: string;
    userId: string;
  }, p: Record<string, string>, body: unknown) => Promise<unknown>) => {
    app[method]<{
      Params: Record<string, string>;
    }>(base + path, async (req, reply) => {
      const identity = await resolveIdentity(context.config, req, reply);
      if (!identity) return reply;
      try {
        if (method !== 'get') {
          const gate = await enforceSources(context, identity, path === '/source-setup' ? 'source.connection.manage' : 'project.monitoring.configure', path === '/source-setup' ? 'source_connection' : 'project');
          if (gate.blocked) return reply.code(403).send(gate.reply403);
        }
        if (method === 'post' && path === '/runs') reply.code(202);
        return reply.send(await handle(service(), identity, req.params, method === 'get' ? req.query : jsonBody(req)));
      } catch (e) {
        return sendRouteError(reply, e);
      }
    });
  };
  route('get', '', (s, i, p, b) => {
    const offset = Number((b as Record<string, unknown>)?.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new HttpError(422, 'Invalid candidate offset');
    return s.state(i, p.projectId!, undefined, offset);
  });
  route('post', '/source-setup', (s, i, p, b) => s.setup(i, p.projectId!, b));
  route('post', '/proposals', (s, i, p, b) => s.propose(i, p.projectId!, b));
  route('patch', '/details', (s, i, p, b) => s.details(i, p.projectId!, b));
  route('post', '/reconcile', (s, i, p) => s.reconcile(i, p.projectId!));
  route('post', '/runs', (s, i, p, b) => s.start(i, p.projectId!, b));
  route('get', '/runs/:operationId', (s, i, p) => s.state(i, p.projectId!, p.operationId));
  route('patch', '/state', (s, i, p, b) => {
    const body = b as Record<string, unknown>;
    if (Object.keys(body).some(k => !['expected_version_id', 'paused'].includes(k)) || typeof body.paused !== 'boolean' || typeof body.expected_version_id !== 'string') throw new HttpError(422, 'Invalid monitoring state');
    return s.setPaused(i, p.projectId!, body.expected_version_id, body.paused);
  });
  route('post', '/items/:itemId/feedback', (s, i, p, b) => s.feedback(i, p.projectId!, p.itemId!, parseBody(MonitoringFeedbackSchema, b).feedback));
}
