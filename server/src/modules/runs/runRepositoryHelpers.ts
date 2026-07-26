import { isVendorCliAdapter } from "../runtimeAdapters/specs";
import {
  RunCreateValidationError,
  type RunCreateInput,
} from "./runRepositoryTypes";

export function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function extractErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const message = record.error_message ?? record.error_text ?? record.message;
  return typeof message === "string" ? message : null;
}

export function addOptionalFilter(
  clauses: string[],
  params: unknown[],
  column: string,
  value: string | null | undefined,
): void {
  if (value == null || value === "") return;
  params.push(value);
  clauses.push(`${column} = $${params.length}`);
}

export function validateRunCreateInput(input: RunCreateInput): void {
  assertOneOf(input.mode, ["live", "dry_run"], "mode");
  assertOneOf(
    input.run_type,
    ["agent", "planning", "system", "workflow", "validation", "reflection", "export", "evolution"],
    "run_type",
  );
  assertOneOf(input.trigger_origin, ["manual", "automation", "job", "system"], "trigger_origin");
}

export function requiredSandboxLevelForRun(
  adapterType: string | null | undefined,
  projectFolderId: string | null | undefined,
): string {
  if (!isVendorCliAdapter(adapterType)) return "none";
  return projectFolderId ? "read_only" : "ephemeral";
}

/**
 * Resolve the effective sandbox after routing has selected the adapter.
 * Creation-time runs intentionally start at `none` because their adapter is
 * not known yet; this is the single policy boundary that turns that default
 * into a run-scope ephemeral directory or a workspace worktree.
 */
export function resolveSandboxLevelForRuntime(input: {
  adapterType: string | null | undefined;
  configuredLevel: string | null | undefined;
  riskLevel: string | null | undefined;
  projectFolderId: string | null | undefined;
}): string | null {
  if (
    isVendorCliAdapter(input.adapterType) &&
    typeof input.riskLevel === "string" &&
    input.riskLevel.trim().toLowerCase() === "critical"
  ) {
    return "one_shot_docker";
  }
  if (isVendorCliAdapter(input.adapterType)) {
    const configured = typeof input.configuredLevel === "string" ? input.configuredLevel.trim() : "";
    const risk = typeof input.riskLevel === "string"
      ? input.riskLevel.trim().toLowerCase()
      : "";
    const baseline = risk === "high"
      ? "worktree"
      : requiredSandboxLevelForRun(input.adapterType, input.projectFolderId);
    return sandboxRank(configured) > sandboxRank(baseline)
      ? configured
      : baseline;
  }
  return input.configuredLevel ?? null;
}

function sandboxRank(level: string): number {
  return {
    none: 0,
    dry_run: 1,
    ephemeral: 2,
    read_only: 3,
    worktree: 4,
    one_shot_docker: 5,
  }[level] ?? -1;
}

function assertOneOf(value: string, allowed: readonly string[], field: string): void {
  if (allowed.includes(value)) return;
  throw new RunCreateValidationError(
    `Invalid ${field} '${value}'. Must be one of: ${allowed.slice().sort().join(", ")}`,
  );
}
