import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { HttpError, dbPool, jsonBody, optionalString, params, query, resolveIdentity, sendRouteError } from "../routeUtils/common";
import { ProjectResearchRepository } from "./repository";
import { ProjectResearchPipelineService } from "./pipeline/researchPipelineService";
import { enforceSources } from "../sources/enforceSources";
import { ProjectResearchReportRepository } from "./reportRepository";
import { ProjectResearchQuestionRefineService } from "./questionRefineService";
import { registerProjectResearchAreaRoutes } from "./areaRoutes";

let repositoryFactoryOverride: ((context: ModuleContext) => ProjectResearchRepository) | null = null;
let orchestratorFactoryOverride: ((context: ModuleContext) => ProjectResearchPipelineService) | null = null;

export function __setProjectResearchRepositoryFactoryForTests(
  factory: ((context: ModuleContext) => ProjectResearchRepository) | null,
): void {
  repositoryFactoryOverride = factory;
}

export function __setProjectResearchOrchestratorFactoryForTests(
  factory: ((context: ModuleContext) => ProjectResearchPipelineService) | null,
): void {
  orchestratorFactoryOverride = factory;
}

function repository(context: ModuleContext): ProjectResearchRepository {
  if (repositoryFactoryOverride) return repositoryFactoryOverride(context);
  return new ProjectResearchRepository(dbPool(context.config));
}

function orchestrator(context: ModuleContext): ProjectResearchPipelineService {
  if (orchestratorFactoryOverride) return orchestratorFactoryOverride(context);
  return new ProjectResearchPipelineService(dbPool(context.config), context.config);
}

function requireParam(request: Parameters<typeof params>[0], name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const base = "/api/v1/projects/:projectId/research";
  const reports = () => new ProjectResearchReportRepository(dbPool(context.config));
  registerProjectResearchAreaRoutes(app, context, base);

  app.post(`${base}/question/refine`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await new ProjectResearchQuestionRefineService(dbPool(context.config), context.config)
        .refine(identity, requireParam(request, "projectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/initial-intake/start`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const sourceGate = await enforceSources(context, identity, "source.connection.manage", "source_channel");
      if (sourceGate.blocked) return reply.code(403).send(sourceGate.reply403);
      const bindingGate = await enforceSources(context, identity, "project.source.bind", "project_source");
      if (bindingGate.blocked) return reply.code(403).send(bindingGate.reply403);
      const backfillGate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan");
      if (backfillGate.blocked) return reply.code(403).send(backfillGate.reply403);
      return reply.code(201).send(await orchestrator(context).startInitialIntake(identity, requireParam(request, "projectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put(`${base}/initial-intake`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await orchestrator(context).saveInitialIntakeDraft(identity, requireParam(request, "projectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put(`${base}/item-limit`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await orchestrator(context).updateInitialItemLimit(
          identity,
          requireParam(request, "projectId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/question/apply-forward`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const sourceGate = await enforceSources(context, identity, "source.connection.manage", "source_channel");
      if (sourceGate.blocked) return reply.code(403).send(sourceGate.reply403);
      const workflowId = optionalString(jsonBody(request).workflow_id);
      if (!workflowId) throw new HttpError(422, "workflow_id is required");
      return reply.send(await orchestrator(context).applyQuestionForward(identity, requireParam(request, "projectId"), workflowId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/question/impact`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const workflowId = optionalString(query(request).workflow_id);
      if (!workflowId) throw new HttpError(422, "workflow_id is required");
      return reply.send(await orchestrator(context).questionChangeImpact(identity, requireParam(request, "projectId"), workflowId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/question/resolve`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const sourceGate = await enforceSources(context, identity, "source.connection.manage", "source_channel");
      if (sourceGate.blocked) return reply.code(403).send(sourceGate.reply403);
      const strategy = optionalString(jsonBody(request).strategy);
      const workflowId = optionalString(jsonBody(request).workflow_id);
      if (!workflowId) throw new HttpError(422, "workflow_id is required");
      if (strategy !== "rescreen" && strategy !== "synthesis_only" && strategy !== "apply_forward") {
        throw new HttpError(422, "strategy must be rescreen, synthesis_only, or apply_forward");
      }
      return reply.send(await orchestrator(context).resolveQuestionChange(identity, requireParam(request, "projectId"), workflowId, strategy));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/reports`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(202).send(await orchestrator(context).generateReportSnapshot(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/profile`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const profile = await repository(context).getProfile(identity, requireParam(request, "projectId"));
      if (!profile) throw new HttpError(404, "Research profile not found");
      return reply.send(profile);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put(`${base}/profile`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).upsertProfile(identity, requireParam(request, "projectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/profile/approve`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).approveProfile(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/workflow`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).listWorkflows(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/scan-summaries`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const rawLimit = Number(query(request).limit ?? 30);
      return reply.send(await repository(context).listScanSummaries(
        identity,
        requireParam(request, "projectId"),
        Number.isFinite(rawLimit) ? rawLimit : 30,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/workflow/start`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository(context).startWorkflow(identity, requireParam(request, "projectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/workflow/:workflowId/trigger`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.connection.manage", "source_channel");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(202).send(
        await orchestrator(context).triggerIncremental(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "workflowId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/workflow/:workflowId/history-backfill`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.backfill.plan", "source_backfill_plan");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(202).send(
        await orchestrator(context).startHistoricalBackfill(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "workflowId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/operations/:operationId/retry`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(202).send(
        await orchestrator(context).retryFailedOperation(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "operationId"),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/operations/:operationId/reconcile`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await orchestrator(context).reconcileOperationForUser(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "operationId"),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put(`${base}/operations/:operationId/item-limit`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.backfill.manage", "source_backfill_plan");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(
        await orchestrator(context).updateItemLimit(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "operationId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/operations/:operationId/rescan`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.backfill.manage", "source_backfill_plan");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(202).send(
        await orchestrator(context).rescanEmptyBackfill(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "operationId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/workflow/:workflowId/stages/:stageKey/run`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).runStage(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "workflowId"),
          requireParam(request, "stageKey"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/workflow/:workflowId/checkpoints`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).listCheckpoints(identity, requireParam(request, "projectId"), requireParam(request, "workflowId")),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/workflow/:workflowId/checkpoints/:checkpointId/decide`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await orchestrator(context).decideCheckpoint(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "workflowId"),
          requireParam(request, "checkpointId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/reports`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await reports().list(identity, requireParam(request, "projectId"))); }
    catch (error) { return sendRouteError(reply, error); }
  });
  app.get(`${base}/reports/:reportId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply); if (!identity) return reply;
    try { return reply.send(await reports().get(identity, requireParam(request, "projectId"), requireParam(request, "reportId"))); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.get(`${base}/claims`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(
        await repository(context).listClaimLinks(identity, requireParam(request, "projectId"), optionalString(q.workflow_id)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/claims`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository(context).createClaimLink(identity, requireParam(request, "projectId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch(`${base}/claims/:claimLinkId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).updateClaimLink(
          identity,
          requireParam(request, "projectId"),
          requireParam(request, "claimLinkId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/screening-criteria`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).getScreeningCriteria(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put(`${base}/screening-criteria`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).upsertScreeningCriteria(identity, requireParam(request, "projectId"), jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/literature-matrix`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).getLiteratureMatrix(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/literature-matrix/rebuild`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).rebuildLiteratureMatrix(identity, requireParam(request, "projectId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/reports/:reportId/integrity`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository(context).runReportIntegrity(identity, requireParam(request, "projectId"), requireParam(request, "reportId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

}
