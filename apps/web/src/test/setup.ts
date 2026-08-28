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
}

afterEach(() => {
  if (typeof document === 'undefined') return
  cleanup()
  localStorage.clear()
})
