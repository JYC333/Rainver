import { resolveIdentity as resolveRouteIdentity } from "../routeUtils/common.js";
import {registerContentRetrievalRoutes} from '../retrieval/contentRequests.js';
import {registerOperationAdapters} from "../systemActions/operations/routeAdapter.js";
import type {FastifyInstance,FastifyReply,FastifyRequest} from "fastify";
import * as protocol from "@rainver/protocol";

import {registerMemoryProjectIntegration} from "./projectIntegration.js";
import {MemoryApplyError,PgMemoryApplyRepository} from "./memoryApplyRepository.js";
import type {ModuleContext} from "../../gateway/routeRegistry.js";
import {getDbPool} from "../../db/pool.js";

import {canReviewSpaceOpsPackets} from "../contextOps/reviewPolicy.js";

import {getMemoryMaintenanceJob} from "./maintenanceJobs.js";
import {MemoryReadValidationError,PgMemoryReadRepository} from "./repository.js";
import {MemoryProposalForbiddenError,MemoryProposalNotFoundError,MemoryProposalPolicyError,MemoryProposalValidationError,PgMemoryProposalRepository} from "./proposalRepository.js";

/**
 * server memory model.
 *
 * The server serves read routes (`GET /memory`, `GET /memory/{id}`,
 * `POST /memory/search`) through canonical content access plus Memory-specific
 * sensitivity and summary redaction. It also owns public memory
 * proposal creation (`POST`/`PATCH`/`DELETE /memory`): those routes INSERT
 * pending `proposals` rows only and never mutate active `memory_entries`.
 */
interface MemoryServices {
  repository: Pick<PgMemoryReadRepository, "list" | "get" | "search" | "versions"> &
    Pick<
      PgMemoryProposalRepository,
      "createMemoryProposal" | "updateMemoryProposal" | "archiveMemoryProposal" | "reviseOperatorEditProposal"
    > &
    // Archiving and restoring your own memory is a direct write (ADR 0003
    // §3), so it belongs to the same service surface the routes resolve —
    // reaching past the factory for a pool would make this the one path
    // nothing can substitute.
    Pick<PgMemoryApplyRepository, "setOwnStatus" | "revertToPreviousVersion">;
}

type MemoryServicesFactory = (context: ModuleContext) => MemoryServices;
type MemoryIdentity = { spaceId: string; userId: string };
type MemoryIdentityOverride =
  | MemoryIdentity
  | ((request: FastifyRequest) => Promise<MemoryIdentity | null> | MemoryIdentity | null);

let servicesFactoryOverride: MemoryServicesFactory | null = null;
let identityOverride: MemoryIdentityOverride | null = null;

export function __setMemoryServicesFactoryForTests(
  factory: MemoryServicesFactory | null,
): void {
  servicesFactoryOverride = factory;
}

export function __setMemoryIdentityForTests(identity: MemoryIdentityOverride | null): void {
  identityOverride = identity;
}

