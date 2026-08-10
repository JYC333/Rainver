import {
  BUILTIN_RUNTIME_ADAPTER_SPECS,
  type RuntimeAdapterType,
} from "../runtimeAdapters/specs";
import { recommendedMaxOutputTokens } from "../providers/modelOutputLimits";
import type { AgentOut, AgentRecord } from "./repository";

export const DEFAULT_MODEL_CONFIG = { model: "claude-sonnet-4-6", max_tokens: 8192 };

/**
 * Default model config for a version that names a model but supplies no
 * explicit config. Known models get their recommended output budget instead
 * of the generic default — stamping 8192 onto a reasoning model starves its
 * structured outputs (thinking and completion share the same budget).
 */
export function defaultModelConfigFor(modelName: string | null | undefined): { model: string; max_tokens: number } {
  if (!modelName) return { ...DEFAULT_MODEL_CONFIG };
  return {
    model: modelName,
    max_tokens: recommendedMaxOutputTokens(modelName) ?? DEFAULT_MODEL_CONFIG.max_tokens,
  };
}
export const DEFAULT_MEMORY_POLICY = {
  readable_scopes: ["user", "project"],
  writable_scopes: ["user", "project"],
  readable_types: ["preference", "semantic", "episodic", "procedural", "project"],
};
export const DEFAULT_RUNTIME_POLICY = {
  risk_level: "medium",
  max_run_time_seconds: 300,
  allowed_adapter_types: [
    "capability",
    "model_api",
    "claude_code",
    "codex_cli",
    "opencode",
    "gemini_cli",
  ],
  default_adapter_type: "model_api",
};
export const DEFAULT_RUNTIME_CONFIG = { risk_level: "medium", max_run_time_seconds: 300 };

export function agentOut(row: AgentRecord): AgentOut {
  const adapterType = normalizeAdapterType(row.runtime_adapter_type ?? runtimePolicy(row).default_adapter_type);
  const spec = BUILTIN_RUNTIME_ADAPTER_SPECS[adapterType as RuntimeAdapterType];
  const requiresModelProvider = spec?.model.model_provider_mode === "required";
  const hasModel =
    row.model_provider_id !== null ||
    row.provider_name !== null ||
    row.provider_type !== null ||
    row.model_name !== null;
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    created_by_user_id: row.owner_user_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    access_level: row.access_level,
    role_instruction: row.role_instruction,
    status: row.status,
    agent_kind: row.agent_kind,
    current_version_id: row.current_version_id,
    model: hasModel
      ? {
          provider_id: row.model_provider_id ?? null,
          provider_name: row.provider_name ?? null,
          provider_type: row.provider_type ?? null,
          model: row.model_name ?? null,
        }
      : null,
    adapter_type: adapterType,
    requires_model_provider: requiresModelProvider,
    system_prompt: row.system_prompt ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function runtimePolicy(row: AgentRecord): Record<string, unknown> {
  return recordValue(row.runtime_policy_json) ?? DEFAULT_RUNTIME_POLICY;
}

export function buildRuntimePolicy(
  adapterType: string,
  base: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const policy = { ...DEFAULT_RUNTIME_POLICY, ...(base ?? {}) };
  const allowed = Array.isArray(policy.allowed_adapter_types)
    ? policy.allowed_adapter_types.filter((item): item is string => typeof item === "string")
    : [...DEFAULT_RUNTIME_POLICY.allowed_adapter_types];
  if (!allowed.includes(adapterType)) allowed.push(adapterType);
  policy.allowed_adapter_types = allowed;
  policy.default_adapter_type = adapterType;
  return policy;
}

export function normalizeAdapterType(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "model_api";
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
