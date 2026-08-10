import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { InterestProfileService } from "../interestProfile/service";
import { domainDefinitions, isKnownDomain, PgSourceAnnotationRepository, SOURCE_ANNOTATION_JOB_TYPE } from "../sourceAnnotation";
import type { InterestProfileSettings } from "../interestProfile/settings";
import { PgJobQueueRepository } from "../jobs/repository";
import { assertProjectReadable } from "../projects/access";
import {
  dbPool,
  HttpError,
  jsonBody,
  numberValue,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common";
import { assertDate, InformationDigestService } from "./service";
import { SerendipityFeedbackService, type SerendipityFeedback } from "./feedbackService";
import { INTEREST_STARTER_PACKS, InterestStarterPackService } from "./starterPacks";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/spaces/:spaceId/information-digests/personal", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const date = digestDate(optionalString(query(request).date) ?? undefined);
      return reply.send(await new InformationDigestService(dbPool(context.config)).personal(spaceId, identity.userId, date));
    } catch (error) {
      return sendDigestError(reply, error);
    }
  });

  app.get("/api/v1/spaces/:spaceId/projects/:projectId/information-digests", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const projectId = params(request).projectId ?? "";
      const db = dbPool(context.config);
      await assertProjectReadable(db, spaceId, projectId, identity.userId);
      const date = digestDate(optionalString(query(request).date) ?? undefined);
      return reply.send(await new InformationDigestService(db).project(spaceId, projectId, identity.userId, date));
    } catch (error) {
      return sendDigestError(reply, error);
    }
  });

  app.post("/api/v1/spaces/:spaceId/information-digests/items/:itemId/serendipity-feedback", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const feedback = optionalString(jsonBody(request).feedback);
      if (!feedback || !(["interesting", "neutral", "never"] as string[]).includes(feedback)) {
        throw new HttpError(422, "feedback must be interesting, neutral, or never");
      }
      return reply.send(await new SerendipityFeedbackService(dbPool(context.config)).record(
        spaceId, identity.userId, params(request).itemId ?? "", feedback as SerendipityFeedback,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

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

  app.post("/api/v1/spaces/:spaceId/interest-profile/candidates/:phraseKey/accept", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const body = jsonBody(request);
      return reply.send(await new InterestProfileService(dbPool(context.config)).acceptCandidate(
        spaceId,
        identity.userId,
        params(request).phraseKey ?? "",
        { label: optionalString(body.label) ?? undefined, domainKey: optionalString(body.domain_key) ?? undefined },
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/spaces/:spaceId/interest-profile/candidates/:phraseKey/dismiss", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const dismissed = await new InterestProfileService(dbPool(context.config)).dismissCandidate(
        spaceId, identity.userId, params(request).phraseKey ?? "",
      );
      if (!dismissed) throw new HttpError(404, "Topic candidate not found");
      return reply.send({ dismissed: true });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/spaces/:spaceId/interest-profile/settings", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      return reply.send({ settings: await new InterestProfileService(dbPool(context.config)).updateSettings(
        spaceId, identity.userId, settingsPatch(jsonBody(request)),
      ) });
    } catch (error) {
      return sendRouteError(reply, profileInputError(error));
    }
  });

  app.post("/api/v1/spaces/:spaceId/interest-profile/topics", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const input = topicInput(jsonBody(request));
      return reply.code(201).send(await new InterestProfileService(dbPool(context.config)).createTopic(spaceId, identity.userId, input));
    } catch (error) {
      return sendRouteError(reply, profileInputError(error));
    }
  });

  app.patch("/api/v1/spaces/:spaceId/interest-profile/topics/:topicKey", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const topic = await new InterestProfileService(dbPool(context.config)).updateTopic(
        spaceId, identity.userId, params(request).topicKey ?? "", topicInput(jsonBody(request), true),
      );
      if (!topic) throw new HttpError(404, "Interest topic not found");
      return reply.send(topic);
    } catch (error) {
      return sendRouteError(reply, profileInputError(error));
    }
  });

  app.post("/api/v1/spaces/:spaceId/interest-profile/topics/:topicKey/archive", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    const archived = await new InterestProfileService(dbPool(context.config)).archiveTopic(
      spaceId, identity.userId, params(request).topicKey ?? "",
    );
    if (!archived) return reply.code(404).send({ detail: "Interest topic not found" });
    return reply.send({ archived: true });
  });

  app.post("/api/v1/spaces/:spaceId/interest-profile/starter-pack", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    try {
      const key = optionalString(jsonBody(request).key);
      if (!key) throw new HttpError(422, "key is required");
      return reply.send(await new InterestStarterPackService(dbPool(context.config)).apply(spaceId, identity.userId, key));
    } catch (error) {
      return sendRouteError(reply, profileInputError(error));
    }
  });

  app.post("/api/v1/spaces/:spaceId/interest-profile/history-backfill", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    const spaceId = params(request).spaceId ?? identity.spaceId;
    if (spaceId !== identity.spaceId) return reply.code(403).send({ detail: "Access denied" });
    const requested = numberValue(jsonBody(request).limit) ?? 500;
    if (!Number.isInteger(requested) || requested < 1 || requested > 500) {
      return reply.code(422).send({ detail: "limit must be an integer between 1 and 500" });
    }
    const db = dbPool(context.config);
    const queued = await new PgSourceAnnotationRepository(db).enqueueSubscriptionHistory(spaceId, identity.userId, requested);
    if (queued > 0) {
      await new PgJobQueueRepository(db).enqueue({
        job_type: SOURCE_ANNOTATION_JOB_TYPE,
        payload: { origin: "interest_profile_history_backfill", queued_item_count: queued },
        space_id: spaceId,
        user_id: identity.userId,
      });
    }
    return reply.send({ queued, limit: requested });
  });
}

