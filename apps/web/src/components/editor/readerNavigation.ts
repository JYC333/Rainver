import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

/**
 * Document-level reading aids over the Reader's ProseMirror tree: the place a
 * person has read to, where that place is in a later version, the document's
 * headings and in-document find. Pure functions over the tree, so they are
 * tested without a browser; the Reader component wires them to its view.
 */

export interface ReadingAnchor {
  block_index: number
  pm_pos: number
  /** UTF-16 offset of the place in the document's text (blocks joined by one space). */
  text_offset: number
  /** Text from the place onward (≤ 200), and up to 80 before it, to find it in another version. */
  quote: string
  before_context: string
}

export interface ReaderHeading { level: number; text: string; pos: number; blockIndex: number }

/** The document's text with blocks joined by a space, and the tree position of each UTF-16 unit. */
export interface FlatText { text: string; positions: Int32Array }

export function flattenDocument(doc: ProseMirrorNode): FlatText {
  const chunks: string[] = []
  const positions: number[] = []
  let first = true
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (!first) { chunks.push(' '); positions.push(-1) }
      first = false
    }
    if (node.isText && node.text) {
      chunks.push(node.text)
      for (let i = 0; i < node.text.length; i++) positions.push(pos + i)
    }
    return true
  })
  return { text: chunks.join(''), positions: Int32Array.from(positions) }
}

/** Index in `flat.text` of the first unit at or after tree position `pos`. */
function offsetOf(flat: FlatText, pos: number): number {
  let lo = 0, hi = flat.positions.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const at = flat.positions[mid]
    // Separators take the position of the unit after them.
    let probe = at
    for (let k = mid + 1; probe < 0 && k < flat.positions.length; k++) probe = flat.positions[k]
    if (probe < 0 || probe >= pos) hi = mid; else lo = mid + 1
  }
  // A place at a block start is the block's first character, not the separator before it.
  while (lo < flat.positions.length && flat.positions[lo] < 0) lo++
  return lo
}

export function blockIndexAt(doc: ProseMirrorNode, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, doc.content.size))
  return Math.min(doc.childCount - 1, doc.resolve(clamped).index(0))
}

/** The anchor for tree position `pos`. */
export function anchorAt(doc: ProseMirrorNode, flat: FlatText, pos: number): ReadingAnchor {
  const offset = offsetOf(flat, pos)
  return {
    block_index: Math.max(0, blockIndexAt(doc, pos)),
    pm_pos: Math.max(0, Math.min(pos, doc.content.size)),
    text_offset: offset,
    quote: flat.text.slice(offset, offset + 120),
    before_context: flat.text.slice(Math.max(0, offset - CONTEXT_BEFORE), offset),
  }
}

/** Characters of text kept before a place, to tell repeated passages apart. */
const CONTEXT_BEFORE = 40

export type LocatedPosition = { pos: number; how: 'exact' | 'quote' } | null

/**
 * Where a saved place is in the document shown now. A place saved on this
 * structure is used as it is; otherwise its text is searched for, and a text
 * found more than once is accepted only where the text before it also
 * matches. Anything else is not located (the caller falls back to the saved
 * fraction and says so), rather than jumping to a guess.
 */
export function locateAnchor(doc: ProseMirrorNode, flat: FlatText, anchor: ReadingAnchor, sameStructure: boolean): LocatedPosition {
  if (sameStructure && anchor.pm_pos >= 0 && anchor.pm_pos <= doc.content.size) return { pos: anchor.pm_pos, how: 'exact' }
  const quote = anchor.quote
  if (quote.trim().length < 8) return null
  // Every occurrence is considered: a capped list could call a place unique that is not.
  const first = flat.text.indexOf(quote)
  if (first === -1) return null
  const second = flat.text.indexOf(quote, first + 1)
  let pick: number | null = second === -1 ? first : null
  if (pick === null) {
    // Repeated text: exactly one occurrence may have the saved text before it. A
    // shorter saved context than the window means the place was that close to
    // the start, so only the occurrence at that offset qualifies.
    const before = anchor.before_context
    const nearStart = before.length < CONTEXT_BEFORE
    for (let i = first; i !== -1; i = flat.text.indexOf(quote, i + 1)) {
      const supported = nearStart ? i === before.length && flat.text.slice(0, i) === before : i >= before.length && flat.text.slice(i - before.length, i) === before
      if (!supported) continue
      if (pick !== null) return null
      pick = i
    }
  }
  if (pick == null) return null
  const pos = flat.positions[pick]
  return pos >= 0 ? { pos, how: 'quote' } : null
}

export function documentHeadings(doc: ProseMirrorNode): ReaderHeading[] {
  const out: ReaderHeading[] = []
  doc.forEach((node, offset, index) => {
    if (node.type.name !== 'heading') return
    const text = node.textContent.trim()
    if (text) out.push({ level: Number(node.attrs.level) || 1, text: text.slice(0, 160), pos: offset, blockIndex: index })
  })
  return out
}

/** Case-insensitive matches of `query` in the document's text, as tree ranges (≤ 1000). */
export function findInDocument(flat: FlatText, query: string): Array<{ from: number; to: number }> {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const haystack = flat.text.toLocaleLowerCase()
  // Lower-casing can change the length of some characters; such text is searched as written.
  const text = haystack.length === flat.text.length ? haystack : flat.text
  const matches: Array<{ from: number; to: number }> = []
  for (let i = text.indexOf(needle); i !== -1 && matches.length < 1000; i = text.indexOf(needle, i + needle.length)) {
    const from = flat.positions[i]
    const last = flat.positions[i + needle.length - 1]
    // A match across two blocks has no single range to mark.
    if (from < 0 || last < 0 || last - from !== needle.length - 1) continue
    matches.push({ from, to: last + 1 })
  }
  return matches
}
