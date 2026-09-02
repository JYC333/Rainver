import { useEffect } from 'react'

/**
 * Keeps a read surface current while it is on screen.
 *
 * A read refresh cadence only — nothing here decides anything. Two triggers:
 * the tab becoming visible again (a backgrounded tab must not show a stale
 * situation on return), and a fixed interval while it is visible. The same
 * shape the Inquiry Area uses for a live Thread; without it the Board and
 * Pulse loaded once on arrival, so work an Agent recorded from the Room
 * appeared only after leaving the page and coming back.
 *
 * `refresh` must be quiet: it is called while the person is looking at the
 * surface, so it must not put a skeleton over what is already drawn.
 */
export function usePeriodicRefresh(refresh: () => void | Promise<void>, intervalMs: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, intervalMs)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(interval)
    }
  }, [refresh, intervalMs, enabled])
}
