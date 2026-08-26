import { randomUUID } from "node:crypto";
import { BUILTIN_RUNTIME_ADAPTER_SPECS, getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import type { Queryable } from "../routeUtils/common.js";
import { EvolutionSignalEmitter } from "../evolution/signalEmitters.js";

export const CONFORMANCE_SUITE_VERSION = "runtime_conformance.v1";
export const CONFORMANCE_CHECKS = [
  "file_scope_obedience",
  "subagent_attempt_detection",
  "cancel_reliability",
  "structured_output_compliance",
  "credential_leakage",
] as const;

export type ConformanceCheck = typeof CONFORMANCE_CHECKS[number];
export type ConformanceStatus = "passed" | "failed" | "partial";
export type ConformanceTrustLevel = "low" | "medium" | "high";

export interface ConformanceCheckObservation {
  passed: boolean;
  evidence?: Record<string, unknown>;
}

export interface ConformanceProbeContext {
  runtime_adapter_type: string;
  runtime_version: string;
  suite_version: string;
}

export interface ConformanceProbeRunner {
  runCheck(
    check: ConformanceCheck,
    context: ConformanceProbeContext,
  ): Promise<ConformanceCheckObservation>;
}

export interface ConformanceResult {
  id: string;
  runtime_adapter_type: string;
  runtime_version: string;
  suite_version: string;
  status: ConformanceStatus;
  trust_level: ConformanceTrustLevel;
  passed_checks: number;
  failed_checks: number;
  checks: Record<string, ConformanceCheckObservation>;
  evidence: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class RuntimeConformanceService {
  constructor(
    private readonly db: Queryable,
    private readonly signalEmitter: EvolutionSignalEmitter | null = new EvolutionSignalEmitter(db),
  ) {}

  async run(input: {
    space_id?: string | null;
    runtime_adapter_type: string;
    runtime_version: string;
    runner: ConformanceProbeRunner;
  }): Promise<ConformanceResult> {
    const spec = getLocalCliRuntimeAdapterSpec(input.runtime_adapter_type);
    if (!spec || spec.implementation_status !== "implemented") {
      throw new Error(`Runtime '${input.runtime_adapter_type}' is not an implemented local CLI adapter`);
    }
    const context: ConformanceProbeContext = {
      runtime_adapter_type: input.runtime_adapter_type,
      runtime_version: input.runtime_version,
      suite_version: CONFORMANCE_SUITE_VERSION,
    };
    const checks: Record<string, ConformanceCheckObservation> = {};
    for (const check of CONFORMANCE_CHECKS) {
      try {
        checks[check] = await input.runner.runCheck(check, context);
      } catch (error) {
        checks[check] = {
          passed: false,
          evidence: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    return this.persist({
      space_id: input.space_id ?? null,
      runtime_adapter_type: input.runtime_adapter_type,
      runtime_version: input.runtime_version,
      checks,
      declared_trust_level: spec.baseline_trust_level,
    });
  }

  async record(input: {
    space_id?: string | null;
    runtime_adapter_type: string;
    runtime_version: string;
    checks: Partial<Record<ConformanceCheck, ConformanceCheckObservation>>;
  }): Promise<ConformanceResult> {
    const spec = BUILTIN_RUNTIME_ADAPTER_SPECS[input.runtime_adapter_type as keyof typeof BUILTIN_RUNTIME_ADAPTER_SPECS];
    if (!spec || spec.runtime_kind !== "local_cli") {
      throw new Error(`Runtime '${input.runtime_adapter_type}' is not a local CLI adapter`);
    }
    const checks = Object.fromEntries(CONFORMANCE_CHECKS.map((check) => [
      check,
      input.checks[check] ?? { passed: false, evidence: { reason: "check_not_recorded" } },
    ])) as Record<ConformanceCheck, ConformanceCheckObservation>;
    return this.persist({
      space_id: input.space_id ?? null,
      runtime_adapter_type: input.runtime_adapter_type,
      runtime_version: input.runtime_version,
      checks,
      declared_trust_level: spec.baseline_trust_level,
    });
  }

  async list(runtimeAdapterType?: string | null): Promise<ConformanceResult[]> {
    const params: unknown[] = [];
    const where = runtimeAdapterType ? "WHERE runtime_adapter_type = $1" : "";
    if (runtimeAdapterType) params.push(runtimeAdapterType);
    const result = await this.db.query<ConformanceRow>(
      `SELECT id, runtime_adapter_type, runtime_version, suite_version, status,
              trust_level, passed_checks, failed_checks, checks_json, evidence_json,
              created_at, updated_at
         FROM runtime_conformance_results
        ${where}
        ORDER BY runtime_adapter_type ASC, runtime_version DESC`,
      params,
    );
    return result.rows.map(toResult);
  }

  private async persist(input: {
    space_id: string | null;
    runtime_adapter_type: string;
    runtime_version: string;
    checks: Record<string, ConformanceCheckObservation>;
    declared_trust_level: ConformanceTrustLevel;
  }): Promise<ConformanceResult> {
    const failedChecks = CONFORMANCE_CHECKS.filter((check) => input.checks[check]?.passed !== true).length;
    const passedChecks = CONFORMANCE_CHECKS.length - failedChecks;
    const status: ConformanceStatus = failedChecks === 0
      ? "passed"
      : passedChecks === 0
        ? "failed"
        : "partial";
    const now = new Date().toISOString();
    const id = randomUUID();
    const result = await this.db.query<ConformanceRow>(
      `INSERT INTO runtime_conformance_results (
         id, runtime_adapter_type, runtime_version, suite_version, status,
         trust_level, passed_checks, failed_checks, checks_json, evidence_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $11)
       ON CONFLICT (runtime_adapter_type, runtime_version)
       DO UPDATE SET suite_version = EXCLUDED.suite_version,
                     status = EXCLUDED.status,
                     trust_level = EXCLUDED.trust_level,
                     passed_checks = EXCLUDED.passed_checks,
                     failed_checks = EXCLUDED.failed_checks,
                     checks_json = EXCLUDED.checks_json,
                     evidence_json = EXCLUDED.evidence_json,
                     updated_at = EXCLUDED.updated_at
       RETURNING id, runtime_adapter_type, runtime_version, suite_version, status,
                 trust_level, passed_checks, failed_checks, checks_json, evidence_json,
                 created_at, updated_at`,
      [
        id,
        input.runtime_adapter_type,
        input.runtime_version,
        CONFORMANCE_SUITE_VERSION,
        status,
        status === "passed" ? input.declared_trust_level : "low",
        passedChecks,
        failedChecks,
        JSON.stringify(input.checks),
        JSON.stringify({ check_count: CONFORMANCE_CHECKS.length, recorded_at: now }),
        now,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Runtime conformance result was not returned after persistence");
    const persisted = toResult(row);
    if (persisted.status !== "passed" && input.space_id && this.signalEmitter) {
      await this.signalEmitter.emitConformanceViolationForRuntime({
        spaceId: input.space_id,
        sourceId: persisted.id,
        runtimeType: persisted.runtime_adapter_type,
        runtimeVersion: persisted.runtime_version,
        violation: failedCheckNames(input.checks).join(",") || "conformance_failed",
        summary: `Runtime '${persisted.runtime_adapter_type}' failed conformance checks.`,
        payload: {
          result_id: persisted.id,
          suite_version: persisted.suite_version,
          failed_checks: persisted.failed_checks,
          checks: input.checks,
        },
      }).catch(() => undefined);
    }
    return persisted;
  }
}

interface ConformanceRow {
  id: string;
  runtime_adapter_type: string;
  runtime_version: string;
  suite_version: string;
  status: string;
  trust_level: string;
  passed_checks: number;
  failed_checks: number;
  checks_json: unknown;
  evidence_json: unknown;
  created_at: string;
  updated_at: string;
}

function toResult(row: ConformanceRow): ConformanceResult {
  return {
    id: row.id,
    runtime_adapter_type: row.runtime_adapter_type,
    runtime_version: row.runtime_version,
    suite_version: row.suite_version,
    status: row.status as ConformanceStatus,
    trust_level: row.trust_level as ConformanceTrustLevel,
    passed_checks: Number(row.passed_checks),
    failed_checks: Number(row.failed_checks),
    checks: objectValue(row.checks_json) as Record<string, ConformanceCheckObservation>,
    evidence: objectValue(row.evidence_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function failedCheckNames(checks: Record<string, ConformanceCheckObservation>): string[] {
  return Object.entries(checks)
    .filter(([, observation]) => observation.passed !== true)
    .map(([name]) => name);
}
