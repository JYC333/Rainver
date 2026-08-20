/**
 * Vendor identity for a configured ModelProvider.
 *
 * What lives here is what agent-space owns about a vendor: its identity, its
 * protocol family, and generic capability facts. How a vendor's models are
 * described to whichever chat implementation is in use is that adapter's
 * concern and lives with it.
 *
 * `model_providers.provider_type` used to hold a wire protocol — MiniMax was
 * stored as `anthropic` because it speaks the Anthropic protocol. That loses
 * the fact a credential actually carries: an API key is issued by a vendor,
 * and the base URL is a routing detail a gateway or mirror may change.
 *
 * Vendor identity is what selects a capability profile, and what the chat
 * adapter resolves its own rate table from, so it has to be recorded rather
 * than guessed from a URL. Protocol is derived from it here, which is the only
 * reason this registry exists as a lookup rather than as a second column.
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
  /** Whether a chat completion may be requested from this vendor at all. */
  supportsChat: boolean;
  /** Whether runtime-host tool calls may be offered. */
  supportsRuntimeTools: boolean;
  /** Whether a structured-output request may be made. */
  supportsStructuredOutput: boolean;
  /** Whether the vendor can serve retrieval embeddings. */
  supportsEmbedding: boolean;
  /** Whether the vendor exposes a dedicated rerank endpoint. */
  supportsRerank: boolean;
  /**
   * The vendor's published API endpoint, used to pre-fill a new provider. Null
   * where there is nothing to publish: a self-hosted or gateway endpoint is
   * whatever the operator points it at.
   */
  defaultBaseUrl: string | null;
  /** Whether configuring this vendor requires a credential at all. */
  apiKeyRequired: boolean;
  /**
   * Whether the only way to reach this vendor is a managed subscription
   * credential. Such a provider is owner-scoped, so it cannot back a
   * space-wide provider task policy — see `provider-policy.md`. Anthropic is
   * deliberately not one of these: the same vendor is reachable by API key.
   */
  subscriptionOnly: boolean;
}

const VENDORS: readonly VendorDescriptor[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    protocol: "openai_completions",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
    supportsEmbedding: true,
    supportsRerank: false,
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyRequired: true,
    subscriptionOnly: false,
  },
  {
    id: "openai_codex",
    displayName: "OpenAI Codex (ChatGPT subscription)",
    protocol: "openai_codex_responses",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
    supportsEmbedding: false,
    supportsRerank: false,
    defaultBaseUrl: "https://chatgpt.com/backend-api",
    apiKeyRequired: false,
    subscriptionOnly: true,
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    protocol: "anthropic_messages",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
    supportsEmbedding: false,
    supportsRerank: false,
    defaultBaseUrl: "https://api.anthropic.com",
    apiKeyRequired: true,
    subscriptionOnly: false,
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    // MiniMax publishes both an Anthropic-compatible and an OpenAI-compatible
    // endpoint. The Anthropic one is the vendor's own protocol here; the
    // OpenAI-compatible gateway is the one whose forced tool-call arguments
    // arrive corrupted, which `structuredOutputCapabilities` still guards.
    protocol: "anthropic_messages",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
    supportsEmbedding: false,
    supportsRerank: false,
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
    apiKeyRequired: true,
    subscriptionOnly: false,
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    protocol: "openai_completions",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
    supportsEmbedding: true,
    supportsRerank: false,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    apiKeyRequired: true,
    subscriptionOnly: false,
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    protocol: "openai_completions",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
    supportsEmbedding: false,
    supportsRerank: false,
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyRequired: true,
    subscriptionOnly: false,
  },
  {
    id: "ollama",
    displayName: "Ollama",
    // Ollama's OpenAI-compatible /v1 surface lets the same pi-ai transport
    // serve local and hosted chat without retaining a bespoke adapter.
    protocol: "openai_completions",
    supportsChat: true,
    supportsRuntimeTools: false,
    supportsStructuredOutput: true,
    supportsEmbedding: true,
    supportsRerank: false,
    defaultBaseUrl: "http://localhost:11434",
    apiKeyRequired: false,
    subscriptionOnly: false,
  },
  {
    id: "openai_compatible",
    displayName: "OpenAI-compatible endpoint",
    // A self-hosted or gateway endpoint. Its vendor is genuinely unknown, so
    // the protocol is the only thing that can be recorded about it.
    protocol: "openai_completions",
    supportsChat: true,
    supportsRuntimeTools: true,
    supportsStructuredOutput: true,
    supportsEmbedding: true,
    supportsRerank: false,
    defaultBaseUrl: null,
    apiKeyRequired: false,
    subscriptionOnly: false,
  },
  {
    id: "cohere",
    displayName: "Cohere",
    protocol: "cohere_v2",
    supportsChat: false,
    supportsRuntimeTools: false,
    supportsStructuredOutput: false,
    supportsEmbedding: true,
    supportsRerank: true,
    defaultBaseUrl: "https://api.cohere.com",
    apiKeyRequired: true,
    subscriptionOnly: false,
  },
  {
    id: "zeroentropy",
    displayName: "ZeroEntropy",
    protocol: "zeroentropy",
    supportsChat: false,
    supportsRuntimeTools: false,
    supportsStructuredOutput: false,
    supportsEmbedding: true,
    supportsRerank: true,
    defaultBaseUrl: "https://api.zeroentropy.dev/v1",
    apiKeyRequired: true,
    subscriptionOnly: false,
  },
];

const BY_ID = new Map(VENDORS.map((vendor) => [vendor.id, vendor]));

export function listProviderVendors(): readonly VendorDescriptor[] {
  return VENDORS;
}

export function providerVendor(id: string): VendorDescriptor | null {
  return BY_ID.get(id) ?? null;
}

export function providerSupportsChat(id: string): boolean {
  return providerVendor(id)?.supportsChat === true;
}

export function providerCanRunWithoutCredential(id: string): boolean {
  const vendor = providerVendor(id);
  return vendor?.supportsChat === true &&
    vendor.apiKeyRequired === false &&
    vendor.subscriptionOnly === false;
}

/**
 * Resolution is deliberately strict. A row whose vendor is unknown cannot have
 * its protocol guessed — that guess is what the base-URL heuristic would have
 * been, and it breaks on exactly the gateways and mirrors a configurable base
 * URL exists to support.
 */
export function requireProviderVendor(id: string): VendorDescriptor {
  const vendor = BY_ID.get(id);
  if (!vendor) throw new Error(`Unknown provider vendor '${id}'`);
  return vendor;
}
