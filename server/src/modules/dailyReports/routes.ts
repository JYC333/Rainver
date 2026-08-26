import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  HttpError,
  jsonBody,
  optionalString,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { contentOwnerFilterSql, contentReadSql } from "../access/contentAccessSql.js";
import { DailyCaptureReportService } from "./service.js";
import { PgDailyReportSettingsRepository } from "./repository.js";

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
      const localDate = parseLocalDate(
        body.local_date,
        setting.timezone || "UTC",
      );
      const result = await service().generateForDate({
        spaceId: identity.spaceId,
        userId: identity.userId,
        setting,
        localDate,
        triggerOrigin: "manual",
        force: optionalBodyBoolean(body.force, "force") ?? false,
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
      const limit = Math.min(Number(query(request).limit ?? 10), 50);
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

function parseLocalDate(value: unknown, timezone: string): string {
  const explicit = optionalString(value);
  if (value !== undefined && !explicit) {
    throw new HttpError(422, "local_date must be YYYY-MM-DD");
  }
  let localDate = explicit;
  if (!localDate) {
    try {
      localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
    } catch {
      throw new HttpError(422, `timezone ${JSON.stringify(timezone)} is not a valid IANA timezone`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new HttpError(422, "local_date must be YYYY-MM-DD");
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
