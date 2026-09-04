import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup, configure } from '@testing-library/react'

// The rotating full-suite failures were all this timeout, not vitest's: the
// page under test was still showing its Suspense fallback because the lazy
// chunk had not finished transforming. Under parallel load that can take well
// over five seconds for a page that renders instantly on its own. vitest's own
// 30s testTimeout still bounds a test that is genuinely stuck.
// Keep this below `maxTestMs` in src/test/perf-budget.json: a test allowed to
// wait this long for the DOM cannot also be budgeted at the same number.
configure({ asyncUtilTimeout: 15000 })

// Pure-logic test files opt out of jsdom with `@vitest-environment node`;
// the DOM shims and the per-test DOM cleanup only apply where a DOM exists.
if (typeof document !== 'undefined') {
  if (!document.elementFromPoint) {
    document.elementFromPoint = () => document.body
  }

  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  }

  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect()
  }

  if (!HTMLElement.prototype.getClientRects) {
    HTMLElement.prototype.getClientRects = () => [] as unknown as DOMRectList
  }

  if (!HTMLElement.prototype.getBoundingClientRect) {
    HTMLElement.prototype.getBoundingClientRect = () => new DOMRect()
  }

  // jsdom has no ResizeObserver, and the conversation view's stick-to-bottom
  // scrolling constructs one on mount — without this, every conversation
  // surface fails to render at all.
  //
  // It reports once on `observe`, rather than never, so a component that
  // sizes itself from the observer sees the same first callback it would in a
  // browser. Nothing currently depends on that — both existing consumers
  // measure explicitly as well — but a silent observer is a stub that quietly
  // disagrees with the environment it stands in for.
  if (!('ResizeObserver' in globalThis)) {
    class TestResizeObserver implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        const box = { inlineSize: 0, blockSize: 0 } as ResizeObserverSize
        this.callback([{
          target,
          contentRect: target.getBoundingClientRect(),
          borderBoxSize: [box], contentBoxSize: [box], devicePixelContentBoxSize: [box],
        }], this)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
  }
}

afterEach(() => {
  if (typeof document === 'undefined') return
  cleanup()
  localStorage.clear()
})
