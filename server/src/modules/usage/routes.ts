import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  boolQuery,
  HttpError,
  intQuery,
  jsonBody,
  optionalString,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { requireInstanceAdmin } from "../routeUtils/access.js";
import { UsageService, type UsageQueryInput } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = () => UsageService.fromConfig(context.config);

  app.get("/api/v1/usage/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().summary(identity, usageQueryInput(query(request))));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/usage/timeseries", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const input = usageQueryInput(query(request));
      input.granularity = granularity(query(request).granularity);
      return reply.send(await service().timeseries(identity, input));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/usage/events", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().events(identity, usageQueryInput(query(request), 50)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/usage/dimensions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().dimensions(identity, usageQueryInput(query(request))));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/usage/subjects", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().subjects(identity, usageQueryInput(query(request), 100)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/usage/sessions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().sessions(identity, usageQueryInput(query(request), 100)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/usage/budget-preview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const projectionWindowDays = intQuery(q.projection_window_days, 30);
      if (projectionWindowDays === null || projectionWindowDays < 1 || projectionWindowDays > 366) {
        throw new HttpError(422, "projection_window_days must be between 1 and 366");
      }
      return reply.send(await service().budgetPreview(
        identity,
        usageQueryInput(q, 100),
        projectionWindowDays,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/usage/operations/totals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try {
      const q = query(request);
      assertQueryKeys(q, new Set(["from", "to"]));
      return reply.send(await service().operationalTotals({
        from: optionalString(q.from),
        to: optionalString(q.to),
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/usage/imports/cli-history/preview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      return reply.send(await service().previewCliHistoryImport(identity, cliHistoryPreviewInput(body)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/usage/imports/cli-history/commit", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      return reply.send(await service().commitCliHistoryImport(identity, cliHistoryCommitInput(body)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

}

function usageQueryInput(q: Record<string, string | undefined>, fallbackLimit = 100): UsageQueryInput {
  assertQueryKeys(q, USAGE_QUERY_KEYS);
  const limit = intQuery(q.limit, fallbackLimit);
  const offset = intQuery(q.offset, 0);
  if (limit === null || limit < 1 || limit > 500) {
    throw new HttpError(422, "limit must be between 1 and 500");
  }
  if (offset === null || offset < 0) {
    throw new HttpError(422, "offset must be non-negative");
  }
  return {
    view: optionalString(q.view),
    from: optionalString(q.from),
    to: optionalString(q.to),
    groupBy: optionalString(q.group_by),
    accuracy: optionalString(q.accuracy),
    executionChannel: optionalString(q.execution_channel),
    providerId: optionalString(q.provider_id),
    model: optionalString(q.model),
    task: optionalString(q.task),
    subjectType: optionalString(q.subject_type),
    subjectId: optionalString(q.subject_id),
    sessionId: optionalString(q.session_id),
    externalSessionId: optionalString(q.external_session_id),
    sessionPath: optionalString(q.session_path),
    dimensionKey: optionalString(q.dimension_key),
    dimensionValue: optionalString(q.dimension_value),
    includeImported: q.include_imported === undefined ? undefined : boolQuery(q.include_imported),
    limit,
    offset,
  };
}

const USAGE_QUERY_KEYS = new Set([
  "view",
  "from",
  "to",
  "group_by",
  "accuracy",
  "execution_channel",
  "provider_id",
  "model",
  "task",
  "subject_type",
  "subject_id",
  "session_id",
  "external_session_id",
  "session_path",
  "dimension_key",
  "dimension_value",
  "include_imported",
  "limit",
  "offset",
  "granularity",
  "projection_window_days",
]);

function assertQueryKeys(
  input: Record<string, string | undefined>,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new HttpError(422, `Unknown Usage query parameter '${unknown}'`);
}

function granularity(value: string | undefined): "day" | "week" | "month" {
  return value === "week" || value === "month" ? value : "day";
}

function cliHistoryPreviewInput(body: Record<string, unknown>): {
  runtime?: string | null;
  sourceKind?: string | null;
  credentialProfileId?: string | null;
  targetSpaceId?: string | null;
} {
  return {
    runtime: bodyString(body.runtime),
    sourceKind: bodyString(body.source_kind),
    credentialProfileId: bodyString(body.credential_profile_id),
    targetSpaceId: bodyString(body.target_space_id),
  };
}

function cliHistoryCommitInput(body: Record<string, unknown>): {
  importBatchId?: string | null;
  targetSpaceId?: string | null;
  confirmation?: boolean;
} {
  return {
    importBatchId: bodyString(body.import_batch_id),
    targetSpaceId: bodyString(body.target_space_id),
    confirmation: body.confirmation === true,
  };
}

function bodyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
