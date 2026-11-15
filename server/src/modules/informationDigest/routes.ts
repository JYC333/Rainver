import { registerOperationAdapters } from '../systemActions/operations/routeAdapter.js';
import { ReadingService } from "./readingService.js";
import { ReadingPreferences } from "./readingPreferences.js";
import type { FastifyInstance } from "fastify";
import { ReadingQuerySchema } from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { InterestProfileService } from "../interestProfile/service.js";
import {
  domainDefinitions,
  PgSourceAnnotationRepository,
} from "../sourceAnnotation/index.js";
import { assertProjectReadable } from "../projects/access.js";
import {
  dbPool,
  HttpError,
  optionalString,
  params,
  parseBody,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { assertDate, InformationDigestBackfillError, InformationDigestService } from "./service.js";
import { INTEREST_STARTER_PACKS } from "./starterPacks.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  for (const path of ["/api/v1/spaces/:spaceId/reading", "/api/v1/spaces/:spaceId/projects/:projectId/reading"]) {
    app.get(path, async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      if (params(request).spaceId !== identity.spaceId) return reply.code(404).send({ detail: "Space not found" });
      try {
        return reply.send(await new ReadingService(dbPool(context.config)).list(
          identity, parseBody(ReadingQuerySchema, query(request)), params(request).projectId,
        ));
      } catch (error) { return sendRouteError(reply, error); }
    });
  }
  registerOperationAdapters(app, context.config, [
    {method:'PATCH',url:'/api/v1/spaces/:spaceId/reading/items/:itemId/state',operation:'reading.personal_state.set',spaceParam:'spaceId',params:{itemId:'item_id'}},
    {method:'PATCH',url:'/api/v1/spaces/:spaceId/projects/:projectId/reading/items/:itemId/state',operation:'reading.project_state.set',spaceParam:'spaceId',params:{projectId:'project_id',itemId:'item_id'}},
  ]);
  const preferencePath = "/api/v1/spaces/:spaceId/projects/:projectId/reading-preference";
  app.get(preferencePath, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (params(request).spaceId !== identity.spaceId) return reply.code(404).send({ detail: "Space not found" });
    try {
      return reply.send(await new ReadingPreferences(dbPool(context.config)).get(identity, params(request).projectId ?? ""));
    } catch (error) { return sendRouteError(reply, error); }
  });
  registerOperationAdapters(app, context.config, [{
    method: 'PUT', url: preferencePath, operation: 'reading.preference.set',
    spaceParam: 'spaceId', params: { projectId: 'project_id' },
  }]);
  // History reads are read-only: a day with no snapshot answers `missing`,
  // and nothing is generated, written or taken from the standby pool by
  // looking. Generation is the scheduled fire's, or an explicit backfill's.
  app.get("/api/v1/spaces/:spaceId/information-digests/personal", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const date = requestedDigestDate(optionalString(query(request).date));
      return reply.send(await new InformationDigestService(dbPool(context.config)).lookup(
        spaceId, { type: "personal", userId: identity.userId }, date,
      ));
    } catch (error) {
      return sendDigestError(reply, error);
    }
  });

  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/spaces/:spaceId/information-digests/personal/backfill',operation:'digest.personal.backfill',spaceParam:'spaceId'}]);

  app.get("/api/v1/spaces/:spaceId/projects/:projectId/information-digests", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const projectId = params(request).projectId ?? "";
      const db = dbPool(context.config);
      await assertProjectReadable(db, spaceId, projectId, identity.userId);
      const date = requestedDigestDate(optionalString(query(request).date));
      return reply.send(await new InformationDigestService(db).lookup(
        spaceId, { type: "project", projectId, readerUserId: identity.userId }, date,
      ));
    } catch (error) {
      return sendDigestError(reply, error);
    }
  });

  // Building a shared snapshot is a write to the Project: writer authority.
  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/spaces/:spaceId/projects/:projectId/information-digests/backfill',operation:'digest.project.backfill',spaceParam:'spaceId',params:{projectId:'project_id'}}]);

  // The caller's own annotation failure episodes and their manual retry. A
  // member sees and reopens only the items they are responsible for: their
  // connections' items and their own saved URLs.
  app.get("/api/v1/spaces/:spaceId/source-annotation/episodes", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const episodes = await new PgSourceAnnotationRepository(dbPool(context.config)).episodeSummaries(spaceId, {
        responsibleUserId: identity.userId,
      });
      return reply.send({ episodes: episodes.map(({ responsible_user_id: _owner, ...episode }) => episode) });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/spaces/:spaceId/source-annotation/retry',operation:'reading.annotation.retry',spaceParam:'spaceId'}]);

  registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/spaces/:spaceId/information-digests/items/:itemId/serendipity-feedback',operation:'digest.serendipity.feedback',spaceParam:'spaceId',params:{itemId:'item_id'}}]);

  // Owner-private interest controls. They live with the personal delivery
  // surface so a profile is useful without exposing another member's model.
  app.get("/api/v1/spaces/:spaceId/interest-profile", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const service = new InterestProfileService(dbPool(context.config));
      await service.runFactLayer(spaceId, identity.userId);
      return reply.send({ ...(await service.snapshot(spaceId, identity.userId)), domains: domainDefinitions(), starter_packs: INTEREST_STARTER_PACKS });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  registerOperationAdapters(app,context.config,[
    {"method": "POST", "url": "/api/v1/spaces/:spaceId/interest-profile/candidates/:phraseKey/accept", "operation": "interest.candidate.accept", "spaceParam": "spaceId", "params": {"phraseKey": "phrase_key"}},
    {"method": "POST", "url": "/api/v1/spaces/:spaceId/interest-profile/candidates/:phraseKey/dismiss", "operation": "interest.candidate.dismiss", "spaceParam": "spaceId", "params": {"phraseKey": "phrase_key"}},
    {"method": "PATCH", "url": "/api/v1/spaces/:spaceId/interest-profile/settings", "operation": "interest.settings.update", "spaceParam": "spaceId", "params": {}},
    {"method": "POST", "url": "/api/v1/spaces/:spaceId/interest-profile/topics", "operation": "interest.topic.create", "spaceParam": "spaceId", "params": {}},
    {"method": "PATCH", "url": "/api/v1/spaces/:spaceId/interest-profile/topics/:topicKey", "operation": "interest.topic.update", "spaceParam": "spaceId", "params": {"topicKey": "topic_key"}},
    {"method": "POST", "url": "/api/v1/spaces/:spaceId/interest-profile/topics/:topicKey/archive", "operation": "interest.topic.archive", "spaceParam": "spaceId", "params": {"topicKey": "topic_key"}},
  ]);

  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/spaces/:spaceId/interest-profile/starter-pack',operation:'interest.starter_pack.apply',spaceParam:'spaceId'},
    {method:'POST',url:'/api/v1/spaces/:spaceId/interest-profile/history-backfill',operation:'interest.history.backfill',spaceParam:'spaceId'},
  ]);
}

/** A named day, or null for the latest complete day of the digest's timezone. */
function requestedDigestDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return requiredDigestDate(value);
}

function requiredDigestDate(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(422, "date must be a valid YYYY-MM-DD calendar date");
  try {
    assertDate(value);
  } catch {
    throw new HttpError(422, "date must be a valid YYYY-MM-DD calendar date");
  }
  return value;
}

function sendDigestError(reply: Parameters<typeof sendRouteError>[0], error: unknown) {
  if (error instanceof Error && error.message.startsWith("Invalid digest date")) {
    return sendRouteError(reply, new HttpError(422, error.message));
  }
  if (error instanceof InformationDigestBackfillError) {
    return sendRouteError(reply, new HttpError(422, error.message, { detail: error.message, code: "digest_day_not_complete" }));
  }
  return sendRouteError(reply, error);
}
