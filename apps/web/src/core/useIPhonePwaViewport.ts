import { useLayoutEffect } from 'react'

/** Include iOS desktop-request user agents; UA spelling is not the device gate. */
export function isIPhonePwa() {
  const legacyStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  const touch = navigator.maxTouchPoints > 0 || Boolean(window.matchMedia?.('(pointer: coarse)').matches)
  const ios = /iPhone|iPod|iPad/.test(navigator.userAgent)
    || (touch && (/Macintosh|MacIntel/.test(`${navigator.userAgent} ${navigator.platform}`) || legacyStandalone))
  return ios && (legacyStandalone || Boolean(window.matchMedia?.('(display-mode: standalone)').matches))
}

/** Shared with full-screen conversation overlays so they do not change the installed layout at rest.
 * A status-bar-sized discrepancy is not a keyboard; pinch zoom is never one.
 */
export function mobileViewportGeometry(viewport: VisualViewport | null, installedPwa = false) {
  const unzoomed = viewport && Math.abs(viewport.scale - 1) < 0.01
  // Negative edge-bounce offsets are not lost keyboard space.
  const overlap = unzoomed ? Math.max(0, innerHeight - viewport.height - Math.max(0, viewport.offsetTop)) : 0
  const keyboard = overlap > 80
  const useVisual = unzoomed && (!installedPwa || keyboard)
  return { height: useVisual ? `${viewport.height}px` : '100dvh',
    top: useVisual ? Math.max(0, viewport?.offsetTop ?? 0) : 0, overlap: installedPwa && !keyboard ? 0 : overlap }
}

export function useIPhonePwaViewport() {
  useLayoutEffect(() => {
    if (!isIPhonePwa()) return
    const root = document.documentElement
    const media = window.matchMedia('(max-width: 1023px)')
    const viewport = window.visualViewport
    const clear = () => {
      root.removeAttribute('data-iphone-pwa')
      for (const key of ['height', 'top', 'keyboard-inset']) root.style.removeProperty(`--app-pwa-${key}`)
    }
    const update = () => {
      if (!media.matches) { clear(); return }
      root.setAttribute('data-iphone-pwa', '')
      const { height, top, overlap } = mobileViewportGeometry(viewport, true)
      root.style.setProperty('--app-pwa-height', height)
      root.style.setProperty('--app-pwa-top', `${top}px`)
      root.style.setProperty('--app-pwa-keyboard-inset', `${overlap}px`)

    }
    update()
    media.addEventListener('change', update)
    window.addEventListener('resize', update)
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    return () => {
      clear()
      media.removeEventListener('change', update)
      window.removeEventListener('resize', update)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
    }
  }, [])
}
