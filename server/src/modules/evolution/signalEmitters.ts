import { randomUUID } from "node:crypto";
import type { Queryable } from "../runs/repository";
import type { RunRecord } from "../runs/runRepositoryTypes";

export const SIGNAL_DEDUP_WINDOWS_SECONDS = {
  run: 60 * 60,
  proposal: 24 * 60 * 60,
  verification: 60 * 60,
  supervisor: 15 * 60,
  conformance: 24 * 60 * 60,
} as const;

export interface RunFinalizationSignalInput {
  run: RunRecord;
  estimated_cost_usd?: number | null;
  evaluation: {
    id?: string | null;
    outcome_status: string;
    failure_layer?: string | null;
    failure_reason_code?: string | null;
    trajectory_status?: string | null;
  };
  verification?: {
    status: "passed" | "failed" | "incomplete" | "not_required";
    failed: number;
    errors: number;
    skipped: number;
    results: Array<{
      verifier_type: string;
      status: string;
      summary: string | null;
    }>;
  };
  repeated?: boolean;
}

export interface ProposalDecisionSignalInput {
  spaceId: string;
  proposalId: string;
  status: string;
  proposalType?: string | null;
  createdByRunId?: string | null;
}

export interface VerificationFailureSignalInput {
  spaceId: string;
  targetId: string;
  sourceId: string;
  summary: string;
  payload?: Record<string, unknown>;
  severity?: SignalSeverity;
}

export interface SupervisorOutcomeSignalInput {
  spaceId: string;
  targetId: string;
  sourceId: string;
  outcome: string;
  summary: string;
  payload?: Record<string, unknown>;
  severity?: SignalSeverity;
}

export interface ConformanceViolationSignalInput {
  spaceId: string;
  targetId: string;
  sourceId: string;
  runtimeType: string;
  violation: string;
  summary: string;
  payload?: Record<string, unknown>;
  severity?: SignalSeverity;
}

export type SignalSeverity = "info" | "warning" | "error" | "critical";

interface SignalRule {
  spaceId: string;
  targetId: string;
  signalType: string;
  sourceType: string;
  sourceId: string;
  severity: SignalSeverity;
  summary: string;
  payload: Record<string, unknown>;
  dedupWindowSeconds: number;
}

export interface SignalEmissionResult {
  emitted: number;
  skipped: number;
  target_found: boolean;
}

interface AutoTargetDescriptor {
  targetType: "capability" | "workflow" | "project_folder";
  targetRefType: string;
  targetRefId: string;
  capabilityKey: string | null;
  targetName: string;
}

