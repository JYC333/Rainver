export type RouteExecutionMode = "live" | "dry_run";
export type RouteRiskLevel = "low" | "medium" | "high" | "critical";
export type RouteTrustLevel = "low" | "medium" | "high";
export type SandboxLevel =
  | "none"
  | "dry_run"
  | "ephemeral"
  | "read_only"
  | "worktree"
  | "one_shot_docker";
export type RouteExecutionShape =
  | "conversational"
  | "structured_generation"
  | "agentic_files"
  | "code_execution";

export interface RouteHints {
  preferred_adapter_types: string[];
  execution_shape: RouteExecutionShape | null;
  preferred_runtime_profile_id: string | null;
  required_capabilities: string[];
  required_tools: string[];
  required_sandbox_level: SandboxLevel | null;
  execution_mode: RouteExecutionMode | null;
  minimum_trust_level: RouteTrustLevel | null;
  latency_budget_ms: number | null;
  cost_budget_usd: number | null;
  sources: string[];
}

export interface RouteRequest {
  adapter_types?: string[];
  runtime_profile_id?: string | null;
  runtime_profile_is_explicit?: boolean;
  excluded_runtime_profile_ids?: string[];
  fallback_runtime_profile_ids?: string[];
  required_capabilities?: string[];
  required_tools?: string[];
  required_sandbox_level: SandboxLevel;
  execution_mode: RouteExecutionMode;
  risk_level: RouteRiskLevel;
  workspace_available: boolean;
  hints?: RouteHints | null;
}

export interface RouteCandidate {
  runtime_profile_id: string;
  profile_name: string;
  adapter_type: string;
  model_provider_id: string | null;
  model_name: string | null;
  credential_profile_id: string | null;
  runtime_config_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
  credential_available: boolean;
  capabilities: string[];
  tools: string[];
  minimum_sandbox_level: SandboxLevel;
  /**
   * Mirrors `RuntimeAdapterSpec.sandbox.requires_file_access`: this runtime
   * *needs* a sandbox working directory to execute at all. Admission for
   * `agentic_files` / `code_execution` reads it because, across every adapter
   * declared today, needing a working directory and being able to act on files
   * coincide. A future adapter that can use a working directory without
   * requiring one would need its own capability field rather than a looser
   * reading of this one. Note the admission path also demands C3 evidence, and
   * `runtimeConformance/service.ts` refuses to record it for anything whose
   * `runtime_kind` is not `local_cli` — so a non-CLI file-access runtime fails
   * closed until that restriction is revisited.
   */
  requires_file_access: boolean;
  /** Whether this runtime needs a persistent workspace to execute at all. */
  requires_workspace_for_execution: boolean;
  supports_workspace: boolean;
  supports_one_shot_docker: boolean;
  supports_live: boolean;
  supports_dry_run: boolean;
  baseline_trust_level: RouteTrustLevel;
  effective_trust_level: RouteTrustLevel;
  conformance_status?: "passed" | "failed" | "partial" | null;
  conformance_suite_version?: string | null;
  subagent_disable_mechanism: "not_applicable" | "runtime_config" | "unsupported" | "unknown";
  estimated_cost_usd: number | null;
  estimated_latency_ms: number | null;
  historical_verification_pass_rate: number | null;
}

export interface RouteRejection {
  runtime_profile_id: string;
  adapter_type: string;
  reasons: string[];
}

export interface ScoredRouteCandidate {
  candidate: RouteCandidate;
  score: number;
  score_trace: Record<string, number>;
}

export interface RouteDecision {
  selected: ScoredRouteCandidate | null;
  candidates: ScoredRouteCandidate[];
  fallback_chain: string[];
  rejected: RouteRejection[];
  hints: RouteHints;
  reason: string;
}
