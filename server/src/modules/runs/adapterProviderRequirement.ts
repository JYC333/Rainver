import type { ProviderProxyRoute } from "../providers/proxy/lease.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

export interface AdapterProviderRequirement {
  /** The `ModelProvider` field the adapter's binding reads for its upstream. */
  base_url_field: "claude_compatible_base_url" | "openai_compatible_base_url";
  missing_base_url_code: string;
  /** Article included: "a Claude-compatible" / "an OpenAI-compatible". */
  base_url_label: string;
  route: ProviderProxyRoute;
}

/**
 * What makes a `ModelProvider` usable by a runtime adapter.
 *
 * Single source of truth on purpose: dispatch-time validation
 * (`hosts/runtimeProviderBindingResolution.ts`) and the binding the daemon is
 * handed (`runs/remoteProviderBinding.ts`) must agree, or a dispatch validates
 * and then fails on the host with an error nobody is waiting on.
 *
 * All that survives of the server-side CLI binding: since ADR 0016 a vendor
 * CLI runs only on an execution host, and the provider binding it receives is
 * built for the wire, not for a local subprocess environment.
 */
export function adapterProviderRequirement(adapterType: string): AdapterProviderRequirement | null {
  // Read from the spec, where the runtime's provider API family is declared
  // once (`model.provider_api`); a runtime that takes no provider — a
  // registry agent, or one that declares none — has no requirement.
  const spec = getRuntimeAdapterSpec(adapterType);
  if (!spec || spec.invocation?.remote_host_only) return null;
  switch (spec.model.provider_api) {
    case "claude_compatible":
      return {
        base_url_field: "claude_compatible_base_url",
        missing_base_url_code: "claude_compatible_base_url_required",
        base_url_label: "a Claude-compatible",
        route: "anthropic",
      };
    case "openai_compatible":
      return {
        base_url_field: "openai_compatible_base_url",
        missing_base_url_code: "openai_compatible_base_url_required",
        base_url_label: "an OpenAI-compatible",
        route: "openai",
      };
    default:
      return null;
  }
}
