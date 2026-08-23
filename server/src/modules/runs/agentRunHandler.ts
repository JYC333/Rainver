import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { RunMaterializationService } from "./materializationService";
import { RunOrchestrationService } from "./orchestrationService";
import { PgRunRepository } from "./repository";
import { sharedCliProcessRegistry } from "./processRegistry";
import { PgCodePatchCollector, PgRunSandboxManager } from "../projectFolders";
import { PgVerificationEngine } from "./verification";
import {
  JobDeferredError,
  type JobEnvelopeForHandler,
  type JobHandlerRegistry,
} from "../jobs/handlerRegistry";
import type { JobHandlerResult } from "../jobs/handlerRegistry";
import { PgJobQueueRepository } from "../jobs/repository";
import type { RuntimeHostLogger } from "../runtimeHost";
import { finalizeChatTurn } from "./chatTurnFinalizer";
import { recordHostTaskThreadOutcome } from "../hosts/threadOutcome";
import { protocolRunStatus } from "./orchestrationResults";
import { withDbTransaction } from "../routeUtils/common";

export function registerAgentRunHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
  runtimeHostLogger?: RuntimeHostLogger,
): void {
  if (!config.databaseUrl) return;

  const repository = PgRunRepository.fromConfig(config);
  const materializer = RunMaterializationService.fromConfig(config);
  const orchestration = new RunOrchestrationService(config, repository, {
    materializer,
    workspaceManager: PgRunSandboxManager.fromConfig(config),
    codePatchCollector: PgCodePatchCollector.fromConfig(config),
    verificationEngine: PgVerificationEngine.fromConfig(config),
    processRegistry: sharedCliProcessRegistry,
    managedApi: { runtimeHostLogger },
  });

  registry.register("agent_run", async (job) =>
    handleAgentRun(job, orchestration, materializer, repository, config));
  registry.register("authorization_request_reconcile", async (job) =>
    reconcileAuthorizationRequest(job, orchestration, repository, config));
}

async function reconcileAuthorizationRequest(
  job: JobEnvelopeForHandler,
  orchestration: RunOrchestrationService,
  repository: PgRunRepository,
  config: ServerConfig,
): Promise<JobHandlerResult> {
  const requestId = stringValue(job.payload.authorization_request_id);
  const runId = stringValue(job.payload.run_id);
  if (!requestId || !runId || !config.databaseUrl) {
    throw new Error("authorization_request_reconcile requires authorization_request_id and run_id");
  }
  const db = getDbPool(config.databaseUrl);
  const request = await db.query<{
    status: "approved" | "rejected";
    agent_id: string;
    instructed_by_user_id: string;
    decided_by_user_id: string;
  }>(
    `SELECT status, agent_id, instructed_by_user_id, decided_by_user_id
       FROM authorization_requests
      WHERE id = $1 AND run_id = $2 AND space_id = $3
        AND status IN ('approved', 'rejected')
      LIMIT 1`,
    [requestId, runId, job.space_id],
  );
  const decided = request.rows[0];
  if (!decided) throw new Error("Decided authorization request not found");

  if (decided.status === "rejected") {
    const result = await orchestration.cancelRun({
      run_id: runId,
      space_id: job.space_id,
      requested_by_user_id: decided.decided_by_user_id,
      reason: "Agent authorization request was rejected.",
    });
    if (result.error_code === "finalization_failed") {
      throw new Error(
        result.error ?? "Authorization rejection finalization failed.",
      );
    }
    const terminal = await repository.getRun(job.space_id, runId);
    if (terminal) await finalizeChatTurn(config, repository, terminal);
    return result;
  }

  const reconciliation = await withDbTransaction(db, async (client) => {
    const runs = new PgRunRepository(client);
    const queue = new PgJobQueueRepository(client);
    const updated = await runs.requeueApprovedAuthorizationRequest({
      run_id: runId,
      space_id: job.space_id,
      authorization_request_id: requestId,
      resumed_at: new Date().toISOString(),
    });
    const current = updated ?? await runs.getRun(job.space_id, runId);
    if (current?.status === "queued") {
      await queue.ensureAgentRunJob({
        job_type: "agent_run",
        space_id: job.space_id,
        user_id: decided.instructed_by_user_id,
        agent_id: decided.agent_id,
        project_folder_id: current.project_folder_id,
        payload: { run_id: runId },
      });
    }
    return { updated, current };
  });
  if (!reconciliation.updated) {
    if (
      reconciliation.current
      && reconciliation.current.status !== "waiting_for_review"
    ) {
      return {
        run_id: runId,
        status: reconciliation.current.status,
        reconciled: true,
      };
    }
    const exponent = Math.max(0, Math.min(6, job.attempts - 1));
    throw new JobDeferredError(
      "Run execution lock has not been released for authorization reconciliation",
      Math.min(30_000, 500 * (2 ** exponent)),
    );
  }
  return { run_id: runId, status: "queued", reconciled: true };
}

