import type {
  AutomationTargetDefinition,
  AutomationTargetType,
} from "@agent-space/protocol";

let cached: ReadonlyMap<AutomationTargetType, AutomationTargetDefinition> | null = null;

export async function loadAutomationTargetDefinitions(): Promise<
  ReadonlyMap<AutomationTargetType, AutomationTargetDefinition>
> {
  if (cached) return cached;
  const protocol = await import("@agent-space/protocol");
  cached = new Map(
    protocol.AUTOMATION_TARGET_REGISTRY.map((definition) => [
      definition.target_type,
      definition,
    ]),
  );
  return cached;
}

export async function loadAutomationTargetDefinition(
  targetType: string,
): Promise<AutomationTargetDefinition | null> {
  const definitions = await loadAutomationTargetDefinitions();
  return definitions.get(targetType as AutomationTargetType) ?? null;
}
