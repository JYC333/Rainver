import { act, render, screen } from '@testing-library/react'
import { useMemo, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useConversationScroll } from './useConversationScroll'

vi.mock('use-stick-to-bottom', () => ({ useStickToBottom: () => {
  const scrollRef = useRef<HTMLDivElement>(null)
  return useMemo(() => ({ scrollRef, stopScroll: vi.fn() }), [])
} }))
afterEach(() => vi.unstubAllGlobals())
function Fixture({ scope, ready }: { scope: string; ready: boolean }) {
  const scrolling = useConversationScroll(scope, ready)
  return <div data-testid="scroll" ref={scrolling.scrollRef} />
}
function dimensions(element: HTMLElement, height: number) {
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: height }, clientHeight: { configurable: true, value: 200 } })
}
it('waits for owned messages and never overwrites a reading position with spinner or old DOM cleanup', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  const view = render(<Fixture scope="scroll-a" ready />)
  const element = screen.getByTestId('scroll')
  dimensions(element, 2000)
  act(() => { element.scrollTop = 150; element.dispatchEvent(new Event('scroll')) })
  // A switch first commits without the destination's messages. The spinner's
  // dimensions are not a reading position for either conversation.
  dimensions(element, 0)
  view.rerender(<Fixture scope="scroll-b" ready={false} />)
  act(() => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  dimensions(element, 2000)
  view.rerender(<Fixture scope="scroll-b" ready />)
  act(() => { element.scrollTop = 75; element.dispatchEvent(new Event('scroll')) })
  dimensions(element, 0)
  view.rerender(<Fixture scope="scroll-a" ready={false} />)
  act(() => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  expect(element.scrollTop).toBe(0)
  dimensions(element, 2000)
  view.rerender(<Fixture scope="scroll-a" ready />)
  expect(element.scrollTop).toBe(150)
  // Unmount after DOM collapse must not replace the valid position with zero.
  dimensions(element, 0); element.scrollTop = 0
  view.unmount()
  const next = render(<Fixture scope="scroll-a" ready={false} />)
  const restored = screen.getByTestId('scroll'); dimensions(restored, 2000)
  next.rerender(<Fixture scope="scroll-a" ready />)
  expect(restored.scrollTop).toBe(150)
})
