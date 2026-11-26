import { act, render, screen } from '@testing-library/react'
import { useMemo, useRef } from 'react'
import { expect, it, vi } from 'vitest'
import { useConversationScroll } from './useConversationScroll'

vi.mock('use-stick-to-bottom', () => ({ useStickToBottom: () => {
  const scrollRef = useRef<HTMLDivElement>(null)
  return useMemo(() => ({ scrollRef, scrollToBottom: vi.fn() }), [])
} }))
function Fixture({ scope, ready }: { scope: string; ready: boolean }) {
  const scrolling = useConversationScroll(scope, ready)
  return <div data-testid="scroll" ref={scrolling.scrollRef} />
}
function dimensions(element: HTMLElement, height: number) {
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: height }, clientHeight: { configurable: true, value: 200 } })
}
it('opens at the latest message only after the destination transcript is ready', () => {
  const view = render(<Fixture scope="scroll-a" ready={false} />)
  const element = screen.getByTestId('scroll')
  dimensions(element, 2000)
  expect(element.scrollTop).toBe(0)
  view.rerender(<Fixture scope="scroll-a" ready />)
  expect(element.scrollTop).toBe(2000)
  act(() => { element.scrollTop = 150 })
  view.rerender(<Fixture scope="scroll-a" ready />)
  expect(element.scrollTop).toBe(150)
  view.rerender(<Fixture scope="scroll-b" ready={false} />)
  expect(element.scrollTop).toBe(150)
  dimensions(element, 1200)
  view.rerender(<Fixture scope="scroll-b" ready />)
  expect(element.scrollTop).toBe(1200)
})
