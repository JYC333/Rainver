import type { ModelProviderOut, ProviderType, ProviderVendorOut } from '../../api/client'
import type { AddProviderMode, ModelFieldCopy, ProviderCapability } from './types'
import i18n from '../../i18n'

/**
 * Vendor facts come from the server's registry, read through
 * `providersApi.vendors()` and threaded down from the providers page. Only
 * presentation lives here — copy, placeholders, and embedding dimension
 * options. Do not hardcode vendor lists here. `VendorDescriptor` answers them.
 */
export function providerTypeOptionsForMode(
  mode: AddProviderMode,
  vendors: readonly ProviderVendorOut[],
): { value: ProviderType; label: string }[] {
  return vendors
    .filter(vendor => (
      mode === 'chat'
        // A vendor reachable only through a managed subscription is connected
        // in the subscriptions panel, never by pasting an API key here.
        ? vendor.supports_chat && !vendor.subscription_only
        : mode === 'embedding'
          ? vendor.supports_embedding
          : vendor.supports_rerank
    ))
    .map(vendor => ({ value: vendor.id, label: vendor.display_name }))
}

export function apiKeyRequiredForVendor(
  providerType: ProviderType | string,
  vendors: readonly ProviderVendorOut[],
): boolean {
  return vendors.find(vendor => vendor.id === providerType)?.api_key_required ?? false
}

export function isRetrievalOnlyVendor(
  providerType: ProviderType | string,
  vendors: readonly ProviderVendorOut[],
): boolean {
  const vendor = vendors.find(candidate => candidate.id === providerType)
  return vendor ? !vendor.supports_chat : false
}

export function supportsStructuredOutput(
  providerType: ProviderType | string,
  vendors: readonly ProviderVendorOut[],
): boolean {
  return vendors.find(candidate => candidate.id === providerType)?.supports_structured_output ?? false
}

export function defaultBaseUrl(
  providerType: ProviderType | string,
  vendors: readonly ProviderVendorOut[],
): string {
  return vendors.find(vendor => vendor.id === providerType)?.default_base_url ?? ''
}

export function providerCapabilities(
  providerType: ProviderType | string,
  vendors: readonly ProviderVendorOut[],
  mode?: AddProviderMode,
): ProviderCapability[] {
  const vendor = vendors.find(candidate => candidate.id === providerType)
  if (!vendor) return []
  const t = i18n.t.bind(i18n)
  const capabilities: ProviderCapability[] = []
  if (mode !== 'embedding' && mode !== 'rerank' && vendor.supports_chat) {
    capabilities.push({
      key: 'chat',
      label: t('workspace_ui.providers.capability.chat_label'),
      detail: t('workspace_ui.providers.capability.chat_detail'),
      variant: 'default',
    })
  }
  if (mode !== 'chat' && mode !== 'rerank' && vendor.supports_embedding) {
    capabilities.push({
      key: 'embeddings',
      label: t('workspace_ui.providers.capability.embeddings_label'),
      detail: t('workspace_ui.providers.capability.embeddings_detail'),
      variant: 'secondary',
    })
  }
  if (mode !== 'chat' && mode !== 'embedding' && vendor.supports_rerank) {
    capabilities.push({
      key: 'native_rerank',
      label: t('workspace_ui.providers.capability.rerank_label'),
      detail: t('workspace_ui.providers.capability.rerank_detail'),
      variant: 'outline',
    })
  }
  return capabilities
}

/**
 * Labels and help for the model fields of a provider. Model names in the
 * placeholders are vendor identifiers and stay as they are.
 */
export function modelFieldCopy(providerType: ProviderType | string, mode?: AddProviderMode): ModelFieldCopy {
  const t = i18n.t.bind(i18n)
  const copy = (kind: 'rerank' | 'embedding' | 'retrieval' | 'chat', help: string, defaultPlaceholder: string, availablePlaceholder: string): ModelFieldCopy => ({
    defaultLabel: t(`workspace_ui.providers.model.default_${kind}`),
    availableLabel: t(`workspace_ui.providers.model.available_${kind}`),
    defaultPlaceholder,
    availablePlaceholder,
    help: t(`workspace_ui.providers.model.help_${help}`),
  })
  if (providerType === 'zeroentropy' && mode === 'rerank') return copy('rerank', 'zeroentropy_rerank', 'zerank-2', 'zerank-2, zerank-1, zerank-1-small')
  if (providerType === 'zeroentropy' && mode === 'embedding') return copy('embedding', 'zeroentropy_embedding', 'zembed-1', 'zembed-1')
  if (providerType === 'zeroentropy') return copy('retrieval', 'zeroentropy_any', 'zembed-1', 'zembed-1, zerank-2, zerank-1, zerank-1-small')
  if (providerType === 'cohere' && mode === 'rerank') return copy('rerank', 'cohere_rerank', 'rerank-v4.0-pro', 'rerank-v4.0-pro')
  if (providerType === 'cohere' && mode === 'embedding') return copy('embedding', 'cohere_embedding', 'embed-v4.0', 'embed-v4.0')
  if (providerType === 'cohere') return copy('retrieval', 'cohere_any', 'embed-v4.0', 'embed-v4.0, rerank-v4.0-pro')
  if (mode === 'embedding') {
    return copy(
      'embedding',
      'embedding',
      providerType === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-large',
      providerType === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-large, text-embedding-3-small',
    )
  }
  return copy(
    'chat',
    'chat',
    providerType === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o',
    providerType === 'anthropic' ? 'claude-3-5-sonnet-latest, claude-3-5-haiku-latest' : 'gpt-4o, gpt-4o-mini',
  )
}

export function embeddingDimensionOptions(providerType: ProviderType | string): number[] {
  if (providerType === 'cohere') return [1536, 1024, 512, 256]
  if (providerType === 'zeroentropy') return [2560]
  if (providerType === 'openai' || providerType === 'openrouter' || providerType === 'openai_compatible') return [3072, 2560, 1536, 1024, 512, 256]
  if (providerType === 'ollama') return [768, 1024, 1536, 2560, 4096]
  return [1536, 1024, 512, 256]
}

export function defaultEmbeddingDimensions(providerType: ProviderType | string): string {
  return String(embeddingDimensionOptions(providerType)[0] ?? 1536)
}

export function inferProviderModelMode(config: ModelProviderOut): AddProviderMode | undefined {
  const values = [config.default_model, ...config.available_models]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase())
  if (values.some(value => value.startsWith('rerank') || value.startsWith('zerank') || value.includes('/rerank'))) return 'rerank'
  if (values.some(value => value.startsWith('embed') || value.startsWith('zembed') || value.includes('embedding'))) return 'embedding'
  return undefined
}
