import { createRef } from 'react'
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { markdownToReaderDocument } from '@rainver/reader-document'
import { ReadOnlyTiptapReader, readerContentExtensions, type ReadOnlyTiptapReaderHandle, type TextSelection } from '../../editor/ReadOnlyTiptapReader'
import { anchorForSelection, resolveAnnotationAnchors } from '../anchorResolution'
import type { ReaderAnnotation } from '../../../types/api'

// Markdown is converted by the shared converter the server uses; the canonical
// (normalized) texts are what the server stores for these inputs, pinned by
// server/test/readerCanonicalText.test.ts so the two cannot drift apart.
const L = 'Long repeated paragraph '.repeat(5).trim()
const CANONICAL_FIXTURES = {
  code: { markdown: '```\n    x\n```\n\nQ\n\ngap\n\nQ', canonical: 'x Q gap Q' },
  list: { markdown: '- Same item\n  - Same item\n- Other item', canonical: 'Same item Same item\nOther item' },
  table: { markdown: '| A | B |\n|---|---|\n| Same | Same |', canonical: 'A | B\nSame | Same' },
  emoji: { markdown: '🙂 Q\n\nmiddle\n\n🙂 Q', canonical: '🙂 Q middle 🙂 Q' },
  long: { markdown: `${L}\n\nQ\n\n${L}\n\nQ\n\n${L}`, canonical: [L, 'Q', L, 'Q', L].join(' ') },
  // An escaped pipe in a cell: the canonical text's separators remove one "A | B" and add another.
  tableEscaped: { markdown: '| X | Y |\n|---|---|\n| A \\| | B |\n| A | B |', canonical: 'X | Y\nA | | B\nA | B' },
  codeCopy: { markdown: '```\ndef f():\n    return 1\n```', canonical: 'def f():\n    return 1' },
}

const schema = getSchema(readerContentExtensions())
const tree = (markdown: string) => ProseMirrorNode.fromJSON(schema, markdownToReaderDocument(markdown))
/** Text nodes holding exactly `text`, in document order. */
function textNodes(doc: ProseMirrorNode, text: string): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = []
  doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) { const at = pos + node.text.indexOf(text); found.push({ from: at, to: at + text.length }) } })
  return found
}
/** The next version: same words, different structure (a rule in front), so the old range is not trusted. */
const restructured = (doc: ProseMirrorNode) => ProseMirrorNode.fromJSON(schema, { ...doc.toJSON(), content: [{ type: 'horizontalRule' }, ...doc.toJSON().content] })

function annotationFrom(doc: ProseMirrorNode, selection: { from: number; to: number }, canonical: string): ReaderAnnotation {
  const anchor = anchorForSelection(doc, selection.from, selection.to, canonical)!
  return { id: 'a', status: 'active', quote_text: anchor.quoteText, anchor_json: {
    schema_version: 1, normalizer: 'plain_text_v1', quote_text: anchor.quoteText,
    text_range: anchor.textRange ? { ...anchor.textRange, unit: 'utf16' } : { start: canonical.length, end: canonical.length + anchor.quoteText.length, unit: 'utf16' },
    before_context: anchor.before, after_context: anchor.after, tiptap_range: selection, structure_hash: 'old',
  } } as unknown as ReaderAnnotation
}

function relocate(doc: ProseMirrorNode, annotation: ReaderAnnotation) {
  return resolveAnnotationAnchors(doc, [annotation], { contentHash: 'same', structureHash: 'new' }).get('a')!
}

