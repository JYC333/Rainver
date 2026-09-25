import type { ProviderProxyRoute } from "../providers/proxy/lease.js";
import { providerVendor } from "../providers/vendors.js";
import { getRuntimeAdapterSpec, type RuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

export type AdapterProviderApi = NonNullable<RuntimeAdapterSpec["model"]["provider_api"]>;

export interface AdapterProviderRequirement {
  /** The `ModelProvider` field the adapter's binding reads for its upstream. */
  base_url_field: "claude_compatible_base_url" | "openai_compatible_base_url";
  missing_base_url_code: string;
  /** Article included: "a Claude-compatible" / "an OpenAI-compatible". */
  base_url_label: string;
  route: ProviderProxyRoute;
}

/**
 * The provider API family a runtime declares (`model.provider_api`), or null
 * when it takes no ModelProvider — a registry agent, or one that declares
 * none. Whether a runtime accepts a binding at all, before any provider is
 * known.
 */
export function adapterProviderApi(runtimeKey: string | null | undefined): AdapterProviderApi | null {
  const spec = getRuntimeAdapterSpec(runtimeKey);
  if (!spec || spec.invocation?.remote_host_only) return null;
  return spec.model.provider_api ?? null;
}

/**
 * What makes a `ModelProvider` usable by an ACP runtime: the base-URL field its
 * binding reads, and the proxy route the Run's lease is minted on.
 *
 * All that survives of the server-side CLI binding: since ADR 0016 a vendor
 * CLI runs only on an execution host, and the provider binding it receives is
 * built for the wire, not for a local subprocess environment.
 * `runs/remoteProviderBinding.ts` is the consumer that mints the lease, and a
 * runtime with no requirement is refused there rather than given a guessed one.
 *
 * A runtime declaring `vendor` (OpenCode) follows the bound provider's vendor
 * protocol: an `anthropic_messages` vendor binds on the Claude-compatible URL
 * and the `anthropic` route, an `openai_completions` vendor on the
 * OpenAI-compatible URL and the `openai` route. Any other protocol, or an
 * unknown vendor, has no requirement — its protocol is never guessed.
 */
export function adapterProviderRequirement(
  runtimeKey: string | null | undefined,
  providerType: string | null | undefined,
): AdapterProviderRequirement | null {
  const declared = adapterProviderApi(runtimeKey);
  const api = declared === "vendor" ? vendorProviderApi(providerType) : declared;
  switch (api) {
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

function vendorProviderApi(providerType: string | null | undefined): "claude_compatible" | "openai_compatible" | null {
  switch (providerType ? providerVendor(providerType)?.protocol : undefined) {
    case "anthropic_messages":
      return "claude_compatible";
    case "openai_completions":
      return "openai_compatible";
    default:
      return null;
  }
}
