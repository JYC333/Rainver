import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { jsonBody, params, resolveIdentity, sendRouteError, HttpError } from "../routeUtils/common.js";
import { CrossSpaceRetrievalService } from "./service.js";

type RouteService = Pick<CrossSpaceRetrievalService,
  "search" | "resolve" | "storeSingleSourceSummary" | "discloseEgress" |
  "storeFusedConclusion" | "updateEgressNotificationSetting" | "listNotifications">;
type ServiceFactory = (context: ModuleContext) => RouteService;
let serviceFactoryOverride: ServiceFactory | null = null;

export function __setCrossSpaceRetrievalServiceFactoryForTests(factory: ServiceFactory | null): void {
  serviceFactoryOverride = factory;
}

function service(context: ModuleContext): RouteService {
  return serviceFactoryOverride?.(context) ?? CrossSpaceRetrievalService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/api/v1/me/retrieval/search", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parse(protocol.CrossSpaceRetrievalRequestSchema, jsonBody(request));
      const result = await service(context).search({
        userId: identity.userId,
        query: body.query,
        resourceTypes: body.resource_types,
        maxResults: body.max_results,
      });
      return reply.send(protocol.CrossSpaceRetrievalResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/me/retrieval/pointers/resolve", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parse(protocol.CrossSpaceResolveRequestSchema, jsonBody(request));
      return reply.send(protocol.CrossSpaceResolveResponseSchema.parse(
        await service(context).resolve(identity.userId, body.pointer_ids),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/me/retrieval/summaries", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parse(protocol.CrossSpaceSummaryStoreRequestSchema, jsonBody(request));
      return reply.code(201).send(protocol.CrossSpaceSummaryStoreResponseSchema.parse(
        await service(context).storeSingleSourceSummary(identity.userId, body.pointer_ids, body.summary),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/me/retrieval/egress/disclose", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parse(protocol.CrossSpaceEgressDisclosureRequestSchema, jsonBody(request));
      return reply.send(protocol.CrossSpaceEgressDisclosureResponseSchema.parse(
        await service(context).discloseEgress(identity.userId, body.pointer_ids),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/me/retrieval/fused-conclusions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parse(protocol.CrossSpaceFusedConclusionStoreRequestSchema, jsonBody(request));
      return reply.code(201).send(protocol.CrossSpaceFusedConclusionStoreResponseSchema.parse(
        await service(context).storeFusedConclusion({
          userId: identity.userId,
          disclosureId: body.disclosure_id,
          pointerIds: body.pointer_ids,
          conclusion: body.conclusion,
        }),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/spaces/:spaceId/egress-notifications", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = parse(protocol.SpaceEgressNotificationSettingUpdateSchema, jsonBody(request));
      return reply.send(protocol.SpaceEgressNotificationSettingSchema.parse(
        await service(context).updateEgressNotificationSetting(
          identity.userId,
          params(request).spaceId ?? "",
          body.egress_notifications_enabled,
        ),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/me/notifications", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(protocol.SpaceMemberNotificationsResponseSchema.parse(
        await service(context).listNotifications(identity.userId),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, "Invalid request body");
  return parsed.data;
}
