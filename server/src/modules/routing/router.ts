import type {
  RouteCandidate,
  RouteDecision,
  RouteExecutionShape,
  RouteHints,
  RouteRejection,
  RouteRequest,
  RouteRiskLevel,
  RouteTrustLevel,
  SandboxLevel,
  ScoredRouteCandidate,
} from "./types";
import { isLocalCliRuntimeAdapter } from "../runtimeAdapters";

const TRUST_RANK: Record<RouteTrustLevel, number> = { low: 1, medium: 2, high: 3 };
const SANDBOX_RANK: Record<SandboxLevel, number> = {
  none: 0,
  dry_run: 1,
  ephemeral: 2,
  read_only: 3,
  worktree: 4,
  one_shot_docker: 5,
};

export const EMPTY_ROUTE_HINTS: RouteHints = {
  preferred_adapter_types: [],
  execution_shape: null,
  preferred_runtime_profile_id: null,
  required_capabilities: [],
  required_tools: [],
  required_sandbox_level: null,
  execution_mode: null,
  minimum_trust_level: null,
  latency_budget_ms: null,
  cost_budget_usd: null,
  sources: [],
};

export class DeterministicRouteSelector {
  select(request: RouteRequest, candidates: RouteCandidate[]): RouteDecision {
    const hints = request.hints ?? EMPTY_ROUTE_HINTS;
    const rejected: RouteRejection[] = [];
    const scored: ScoredRouteCandidate[] = [];
    for (const candidate of candidates) {
      const reasons = hardFilterReasons(request, hints, candidate);
      if (reasons.length > 0) {
        rejected.push({ runtime_profile_id: candidate.runtime_profile_id, adapter_type: candidate.adapter_type, reasons });
        continue;
      }
      const scoreTrace = scoreCandidate(request, hints, candidate);
      scored.push({ candidate, score: Object.values(scoreTrace).reduce((sum, value) => sum + value, 0), score_trace: scoreTrace });
    }
    scored.sort((left, right) =>
      right.score - left.score
      || (right.candidate.historical_verification_pass_rate ?? 0.5) - (left.candidate.historical_verification_pass_rate ?? 0.5)
      || left.candidate.runtime_profile_id.localeCompare(right.candidate.runtime_profile_id),
    );
    return {
      selected: scored[0] ?? null,
      candidates: scored,
      fallback_chain: scored.map((item) => item.candidate.runtime_profile_id),
      rejected,
      hints,
      reason: scored[0]
        ? `Selected ${scored[0].candidate.profile_name} using deterministic policy scoring.`
        : "No runtime candidate passed routing hard filters.",
    };
  }
}

export function mergeRouteHints(sources: Array<{ source: string; value: unknown }>): RouteHints {
  const result: RouteHints = { ...EMPTY_ROUTE_HINTS, preferred_adapter_types: [], required_capabilities: [], required_tools: [], sources: [] };
  for (const source of sources) {
    const value = record(source.value);
    result.sources.push(source.source);
    result.preferred_adapter_types = unique([...result.preferred_adapter_types, ...stringArray(value.preferred_adapter_types ?? value.preferred_adapters ?? value.recommended_runtime_adapters)]);
    result.execution_shape = executionShape(value.execution_shape) ?? result.execution_shape;
    result.required_capabilities = unique([...result.required_capabilities, ...stringArray(value.required_capabilities)]);
    result.required_tools = unique([...result.required_tools, ...stringArray(value.required_tools)]);
    result.preferred_runtime_profile_id = stringValue(value.preferred_runtime_profile_id) ?? result.preferred_runtime_profile_id;
    result.required_sandbox_level = sandboxValue(value.required_sandbox_level) ?? result.required_sandbox_level;
    result.execution_mode = executionMode(value.execution_mode) ?? result.execution_mode;
    result.minimum_trust_level = trustValue(value.minimum_trust_level) ?? result.minimum_trust_level;
    result.latency_budget_ms = finiteNumber(value.latency_budget_ms) ?? result.latency_budget_ms;
    result.cost_budget_usd = finiteNumber(value.cost_budget_usd) ?? result.cost_budget_usd;
  }
  return result;
}

