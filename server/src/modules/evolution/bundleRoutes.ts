import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  jsonBody,
  params,
  parsePage,
  resolveIdentity,
  sendRouteError,
  stringArray,
} from "../routeUtils/common.js";
import { PgProposalApplyService } from "../proposals/applyService.js";
import { EvolutionBundleRepository, type EvolutionBundleDecision } from "./bundleRepository.js";

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, `${field} is required`);
  return value.trim();
}

function decisionsFromBody(body: Record<string, unknown>): EvolutionBundleDecision[] {
  if (Array.isArray(body.decisions)) {
    return body.decisions.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(422, "decisions must contain objects");
      }
      const item = value as Record<string, unknown>;
      const proposalId = typeof item.proposal_id === "string" ? item.proposal_id.trim() : "";
      const decision = item.decision === "approve" || item.decision === "reject" ? item.decision : null;
      if (!proposalId || !decision) throw new HttpError(422, "Each decision requires proposal_id and decision=approve|reject");
      return {
        proposalId,
        decision,
        note: typeof item.note === "string" ? item.note.trim() || null : null,
      };
    });
  }
  const approvals = stringArray(body.approve_proposal_ids ?? body.approved_proposal_ids);
  const rejections = stringArray(body.reject_proposal_ids ?? body.rejected_proposal_ids);
  return [
    ...approvals.map((proposalId) => ({ proposalId, decision: "approve" as const })),
    ...rejections.map((proposalId) => ({ proposalId, decision: "reject" as const })),
  ];
}

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

  app.post(base, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      return reply.code(201).send(await repository().create(identity, {
        title: requiredString(body, "title"),
        description: typeof body.description === "string" ? body.description : null,
        proposalIds: stringArray(body.proposal_ids),
      }));
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

  app.post(`${base}/:bundleId/decide`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const decisions = decisionsFromBody(jsonBody(request));
      const result = await repository().decide(
        identity,
        params(request).bundleId ?? "",
        decisions,
        PgProposalApplyService.fromConfig(context.config),
      );
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:bundleId/approve`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const proposalIds = stringArray(body.proposal_ids ?? body.approved_proposal_ids);
      const decisions = proposalIds.map((proposalId) => ({ proposalId, decision: "approve" as const }));
      return reply.send(await repository().decide(
        identity,
        params(request).bundleId ?? "",
        decisions,
        PgProposalApplyService.fromConfig(context.config),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:bundleId/reject`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const proposalIds = stringArray(body.proposal_ids ?? body.rejected_proposal_ids);
      const decisions = proposalIds.map((proposalId) => ({ proposalId, decision: "reject" as const }));
      return reply.send(await repository().decide(
        identity,
        params(request).bundleId ?? "",
        decisions,
        PgProposalApplyService.fromConfig(context.config),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:bundleId/rollback`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().requestRollback(
        identity,
        params(request).bundleId ?? "",
        PgProposalApplyService.fromConfig(context.config),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
