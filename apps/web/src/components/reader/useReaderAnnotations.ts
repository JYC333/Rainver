import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readerApi } from '../../api/client'
import type { ReaderAnnotation } from '../../types/api'
import { clearDocumentCommentDrafts, readerDraftScopeKey, retainCommentDrafts, type ReaderDraftScope } from './commentDrafts'
import { annotationBodyWithheld, type ReaderAnnotationAuthority, type ReaderAnnotationChange, type ReaderAnnotationsStatus } from './readerModel'

/** 401/403/404: the list (and anything derived from it) is no longer the person's to see. */
export function isReaderAccessError(error: unknown): boolean {
  const status = error && typeof error === 'object' && 'status' in error ? (error as { status: unknown }).status : null
  return status === 401 || status === 403 || status === 404
}

/**
 * A document's annotation list for a Reader wrapper, loaded independently of
 * the document so a list failure never hides readable text.
 *
 * Ordering: only the latest request for the current scope may answer, and a
 * list request that was in flight while this tab created or removed an
 * annotation is a stale snapshot — it is discarded and fetched again rather
 * than allowed to roll the confirmed change back. An access error clears the
 * list and the document's unsent drafts; any other error keeps what this
 * scope already confirmed and offers a retry.
 *
 * Authority: an access error advances an authority epoch, and so does the
 * next successful read after it. A create or archive takes the epoch when it
 * starts (`authority.begin()`), and its response may change the list only if
 * the epoch, the scope and access are unchanged (`authority.accepts()`). So a
 * POST that the server accepted before access was refused, but that answers
 * after, cannot bring a refused quote back — not even once access returns;
 * only a new authoritative read can show it.
 */
export function useReaderAnnotations(scope: ReaderDraftScope | null) {
  const scopeKey = scope ? readerDraftScopeKey(scope) : ''
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>([])
  const [state, setState] = useState<{ state: 'loading' } | { state: 'error'; error: unknown } | null>(scope ? { state: 'loading' } : null)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const currentKey = useRef(scopeKey)
  const request = useRef(0)
  const mutations = useRef(0)
  const epoch = useRef(0)
  const denied = useRef(false)

  const load = useCallback(() => {
    const target = scopeRef.current
    if (!target) return
    const key = readerDraftScopeKey(target)
    const id = ++request.current
    const mutationsAtStart = mutations.current
    setState({ state: 'loading' })
    const current = () => currentKey.current === key && request.current === id
    readerApi.listAnnotations(target.documentType, target.documentId)
      .then(result => {
        if (!current()) return
        if (mutations.current !== mutationsAtStart) { load(); return }
        // Access is back: nothing started under the refusal or before it may apply.
        if (denied.current) { denied.current = false; epoch.current += 1 }
        setAnnotations(result.items); setState(null)
        // Only annotations listed with their full body may keep an unsent comment.
        retainCommentDrafts(target, result.items.filter(item => item.status === 'active' && !annotationBodyWithheld(item)).map(item => item.id))
      })
      .catch(error => {
        if (!current()) return
        if (isReaderAccessError(error)) {
          denied.current = true; epoch.current += 1
          setAnnotations([]); clearDocumentCommentDrafts(target)
        }
        setState({ state: 'error', error })
      })
  }, [])

  useEffect(() => {
    currentKey.current = scopeKey
    denied.current = false; epoch.current += 1
    setAnnotations([])
    if (!scopeKey) { setState(null); return }
    load()
    return () => { currentKey.current = '' }
  }, [scopeKey, load])

  /**
   * Local changes confirmed by the server (create, archive). Refused outright
   * while access is refused, whoever calls it; callers also check
   * `authority.accepts()` so a change started before a refusal stays out after
   * access returns.
   */
  const onAnnotationsChange = useCallback((items: ReaderAnnotation[]) => {
    if (denied.current) return
    mutations.current += 1
    setAnnotations(items)
  }, [])

  const authority = useMemo<ReaderAnnotationAuthority>(() => ({
    begin: () => ({ scopeKey: currentKey.current, epoch: epoch.current }),
    accepts: (change: ReaderAnnotationChange) => !denied.current && change.scopeKey === currentKey.current && change.epoch === epoch.current,
  }), [])

  const status = useMemo<ReaderAnnotationsStatus | undefined>(() => state?.state === 'error'
    ? { state: 'error', error: state.error, retry: load }
    : state ?? undefined, [load, state])

  return { annotations, onAnnotationsChange, status, reload: load, authority }
}
