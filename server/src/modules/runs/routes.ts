import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope";
import { checkInternalToken } from "../../gateway/internalAuth";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext";
import { introspectIdentity } from "../auth/identity";
import { PgActivityRepository } from "../activity/repository";
import { PgArtifactRepository } from "../artifacts/repository";
import { PgProposalRepository } from "../proposals/repository";
import { dbPool, page, sendRouteError } from "../routeUtils/common";
import { PgRunRepository, type RunRecord } from "./repository";
import { RunOrchestrationService } from "./orchestrationService";
import { enqueueAgentRunJob } from "./agentRunHandler";
import { RunMaterializationService } from "./materializationService";
import { sharedCliProcessRegistry } from "./processRegistry";
import { ContextPrepareService } from "../context";
import { PgCodePatchCollector, PgWorkspaceManager } from "../workspaces";
import { EvolutionRepository } from "../evolution/repository";
import { EvolutionSolidifier } from "../evolution/solidifier";
import { EvolutionSignalEmitter } from "../evolution/signalEmitters";
import { PgUsageRepository } from "../usage/repository";
import { PgVerificationEngine } from "./verification";
import { PlanExecutionService } from "../plans/executionService";
import { WorkflowExecutionService } from "../automations/workflowExecutionService";
import { PgRunSupervisor } from "./supervisor";
import {
  NonTerminalRunError,
  PostRunFinalizationService,
  RunNotFoundError,
} from "./finalizationService";
import {
  artifactSummaryToOut,
  contextSnapshotToOut,
  proposalSummaryToOut,
  runEvaluationToOut,
  runEventToOut,
  runFinalizationToOut,
  runLineageToOut,
  runStatusToOut,
  runStepToOut,
  runToOut,
  verificationResultToOut,
} from "./runReadModel";

interface RunsCommandServices {
  orchestration: Pick<RunOrchestrationService, "executeRun" | "cancelRun">;
  repository: Pick<PgRunRepository, "getVisibleRun">;
}

type RunsCommandServicesFactory = (context: ModuleContext) => RunsCommandServices;
type RunsIdentity = { spaceId: string; userId: string };
type RunsIdentityOverride =
  | RunsIdentity
  | ((request: FastifyRequest) => Promise<RunsIdentity | null> | RunsIdentity | null);
