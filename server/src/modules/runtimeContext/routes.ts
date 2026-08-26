import type { FastifyInstance } from "fastify";
import * as protocol from "@agent-space/protocol";
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
      if (!parsed.success) return reply.code(422).send({ error: "Invalid Turn Context Request" });
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
