import type { AgentRuntimeBackendMode, AgentRuntimeDefinition, RuntimeKey } from "@rainver/protocol";
import { getRuntimeAdapterSpec, isAcpRuntimeAdapter, listRuntimeAdapterSpecs } from "./specs.js";

/**
 * The ACP-facing projection of the runtime registry.
 *
 * `RuntimeAdapterSpec` (`specs.ts`) is the authoring catalog: it carries every
 * implementation fact a launch, probe or install needs. `AgentRuntimeDefinition`
 * is the narrow view of that catalog which Profile admission, routing and
 * dispatch read — `runtime_key`, display name, protocol and the backend modes
 * the runtime contract supports. Projection only: no execution logic lives
 * here, and `AcpController` (reached through `acpRuntimeAdapter.ts`) remains
 * the single Agent execution loop.
 */
export function getAgentRuntimeDefinition(runtimeKey: string | null | undefined): AgentRuntimeDefinition | null {
  if (!runtimeKey || !isAcpRuntimeAdapter(runtimeKey)) return null;
  const spec = getRuntimeAdapterSpec(runtimeKey);
  if (!spec || spec.invocation?.protocol !== "acp") return null;
  return {
    runtime_key: runtimeKey as RuntimeKey,
    display_name: spec.display_name,
    protocol: "acp",
    supports_runtime_native: spec.credentials.credential_mode === "cli_profile" || spec.credentials.credential_mode === "cli_profile_or_model_provider",
    supports_model_provider: spec.credentials.credential_mode === "cli_profile_or_model_provider",
  };
}

/** Backend-mode support is determined only by the registered runtime contract. */
export function supportsRuntimeBackendMode(
  runtimeKey: string | null | undefined,
  backendMode: AgentRuntimeBackendMode,
): boolean {
  const definition = getAgentRuntimeDefinition(runtimeKey);
  if (!definition) return false;
  return backendMode === "runtime_native"
    ? definition.supports_runtime_native
    : definition.supports_model_provider;
}

/**
 * A selectable Agent runtime. `getAgentRuntimeDefinition` already answers both
 * halves — `isAcpRuntimeAdapter` admits only an implemented spec, and the
 * protocol check admits only an ACP one — so a definition is the whole test.
 */
export function isRunnableAgentRuntime(runtimeKey: string | null | undefined): boolean {
  return getAgentRuntimeDefinition(runtimeKey) !== null;
}

export function assertAgentRuntimeDefinition(runtimeKey: string): AgentRuntimeDefinition {
  const definition = getAgentRuntimeDefinition(runtimeKey);
  if (!definition) throw new Error(`Runtime '${runtimeKey}' is not a registered ACP runtime`);
  return definition;
}

export function listAgentRuntimeDefinitions(): AgentRuntimeDefinition[] {
  return listRuntimeAdapterSpecs()
    .map((spec) => getAgentRuntimeDefinition(spec.runtime_key))
    .filter((definition): definition is AgentRuntimeDefinition => definition !== null);
}