function hardFilterReasons(request: RouteRequest, hints: RouteHints, candidate: RouteCandidate): string[] {
  const reasons: string[] = [];
  const requiredCapabilities = unique([...(request.required_capabilities ?? []), ...hints.required_capabilities]);
  const requiredTools = unique([...(request.required_tools ?? []), ...hints.required_tools]);
  if (!candidate.enabled) reasons.push("candidate_disabled");
  if (!candidate.credential_available) reasons.push("credential_unavailable");
  const localCli = isLocalCliRuntimeAdapter(candidate.adapter_type);
  const shape = hints.execution_shape;
  if (candidate.conformance_status === "failed" && localCli) {
    reasons.push("runtime_conformance_failed");
  }
  if (localCli && request.risk_level !== "low" && candidate.conformance_status !== "passed") {
    reasons.push("runtime_conformance_required");
  }
  if (
    candidate.adapter_type === "opencode" &&
    (shape === "agentic_files" || shape === "code_execution") &&
    candidate.conformance_status !== "passed"
  ) {
    reasons.push("runtime_conformance_required_for_execution_shape");
  }
  if (
    candidate.adapter_type === "model_api" &&
    (shape === "agentic_files" || shape === "code_execution")
  ) {
    reasons.push("execution_shape_incompatible");
  }
  if (request.excluded_runtime_profile_ids?.includes(candidate.runtime_profile_id)) {
    reasons.push("runtime_profile_excluded_for_retry");
  }
  if (
    request.fallback_runtime_profile_ids &&
    request.fallback_runtime_profile_ids.length > 0 &&
    !request.fallback_runtime_profile_ids.includes(candidate.runtime_profile_id)
  ) {
    reasons.push("runtime_profile_not_in_fallback_chain");
  }
  if (request.adapter_types && request.adapter_types.length > 0 && !request.adapter_types.includes(candidate.adapter_type)) reasons.push("adapter_not_requested");
  if (request.runtime_profile_is_explicit && request.runtime_profile_id !== candidate.runtime_profile_id) reasons.push("explicit_profile_not_selected");
  if (hints.preferred_runtime_profile_id && hints.preferred_runtime_profile_id === candidate.runtime_profile_id) {
    // A preferred profile is scored, not hard-required.
  }
  if (!requiredCapabilities.every((capability) => candidate.capabilities.includes(capability))) reasons.push("required_capability_missing");
  if (!requiredTools.every((tool) => candidate.tools.includes(tool))) reasons.push("required_tool_missing");
  const requiredSandbox = stricterSandbox(request.required_sandbox_level, hints.required_sandbox_level);
  const candidateSandbox = request.risk_level === "critical"
    && isLocalCliRuntimeAdapter(candidate.adapter_type)
    ? "one_shot_docker" as const
    : requiredSandbox;
  // A local CLI may have a worktree baseline while also supporting a
  // stronger one-shot Docker execution mode. Model that capability
  // explicitly; the old rank comparison treated worktree as sufficient for
  // Docker simply because it was below the requested rank.
  const sandboxSupported = candidateSandbox === "one_shot_docker"
    ? candidate.supports_one_shot_docker
    : SANDBOX_RANK[candidate.minimum_sandbox_level] >= SANDBOX_RANK[candidateSandbox];
  if (!sandboxSupported) reasons.push("sandbox_requirement_not_supported");
  if (requiresPersistentWorkspace(request, requiredSandbox, candidate)) {
    reasons.push("workspace_or_file_access_unavailable");
  }
  const minimumTrust = stricterTrust(trustRequiredForRisk(request.risk_level), hints.minimum_trust_level);
  if (TRUST_RANK[candidate.effective_trust_level] < TRUST_RANK[minimumTrust]) reasons.push("trust_level_too_low");
  const mode = hints.execution_mode ?? request.execution_mode;
  if (mode === "dry_run" && !candidate.supports_dry_run) reasons.push("dry_run_unsupported");
  if (mode === "live" && !candidate.supports_live) reasons.push("live_execution_unsupported");
  return reasons;
}