type RunsReadResponseOverride = (
  runId: string,
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply> | FastifyReply;

let servicesFactoryOverride: RunsCommandServicesFactory | null = null;
let identityOverride: RunsIdentityOverride | null = null;
let readResponseOverride: RunsReadResponseOverride | null = null;

export function __setRunsCommandServicesFactoryForTests(
  factory: RunsCommandServicesFactory | null,
): void {
  servicesFactoryOverride = factory;
}

export function __setRunsIdentityForTests(identity: RunsIdentityOverride | null): void {
  identityOverride = identity;
}

export function __setRunsReadResponseForTests(
  responder: RunsReadResponseOverride | null,
): void {
  readResponseOverride = responder;
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

function bodyText(request: FastifyRequest): string {
  return request.body instanceof Buffer ? request.body.toString("utf8") : "";
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const text = bodyText(request);
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ spaceId: string; userId: string } | null> {
  if (identityOverride) {
    return typeof identityOverride === "function"
      ? identityOverride(request)
      : identityOverride;
  }
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(context.config, request);
  if (identity.ok) return { spaceId: identity.spaceId, userId: identity.userId };
  if (identity.reason === "denied") {
    reply.code(identity.statusCode);
    reply.header("content-type", "application/json");
    reply.send(identity.body);
    return null;
  }
  await sendErrorEnvelope(
    reply,
    502,
    errorEnvelope(
      identity.reason === "contract_violation"
        ? "introspect_contract_violation"
        : "identity_unavailable",
      "Identity introspection failed",
      requestId,
    ),
  );
  return null;
}

function commandServices(context: ModuleContext): RunsCommandServices {
  if (servicesFactoryOverride) return servicesFactoryOverride(context);
  const repository = PgRunRepository.fromConfig(context.config);
  const materializer = RunMaterializationService.fromConfig(context.config);
  const contextPreparer = new ContextPrepareService(context.config);
  return {
    repository,
    orchestration: new RunOrchestrationService(context.config, repository, {
      materializer,
      contextPreparer,
      workspaceManager: PgWorkspaceManager.fromConfig(context.config),
      codePatchCollector: PgCodePatchCollector.fromConfig(context.config),
      verificationEngine: PgVerificationEngine.fromConfig(context.config),
      processRegistry: sharedCliProcessRegistry,
    }),
  };
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/api/v1/runs/:runId/execute", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const runId = params(request).runId ?? "";
    const runtime = query(request).runtime;
    if (runtime) {
      return reply.code(400).send({
        detail:
          "Runtime query overrides are not supported by the server runs authority; use the configured runtime adapter.",
      });
    }
    // The Run row and the policy-owned adapter resolution are authoritative.
    // Execution parameters (prompt, model, adapter config, sandbox, timeouts)
    // are never accepted from the request body.
    const services = commandServices(context);
    await services.orchestration.executeRun({
      run_id: runId,
      space_id: identity.spaceId,
      worker_id: `http:${resolveRequestId(request)}`,
      command_source: "http",
    });
    if (readResponseOverride) return readResponseOverride(runId, request, reply);
    const run = await services.repository.getVisibleRun(identity.spaceId, identity.userId, runId);
    if (!run) {
      return reply.code(404).send({ detail: "Run not found in this space" });
    }
    return reply.send(runToOut(run));
  });

  // Service-authenticated internal execute for synchronous server callers
  // (currently the agents chat turn). Same orchestration authority as the
  // public route; identity is the internal service token, and the caller
  // supplies the run/space ids it already validated.
  app.post("/internal/runs/execute", async (request, reply) => {
    if (!checkInternalToken(context.config, request)) {
      return reply.code(401).send({ detail: "Unauthorized" });
    }
    const body = jsonBody(request);
    const runId = stringValue(body.run_id);
    const spaceId = stringValue(body.space_id);
    if (!runId || !spaceId) {
      return reply.code(422).send({ detail: "run_id and space_id are required" });
    }
    const services = commandServices(context);
    const result = await services.orchestration.executeRun({
      run_id: runId,
      space_id: spaceId,
      worker_id: stringValue(body.worker_id) ?? "internal",
      command_source: "internal",
    });
    return reply.send(result);
  });

  app.patch("/api/v1/runs/:runId/stop", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const runId = params(request).runId ?? "";
    const body = jsonBody(request);
    const services = commandServices(context);
    const before = await services.repository.getVisibleRun(identity.spaceId, identity.userId, runId);
    if (!before) {
      return reply.code(404).send({ detail: "Run not found in this space." });
    }
    const result = await services.orchestration.cancelRun({
      run_id: runId,
      space_id: identity.spaceId,
      requested_by_user_id: identity.userId,
      reason: stringValue(body.reason),
    });
    const after = await services.repository.getVisibleRun(identity.spaceId, identity.userId, runId);
    const run = after ?? before;
    if (!run && result.status === "unknown") {
      return reply.code(404).send({ detail: "Run not found in this space." });
    }
    return reply.send(stopResponse(run, result.status, !result.skipped));
  });

  app.get("/api/v1/runs", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const q = query(request);
    const repository = PgRunRepository.fromConfig(context.config);
    try {
      const runs = await repository.listRuns({
        space_id: identity.spaceId,
        user_id: identity.userId,
        status: q.status ?? null,
        mode: q.mode ?? null,
        agent_id: q.agent_id ?? null,
        workspace_id: q.workspace_id ?? null,
        project_id: q.project_id ?? null,
        workflow_version_id: q.workflow_version_id ?? null,
        capability_id: q.capability_id ?? null,
        run_role: q.run_role === "coordinator" ? "coordinator" : q.run_role === "execution" ? "execution" : null,
        limit: boundedInt(q.limit, 50, 1, 200),
        offset: boundedInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      });
      return reply.send(
        await Promise.all(runs.map((run) => runToOutWithProvider(repository, run))),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/runs/:runId/status", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    return reply.send(runStatusToOut(result.run));
  });

  app.get("/api/v1/runs/:runId/activities", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const q = query(request);
    const limit = boundedInt(q.limit, 100, 1, 200);
    const offset = boundedInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const items = await new PgActivityRepository(dbPool(context.config)).list(
      { spaceId: result.run.space_id, userId: result.identity.userId },
      {
        sourceRunId: result.run.id,
        limit,
        offset,
      },
    );
    return reply.send(page(items, items.length, limit, offset));
  });

  app.get("/api/v1/runs/:runId/artifacts", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const q = query(request);
    const limit = boundedInt(q.limit, 100, 1, 200);
    const offset = boundedInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return reply.send(
      await PgArtifactRepository.fromConfig(context.config).listVisible(
        result.run.space_id,
        result.identity.userId,
        {
          runId: result.run.id,
          limit,
          offset,
        },
      ),
    );
  });

  app.get("/api/v1/runs/:runId/proposals", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const q = query(request);
    const status = q.status === "all" ? null : q.status ?? null;
    const limit = boundedInt(q.limit, 100, 1, 200);
    const offset = boundedInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return reply.send(
      await PgProposalRepository.fromConfig(context.config).listVisible(
        result.run.space_id,
        result.identity.userId,
        {
          status,
          createdByRunId: result.run.id,
          limit,
          offset,
        },
      ),
    );
  });

  app.get("/api/v1/runs/:runId/trace", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const { repository, run } = result;
    const [steps, events, artifacts, proposals, children, contextSnapshot, finalization] = await Promise.all([
      repository.listRunSteps(run.space_id, run.id),
      repository.listRunEvents(run.space_id, run.id),
      repository.listArtifactSummaries(run.space_id, run.id),
      repository.listProposalSummaries(run.space_id, run.id),
      repository.listChildRuns(run.space_id, run.id),
      repository.getContextSnapshot(run.space_id, run.context_snapshot_id),
      repository.getLatestRunFinalization(run.space_id, run.id),
    ]);
    return reply.send({
      run: await runToOutWithProvider(repository, run),
      agent: null,
      agent_version: null,
      model_provider: null,
      context_snapshot: contextSnapshotToOut(contextSnapshot),
      steps: steps.map(runStepToOut),
      events: events.map(runEventToOut),
      artifacts: artifacts.map(artifactSummaryToOut),
      proposals: proposals.map((proposal) => proposalSummaryToOut(proposal)),
      finalization: finalization ? runFinalizationToOut(finalization) : null,
      parent: null,
      children: children.map(runLineageToOut),
    });
  });

  app.get("/api/v1/runs/:runId/attempts", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const [attempts, supervisorDecisions] = await Promise.all([
      result.repository.listRunAttempts(result.run.space_id, result.run.id),
      result.repository.listRunSupervisorDecisions(result.run.space_id, result.run.id),
    ]);
    return reply.send({
      attempts,
      supervisor_decisions: supervisorDecisions,
    });
  });

  app.post("/api/v1/runs/:runId/finalize", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const runId = params(request).runId ?? "";
    const repository = PgRunRepository.fromConfig(context.config);
    try {
      const db = dbPool(context.config);
      const finalization = await new PostRunFinalizationService(
        repository,
        new EvolutionSolidifier(new EvolutionRepository(db)),
        new EvolutionSignalEmitter(db),
        new PgUsageRepository(db),
        {
          reconcileForRun: async (spaceId: string, childRunId: string, userId: string) => {
            await new PlanExecutionService(db).reconcileForRun(spaceId, childRunId, userId);
            await new WorkflowExecutionService().reconcileForRun(db, spaceId, childRunId, userId);
          },
        },
        new PgRunSupervisor(db, new EvolutionSignalEmitter(db)),
      ).finalize(
        runId,
        identity.spaceId,
      );
      return reply.send(runFinalizationToOut(finalization));
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        return reply.code(404).send({ detail: error.message });
      }
      if (error instanceof NonTerminalRunError) {
        return reply.code(422).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.get("/api/v1/runs/:runId/finalization", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const finalization = await result.repository.getLatestRunFinalization(
      result.run.space_id,
      result.run.id,
    );
    if (!finalization) {
      return reply.code(404).send({
        detail: `No finalization found for run '${result.run.id}'. POST /runs/${result.run.id}/finalize first.`,
      });
    }
    return reply.send(runFinalizationToOut(finalization));
  });

  app.get("/api/v1/runs/:runId/finalizations", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const finalizations = await result.repository.listRunFinalizations(
      result.run.space_id,
      result.run.id,
    );
    return reply.send(finalizations.map(runFinalizationToOut));
  });

  app.get("/api/v1/runs/:runId/evaluation", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const evaluation = await result.repository.getLatestRunEvaluation(
      result.run.space_id,
      result.run.id,
    );
    if (!evaluation) {
      return reply.code(404).send({
        detail: `No evaluation found for run '${result.run.id}'. POST /runs/${result.run.id}/finalize first.`,
      });
    }
    return reply.send(runEvaluationToOut(evaluation));
  });

  app.get("/api/v1/runs/:runId/evaluations", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const evaluations = await result.repository.listRunEvaluations(
      result.run.space_id,
      result.run.id,
    );
    return reply.send(evaluations.map(runEvaluationToOut));
  });

  app.get("/api/v1/runs/:runId/verification", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const verifications = await result.repository.listVerificationResults(
      result.run.space_id,
      result.run.id,
    );
    return reply.send(verifications.map(verificationResultToOut));
  });

  app.get("/api/v1/runs/:runId/verifications", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    const verifications = await result.repository.listVerificationResults(
      result.run.space_id,
      result.run.id,
    );
    return reply.send(verifications.map(verificationResultToOut));
  });

  app.get("/api/v1/runs/:runId", async (request, reply) => {
    const result = await visibleRun(context, request, reply);
    if (!result) return reply;
    return reply.send(await runToOutWithProvider(result.repository, result.run));
  });

  app.post("/api/v1/runs/:runId/resume", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const repository = PgRunRepository.fromConfig(context.config);
    const runId = params(request).runId ?? "";
    const run = await repository.getVisibleRun(identity.spaceId, identity.userId, runId);
    if (!run) {
      return reply.code(404).send({ detail: "Run not found in this space" });
    }
    if (run.status !== "waiting_for_review") {
      return reply
        .code(409)
        .send({ detail: `Run is not waiting for review (current status: ${run.status})` });
    }
    const grantedAt = new Date().toISOString();
    const supervisorReview = recordValue(run.error_json).supervisor_review === true;
    const updated = supervisorReview
      ? await repository.resumeRunAfterSupervisorReview({
          run_id: runId,
          space_id: identity.spaceId,
          resumed_by_user_id: identity.userId,
          resumed_at: grantedAt,
        })
      : await repository.grantRunApprovalAndRequeue({
          run_id: runId,
          space_id: identity.spaceId,
          granted_by_user_id: identity.userId,
          granted_at: grantedAt,
        });
    if (!updated) {
      return reply.code(409).send({ detail: "Run could not be resumed (status may have changed)" });
    }
    await enqueueAgentRunJob(context.config, {
      run_id: runId,
      space_id: identity.spaceId,
      user_id: identity.userId,
      agent_id: run.agent_id,
      workspace_id: run.workspace_id,
    });
    return reply.code(202).send({
      id: updated.id,
      status: updated.status,
      resumed_at: grantedAt,
      resume_kind: supervisorReview ? "new_attempt" : "same_attempt",
    });
  });

  app.post("/api/v1/runs/:runId/abandon", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const repository = PgRunRepository.fromConfig(context.config);
    const runId = params(request).runId ?? "";
    const run = await repository.getVisibleRun(identity.spaceId, identity.userId, runId);
    if (!run) {
      return reply.code(404).send({ detail: "Run not found in this space" });
    }
    if (run.status !== "waiting_for_review") {
      return reply
        .code(409)
        .send({ detail: `Run is not waiting for review (current status: ${run.status})` });
    }
    const body = jsonBody(request);
    const abandonedAt = new Date().toISOString();
    const updated = await repository.markRunTerminal({
      run_id: runId,
      space_id: identity.spaceId,
      status: "cancelled",
      output_json: {},
      error_json: {
        error_code: "run_abandoned",
        error_text: stringValue(body.reason) ?? "Run abandoned after supervisor review.",
        abandoned_by_user_id: identity.userId,
      },
      exit_code: 1,
      completed_at: abandonedAt,
    });
    if (!updated) {
      return reply.code(409).send({ detail: "Run could not be abandoned (status may have changed)" });
    }
    await RunMaterializationService.fromConfig(context.config).finalizeRun(updated);
    return reply.code(202).send({
      id: updated.id,
      status: updated.status,
      abandoned_at: abandonedAt,
    });
  });
}

