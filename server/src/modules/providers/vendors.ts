/**
 * Vendor identity for a configured ModelProvider.
 *
 * `model_providers.provider_type` used to hold a wire protocol — MiniMax was
 * stored as `anthropic` because it speaks the Anthropic protocol. That loses
 * the fact a credential actually carries: an API key is issued by a vendor,
 * and the base URL is a routing detail a gateway or mirror may change.
 *
 * Vendor identity is what selects a rate table and a capability profile, so it
 * has to be recorded rather than guessed from a URL. Protocol is derived from
 * it here, which is the only reason this registry exists as a lookup rather
 * than as a second column.
 */

/** Wire protocol, and therefore which transport implementation serves a call. */
export type ProviderProtocol =
  | "openai_completions"
  | "openai_codex_responses"
  | "anthropic_messages"
  | "cohere_v2"
  | "zeroentropy";

export interface VendorDescriptor {
  /** Stored in `model_providers.provider_type`. */
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  /**
   * The pi-ai catalog this vendor's models are described by, when one exists.
   * It is the source of per-model rates and `compat` flags, so a vendor
   * without one produces no cost — true for the embedding and rerank vendors,
   * which pi-ai does not cover at all, and for custom endpoints, whose models
   * are whatever the operator points them at.
   */
  piCatalog: string | null;
  /** Whether a chat completion may be requested from this vendor at all. */
  supportsChat: boolean;
  /** Whether runtime-host tool calls may be offered. */
  supportsRuntimeTools: boolean;
  /** Whether a structured-output request may be made. */
  supportsStructuredOutput: boolean;
}

const VENDORS: readonly VendorDescriptor[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    protocol: "openai_completions",
    piCatalog: "openai",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
  },
  {
    id: "openai_codex",
    displayName: "OpenAI Codex (ChatGPT subscription)",
    protocol: "openai_codex_responses",
    piCatalog: "openai-codex",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    protocol: "anthropic_messages",
    piCatalog: "anthropic",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    // MiniMax publishes both an Anthropic-compatible and an OpenAI-compatible
    // endpoint. The Anthropic one is the vendor's own protocol here; the
    // OpenAI-compatible gateway is the one whose forced tool-call arguments
    // arrive corrupted, which `structuredOutputCapabilities` still guards.
    protocol: "anthropic_messages",
    piCatalog: "minimax",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    protocol: "openai_completions",
    piCatalog: "openrouter",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    protocol: "openai_completions",
    piCatalog: "deepseek",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
  },
  {
    id: "ollama",
    displayName: "Ollama",
    // Ollama's OpenAI-compatible /v1 surface lets the same pi-ai transport
    // serve local and hosted chat without retaining a bespoke adapter.
    protocol: "openai_completions",
    // Locally served models have no published rates, and their marginal cost
    // genuinely is zero, so the absent catalog is accurate rather than a gap.
    piCatalog: null,
    supportsChat: true,
    supportsRuntimeTools: false,
    supportsStructuredOutput: true,
  },
  {
    id: "openai_compatible",
    displayName: "OpenAI-compatible endpoint",
    // A self-hosted or gateway endpoint. Its vendor is genuinely unknown, so
    // the protocol is the only thing that can be recorded about it.
    protocol: "openai_completions",
    piCatalog: null,
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
  },
  {
    id: "cohere",
    displayName: "Cohere",
    protocol: "cohere_v2",
    piCatalog: null,
    supportsChat: false,
    supportsRuntimeTools: false,
    supportsStructuredOutput: false,
  },
  {
    id: "zeroentropy",
    displayName: "ZeroEntropy",
    protocol: "zeroentropy",
    piCatalog: null,
    supportsChat: false,
    supportsRuntimeTools: false,
    supportsStructuredOutput: false,
  },
];

const BY_ID = new Map(VENDORS.map((vendor) => [vendor.id, vendor]));

/** Read-time compatibility for protocol-era custom provider rows. */
export function canonicalProviderVendorId(id: string): string {
  return id === "other" ? "openai_compatible" : id;
}

export function listProviderVendors(): readonly VendorDescriptor[] {
  return VENDORS;
}

export function providerVendor(id: string): VendorDescriptor | null {
  return BY_ID.get(canonicalProviderVendorId(id)) ?? null;
}

/**
 * Resolution is deliberately strict. A row whose vendor is unknown cannot have
 * its protocol guessed — that guess is what the base-URL heuristic would have
 * been, and it breaks on exactly the gateways and mirrors a configurable base
 * URL exists to support.
 */
export function requireProviderVendor(id: string): VendorDescriptor {
  const vendor = BY_ID.get(canonicalProviderVendorId(id));
  if (!vendor) throw new Error(`Unknown provider vendor '${id}'`);
  return vendor;
}
