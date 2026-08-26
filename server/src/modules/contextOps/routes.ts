import type { FastifyInstance, FastifyReply } from "fastify";
import * as protocol from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, intQuery, jsonBody, query, resolveIdentity, sendRouteError, HttpError, withDbTransaction } from "../routeUtils/common.js";
import { authRepositoryFromConfig } from "../auth/identity.js";
import { readSpaceRetrievalSettings } from "../retrieval/settings.js";
import { knowledgeRetrievalRegistry } from "../knowledge/retrievalAdapter.js";
import { roleCanInitiateContextOpsScan, roleCanReviewSpaceOps, type SpaceRole } from "./reviewPolicy.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";
import { ContextOpsService } from "./service.js";
import { runContextReviewCycle } from "./reviewCycle.js";
import { runContextObservationScan } from "./contextObservations.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/context-ops/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const windowDays = intQuery(q.window_days, 14);
      const limit = intQuery(q.limit, 10);
      if (windowDays === null || windowDays < 1 || windowDays > 90) {
        throw new HttpError(422, "window_days must be between 1 and 90");
      }
      if (limit === null || limit < 1 || limit > 50) {
        throw new HttpError(422, "limit must be between 1 and 50");
      }
      const access = await requireSpaceContextOpsRole(context.config, identity, reply);
      if (!access) return reply;
      const service = ContextOpsService.fromConfig(context.config);
      const summary = await service.getSummary({
        spaceId: identity.spaceId,
        userId: identity.userId,
        windowDays,
        limit,
        includeSpaceOpsReports: access.includeSpaceOpsReports,
      });
      return reply.send(protocol.ContextOpsSummarySchema.parse(summary));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/context-ops/drilldown", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const section = protocol.ContextOpsDrilldownSectionSchema.safeParse(q.section);
      if (!section.success) {
        throw new HttpError(
          422,
          "section must be one of index_freshness, embedding_backlog, source_warnings, maintenance_reports, diagnostics_reports, explain_reports, recent_briefs",
        );
      }
      const limit = intQuery(q.limit, 20);
      if (limit === null || limit < 1 || limit > 100) {
        throw new HttpError(422, "limit must be between 1 and 100");
      }
      const access = await requireSpaceContextOpsRole(context.config, identity, reply);
      if (!access) return reply;
      const service = ContextOpsService.fromConfig(context.config);
      const drilldown = await service.getDrilldown({
        spaceId: identity.spaceId,
        userId: identity.userId,
        section: section.data,
        limit,
        registry: knowledgeRetrievalRegistry,
        includeAllSources: access.isSpaceAdmin,
        includeSpaceOpsReports: access.includeSpaceOpsReports,
      });
      return reply.send(protocol.ContextOpsDrilldownSchema.parse(drilldown));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/context-ops/review-cycle/run", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const parsed = protocol.ContextReviewCycleRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) throw new HttpError(422, validationMessage(parsed.error.issues));
      const access = await requireSpaceContextOpsRole(context.config, identity, reply);
      if (!access) return reply;
      if (!access.canScan) {
        throw new HttpError(403, "Requires space owner/admin role or enabled Context Ops member scan access");
      }
      if (parsed.data.review_scope === "space_ops" && !access.includeSpaceOpsReports) {
        throw new HttpError(403, "space-wide Context Ops review is not enabled for this reviewer");
      }
      const result = await withDbTransaction(dbPool(context.config), async (client) =>
        runContextReviewCycle(client, {
          spaceId: identity.spaceId,
          userId: identity.userId,
          request: parsed.data,
        }));
      return reply.code(201).send(protocol.ContextReviewCycleResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/context-ops/context-observations/scan", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const parsed = protocol.ContextOpsContextObservationScanRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) throw new HttpError(422, validationMessage(parsed.error.issues));
      const access = await requireSpaceContextOpsRole(context.config, identity, reply);
      if (!access) return reply;
      if (!access.canScan) {
        throw new HttpError(403, "Requires space owner/admin role or enabled Context Ops member scan access");
      }
      const result = await withDbTransaction(dbPool(context.config), async (client) =>
        runContextObservationScan(client, {
          spaceId: identity.spaceId,
          userId: identity.userId,
          request: parsed.data,
        }));
      return reply.code(201).send(protocol.ContextOpsContextObservationScanResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

async function requireSpaceContextOpsRole(
  config: ServerConfig,
  identity: { spaceId: string; userId: string },
  reply: FastifyReply,
): Promise<{ includeSpaceOpsReports: boolean; isSpaceAdmin: boolean; canScan: boolean } | null> {
  const repository = authRepositoryFromConfig(config);
  if (!repository) {
    reply.code(502).send({ detail: "Identity database is unavailable" });
    return null;
  }
  const space = await repository.getSpaceForUser(identity.userId, identity.spaceId);
  if (!space) {
    reply.code(404).send({ detail: "Space not found" });
    return null;
  }
  if ("statusCode" in space) {
    reply.code(space.statusCode).send({ detail: space.detail });
    return null;
  }
  const settings = await readSpaceRetrievalSettings(dbPool(config), identity.spaceId);
  const role = space.role as SpaceRole;
  const canReviewSpaceOps = roleCanReviewSpaceOps(role, settings.contextOpsReviewMode);
  const canScan = roleCanInitiateContextOpsScan(role, settings.contextOpsScanMode);
  if (!canScan && !canReviewSpaceOps) {
    reply.code(403).send({ detail: "Requires space owner/admin role or enabled Context Ops member review/scan access" });
    return null;
  }
  return {
    includeSpaceOpsReports: canReviewSpaceOps,
    isSpaceAdmin: isSpaceOwnerOrAdmin(role),
    canScan,
  };
}

function validationMessage(issues: Array<{ path: Array<string | number>; message: string }>): string {
  const issue = issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
