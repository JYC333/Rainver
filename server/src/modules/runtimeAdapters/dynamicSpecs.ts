import type { RuntimeAdapterSpec } from "./specs.js";

/**
 * Runtime adapters that exist because an operator enabled them, not because
 * they were written into `BUILTIN_RUNTIME_ADAPTER_SPECS` — today, agents
 * from the ACP registry (`modules/acpAgents`). Held in process memory and
 * replaced wholesale by whoever owns their source of truth; `getRuntimeAdapterSpec`
 * consults this after the builtins so the rest of the server reads one catalog.
 *
 * Only the spec lookups go through here. Code that indexes
 * `BUILTIN_RUNTIME_ADAPTER_SPECS` directly (agent configuration, automations,
 * server-host runtime tools) deliberately never sees these: a dynamic adapter
 * is `remote_host_only` and has no server-host execution path.
 */
const dynamicSpecs = new Map<string, RuntimeAdapterSpec>();

export function setDynamicRuntimeAdapterSpecs(specs: readonly RuntimeAdapterSpec[]): void {
  dynamicSpecs.clear();
  for (const spec of specs) dynamicSpecs.set(spec.adapter_type, spec);
}

export function getDynamicRuntimeAdapterSpec(adapterType: string): RuntimeAdapterSpec | null {
  return dynamicSpecs.get(adapterType) ?? null;
}

export function listDynamicRuntimeAdapterSpecs(): RuntimeAdapterSpec[] {
  return [...dynamicSpecs.values()];
}
