import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BriefingGenerateRequestSchema, BriefingSettingsRequestSchema } from "@rainver/protocol";
import type { ModuleContext } from "../../../gateway/routeRegistry.js";
import { assertProjectReadable } from "../../projects/access.js";
import { dbPool, HttpError, jsonBody, params, parseBody, resolveIdentity, sendRouteError, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common.js";
import type { BriefingScopeAdapter } from "./contract.js";
import { personalBriefingScope } from "./personalScope.js";
import { projectBriefingScope } from "./projectScope.js";
import { readDailyBriefingSetting, setDailyBriefing } from "./schedule.js";
import { InformationBriefingService } from "./service.js";

const PROJECT_BASE = "/api/v1/spaces/:spaceId/projects/:projectId/information-briefings";
const PERSONAL_BASE = "/api/v1/spaces/:spaceId/information-briefings/personal";

export async function projectBriefingLabel(db: Queryable, spaceId: string, projectId: string): Promise<string> {
  const name = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE space_id = $1 AND id = $2`, [spaceId, projectId])).rows[0]?.name;
  return `the Project "${(name ?? "Project").slice(0, 200)}"`;
}

/** The personal briefing's label: whose and from what, never another person's name. */
export const PERSONAL_BRIEFING_LABEL = "this reader's personal Reading (their Following, subscribed Sources and the Projects they opted into Reading)";

/** What a briefing route needs to know about its scope; the handlers are the same for every scope. */
interface ScopeRoute {
  adapter: BriefingScopeAdapter;
  label: (db: Queryable) => Promise<string>;
  /** The sealed digest of `date` for this scope, if it exists. */
  sealedDay: (db: Queryable, date: string) => Promise<{ id: string; period_end_utc: string } | null>;
}

type Resolve = (db: Queryable, request: FastifyRequest, identity: SpaceUserIdentity) => Promise<ScopeRoute>;

/**
 * Briefing routes of a scope. Reads need read access to the scope and never
 * generate; generating, cancelling and the daily setting need the right to
 * generate it (a Project writer; for a personal briefing, its owner).
 */
function registerScopeRoutes(app: FastifyInstance, context: ModuleContext, base: string, resolve: Resolve): void {
  const scoped = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return null;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) {
      reply.code(403).send({ detail: "Access denied" });
      return null;
    }
    const db = dbPool(context.config);
    const route = await resolve(db, request, identity);
    return { identity, db, route, service: new InformationBriefingService(db, context.config) };
  };
  const requireGenerate = async (db: Queryable, adapter: BriefingScopeAdapter, userId: string) => {
    if (!(await adapter.canGenerate(db, userId))) throw new HttpError(403, "Generating this briefing requires write access", { code: "briefing_writer_required" });
  };

  app.get(base, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      const daily = await readDailyBriefingSetting(scope.db, scope.route.adapter);
      return reply.send(await scope.service.overview(scope.route.adapter, scope.identity.userId, daily.enabled));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/:briefingId`, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      return reply.send(await scope.service.get(scope.route.adapter, scope.identity.userId, params(request).briefingId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(base, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      const { adapter } = scope.route;
      await requireGenerate(scope.db, adapter, scope.identity.userId);
      const body = parseBody(BriefingGenerateRequestSchema, jsonBody(request) ?? {});
      const label = await scope.route.label(scope.db);
      const execution = { agent_id: body.agent_id, runtime_profile_id: body.runtime_profile_id };
      let result;
      if (body.date) {
        // A sealed day briefed later: only a day whose digest exists, behind no later version.
        const digest = await scope.route.sealedDay(scope.db, body.date);
        if (!digest) throw new HttpError(422, "That day has no sealed digest", { code: "briefing_day_not_sealed" });
        result = await scope.service.request(adapter, scope.identity.userId, {
          kind: "backfill", day: { date: body.date, digestId: digest.id, cutoff: new Date(digest.period_end_utc).toISOString() },
          execution, origin: "manual", label,
        });
      } else {
        result = await scope.service.request(adapter, scope.identity.userId, { kind: "manual", execution, origin: "manual", label });
      }
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:briefingId/cancel`, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      return reply.send(await scope.service.cancel(scope.route.adapter, scope.identity.userId, params(request).briefingId ?? ""));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put(`${base}/settings`, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      const body = parseBody(BriefingSettingsRequestSchema, jsonBody(request));
      const setting = await setDailyBriefing(scope.db, scope.route.adapter, scope.identity.userId, body);
      return reply.send({ daily_enabled: setting.enabled });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

const sealedDigest = async (db: Queryable, where: string, values: unknown[]) =>
  (await db.query<{ id: string; period_end_utc: string }>(
    `SELECT id, period_end_utc::text FROM information_digests WHERE ${where}`, values,
  )).rows[0] ?? null;

/** Project briefings (Project read to read; Project write to generate) and the reader's own personal briefing. */
export function registerBriefingRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerScopeRoutes(app, context, PROJECT_BASE, async (db, request, identity) => {
    const projectId = params(request).projectId ?? "";
    await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
    return {
      adapter: projectBriefingScope(identity.spaceId, projectId),
      label: (tx) => projectBriefingLabel(tx, identity.spaceId, projectId),
      sealedDay: (tx, date) => sealedDigest(tx, `space_id = $1 AND project_id = $2 AND digest_date = $3 AND digest_type = 'project'`, [identity.spaceId, projectId, date]),
    };
  });
  // Always the caller's own: no route reads another person's personal briefing.
  registerScopeRoutes(app, context, PERSONAL_BASE, async (_db, _request, identity) => ({
    adapter: personalBriefingScope(identity.spaceId, identity.userId),
    label: async () => PERSONAL_BRIEFING_LABEL,
    sealedDay: (tx, date) => sealedDigest(tx, `space_id = $1 AND owner_user_id = $2 AND digest_date = $3 AND digest_type = 'personal'`, [identity.spaceId, identity.userId, date]),
  }));
}
