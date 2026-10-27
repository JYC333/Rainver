import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReadingPage, ReadingStateRequest } from '@rainver/protocol'
import { informationDigestsApi } from '../../api/client'

/** Transports server pages; never derives membership, grouping, counts or cursors. */
export function useReading(spaceId: string | null, projectId?: string, view: 'pending' | 'read' | 'all' = 'pending', q = '', limit = 30) {
  const key = JSON.stringify([spaceId, projectId, view, q, limit])
  const current = useRef(key)
  current.current = key
  const generation = useRef(0)
  const mutation = useRef(0)
  const transport = useRef<AbortController | null>(null)
  const [result, setResult] = useState<{ key: string; page: ReadingPage } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const page = result?.key === key ? result.page : null
  const load = useCallback(async (cursor?: string, windowSize?: number) => {
    transport.current?.abort()
    const controller = new AbortController()
    transport.current = controller
    const request = ++generation.current
    if (!spaceId) return
    const active = () => !controller.signal.aborted && current.current === key && request === generation.current
    setLoading(true); setError(null)
    // A successful write revalidates the existing window in place. All
    // other first-page reads (including preference changes) drop stale content.
    if (!cursor && windowSize === undefined) setResult(null)
    try {
      const wanted = windowSize ?? limit
      const read = (size: number, after?: string) => informationDigestsApi.reading(
        spaceId, { view, q: q || undefined, limit: size, cursor: after }, projectId, { signal: controller.signal },
      )
      let next = await read(Math.min(100, wanted), cursor)
      if (!active()) return
      // The API caps each page at 100. Re-walk a larger loaded window using
      // only its fresh opaque cursors; publish atomically after every page passes.
      while (windowSize !== undefined && next.items.length < wanted && next.next_cursor) {
        const following = await read(Math.min(100, wanted - next.items.length), next.next_cursor)
        if (!active()) return
        next = { ...following, items: [...next.items, ...following.items] }
        if (following.items.length === 0) break
      }
      setResult(previous => ({ key, page: cursor && previous?.key === key
        ? { ...next, items: [...previous.page.items, ...next.items] } : next }))
    } catch (failure) {
      if (!active()) return
      // Includes failed writes/revalidation, revoked ACL and changed cursors.
      setResult(null); setError(failure)
    } finally { if (active()) setLoading(false) }
  }, [spaceId, projectId, view, q, limit, key])
  useEffect(() => {
    setResult(null); setError(null); setBusy(false)
    void load()
    return () => { generation.current++; mutation.current++; transport.current?.abort() }
  }, [load])
  const change = async (itemId: string, body: ReadingStateRequest) => {
    if (!spaceId || busy) return
    transport.current?.abort()
    const request = ++generation.current
    const action = ++mutation.current
    const windowSize = Math.max(limit, page?.items.length ?? 0)
    setBusy(true); setLoading(false); setError(null)
    try {
      // Do not abort mutations: a transport cancellation cannot undo a write.
      await informationDigestsApi.readingState(spaceId, itemId, body, projectId)
      if (current.current === key && request === generation.current) await load(undefined, windowSize)
    } catch (failure) {
      if (current.current === key && request === generation.current) { setResult(null); setError(failure) }
    } finally { if (current.current === key && action === mutation.current) setBusy(false) }
  }
  return { page, loading, error, busy, reload: () => load(), refresh: () => load(undefined, Math.max(limit, page?.items.length ?? 0)), more: () => page?.next_cursor ? load(page.next_cursor) : Promise.resolve(), change }
}
