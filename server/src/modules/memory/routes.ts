import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type {
  MemoryMaintenanceScanRequest,
  RetrievalBriefRequest,
  RetrievalCreateSafetyRequest,
  RetrievalFeedbackRequest,
  RetrievalSearchRequest,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { getDbPool } from "../../db/pool.js";
import { introspectIdentity } from "../auth/identity.js";
import { PgActivityConsolidationRepository } from "../activity/consolidationRepository.js";
import {
  RetrievalFeedbackService,
  RetrievalProjectionService,
  RetrievalSearchService,
  persistRetrievalBriefArtifact,
} from "../retrieval/index.js";
import { readSpaceRetrievalSettings, resolveRetrievalSearchControls } from "../retrieval/settings.js";
import { canInitiateContextOpsScan, canReviewSpaceOpsPackets } from "../contextOps/reviewPolicy.js";
import { withDbTransaction } from "../routeUtils/common.js";
import { requireSpaceOwnerOrAdmin } from "../routeUtils/access.js";
import { enqueueRetrievalEmbeddingBackfill } from "../retrieval/embedding/job.js";
import { ProviderQueryEmbedder } from "../retrieval/embedding/queryEmbedder.js";
import { ProviderReranker } from "../retrieval/rerankProvider/providerReranker.js";
import { ProviderQueryRewriter } from "../retrieval/queryRewriteProvider/providerQueryRewriter.js";
import { ProviderSynthesizer } from "../retrieval/synthesisProvider/providerSynthesizer.js";
import { resolveProviderCommandStore } from "../providers/commands/store.js";
import { memoryRetrievalRegistry } from "./retrievalAdapter.js";
import { MemoryMaintenanceService } from "./maintenance.js";
import {
  createMemoryMaintenanceProposalPacket,
  persistMemoryMaintenanceReportArtifact,
} from "./maintenanceArtifacts.js";
import {
  createMemoryMaintenanceJob,
  getMemoryMaintenanceJob,
  runMemoryMaintenanceJobOnce,
} from "./maintenanceJobs.js";
import {
  MemoryReadValidationError,
  PgMemoryReadRepository,
} from "./repository.js";
import {
  MemoryProposalForbiddenError,
  MemoryProposalNotFoundError,
  MemoryProposalPolicyError,
  MemoryProposalValidationError,
  PgMemoryProposalRepository,
} from "./proposalRepository.js";
import {
  applyContentCreationContext,
  resolveContentCreationContext,
} from "../access/creationContext.js";

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
  repository: Pick<PgMemoryReadRepository, "list" | "get" | "search"> &
    Pick<
      PgMemoryProposalRepository,
      "createMemoryProposal" | "updateMemoryProposal" | "archiveMemoryProposal"
    >;
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
  return {
    repository: {
      list: readRepository.list.bind(readRepository),
      get: readRepository.get.bind(readRepository),
      search: readRepository.search.bind(readRepository),
      createMemoryProposal: proposalRepository.createMemoryProposal.bind(proposalRepository),
      updateMemoryProposal: proposalRepository.updateMemoryProposal.bind(proposalRepository),
      archiveMemoryProposal: proposalRepository.archiveMemoryProposal.bind(proposalRepository),
    },
  };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
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

  app.post("/api/v1/memory/search", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const body = protocol.MemorySearchRequestSchema.parse(jsonBody(request));
      // Memory search is strictly identity-scoped: space_id and user_id come
      // only from the authenticated identity, never from the request body
      // (SECURITY_AND_ACCESS_BOUNDARIES §2). A caller can only search their own
      // current space as themselves; any body space_id/user_id is ignored.
      const rows = await memoryServices(context).repository.search(identity.spaceId, identity.userId, {
        query: body.query,
        scope: body.scope ?? null,
        namespace: body.namespace ?? null,
        memoryType: body.type ?? null,
        limit: body.limit,
      });
      return reply.send(rows);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // Advisory duplicate detection for memory proposal creation. It surfaces
  // existing memories (exists / probable_duplicate / unknown) so a create
  // proposal can warn about likely duplicates. It is read-only and must never
  // block creation — the proposal write path is unchanged. Matches returned to
  // the caller are logged through the same memory read-trace as search.
  app.post("/api/v1/memory/create-safety", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const body = protocol.RetrievalCreateSafetyRequestSchema.parse(
        jsonBody(request),
      ) as RetrievalCreateSafetyRequest;
      // The memory surface is scoped to memory objects so it cannot be used to
      // probe Knowledge objects through the memory registry.
      if (body.object_type !== "memory_entry") {
        return reply
          .code(422)
          .send({ detail: "memory create-safety only supports object_type=memory_entry" });
      }
      const search = new RetrievalSearchService(
        getDbPool(context.config.databaseUrl),
        memoryRetrievalRegistry,
      );
      const response = await search.assessCreateSafety({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        objectType: "memory_entry",
        title: body.title ?? null,
        slug: body.slug ?? null,
        aliases: body.aliases ?? [],
        uri: body.uri ?? null,
        excludeObjectId: body.exclude_object_id ?? null,
        maxResults: body.max_results,
      });
      return reply.send(response);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // Human user-facing, retrieval-backed memory search for the caller's CURRENT
  // space only. Cross-space is fail-closed (not implemented here). The single
  // read-access gate is the memory adapter's revalidate: canReadMemory +
  // summary-only redaction + project-membership gating. Only the returned rows
  // are logged to content_access_logs (search_hit) when another member reads
  // owner-attributed content.
  app.post("/api/v1/memory/retrieval/search", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const body = protocol.RetrievalSearchRequestSchema.parse(
        jsonBody(request),
      ) as RetrievalSearchRequest;
      const pool = getDbPool(context.config.databaseUrl);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const controls = resolveRetrievalSearchControls(body, retrievalSettings);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, memoryRetrievalRegistry, {
        egressPolicy,
        // Vector recall arm; provider egress is checked at invocation time, so
        // local providers remain usable when external egress is disabled.
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          retrievalSettings.embeddingDimensions,
          egressPolicy,
        ),
        feedbackService: new RetrievalFeedbackService(pool, memoryRetrievalRegistry),
        // Reranker is off unless this space enables it; degrades to the fused order otherwise.
        reranker: retrievalSettings.rerankEnabled
          ? new ProviderReranker(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "memory_retrieval_search",
              egressPolicy,
            })
          : undefined,
        // Query rewriter is off unless this space enables it; degrades to the original query.
        queryRewriter: retrievalSettings.queryRewriteEnabled
          ? new ProviderQueryRewriter(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "memory_retrieval_search",
              egressPolicy,
            })
          : undefined,
      });
      const response = await search.search({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        // Scoped to memory objects; the memory registry only resolves memory_entry.
        objectTypes: ["memory_entry"],
        objectProfiles: body.object_profiles,
        query: body.query,
        maxResults: controls.maxResults,
        includeTrace: controls.includeTrace,
        feedbackSurface: "memory_retrieval_search",
        mode: controls.mode,
        rewrite: controls.rewrite,
        useCache: controls.useCache,
        adaptiveReturn: controls.adaptiveReturn,
        rankingConfig: controls.rankingConfig,
      });
      return reply.send(response);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/memory/retrieval/brief", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const body = protocol.RetrievalBriefRequestSchema.parse(
        jsonBody(request),
      ) as RetrievalBriefRequest;
      const objectTypes = body.object_types ?? ["memory_entry"];
      if (objectTypes.some((objectType) => objectType !== "memory_entry")) {
        return reply
          .code(422)
          .send({ detail: "memory retrieval brief only supports object_type=memory_entry" });
      }
      const pool = getDbPool(context.config.databaseUrl);
      const retrievalSettings = await readSpaceRetrievalSettings(pool, identity.spaceId);
      const store = resolveProviderCommandStore(context.config);
      const egressPolicy = { externalEgressEnabled: retrievalSettings.externalEgressEnabled };
      const search = new RetrievalSearchService(pool, memoryRetrievalRegistry, {
        egressPolicy,
        queryEmbedder: new ProviderQueryEmbedder(
          store,
          null,
          undefined,
          retrievalSettings.embeddingDimensions,
          egressPolicy,
        ),
        reranker: retrievalSettings.rerankEnabled
          ? new ProviderReranker(store, {
              databaseUrl: context.config.databaseUrl,
              surface: "memory_retrieval_brief",
              egressPolicy,
            })
          : undefined,
        synthesizer: new ProviderSynthesizer(store, {
          databaseUrl: context.config.databaseUrl,
          surface: "memory_retrieval_brief",
          egressPolicy,
        }),
      });
      const maxResults = body.max_results ?? retrievalSettings.maxResultsDefault;
      const includeTrace = body.include_trace ?? retrievalSettings.includeTrace;
      const mode = body.mode ?? retrievalSettings.defaultSearchMode;
      const adaptiveReturn = body.adaptive_return ?? resolveRetrievalSearchControls(body, retrievalSettings).adaptiveReturn;
      const response = await search.buildBrief({
        spaceId: identity.spaceId,
        viewerUserId: identity.userId,
        objectTypes: ["memory_entry"],
        objectProfiles: body.object_profiles,
        query: body.query,
        maxResults,
        includeTrace,
        mode,
        useCache: retrievalSettings.useQueryCache,
        adaptiveReturn,
        rankingConfig: retrievalSettings.rankingConfig,
      });
      if (!body.persist_artifact) return reply.send(response);
      try {
        const artifactId = await persistRetrievalBriefArtifact(pool, {
          spaceId: identity.spaceId,
          ownerUserId: identity.userId,
          runId: null,
          projectId: null,
          query: body.query,
          objectTypes: ["memory_entry"],
          objectProfiles: body.object_profiles,
          maxResults,
          includeTrace,
          mode,
          surface: "memory_retrieval_brief",
          response,
          persistTrace: false,
          egressPolicySnapshot: {
            external_egress_enabled: retrievalSettings.externalEgressEnabled,
          },
          settingsSnapshot: {
            default_search_mode: retrievalSettings.defaultSearchMode,
            rerank_enabled: retrievalSettings.rerankEnabled,
            query_rewrite_enabled: retrievalSettings.queryRewriteEnabled,
            use_query_cache: retrievalSettings.useQueryCache,
            embedding_dimensions: retrievalSettings.embeddingDimensions,
            max_results_default: retrievalSettings.maxResultsDefault,
          },
        });
        return reply.send({ ...response, artifact_id: artifactId });
      } catch (error) {
        request.log.warn(
          { err: error },
          "memory retrieval brief artifact persistence failed",
        );
        return reply.send({ ...response, artifact_error: "retrieval_brief_persist_failed" });
      }
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/memory/retrieval/feedback", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const body = protocol.RetrievalFeedbackRequestSchema.parse(
        jsonBody(request),
      ) as RetrievalFeedbackRequest;
      if (body.object_type !== "memory_entry") {
        return reply
          .code(422)
          .send({ detail: "memory retrieval feedback only supports object_type=memory_entry" });
      }
      const pool = getDbPool(context.config.databaseUrl);
      const recorded = await withDbTransaction(pool, async (client) => {
        const ok = await new RetrievalFeedbackService(client, memoryRetrievalRegistry).record({
          spaceId: identity.spaceId,
          viewerUserId: identity.userId,
          surface: "memory_retrieval_search",
          query: body.query,
          objectType: "memory_entry",
          objectId: body.object_id,
          signalType: body.signal_type,
          dwellMs: body.dwell_ms ?? null,
          metadata: body.metadata ?? null,
        });
        if (!ok) return false;
        await new PgMemoryReadRepository(client).recordRetrievalFeedbackReads(
          [body.object_id],
          identity.spaceId,
          identity.userId,
        );
        return true;
      });
      if (!recorded) return reply.code(404).send({ detail: "Retrieval result not found" });
      return reply.send({ ok: true });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // Owner-private Memory maintenance scan. The scan runs through the normal
  // memory visibility gate, emits only IDs/titles/reasons, and logs only final
  // findings that contributed to the report.
  app.post("/api/v1/memory/maintenance/scan", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const body = protocol.MemoryMaintenanceScanRequestSchema.parse(
        jsonBody(request),
      ) as MemoryMaintenanceScanRequest;
      if (body.create_packet && !body.persist_report) {
        return reply
          .code(422)
          .send({ detail: "create_packet requires persist_report" });
      }
      const pool = getDbPool(context.config.databaseUrl);
      const canScan = await canInitiateContextOpsScan(pool, identity.spaceId, identity.userId);
      if (!canScan) {
        return reply.code(403).send({ detail: "Requires space owner/admin role or enabled Context Ops member scan access" });
      }
      const reviewScope = body.review_scope ?? "private";
      if (reviewScope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
        if (!allowed) {
          return reply.code(403).send({ detail: "space-wide Context Ops review is not enabled for this reviewer" });
        }
      }
      const scanInput = {
        spaceId: identity.spaceId,
        userId: identity.userId,
        limit: body.limit,
        staleAfterDays: body.stale_after_days,
        thinContentChars: body.thin_content_chars,
        maxFindings: body.max_findings,
        projectId: body.project_id ?? null,
        scanMode: body.scan_mode,
        cursor: body.cursor ?? null,
        excludePersonalVisibility: reviewScope === "space_ops",
      };
      const scanOptions = {
        limit: body.limit,
        stale_after_days: body.stale_after_days,
        thin_content_chars: body.thin_content_chars,
        max_findings: body.max_findings,
        project_id: body.project_id ?? null,
        scan_mode: body.scan_mode,
        cursor: body.cursor ?? null,
      };

      if (body.persist_report) {
        const persisted = await withDbTransaction(pool, async (client) => {
          const result = await new MemoryMaintenanceService(client).scan(scanInput);
          const artifactId = await persistMemoryMaintenanceReportArtifact(client, {
            spaceId: identity.spaceId,
            ownerUserId: identity.userId,
            report: result.report,
            scanOptions,
            reviewScope,
          });
          const proposalId = body.create_packet
            ? await createMemoryMaintenanceProposalPacket(client, {
                spaceId: identity.spaceId,
                ownerUserId: identity.userId,
                report: result.report,
                scanOptions,
                artifactId,
                reviewScope,
              })
            : undefined;
          await new PgMemoryReadRepository(client).recordMaintenanceReads(
            result.contributingMemoryIds,
            identity.spaceId,
            identity.userId,
            artifactId,
          );
          return { report: result.report, artifactId, proposalId };
        });
        return reply.send({
          ...persisted.report,
          artifact_id: persisted.artifactId,
          ...(persisted.proposalId ? { proposal_id: persisted.proposalId } : {}),
        });
      }

      const result = await new MemoryMaintenanceService(pool).scan(scanInput);
      await new PgMemoryReadRepository(pool).recordMaintenanceReads(
        result.contributingMemoryIds,
        identity.spaceId,
        identity.userId,
        null,
      );
      return reply.send(result.report);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/memory/maintenance/jobs", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const body = protocol.MemoryMaintenanceJobCreateRequestSchema.parse(jsonBody(request));
      if (body.create_packet && !body.persist_report) {
        return reply.code(422).send({ detail: "create_packet requires persist_report" });
      }
      const pool = getDbPool(context.config.databaseUrl);
      const canScan = await canInitiateContextOpsScan(pool, identity.spaceId, identity.userId);
      if (!canScan) {
        return reply.code(403).send({ detail: "Requires space owner/admin role or enabled Context Ops member scan access" });
      }
      if (body.review_scope === "space_ops") {
        const allowed = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
        if (!allowed) {
          return reply.code(403).send({ detail: "space-wide Context Ops review is not enabled for this reviewer" });
        }
      }
      const job = await createMemoryMaintenanceJob(pool, {
        spaceId: identity.spaceId,
        ownerUserId: identity.userId,
        request: body,
      });
      return reply.code(201).send(protocol.MemoryMaintenanceJobSchema.parse(job));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

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

  app.post("/api/v1/memory/maintenance/jobs/:jobId/run", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const pool = getDbPool(context.config.databaseUrl);
      const canScan = await canInitiateContextOpsScan(pool, identity.spaceId, identity.userId);
      if (!canScan) {
        return reply.code(403).send({ detail: "Requires space owner/admin role or enabled Context Ops member scan access" });
      }
      const includeSpaceOps = await canReviewSpaceOpsPackets(pool, identity.spaceId, identity.userId);
      const result = await withDbTransaction(pool, async (client) =>
        runMemoryMaintenanceJobOnce(client, {
          spaceId: identity.spaceId,
          userId: identity.userId,
          jobId: params(request).jobId ?? "",
          includeSpaceOps,
        }));
      if (!result) return reply.code(404).send({ detail: "Memory maintenance job not found" });
      return reply.send(protocol.MemoryMaintenanceJobRunResponseSchema.parse(result));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // Rebuild the derived memory retrieval projection for the caller's space.
  // Derived, idempotent, space-scoped maintenance; requires space owner/admin.
  app.post("/api/v1/memory/retrieval/reindex", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!(await requireSpaceMaintenanceRole(context.config, identity, reply))) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const projection = new RetrievalProjectionService(
        getDbPool(context.config.databaseUrl),
        memoryRetrievalRegistry,
      );
      const summary = await projection.reindexAll(identity.spaceId);
      const embeddingBackfill = await enqueueRetrievalEmbeddingBackfill(context.config, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        trigger: "memory_retrieval_reindex",
      }).catch((error) => {
        process.stderr.write(
          `[memory.retrieval] embedding backfill enqueue failed: ${String((error as Error)?.message ?? error)}\n`,
        );
        return null;
      });
      return reply.send({
        ok: true,
        reindexed: summary,
        embedding_backfill_job_id: embeddingBackfill?.jobId ?? null,
      });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/memory", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(getDbPool(context.config.databaseUrl), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      const command = protocol.MemoryProposalCreateCommandSchema.parse({
        ...applyContentCreationContext(body, creation),
        operation: "create",
        scope: creation.projectId ? "project" : "user",
      });
      const proposal = await memoryServices(context).repository.createMemoryProposal(
        creation.spaceId,
        identity.userId,
        command,
      );
      return reply.code(202).send(proposal);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.patch("/api/v1/memory/:memoryId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const memoryId = params(request).memoryId ?? "";
    try {
      const command = protocol.MemoryProposalUpdateCommandSchema.parse({
        ...jsonBody(request),
        operation: "update",
        target_memory_id: memoryId,
      });
      const proposal = await memoryServices(context).repository.updateMemoryProposal(
        identity.spaceId,
        identity.userId,
        memoryId,
        command,
      );
      return reply.code(202).send(proposal);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.delete("/api/v1/memory/:memoryId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const memoryId = params(request).memoryId ?? "";
    try {
      const command = protocol.MemoryProposalArchiveCommandSchema.parse({
        operation: "archive",
        target_memory_id: memoryId,
      });
      const proposal = await memoryServices(context).repository.archiveMemoryProposal(
        identity.spaceId,
        identity.userId,
        memoryId,
        command,
      );
      return reply.code(202).send(proposal);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/api/v1/memory/consolidation/run", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    if (!context.config.databaseUrl) {
      return reply.code(502).send({ detail: "SERVER_DATABASE_URL is required" });
    }
    try {
      const body = jsonBody(request);
      const batchLimit = boundedInt(body.batch_limit, 50, 1, 500);
      const rawIds = body.activity_ids;
      const activityIds =
        Array.isArray(rawIds) && rawIds.length > 0 ? rawIds.map((value) => String(value)) : null;
      const repo = new PgActivityConsolidationRepository(getDbPool(context.config.databaseUrl));
      const result = await repo.runPending({
        spaceId: identity.spaceId,
        actingUserId: identity.userId,
        batchLimit,
        activityIds,
      });
      return reply.send(result);
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
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(context.config, request);
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

async function requireSpaceMaintenanceRole(
  config: ServerConfig,
  identity: MemoryIdentity,
  reply: FastifyReply,
): Promise<boolean> {
  return requireSpaceOwnerOrAdmin(config, identity, reply);
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
  const message = error instanceof Error ? error.message : "Request failed";
  return reply.code(400).send({ detail: message });
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const text = request.body instanceof Buffer ? request.body.toString("utf8") : "";
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intQuery(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return Math.min(Math.max(value, min), max);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return Math.min(Math.max(parsed, min), max);
  }
  return fallback;
}