const SETTING_KEYS: readonly (keyof InterestProfileSettings)[] = [
  "coverage_half_life_days", "new_topic_occurrence_threshold", "new_topic_read_threshold",
  "warming_min_read_items", "warm_min_read_items", "warm_min_covered_domains",
  "interest_slots", "serendipity_slots", "interesting_cooldown_days",
  "neutral_cooldown_days", "probe_domain_budget",
];

function settingsPatch(body: Record<string, unknown>): Partial<InterestProfileSettings> {
  const patch: Partial<InterestProfileSettings> = {};
  for (const key of SETTING_KEYS) {
    if (!(key in body)) continue;
    const value = numberValue(body[key]);
    if (value === null || !Number.isInteger(value)) throw new HttpError(422, `${key} must be an integer`);
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) throw new HttpError(422, "At least one profile setting is required");
  return patch;
}

function topicInput(body: Record<string, unknown>, requireWeight = false): { label: string; domainKey: string; weight: number } {
  const label = optionalString(body.label);
  const domainKey = optionalString(body.domain_key);
  const weight = numberValue(body.weight);
  if (!label) throw new HttpError(422, "label is required");
  if (!domainKey || !isKnownDomain(domainKey)) throw new HttpError(422, "domain_key must name a registered domain");
  if ((requireWeight && weight === null) || (weight !== null && (weight < 0 || weight > 10))) {
    throw new HttpError(422, "weight must be between 0 and 10");
  }
  return { label, domainKey, weight: weight ?? 1 };
}

function profileInputError(error: unknown): unknown {
  return error instanceof HttpError ? error : new HttpError(422, error instanceof Error ? error.message : "Invalid interest profile input");
}

function digestDate(value?: string): string {
  const next = value ?? new Date().toISOString().slice(0, 10);
  try {
    assertDate(next);
  } catch {
    throw new HttpError(422, "date must be a valid YYYY-MM-DD calendar date");
  }
  return next;
}

function sendDigestError(reply: Parameters<typeof sendRouteError>[0], error: unknown) {
  if (error instanceof Error && error.message.startsWith("Invalid digest date")) {
    return sendRouteError(reply, new HttpError(422, error.message));
  }
  return sendRouteError(reply, error);
}
