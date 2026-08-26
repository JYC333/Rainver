import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { resolveRequestId } from "../../gateway/requestContext.js";
import {
  boolQuery,
  dbPool,
  HttpError,
  intQuery,
  jsonBody,
  optionalString,
  query,
  resolveIdentity,
} from "../routeUtils/common.js";
import { assertProjectInSpace } from "../projects/access.js";
import { GraphProjectionBuilder, parseGraphLensId, type ServerGraphProjectionMode } from "./projectionBuilder.js";
import { GraphProjectionRepository } from "./projectionRepository.js";
import { GraphViewStateRepository, normalizeStateObject } from "./viewStateRepository.js";

const DEFAULT_LIMIT = 300;
const HARD_LIMIT = 2000;
const SERVER_MODES = new Set<ServerGraphProjectionMode>(["global", "local", "cluster", "search"]);

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const pool = () => dbPool(context.config);
  const projectionBuilder = () => new GraphProjectionBuilder(new GraphProjectionRepository(pool()));
  const viewStates = () => new GraphViewStateRepository(pool());

  app.get("/api/v1/graph/projection", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const mode = parseMode(optionalString(q.mode) ?? "global");
      const depth = parseOptionalInt(q.depth, "depth");
      const limit = parseLimit(q.limit);
      const projectId = optionalString(q.project_id);
      const lensId = parseGraphLensId(optionalString(q.lens_id) ?? undefined);
      if (projectId) {
        await assertProjectInSpace(pool(), identity.spaceId, projectId, { statusCode: 404 });
      }
      const projection = await projectionBuilder().build(identity, {
        mode,
        rootId: optionalString(q.root_id) ?? undefined,
        depth: depth ?? undefined,
        nodeKinds: csv(q.node_kinds),
        edgeKinds: csv(q.edge_kinds),
        q: optionalString(q.q) ?? undefined,
        projectId: projectId ?? undefined,
        lensId,
        limit,
        includeClusters: boolQuery(q.include_clusters, true),
      });
      return reply.send(projection);
    } catch (error) {
      return sendGraphRouteError(request, reply, error);
    }
  });

  app.get("/api/v1/graph/view-state", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const scopeKey = optionalString(query(request).scope_key);
      if (!scopeKey) throw new HttpError(422, "scope_key is required");
      return reply.send(await viewStates().get(identity, scopeKey));
    } catch (error) {
      return sendGraphRouteError(request, reply, error);
    }
  });

  app.put("/api/v1/graph/view-state", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const scopeKey = optionalString(body.scope_key);
      if (!scopeKey) throw new HttpError(422, "scope_key is required");
      const stateJson = normalizeStateObject(body.state_json ?? {});
      return reply.send(await viewStates().upsert(identity, scopeKey, stateJson));
    } catch (error) {
      return sendGraphRouteError(request, reply, error);
    }
  });
}

function parseMode(value: string): ServerGraphProjectionMode {
  if (SERVER_MODES.has(value as ServerGraphProjectionMode)) return value as ServerGraphProjectionMode;
  if (value === "debug") throw new HttpError(422, "debug graph mode is frontend-only");
  throw new HttpError(422, "invalid graph mode");
}

function parseLimit(value: string | undefined): number {
  const limit = intQuery(value, DEFAULT_LIMIT);
  if (limit === null || limit < 1 || limit > HARD_LIMIT) {
    throw new HttpError(422, `limit must be between 1 and ${HARD_LIMIT}`);
  }
  return limit;
}

function parseOptionalInt(value: string | undefined, field: string): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new HttpError(422, `${field} must be an integer`);
  return parsed;
}

function csv(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function sendGraphRouteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof HttpError) {
    const safe = routeErrorBody(error.statusCode, error.message);
    return sendErrorEnvelope(
      reply,
      error.statusCode,
      errorEnvelope(safe.error, safe.message, resolveRequestId(request)),
    );
  }
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    const statusCode = (error as { statusCode: number }).statusCode;
    const safe = routeErrorBody(statusCode, error.message);
    return sendErrorEnvelope(
      reply,
      statusCode,
      errorEnvelope(safe.error, safe.message, resolveRequestId(request)),
    );
  }
  throw error;
}

function routeErrorBody(
  statusCode: number,
  message: string,
): { error: "request_error" | "internal_error"; message: string } {
  if (statusCode >= 500) {
    return { error: "internal_error", message: "Internal server error" };
  }
  return { error: "request_error", message };
}
