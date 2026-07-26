import { randomUUID } from "node:crypto";
import { getDbPool } from "../../db/pool";
import type { ServerConfig } from "../../config";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common";
import { PgJobQueueRepository } from "../jobs/repository";
import { PgRouteDecisionRepository } from "../routing/repository";
import { EvolutionSignalEmitter } from "../evolution/signalEmitters";
import { contractRecord } from "./contractSnapshot";
import { isManagedFailFastRun } from "../policy/managedExecutionPolicy";
import { PgRunRepository, type RunRecord } from "./repository";
import type { RunEvaluationRecord, RunAttemptRecord } from "./runRepositoryTypes";

export const DEFAULT_MAX_RUN_ATTEMPTS = 2;

const RETRYABLE_ERROR_CODES = new Set([
  "adapter_timeout",
  "cli_adapter_timeout",
  "cli_stall_timeout",
  "adapter_runtime_error",
  "cli_runtime_provider_config_failed",
  "runtime_tool_version_unavailable",
  "runtime_session_invalid",
  "provider_network_error",
  "provider_rate_limit",
  "orphaned",
  "semantic_rejection",
  "verification_failed",
  "validation_failed",
  "run_exchange_output_validation_failed",
]);

export interface RunSupervisorPort {
  supervise(input: {
    run: RunRecord;
    evaluation: Pick<RunEvaluationRecord, "failure_reason_code" | "outcome_status">;
  }): Promise<SupervisorDecision | null>;
}

export interface SupervisorDecision {
  decision: "retry_same_route" | "retry_fallback_route" | "human_review" | "budget_exceeded" | "cancelled";
  reason_code: string;
  attempt_number: number;
  total_estimated_cost_usd: number | null;
  max_cost_usd: number | null;
}

interface AttemptRow extends RunAttemptRecord {
  supervisor_decision_id?: string | null;
}

export class PgRunSupervisor implements RunSupervisorPort {
  constructor(
    private readonly db: Queryable,
    private readonly signalEmitter: EvolutionSignalEmitter | null = null,
  ) {}

  static fromConfig(config: ServerConfig): PgRunSupervisor | null {
    if (!config.databaseUrl) return null;
    const db = getDbPool(config.databaseUrl);
    return new PgRunSupervisor(db, new EvolutionSignalEmitter(db));
  }

