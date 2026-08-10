import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup, configure } from '@testing-library/react'

// The rotating full-suite failures were all this timeout, not vitest's: the
// page under test was still showing its Suspense fallback because the lazy
// chunk had not finished transforming. Under parallel load that can take well
// over five seconds for a page that renders instantly on its own. vitest's own
// 30s testTimeout still bounds a test that is genuinely stuck.
configure({ asyncUtilTimeout: 15000 })

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

afterEach(() => {
  cleanup()
  localStorage.clear()
})
