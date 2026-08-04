import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  dbPool,
  HttpError,
  jsonBody,
  objectValue,
  optionalString,
  params,
  parsePage,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common";
import { PgRunRepository } from "../runs/repository";
import { RunOrchestrationService } from "../runs/orchestrationService";
import { RunMaterializationService } from "../runs/materializationService";
import { PgVerificationEngine } from "../runs/verification";
import { resolveRequestId } from "../../gateway/requestContext";
import { EvolutionRepository } from "./repository";
import { registerEvolvableAssetRoutes } from "./assetRoutes";
import { RunWorkflowService, type SaveRunAsWorkflowInput } from "./runWorkflowService";
import { registerEvolutionBundleRoutes } from "./bundleRoutes";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new EvolutionRepository(dbPool(context.config));
  registerEvolvableAssetRoutes(app, context);
  registerEvolutionBundleRoutes(app, context);

  app.post("/api/v1/evolution/workflows/from-run/preview", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await new RunWorkflowService(dbPool(context.config)).preview(identity, jsonBody(request) as unknown as SaveRunAsWorkflowInput));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/evolution/workflows/from-run/save", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await new RunWorkflowService(dbPool(context.config)).save(identity, jsonBody(request) as unknown as SaveRunAsWorkflowInput));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/summary", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().summary(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/targets", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listTargets(identity, optionalString(query(request).status)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/evolution/targets", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository().createTarget(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/targets/:targetId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const target = await repository().getTarget(identity, params(request).targetId ?? "");
      if (!target) return reply.code(404).send({ detail: "Evolution target not found" });
      return reply.send(target);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/evolution/targets/:targetId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().updateTarget(identity, params(request).targetId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/signals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listSignals(identity, null, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/targets/:targetId/signals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listSignals(identity, params(request).targetId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/evolution/signals/:signalId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().updateSignalTriage(
        identity,
        params(request).signalId ?? "",
        jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/evolution/signals/:signalId/dismiss", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().dismissSignal(
        identity,
        params(request).signalId ?? "",
        jsonBody(request),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/evolution/targets/:targetId/signals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository().createSignal(identity, params(request).targetId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/strategies", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q, 100);
      return reply.send(await repository().listStrategies(identity, {
        status: optionalString(q.status),
        targetType: optionalString(q.target_type),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/selector-decisions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listSelectorDecisions(identity, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/experiences", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listExperiences(identity, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listRuns(identity, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/evolution/targets/:targetId/run", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const targetId = params(request).targetId ?? "";
      const body = jsonBody(request);
      const repo = repository();

      const target = await repo.getTargetRow(identity, targetId);
      if (!target) return reply.code(404).send({ detail: "Evolution target not found" });

      const bodyAgentId = optionalString(body.agent_id);
      const targetAgentId = optionalString(objectValue(target.metadata_json).agent_id);
      const agentId = bodyAgentId ?? targetAgentId;
      if (!agentId) {
        throw new HttpError(
          422,
          "agent_id is required in the request or target metadata",
        );
      }

      const setup = await repo.recordRunSetup(identity, targetId, agentId, body);

      const runRepo = PgRunRepository.fromConfig(context.config);
      const orch = new RunOrchestrationService(context.config, runRepo, {
        materializer: RunMaterializationService.fromConfig(context.config),
        verificationEngine: PgVerificationEngine.fromConfig(context.config),
      });
      await orch.executeRun({
        run_id: setup.runId,
        space_id: identity.spaceId,
        worker_id: `evolution:${resolveRequestId(request)}`,
        command_source: "http",
      });

      const finalRun = await runRepo.getRun(identity.spaceId, setup.runId);

      return reply.send({
        run_id: setup.runId,
        target_id: setup.targetId,
        selector_decision_id: setup.selectorDecisionId,
        selected_strategy_key: setup.selectedStrategyKey,
        run_status: finalRun?.status ?? "queued",
        proposal_ids: [],
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await repository().listProposals(identity, limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/evolution/validation", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().listValidationResults(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
