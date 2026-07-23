import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

/**
 * Debounced auto-save state machine shared by every free-text editor surface
 * (Notes, Research Notebook sections, …) — no editor should require a manual
 * "Save" button. `onSave` is read fresh on every call via a ref, so callers
 * can pass an inline closure without worrying about staleness; it should
 * read whatever latest content/version it needs at call time, throw on
 * failure, and report its own error (toast) before throwing — `performSave`
 * swallows the rejection after recording `state: 'error'` so the internal
 * debounce timer and unmount-flush never produce an unhandled rejection.
 */
export function useAutosave(
  onSave: () => Promise<void>,
  options: {
    delayMs?: number
    /** Change this (e.g. the id of the thing being edited) to also flush a
     *  pending save on switch, not just on full unmount — only fires if a
     *  debounced save is actually pending. */
    flushKey?: unknown
  } = {},
) {
  const { delayMs = 800, flushKey } = options
  const [state, setState] = useState<SaveState>('saved')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const performSave = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setState('saving')
    try {
      await onSaveRef.current()
      setState(prev => (prev === 'saving' ? 'saved' : prev))
    } catch {
      setState('error')
    }
  }, [])

  const scheduleSave = useCallback(() => {
    setState('dirty')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void performSave() }, delayMs)
  }, [performSave, delayMs])

  // Flush a pending debounced save on unmount, and whenever `flushKey`
  // changes (e.g. switching to a different note/section while this same
  // component instance stays mounted), so the last edit is never silently
  // lost. Only fires if a save is actually pending.
  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      void performSave()
    }
  }, [performSave, flushKey])

  // Cmd/Ctrl+S forces an immediate save and suppresses the browser dialog.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void performSave()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [performSave])

  return { state, setState, scheduleSave, performSave }
}
