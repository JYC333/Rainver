// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ModelProviderOut } from '../../api/client'
import { defaultModelProvider } from './defaultProvider'

const provider = (id: string, overrides: Partial<ModelProviderOut> = {}): ModelProviderOut =>
  ({ id, name: id, provider_type: 'openai', enabled: true, is_default: false, default_model: null, ...overrides }) as ModelProviderOut

describe('defaultModelProvider', () => {
  it('prefers the enabled space default over earlier providers', () => {
    const providers = [provider('a'), provider('b', { is_default: true }), provider('c')]
    expect(defaultModelProvider(providers)?.id).toBe('b')
  })

  it('skips a disabled default and a default filtered out by the surface', () => {
    expect(defaultModelProvider([provider('a'), provider('b', { is_default: true, enabled: false })])?.id).toBe('a')
    expect(defaultModelProvider(
      [provider('a'), provider('b', { is_default: true, provider_type: 'custom' as ModelProviderOut['provider_type'] })],
      candidate => candidate.provider_type === 'openai',
    )?.id).toBe('a')
  })

  it('falls back to the first eligible provider and to null when none qualify', () => {
    expect(defaultModelProvider([provider('a'), provider('b')])?.id).toBe('a')
    expect(defaultModelProvider([provider('a', { enabled: false })])).toBeNull()
  })
})
