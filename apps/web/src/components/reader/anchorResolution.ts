import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { ReaderAnnotation } from '../../types/api'

/**
 * Where a stored annotation belongs in the document as it is now.
 *
 * Rules, in order — each is a proof, never a best guess:
 * 1. Range: the stored ProseMirror range is used only when the anchor's
 *    `structure_hash` equals the document's (the tree it was made on, as
 *    displayed) and the range still holds the quote. A text hash never proves
 *    positions: the same text can be laid out in a different tree (a re-parse,
 *    or the read-time normalizer degrading a node). Anchors made before
 *    structure hashes therefore always go to rule 2.
 * 2. Unique quote: if the quote occurs exactly once in the current text, that
 *    occurrence is the quoted words.
 * 3. Repeated quote: an occurrence is supported when the stored context
 *    matches the text around it completely on both sides — the whole stored
 *    `before_context` ends right before it and the whole `after_context`
 *    starts right after it; an empty stored side means the quote was at the
 *    document edge, so it must be at the edge now. Exactly one supported
 *    occurrence is located; none or several are `unlocated`. A partial match,
 *    however long, never decides between occurrences.
 * Unlocated annotations are not painted; they stay listed with quote and comments.
 *
 * Offsets: every position here is a UTF-16 code-unit index, the unit of JS
 * strings, of ProseMirror text positions and of the stored
 * `text_range.unit = 'utf16'`. No code-point conversion happens anywhere.
 * Comparison is whitespace-insensitive (runs of whitespace compare equal):
 * the stored normalized text and the editor's block-separated text differ only
 * in whitespace between blocks.
 */
export type AnchorResolution =
  | { state: 'located'; from: number; to: number; by: 'range' | 'text' }
  | { state: 'unlocated'; reason: 'missing' | 'ambiguous' }

export interface DocumentVersion { contentHash: string; structureHash?: string | null }

interface TextMap { text: string; positions: number[] }

/** The document's text with the ProseMirror position of every UTF-16 unit (-1 for block separators). */
function textMap(doc: ProseMirrorNode): TextMap {
  let text = ''
  const positions: number[] = []
  const separate = () => { if (text && !/\s$/.test(text)) { text += ' '; positions.push(-1) } }
  doc.descendants((node, pos) => {
    if (node.isText) {
      for (let index = 0; index < (node.text ?? '').length; index += 1) positions.push(pos + index)
      text += node.text ?? ''
      return false
    }
    // Each text block, and a hard break or other leaf, separates words.
    if (node.isTextblock || node.isLeaf) separate()
    return true
  })
  return { text, positions }
}

/** Whitespace runs collapsed to one space, with a map back to the original indices. */
function collapse(value: string): { text: string; index: number[] } {
  let text = ''
  const index: number[] = []
  let inSpace = false
  for (let i = 0; i < value.length; i += 1) {
    if (/\s/.test(value[i]!)) {
      if (!inSpace) { text += ' '; index.push(i) }
      inSpace = true
    } else {
      text += value[i]
      index.push(i)
      inSpace = false
    }
  }
  return { text, index }
}

const squash = (value: string) => value.replace(/\s+/g, ' ').trim()

/** Whether the text before an occurrence carries the whole stored context (empty: the occurrence starts the document). */
function beforeSupports(textBefore: string, storedBefore: string): boolean {
  return storedBefore ? textBefore.endsWith(storedBefore) : textBefore === ''
}

function afterSupports(textAfter: string, storedAfter: string): boolean {
  return storedAfter ? textAfter.startsWith(storedAfter) : textAfter === ''
}

function rangeHoldsQuote(doc: ProseMirrorNode, from: number, to: number, quote: string): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > doc.content.size || from >= to) return false
  try {
    return squash(doc.textBetween(from, to, ' ')) === squash(quote)
  } catch {
    return false
  }
}

