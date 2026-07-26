import {
  type PgRunRepository,
  type RunEvaluationRecord,
  type RunFinalizationRecord,
  type RunRecord,
} from "./repository";
import type { EvolutionRunEvaluationForSolidifier } from "../evolution/solidifier";
import { EvolutionSignalEmitter } from "../evolution/signalEmitters";
import {
  hasDeclaredVerificationChecks,
  summarizeVerificationResults,
} from "./verification";
import type { VerificationResultRecord } from "./verification";
import type { RunSupervisorPort } from "./supervisor";

export const RUN_FINALIZER_VERSION = "post_run_finalization.v1";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "degraded", "cancelled", "orphaned"]);

const EXACT_ERROR_CODE_MAP: Record<string, { layer: string; reason: string }> = {
  context_snapshot_population_failed: {
    layer: "context",
    reason: "context_snapshot_population_failed",
  },
  sandbox_required: { layer: "sandbox", reason: "sandbox_required" },
  docker_sandbox_not_supported: {
    layer: "sandbox",
    reason: "docker_sandbox_not_supported",
  },
  docker_network_policy_denied: {
    layer: "sandbox",
    reason: "docker_network_policy_denied",
  },
  docker_sandbox_unavailable: {
    layer: "sandbox",
    reason: "docker_sandbox_unavailable",
  },
  file_access_adapter_requires_worktree_policy: {
    layer: "policy",
    reason: "file_access_adapter_requires_worktree_policy",
  },
  credentials_missing: { layer: "policy", reason: "credentials_missing" },
  adapter_runtime_error: { layer: "runtime", reason: "adapter_runtime_error" },
  semantic_rejection: { layer: "task_spec", reason: "semantic_rejection" },
  runtime_removed: { layer: "runtime", reason: "runtime_removed" },
  orphaned: { layer: "orchestration", reason: "orphaned" },
  duplicate_execution: { layer: "orchestration", reason: "duplicate_execution" },
  run_cancelled: { layer: "orchestration", reason: "run_cancelled" },
  validation_failed: { layer: "validation", reason: "validation_failed" },
  verification_failed: { layer: "validation", reason: "verification_failed" },
  usage_recording_failed: {
    layer: "orchestration",
    reason: "usage_recording_failed",
  },
  run_exchange_output_validation_failed: {
    layer: "validation",
    reason: "run_exchange_output_validation_failed",
  },
  validation_command_failed: {
    layer: "validation",
    reason: "validation_command_failed",
  },
  code_patch_validation_failed: {
    layer: "validation",
    reason: "code_patch_validation_failed",
  },
  code_patch_collection_error: {
    layer: "tool",
    reason: "code_patch_collection_error",
  },
  produced_artifact_ingestion_error: {
    layer: "tool",
    reason: "produced_artifact_ingestion_error",
  },
  runtime_output_artifact: { layer: "tool", reason: "runtime_output_artifact" },
  output_artifact_materialization_error: {
    layer: "tool",
    reason: "output_artifact_materialization_error",
  },
  output_proposal_materialization_error: {
    layer: "tool",
    reason: "output_proposal_materialization_error",
  },
  output_activity_materialization_error: {
    layer: "tool",
    reason: "output_activity_materialization_error",
  },
};

export class RunNotFoundError extends Error {}
export class NonTerminalRunError extends Error {}

export interface EvolutionRunEvaluationSolidifier {
  solidifyFromRunEvaluation(
    evaluation: EvolutionRunEvaluationForSolidifier,
  ): Promise<{ id: string } | null>;
}

export interface RunEstimatedCostReader {
  getRunEstimatedCost(spaceId: string, runId: string): Promise<number | null>;
}

export interface ExecutionGraphReconciler {
  reconcileForRun(spaceId: string, runId: string, userId: string): Promise<void>;
}

export class PostRunFinalizationService {
  constructor(
    private readonly repository: PgRunRepository,
    private readonly evolutionSolidifier?: EvolutionRunEvaluationSolidifier,
    private readonly evolutionSignalEmitter?: EvolutionSignalEmitter,
    private readonly runEstimatedCostReader?: RunEstimatedCostReader,
    private readonly executionGraphReconciler?: ExecutionGraphReconciler,
    private readonly supervisor?: RunSupervisorPort,
  ) {}

