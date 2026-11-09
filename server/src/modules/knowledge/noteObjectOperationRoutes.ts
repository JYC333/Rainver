import type { FastifyInstance } from 'fastify';
import type { ModuleContext } from '../../gateway/routeRegistry.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { introspectIdentity } from '../auth/identity.js';
import { jsonBody, params } from '../routeUtils/common.js';
import { sessionActor } from '../systemActions/operations/actor.js';
import { OperationError } from '../systemActions/operations/errors.js';
import { operationRuntime } from '../systemActions/operations/runtime.js';
export const NOTE_OBJECT_ROUTES = [['POST','/api/v1/knowledge/notes/:noteId/promote','note.promote_to_knowledge','flat'],['POST','/api/v1/knowledge/sources','knowledge.source.create','body'],['PATCH','/api/v1/knowledge/sources/:sourceId','knowledge.source.update','source'],['DELETE','/api/v1/knowledge/sources/:sourceId','knowledge.source.archive','target'],['POST', '/api/v1/knowledge/notes', 'knowledge.note.create', 'body'], ['PATCH', '/api/v1/knowledge/notes/:noteId', 'knowledge.note.update', 'note'], ['POST', '/api/v1/notes/collections', 'knowledge.collection.create', 'body'], ['PATCH', '/api/v1/notes/collections/:collectionId', 'knowledge.collection.update', 'collection'], ['DELETE', '/api/v1/notes/collections/:collectionId', 'knowledge.collection.delete', 'target'], ['POST', '/api/v1/notes/collections/project/:projectId', 'knowledge.collection.ensure_project', 'target'], ['POST', '/api/v1/knowledge/notes/:noteId/placements', 'knowledge.note.placement.add', 'flat'], ['DELETE', '/api/v1/knowledge/notes/:noteId/placements/:collectionId', 'knowledge.note.placement.remove', 'target'], ['DELETE', '/api/v1/knowledge/notes/:noteId/shares/:projectId', 'knowledge.note.share.revoke', 'target'], ['PATCH', '/api/v1/knowledge/notes/tree/reorder', 'knowledge.note.tree.reorder', 'body']] as const;
export function registerNoteObjectOperationRoutes(app: FastifyInstance, context: ModuleContext) {
  for (const [method, url, id, shape] of NOTE_OBJECT_ROUTES) app.route({
    method,
    url,
    config: {
      operation: id
    },
    async handler(request, reply) {
      const requestId = resolveRequestId(request);
      reply.header('x-request-id', requestId).header('cache-control', 'private, no-store');
      const fail = (e: OperationError) => reply.code(e.httpStatus).send(e.body(requestId));
      const auth = await introspectIdentity(context.config, request, reply);
      if (!auth.ok) return fail(auth.reason === 'denied' ? new OperationError(auth.statusCode === 401 ? 'authentication_required' : 'operation_not_found', auth.statusCode === 401 ? 401 : 404) : new OperationError('operation_temporarily_unavailable', 503, true));
      let body: Record<string, unknown>;
      try {
        body = request.body === undefined ? {} : jsonBody(request);
      } catch {
        return fail(new OperationError('operation_invalid_input', 422));
      }
      const target = Object.fromEntries(Object.entries(params(request)).map(([key, val]) => [({
        noteId: 'note_id',
        sourceId: 'source_id',
        collectionId: 'collection_id',
        projectId: 'project_id'
      } as Record<string, string>)[key] ?? key, val]));
      if (Object.keys(target).some(k => Object.hasOwn(body, k)) || shape === 'target' && Object.keys(body).length) return fail(new OperationError('operation_invalid_input', 422));
      const input = shape === 'note' || shape === 'collection' || shape === 'source' ? {
        ...target,
        changes: body
      } : {
        ...body,
        ...target
      };
      const key = request.headers['idempotency-key'];
      const result = await (await operationRuntime(context.config)).execute(id, input, sessionActor({
        spaceId: auth.spaceId,
        userId: auth.userId
      }), requestId, typeof key === 'string' ? key : undefined);
      return reply.code(result.http_status).send(result.body);
    }
  });
}
