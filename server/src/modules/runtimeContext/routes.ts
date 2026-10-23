import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  jsonBody,
  params,
  requiredString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { WorkContextService } from "./workContextService.js";
import { createProductionRuntimeContextPlanningService } from "./productionAcquisition.js";
import { RuntimeContextContinuityService } from "./continuity/service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const workContexts = () => new WorkContextService(dbPool(context.config));

  app.get("/api/v1/runtime-context/work-contexts/:scopeId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const active = await workContexts().getActive(
        identity,
        requiredString(params(request).scopeId, "scope_id"),
      );
      if (!active) return reply.send(null);
      return reply.send(protocol.WorkContextSetupSchema.parse(active));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/runtime-context/work-contexts/:scopeId/retrieval", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const state = await workContexts().getRetrievalSwitch(identity, requiredString(params(request).scopeId, "scope_id"));
      return reply.send(protocol.WorkRetrievalSwitchSchema.parse(state));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/runtime-context/work-contexts/:scopeId/retrieval", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const state = await workContexts().setRetrievalSwitch(
        identity,
        requiredString(params(request).scopeId, "scope_id"),
        jsonBody(request),
      );
      return reply.send(protocol.WorkRetrievalSwitchSchema.parse(state));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // A Room recipient's knowledge retrieval switch belongs to one Conversation:
  // the client names the Conversation and the recipient, not the scope.
  app.get("/api/v1/runtime-context/room-conversations/:sessionId/recipients/:memberId/retrieval", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      // Read-only: the recipient's scope is created by the PUT below or by
      // the first Run that resolves it, never by looking at the switch.
      return reply.send(protocol.WorkRetrievalSwitchSchema.parse(await workContexts().getRoomConversationRetrievalSwitch(
        identity,
        requiredString(params(request).sessionId, "session_id"),
        requiredString(params(request).memberId, "member_id"),
      )));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/runtime-context/room-conversations/:sessionId/recipients/:memberId/retrieval", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const service = workContexts();
      const scopeId = await service.roomConversationScopeId(
        identity,
        requiredString(params(request).sessionId, "session_id"),
        requiredString(params(request).memberId, "member_id"),
      );
      return reply.send(protocol.WorkRetrievalSwitchSchema.parse(
        await service.setRetrievalSwitch(identity, scopeId, jsonBody(request)),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/runtime-context/work-contexts", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const created = await workContexts().create(identity, jsonBody(request));
      return reply.code(201).send(protocol.WorkContextSetupSchema.parse(created));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/runtime-context/preview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const parsed = protocol.TurnContextRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) return reply.code(422).send({ detail: "Invalid Turn Context Request" });
      const envelope = await createProductionRuntimeContextPlanningService(dbPool(context.config), context.config).preview({
        identity,
        turn: parsed.data,
      });
      return reply.send(protocol.RuntimeContextEnvelopeSchema.parse(envelope));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/runtime-context/work-contexts/:scopeId/checkpoint-corrections", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const scopeId = requiredString(params(request).scopeId, "scope_id");
      const active = await workContexts().getActive(identity, scopeId);
      if (!active) return reply.code(404).send({ detail: "Work Context is not readable" });
      const parsed = protocol.SemanticCheckpointCorrectionRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) return reply.code(422).send({ detail: "Invalid checkpoint correction" });
      const correctionId = await new RuntimeContextContinuityService(dbPool(context.config))
        .correctSemanticCheckpoint({
          spaceId: identity.spaceId,
          workContextScopeId: scopeId,
          checkpointId: parsed.data.checkpoint_id,
          identity,
          canonicalRef: parsed.data.canonical_ref,
          correction: parsed.data.correction as Record<string, unknown>,
        });
      return reply.code(201).send({ id: correctionId });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
