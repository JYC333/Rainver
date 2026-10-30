import { useSyncExternalStore } from 'react'

/** One action table for execution, help and key hints. Navigation and Escape stay reserved. */
export const READER_SHORTCUTS = [
  { id: 'move', keys: '↑ / ↓', action: 'reading.shortcutMove', configurable: false },
  { id: 'highlight', keys: 'h', action: 'reading.shortcutHighlight', configurable: true },
  { id: 'comment', keys: 'n', action: 'reading.shortcutComment', configurable: true },
  { id: 'outline', keys: '[', action: 'reading.shortcutOutline', configurable: true },
  { id: 'inspector', keys: ']', action: 'reading.shortcutInspector', configurable: true },
  { id: 'find', keys: '/', action: 'reading.shortcutFind', configurable: true },
  { id: 'focus', keys: 'f', action: 'reading.shortcutFocus', configurable: true },
  { id: 'escape', keys: 'Escape', action: 'reading.shortcutEscape', configurable: false },
  { id: 'help', keys: '?', action: 'reading.shortcutHelp', configurable: false },
] as const
export type ReaderShortcutId = typeof READER_SHORTCUTS[number]['id']
export type ReaderKeyMap = Record<ReaderShortcutId, string>
const STORAGE_KEY = 'rainver:reader-shortcuts'
const CHANGE_EVENT = 'rainver:reader-shortcuts-changed'
const defaults = () => Object.fromEntries(READER_SHORTCUTS.map(item => [item.id, item.keys])) as ReaderKeyMap

/** Restrict editable bindings to unmodified Latin letters or these punctuation keys.
 * Event.key (not physical code) respects the active keyboard layout. */
export function validReaderKeyMap(value: unknown): ReaderKeyMap | null {
  if (!value || typeof value !== 'object') return null
  const result = defaults()
  for (const item of READER_SHORTCUTS) {
    const key = (value as Record<string, unknown>)[item.id]
    if (!item.configurable) continue
    if (typeof key !== 'string' || !/^[a-z[\]\/;,.]$/.test(key)) return null
    result[item.id] = key
  }
  const keys = READER_SHORTCUTS.map(item => result[item.id])
  return new Set(keys).size === keys.length ? result : null
}
function snapshot(): string { try { return localStorage.getItem(STORAGE_KEY) ?? '' } catch { return '' } }
function subscribe(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener); window.addEventListener('storage', listener)
  return () => { window.removeEventListener(CHANGE_EVENT, listener); window.removeEventListener('storage', listener) }
}
export function useReaderShortcuts() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => '')
  let keys = defaults()
  try { keys = validReaderKeyMap(JSON.parse(raw)) ?? keys } catch { /* defaults for old/invalid storage */ }
  const save = (value: ReaderKeyMap | null) => {
    try {
      if (value) { const valid = validReaderKeyMap(value); if (!valid) return false; localStorage.setItem(STORAGE_KEY, JSON.stringify(valid)) }
      else localStorage.removeItem(STORAGE_KEY)
      window.dispatchEvent(new Event(CHANGE_EVENT)); return true
    } catch { return false }
  }
  return { keys, save }
}
export function readerShortcutAction(key: string, shift: boolean, keys: ReaderKeyMap): ReaderShortcutId | undefined {
  return READER_SHORTCUTS.find(item => item.id !== 'move' && keys[item.id].toLowerCase() === (shift && key !== '?' ? '' : key.toLowerCase()))?.id
}

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
// Focus inside one of these means the keys belong to it (menus and listboxes
// move with arrows, dialogs own their keys), modal or not.
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="listbox"], [aria-modal="true"]'

function visible(element: Element): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  return element.getClientRects().length > 0
}

/**
 * Whether an active modal currently owns the page. Radix modals mark the rest
 * of the app aria-hidden (or inert) while open, which covers a dialog opened
 * with focus elsewhere; any other visible aria-modal element counts too. A
 * hidden or closed node, or a non-modal popover that does not hold focus,
 * does not: a persistent hidden node must never disable the Reader's keys.
 */
function modalOpen(root: HTMLElement | null): boolean {
  if (root?.closest('[aria-hidden="true"], [inert]')) return true
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some(visible)
}

/**
 * Whether a keydown belongs to someone other than the Reader: IME composition
 * (a Chinese candidate key must not highlight), text entry, a focused
 * menu/dialog/listbox, an active modal, a handler that already consumed it, a
 * modified chord, or a key aimed at controls outside this Reader.
 */
export function readerShortcutBlocked(event: KeyboardEvent, root: HTMLElement | null): boolean {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return true
  if (event.metaKey || event.ctrlKey || event.altKey) return true
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest(EDITABLE) || target?.closest(OVERLAY)) return true
  if (modalOpen(root)) return true
  if (target && target !== document.body && target !== document.documentElement && !root?.contains(target)) return true
  return false
}
