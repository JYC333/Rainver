import { useEffect, useRef, type RefObject } from 'react'
import { sessionEpoch } from '../../lib/sessionResidue'

/** Optional article navigation, limited to top-level prose. No gesture library
 * or document-wide interception; tables/code/media retain native panning. */
export function useReaderArticleSwipe(ref: RefObject<HTMLElement | null>, enabled: boolean, scope: string, previous: () => void, next: () => void) {
  const revision = useRef({ scope, generation: 0 })
  if (revision.current.scope !== scope) { revision.current.scope = scope; revision.current.generation++ }
  const active = useRef(enabled); active.current = enabled
  const actions = useRef({ previous, next }); actions.current = { previous, next }
  useEffect(() => {
    if (!enabled) return
    const workspace = ref.current?.closest<HTMLElement>('.reader-workspace')
    const shell = workspace?.querySelector<HTMLElement>('.reader-document-shell')
    if (!workspace || !shell) return
    const generation = revision.current.generation
    workspace.classList.add('reader-swipe-enabled')
    let start: { id: number; x: number; y: number; at: number; epoch: number } | null = null
    const cancel = () => { start = null }
    const selected = () => window.getSelection()?.isCollapsed === false
    const down = (event: PointerEvent) => {
      if (!active.current || revision.current.generation !== generation) return
      if (start || event.isPrimary === false) { cancel(); return }
      if (event.pointerType !== 'touch' || event.button !== 0 || selected()) return
      const target = event.target instanceof Element ? event.target : null
      if (!target || target.closest('a,button,input,textarea,select,[contenteditable="true"],table,pre,code,img,video,audio,figure')) return
      const block = target.closest('.reader-surface > p, .reader-surface > h1, .reader-surface > h2, .reader-surface > h3, .reader-surface > h4, .reader-surface > h5, .reader-surface > h6')
      if (!block || !shell.contains(block)) return
      start = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), epoch: sessionEpoch() }
    }
    const move = (event: PointerEvent) => {
      if (start && event.pointerId === start.id && Math.abs(event.clientY - start.y) > 24) cancel()
    }
    const up = (event: PointerEvent) => {
      const began = start; cancel()
      if (!active.current || revision.current.generation !== generation || !began || event.pointerId !== began.id || began.epoch !== sessionEpoch() || selected()) return
      const x = event.clientX - began.x, y = event.clientY - began.y
      if (Math.abs(x) < 80 || Math.abs(x) < Math.abs(y) * 3 || performance.now() - began.at > 600) return
      if (x < 0) actions.current.next(); else actions.current.previous()
    }
    shell.addEventListener('pointerdown', down, { passive: true })
    shell.addEventListener('pointermove', move, { passive: true })
    shell.addEventListener('pointerup', up, { passive: true })
    shell.addEventListener('pointercancel', cancel)
    shell.addEventListener('contextmenu', cancel)
    return () => {
      cancel(); workspace.classList.remove('reader-swipe-enabled')
      shell.removeEventListener('pointerdown', down); shell.removeEventListener('pointermove', move)
      shell.removeEventListener('pointerup', up); shell.removeEventListener('pointercancel', cancel); shell.removeEventListener('contextmenu', cancel)
    }
  }, [ref, enabled, scope])
}
