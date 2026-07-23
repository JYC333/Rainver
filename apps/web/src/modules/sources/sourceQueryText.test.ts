import { describe, expect, it } from 'vitest'
import type { SourceChannel } from '../../types/api'
import { sourceQueryText } from './sourceQueryText'

function channel(provider: string, query: Record<string, unknown>, endpoint_url = 'https://provider.test/very-long-url'): SourceChannel {
  return {
    channel_type: 'search', provider: { key: provider, display_name: provider }, query, endpoint_url,
  } as SourceChannel
}

describe('sourceQueryText', () => {
  it('shows the provider query instead of falling back to the endpoint URL', () => {
    expect(sourceQueryText(channel('openalex', { search: 'agent memory evaluation' }))).toBe('agent memory evaluation')
    expect(sourceQueryText(channel('semantic_scholar', { query: 'agent memory benchmark' }))).toBe('agent memory benchmark')
    expect(sourceQueryText(channel('web_search', { q: 'agent memory report' }))).toBe('agent memory report')
  })
})
