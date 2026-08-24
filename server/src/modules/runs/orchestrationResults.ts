import type {
  CanonicalRunOutput,
  RunAdapterResultEnvelope,
  RunInputEnvelope,
  RunMaterializationItemSummary,
  RunStatus,
  RunTerminalStatus,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  redactEvidenceText,
  sanitizeEvidenceJson,
} from "./evidenceRedaction";
import { RunPreparationError } from "./orchestrationErrors";
import type { RunRecord } from "./repository";

interface PreparedRuntimeInput {
  prompt: string | null;
  sandbox_cwd: string | null;
  context_text: string | null;
  adapter_config: Record<string, unknown>;
  risk_level: string | null;
  run_input: RunInputEnvelope;
}

export function terminalStatusFromAdapter(result: RunAdapterResultEnvelope): RunTerminalStatus {
  if (result.success) return "succeeded";
  if (result.error_code === "run_cancelled") return "cancelled";
  return "failed";
}

/**
 * A managed Run keeps going when one of its server-owned tools cannot be used —
 * the tool call returns `ok: false` and the model answers without it. The
 * summaries record that, but a terminal `succeeded` would make an answer
 * produced without a tool indistinguishable from one produced with it, which
 * matters most exactly when nobody is reading the Run. Report the failed tools
 * so the caller can settle the Run as `degraded` instead.
 *
 * This reads the family-neutral key every managed tool loop writes. It must
 * keep matching what `managedToolLoop.ts` emits: a delegation or proposal tool
 * failing is the same kind of evidence as a retrieval tool failing, and the
 * Always-on gate depends on all of them being visible here.
 */
export function managedToolDegradation(
  result: RunAdapterResultEnvelope,
): { tool_names: string[]; error_codes: string[] } | null {
  const metadata = recordValue(result.metadata_json);
  const failed = ["managed_tool_calls"]
    .flatMap((key) => (Array.isArray(metadata[key]) ? metadata[key] as unknown[] : []))
    .map((call) => recordValue(call))
    .filter((call) => call.ok === false);
  if (failed.length === 0) return null;
  const unique = (values: unknown[]) =>
    [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
  return {
    tool_names: unique(failed.map((call) => call.tool_name)),
    error_codes: unique(failed.map((call) => call.error_code)),
  };
}

export function adapterErrorJson(result: RunAdapterResultEnvelope): unknown {
  if (result.success) return {};
  const output = recordValue(result.output_json);
  const diagnostics = recordValue(output.structured_output_diagnostics);
  return sanitizeEvidenceJson({
    error_code: result.error_code ?? "adapter_failed",
    error_text: result.error_message ?? "Runtime adapter failed.",
    adapter_type: result.adapter_type,
    adapter_kind: result.adapter_kind,
    exit_code: result.exit_code,
    ...(Object.keys(diagnostics).length > 0
      ? { structured_output_diagnostics: diagnostics }
      : {}),
  });
}

export interface SemanticRunFailure {
  error_code:
    | "semantic_rejection"
    | "verification_failed"
    | "usage_recording_failed";
  error_message: string;
}

export function semanticRunFailure(
  result: RunAdapterResultEnvelope,
  verificationResults: readonly { status: string }[],
): SemanticRunFailure | null {
  if (!result.success) return null;
  const output = recordValue(result.output_json);
  if (output.status === "rejected") {
    return {
      error_code: "semantic_rejection",
      error_message: "Agent reported that it could not complete the requested work.",
    };
  }
  if (verificationResults.some(
    (verification) => verification.status === "failed" || verification.status === "error",
  )) {
    return {
      error_code: "verification_failed",
      error_message: "Run output did not satisfy its deterministic acceptance checks.",
    };
  }
  return null;
}

export function semanticFailureErrorJson(
  result: RunAdapterResultEnvelope,
  failure: SemanticRunFailure | null,
): unknown {
  return failure
    ? sanitizeEvidenceJson({
        error_code: failure.error_code,
        error_text: failure.error_message,
        adapter_type: result.adapter_type,
        adapter_kind: result.adapter_kind,
        exit_code: result.exit_code,
      })
    : adapterErrorJson(result);
}

export function outputJsonWithMaterialization(
  outputJson: unknown,
  items: RunMaterializationItemSummary[],
  errors: string[],
): unknown {
  const output = recordValue(outputJson);
  if (items.length > 0) output.materialization = sanitizeEvidenceJson(items);
  if (errors.length > 0) output.materialization_errors = errors.map((error) => redactEvidenceText(error));
  return sanitizeEvidenceJson(output);
}

export function canonicalRunOutput(input: {
  success: boolean;
  outputText: string;
  outputJson: unknown;
}): CanonicalRunOutput {
  const output = recordValue(input.outputJson);
  const manifest = normalizeOutputManifest(output.output_manifest);
  const { output_manifest: _manifest, ...result } = output;
  const semanticStatus = output.status === "rejected" ? "rejected" : input.success ? "succeeded" : "failed";
  return {
    schema_version: "run_output.v1",
    status: semanticStatus,
    summary: redactEvidenceText(input.outputText) ?? "",
    result: sanitizeEvidenceJson(result) as CanonicalRunOutput["result"],
    output_manifest: manifest,
  };
}

export function runOutputResult(value: unknown): Record<string, unknown> {
  const output = recordValue(value);
  return output.schema_version === "run_output.v1"
    ? recordValue(output.result)
    : {};
}

function normalizeOutputManifest(value: unknown): CanonicalRunOutput["output_manifest"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordValue(item);
    const name = stringValue(record.name ?? record.path);
    const status = stringValue(record.status);
    if (
      !name ||
      !["valid", "missing", "invalid", "oversized", "undeclared"].includes(status ?? "")
    ) return [];
    return [{
      name,
      status: status as CanonicalRunOutput["output_manifest"][number]["status"],
      artifact_id: stringValue(record.artifact_id),
      media_type: stringValue(record.media_type),
      size_bytes: typeof record.size_bytes === "number" &&
        Number.isInteger(record.size_bytes) &&
        record.size_bytes >= 0
        ? record.size_bytes
        : null,
      validation_errors: Array.isArray(record.validation_errors)
        ? record.validation_errors.flatMap((error) => {
            const text = stringValue(error);
            return text ? [text] : [];
          })
        : [],
    }];
  });
}

