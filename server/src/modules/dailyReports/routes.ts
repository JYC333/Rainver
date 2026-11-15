import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  HttpError,
  intQuery,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { contentOwnerFilterSql, contentReadSql } from "../access/contentAccessSql.js";
import { PgDailyReportSettingsRepository } from "./repository.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const settingsRepo = () => new PgDailyReportSettingsRepository(dbPool(context.config));

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

  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/daily-capture-report/run',operation:'daily_capture.run'},
    {method:'PATCH',url:'/api/v1/daily-capture-report/settings',operation:'daily_capture.settings.patch'},
    {method:'PUT',url:'/api/v1/daily-capture-report/settings',operation:'daily_capture.settings.set'},
  ]);

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
