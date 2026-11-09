/**
 * Policy module routes — internal, service-authenticated enforcement port.
 *
 * Internal callers reach the policy authority through this port so there is
 * never a second decider. Run orchestration calls `policy.enforce` via its
 * context port. Proposal-apply uses the same internal boundary while the server owns
 * the decision and audit write.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { checkInternalToken } from "../../gateway/internalAuth.js";
import { loadActionRegistry } from "./actionRegistry.js";
import { enforce, enforceProposalApply } from "./service.js";
import { introspectIdentity } from '../auth/identity.js';
import { operationRuntime } from '../systemActions/operations/runtime.js';
import { OperationError } from '../systemActions/operations/errors.js';
import { sessionActor } from '../systemActions/operations/actor.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { AuthorizationRequestService } from "./authorizationRequestService.js";
import { RuntimeContextPolicyRepository } from "./runtimeContextPolicyRepository.js";
import { dbPool, jsonBody as publicJsonBody, params, requiredString, resolveIdentity, sendRouteError, HttpError } from "../routeUtils/common.js";

function jsonBody(request: FastifyRequest): unknown {
  const text = request.body instanceof Buffer ? request.body.toString("utf8") : "";
  return text ? JSON.parse(text) : {};
}

function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(400).send({ detail: message });
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const authorizationRequests = () => new AuthorizationRequestService(
    dbPool(context.config),
    context.config,
  );
  const runtimeContextPolicies = () => new RuntimeContextPolicyRepository(dbPool(context.config));
  app.get("/api/v1/runtime-context/policies/:scopeType/:scopeId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const scopeType = protocol.RuntimeContextPolicyScopeSchema.parse(requiredString(params(request).scopeType, "scope_type"));
      const scopeId = requiredString(params(request).scopeId, "scope_id");
      const active = await runtimeContextPolicies().getActive(identity, scopeType, scopeId);
      return reply.send(active === null ? null : protocol.RuntimeContextPolicyVersionSchema.parse(active));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.get("/api/v1/runtime-context/policies/:scopeType/:scopeId/versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const scopeType = protocol.RuntimeContextPolicyScopeSchema.parse(requiredString(params(request).scopeType, "scope_type"));
      const scopeId = requiredString(params(request).scopeId, "scope_id");
      const items = await runtimeContextPolicies().listVersions(identity, scopeType, scopeId);
      return reply.send(protocol.RuntimeContextPolicyVersionListResponseSchema.parse({ items }));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.put("/api/v1/runtime-context/policies/:scopeType/:scopeId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const scopeType = protocol.RuntimeContextPolicyScopeSchema.parse(requiredString(params(request).scopeType, "scope_type"));
      const scopeId = requiredString(params(request).scopeId, "scope_id");
      const parsed = protocol.RuntimeContextPolicyWriteRequestSchema.safeParse(publicJsonBody(request));
      if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Invalid Runtime Context Policy");
      const version = await runtimeContextPolicies().write(identity, scopeType, scopeId, parsed.data);
      return reply.send(protocol.RuntimeContextPolicyVersionSchema.parse(version));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.post("/api/v1/runtime-context/policies/resolve", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const parsed = protocol.RuntimeContextPolicyResolveRequestSchema.safeParse(publicJsonBody(request));
      if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Invalid policy resolution request");
      const resolved = await runtimeContextPolicies().resolve(identity, parsed.data);
      return reply.send(protocol.RuntimeContextResolvedPolicySchema.parse(resolved));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.get("/api/v1/runs/:runId/authorization-requests", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const runId = requiredString(params(request).runId, "run_id");
      return reply.send(await authorizationRequests().listForRun(identity, runId));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.post("/api/v1/authorization-requests/:requestId/approve", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const requestId = requiredString(params(request).requestId, "request_id");
      return reply.send(await authorizationRequests().decide(identity, requestId, "approved"));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.post("/api/v1/authorization-requests/:requestId/reject", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const requestId = requiredString(params(request).requestId, "request_id");
      return reply.send(await authorizationRequests().decide(identity, requestId, "rejected"));
    } catch (error) { return sendRouteError(reply, error); }
  });
  for (const [url,id] of [
    ['/api/v1/policy/action-grants','policy.action_grant.create'],
    ['/api/v1/policy/action-grants/:grantId/revoke','policy.action_grant.revoke'],
  ] as const) app.post(url,{config:{operation:id}},async(request,reply)=>{
    const resolved = await introspectIdentity(context.config, request, reply);
    if (!resolved.ok) {
      const error = resolved.reason === 'denied'
        ? resolved.statusCode === 401 ? new OperationError('authentication_required', 401) : new OperationError('operation_not_found', 404)
        : new OperationError('operation_temporarily_unavailable', 503, true);
      return reply.code(error.httpStatus).send(error.body(resolveRequestId(request)));
    }
    const identity = {spaceId: resolved.spaceId, userId: resolved.userId};
    let body: Record<string, unknown>;
    try { body = publicJsonBody(request); }
    catch {
      return reply.code(422).send(new OperationError('operation_invalid_input', 422).body(resolveRequestId(request)));
    }
    // The URL owns the revoke target; body fields still pass strict validation.
    if (id === 'policy.action_grant.revoke' && Object.hasOwn(body, 'grant_id')) {
      return reply.code(422).send(new OperationError('operation_invalid_input', 422).body(resolveRequestId(request)));
    }
    const input = id === 'policy.action_grant.create' ? body : {...body, grant_id: params(request).grantId};
    const key=request.headers['idempotency-key'];
    const result=await(await operationRuntime(context.config)).execute(id,input,sessionActor(identity),resolveRequestId(request),typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
  });

  app.post("/internal/policy/enforce", async (request, reply) => {
    if (!checkInternalToken(context.config, request)) {
      return reply.code(401).send({ detail: "Unauthorized" });
    }
    try {
      const req = protocol.PolicyCheckRequestSchema.parse(jsonBody(request));
      const registry = await loadActionRegistry(context.config);
      const result = await enforce(context.config, registry, req);
      return reply.send(protocol.PolicyEnforceResultSchema.parse(result));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/internal/policy/enforce-proposal-apply", async (request, reply) => {
    if (!checkInternalToken(context.config, request)) {
      return reply.code(401).send({ detail: "Unauthorized" });
    }
    try {
      const req = protocol.PolicyProposalApplyRequestSchema.parse(jsonBody(request));
      const result = await enforceProposalApply(
        context.config,
        {
          user_id: req.user_id,
          space_id: req.space_id,
          proposal_id: req.proposal_id,
          proposal_type: req.proposal_type,
          declared_risk: req.risk_level ?? null,
          required_approver_role: req.required_approver_role ?? null,
          proposal_payload: req.payload ?? null,
          metadata_json: req.metadata_json ?? null,
        },
        req.membership_role ?? null,
        new Set(req.supported_proposal_types),
      );
      return reply.send(protocol.PolicyEnforceResultSchema.parse(result));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}