function memoryServices(context: ModuleContext): MemoryServices {
  if (servicesFactoryOverride) return servicesFactoryOverride(context);
  const readRepository = PgMemoryReadRepository.fromConfig(context.config);
  const proposalRepository = PgMemoryProposalRepository.fromConfig(context.config);
  const applyRepository = new PgMemoryApplyRepository(getDbPool(context.config.databaseUrl!));
  return {
    repository: {
      list: readRepository.list.bind(readRepository),
      get: readRepository.get.bind(readRepository),
      search: readRepository.search.bind(readRepository),
      versions: readRepository.versions.bind(readRepository),
      setOwnStatus: applyRepository.setOwnStatus.bind(applyRepository),
      revertToPreviousVersion: applyRepository.revertToPreviousVersion.bind(applyRepository),
      createMemoryProposal: proposalRepository.createMemoryProposal.bind(proposalRepository),
      updateMemoryProposal: proposalRepository.updateMemoryProposal.bind(proposalRepository),
      archiveMemoryProposal: proposalRepository.archiveMemoryProposal.bind(proposalRepository),
      reviseOperatorEditProposal: proposalRepository.reviseOperatorEditProposal.bind(proposalRepository),
    },
  };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerContentRetrievalRoutes(app,context,'memory');
  registerMemoryProjectIntegration(context.config.memoryDirectWritesPerSession);
  registerOperationAdapters(app,context.config,[{"method": "POST", "url": "/api/v1/memory", "operation": "memory.propose_create"}, {"method": "PATCH", "url": "/api/v1/memory/:memoryId", "operation": "memory.propose_update", "params": {"memoryId": "memory_id"}}, {"method": "POST", "url": "/api/v1/memory/proposals/:proposalId/revision", "operation": "memory.proposal.revise", "params": {"proposalId": "proposal_id"}}, {"method": "DELETE", "url": "/api/v1/memory/:memoryId", "operation": "memory.archive", "params": {"memoryId": "memory_id"}}, {"method": "POST", "url": "/api/v1/memory/:memoryId/revert", "operation": "memory.revert", "params": {"memoryId": "memory_id"}}, {"method": "POST", "url": "/api/v1/memory/:memoryId/restore", "operation": "memory.restore", "params": {"memoryId": "memory_id"}}, {"method": "POST", "url": "/api/v1/memory/retrieval/feedback", "operation": "memory.retrieval.feedback"}, {"method": "POST", "url": "/api/v1/memory/retrieval/reindex", "operation": "memory.retrieval.reindex"}]);

  app.get("/api/v1/memory", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const q = query(request);
    const limit = intQuery(q.limit, 50);
    const offset = intQuery(q.offset, 0);
    if (limit === null || limit < 0 || limit > 200) {
      return reply.code(422).send({ detail: "limit must be between 0 and 200" });
    }
    if (offset === null || offset < 0) {
      return reply.code(422).send({ detail: "offset must be non-negative" });
    }
    try {
      const page = await memoryServices(context).repository.list(
        identity.spaceId,
        identity.userId,
        {
          scope: optionalString(q.scope),
          namespace: optionalString(q.namespace),
          memoryType: optionalString(q.type),
          status: q.status === undefined ? "active" : q.status,
          projectId: optionalString(q.project_id),
          agentId: optionalString(q.agent_id),
          writtenBy: q.created_by === "agent" || q.created_by === "user" ? q.created_by : null,
          since: optionalString(q.since),
          sessionId: optionalString(q.session),
          runId: optionalString(q.run),
          limit,
          offset,
        },
      );
      return reply.send(page);
    } catch (error) {
      if (error instanceof MemoryReadValidationError) {
        return reply.code(422).send({ detail: error.message });
      }
      return sendDomainError(reply, error);
    }
  });

  app.get("/api/v1/memory/:memoryId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const memoryId = params(request).memoryId ?? "";
    const memory = await memoryServices(context).repository.get(
      identity.spaceId,
      identity.userId,
      memoryId,
    );
    if (!memory) return reply.code(404).send({ detail: "Memory not found" });
    return reply.send(memory);
  });

  // Advisory duplicate detection for memory proposal creation. It surfaces
  // existing memories (exists / probable_duplicate / unknown) so a create
  // proposal can warn about likely duplicates. It is read-only. Do not block
  // creation. Matches returned to
  // the caller are logged through the same memory read-trace as search.

  // Human user-facing, retrieval-backed memory search for the caller's CURRENT
  // space only. Cross-space is fail-closed (not implemented here). The single
  // read-access gate is the memory adapter's revalidate: canReadMemory +
  // summary-only redaction + project-membership gating. Only the returned rows
  // are logged to content_access_logs (search_hit) when another member reads
  // owner-attributed content.

  // Owner-private Memory maintenance scan. The scan runs through the normal
  // memory visibility gate, emits only IDs/titles/reasons, and logs only final
  // findings that contributed to the report.

  app.get("/api/v1/memory/maintenance/jobs/:jobId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const pool = getDbPool(context.config.databaseUrl);
      const includeSpaceOps = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
      const job = await getMemoryMaintenanceJob(pool, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        jobId: params(request).jobId ?? "",
        includeSpaceOps,
      });
      if (!job) return reply.code(404).send({ detail: "Memory maintenance job not found" });
      return reply.send(protocol.MemoryMaintenanceJobSchema.parse(job));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // Rebuild the derived memory retrieval projection for the caller's space.
  // Derived, idempotent, space-scoped maintenance; requires space owner/admin.

  // The revision a maintenance finding asked for, written into its pending
  // update by the person who decides what the entry says. Accepting is
  // separate; an update that asks for a revision is refused until it has one.

  // Archiving and restoring your own memory is direct (ADR 0003 §3). Do not
  // ask a person for permission to archive their own entry. Someone else's
  // entry still goes through a proposal.

  /**
   * Undo one revision in a single action: archive the version that is there
   * and bring back the one it replaced.
   *
   * `DELETE` then `POST /restore` is two requests and leaves a window with no
   * active version on the chain — which for an Agent's persona means an Agent
   * with none at all. The Project's updates already offer this as
   * `restore_memory`; this is the same reversal for a revision made outside
   * any Project, which has no feed to offer it from.
   */

  app.get("/api/v1/memory/:memoryId/versions", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const versions = await memoryServices(context).repository.versions(
        identity.spaceId,
        identity.userId,
        params(request).memoryId ?? "",
      );
      return reply.send(versions);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<MemoryIdentity | null> {
  if (identityOverride) {
    return typeof identityOverride === "function"
      ? identityOverride(request)
      : identityOverride;
  }
  return resolveRouteIdentity(context.config, request, reply);
}

function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof MemoryProposalPolicyError) {
    return reply.code(error.statusCode).send(error.body);
  }
  if (
    error instanceof MemoryProposalValidationError ||
    error instanceof MemoryProposalForbiddenError ||
    error instanceof MemoryProposalNotFoundError
  ) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  // A state conflict, not a malformed request: archiving something already
  // archived is a stale page, and 400 would send the client to fix its input.
  if (error instanceof MemoryApplyError) {
    return reply.code(409).send({ detail: error.message });
  }
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(400).send({ detail: message });
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intQuery(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
