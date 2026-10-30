import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CustomSourcePolicyEnvelope,
  CustomSourcePolicyLimits,
} from "@rainver/protocol";

type SourceExecutionBlockReason =
  | "handler_language_removed"
  | "runner_disabled"
  | "language_not_allowed"
  | "browser_automation_requested"
  | "shell_requested"
  | "dependency_installation_requested";

export interface SourceExecutionBlockedResult {
  status: "blocked";
  reason: SourceExecutionBlockReason;
}

export interface SourceExecutionCompletedResult {
  status: "completed";
  exit_code: number | null;
  timed_out: boolean;
  /** Redacted, byte-capped interpreter diagnostics. */
  logs: string;
  logs_truncated: boolean;
  /** Serialized interpreter output, or null on failure or byte-limit rejection. Validate the contract before any Source write. */
  raw_output_json: string | null;
  /** Serialized output exceeds the effective byte limit; raw_output_json is null. */
  output_too_large: boolean;
  /** Temporary snapshot files directory. The validator/materializer checks declared paths; the caller cleans it with cleanupSourceExecutionFiles. */
  sandbox_files_root: string;
}

export type SourceExecutionResult = SourceExecutionBlockedResult | SourceExecutionCompletedResult;

export interface SourceExecutionSettings {
  runner_enabled: boolean;
  allowed_languages: string[];
  network_hard_deny_rules: string[];
  timeout_ms_max: number;
  output_bytes_max: number;
  download_bytes_max: number;
  log_bytes_max: number;
  max_files: number;
  browser_automation_available: boolean;
  shell_available: boolean;
  dependency_installation_available: boolean;
}

export function evaluateCustomSourceExecutionBlockReason(
  settings: SourceExecutionSettings,
  policyEnvelope: CustomSourcePolicyEnvelope,
): SourceExecutionBlockReason | null {
  if (!settings.runner_enabled) return "runner_disabled";
  if (!settings.allowed_languages.includes(policyEnvelope.language)) return "language_not_allowed";
  // Browser automation, shell, and dependency installation stay disabled
  // unconditionally. Instance availability flags do not turn them on.
  if (policyEnvelope.browser_automation_enabled) return "browser_automation_requested";
  if (policyEnvelope.shell_enabled) return "shell_requested";
  if (policyEnvelope.dependency_installation_enabled) return "dependency_installation_requested";
  // Handler APIs support only reviewed declarative steps. Isolated Goal code
  // has a separate Host admission and never dispatches through this gate.
  if (policyEnvelope.language !== "declarative_pipeline_v1") return "handler_language_removed";
  return null;
}

/**
 * Instance hard limits always win over a handler version's policy envelope.
 * A handler version cannot request a timeout, log, output, download, or file
 * budget beyond what the instance allows.
 */
export function effectiveSourceExecutionLimits(
  settings: SourceExecutionSettings,
  policyLimits: CustomSourcePolicyLimits,
): CustomSourcePolicyLimits {
  return {
    ...policyLimits,
    timeout_ms: Math.min(policyLimits.timeout_ms, settings.timeout_ms_max),
    log_max_bytes: Math.min(policyLimits.log_max_bytes, settings.log_bytes_max),
    max_output_bytes: Math.min(policyLimits.max_output_bytes, settings.output_bytes_max),
    max_download_bytes: Math.min(policyLimits.max_download_bytes, settings.download_bytes_max),
    max_files: Math.min(policyLimits.max_files, settings.max_files),
  };
}

export async function cleanupSourceExecutionFiles(sandboxFilesRoot: string): Promise<void> {
  // sandbox_files_root is <sandboxRoot>/files; remove the parent sandbox dir.
  const sandboxRoot = resolve(sandboxFilesRoot, "..");
  await rm(sandboxRoot, { recursive: true, force: true });
}
