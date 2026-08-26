import { RESEARCH_CAPABILITIES } from "./researchPack.js";
import type { CapabilityDefinition } from "./types.js";

export function listBuiltInCapabilityDefinitions(): CapabilityDefinition[] {
  return [...RESEARCH_CAPABILITIES].sort((a, b) => a.id.localeCompare(b.id));
}

export function getBuiltInCapabilityDefinition(id: string): CapabilityDefinition | null {
  return listBuiltInCapabilityDefinitions().find((capability) => capability.id === id) ?? null;
}

export function assertUniqueCapabilityIds(capabilities: readonly CapabilityDefinition[]): void {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (seen.has(capability.id)) throw new Error(`duplicate capability id ${capability.id}`);
    seen.add(capability.id);
  }
}

