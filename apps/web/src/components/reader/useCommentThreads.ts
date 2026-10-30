import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readerApi } from '../../api/client'
import type { ReaderCommentThread } from '../../types/api'
import type { ReaderThreadsStatus } from './readerModel'
import { isReaderAccessError } from './useReaderAnnotations'

/**
 * Comment threads of the annotation shown in the inspector.
 *
 * Reads: only the latest request for the shown annotation of the current
 * document answers, and a list requested before a comment or status change
 * for that annotation completed is refetched instead of rolling it back.
 *
 * Writes: each response is applied as a merge of only what that write changed
 * (a comment POST adds its comment, a resolve/reopen sets the status), so the
 * two kinds commute and a late snapshot cannot roll the other back. When writes
 * for the same annotation overlapped, the threads are also read again from the
 * server once the last one settles, so what is shown ends as the server's
 * state. Loading and failure are states, never shown as "no comments".
 */
export function useCommentThreads({ documentKey, onAccessLost }: {
  documentKey: string
  /** The shown annotation's threads returned 401/403/404. */
  onAccessLost: (annotationId: string, error: unknown) => void
}) {
  const [threads, setThreads] = useState<ReaderCommentThread[]>([])
  const [state, setState] = useState<{ annotationId: string; state: 'loading' } | { annotationId: string; state: 'error'; error: unknown } | null>(null)
  const [shownId, setShownId] = useState<string | null>(null)
  const shown = useRef<string | null>(null)
  const documentRef = useRef(documentKey)
  documentRef.current = documentKey
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const onAccessLostRef = useRef(onAccessLost)
  onAccessLostRef.current = onAccessLost
  const request = useRef(0)
  const completedWrites = useRef(new Map<string, number>())
  const writes = useRef(new Map<string, { inFlight: number; overlapped: boolean }>())

  const isShown = (annotationId: string, key: string) => mounted.current && key === documentRef.current && shown.current === annotationId

  const load = useCallback((annotationId: string) => {
    const id = ++request.current
    const key = documentRef.current
    const writesAtStart = completedWrites.current.get(annotationId) ?? 0
    const current = () => request.current === id && isShown(annotationId, key)
    setState({ annotationId, state: 'loading' })
    readerApi.listThreads(annotationId)
      .then(result => {
        if (!current()) return
        if ((completedWrites.current.get(annotationId) ?? 0) !== writesAtStart) { load(annotationId); return }
        setThreads(result.items); setState(null)
      })
      .catch(error => {
        if (!current()) return
        setState({ annotationId, state: 'error', error })
        if (isReaderAccessError(error)) { setThreads([]); onAccessLostRef.current(annotationId, error) }
      })
  }, [])

  /**
   * Shows an annotation's threads (null hides them) and drops any in-flight
   * read. `fetch: false` is for an annotation just created, which has none.
   */
  const show = useCallback((annotationId: string | null, { fetch = true }: { fetch?: boolean } = {}) => {
    shown.current = annotationId
    setShownId(annotationId)
    request.current += 1
    setThreads([]); setState(null)
    if (annotationId && fetch) load(annotationId)
  }, [load])

  useEffect(() => {
    shown.current = null; setShownId(null); request.current += 1
    setThreads([]); setState(null)
    writes.current.clear()
  }, [documentKey])

  /** Runs a confirmed-by-server write for `annotationId`, coordinated as described above. */
  const write = useCallback(async <R,>(annotationId: string, run: () => Promise<R>, apply: (result: R) => (current: ReaderCommentThread[]) => ReaderCommentThread[]): Promise<R> => {
    const key = documentRef.current
    const entry = writes.current.get(annotationId) ?? { inFlight: 0, overlapped: false }
    if (entry.inFlight > 0) entry.overlapped = true
    entry.inFlight += 1
    writes.current.set(annotationId, entry)
    const settle = (result: { ok: true; value: R } | { ok: false }) => {
      entry.inFlight -= 1
      completedWrites.current.set(annotationId, (completedWrites.current.get(annotationId) ?? 0) + 1)
      if (result.ok && isShown(annotationId, key)) setThreads(apply(result.value))
      if (entry.inFlight > 0) return
      writes.current.delete(annotationId)
      if (entry.overlapped) {
        entry.overlapped = false
        if (isShown(annotationId, key)) load(annotationId)
      }
    }
    try {
      const value = await run()
      settle({ ok: true, value })
      return value
    } catch (error) {
      settle({ ok: false })
      throw error
    }
  }, [load])

  const status = useMemo<ReaderThreadsStatus | undefined>(() => {
    if (!state || state.annotationId !== shownId) return undefined
    return state.state === 'error' ? { state: 'error', error: state.error, retry: () => load(state.annotationId) } : { state: 'loading' }
  }, [load, shownId, state])

  return useMemo(() => ({ threads, status, show, reload: load, write }), [threads, status, show, load, write])
}
