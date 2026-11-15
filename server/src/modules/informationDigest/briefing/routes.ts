import { registerOperationAdapters } from '../../systemActions/operations/routeAdapter.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../../gateway/routeRegistry.js";
import { assertProjectReadable } from "../../projects/access.js";
import { dbPool, params, resolveIdentity, sendRouteError, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common.js";
import type { BriefingScopeAdapter } from "./contract.js";
import { personalBriefingScope } from "./personalScope.js";
import { projectBriefingScope } from "./projectScope.js";
import { readDailyBriefingSetting } from "./schedule.js";
import { InformationBriefingService } from "./service.js";

const PROJECT_BASE = "/api/v1/spaces/:spaceId/projects/:projectId/information-briefings";
const PERSONAL_BASE = "/api/v1/spaces/:spaceId/information-briefings/personal";

/** The personal briefing's label: whose and from what, never another person's name. */
export const PERSONAL_BRIEFING_LABEL = "this reader's personal Reading (their Following, subscribed Sources and the Projects they opted into Reading)";

/** What a briefing route needs to know about its scope; the handlers are the same for every scope. */
interface ScopeRoute {
  adapter: BriefingScopeAdapter;
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


  app.get(base, async (request, reply) => {
    try {
      const scope = await scoped(request, reply);
      if (!scope) return reply;
      const daily = await readDailyBriefingSetting(scope.db, scope.route.adapter);
      const result=await scope.service.overview(scope.route.adapter, scope.identity.userId, daily.enabled);
      return reply.send({...result,can_generate:scope.route.adapter.scope.type==='project'?false:result.can_generate});
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

  registerOperationAdapters(app, context.config, [{method:'POST',url:base,spaceParam:'spaceId',operation:base===PROJECT_BASE?'briefing.project.request':'briefing.personal.request',...(base===PROJECT_BASE?{params:{projectId:'project_id'}}:{})}]);

  registerOperationAdapters(app, context.config, [{
    method:'POST',url:`${base}/:briefingId/cancel`,spaceParam:'spaceId',
    operation:base===PROJECT_BASE?'briefing.project.cancel':'briefing.personal.cancel',
    params:{briefingId:'briefing_id',...(base===PROJECT_BASE?{projectId:'project_id'}:{})},
  }]);

  const prefix=base===PROJECT_BASE?'briefing.project':'briefing.personal';
  const targets={briefingId:'briefing_id',index:'index',...(base===PROJECT_BASE?{projectId:'project_id'}:{})};
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:`${base}/:briefingId/highlights/:index/follow-up`,spaceParam:'spaceId',operation:`${prefix}.follow_up`,params:targets},
    {method:'POST',url:`${base}/:briefingId/highlights/:index/adoption/preview`,spaceParam:'spaceId',operation:`${prefix}.adoption.preview`,params:targets},
    {method:'POST',url:`${base}/:briefingId/highlights/:index/adoption`,spaceParam:'spaceId',operation:`${prefix}.adoption.confirm`,params:targets},
  ]);

  registerOperationAdapters(app, context.config, [{
    method:'PUT', url:`${base}/settings`, spaceParam:'spaceId',
    operation:base===PROJECT_BASE?'briefing.project.settings.set':'briefing.personal.settings.set',
    ...(base===PROJECT_BASE?{params:{projectId:'project_id'}}:{}),
  }]);
}

/** Historical Project reads and the reader's own personal generation. */
export function registerBriefingRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerScopeRoutes(app, context, PROJECT_BASE, async (db, request, identity) => {
    const projectId = params(request).projectId ?? "";
    await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
    return {
      adapter: projectBriefingScope(identity.spaceId, projectId),
    };
  });
  // Always the caller's own: no route reads another person's personal briefing.
  registerScopeRoutes(app, context, PERSONAL_BASE, async (_db, _request, identity) => ({
    adapter: personalBriefingScope(identity.spaceId, identity.userId),
  }));
}
