import { useLayoutEffect, useSyncExternalStore } from 'react'
import { isIPhonePwa, mobileViewportGeometry } from '../../../core/useIPhonePwaViewport'

const subscribe = (changed: () => void) => {
  const media = window.matchMedia?.('(max-width: 1023px)')
  media?.addEventListener?.('change', changed)
  return () => media?.removeEventListener?.('change', changed)
}
const snapshot = () => window.matchMedia?.('(max-width: 1023px)').matches ?? false
export function useMobileBreakpoint() { return useSyncExternalStore(subscribe, snapshot, () => false) }
/** Conversation viewport owner, sharing the iPhone PWA Shell's geometry.
 * Pinch zoom is never interpreted as a keyboard.
 * Like ReaderWorkspace, consume visualViewport resize AND scroll and clean up.
 * The Shell consumes safe areas; consumers must not add another bottom inset.
 */
export function useMobileConversation(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled || typeof window.matchMedia !== 'function') return
    const root = document.documentElement
    const media = window.matchMedia('(max-width: 1023px)')
    const viewport = window.visualViewport
    const update = () => {
      root.toggleAttribute('data-mobile-conversation', media.matches)
      const { height, top, overlap } = mobileViewportGeometry(viewport, isIPhonePwa())
      root.style.setProperty('--conversation-visual-top', `${top}px`)
      root.style.setProperty('--conversation-visual-height', height)
      root.style.setProperty('--conversation-keyboard-inset', `${overlap}px`)
    }
    update()
    media.addEventListener?.('change', update)
    window.addEventListener('resize', update)
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    return () => {
      root.removeAttribute('data-mobile-conversation')
      for (const key of ['top', 'height']) root.style.removeProperty(`--conversation-visual-${key}`)
      root.style.removeProperty('--conversation-keyboard-inset')
      media.removeEventListener?.('change', update)
      window.removeEventListener('resize', update)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
    }
  }, [enabled])
}
