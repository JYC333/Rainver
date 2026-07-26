import { describe, expect, it } from "vitest";
import type { QueryResult, Queryable, RunRecord } from "../src/modules/runs/repository";
import {
  buildRunFinalizationRules,
  EvolutionSignalEmitter,
  proposalSignalType,
} from "../src/modules/evolution/signalEmitters";

class FakeDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  constructor(private readonly targetId: string | null = "target-1") {}

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push({ sql, params });
    if (sql.includes("FROM evolution_selector_decisions") || sql.includes("FROM (")) {
      return { rows: this.targetId ? [{ target_id: this.targetId } as Row] : [], rowCount: this.targetId ? 1 : 0 };
    }
    return { rows: [{ id: "signal-1" } as Row], rowCount: 1 };
  }
}

class AutoTargetDb extends FakeDb {
  override async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
    if (sql.includes("FROM evolution_selector_decisions")) {
      this.calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("WITH lock") && params.length === 11) {
      this.calls.push({ sql, params });
      return { rows: [{ id: "target-auto" } as Row], rowCount: 1 };
    }
    return super.query(sql, params);
  }
}

describe("EvolutionSignalEmitter", () => {
  it("emits finalization, cost, and latency rules from existing run facts", async () => {
    const db = new FakeDb();
    const emitter = new EvolutionSignalEmitter(db, () => new Date("2026-07-11T00:00:00.000Z"));
    const result = await emitter.emitRunFinalization({
      run: run({
        status: "failed",
        started_at: "2026-07-10T23:59:50.000Z",
        ended_at: "2026-07-11T00:00:00.000Z",
        contract_snapshot_json: { max_cost: 10, max_duration_seconds: 10 },
      }),
      estimated_cost_usd: 8,
      evaluation: {
        id: "evaluation-1",
        outcome_status: "failed",
        failure_layer: "runtime",
        failure_reason_code: "adapter_runtime_error",
        trajectory_status: "incomplete",
      },
    });

    expect(result).toEqual({ emitted: 3, skipped: 0, target_found: true });
    expect(db.calls).toHaveLength(4);
    expect(db.calls.slice(1).every((call) => call.sql.includes("pg_advisory_xact_lock") && call.sql.includes("NOT EXISTS"))).toBe(true);
    expect(db.calls.slice(1).map((call) => call.params[4])).toEqual([
      "run_finalization_failed",
      "run_cost_threshold",
      "run_latency_threshold",
    ]);
  });

  it("deduplicates repeat finalization rules through the same source window", () => {
    const rules = buildRunFinalizationRules({
      run: run({ status: "succeeded" }),
      evaluation: { outcome_status: "passed" },
      repeated: true,
    }, "target-1");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      signalType: "run_finalization_repeated",
      sourceType: "run",
      sourceId: "run-1",
      dedupWindowSeconds: 3600,
    });
  });

  it("emits a verification signal from finalized verification facts", () => {
    const rules = buildRunFinalizationRules({
      run: run({ status: "succeeded" }),
      evaluation: { outcome_status: "failed", id: "evaluation-1" },
      verification: {
        status: "failed",
        failed: 1,
        errors: 0,
        skipped: 0,
        results: [{ verifier_type: "output_schema", status: "failed", summary: "Missing answer." }],
      },
    }, "target-1");
    expect(rules.map((rule) => rule.signalType)).toEqual([
      "run_finalization_failed",
      "verification_failed",
    ]);
    expect(rules[1]).toMatchObject({ sourceType: "verification", sourceId: "run-1" });
  });

  it("does not write an orphan signal when the run has no evolution target", async () => {
    const db = new FakeDb(null);
    const result = await new EvolutionSignalEmitter(db).emitRunFinalization({
      run: run({ status: "failed" }),
      evaluation: { outcome_status: "failed" },
    });
    expect(result).toEqual({ emitted: 0, skipped: 0, target_found: false });
    expect(db.calls).toHaveLength(1);
  });

  it("emits a proposal rejection against its evolution target", async () => {
    const db = new FakeDb();
    const result = await new EvolutionSignalEmitter(db).emitProposalDecision({
      spaceId: "space-1",
      proposalId: "proposal-1",
      status: "rejected",
      proposalType: "capability_update",
      createdByRunId: "run-1",
    });
    expect(result).toEqual({ emitted: 1, skipped: 0, target_found: true });
    expect(db.calls[1]?.params[4]).toBe("proposal_rejected");
  });

  it("boundedly provisions a task target when an ordinary run fails", async () => {
    const db = new AutoTargetDb();
    const result = await new EvolutionSignalEmitter(db).emitRunFinalization({
      run: run({
        status: "failed",
        contract_snapshot_json: {
          source: { kind: "task", id: "task-1" },
          risk_level: "high",
        },
      }),
      evaluation: { outcome_status: "failed", failure_reason_code: "adapter_runtime_error" },
    });
    expect(result).toEqual({ emitted: 1, skipped: 0, target_found: true });
    expect(db.calls[1]?.sql).toContain("INSERT INTO evolution_targets");
    expect(db.calls[1]?.params.slice(1, 6)).toEqual([
      "space-1",
      "project_folder",
      "task",
      "task-1",
      "",
    ]);
    expect(db.calls[2]?.params[4]).toBe("run_finalization_failed");
  });

  it.each([
    [{ kind: "workflow", id: "workflow-1" }, "workflow", "workflow_asset", "workflow-1"],
    [{ kind: "automation", id: "automation-1" }, "project_folder", "automation", "automation-1"],
  ] as const)("maps %s failures to a bounded source target", async (source, targetType, refType, refId) => {
    const db = new AutoTargetDb();
    await new EvolutionSignalEmitter(db).emitRunFinalization({
      run: run({
        capability_id: "capability-ignored-for-source-kind",
        contract_snapshot_json: { source, risk_level: "low" },
        status: "failed",
      }),
      evaluation: { outcome_status: "failed" },
    });
    expect(db.calls[1]?.params.slice(1, 6)).toEqual(["space-1", targetType, refType, refId, ""]);
  });

  it("exposes the future verification, supervisor, and conformance signal paths", async () => {
    const db = new FakeDb();
    const emitter = new EvolutionSignalEmitter(db);
    await emitter.emitVerificationFailure({
      spaceId: "space-1",
      targetId: "target-1",
      sourceId: "verification-1",
      summary: "Acceptance check failed.",
    });
    await emitter.emitSupervisorOutcome({
      spaceId: "space-1",
      targetId: "target-1",
      sourceId: "supervisor-1",
      outcome: "retry_exhausted",
      summary: "Retry budget exhausted.",
    });
    await emitter.emitConformanceViolation({
      spaceId: "space-1",
      targetId: "target-1",
      sourceId: "conformance-1",
      runtimeType: "codex_cli",
      violation: "credential_leakage",
      summary: "Credential-like text appeared in output.",
    });
    expect(db.calls).toHaveLength(3);
    expect(db.calls.map((call) => call.params[4])).toEqual([
      "verification_failed",
      "supervisor_outcome",
      "runtime_conformance_violation",
    ]);
  });

  it("maps both current rejection and future request-changes decisions", () => {
    expect(proposalSignalType("rejected")).toBe("proposal_rejected");
    expect(proposalSignalType("request_changes")).toBe("proposal_request_changes");
    expect(proposalSignalType("changes_requested")).toBe("proposal_request_changes");
    expect(proposalSignalType("accepted")).toBeNull();
  });
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    status: "succeeded",
    mode: "execute",
    prompt: "prompt",
    instruction: null,
    project_folder_id: null,
    session_id: null,
    project_id: null,
    adapter_type: "model_api",
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "http",
    started_at: null,
    ended_at: null,
    ...overrides,
  };
}