  async finalize(runId: string, spaceId: string): Promise<RunFinalizationRecord> {
    const run = await this.repository.getRun(spaceId, runId);
    if (!run) {
      throw new RunNotFoundError(`Run '${runId}' not found in space '${spaceId}'`);
    }
    if (!TERMINAL_STATUSES.has(run.status)) {
      throw new NonTerminalRunError(
        `Run '${runId}' is not terminal (status='${run.status}'); finalization requires a terminal status: succeeded, failed, degraded, or cancelled.`,
      );
    }

    const attemptNumber = await this.currentAttemptNumber(run);
    return this.repository.withRunFinalizationLock(
      spaceId,
      runId,
      attemptNumber,
      RUN_FINALIZER_VERSION,
      (repository) => new PostRunFinalizationService(
        repository,
        this.evolutionSolidifier,
        this.evolutionSignalEmitter,
        this.runEstimatedCostReader,
        this.executionGraphReconciler,
        this.supervisor,
      ).finalizeLocked(run, attemptNumber),
    );
  }

  private async finalizeLocked(
    run: RunRecord,
    attemptNumber: number,
  ): Promise<RunFinalizationRecord> {
    const spaceId = run.space_id;
    const runId = run.id;
    const existing = await this.repository.getRunFinalizationByVersion(
      spaceId,
      runId,
      attemptNumber,
      RUN_FINALIZER_VERSION,
    );
    if (existing) {
      const verificationResults = await this.repository.listVerificationResults(spaceId, runId);
      const repeatedEvaluation = {
        id: existing.run_evaluation_id,
        outcome_status: existing.outcome_status ?? "unknown",
        failure_layer: existing.failure_layer,
        failure_reason_code: isSupervisableStatus(run.status)
          ? stringValue(recordValue(run.error_json).error_code) ?? existing.failure_reason_code
          : existing.failure_reason_code,
        trajectory_status: existing.trajectory_status,
      };
      await this.emitSignalsBestEffort({
        run,
        estimated_cost_usd: await this.estimatedCostBestEffort(spaceId, runId),
        evaluation: repeatedEvaluation,
        verification: summarizeVerificationResults(verificationResults),
        repeated: true,
      });
      if (isSupervisableStatus(run.status)) {
        await this.superviseBestEffort(run, repeatedEvaluation);
      }
      const currentRun = await this.repository.getRun(spaceId, runId);
      await this.reconcileExecutionGraphBestEffort(currentRun ?? run);
      await this.repository.markRunFinalizationGateCommitted(
        spaceId,
        existing.id,
        new Date().toISOString(),
      );
      return existing;
    }

    const evaluation = await this.evaluate(run, attemptNumber);
    const now = new Date().toISOString();
    const taskBridge = await this.repository.bridgeTaskEvaluationForRunEvaluation(
      spaceId,
      evaluation,
    );
    const evolutionExperience = await this.evolutionSolidifier?.solidifyFromRunEvaluation(evaluation) ?? null;
    const skippedReasons = taskBridge.skippedReason ? [taskBridge.skippedReason] : [];
    const finalization = await this.repository.insertRunFinalization({
      space_id: spaceId,
      run_id: runId,
      attempt_number: attemptNumber,
      finalizer_version: RUN_FINALIZER_VERSION,
      status: "completed",
      run_evaluation_id: evaluation.id,
      task_evaluation_id: taskBridge.taskEvaluationId,
      outcome_status: evaluation.outcome_status,
      failure_layer: evaluation.failure_layer,
      failure_reason_code: evaluation.failure_reason_code,
      trajectory_status: evaluation.trajectory_status,
      skipped_reasons_json: skippedReasons,
      metadata_json: {
        finalizer_version: RUN_FINALIZER_VERSION,
        attempt_number: attemptNumber,
        evolution_experience_id: evolutionExperience?.id ?? null,
      },
      finalized_at: now,
      created_at: now,
    });
    const verificationResults = await this.repository.listVerificationResults(spaceId, runId);
    await this.emitSignalsBestEffort({
      run,
      estimated_cost_usd: await this.estimatedCostBestEffort(spaceId, runId),
      evaluation,
      verification: summarizeVerificationResults(verificationResults),
    });
    try {
      await this.repository.appendRunEvent({
        run_id: runId,
        space_id: spaceId,
        event_type: "run_finalized",
        status: "succeeded",
        metadata_json: {
          run_finalization_id: finalization.id,
          run_evaluation_id: evaluation.id,
          task_evaluation_id: taskBridge.taskEvaluationId,
          evolution_experience_id: evolutionExperience?.id ?? null,
          skipped_reasons: skippedReasons,
          finalizer_version: RUN_FINALIZER_VERSION,
        },
      });
    } catch {
      // RunEvent is an append-only audit log. A missed audit event must not
      // turn a completed finalization into a failed one.
    }
    await this.superviseBestEffort(run, evaluation);
    const currentRun = await this.repository.getRun(spaceId, runId);
    await this.reconcileExecutionGraphBestEffort(currentRun ?? run);
    await this.repository.markRunFinalizationGateCommitted(
      spaceId,
      finalization.id,
      new Date().toISOString(),
    );
    return finalization;
  }

