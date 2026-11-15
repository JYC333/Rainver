import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { introspectIdentity } from "../auth/identity.js";
import { PgProposalRepository, type ProposalListFilters } from "./repository.js";
import {
  PgProposalApplyService,
  ProposalApplyHttpError,
} from "./applyService.js";
import type {
  ProposalOut,
  ProposalPage,
} from "@rainver/protocol";

interface ProposalServices {
  repository: Pick<PgProposalRepository, "listVisible" | "getVisible">;
  applyService: Pick<
    PgProposalApplyService,
    "accept" | "reject" | "approveEgressGrantingUser" | "rollback"
  >;
}

type ProposalServicesFactory = (context: ModuleContext) => ProposalServices;
type ProposalIdentity = { spaceId: string; userId: string };
type ProposalIdentityOverride =
  | ProposalIdentity
  | ((request: FastifyRequest) => Promise<ProposalIdentity | null> | ProposalIdentity | null);

let servicesFactoryOverride: ProposalServicesFactory | null = null;
let identityOverride: ProposalIdentityOverride | null = null;

export function __setProposalServicesFactoryForTests(
  factory: ProposalServicesFactory | null,
): void {
  servicesFactoryOverride = factory;
}

export function __setProposalIdentityForTests(
  identity: ProposalIdentityOverride | null,
): void {
  identityOverride = identity;
}

function proposalServices(context: ModuleContext): ProposalServices {
  if (servicesFactoryOverride) return servicesFactoryOverride(context);
  return {
    repository: PgProposalRepository.fromConfig(context.config),
    applyService: PgProposalApplyService.fromConfig(context.config, context.pluginHost),
  };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const parsed = parseListFilters(request);
    if ("error" in parsed) return reply.code(422).send({ detail: parsed.error });
    const services = proposalServices(context);
    try {
      const page = await services.repository.listVisible(
        identity.spaceId,
        identity.userId,
        parsed.filters,
      );
      return reply.send(page);
    } catch (error) {
      return sendProposalRouteError(request, reply, error);
    }
  });

  app.get("/api/v1/proposals/:proposalId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const proposalId = params(request).proposalId ?? "";
    const services = proposalServices(context);
    const proposal = await services.repository.getVisible(
      identity.spaceId,
      identity.userId,
      proposalId,
    );
    if (!proposal) return reply.code(404).send({ detail: "Proposal not found" });
    return reply.send(proposal);
  });

  registerOperationAdapters(app,context.config,[
    {method:"POST",url:"/api/v1/proposals/:proposalId/accept",operation:"proposal.accept",params:{proposalId:"proposal_id"},query:{confirm_incomplete_patch:"confirm_incomplete_patch"}},
    {method:"POST",url:"/api/v1/proposals/:proposalId/rollback",operation:"proposal.rollback",params:{proposalId:"proposal_id"}},
{method:'POST',url:'/api/v1/proposals/:proposalId/reject',operation:'proposal.reject',params:{proposalId:'proposal_id'}},{
    method:'POST',url:'/api/v1/proposals/:proposalId/approvals/egress-granting-user',
    operation:'proposal.egress.approve',params:{proposalId:'proposal_id'},
  }]);
}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ProposalIdentity | null> {
  if (identityOverride) {
    return typeof identityOverride === "function"
      ? identityOverride(request)
      : identityOverride;
  }
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(context.config, request, reply);
  if (identity.ok) return { spaceId: identity.spaceId, userId: identity.userId };
  if (identity.reason === "denied") {
    reply.code(identity.statusCode);
    reply.header("content-type", "application/json");
    reply.send(identity.body);
    return null;
  }
  await sendErrorEnvelope(
    reply,
    502,
    errorEnvelope(
      identity.reason === "contract_violation"
        ? "introspect_contract_violation"
        : "identity_unavailable",
      "Identity introspection failed",
      requestId,
    ),
  );
  return null;
}

function parseListFilters(
  request: FastifyRequest,
): { filters: ProposalListFilters } | { error: string } {
  const q = query(request);
  const status = resolveStatus(q.status);
  if (status instanceof Error) return { error: status.message };
  const limit = intQuery(q.limit, 50);
  const offset = intQuery(q.offset, 0);
  if (limit === null || limit < 0 || limit > 200) {
    return { error: "limit must be between 0 and 200" };
  }
  if (offset === null || offset < 0) return { error: "offset must be non-negative" };
  const urgency = q.urgency;
  if (urgency && !["low", "normal", "high", "critical"].includes(urgency)) {
    return { error: `Invalid urgency ${JSON.stringify(urgency)}` };
  }
  const expired = boolQuery(q.expired);
  if (q.expired !== undefined && expired === null) {
    return { error: `Invalid expired ${JSON.stringify(q.expired)}` };
  }
  return {
    filters: {
      status,
      proposalType: q.type ?? null,
      urgency: urgency ?? null,
      expired,
      projectId: q.project_id ?? null,
      createdByRunId: q.created_by_run_id ?? null,
      limit,
      offset,
    },
  };
}

function resolveStatus(raw: string | undefined): string | null | Error {
  if (raw === undefined) return "pending";
  if (raw === "all") return null;
  if (raw === "pending" || raw === "accepted" || raw === "rejected") return raw;
  return new Error(`Invalid status ${JSON.stringify(raw)}`);
}

function sendProposalRouteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply | Promise<FastifyReply> {
  if(error && typeof error==='object' && (error as {code?:unknown}).code==='idempotency_in_progress') {
    return reply.code(409).send({error:{code:'idempotency_in_progress',domain:'operations',message:'Operation is in progress',metadata:{},retryable:true,request_id:request.id}});
  }
  if (error instanceof ProposalApplyHttpError) {
    return reply.code(error.statusCode).send({ detail: error.detail });
  }
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    return reply
      .code((error as { statusCode: number }).statusCode)
      .send({ detail: error.message });
  }
  throw error;
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

function boolQuery(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function intQuery(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export type { ProposalOut, ProposalPage };
