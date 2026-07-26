import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { dbPool, jsonBody, params, requiredString, resolveIdentity, sendRouteError } from "../routeUtils/common";
import { ExperimentDefinitionService } from "./definitionService";
import { ExperimentRunService } from "./runService";
import { ExperimentInterpretationService } from "./interpretationService";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const definitions = () => new ExperimentDefinitionService(dbPool(context.config));
  const runs = () => new ExperimentRunService(dbPool(context.config));
  const interpretations = () => new ExperimentInterpretationService(dbPool(context.config));

  app.get("/api/v1/projects/:projectId/experiments/definitions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await definitions().listDefinitions(identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/definitions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.code(201).send(await definitions().createDefinition(identity, projectId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/experiments/definitions/:definitionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await definitions().getDefinition(identity, requiredString(p.projectId, "project_id"), requiredString(p.definitionId, "definition_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/projects/:projectId/experiments/definitions/:definitionId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await definitions().updateDefinition(
        identity, requiredString(p.projectId, "project_id"), requiredString(p.definitionId, "definition_id"), jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await definitions().listVersions(identity, requiredString(p.projectId, "project_id"), requiredString(p.definitionId, "definition_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await definitions().createVersion(
        identity, requiredString(p.projectId, "project_id"), requiredString(p.definitionId, "definition_id"), jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions/:versionId/approve", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await definitions().approveVersion(
        identity,
        requiredString(p.projectId, "project_id"),
        requiredString(p.definitionId, "definition_id"),
        requiredString(p.versionId, "version_id"),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/experiments/definitions/:definitionId/runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const versionId = typeof (request.query as Record<string, unknown>)?.version_id === "string" ? (request.query as Record<string, string>).version_id : undefined;
      return reply.send(await runs().listRuns(identity, requiredString(p.projectId, "project_id"), requiredString(p.definitionId, "definition_id"), versionId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions/:versionId/runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await runs().createRun(
        identity,
        requiredString(p.projectId, "project_id"),
        requiredString(p.definitionId, "definition_id"),
        requiredString(p.versionId, "version_id"),
        jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/definitions/:definitionId/versions/:versionId/runs/launch", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(202).send(await runs().launchManagedRun(
        identity,
        requiredString(p.projectId, "project_id"),
        requiredString(p.definitionId, "definition_id"),
        requiredString(p.versionId, "version_id"),
        jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/definitions/:definitionId/runs/:runId/complete", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await runs().completeRun(
        identity,
        requiredString(p.projectId, "project_id"),
        requiredString(p.definitionId, "definition_id"),
        requiredString(p.runId, "run_id"),
        jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/definitions/:definitionId/runs/:runId/observations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await runs().recordObservation(
        identity,
        requiredString(p.projectId, "project_id"),
        requiredString(p.definitionId, "definition_id"),
        requiredString(p.runId, "run_id"),
        jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/experiments/definitions/:definitionId/runs/:runId/observations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await runs().listObservations(
        identity,
        requiredString(p.projectId, "project_id"),
        requiredString(p.definitionId, "definition_id"),
        requiredString(p.runId, "run_id"),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/experiments/definitions/:definitionId/interpretations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await interpretations().listInterpretations(identity, requiredString(p.projectId, "project_id"), requiredString(p.definitionId, "definition_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/definitions/:definitionId/interpretations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await interpretations().createInterpretation(
        identity, requiredString(p.projectId, "project_id"), requiredString(p.definitionId, "definition_id"), jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/interpretations/:interpretationId/review", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.send(await interpretations().markReviewed(identity, requiredString(p.projectId, "project_id"), requiredString(p.interpretationId, "interpretation_id")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/experiments/interpretations/:interpretationId/convert-to-signal", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      return reply.code(201).send(await interpretations().convertToSignal(
        identity, requiredString(p.projectId, "project_id"), requiredString(p.interpretationId, "interpretation_id"), jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
