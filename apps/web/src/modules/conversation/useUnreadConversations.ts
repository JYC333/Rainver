import { useEffect, useMemo } from 'react'
import { useOptionalAgentWorkList } from '../agent_work/useAgentWorkList'

/** Same per-user projection and SSE invalidation as Agent Work, with no read writes. */
export function useUnreadConversations(spaceId: string | undefined, projectId: string | undefined, enabled = true) {
  const { page, loading, error, refresh } = useOptionalAgentWorkList({
    scope: 'all_visible', space_id: spaceId, project_id: projectId, limit: 100,
  }, enabled && Boolean(spaceId && projectId))
  // Do not silently drop conversations beyond the first transport page.
  useEffect(() => {
    if (page?.next_cursor && !loading && !error) void refresh(page.next_cursor)
  }, [page?.next_cursor, loading, error, refresh])
  return useMemo(() => {
    const ids = new Set<string>()
    if (error) return ids
    for (const item of page?.items ?? []) {
      if (item.space_id !== spaceId || item.project_id !== projectId || !item.unread) continue
      if (item.identity.kind === 'session') ids.add(item.identity.source_id)
      for (const id of item.unread_session_ids ?? []) ids.add(id)
    }
    return ids
  }, [page, error, spaceId, projectId])
}