/**
 * A runtime's minimum sandbox is not the same thing as a persistent project
 * workspace requirement. File-access CLIs can use an ephemeral run directory
 * for low/medium-risk work. Persistent workspace is required only when the
 * adapter declares it, when high-risk work needs a worktree, or when the
 * route explicitly asks for one.
 */
function requiresPersistentWorkspace(
  request: RouteRequest,
  requiredSandbox: SandboxLevel,
  candidate: RouteCandidate,
): boolean {
  if (request.workspace_available) return false;
  if (candidate.requires_workspace_for_execution) return true;
  if (requiredSandbox === "worktree") return true;
  return request.risk_level === "high" && candidate.minimum_sandbox_level !== "none";
}

function scoreCandidate(request: RouteRequest, hints: RouteHints, candidate: RouteCandidate): Record<string, number> {
  const preferredAdapters = [...(request.adapter_types ?? []), ...hints.preferred_adapter_types];
  const preference = preferredAdapters.includes(candidate.adapter_type) ? 20 : 0;
  const profilePreference = hints.preferred_runtime_profile_id === candidate.runtime_profile_id || request.runtime_profile_id === candidate.runtime_profile_id ? 25 : 0;
  const defaultProfile = candidate.is_default ? 3 : 0;
  const passRate = (candidate.historical_verification_pass_rate ?? 0.5) * 20;
  const cost = candidate.estimated_cost_usd === null ? 0 : Math.max(-10, 5 - candidate.estimated_cost_usd);
  const latency = candidate.estimated_latency_ms === null ? 0 : Math.max(-10, 5 - (candidate.estimated_latency_ms / 1000));
  const latencyBudget = hints.latency_budget_ms !== null && candidate.estimated_latency_ms !== null && candidate.estimated_latency_ms <= hints.latency_budget_ms ? 4 : 0;
  const costBudget = hints.cost_budget_usd !== null && candidate.estimated_cost_usd !== null && candidate.estimated_cost_usd <= hints.cost_budget_usd ? 4 : 0;
  const shapeDefault = executionShapeScore(hints.execution_shape, candidate);
  return { preference, profile_preference: profilePreference, execution_shape_default: shapeDefault, default_profile: defaultProfile, verification_pass_rate: passRate, cost, latency, latency_budget: latencyBudget, cost_budget: costBudget };
}

function executionShapeScore(
  shape: RouteExecutionShape | null,
  candidate: RouteCandidate,
): number {
  if (
    (shape === "conversational" || shape === "structured_generation") &&
    candidate.adapter_type === "model_api"
  ) return 30;
  if (
    (shape === "agentic_files" || shape === "code_execution") &&
    candidate.adapter_type === "opencode" &&
    candidate.conformance_status === "passed"
  ) return 30;
  return 0;
}

function trustRequiredForRisk(risk: RouteRiskLevel): RouteTrustLevel {
  if (risk === "critical" || risk === "high") return "high";
  if (risk === "medium") return "medium";
  return "low";
}

function stricterSandbox(base: SandboxLevel, hint: SandboxLevel | null): SandboxLevel {
  if (!hint) return base;
  return SANDBOX_RANK[hint] > SANDBOX_RANK[base] ? hint : base;
}

function stricterTrust(base: RouteTrustLevel, hint: RouteTrustLevel | null): RouteTrustLevel {
  if (!hint) return base;
  return TRUST_RANK[hint] > TRUST_RANK[base] ? hint : base;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function sandboxValue(value: unknown): SandboxLevel | null { return value === "none" || value === "dry_run" || value === "ephemeral" || value === "read_only" || value === "worktree" || value === "one_shot_docker" ? value : null; }
function executionMode(value: unknown): "live" | "dry_run" | null { return value === "live" || value === "dry_run" ? value : null; }
function trustValue(value: unknown): RouteTrustLevel | null { return value === "low" || value === "medium" || value === "high" ? value : null; }
function executionShape(value: unknown): RouteExecutionShape | null {
  return value === "conversational" ||
    value === "structured_generation" ||
    value === "agentic_files" ||
    value === "code_execution"
    ? value
    : null;
}
