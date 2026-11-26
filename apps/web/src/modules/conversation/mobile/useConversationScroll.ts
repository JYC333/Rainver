import { useLayoutEffect, useRef } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'

export function useConversationScroll(key: string | null, ready: boolean) {
  const scrolling = useStickToBottom({ initial: 'instant', resize: 'smooth' })
  const { scrollRef, scrollToBottom } = scrolling
  const positionedKey = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (!ready || !key) {
      positionedKey.current = null
      return
    }
    const element = scrollRef.current
    if (!element || positionedKey.current === key) return
    positionedKey.current = key
    // Start at the newest message before paint and resume live following.
    element.scrollTop = element.scrollHeight
    void scrollToBottom({ animation: 'instant' })
  }, [key, ready, scrollRef, scrollToBottom])

  return scrolling
}
