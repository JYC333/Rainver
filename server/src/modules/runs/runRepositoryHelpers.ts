import { isVendorCliAdapter } from "../runtimeAdapters/specs.js";
import {
  RunCreateValidationError,
  type RunCreateInput,
} from "./runRepositoryTypes.js";

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
  assertOneOf(input.trigger_origin, ["manual", "automation", "autonomous", "job", "system"], "trigger_origin");
}

/**
 * The floor a vendor CLI run starts from.
 *
 * A Folder-bound run baselines at `worktree` — "works in a working copy of the
 * repository" — not `read_only`. `read_only` was right only while the server
 * mounted the Folder read-only and provisioned a *separate* worktree for the
 * run's writes, to be reviewed as a code patch. That provisioning is gone
 * (ADR 0016): a run executes on a host daemon, against the registered Location,
 * and the Location **is** the working copy. Undo is git (ADR 0016 section 11).
 *
 * Left as `read_only`, the levels came out inverted on the built-in host: a
 * low-risk Folder-bound run could not write its own workspace, while a
 * high-risk one could, because only `read_only` narrows the bind. A run that
 * cannot write cannot do the work it was dispatched for, at any risk level.
 * A caller that genuinely wants a read-only run still asks for one; this is
 * the floor, not a ceiling.
 */
export function requiredSandboxLevelForRun(
  adapterType: string | null | undefined,
  projectFolderId: string | null | undefined,
): string {
  if (!isVendorCliAdapter(adapterType)) return "none";
  return projectFolderId ? "worktree" : "ephemeral";
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
