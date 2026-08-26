import type { RunToolGrant } from "@rainver/protocol";
import { loadSystemActionRegistry } from "./registry.js";

export async function buildRunToolGrants(
  capabilities: readonly unknown[],
  toolPermissions: unknown,
): Promise<RunToolGrant[]> {
  const declared = new Set(
    capabilities.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const allowed = new Set(allowedTools(toolPermissions));
  const registry = await loadSystemActionRegistry();
  const grants: RunToolGrant[] = [...registry.values()]
    .filter(
      (definition) =>
        definition.id !== "authorization.request" &&
        declared.has(definition.id) &&
        allowed.has(definition.id) &&
        definition.visibility.has("agent_tool") &&
        definition.allowed_actor_types.includes("agent"),
    )
    .map((definition) => ({
      action_id: definition.id,
      capability_id: null,
      approval_behavior: "none" as const,
      side_effecting: definition.side_effects !== "none",
    }));
  const requestDefinition = registry.get("authorization.request");
  return grants.length > 0 && requestDefinition
    ? [{
        action_id: requestDefinition.id,
        capability_id: null,
        approval_behavior: "none" as const,
        side_effecting: true,
      }, ...grants]
    : grants;
}

function allowedTools(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const tools = (value as Record<string, unknown>).allowed_tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}
