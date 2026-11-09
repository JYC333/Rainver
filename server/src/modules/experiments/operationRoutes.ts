import type { FastifyInstance } from 'fastify';
import type { ModuleContext } from '../../gateway/routeRegistry.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { introspectIdentity } from '../auth/identity.js';
import { jsonBody, params } from '../routeUtils/common.js';
import { OperationError } from '../systemActions/operations/errors.js';
import { sessionActor } from '../systemActions/operations/actor.js';
import { operationRuntime } from '../systemActions/operations/runtime.js';

const base = '/api/v1/projects/:projectId/experiments';
export const EXPERIMENT_OPERATION_ROUTES = [
  ['POST', `${base}/definitions`, 'experiment.definition.create'],
  ['PATCH', `${base}/definitions/:definitionId`, 'experiment.definition.update'],
  ['POST', `${base}/definitions/:definitionId/versions`, 'experiment.version.create'],
  ['POST', `${base}/definitions/:definitionId/versions/:versionId/approve`, 'experiment.version.approve'],
  ['POST', `${base}/definitions/:definitionId/versions/:versionId/runs`, 'experiment.run.create'],
  ['POST', `${base}/definitions/:definitionId/versions/:versionId/runs/launch`, 'experiment.run.launch'],
  ['POST', `${base}/definitions/:definitionId/runs/:runId/complete`, 'experiment.run.complete'],
  ['POST', `${base}/definitions/:definitionId/runs/:runId/observations`, 'experiment.observation.record'],
  ['POST', `${base}/definitions/:definitionId/interpretations`, 'experiment.interpretation.create'],
  ['POST', `${base}/interpretations/:interpretationId/review`, 'experiment.interpretation.review'],
  ['POST', `${base}/interpretations/:interpretationId/convert-to-signal`, 'experiment.interpretation.convert'],
] as const;

export function registerExperimentOperationRoutes(app: FastifyInstance, context: ModuleContext): void {
  for (const [method, url, id] of EXPERIMENT_OPERATION_ROUTES) app.route({ method, url, config: { operation: id }, async handler(request, reply) {
    const requestId = resolveRequestId(request);
    reply.header('x-request-id', requestId).header('cache-control', 'private, no-store');
    const fail = (error: OperationError) => reply.code(error.httpStatus).send(error.body(requestId));
    const identity = await introspectIdentity(context.config, request, reply);
    if (!identity.ok) return fail(identity.reason === 'denied' ? new OperationError(identity.statusCode === 401 ? 'authentication_required' : 'operation_not_found', identity.statusCode === 401 ? 401 : 404) : new OperationError('operation_temporarily_unavailable', 503, true));
    let body: Record<string, unknown>;
    try { body = request.body === undefined ? {} : jsonBody(request); }
    catch { return fail(new OperationError('operation_invalid_input', 422)); }
    const p = params(request);
    const target = { project_id: p.projectId, ...(p.definitionId ? { definition_id: p.definitionId } : {}), ...(p.versionId ? { version_id: p.versionId } : {}), ...(p.runId ? { experiment_run_id: p.runId } : {}), ...(p.interpretationId ? { interpretation_id: p.interpretationId } : {}) };
    if (Object.keys(target).some(key => Object.hasOwn(body, key))) return fail(new OperationError('operation_invalid_input', 422));
    const key = request.headers['idempotency-key'];
    const result = await (await operationRuntime(context.config)).execute(id, { ...body, ...target }, sessionActor({ spaceId: identity.spaceId, userId: identity.userId }), requestId, typeof key === 'string' ? key : undefined);
    return reply.code(result.http_status).send(result.body);
  } });
}
