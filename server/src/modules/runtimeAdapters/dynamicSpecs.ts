import type { RuntimeAdapterSpec } from "./specs.js";

/**
 * Runtime adapters an operator enabled. They are not entries of
 * `BUILTIN_RUNTIME_ADAPTER_SPECS`. Agents from the
 * ACP registry (`modules/acpAgents`) are the ones held here, in process
 * memory, and replaced wholesale by whoever owns their source of truth.
 * `getRuntimeAdapterSpec` consults this map after the builtins, so the rest
 * of the server reads one catalog. Do not subscript
 * `BUILTIN_RUNTIME_ADAPTER_SPECS` for an agent. A dynamic adapter is
 * `remote_host_only` and is invisible in that table; dispatch would answer
 * "Unknown runtime_key".
 */
const dynamicSpecs = new Map<string, RuntimeAdapterSpec>();

export function setDynamicRuntimeAdapterSpecs(specs: readonly RuntimeAdapterSpec[]): void {
  dynamicSpecs.clear();
  for (const spec of specs) dynamicSpecs.set(spec.runtime_key, spec);
}

export function getDynamicRuntimeAdapterSpec(runtimeKey: string): RuntimeAdapterSpec | null {
  return dynamicSpecs.get(runtimeKey) ?? null;
}

export function listDynamicRuntimeAdapterSpecs(): RuntimeAdapterSpec[] {
  return [...dynamicSpecs.values()];
}
