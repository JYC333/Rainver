import { pluginOperations } from "../plugins/operationRegistry.js";
import type { ServerConfig } from "../../config.js";
import type { RegisteredSystemActionDefinition as SystemActionDefinition, SystemActionId } from "@rainver/protocol";
import * as protocol from "@rainver/protocol";

let cached: ReadonlyMap<SystemActionId, SystemActionDefinition> | null = null;

export async function loadSystemActionRegistry(config?:ServerConfig): Promise<ReadonlyMap<string, SystemActionDefinition>> {
  const core=await loadCoreRegistry();
  return new Map([...core,...pluginOperations(config).map(r=>[r.definition.id,r.definition] as const)]);
}
async function loadCoreRegistry():Promise<ReadonlyMap<SystemActionId,SystemActionDefinition>> {
  if (cached) return cached;
  const policyActionIds = new Set<string>(
    protocol.POLICY_ACTION_REGISTRY.map((definition) => definition.action),
  );
  const validated = new Map<SystemActionId, SystemActionDefinition>();
  for (const candidate of protocol.SYSTEM_ACTION_REGISTRY) {
    const parsed = protocol.SystemActionDefinitionSchema.safeParse(candidate);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "definition"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid system action definition ${candidate.id}: ${detail}`);
    }
    const definition = parsed.data as SystemActionDefinition;
    if (validated.has(definition.id as SystemActionId)) {
      throw new Error(`Duplicate system action id: ${definition.id}`);
    }
    if (!policyActionIds.has(definition.policy_action)) {
      throw new Error(
        `Unknown policy action ${definition.policy_action} for system action ${definition.id}`,
      );
    }
    validated.set(definition.id as SystemActionId, definition);
  }
  cached = validated;
  return cached;
}

export function resetSystemActionRegistryForTests(): void {
  cached = null;
}
