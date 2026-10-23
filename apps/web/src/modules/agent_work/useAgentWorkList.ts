import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentAttentionQueryInput, AgentAttentionReadState } from '@rainver/protocol'
import { useAttention } from './AgentAttentionProvider'
import { PERSONAL_QUERY, queryKey } from './attentionStore'
export { failureKind } from './attentionStore'

/** All aggregate reads belong to the Shell provider; filters never affect its personal feed. */
export function useAgentWorkList(query: AgentAttentionQueryInput) {
  const { store } = useAttention()
  const key = queryKey(query)
  const entry = useMemo(() => store.entry(key), [store, key])
  const subscribe = useCallback((listener: () => void) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener) } }, [entry])
  const state = useSyncExternalStore(subscribe, () => entry.state)
  useEffect(() => {
    store.entries.set(key, entry)
    if (key === PERSONAL_QUERY ? entry.pages > 1 : !entry.state.page) void store.refresh(entry)
    return () => { if (key !== PERSONAL_QUERY) queueMicrotask(() => { if (entry.listeners.size === 0 && store.entries.get(key) === entry) { clearTimeout(entry.timer); entry.request?.abort(); entry.token++; store.entries.delete(key) } }) }
  }, [store, entry, key])
  const refresh = useCallback((cursor?: string) => store.refresh(entry, cursor, true), [store, entry])
  const update = useCallback((workKey: string, next: AgentAttentionReadState) => store.update(workKey, next), [store])
  return { ...state, refresh, update }
}
