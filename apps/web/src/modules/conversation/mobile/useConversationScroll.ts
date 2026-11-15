import { useLayoutEffect, useRef } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { registerInMemoryResidue, sessionEpoch } from '../../../lib/sessionResidue'
import { useMobileBreakpoint } from './useMobileConversation'

// Numeric reading positions only, bounded and cleared with authenticated residue.
// Never keep another transcript mounted just to remember where it was read.
const positions = new Map<string, number>()
registerInMemoryResidue(() => positions.clear())

export function useConversationScroll(key: string | null, ready: boolean) {
  const mobile = useMobileBreakpoint()
  const remembered = useRef({ key, top: key ? positions.get(key) : undefined })
  if (remembered.current.key !== key) remembered.current = { key, top: key ? positions.get(key) : undefined }
  const scrolling = useStickToBottom({ initial: mobile && remembered.current.top !== undefined ? false : 'smooth', resize: 'smooth' })
  const { scrollRef, stopScroll } = scrolling
  useLayoutEffect(() => {
    if (!mobile || !key || !ready) return
    const element = scrollRef.current
    if (!element) return
    const epoch = sessionEpoch()
    const top = remembered.current.top
    if (top !== undefined) {
      stopScroll()
      element.scrollTop = Math.min(top, Math.max(0, element.scrollHeight - element.clientHeight))
    }
    const save = () => {
      if (epoch !== sessionEpoch()) return
      // At the tail, keep the library's normal live following on re-entry.
      if (element.scrollHeight - element.clientHeight - element.scrollTop < 16) positions.delete(key)
      else {
        positions.delete(key); positions.set(key, element.scrollTop)
        if (positions.size > 100) positions.delete(positions.keys().next().value!)
      }
    }
    element.addEventListener('scroll', save, { passive: true })
    // Save only real scroll events while the owned messages are ready. Cleanup
    // may see a spinner or a detached/emptied DOM and must not overwrite history.
    return () => { element.removeEventListener('scroll', save) }
  }, [mobile, key, ready, scrollRef, stopScroll])
  return scrolling
}