  private async superviseBestEffort(
    run: RunRecord,
    evaluation: Pick<RunEvaluationRecord, "failure_reason_code" | "outcome_status">,
  ): Promise<void> {
    if (!this.supervisor) return;
    // The evaluation is durable and repeated finalization is idempotent, but a
    // missing Supervisor decision is not optional: callers must retry until
    // the retry/review transition is committed.
    await this.supervisor.supervise({ run, evaluation });
  }

  private async reconcileExecutionGraphBestEffort(run: RunRecord): Promise<void> {
    if (!this.executionGraphReconciler) return;
    const userId = run.owner_user_id ?? run.instructed_by_user_id ?? "system";
    try {
      await this.executionGraphReconciler.reconcileForRun(run.space_id, run.id, userId);
    } catch {
      // Reconciliation is idempotent and best-effort. A terminal run and its
      // finalization remain durable even if the scheduler needs a later retry.
    }
  }

  private async estimatedCostBestEffort(spaceId: string, runId: string): Promise<number | null> {
    if (!this.runEstimatedCostReader) return null;
    try {
      return await this.runEstimatedCostReader.getRunEstimatedCost(spaceId, runId);
    } catch {
      return null;
    }
  }

  private async currentAttemptNumber(run: RunRecord): Promise<number> {
    const getLatestRunAttempt = this.repository.getLatestRunAttempt;
    if (typeof getLatestRunAttempt !== "function") return 1;
    const attempt = await getLatestRunAttempt.call(this.repository, run.space_id, run.id);
    return attempt?.attempt_number && attempt.attempt_number > 0 ? attempt.attempt_number : 1;
  }

  private async emitSignalsBestEffort(input: Parameters<EvolutionSignalEmitter["emitRunFinalization"]>[0]): Promise<void> {
    if (!this.evolutionSignalEmitter) return;
    try {
      await this.evolutionSignalEmitter.emitRunFinalization(input);
    } catch {
      // Evolution telemetry is advisory. A signal write must not change the
      // run's finalization result or make a retry appear to have failed.
    }
  }