export function waitingForDependencyFromAdapter(
  result: RunAdapterResultEnvelope,
): Record<string, unknown> | null {
  if (!result.success) return null;
  const waiting = recordValue(recordValue(result.output_json).waiting_for_results);
  if (waiting.status !== "waiting") return null;
  const dependsOnRunIds = stringArrayValue(waiting.depends_on_run_ids);
  if (dependsOnRunIds.length === 0) return null;
  return sanitizeEvidenceJson({
    ...waiting,
    status: "waiting",
    depends_on_run_ids: dependsOnRunIds,
    pending_run_ids: stringArrayValue(waiting.pending_run_ids),
  }) as Record<string, unknown>;
}

export function materializationEventStatus(
  item: RunMaterializationItemSummary,
): "succeeded" | "failed" | "warning" | "skipped" {
  if (item.status === "succeeded") return "succeeded";
  if (item.status === "skipped") return "skipped";
  if (item.status === "warning") return "warning";
  return "failed";
}

export function adapterFailureEnvelope(
  run: RunRecord,
  errorCode: string,
  message: string,
): RunAdapterResultEnvelope {
  const now = new Date().toISOString();
  return {
    adapter_type: run.adapter_type ?? "unknown",
    adapter_kind: "custom",
    success: false,
    output_text: "",
    output_json: { adapter_type: run.adapter_type ?? "unknown" },
    exit_code: 1,
    error_code: errorCode,
    error_message: redactEvidenceText(message),
    started_at: now,
    completed_at: now,
    usage: null,
    metadata_json: {
      adapter_type: run.adapter_type ?? "unknown",
    },
  };
}

export function adapterTimeoutEnvelope(
  run: RunRecord,
  timeoutMs: number,
): RunAdapterResultEnvelope {
  const now = new Date().toISOString();
  return {
    adapter_type: run.adapter_type ?? "unknown",
    adapter_kind: run.adapter_type === "claude_code" || run.adapter_type === "codex_cli" || run.adapter_type === "opencode"
      ? "local_cli"
      : "managed_api",
    success: false,
    output_text: "",
    output_json: { adapter_type: run.adapter_type ?? "unknown" },
    exit_code: 1,
    error_code: "adapter_timeout",
    error_message: `Runtime adapter timed out after ${timeoutMs}ms.`,
    started_at: now,
    completed_at: now,
    usage: null,
    metadata_json: {
      adapter_type: run.adapter_type ?? "unknown",
      timeout_ms: timeoutMs,
    },
  };
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      resolveValue(timeoutValue);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function inputWithPreparedRuntime<T extends {
  prompt?: string | null;
  sandbox_cwd?: string | null;
  context_text?: string | null;
  adapter_config?: Record<string, unknown>;
  risk_level?: string | null;
  run_input?: RunInputEnvelope;
}>(
  input: T,
  prepared: PreparedRuntimeInput,
): T {
  return {
    ...input,
    prompt: prepared.prompt,
    sandbox_cwd: prepared.sandbox_cwd,
    context_text: prepared.context_text,
    adapter_config: prepared.adapter_config,
    risk_level: prepared.risk_level ?? input.risk_level ?? null,
    run_input: prepared.run_input,
  };
}

export function toRunPreparationError(error: unknown, fallbackCode: string): RunPreparationError {
  if (error instanceof RunPreparationError) return error;
  const code = errorCodeValue(error) ?? fallbackCode;
  return new RunPreparationError(code, errorMessage(error));
}

export function errorCodeValue(error: unknown): string | null {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code ? code : null;
  }
  return null;
}

export function isTerminalRunStatus(status: string): status is RunTerminalStatus | "waiting_for_review" {
  return [
    "succeeded",
    "failed",
    "degraded",
    "cancelled",
    "orphaned",
    "waiting_for_review",
  ].includes(status);
}

/** Statuses a Run can never leave. Deliberately excludes `waiting_for_review`
 * and `cancelling` — both are cancellable/in-flight — so SQL that selects
 * "Runs still worth stopping" can be built from this list rather than a
 * hand-rolled copy that drifts. */
export const HARD_TERMINAL_RUN_STATUSES = ["succeeded", "failed", "degraded", "cancelled", "orphaned"] as const;

export function isHardTerminalRunStatus(status: string): status is RunTerminalStatus {
  return (HARD_TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function protocolRunStatus(status: string): RunStatus | "unknown" {
  if (
    [
      "queued",
      "running",
      "cancelling",
      "succeeded",
      "failed",
      "degraded",
      "cancelled",
      "orphaned",
      "waiting_for_review",
      "waiting_for_dependency",
    ].includes(status)
  ) {
    return status as RunStatus;
  }
  return "unknown";
}

export function summarizeOutput(value: string | undefined): string | null {
  if (!value) return null;
  return redactEvidenceText(value.length > 500 ? `${value.slice(0, 500)}...` : value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "run orchestration failed";
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0))];
}
