import { bodyWithheld, type WithAccessLevel } from "../access/contentAccessTypes.js";
import type { AgentOut, AgentRecord } from "./repository.js";

export const DEFAULT_MEMORY_POLICY = {
  readable_scopes: ["user", "project"],
  writable_scopes: ["user", "project"],
  readable_types: ["preference", "semantic", "episodic", "procedural", "project"],
};
export const DEFAULT_AGENT_RISK_LEVEL = "medium" as const;
export const DEFAULT_AGENT_MAX_RUN_TIME_SECONDS = 300;
export const DEFAULT_RUNTIME_CONFIG: Record<string, unknown> = {};

export function agentOut(row: WithAccessLevel<AgentRecord>): AgentOut {
  const runtimeKey = row.runtime_key ?? null;
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
    runtime_key: runtimeKey,
    system_prompt: bodyWithheld(row.effective_access_level) ? null : row.system_prompt ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
