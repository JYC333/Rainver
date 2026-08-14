import type { ModelProviderOut, ProviderType } from '../../api/client'
import type { AddProviderMode, ModelFieldCopy, ProviderCapability } from './types'

export const PROVIDER_TYPES: { value: ProviderType; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'zeroentropy', label: 'ZeroEntropy' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'openai_compatible', label: 'Other OpenAI-compatible' },
]

const CHAT_PROVIDER_TYPES = new Set<ProviderType>(['openai', 'openai_codex', 'anthropic', 'minimax', 'openrouter', 'deepseek', 'ollama', 'openai_compatible'])
const EMBEDDING_PROVIDER_TYPES = new Set<ProviderType>(['cohere', 'zeroentropy', 'openai', 'openrouter', 'ollama', 'openai_compatible'])
const RERANK_PROVIDER_TYPES = new Set<ProviderType>(['cohere', 'zeroentropy'])

export const API_KEY_REQUIRED = new Set(['openai', 'anthropic', 'minimax', 'openrouter', 'deepseek', 'zeroentropy', 'cohere'])
export const RETRIEVAL_ONLY_PROVIDER_TYPES = new Set(['zeroentropy', 'cohere'])

export function providerTypeOptionsForMode(mode: AddProviderMode): { value: ProviderType; label: string }[] {
  return PROVIDER_TYPES.filter(option => (
    mode === 'chat'
      ? CHAT_PROVIDER_TYPES.has(option.value)
      : mode === 'embedding'
        ? EMBEDDING_PROVIDER_TYPES.has(option.value)
        : RERANK_PROVIDER_TYPES.has(option.value)
  ))
}

export function providerCapabilities(providerType: ProviderType | string, mode?: AddProviderMode): ProviderCapability[] {
  const capabilities: ProviderCapability[] = []
  if (mode !== 'embedding' && mode !== 'rerank' && ['openai', 'openai_codex', 'anthropic', 'minimax', 'openrouter', 'deepseek', 'ollama', 'openai_compatible'].includes(providerType)) {
    capabilities.push({
      key: 'chat',
      label: 'Chat',
      detail: 'Can be used for normal assistant/model calls and query rewrite.',
      variant: 'default',
    })
  }
  if (mode !== 'chat' && mode !== 'rerank' && ['openai', 'openrouter', 'ollama', 'zeroentropy', 'cohere', 'openai_compatible'].includes(providerType)) {
    capabilities.push({
      key: 'embeddings',
      label: 'Embeddings',
      detail: 'Can be used by retrieval vector search.',
      variant: 'secondary',
    })
  }
  if (mode !== 'chat' && mode !== 'embedding' && (providerType === 'zeroentropy' || providerType === 'cohere')) {
    capabilities.push({
      key: 'native_rerank',
      label: 'Native rerank',
      detail: 'Can be used by retrieval hybrid rerank.',
      variant: 'outline',
    })
  }
  return capabilities
}

export function modelFieldCopy(providerType: ProviderType | string, mode?: AddProviderMode): ModelFieldCopy {
  if (providerType === 'zeroentropy' && mode === 'rerank') {
    return {
      defaultLabel: 'Default rerank model',
      availableLabel: 'Available rerank models',
      defaultPlaceholder: 'zerank-2',
      availablePlaceholder: 'zerank-2, zerank-1, zerank-1-small',
      help: 'Use zerank-* models for native rerank in Retrieval Settings.',
    }
  }
  if (providerType === 'zeroentropy' && mode === 'embedding') {
    return {
      defaultLabel: 'Default embedding model',
      availableLabel: 'Available embedding models',
      defaultPlaceholder: 'zembed-1',
      availablePlaceholder: 'zembed-1',
      help: 'Use zembed-* models for retrieval embeddings.',
    }
  }
  if (providerType === 'zeroentropy') {
    return {
      defaultLabel: 'Default retrieval model',
      availableLabel: 'Available retrieval models',
      defaultPlaceholder: 'zembed-1',
      availablePlaceholder: 'zembed-1, zerank-2, zerank-1, zerank-1-small',
      help: 'Use zembed-* for embeddings and zerank-* for native rerank.',
    }
  }
  if (providerType === 'cohere' && mode === 'rerank') {
    return {
      defaultLabel: 'Default rerank model',
      availableLabel: 'Available rerank models',
      defaultPlaceholder: 'rerank-v4.0-pro',
      availablePlaceholder: 'rerank-v4.0-pro',
      help: 'Use Cohere rerank models for native rerank in Retrieval Settings.',
    }
  }
  if (providerType === 'cohere' && mode === 'embedding') {
    return {
      defaultLabel: 'Default embedding model',
      availableLabel: 'Available embedding models',
      defaultPlaceholder: 'embed-v4.0',
      availablePlaceholder: 'embed-v4.0',
      help: 'Use Cohere embed models for retrieval embeddings. Cohere embed-v4 supports 1536, 1024, 512, or 256 dimensions.',
    }
  }
  if (providerType === 'cohere') {
    return {
      defaultLabel: 'Default retrieval model',
      availableLabel: 'Available retrieval models',
      defaultPlaceholder: 'embed-v4.0',
      availablePlaceholder: 'embed-v4.0, rerank-v4.0-pro',
      help: 'Use Cohere embed models for embeddings and Cohere rerank models for native rerank.',
    }
  }
  if (mode === 'embedding') {
    return {
      defaultLabel: 'Default embedding model',
      availableLabel: 'Available embedding models',
      defaultPlaceholder: providerType === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-large',
      availablePlaceholder: providerType === 'ollama'
        ? 'nomic-embed-text'
        : 'text-embedding-3-large, text-embedding-3-small',
      help: 'Use an embeddings-capable model for retrieval. Native rerank only appears for providers with a dedicated rerank endpoint.',
    }
  }
  return {
    defaultLabel: 'Default chat model',
    availableLabel: 'Available chat models',
    defaultPlaceholder: providerType === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o',
    availablePlaceholder: providerType === 'anthropic'
      ? 'claude-3-5-sonnet-latest, claude-3-5-haiku-latest'
      : 'gpt-4o, gpt-4o-mini',
    help: 'Comma-separated model names shown in provider and task selectors.',
  }
}

export function defaultBaseUrl(providerType: ProviderType): string {
  if (providerType === 'openai') return 'https://api.openai.com/v1'
  if (providerType === 'openai_codex') return 'https://chatgpt.com/backend-api'
  if (providerType === 'anthropic') return 'https://api.anthropic.com'
  if (providerType === 'openrouter') return 'https://openrouter.ai/api/v1'
  if (providerType === 'ollama') return 'http://localhost:11434'
  if (providerType === 'zeroentropy') return 'https://api.zeroentropy.dev/v1'
  if (providerType === 'cohere') return 'https://api.cohere.com'
  return ''
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
