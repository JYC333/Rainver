/**
 * Policy module routes — internal, service-authenticated enforcement port.
 *
 * Internal callers reach the policy authority through this port so there is
 * never a second decider. Run orchestration calls `policy.enforce` via its
 * context port. Proposal-apply uses the same internal boundary while the server owns
 * the decision and audit write.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { checkInternalToken } from "../../gateway/internalAuth";
import { loadProtocol } from "../providers/protocolRuntime";
import { loadActionRegistry } from "./actionRegistry";
import { enforce, enforceProposalApply } from "./service";
import { ActionApprovalGrantService } from "./actionApprovalGrantService";
import { AuthorizationRequestService } from "./authorizationRequestService";
import { dbPool, jsonBody as publicJsonBody, params, requiredString, resolveIdentity, sendRouteError } from "../routeUtils/common";

function jsonBody(request: FastifyRequest): unknown {
  const text = request.body instanceof Buffer ? request.body.toString("utf8") : "";
  return text ? JSON.parse(text) : {};
}

function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(400).send({ detail: message });
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const grants = () => new ActionApprovalGrantService(dbPool(context.config));
  const authorizationRequests = () => new AuthorizationRequestService(
    dbPool(context.config),
    context.config,
  );
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
  app.post("/api/v1/policy/action-grants", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      return reply.code(201).send(await grants().create(context.config, identity, publicJsonBody(request)));
    } catch (error) { return sendRouteError(reply, error); }
  });
  app.post("/api/v1/policy/action-grants/:grantId/revoke", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try {
      const grantId = requiredString(params(request).grantId, "grant_id");
      const result = await enforce(context.config, await loadActionRegistry(), { action: "policy.action_grant.revoke", actor_type: "user", actor_id: identity.userId, space_id: identity.spaceId, resource_type: "action_approval_grant", resource_id: grantId, force_record: true });
      if (result.status !== "allow") return reply.code(result.status === "blocked" ? 403 : 503).send({ detail: result.message ?? "Policy enforcement failed" });
      return reply.send(await grants().revoke(identity, grantId));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.post("/internal/policy/enforce", async (request, reply) => {
    if (!checkInternalToken(context.config, request)) {
      return reply.code(401).send({ detail: "Unauthorized" });
    }
    try {
      const protocol = await loadProtocol();
      const req = protocol.PolicyCheckRequestSchema.parse(jsonBody(request));
      const registry = await loadActionRegistry();
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
      const protocol = await loadProtocol();
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
