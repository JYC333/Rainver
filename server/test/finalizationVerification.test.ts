import { describe, expect, it } from "vitest";
import {
  PostRunFinalizationService,
  RunSettlementPendingError,
} from "../src/modules/runs/finalizationService.js";
import type {
  PgRunRepository,
  RunEvaluationRecord,
  RunFinalizationRecord,
  RunRecord,
} from "../src/modules/runs/repository.js";
import type { VerificationResultRecord } from "../src/modules/runs/verification/index.js";

function run(contract_snapshot_json: unknown): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    execution_kind: "agent",
    agent_id: "agent-1",
    agent_version_id: "version-1",
    status: "succeeded",
    mode: "live",
    prompt: null,
    instruction: null,
    project_folder_id: null,
    session_id: null,
    project_id: null,
    runtime_key: "opencode",
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    started_at: null,
    ended_at: new Date().toISOString(),
    contract_snapshot_json,
    output_json: {},
    error_json: {},
  };
}

function verification(status: VerificationResultRecord["status"]): VerificationResultRecord {
  return {
    id: "verification-1",
    space_id: "space-1",
    run_id: "run-1",
    attempt_number: 1,
    verifier_type: "output_schema",
    verifier_version: "verification_engine.v1",
    status,
    summary: "schema result",
    evidence_refs_json: {},
    details_json: {},
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

class FinalizationRepository {
  constructor(
    private readonly currentRun: RunRecord,
    private readonly verificationRows: VerificationResultRecord[],
  ) {}

  async getRun(): Promise<RunRecord> { return this.currentRun; }
  async getRunFinalizationByVersion(): Promise<null> { return null; }
  async getRunEvaluationForAttempt(): Promise<null> { return null; }
  async listRunSteps(): Promise<never[]> { return []; }
  async listRunEvents(): Promise<never[]> { return []; }
  async listVerificationResults(): Promise<VerificationResultRecord[]> { return this.verificationRows; }
  async bridgeTaskEvaluationForRunEvaluation(): Promise<{ taskEvaluationId: null; skippedReason: string }> {
    return { taskEvaluationId: null, skippedReason: "no_task_run_link" };
  }
  async insertRunEvaluation(input: Omit<RunEvaluationRecord, "id" | "evaluator_type" | "evaluator_version" | "evidence_json" | "rule_trace_json" | "notes"> & {
    evidence_json: unknown;
    rule_trace_json: unknown;
    notes: string | null;
  }): Promise<RunEvaluationRecord> {
    return {
      ...input,
      id: "evaluation-1",
      evaluator_type: "deterministic_harness",
      evaluator_version: "harness_eval.v1",
    };
  }
  async insertRunFinalization(input: Partial<RunFinalizationRecord>): Promise<RunFinalizationRecord> {
    return {
      id: "finalization-1",
      space_id: "space-1",
      run_id: "run-1",
      attempt_number: 1,
      finalizer_version: "post_run_finalization.v1",
      status: "completed",
      run_evaluation_id: "evaluation-1",
      task_evaluation_id: null,
      outcome_status: input.outcome_status ?? null,
      failure_layer: input.failure_layer ?? null,
      failure_reason_code: input.failure_reason_code ?? null,
      trajectory_status: input.trajectory_status ?? null,
      skipped_reasons_json: [],
      error_json: null,
      metadata_json: null,
      finalized_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      settled_at: null,
      settlement_attempts: 0,
      settlement_json: {},
    };
  }

  readonly settlements: Array<{ completed: readonly string[]; failure: { key: string } | null }> = [];
  async recordRunSettlement(_spaceId: string, _finalizationId: string, input: { completed: readonly string[]; failure: { key: string } | null }): Promise<void> {
    this.settlements.push(input);
  }
  async withRunFinalizationLock<T>(
    _spaceId: string,
    _runId: string,
    _attemptNumber: number,
    _finalizerVersion: string,
    fn: (repository: PgRunRepository) => Promise<T>,
  ): Promise<T> {
    return fn(this as unknown as PgRunRepository);
  }
  async appendRunEvent(): Promise<null> { return null; }
}

describe("post-run verification outcome", () => {
  it("does not classify a successful adapter exit as passed after verification failure", async () => {
    const repository = new FinalizationRepository(
      run({ acceptance_criteria_json: { checks: [{ type: "output_schema" }] } }),
      [verification("failed")],
    );
    const finalization = await new PostRunFinalizationService(
      repository as unknown as PgRunRepository,
    ).finalize("run-1", "space-1");

    expect(finalization.outcome_status).toBe("failed");
    expect(finalization.failure_layer).toBe("validation");
    expect(finalization.failure_reason_code).toBe("verification_failed");
  });

  it("returns insufficient evidence when declared verification results are missing", async () => {
    const repository = new FinalizationRepository(
      run({ required_outputs_json: [{ type: "artifact_exists", title: "report" }] }),
      [],
    );
    const finalization = await new PostRunFinalizationService(
      repository as unknown as PgRunRepository,
    ).finalize("run-1", "space-1");

    expect(finalization.outcome_status).toBe("unknown");
    expect(finalization.trajectory_status).toBe("insufficient_evidence");
    expect(finalization.failure_reason_code).toBe("verification_missing");
  });

  it("commits the completion gate only once every settlement reconciler completed", async () => {
    const repository = new FinalizationRepository(run({}), []);
    const settled: string[] = [];
    await new PostRunFinalizationService(
      repository as unknown as PgRunRepository,
      undefined,
      undefined,
      undefined,
      {
        reconcilers: () => [
          { key: "plan_graph", settle: async (target) => { settled.push(`plan_graph:${target.id}`); } },
          { key: "project_work", settle: async (target) => { settled.push(`project_work:${target.id}`); } },
        ],
      },
    ).finalize("run-1", "space-1");
    expect(settled).toEqual(["plan_graph:run-1", "project_work:run-1"]);
    expect(repository.settlements).toEqual([{ completed: ["plan_graph", "project_work"], failure: null, at: expect.any(String) }]);
  });

  it("leaves settlement owed when a reconciler fails, still running the others", async () => {
    const repository = new FinalizationRepository(run({}), []);
    const settled: string[] = [];
    await expect(new PostRunFinalizationService(
      repository as unknown as PgRunRepository,
      undefined,
      undefined,
      undefined,
      {
        reconcilers: () => [
          { key: "plan_graph", settle: async () => { throw Object.assign(new Error("deadlock"), { code: "40P01" }); } },
          { key: "project_work", settle: async () => { settled.push("project_work"); } },
        ],
      },
    ).finalize("run-1", "space-1")).rejects.toBeInstanceOf(RunSettlementPendingError);
    expect(settled).toEqual(["project_work"]);
    expect(repository.settlements).toEqual([{
      completed: ["project_work"],
      failure: { key: "plan_graph", error_code: "40P01", message: "deadlock" },
      at: expect.any(String),
    }]);
  });
});
