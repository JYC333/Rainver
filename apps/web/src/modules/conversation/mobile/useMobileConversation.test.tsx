import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileConversation } from './useMobileConversation'

afterEach(() => { vi.unstubAllGlobals(); document.documentElement.removeAttribute('style') })
it('contains only the unzoomed visible viewport and restores all global state on exit', () => {
  const media = Object.assign(new EventTarget(), { matches: true })
  const viewport = Object.assign(new EventTarget(), { height: 350, offsetTop: 24, scale: 1 })
  vi.stubGlobal('matchMedia', () => media)
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  const { rerender, unmount } = renderHook(({ enabled }) => useMobileConversation(enabled), { initialProps: { enabled: true } })
  const root = document.documentElement
  expect(root.hasAttribute('data-mobile-conversation')).toBe(true)
  expect(root.style.getPropertyValue('--conversation-visual-height')).toBe('350px')
  expect(root.style.getPropertyValue('--conversation-visual-top')).toBe('24px')
  act(() => { viewport.scale = 1.5; viewport.dispatchEvent(new Event('resize')) })
  expect(root.style.getPropertyValue('--conversation-visual-height')).toBe('100dvh')
  expect(root.style.getPropertyValue('--conversation-visual-top')).toBe('0px')
  act(() => { media.matches = false; media.dispatchEvent(new Event('change')) })
  expect(root.hasAttribute('data-mobile-conversation')).toBe(false)
  rerender({ enabled: false })
  expect(root.style.getPropertyValue('--conversation-visual-height')).toBe('')
  unmount()
  expect(root.hasAttribute('data-mobile-conversation')).toBe(false)
  delete (window as unknown as { visualViewport?: unknown }).visualViewport
})