function stopResponse(
  run: RunRecord | null,
  fallbackStatus: string,
  changed: boolean,
): Record<string, unknown> {
  return {
    id: run?.id ?? null,
    status: run?.status ?? fallbackStatus,
    mode: run?.mode ?? null,
    run_type: run?.run_type ?? "agent",
    trigger_origin: run?.trigger_origin ?? null,
    started_at: run?.started_at ?? null,
    ended_at: run?.ended_at ?? null,
    error_message: run?.error_message ?? null,
    changed,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function visibleRun(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ repository: PgRunRepository; run: RunRecord; identity: RunsIdentity } | null> {
  const identity = await resolveIdentity(context, request, reply);
  if (!identity) return null;
  const repository = PgRunRepository.fromConfig(context.config);
  const runId = params(request).runId ?? "";
  const run = await repository.getVisibleRun(identity.spaceId, identity.userId, runId);
  if (!run) {
    reply.code(404).send({ detail: "Run not found in this space" });
    return null;
  }
  return { repository, run, identity };
}

async function runToOutWithProvider(
  repository: PgRunRepository,
  run: RunRecord,
): Promise<Record<string, unknown>> {
  const provider = await repository.getModelProviderSummary(
    run.space_id,
    run.model_provider_id,
  );
  return runToOut(run, provider);
}

function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