async function handleAgentRun(
  job: JobEnvelopeForHandler,
  orchestration: RunOrchestrationService,
  materializer: RunMaterializationService,
  repository: PgRunRepository,
  config: ServerConfig,
): Promise<JobHandlerResult> {
  const runId = stringValue(job.payload.run_id);
  if (!runId) {
    throw new Error(
      "agent_run payload requires run_id under the server runs authority; " +
        "task_id/agent_id create-and-execute payloads are not supported",
    );
  }
  if (!job.user_id) {
    throw new Error("agent_run job requires user_id");
  }
  let result: Awaited<ReturnType<RunOrchestrationService["executeRun"]>>;
  try {
    result = await orchestration.executeRun({
      run_id: runId,
      space_id: job.space_id,
      worker_id: job.worker_id,
      job_id: job.job_id,
      command_source: "job",
      // control-center-phase2-plan.md P1: the hosts dispatch endpoint no
      // longer calls executeRun synchronously — it enqueues this job instead
      // (async dispatch) and carries the task thread's vendor resume session
      // id and requested timeout here, the same way the endpoint used to
      // pass both as direct caller parameters (the timeout was dropped
      // silently by the P1 migration until P1 discovery review caught it —
      // no other agent_run job carries timeout_ms today, so both fields are
      // undefined/null for every job but this endpoint's).
      adapter_config: recordValue(job.payload.adapter_config),
      timeout_ms: numberValue(job.payload.timeout_ms),
    });
  } catch (error) {
    if (job.attempts >= job.max_attempts) {
      const current = await repository.getRun(job.space_id, runId);
      const terminal = current && isTerminalRun(current.status)
        ? current
        : await repository.markRunTerminal({
            run_id: runId,
            space_id: job.space_id,
            status: "orphaned",
            output_json: {},
            error_json: {
              error_code: "job_exhausted",
              error_text: error instanceof Error
                ? error.message
                : "The agent_run job exhausted its retry budget.",
            },
            exit_code: 1,
            completed_at: new Date().toISOString(),
          });
      if (terminal) {
        const finalization = await materializer.finalizeRun(terminal);
        if (finalization.status === "succeeded") {
          const currentTerminal = await repository.getRun(job.space_id, runId);
          if (currentTerminal && isTerminalRun(currentTerminal.status)) {
            await orchestration.reconcileTerminalDelegation(currentTerminal);
            await finalizeChatTurn(config, repository, currentTerminal);
            const exhaustedThreadId = stringValue(job.payload.host_task_thread_id);
            if (exhaustedThreadId) {
              await recordHostTaskThreadOutcome(
                config,
                exhaustedThreadId,
                currentTerminal,
                job.payload.host_thread_resume_attempted === true,
              );
            }
          }
        }
      }
    }
    throw error;
  }
  let completedRun = await repository.getRun(job.space_id, runId);
  if (completedRun && isTerminalRun(completedRun.status)) {
    const finalization = await materializer.finalizeRun(completedRun);
    if (finalization.status !== "succeeded") {
      throw new Error(
        finalization.error_message ?? "Run finalization reconciliation failed.",
      );
    }
    completedRun = await repository.getRun(job.space_id, runId);
    if (completedRun) {
      result = { ...result, status: protocolRunStatus(completedRun.status) };
    }
  }
  if (completedRun && isTerminalRun(completedRun.status)) {
    await orchestration.reconcileTerminalDelegation(completedRun);
  }
  if (completedRun) {
    await finalizeChatTurn(config, repository, completedRun);
  }
  // control-center-phase2-plan.md P1: the hosts dispatch endpoint now
  // enqueues this job instead of awaiting executeRun inline, so task-thread
  // outcome recording (vendor session id, session_reset detection) has to
  // happen here instead, gated on the run actually carrying a thread.
  const hostTaskThreadId = stringValue(job.payload.host_task_thread_id);
  if (completedRun && hostTaskThreadId) {
    await recordHostTaskThreadOutcome(
      config,
      hostTaskThreadId,
      completedRun,
      job.payload.host_thread_resume_attempted === true,
    );
  }
  // Research runs use the normal Run/Materialization authority. This hook is
  // only a latency optimization: the reconciler observes the committed run
  // and advances the owning Project Research operation.
  if (result.status === "succeeded" || result.status === "failed" || result.status === "degraded" || result.status === "cancelled") {
    const db = getDbPool(config.databaseUrl!);
    const contract = await db.query<{ workflow_input_json: unknown }>(
      `SELECT contract_snapshot_json->'workflow_input_json' AS workflow_input_json
         FROM runs WHERE id=$1 AND space_id=$2`,
      [runId, job.space_id],
    );
    const workflowInput = recordValue(contract.rows[0]?.workflow_input_json);
    const kind = stringValue(workflowInput.kind);
    const queue = new PgJobQueueRepository(db);
    if (kind === "knowledge_candidate_extraction") {
      await queue.enqueue({
        job_type: "knowledge_candidate_extraction_reconcile",
        space_id: job.space_id,
        user_id: job.user_id,
        payload: { run_id: runId },
      });
    } else if (kind === "managed_experiment") {
      await queue.enqueue({
        job_type: "managed_experiment_reconcile",
        space_id: job.space_id,
        user_id: job.user_id,
        payload: { run_id: runId },
      });
    } else if (workflowInput.project_research_standing !== undefined) {
      await queue.enqueue({
        job_type: "project_research_standing_reconcile",
        space_id: job.space_id,
        user_id: job.user_id,
        payload: { run_id: runId },
      });
    } else if (workflowInput.project_research !== undefined) {
      await queue.enqueue({
        job_type: "project_research_execution_nudge",
        space_id: job.space_id,
        user_id: job.user_id,
        payload: { run_id: runId, reason: "agent_run_terminal" },
      });
    }
  }
  return result;
}

export async function enqueueAgentRunJob(
  config: ServerConfig,
  input: {
    run_id: string;
    space_id: string;
    user_id: string;
    agent_id?: string | null;
    project_folder_id?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error("enqueueAgentRunJob requires SERVER_DATABASE_URL");
  }
  const queue = new PgJobQueueRepository(getDbPool(config.databaseUrl));
  await queue.enqueue({
    job_type: "agent_run",
    space_id: input.space_id,
    user_id: input.user_id,
    agent_id: input.agent_id ?? null,
    project_folder_id: input.project_folder_id ?? null,
    payload: {
      run_id: input.run_id,
      ...(input.payload ?? {}),
    },
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isTerminalRun(status: string): boolean {
  return [
    "succeeded",
    "failed",
    "degraded",
    "cancelled",
    "orphaned",
  ].includes(status);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
