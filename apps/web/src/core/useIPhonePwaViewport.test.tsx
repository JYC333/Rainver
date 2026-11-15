import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useIPhonePwaViewport } from './useIPhonePwaViewport'
import { useMobileConversation } from '../modules/conversation/mobile/useMobileConversation'

let media: EventTarget & { matches: boolean }
let viewport: EventTarget & { height: number; offsetTop: number; scale: number }
beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: true })
  viewport = Object.assign(new EventTarget(), { height: 812, offsetTop: 0, scale: 1 })
  vi.stubGlobal('innerHeight', 812)
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('navigator', { userAgent: 'iPhone', standalone: true })
  vi.stubGlobal('matchMedia', (query: string) => query === '(max-width: 1023px)' ? media : { matches: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-iphone-pwa')
})
it('keeps C at rest, fits keyboard, respects pinch zoom and cleans only owned state', () => {
  const root = document.documentElement
  root.style.setProperty('--unrelated', 'kept')
  const { unmount } = renderHook(() => useIPhonePwaViewport())
  expect(root.hasAttribute('data-iphone-pwa')).toBe(true)
  expect(root.style.getPropertyValue('--app-pwa-height')).toBe('100vh')
  act(() => { viewport.height = 350; viewport.offsetTop = 24; viewport.dispatchEvent(new Event('resize')) })
  expect(root.style.getPropertyValue('--app-pwa-height')).toBe('350px')
  expect(root.style.getPropertyValue('--app-pwa-top')).toBe('24px')
  act(() => { viewport.scale = 1.5; viewport.dispatchEvent(new Event('scroll')) })
  expect(root.style.getPropertyValue('--app-pwa-height')).toBe('100vh')
  expect(root.style.getPropertyValue('--app-pwa-keyboard-inset')).toBe('0px')
  expect(viewport.scale).toBe(1.5)
  act(() => { viewport.height = 812; viewport.offsetTop = 0; viewport.scale = 1; viewport.dispatchEvent(new Event('resize')) })
  expect(root.style.getPropertyValue('--app-pwa-height')).toBe('100vh')
  act(() => { media.matches = false; media.dispatchEvent(new Event('change')) })
  expect(root.hasAttribute('data-iphone-pwa')).toBe(false)
  expect(root.style.getPropertyValue('--app-pwa-height')).toBe('')
  act(() => { media.matches = true; media.dispatchEvent(new Event('change')) })
  expect(root.hasAttribute('data-iphone-pwa')).toBe(true)
  unmount()
  expect(root.hasAttribute('data-iphone-pwa')).toBe(false)
  expect(root.style.getPropertyValue('--app-pwa-height')).toBe('')
  expect(root.style.getPropertyValue('--unrelated')).toBe('kept')
})
it('uses the same C geometry for Room/sidecar overlays rather than restoring 812px', () => {
  const { unmount } = renderHook(() => { useIPhonePwaViewport(); useMobileConversation(true) })
  const root = document.documentElement
  expect(root.style.getPropertyValue('--conversation-visual-height')).toBe('100vh')
  act(() => { viewport.height = 350; viewport.dispatchEvent(new Event('resize')) })
  expect(root.style.getPropertyValue('--conversation-visual-height')).toBe('350px')
  expect(root.style.getPropertyValue('--app-pwa-height')).toBe('350px')
  act(() => { viewport.height = 812; viewport.dispatchEvent(new Event('resize')) })
  expect(root.style.getPropertyValue('--conversation-visual-height')).toBe('100vh')
  unmount()
  expect(root.hasAttribute('data-mobile-conversation')).toBe(false)
})
it('does not change an iPhone browser tab or a desktop PWA', () => {
  for (const navigator of [{ userAgent: 'iPhone', standalone: false }, { userAgent: 'Linux desktop', standalone: true }]) {
    vi.stubGlobal('navigator', navigator)
    const { unmount } = renderHook(() => useIPhonePwaViewport())
    expect(document.documentElement.hasAttribute('data-iphone-pwa')).toBe(false)
    unmount()
  }
})
it('recognizes installed touch iOS in desktop-request mode without an iPhone UA', () => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5, standalone: true })
  const { unmount } = renderHook(() => useIPhonePwaViewport())
  expect(document.documentElement.hasAttribute('data-iphone-pwa')).toBe(true)
  expect(document.documentElement.style.getPropertyValue('--app-pwa-height')).toBe('100vh')
  unmount()
})
it('never forces root scrolling and ignores idle offsets without a document scroll lock', () => {
  const scrollTo = vi.fn()
  vi.stubGlobal('scrollTo', scrollTo)
  vi.stubGlobal('scrollY', 40)
  const { unmount } = renderHook(() => useIPhonePwaViewport())
  const root = document.documentElement
  for (const offset of [-120, -24, 24, 120, -8, 0]) {
    act(() => { viewport.offsetTop = offset; viewport.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')) })
    expect(root.style.getPropertyValue('--app-pwa-top')).toBe('0px')
    expect(root.style.getPropertyValue('--app-pwa-height')).toBe('100vh')
  }
  act(() => { viewport.height = 350; viewport.offsetTop = 24; viewport.dispatchEvent(new Event('resize')) })
  expect(root.style.getPropertyValue('--app-pwa-top')).toBe('24px')
  act(() => { viewport.height = 812; viewport.scale = 1.5; viewport.dispatchEvent(new Event('scroll')) })
  expect(viewport.scale).toBe(1.5)
  act(() => { viewport.height = 788; viewport.offsetTop = 24; viewport.scale = 1; viewport.dispatchEvent(new Event('resize')) })
  expect(root.style.getPropertyValue('--app-pwa-top')).toBe('0px')
  expect(root.style.getPropertyValue('--app-pwa-height')).toBe('100vh')
  expect(scrollTo).not.toHaveBeenCalled()
  unmount()
  act(() => { viewport.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')) })
  expect(root.style.getPropertyValue('--app-pwa-top')).toBe('')
  expect(scrollTo).not.toHaveBeenCalled()
})
