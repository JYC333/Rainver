import { jsonBody } from '../routeUtils/common.js';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import { introspectIdentity } from '../auth/identity.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { sessionActor } from './operations/actor.js';
import { operationRuntime } from './operations/runtime.js';
import { loadSystemActionRegistry } from './registry.js';
import { OperationError } from './operations/errors.js';
export function registerRoutes(app: FastifyInstance, config: ServerConfig): void {
  const getExecutor = () => operationRuntime(config);
  for (const [method, url, kind] of [['GET', '/api/v1/queries/:opId', 'query'], ['POST', '/api/v1/actions/:opId', 'command']] as const) {
    app.route({
      method,
      url,
      config: {
        operationEntry: true
      },
      handler: async (request, reply) => {
        const requestId = resolveRequestId(request);
        reply.header('cache-control', 'private, no-store');
        const resolved = await introspectIdentity(config, request, reply);
        if (!resolved.ok) {
          const error = resolved.reason === 'denied' ? resolved.statusCode === 401 ? new OperationError('authentication_required', 401) : new OperationError('operation_not_found', 404) : new OperationError('operation_temporarily_unavailable', 503, true);
          return reply.code(error.httpStatus).send(error.body(requestId));
        }
        const identity = {
          spaceId: resolved.spaceId,
          userId: resolved.userId
        };
        const id = (request.params as {
          opId: string;
        }).opId;
        const definition = (await loadSystemActionRegistry(config)).get(id as never);
        if (!definition?.execution || definition.execution.kind !== kind) return reply.code(404).send(new OperationError('operation_not_found', 404).body(requestId));
        let input: unknown;
        if (method === 'POST') {
          try { input = jsonBody(request); }
          catch { return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId)); }
        }
        if (method === 'GET') {
          try {
            const encoded = (request.query as {
              input?: unknown;
            }).input;
            input = encoded === undefined ? {} : typeof encoded === 'string' ? JSON.parse(encoded) : null;
          } catch {
            return reply.code(422).send(new OperationError('operation_invalid_input', 422).body(requestId));
          }
        }
        const key = request.headers['idempotency-key'];
        const result = await (await getExecutor()).execute(id, input, sessionActor(identity), requestId, typeof key === 'string' ? key : undefined);
        return reply.code(result.http_status).send(result.body);
      }
    });
  }
}