describe('a new annotation names the occurrence that was selected', () => {
  it('gives no range when equal occurrence counts would name another table row, and keeps the selected row’s context', () => {
    const { markdown, canonical } = CANONICAL_FIXTURES.tableEscaped
    const doc = tree(markdown)
    let first = -1, b = -1
    doc.descendants((node, pos) => { if (node.text === 'A |') first = pos; if (node.text === 'B' && b < 0) b = pos })
    const anchor = anchorForSelection(doc, first, b + 1, canonical)!
    expect(anchor.quoteText).toBe('A | B')
    // "A | B" occurs once in each text, but in different rows: no range is a proof here.
    expect(anchor.textRange).toBeNull()
    expect(anchor.after).toBe(' A B')
    // The selection's own range and context still place it in this version and the next.
    const annotation = annotationFrom(doc, { from: first, to: b + 1 }, canonical)
    expect(annotation.anchor_json.text_range.start).toBe(canonical.length)
    expect(relocate(restructured(doc), annotation)).toMatchObject({ state: 'located', from: first + 1 })
  })

  it('copies the selection as it reads (line breaks, indentation, runs of spaces), while the quote compares collapsed', async () => {
    const { markdown, canonical } = CANONICAL_FIXTURES.codeCopy
    const ref = createRef<ReadOnlyTiptapReaderHandle>()
    render(<ReadOnlyTiptapReader ref={ref} contentJson={markdownToReaderDocument(markdown) as unknown as Record<string, unknown>} normalizedText={canonical} />)
    await waitFor(() => expect(ref.current).not.toBeNull())
    const selected = ref.current!.blockSelection(0)!
    expect(selected.selectedText).toBe('def f():\n    return 1')
    expect(selected.quoteText).toBe('def f(): return 1')
    // Same text whitespace aside: the range is provable here.
    expect(selected.anchorDraft.text_range).toEqual({ start: 0, end: canonical.length, unit: 'utf16' })
  })

  it('in the real Reader, after indented code: the first of two quotes keeps its own range and context, and a re-parse finds it again', async () => {
    const { markdown, canonical } = CANONICAL_FIXTURES.code
    const content = markdownToReaderDocument(markdown)
    const ref = createRef<ReadOnlyTiptapReaderHandle>()
    render(<ReadOnlyTiptapReader ref={ref} contentJson={content as unknown as Record<string, unknown>} normalizedText={canonical} />)
    await waitFor(() => expect(ref.current).not.toBeNull())
    const selected: TextSelection = ref.current!.blockSelection(1)!
    expect(selected.quoteText).toBe('Q')
    // The first Q is at offset 2 of "x Q gap Q", not the second at 8.
    expect(selected.anchorDraft.text_range).toEqual({ start: 2, end: 3, unit: 'utf16' })
    const doc = ProseMirrorNode.fromJSON(schema, content)
    const next = restructured(doc)
    const annotation = { id: 'a', status: 'active', quote_text: 'Q', anchor_json: { ...selected.anchorDraft, structure_hash: 'old' } } as unknown as ReaderAnnotation
    expect(relocate(next, annotation)).toMatchObject({ state: 'located', from: textNodes(next, 'Q')[0]!.from })
  })

  it.each([
    ['nested lists', 'list', 'Same item', 1],
    ['table cells', 'table', 'Same', 1],
    ['emoji text', 'emoji', '🙂 Q', 1],
    ['indented code', 'code', 'Q', 1],
  ] as const)('%s: the selected occurrence (not the other) is found again after a structure change', (_label, fixture, quote, which) => {
    const { markdown, canonical } = CANONICAL_FIXTURES[fixture]
    const doc = tree(markdown)
    const occurrences = textNodes(doc, quote)
    expect(occurrences.length).toBeGreaterThan(1)
    for (const index of [0, which]) {
      const annotation = annotationFrom(doc, occurrences[index]!, canonical)
      const next = restructured(doc)
      const result = relocate(next, annotation)
      // Located on the selected occurrence, or not at all — never on the other one.
      if (result.state === 'located') expect(result.from).toBe(textNodes(next, quote)[index]!.from)
      else expect(result.state).toBe('unlocated')
    }
  })

  it('gives a canonical range only when the occurrence can be proved, and leaves a repeated quote with identical surroundings unlocated', () => {
    // Same text, whitespace aside (indented code, nested lists, emoji): offsets correspond, so the range is given.
    const code = tree(CANONICAL_FIXTURES.code.markdown)
    expect(anchorForSelection(code, textNodes(code, 'Q')[1]!.from, textNodes(code, 'Q')[1]!.to, CANONICAL_FIXTURES.code.canonical)!.textRange).toEqual({ start: 8, end: 9 })
    const list = tree(CANONICAL_FIXTURES.list.markdown)
    expect(anchorForSelection(list, textNodes(list, 'Same item')[1]!.from, textNodes(list, 'Same item')[1]!.to, CANONICAL_FIXTURES.list.canonical)!.textRange).toEqual({ start: 10, end: 19 })
    // A table: the canonical text has "|" separators the Reader's text lacks. Not the same text, so no range,
    // even though "Same" occurs twice in both.
    const table = tree(CANONICAL_FIXTURES.table.markdown)
    const second = anchorForSelection(table, textNodes(table, 'Same')[1]!.from, textNodes(table, 'Same')[1]!.to, CANONICAL_FIXTURES.table.canonical)!
    expect(second.textRange).toBeNull()
    expect(second.before.endsWith('Same ')).toBe(true)
    // Two Qs whose 80 characters on each side are the same text: neither can be told apart in another version.
    const long = tree(CANONICAL_FIXTURES.long.markdown)
    const qs = textNodes(long, 'Q')
    for (const q of qs) {
      const annotation = annotationFrom(long, q, CANONICAL_FIXTURES.long.canonical)
      expect(relocate(restructured(long), annotation)).toEqual({ state: 'unlocated', reason: 'ambiguous' })
    }
  })
})

describe('range adjustment uses Reader positions', () => {
  it('keeps repeated emoji occurrences distinct and never cuts a surrogate pair', async () => {
    const { markdown, canonical } = CANONICAL_FIXTURES.emoji
    const doc = tree(markdown), occurrences = textNodes(doc, '🙂 Q')
    const ref = createRef<ReadOnlyTiptapReaderHandle>()
    render(<ReadOnlyTiptapReader ref={ref} contentJson={doc.toJSON()} normalizedText={canonical} />)
    await waitFor(() => expect(ref.current).not.toBeNull())
    const second = ref.current!.rangeSelection(occurrences[1].from + 1, occurrences[1].to)!
    expect(second.quoteText).toBe('🙂 Q')
    expect(second.anchorDraft.tiptap_range).toEqual(occurrences[1])
    const forward = ref.current!.rangeSelection(occurrences[1].from + 1, occurrences[1].to, occurrences[1])!
    expect(forward.anchorDraft.tiptap_range!.from).toBe(occurrences[1].from + 2)
    expect(forward.selectedText).not.toContain('\uD83D')
    const back = ref.current!.rangeSelection(occurrences[1].from, occurrences[1].from + 1, { from: occurrences[1].from, to: occurrences[1].from + 2 })
    expect(back).toBeNull() // A single emoji may not be shortened to half a surrogate.

    const saved = { id: 'range', status: 'active', quote_text: second.quoteText, anchor_json: { ...second.anchorDraft, structure_hash: 'old' } } as unknown as ReaderAnnotation
    const resolved = resolveAnnotationAnchors(restructured(doc), [saved], { contentHash: 'same', structureHash: 'new' }).get('range')!
    expect(resolved.state).toBe('located')
    if (resolved.state === 'located') expect(resolved.from).toBe(occurrences[1].from + 1)
    const cross = ref.current!.rangeSelection(occurrences[0].from, occurrences[1].to)!
    expect(cross.quoteText).toContain('middle')
    expect(cross.selectedText).toContain('🙂 Q')
  })
})
