import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentAttentionQueryInput, AgentAttentionReadState } from '@rainver/protocol'
import { useAttention, useOptionalAttention } from './AgentAttentionProvider'
import { PERSONAL_QUERY, queryKey } from './attentionStore'
export { failureKind } from './attentionStore'

/** All aggregate reads belong to the Shell provider; filters never affect its personal feed. */
export function useAgentWorkList(query: AgentAttentionQueryInput) {
  useAttention()
  return useOptionalAgentWorkList(query)
}

const EMPTY_STATE = { page: null, error: null, loading: false }
/** Read-only consumers can also render outside the authenticated Shell. */
export function useOptionalAgentWorkList(query: AgentAttentionQueryInput, enabled = true) {
  const context = useOptionalAttention()
  const store = enabled ? context?.store : undefined
  const key = queryKey(query)
  const entry = useMemo(() => store?.entry(key), [store, key])
  const subscribe = useCallback((listener: () => void) => { entry?.listeners.add(listener); return () => { entry?.listeners.delete(listener) } }, [entry])
  const state = useSyncExternalStore(subscribe, () => entry?.state ?? EMPTY_STATE)
  useEffect(() => {
    if (!store || !entry) return
    store.entries.set(key, entry)
    if (key === PERSONAL_QUERY ? entry.pages > 1 : !entry.state.page) void store.refresh(entry)
    return () => { if (key !== PERSONAL_QUERY) queueMicrotask(() => { if (entry.listeners.size === 0 && store.entries.get(key) === entry) { clearTimeout(entry.timer); entry.request?.abort(); entry.token++; store.entries.delete(key) } }) }
  }, [store, entry, key])
  const refresh = useCallback((cursor?: string) => {
    if (!store || !entry || cursor && entry.state.loading) return Promise.resolve()
    return store.refresh(entry, cursor, true)
  }, [store, entry])
  const update = useCallback((workKey: string, next: AgentAttentionReadState) => store?.update(workKey, next), [store])
  return { ...state, refresh, update }
}