function resolveOne(doc: ProseMirrorNode, map: TextMap, collapsed: ReturnType<typeof collapse>, annotation: ReaderAnnotation, version: DocumentVersion): AnchorResolution | null {
  const anchor = annotation.anchor_json ?? ({} as ReaderAnnotation['anchor_json'])
  const quote = squash(annotation.quote_text || anchor.quote_text || '')
  // A summary-level annotation carries no quote: there is nothing to place.
  if (!quote) return null
  const range = anchor.tiptap_range
  if (range && anchor.structure_hash && anchor.structure_hash === version.structureHash && rangeHoldsQuote(doc, range.from, range.to, quote)) {
    return { state: 'located', from: range.from, to: range.to, by: 'range' }
  }

  const starts: number[] = []
  for (let at = collapsed.text.indexOf(quote); at !== -1; at = collapsed.text.indexOf(quote, at + 1)) starts.push(at)
  if (starts.length === 0) return { state: 'unlocated', reason: 'missing' }

  let chosen = starts.length === 1 ? starts[0]! : null
  if (chosen === null) {
    const before = squash(anchor.before_context ?? '')
    const after = squash(anchor.after_context ?? '')
    const supported = starts.filter(start => beforeSupports(collapsed.text.slice(0, start).trimEnd(), before)
      && afterSupports(collapsed.text.slice(start + quote.length).trimStart(), after))
    if (supported.length !== 1) return { state: 'unlocated', reason: 'ambiguous' }
    chosen = supported[0]!
  }
  const best = { start: chosen, end: chosen + quote.length }

  const from = map.positions[collapsed.index[best.start]!]
  const lastChar = map.positions[collapsed.index[best.end - 1]!]
  if (from === undefined || lastChar === undefined || from < 0 || lastChar < 0) return { state: 'unlocated', reason: 'missing' }
  return { state: 'located', from, to: lastChar + 1, by: 'text' }
}

/** Resolves every active annotation against `doc`; summary-level ones (no quote) are left out. */
export function resolveAnnotationAnchors(doc: ProseMirrorNode, annotations: ReaderAnnotation[], version: DocumentVersion): Map<string, AnchorResolution> {
  const map = textMap(doc)
  const collapsed = collapse(map.text)
  const resolved = new Map<string, AnchorResolution>()
  for (const annotation of annotations) {
    if (annotation.status !== 'active') continue
    const result = resolveOne(doc, map, collapsed, annotation, version)
    if (result) resolved.set(annotation.id, result)
  }
  return resolved
}

/** Characters of the Reader's text kept on each side of a new anchor's quote. */
const CONTEXT_WINDOW = 80

export interface CreatedAnchor {
  /** The quote with whitespace runs collapsed: what anchors compare (not what is copied). */
  quoteText: string
  /** The quote's place in the stored normalized text, or null when it cannot be proved (see below). */
  textRange: { start: number; end: number } | null
  before: string
  after: string
}

function firstAtLeast(values: number[], target: number): number {
  let low = 0, high = values.length
  while (low < high) { const middle = (low + high) >> 1; if (values[middle]! < target) low = middle + 1; else high = middle }
  return low
}

/**
 * The anchor for the words a person selected (ProseMirror `from`–`to`), made
 * from the same text the resolver above searches, so its context describes
 * the occurrence actually selected — never one guessed from an offset in
 * another representation.
 *
 * `textRange` places it in the stored normalized text (the server's canonical
 * text, which can differ from the tree's text: trimmed code indentation, table
 * and list separators). It is given only when the whole normalized text is the
 * Reader's text with whitespace collapsed (leading whitespace aside), so every
 * offset corresponds. Otherwise it is null — a matching number of
 * occurrences is not proof — and the caller stores no verifiable range; in
 * another version a repeated quote is placed only by its context, or not at all.
 */
export function anchorForSelection(doc: ProseMirrorNode, from: number, to: number, normalizedText: string): CreatedAnchor | null {
  const map = textMap(doc)
  const collapsed = collapse(map.text)
  // Selection bounds in the Reader's text, then in its collapsed form.
  let mapStart = map.positions.findIndex(position => position >= from)
  if (mapStart === -1) return null
  let mapEnd = map.positions.findIndex(position => position >= to)
  if (mapEnd === -1) mapEnd = map.text.length
  mapStart = Math.min(mapStart, mapEnd)
  let start = firstAtLeast(collapsed.index, mapStart)
  let end = firstAtLeast(collapsed.index, mapEnd)
  while (start < end && collapsed.text[start] === ' ') start += 1
  while (end > start && collapsed.text[end - 1] === ' ') end -= 1
  const quoteText = collapsed.text.slice(start, end)
  if (!quoteText) return null

  // Only when the two texts are the same text (whitespace aside) does a place in
  // one name a place in the other: then the selection's offset is the same in
  // both. Matching counts of the quote prove nothing (a table separator can
  // remove one match and add another).
  const canonical = collapse(normalizedText)
  const leadHere = collapsed.text.length - collapsed.text.trimStart().length
  const leadThere = canonical.text.length - canonical.text.trimStart().length
  let textRange: CreatedAnchor['textRange'] = null
  if (collapsed.text.trim() === canonical.text.trim() && start >= leadHere) {
    const at = start - leadHere + leadThere
    textRange = { start: canonical.index[at]!, end: canonical.index[at + quoteText.length - 1]! + 1 }
  }
  return {
    quoteText,
    textRange,
    before: collapsed.text.slice(Math.max(0, start - CONTEXT_WINDOW), start),
    after: collapsed.text.slice(end, end + CONTEXT_WINDOW),
  }
}