  async supervise(input: {
    run: RunRecord;
    evaluation: Pick<RunEvaluationRecord, "failure_reason_code" | "outcome_status">;
  }): Promise<SupervisorDecision | null> {
    if (input.run.run_role === "coordinator") return null;
    if (!isSupervisableStatus(input.run.status)) return null;
    // Managed Source/Research executions have an owning operation that
    // records the terminal failure and exposes its own retry action. Sending
    // them through the generic Supervisor would create a second review gate.
    if (isManagedFailFastRun(input.run)) return null;

    return withQueryableTransaction(this.db, async (db) => {
      const repository = new PgRunRepository(db);
      const attempt = await ensureAttempt(db, input.run);
      const existing = await db.query<{ id: string }>(
        `SELECT id
           FROM run_supervisor_decisions
          WHERE space_id = $1 AND attempt_id = $2
          LIMIT 1`,
        [input.run.space_id, attempt.id],
      );
      if (existing.rows[0]) return null;

      const cost = await db.query<{ total_cost_usd: string | number | null }>(
        `SELECT sum(estimated_cost_usd)::numeric AS total_cost_usd
           FROM token_usage_events
          WHERE space_id = $1 AND run_id = $2`,
        [input.run.space_id, input.run.id],
      );
      const totalCost = numberOrNull(cost.rows[0]?.total_cost_usd);
      const maxCost = maxCostForRun(input.run);
      const reasonCode = input.evaluation.failure_reason_code
        ?? errorCodeFromRun(input.run)
        ?? "run_failed";
      const attemptNumber = attempt.attempt_number;
      const maxAttempts = maxAttemptsForRun(input.run);
      const budgetExceeded = maxCost !== null && totalCost !== null && totalCost >= maxCost;
      const retryable = RETRYABLE_ERROR_CODES.has(reasonCode);
      const canRetry = retryable && !budgetExceeded && attemptNumber < maxAttempts;
      const hasFallbackRoute = canRetry
        ? await new PgRouteDecisionRepository(db).hasFallbackRoute(input.run)
        : false;
      const userId = input.run.owner_user_id ?? input.run.instructed_by_user_id ?? null;
      const decision: SupervisorDecision = budgetExceeded
        ? {
            decision: "budget_exceeded",
            reason_code: "run_budget_exceeded",
            attempt_number: attemptNumber,
            total_estimated_cost_usd: totalCost,
            max_cost_usd: maxCost,
          }
        : canRetry && userId
          ? {
              decision: hasFallbackRoute ? "retry_fallback_route" : "retry_same_route",
              reason_code: reasonCode,
              attempt_number: attemptNumber,
              total_estimated_cost_usd: totalCost,
              max_cost_usd: maxCost,
            }
          : {
              decision: "human_review",
              reason_code: !retryable
                ? reasonCode
                : !userId
                  ? "retry_identity_unavailable"
                  : "retry_attempt_cap_reached",
              attempt_number: attemptNumber,
              total_estimated_cost_usd: totalCost,
              max_cost_usd: maxCost,
            };

      const decisionId = randomUUID();
      await db.query(
        `INSERT INTO run_supervisor_decisions (
           id, space_id, run_id, attempt_id, decision, reason_code,
           next_attempt_number, total_estimated_cost_usd, max_cost_usd,
           metadata_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
        [
          decisionId,
          input.run.space_id,
          input.run.id,
          attempt.id,
          decision.decision,
          decision.reason_code,
          decision.decision === "retry_same_route" || decision.decision === "retry_fallback_route"
            ? attemptNumber + 1
            : null,
          decision.total_estimated_cost_usd,
          decision.max_cost_usd,
          JSON.stringify({
            max_attempts: maxAttempts,
            reroute: decision.decision === "retry_fallback_route",
            retryable,
            source_status: input.run.status,
            outcome_status: input.evaluation.outcome_status,
          }),
          new Date().toISOString(),
        ],
      );

      if (decision.decision === "retry_same_route" || decision.decision === "retry_fallback_route") {
        const requeued = await repository.requeueRunForRetry({
          run_id: input.run.id,
          space_id: input.run.space_id,
          updated_at: new Date().toISOString(),
          reason_code: decision.reason_code,
          attempt_number: attemptNumber + 1,
        });
        if (!requeued) throw new Error("Supervisor could not requeue the failed run");
        await new PgJobQueueRepository(db).enqueue({
          job_type: "agent_run",
          space_id: input.run.space_id,
          user_id: userId,
          agent_id: input.run.agent_id,
          project_folder_id: input.run.project_folder_id,
          max_attempts: 3,
          payload: { run_id: input.run.id, supervisor_attempt: attemptNumber + 1 },
        });
      } else if (decision.decision !== "cancelled") {
        const reason = decision.decision === "budget_exceeded"
          ? "Run cost cap was reached before another physical attempt could start."
          : `Supervisor requires human review after attempt ${attemptNumber}: ${decision.reason_code}.`;
        await repository.holdRunForSupervisorReview({
          run_id: input.run.id,
          space_id: input.run.space_id,
          updated_at: new Date().toISOString(),
          reason_code: decision.reason_code,
          message: reason,
        });
      }
      const transactionSignalEmitter = this.signalEmitter?.forDatabase(db);
      if (transactionSignalEmitter) {
        let savepoint = false;
        try {
          await db.query("SAVEPOINT supervisor_signal");
          savepoint = true;
          await transactionSignalEmitter.emitSupervisorOutcomeForRun({
            run: input.run,
            sourceId: decisionId,
            outcome: decision.decision,
            summary: `Supervisor selected '${decision.decision}' for run '${input.run.id}'.`,
            payload: {
              decision_id: decisionId,
              reason_code: decision.reason_code,
              attempt_number: decision.attempt_number,
              total_estimated_cost_usd: decision.total_estimated_cost_usd,
              max_cost_usd: decision.max_cost_usd,
            },
            severity: decision.decision === "human_review" || decision.decision === "budget_exceeded" ? "error" : "info",
          });
          await db.query("RELEASE SAVEPOINT supervisor_signal");
          savepoint = false;
        } catch {
          if (savepoint) {
            await db.query("ROLLBACK TO SAVEPOINT supervisor_signal").catch(() => undefined);
            await db.query("RELEASE SAVEPOINT supervisor_signal").catch(() => undefined);
          }
        }
      }
      return decision;
    });
  }
}

async function ensureAttempt(db: Queryable, run: RunRecord): Promise<AttemptRow> {
  const existing = await new PgRunRepository(db).getLatestRunAttempt(run.space_id, run.id);
  if (existing) return existing;
  const now = run.ended_at ?? run.updated_at ?? new Date().toISOString();
  const id = randomUUID();
  await db.query(
    `INSERT INTO run_attempts (
       id, space_id, run_id, attempt_number, status,
       started_at, ended_at, last_activity_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, $4, $5, $5, $5, $5, $5)
     ON CONFLICT (space_id, run_id, attempt_number) DO NOTHING`,
    [id, run.space_id, run.id, attemptStatusForRun(run.status), run.started_at ?? now],
  );
  const created = await new PgRunRepository(db).getLatestRunAttempt(run.space_id, run.id);
  if (!created) throw new Error(`Run attempt was not created for run '${run.id}'`);
  return created;
}

function isSupervisableStatus(status: string): boolean {
  return status === "failed" || status === "degraded" || status === "orphaned";
}

function attemptStatusForRun(status: string): string {
  return status === "orphaned" ? "orphaned" : status === "degraded" ? "degraded" : "failed";
}

function maxAttemptsForRun(run: RunRecord): number {
  const configured = contractRecord(run.contract_snapshot_json).max_attempts;
  if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_MAX_RUN_ATTEMPTS;
  return Math.max(1, Math.min(10, Math.floor(configured)));
}

function maxCostForRun(run: RunRecord): number | null {
  const configured = contractRecord(run.contract_snapshot_json).max_cost;
  return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
    ? configured
    : null;
}

function errorCodeFromRun(run: RunRecord): string | null {
  if (!run.error_json || typeof run.error_json !== "object" || Array.isArray(run.error_json)) return null;
  const value = (run.error_json as Record<string, unknown>).error_code;
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
