import type { FastifyInstance } from 'fastify';
import type { ModuleContext } from '../../gateway/routeRegistry.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { introspectIdentity } from '../auth/identity.js';
import { jsonBody, params } from '../routeUtils/common.js';
import { sessionActor } from '../systemActions/operations/actor.js';
import { OperationError } from '../systemActions/operations/errors.js';
import { operationRuntime } from '../systemActions/operations/runtime.js';
export const KNOWLEDGE_REVIEW_ROUTES = [
 ['POST','/api/v1/projects/:projectId/knowledge-candidate-extractions','knowledge.candidate.extract'],
 ['POST','/api/v1/knowledge/items/:itemId/sources','knowledge.evidence.add'],
 ['DELETE','/api/v1/knowledge/items/:itemId/sources/:linkId','knowledge.evidence.remove'],
 ['POST','/api/v1/projects/:projectId/knowledge-candidates/from-note','knowledge.candidate.from_note'],
 ['POST','/api/v1/projects/:projectId/knowledge-candidates/from-thread','knowledge.candidate.from_thread'],
 ['POST','/api/v1/projects/:projectId/knowledge-candidates/from-interpretation','knowledge.candidate.from_interpretation'],
 ['POST','/api/v1/projects/:projectId/knowledge-candidates/:candidateId/decision','knowledge.candidate.decide'],
 ['POST','/api/v1/projects/:projectId/knowledge-candidates/:candidateId/reopen','knowledge.candidate.reopen'],
 ['POST','/api/v1/projects/:projectId/knowledge-candidate-review-packets','knowledge.candidate.packet.open'],
 ['POST','/api/v1/projects/:projectId/knowledge-candidate-review-packets/:packetId/close','knowledge.candidate.packet.close'],
] as const;
export function registerKnowledgeReviewRoutes(app: FastifyInstance, context: ModuleContext, family: 'evidence' | 'candidate') {
  for (const [method, url, id] of KNOWLEDGE_REVIEW_ROUTES.filter(row=>row[2].startsWith('knowledge.'+family+'.'))) app.route({
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
        itemId: 'item_id',linkId:'link_id',candidateId:'candidate_id',packetId:'packet_id',noteId: 'note_id',
        sourceId: 'source_id',
        collectionId: 'collection_id',
        projectId: 'project_id'
      } as Record<string, string>)[key] ?? key, val]));
      if (Object.keys(target).some(k => Object.hasOwn(body, k))) return fail(new OperationError('operation_invalid_input', 422));
      const input = {...body,...target};
      const key = request.headers['idempotency-key'];
      const result = await (await operationRuntime(context.config)).execute(id, input, sessionActor({
        spaceId: auth.spaceId,
        userId: auth.userId
      }), requestId, typeof key === 'string' ? key : undefined);
      return reply.code(result.http_status).send(result.body);
    }
  });
}