export class EvolutionSignalEmitter {
  constructor(
    private readonly db: Queryable,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Rebind the emitter to a caller-owned transaction without losing its
   * clock. Signal rows must share the supervisor/proposal transaction when
   * their source decision is still uncommitted.
   */
  forDatabase(db: Queryable): EvolutionSignalEmitter {
    return new EvolutionSignalEmitter(db, this.clock);
  }

  async emitRunFinalization(input: RunFinalizationSignalInput): Promise<SignalEmissionResult> {
    let targetId = await this.targetForRun(input.run.space_id, input.run.id);
    if (!targetId && hasRunSignalRule(input)) {
      targetId = await this.ensureTargetForRun(input.run);
    }
    if (!targetId) return emptyEmission(false);
    const rules = buildRunFinalizationRules(input, targetId);
    return this.emitRules(rules);
  }

  async emitProposalDecision(input: ProposalDecisionSignalInput): Promise<SignalEmissionResult> {
    const signalType = proposalSignalType(input.status);
    if (!signalType) return emptyEmission(true);
    const targetId = await this.targetForProposal(input.spaceId, input.proposalId, input.createdByRunId ?? null);
    if (!targetId) return emptyEmission(false);
    return this.emitRules([{
      spaceId: input.spaceId,
      targetId,
      signalType,
      sourceType: "proposal",
      sourceId: input.proposalId,
      severity: "warning",
      summary: `Proposal '${input.proposalId}' was ${input.status}.`,
      payload: {
        proposal_id: input.proposalId,
        proposal_type: input.proposalType ?? null,
        status: input.status,
      },
      dedupWindowSeconds: SIGNAL_DEDUP_WINDOWS_SECONDS.proposal,
    }]);
  }

  async emitVerificationFailure(input: VerificationFailureSignalInput): Promise<SignalEmissionResult> {
    return this.emitRules([{
      spaceId: input.spaceId,
      targetId: input.targetId,
      signalType: "verification_failed",
      sourceType: "verification",
      sourceId: input.sourceId,
      severity: input.severity ?? "error",
      summary: input.summary,
      payload: input.payload ?? {},
      dedupWindowSeconds: SIGNAL_DEDUP_WINDOWS_SECONDS.verification,
    }]);
  }

  async emitSupervisorOutcome(input: SupervisorOutcomeSignalInput): Promise<SignalEmissionResult> {
    return this.emitRules([{
      spaceId: input.spaceId,
      targetId: input.targetId,
      signalType: "supervisor_outcome",
      sourceType: "supervisor",
      sourceId: input.sourceId,
      severity: input.severity ?? supervisorSeverity(input.outcome),
      summary: input.summary,
      payload: { ...input.payload, outcome: input.outcome },
      dedupWindowSeconds: SIGNAL_DEDUP_WINDOWS_SECONDS.supervisor,
    }]);
  }

  async emitSupervisorOutcomeForRun(input: {
    run: RunRecord;
    sourceId: string;
    outcome: string;
    summary: string;
    payload?: Record<string, unknown>;
    severity?: SignalSeverity;
  }): Promise<SignalEmissionResult> {
    const targetId = await this.targetForRun(input.run.space_id, input.run.id)
      ?? await this.ensureTargetForRun(input.run);
    if (!targetId) return emptyEmission(false);
    return this.emitSupervisorOutcome({
      spaceId: input.run.space_id,
      targetId,
      sourceId: input.sourceId,
      outcome: input.outcome,
      summary: input.summary,
      payload: { run_id: input.run.id, ...input.payload },
      severity: input.severity,
    });
  }

  async emitConformanceViolation(input: ConformanceViolationSignalInput): Promise<SignalEmissionResult> {
    return this.emitRules([{
      spaceId: input.spaceId,
      targetId: input.targetId,
      signalType: "runtime_conformance_violation",
      sourceType: "conformance",
      sourceId: input.sourceId,
      severity: input.severity ?? "error",
      summary: input.summary,
      payload: { ...input.payload, runtime_type: input.runtimeType, violation: input.violation },
      dedupWindowSeconds: SIGNAL_DEDUP_WINDOWS_SECONDS.conformance,
    }]);
  }

  async emitConformanceViolationForRuntime(input: {
    sourceId: string;
    runtimeType: string;
    runtimeVersion: string;
    violation: string;
    summary: string;
    payload?: Record<string, unknown>;
    severity?: SignalSeverity;
    spaceId: string;
  }): Promise<SignalEmissionResult> {
    const targetId = await this.ensureTargetForRuntime(input.spaceId, input.runtimeType, input.runtimeVersion);
    if (!targetId) return emptyEmission(false);
    return this.emitConformanceViolation({
      spaceId: input.spaceId,
      targetId,
      sourceId: input.sourceId,
      runtimeType: input.runtimeType,
      violation: input.violation,
      summary: input.summary,
      payload: input.payload,
      severity: input.severity,
    });
  }

  private async targetForRun(spaceId: string, runId: string): Promise<string | null> {
    const result = await this.db.query<{ target_id: string | null }>(
      `SELECT d.target_id
         FROM evolution_selector_decisions d
         JOIN evolution_targets et ON et.id = d.target_id
        WHERE d.space_id = $1 AND d.run_id = $2
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 1`,
      [spaceId, runId],
    );
    return result.rows[0]?.target_id ?? null;
  }

  private async ensureTargetForRun(run: RunRecord): Promise<string | null> {
    const descriptor = autoTargetDescriptor(run);
    if (!descriptor) return null;
    const now = this.clock().toISOString();
    const riskLevel = runRiskLevel(run);
    const maxStrategyRisk = riskLevel === "low" ? "low" : "medium";
    const targetKey = [
      run.space_id,
      descriptor.targetType,
      descriptor.targetRefType,
      descriptor.targetRefId,
      descriptor.capabilityKey ?? "",
    ].join(":");
    const result = await this.db.query<{ id: string }>(
      `WITH lock AS (
         SELECT pg_advisory_xact_lock(hashtext($1)) AS acquired
       ), existing AS (
         SELECT id
           FROM evolution_targets
          WHERE space_id = $2
            AND target_type = $3
            AND target_ref_type = $4
            AND target_ref_id = $5
            AND COALESCE(capability_key, '') = $6
            AND status = 'active'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
       ), inserted AS (
         INSERT INTO evolution_targets (
           id, space_id, target_type, target_ref_type, target_ref_id,
           capability_key, current_version_id, risk_level, status, enabled,
           engine_policy_json, metadata_json, created_at, updated_at
         )
         SELECT $7, $2, $3, $4, $5, NULLIF($6, ''), NULL, $8, 'active', true,
                $9::jsonb, $10::jsonb, $11, $11
           FROM lock
          WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING id
       )
       SELECT id FROM existing
       UNION ALL
       SELECT id FROM inserted
       LIMIT 1`,
      [
        `evolution-target:${targetKey}`,
        run.space_id,
        descriptor.targetType,
        descriptor.targetRefType,
        descriptor.targetRefId,
        descriptor.capabilityKey ?? "",
        randomUUID(),
        riskLevel,
        JSON.stringify({
          source: "d1_auto_signal_target",
          max_strategy_risk: maxStrategyRisk,
          allowed_strategy_categories: ["repair", "harden", "review"],
          allow_no_signal: true,
        }),
        JSON.stringify({
          target_name: descriptor.targetName,
          auto_provisioned: true,
          source_run_id: run.id,
          source_kind: recordValue(run.contract_snapshot_json).source &&
            recordValue(recordValue(run.contract_snapshot_json).source).kind,
        }),
        now,
      ],
    );
    return result.rows[0]?.id ?? null;
  }

  private async targetForProposal(
    spaceId: string,
    proposalId: string,
    createdByRunId: string | null,
  ): Promise<string | null> {
    const result = await this.db.query<{ target_id: string | null }>(
      `SELECT target_id
         FROM (
           SELECT d.target_id, d.created_at, d.id
             FROM evolution_selector_decisions d
            WHERE d.space_id = $1
              AND ($3::varchar IS NOT NULL AND d.run_id = $3)
           UNION ALL
           SELECT et.id AS target_id, et.created_at, et.id
             FROM evolution_targets et
            WHERE et.space_id = $1
              AND et.target_ref_type = 'proposal'
              AND et.target_ref_id = $2
         ) candidates
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [spaceId, proposalId, createdByRunId],
    );
    return result.rows[0]?.target_id ?? null;
  }

  private async ensureTargetForRuntime(spaceId: string, runtimeType: string, runtimeVersion: string): Promise<string | null> {
    const now = this.clock().toISOString();
    const result = await this.db.query<{ id: string }>(
      `WITH lock AS (
         SELECT pg_advisory_xact_lock(hashtext($1)) AS acquired
       ), existing AS (
         SELECT id FROM evolution_targets
          WHERE space_id = $2 AND target_type = 'project_folder'
            AND target_ref_type = 'runtime_adapter' AND target_ref_id = $3
            AND status = 'active'
          ORDER BY created_at ASC, id ASC LIMIT 1
       ), inserted AS (
         INSERT INTO evolution_targets (
           id, space_id, target_type, target_ref_type, target_ref_id,
           capability_key, current_version_id, risk_level, status, enabled,
           engine_policy_json, metadata_json, created_at, updated_at
         )
         SELECT $4, $2, 'project_folder', 'runtime_adapter', $3,
                NULL, NULL, 'medium', 'active', true,
                '{"source":"d1_runtime_conformance"}'::jsonb,
                $5::jsonb, $6, $6 FROM lock
          WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING id
       )
       SELECT id FROM existing UNION ALL SELECT id FROM inserted LIMIT 1`,
      [
        `evolution-runtime-target:${spaceId}:${runtimeType}:${runtimeVersion}`,
        spaceId,
        `${runtimeType}:${runtimeVersion}`,
        randomUUID(),
        JSON.stringify({ target_name: `Runtime ${runtimeType} ${runtimeVersion}`, runtime_type: runtimeType, runtime_version: runtimeVersion, auto_provisioned: true }),
        now,
      ],
    );
    return result.rows[0]?.id ?? null;
  }

  private async emitRules(rules: SignalRule[]): Promise<SignalEmissionResult> {
    let emitted = 0;
    for (const rule of rules) {
      const payload = {
        ...rule.payload,
        dedup_key: dedupKey(rule),
      };
      const result = await this.db.query<{ id: string }>(
        `WITH lock AS (
           SELECT pg_advisory_xact_lock(hashtext($1)) AS acquired
         ), inserted AS (
           INSERT INTO evolution_signals (
             id, space_id, target_id, signal_type, source_type, source_id,
             severity, summary, payload_json, created_at
           )
           SELECT $2::varchar, $3::varchar, $4::varchar, $5::varchar,
                  $6::varchar, $7::varchar, $8::varchar, $9::text,
                  $10::jsonb, $11::timestamptz
             FROM lock
            WHERE NOT EXISTS (
              SELECT 1
                FROM evolution_signals
               WHERE target_id = $4::varchar
                 AND signal_type = $5::varchar
                 AND source_type = $6::varchar
                 AND source_id = $7::varchar
                 AND payload_json->>'dedup_key' = $12::text
                 AND created_at > $11::timestamptz - ($13::double precision * interval '1 second')
            )
           RETURNING id
         )
         SELECT id FROM inserted`,
        [
          dedupLockKey(rule),
          randomId(),
          rule.spaceId,
          rule.targetId,
          rule.signalType,
          rule.sourceType,
          rule.sourceId,
          rule.severity,
          rule.summary,
          JSON.stringify(payload),
          this.clock().toISOString(),
          payload.dedup_key,
          rule.dedupWindowSeconds,
        ],
      );
      if (result.rows.length > 0) emitted += 1;
    }
    return {
      emitted,
      skipped: rules.length - emitted,
      target_found: true,
    };
  }
}

export function buildRunFinalizationRules(
  input: RunFinalizationSignalInput,
  targetId: string,
): SignalRule[] {
  const rules: SignalRule[] = [];
  const sourceId = input.run.id;
  if (input.repeated) {
    rules.push({
      spaceId: input.run.space_id,
      targetId,
      signalType: "run_finalization_repeated",
      sourceType: "run",
      sourceId,
      severity: "info",
      summary: `Run '${sourceId}' was finalized more than once.`,
      payload: { run_id: sourceId, finalization_repeated: true },
      dedupWindowSeconds: SIGNAL_DEDUP_WINDOWS_SECONDS.run,
    });
  }

  if (isFailedFinalization(input)) {
    rules.push({
      spaceId: input.run.space_id,
      targetId,
      signalType: "run_finalization_failed",
      sourceType: "run",
      sourceId,
      severity: input.evaluation.outcome_status === "failed" ? "error" : "warning",
      summary: `Run '${sourceId}' finalized with outcome '${input.evaluation.outcome_status}'.`,
      payload: {
        run_id: sourceId,
        outcome_status: input.evaluation.outcome_status,
        failure_layer: input.evaluation.failure_layer ?? null,
        failure_reason_code: input.evaluation.failure_reason_code ?? null,
        trajectory_status: input.evaluation.trajectory_status ?? null,
        evaluation_id: input.evaluation.id ?? null,
      },
      dedupWindowSeconds: SIGNAL_DEDUP_WINDOWS_SECONDS.run,
    });
  }

  if (input.verification?.status === "failed") {
    rules.push({
      spaceId: input.run.space_id,
      targetId,
      signalType: "verification_failed",
      sourceType: "verification",
      sourceId,
      severity: "error",
      summary: `Run '${sourceId}' failed deterministic verification.`,
      payload: {
        run_id: sourceId,
        failed_count: input.verification.failed,
        error_count: input.verification.errors,
        skipped_count: input.verification.skipped,
        results: input.verification.results,
        evaluation_id: input.evaluation.id ?? null,
      },
      dedupWindowSeconds: SIGNAL_DEDUP_WINDOWS_SECONDS.verification,
    });
  }

  const contract = recordValue(input.run.contract_snapshot_json);
  const cost = numberValue(input.estimated_cost_usd);
  const maxCost = numberValue(contract.max_cost);
  if (cost !== null && maxCost !== null && maxCost > 0 && cost >= maxCost * 0.8) {
    rules.push(thresholdRule({
      spaceId: input.run.space_id,
      targetId,
      sourceId,
      signalType: "run_cost_threshold",
      metric: "cost_usd",
      observed: cost,
      threshold: maxCost,
      unit: "USD",
    }));
  }

  const durationSeconds = runDurationSeconds(input.run);
  const maxDuration = numberValue(contract.max_duration_seconds);
  if (durationSeconds !== null && maxDuration !== null && maxDuration > 0 && durationSeconds >= maxDuration * 0.8) {
    rules.push(thresholdRule({
      spaceId: input.run.space_id,
      targetId,
      sourceId,
      signalType: "run_latency_threshold",
      metric: "duration_seconds",
      observed: durationSeconds,
      threshold: maxDuration,
      unit: "seconds",
    }));
  }
  return rules;
}

export function proposalSignalType(status: string): "proposal_rejected" | "proposal_request_changes" | null {
  if (status === "rejected") return "proposal_rejected";
  if (status === "request_changes" || status === "changes_requested") return "proposal_request_changes";
  return null;
}

function isFailedFinalization(input: RunFinalizationSignalInput): boolean {
  return input.evaluation.outcome_status === "failed" || input.evaluation.outcome_status === "partial";
}

function hasRunSignalRule(input: RunFinalizationSignalInput): boolean {
  return buildRunFinalizationRules(input, "auto-target").length > 0;
}

function autoTargetDescriptor(run: RunRecord): AutoTargetDescriptor | null {
  const contract = recordValue(run.contract_snapshot_json);
  const source = recordValue(contract.source);
  const sourceKind = typeof source.kind === "string" ? source.kind : null;
  const sourceId = typeof source.id === "string" && source.id.length > 0 ? source.id : null;
  const routeHints = recordValue(contract.route_hints_json);
  if (sourceKind === "workflow" && sourceId) {
    return {
      targetType: "workflow",
      targetRefType: "workflow_asset",
      targetRefId: sourceId,
      capabilityKey: null,
      targetName: `Workflow ${sourceId}`,
    };
  }
  if (sourceKind === "automation" && sourceId) {
    return {
      targetType: "project_folder",
      targetRefType: "automation",
      targetRefId: sourceId,
      capabilityKey: null,
      targetName: `Automation ${sourceId}`,
    };
  }
  const capabilityKey = run.capability_id ?? stringValue(routeHints.capability_id);
  if (capabilityKey) {
    return {
      targetType: "capability",
      targetRefType: "capability",
      targetRefId: capabilityKey,
      capabilityKey,
      targetName: `Capability ${capabilityKey}`,
    };
  }
  if (sourceKind === "task" && sourceId) {
    return {
      targetType: "project_folder",
      targetRefType: "task",
      targetRefId: sourceId,
      capabilityKey: null,
      targetName: `Task ${sourceId}`,
    };
  }
  return null;
}

function runRiskLevel(run: RunRecord): "low" | "medium" | "high" | "critical" {
  const risk = stringValue(recordValue(run.contract_snapshot_json).risk_level);
  return risk === "low" || risk === "medium" || risk === "high" || risk === "critical"
    ? risk
    : "low";
}

function thresholdRule(input: {
  spaceId: string;
  targetId: string;
  sourceId: string;
  signalType: string;
  metric: string;
  observed: number;
  threshold: number;
  unit: string;
}): SignalRule {
  const exceeded = input.observed > input.threshold;
  return {
    spaceId: input.spaceId,
    targetId: input.targetId,
    signalType: input.signalType,
    sourceType: "run",
    sourceId: input.sourceId,
    severity: exceeded ? "error" : "warning",
    summary: `Run '${input.sourceId}' ${input.metric} reached ${input.observed} ${input.unit} against a ${input.threshold} ${input.unit} contract limit.`,
    payload: {
      run_id: input.sourceId,
      metric: input.metric,
      observed: input.observed,
      threshold: input.threshold,
      threshold_state: exceeded ? "exceeded" : "warning",
      unit: input.unit,
    },
    dedupWindowSeconds: SIGNAL_DEDUP_WINDOWS_SECONDS.run,
  };
}

function runDurationSeconds(run: RunRecord): number | null {
  if (!run.started_at || !run.ended_at) return null;
  const started = Date.parse(run.started_at);
  const ended = Date.parse(run.ended_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return (ended - started) / 1000;
}

function supervisorSeverity(outcome: string): SignalSeverity {
  if (outcome === "failed" || outcome === "retry_exhausted") return "error";
  if (outcome === "stalled" || outcome === "degraded") return "warning";
  return "info";
}

function dedupKey(rule: SignalRule): string {
  return [rule.signalType, rule.sourceType, rule.sourceId].join(":");
}

function dedupLockKey(rule: SignalRule): string {
  return `evolution-signal:${rule.targetId}:${dedupKey(rule)}`;
}

function emptyEmission(targetFound: boolean): SignalEmissionResult {
  return { emitted: 0, skipped: 0, target_found: targetFound };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function randomId(): string {
  return randomUUID();
}
