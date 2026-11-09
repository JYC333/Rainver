/**
 * Canonical action registry access.
 *
 * The registry data is owned by the shared protocol package
 * (`POLICY_ACTION_REGISTRY`); this module indexes it into a Map for lookup.
 */


import { pluginPolicies } from "../plugins/operationRegistry.js";
import type { ServerConfig } from "../../config.js";
import type { PolicyActionDefinition } from "@rainver/protocol";
import { POLICY_ACTION_REGISTRY } from "@rainver/protocol";

export type { PolicyActionDefinition };

export class UnknownPolicyActionError extends Error {
  readonly action: string;
  constructor(action: string) {
    super(
      `Unknown policy action: ${JSON.stringify(action)}. All sensitive actions must be registered in the canonical action registry.`,
    );
    this.action = action;
    this.name = "UnknownPolicyActionError";
  }
}

let cached: Promise<ReadonlyMap<string, PolicyActionDefinition>> | null = null;

export async function loadActionRegistry(config?:ServerConfig): Promise<
  ReadonlyMap<string, PolicyActionDefinition>
> {
  cached ??= (async () => {
    const map = new Map<string, PolicyActionDefinition>();
    for (const def of POLICY_ACTION_REGISTRY) {
      map.set(def.action, def);
    }
    return map;
  })();
  return new Map([...(await cached),...pluginPolicies(config).map(p=>[p.action,p] as const)]);
}

export function getActionDefinition(
  registry: ReadonlyMap<string, PolicyActionDefinition>,
  action: string,
): PolicyActionDefinition | undefined {
  return registry.get(action);
}

export function requireActionDefinition(
  registry: ReadonlyMap<string, PolicyActionDefinition>,
  action: string,
): PolicyActionDefinition {
  const defn = registry.get(action);
  if (defn === undefined) throw new UnknownPolicyActionError(action);
  return defn;
}