  private async evaluate(run: RunRecord, attemptNumber: number): Promise<RunEvaluationRecord> {
    const [allSteps, allEvents] = await Promise.all([
      this.repository.listRunSteps(run.space_id, run.id),
      this.repository.listRunEvents(run.space_id, run.id),
    ]);
    // Steps/events are stamped with the attempt that produced them. Evaluation
    // classifies one attempt, so a prior attempt's failure evidence must not
    // leak into a retry's classification. Unstamped rows (written while no
    // attempt row existed) stay included.
    const steps = allSteps.filter(
      (step) => step.attempt_number === null || step.attempt_number === attemptNumber,
    );
    const events = allEvents.filter(
      (event) => event.attempt_number === null || event.attempt_number === attemptNumber,
    );
    const eventErrorCodes = events
      .map((event) => event.error_code)
      .filter((code): code is string => Boolean(code));
    const stepErrorCodes = steps
      .filter((step) => step.status === "failed" && step.error_type)
      .map((step) => step.error_type as string);
    const errorCodes = dedupe([
      ...eventErrorCodes,
      ...collectErrorCodes(run.error_json),
      ...collectErrorCodes(run.output_json),
      ...stepErrorCodes,
    ]);
    const verificationResults = await this.repository.listVerificationResults(run.space_id, run.id);
    const verification = summarizeVerificationResults(verificationResults);
    const verificationFailure = verificationFailureForRun(run, verificationResults);
    const mapped = mapFailure(errorCodes, verificationFailure);
    const outcome = outcomeForRun(run, mapped.reason, verification);
    const now = new Date().toISOString();
    return this.repository.insertRunEvaluation({
      space_id: run.space_id,
      run_id: run.id,
      outcome_status: outcome.outcome_status,
      failure_layer: mapped.layer,
      failure_reason_code: mapped.reason,
      trajectory_status: outcome.trajectory_status,
      evidence_json: {
        run_status: run.status,
        attempt_number: attemptNumber,
        event_count: events.length,
        step_count: steps.length,
        event_types: events.map((event) => event.event_type),
        error_codes: errorCodes,
        required_sandbox_level: run.required_sandbox_level,
        adapter_type: run.adapter_type,
        verification,
        verification_results: verificationResults.map((result) => ({
          verifier_type: result.verifier_type,
          verifier_version: result.verifier_version,
          status: result.status,
          summary: result.summary,
        })),
      },
      rule_trace_json: [
        {
          rule: "ts_post_run_finalization.v1",
          terminal_status: run.status,
          attempt_number: attemptNumber,
          mapped_failure_reason: mapped.reason,
          verification_status: verification.status,
        },
      ],
      notes: null,
      evaluated_at: now,
    });
  }
}

function outcomeForRun(
  run: RunRecord,
  failureReason: string | null,
  verification: ReturnType<typeof summarizeVerificationResults>,
): { outcome_status: string; trajectory_status: string } {
  if (run.status === "succeeded") {
    if (failureReason === "verification_missing" || failureReason === "verification_incomplete") {
      return { outcome_status: "unknown", trajectory_status: "insufficient_evidence" };
    }
    if (verification.status === "failed") {
      return { outcome_status: "failed", trajectory_status: "incomplete" };
    }
    if (verification.status === "incomplete") {
      return { outcome_status: "unknown", trajectory_status: "insufficient_evidence" };
    }
    return failureReason
      ? { outcome_status: "partial", trajectory_status: "incomplete" }
      : { outcome_status: "passed", trajectory_status: "acceptable" };
  }
  if (run.status === "degraded") {
    return { outcome_status: "partial", trajectory_status: "incomplete" };
  }
  if (run.status === "cancelled") {
    return { outcome_status: "failed", trajectory_status: "incomplete" };
  }
  return { outcome_status: "failed", trajectory_status: "incomplete" };
}

function mapFailure(
  errorCodes: string[],
  verificationFailure: string | null,
): { layer: string | null; reason: string | null } {
  for (const code of errorCodes) {
    const mapped = EXACT_ERROR_CODE_MAP[code];
    if (mapped) return { layer: mapped.layer, reason: mapped.reason };
  }
  if (verificationFailure) return { layer: "validation", reason: verificationFailure };
  if (errorCodes.length > 0) return { layer: "unknown", reason: errorCodes[0] };
  return { layer: null, reason: null };
}

function verificationFailureForRun(
  run: RunRecord,
  results: VerificationResultRecord[],
): string | null {
  const declared = hasDeclaredVerificationChecks(run);
  if (!declared) return null;
  if (results.length === 0) return "verification_missing";
  if (results.some((result) => result.status === "failed" || result.status === "error")) {
    return "verification_failed";
  }
  if (results.some((result) => result.status === "skipped")) return "verification_incomplete";
  return null;
}

function collectErrorCodes(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const codes = [record.error_code, record.code].filter(
    (code): code is string => typeof code === "string" && code.length > 0,
  );
  return codes;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isSupervisableStatus(status: string): boolean {
  return status === "failed" || status === "degraded" || status === "orphaned";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
