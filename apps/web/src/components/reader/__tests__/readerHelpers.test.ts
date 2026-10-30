import { afterEach, describe, expect, it } from 'vitest'
import { documentTitleHeading } from '../readerModel'
import { floatingToolbarStyle } from '../ReaderSelectionToolbar'
import { readerShortcutBlocked } from '../readerShortcuts'

const heading = (text: string, level = 1) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] })
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

describe('documentTitleHeading', () => {
  it('lets an opening h1 with the same title stand as the title, ignoring spacing, width and case', () => {
    expect(documentTitleHeading({ type: 'doc', content: [heading('Signals  in Long-Form Reading'), paragraph('Body')] }, 'signals in long-form reading')).toBe('h1')
    expect(documentTitleHeading({ type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: 'Split ' }, { type: 'text', marks: [{ type: 'bold' }], text: 'title' }] }] }, 'Split title')).toBe('h1')
  })

  it('reports a same-title heading at a lower level separately, so the page keeps its h1', () => {
    expect(documentTitleHeading({ type: 'doc', content: [heading('长文 阅读（第一部分）', 2)] }, '长文 阅读(第一部分)')).toBe('lower')
    expect(documentTitleHeading({ type: 'doc', content: [heading('Signals', 3)] }, 'Signals')).toBe('lower')
  })

  it('finds no title heading for a different heading, a paragraph start, an empty body or an empty title', () => {
    expect(documentTitleHeading({ type: 'doc', content: [heading('Introduction'), paragraph('Body')] }, 'Signals')).toBe('none')
    expect(documentTitleHeading({ type: 'doc', content: [paragraph('Signals')] }, 'Signals')).toBe('none')
    expect(documentTitleHeading({ type: 'doc', content: [] }, 'Signals')).toBe('none')
    expect(documentTitleHeading({ type: 'doc', content: [heading('')] }, ' ')).toBe('none')
  })
})

describe('floatingToolbarStyle', () => {
  const bounds = { top: 0, left: 0, width: 390, height: 700 }
  const rect = (top: number, bottom: number, left = 100, width = 120) => ({ top, bottom, left, right: left + width, width, height: bottom - top })

  it('sits above the selection with a fine pointer and below it with a coarse one', () => {
    expect(floatingToolbarStyle(rect(300, 320), bounds, false)).toEqual({ top: 252, left: 58 })
    expect(floatingToolbarStyle(rect(300, 320), bounds, true)).toEqual({ top: 328, left: 42 })
  })

  it('takes the other side at a viewport edge and docks when no side leaves the selection uncovered', () => {
    expect(floatingToolbarStyle(rect(20, 40), bounds, false)).toMatchObject({ top: 48 })
    expect(floatingToolbarStyle(rect(640, 660), bounds, true)).toMatchObject({ top: 592 })
    expect(floatingToolbarStyle(rect(10, 690), bounds, false)).toBeNull()
  })

  it('clamps horizontally inside the visual viewport, including a zoomed or keyboard-shrunk one', () => {
    expect(floatingToolbarStyle(rect(300, 320, 370, 20), bounds, false)).toMatchObject({ left: 178 })
    const keyboard = { top: 0, left: 0, width: 390, height: 360 }
    expect(floatingToolbarStyle(rect(330, 350), keyboard, true)).toMatchObject({ top: 282 })
    const zoomed = { top: 200, left: 50, width: 200, height: 300 }
    expect(floatingToolbarStyle(rect(300, 320, 10, 20), zoomed, false)).toEqual({ top: 252, left: 58 })
  })
})

describe('readerShortcutBlocked', () => {
  afterEach(() => { document.body.innerHTML = '' })
  const root = () => { const element = document.createElement('div'); element.innerHTML = '<p>Text</p><button>Act</button><textarea></textarea><div contenteditable="false"><span>ro</span></div>'; document.body.append(element); return element }
  const key = (target: EventTarget, init: KeyboardEventInit & { keyCode?: number } = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true, ...init })
    if (init.keyCode) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
    Object.defineProperty(event, 'target', { value: target })
    return event
  }

  it('lets plain keys on the page or inside this Reader through, including a read-only surface', () => {
    const reader = root()
    expect(readerShortcutBlocked(key(document.body), reader)).toBe(false)
    expect(readerShortcutBlocked(key(reader.querySelector('button')!), reader)).toBe(false)
    expect(readerShortcutBlocked(key(reader.querySelector('span')!), reader)).toBe(false)
  })

  it('yields to IME composition, text entry, modified chords and handled events', () => {
    const reader = root()
    expect(readerShortcutBlocked(key(document.body, { isComposing: true }), reader)).toBe(true)
    expect(readerShortcutBlocked(key(document.body, { keyCode: 229 }), reader)).toBe(true)
    expect(readerShortcutBlocked(key(reader.querySelector('textarea')!), reader)).toBe(true)
    expect(readerShortcutBlocked(key(document.body, { ctrlKey: true }), reader)).toBe(true)
    expect(readerShortcutBlocked(key(document.body, { metaKey: true }), reader)).toBe(true)
    const handled = key(document.body); handled.preventDefault()
    expect(readerShortcutBlocked(handled, reader)).toBe(true)
  })

  it('yields to focus inside a menu, listbox or dialog, and to controls outside the Reader', () => {
    const reader = root()
    const outside = document.createElement('button'); document.body.append(outside)
    expect(readerShortcutBlocked(key(outside), reader)).toBe(true)
    for (const role of ['menu', 'listbox', 'dialog', 'alertdialog']) {
      const overlay = document.createElement('div'); overlay.setAttribute('role', role)
      const item = document.createElement('button'); overlay.append(item); document.body.append(overlay)
      expect(readerShortcutBlocked(key(item), reader), role).toBe(true)
      overlay.remove()
    }
  })

  it('does not let a hidden or unfocused non-modal overlay disable the keys', () => {
    const reader = root()
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); document.body.append(menu)
    const hiddenModal = document.createElement('div'); hiddenModal.setAttribute('aria-modal', 'true'); hiddenModal.hidden = true; document.body.append(hiddenModal)
    expect(readerShortcutBlocked(key(document.body), reader)).toBe(false)
  })

  it('yields while an active modal owns the page: the app is hidden from it, or a visible aria-modal is open', () => {
    const reader = root()
    reader.setAttribute('aria-hidden', 'true')
    expect(readerShortcutBlocked(key(document.body), reader)).toBe(true)
    reader.removeAttribute('aria-hidden')
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
    modal.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList
    expect(readerShortcutBlocked(key(document.body), reader)).toBe(true)
    modal.remove()
    expect(readerShortcutBlocked(key(document.body), reader)).toBe(false)
  })
})
