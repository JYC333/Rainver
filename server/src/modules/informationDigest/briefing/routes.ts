import type { FastifyInstance } from "fastify";
import { BriefingGenerateRequestSchema, BriefingSettingsRequestSchema } from "@rainver/protocol";
import type { ModuleContext } from "../../../gateway/routeRegistry.js";
import { assertProjectReadable, assertProjectWriter } from "../../projects/access.js";
import { dbPool, HttpError, jsonBody, params, parseBody, resolveIdentity, sendRouteError, type Queryable } from "../../routeUtils/common.js";
import { projectBriefingScope } from "./projectScope.js";
import { readDailyBriefingSetting, setDailyBriefing } from "./schedule.js";
import { InformationBriefingService } from "./service.js";

const BASE = "/api/v1/spaces/:spaceId/projects/:projectId/information-briefings";

export async function projectBriefingLabel(db: Queryable, spaceId: string, projectId: string): Promise<string> {
  const name = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE space_id = $1 AND id = $2`, [spaceId, projectId])).rows[0]?.name;
  return `the Project "${(name ?? "Project").slice(0, 200)}"`;
}

/**
 * Project briefings. Reads need Project read access and never generate;
 * generating, cancelling and the daily setting need Project write access.
 */
export function registerBriefingRoutes(app: FastifyInstance, context: ModuleContext): void {
  const scoped = async (request: Parameters<typeof resolveIdentity>[1], reply: Parameters<typeof resolveIdentity>[2]) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return null;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) {
      reply.code(403).send({ detail: "Access denied" });
      return null;
    }
    const projectId = params(request).projectId ?? "";
    const db = dbPool(context.config);
    await assertProjectReadable(db, spaceId, projectId, identity.userId);
    return { identity, db, spaceId, projectId, adapter: projectBriefingScope(spaceId, projectId), service: new InformationBriefingService(db, context.config) };
  };

  app.get(BASE, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      const daily = await readDailyBriefingSetting(scope.db, scope.spaceId, scope.projectId);
      return reply.send(await scope.service.overview(scope.adapter, scope.identity.userId, daily.enabled));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${BASE}/:briefingId`, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      return reply.send(await scope.service.get(scope.adapter, scope.identity.userId, params(request).briefingId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(BASE, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      await assertProjectWriter(scope.db, scope.spaceId, scope.projectId, scope.identity.userId);
      const body = parseBody(BriefingGenerateRequestSchema, jsonBody(request) ?? {});
      const label = await projectBriefingLabel(scope.db, scope.spaceId, scope.projectId);
      const execution = { agent_id: body.agent_id, runtime_profile_id: body.runtime_profile_id };
      let result;
      if (body.date) {
        // A sealed day briefed later: only a day whose digest exists, behind no later version.
        const digest = (await scope.db.query<{ id: string; period_end_utc: string }>(
          `SELECT id, period_end_utc::text FROM information_digests WHERE space_id = $1 AND project_id = $2 AND digest_date = $3 AND digest_type = 'project'`,
          [scope.spaceId, scope.projectId, body.date],
        )).rows[0];
        if (!digest) throw new HttpError(422, "That day has no sealed Project digest", { code: "briefing_day_not_sealed" });
        result = await scope.service.request(scope.adapter, scope.identity.userId, {
          kind: "backfill", day: { date: body.date, digestId: digest.id, cutoff: new Date(digest.period_end_utc).toISOString() },
          execution, origin: "manual", label,
        });
      } else {
        result = await scope.service.request(scope.adapter, scope.identity.userId, { kind: "manual", execution, origin: "manual", label });
      }
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${BASE}/:briefingId/cancel`, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      return reply.send(await scope.service.cancel(scope.adapter, scope.identity.userId, params(request).briefingId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put(`${BASE}/settings`, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      await assertProjectWriter(scope.db, scope.spaceId, scope.projectId, scope.identity.userId);
      const body = parseBody(BriefingSettingsRequestSchema, jsonBody(request));
      const setting = await setDailyBriefing(scope.db, scope.spaceId, scope.projectId, scope.identity.userId, body);
      return reply.send({ daily_enabled: setting.enabled });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
