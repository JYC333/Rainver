import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  HttpError,
  intQuery,
  jsonBody,
  optionalString,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { contentOwnerFilterSql, contentReadSql } from "../access/contentAccessSql.js";
import { DailyCaptureReportService } from "./service.js";
import { PgDailyReportSettingsRepository } from "./repository.js";
import { isLocalDayComplete, isValidTimezone, localDateNow, previousLocalDate } from "../scheduler/localDay.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const settingsRepo = () => new PgDailyReportSettingsRepository(dbPool(context.config));
  const service = () => new DailyCaptureReportService(dbPool(context.config), context.config);

  app.get("/api/v1/daily-capture-report/settings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const row = await settingsRepo().getOrCreate(identity.spaceId, identity.userId);
      return reply.send(settingsRepo().toOut(row));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  const updateSettings = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const row = await settingsRepo().update(
        identity.spaceId,
        identity.userId,
        jsonBody(request),
      );
      return reply.send(settingsRepo().toOut(row));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  };
  app.put("/api/v1/daily-capture-report/settings", updateSettings);
  app.patch("/api/v1/daily-capture-report/settings", updateSettings);

  app.post("/api/v1/daily-capture-report/run", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const setting = await settingsRepo().getOrCreate(identity.spaceId, identity.userId);
      const timezone = setting.timezone || "UTC";
      const localDate = parseLocalDate(body.local_date, timezone);
      const result = await service().generateForDate({
        spaceId: identity.spaceId,
        userId: identity.userId,
        setting,
        localDate,
        triggerOrigin: "manual",
        createExperienceProposalsOverride: optionalBodyBoolean(
          body.create_experience_proposals,
          "create_experience_proposals",
        ),
        createMemoryProposalsOverride: optionalBodyBoolean(
          body.create_memory_proposals,
          "create_memory_proposals",
        ),
      });
      return reply.code(201).send({
        run_id: result.run_id,
        artifact_id: result.artifact_id ?? result.existing_artifact_id,
        proposal_ids: result.proposal_ids,
        experience_proposal_ids: result.experience_proposal_ids,
        memory_proposal_ids: result.memory_proposal_ids,
        capture_count: result.capture_count,
        status: result.status,
        summary_preview: result.summary_preview,
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/daily-capture-report/reports", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const limit = intQuery(query(request).limit, 10);
      if (limit === null || limit < 1 || limit > 50) {
        throw new HttpError(422, "limit must be between 1 and 50");
      }
      const db = dbPool(context.config);
      const result = await db.query(
        `SELECT a.id, a.run_id, a.title, a.content, a.metadata_json, a.created_at
           FROM artifacts a
          WHERE a.space_id = $1
            AND ${contentReadSql("artifact", "a", "$2")}
            AND ${contentOwnerFilterSql("artifact", "a", "$2")}
            AND a.artifact_type = 'daily_capture_report'
          ORDER BY a.created_at DESC
          LIMIT $3`,
        [identity.spaceId, identity.userId, limit],
      );
      return reply.send(result.rows);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

/**
 * The day a requested report covers: a named local date, or by default the
 * most recent complete day of the configured timezone. Only a complete day:
 * a report on a day still in progress would be a report on part of it, and
 * one report per day is never rewritten.
 */
function parseLocalDate(value: unknown, timezone: string): string {
  if (!isValidTimezone(timezone)) {
    throw new HttpError(422, `timezone ${JSON.stringify(timezone)} is not a valid IANA timezone`);
  }
  if (value === undefined || value === null) return previousLocalDate(localDateNow(timezone));
  const localDate = optionalString(value);
  if (!localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new HttpError(422, "local_date must be YYYY-MM-DD");
  }
  if (!isLocalDayComplete(localDate, timezone)) {
    throw new HttpError(422, `${localDate} has not ended in ${timezone}; only a complete day can be reported`, {
      detail: `${localDate} has not ended in ${timezone}; only a complete day can be reported`,
      code: "report_day_not_complete",
    });
  }
  return localDate;
}

function optionalBodyBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new HttpError(422, `${field} must be a boolean`);
  }
  return value;
}
