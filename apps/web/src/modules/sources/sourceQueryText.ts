import type { SourceChannel } from '../../types/api'

export function sourceQueryText(channel: Pick<SourceChannel, 'channel_type' | 'provider' | 'query' | 'endpoint_url'>): string {
  if (channel.channel_type !== 'search') return channel.endpoint_url ?? 'Configured monitor'
  if (channel.provider.key === 'arxiv' && channel.query.mode === 'all') return 'All arXiv papers'
  if (channel.provider.key === 'arxiv' && channel.query.mode === 'recent_by_category') {
    const categories = Array.isArray(channel.query.categories) ? channel.query.categories.join(', ') : ''
    return categories ? `Categories: ${categories}` : 'arXiv category stream'
  }
  for (const value of [channel.query.search_query, channel.query.search, channel.query.query, channel.query.q]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return 'Configured academic search'
}
