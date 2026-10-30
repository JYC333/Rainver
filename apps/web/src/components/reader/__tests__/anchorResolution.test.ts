import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { markdownToReaderDocument } from '@rainver/reader-document'
import { resolveAnnotationAnchors } from '../anchorResolution'
import type { ReaderAnnotation } from '../../../types/api'

const schema = getSchema([StarterKit])
const docFrom = (markdown: string) => ProseMirrorNode.fromJSON(schema, markdownToReaderDocument(markdown))

function annotation(id: string, quote: string, anchor: Partial<ReaderAnnotation['anchor_json']> = {}): ReaderAnnotation {
  return {
    id, quote_text: quote, status: 'active',
    anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: quote, text_range: { start: 0, end: quote.length, unit: 'utf16' }, before_context: '', after_context: '', ...anchor },
  } as ReaderAnnotation
}

const textAt = (doc: ProseMirrorNode, placement: ReturnType<typeof resolveAnnotationAnchors> extends Map<string, infer V> ? V | undefined : never) =>
  placement?.state === 'located' ? doc.textBetween(placement.from, placement.to, ' ') : null

describe('resolveAnnotationAnchors', () => {
  it('trusts a stored range on the same structure version when it still holds the quote', () => {
    const doc = docFrom('First paragraph.\n\nSecond paragraph.')
    const resolved = resolveAnnotationAnchors(doc, [annotation('a', 'Second', { tiptap_range: { from: 19, to: 25 }, structure_hash: 's1' })], { contentHash: 'c1', structureHash: 's1' })
    expect(resolved.get('a')).toEqual({ state: 'located', from: 19, to: 25, by: 'range' })
  })

  it('does not paint a stale range after the structure changed; it relocates the quote by text', () => {
    // The same words, re-parsed from literal Markdown into a heading and a list: every position moved.
    const before = ProseMirrorNode.fromJSON(schema, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '# Title - alpha beta gamma' }] }] })
    const range = { from: 11, to: 21 }
    expect(before.textBetween(range.from, range.to)).toBe('alpha beta')
    const after = docFrom('# Title\n\n- alpha beta gamma')
    const resolved = resolveAnnotationAnchors(after, [annotation('a', 'alpha beta', { tiptap_range: range, structure_hash: 'old', before_context: '# Title - ', after_context: ' gamma' })], { contentHash: 'c2', structureHash: 'new' })
    expect(resolved.get('a')).toMatchObject({ state: 'located', by: 'text' })
    expect(textAt(after, resolved.get('a'))).toBe('alpha beta')
  })

  it('checks a legacy anchor (no structure hash) against the text hash before trusting its range', () => {
    const doc = docFrom('Alpha beta.\n\nGamma delta.')
    const legacy = (hash: string) => annotation('a', 'Gamma', { tiptap_range: { from: 1, to: 6 }, content_hash: hash })
    // Same text version, but the stored range holds other words: never painted there.
    expect(resolveAnnotationAnchors(doc, [legacy('c1')], { contentHash: 'c1' }).get('a')).toMatchObject({ state: 'located', by: 'text' })
    expect(textAt(doc, resolveAnnotationAnchors(doc, [legacy('other')], { contentHash: 'c1' }).get('a'))).toBe('Gamma')
  })

  it('uses the stored context to pick one of several equal quotes, and reports a tie as unlocated', () => {
    const doc = docFrom('The cat sat. Then the cat ran.\n\nAgain the cat sat.')
    const second = annotation('a', 'the cat', { before_context: 'The cat sat. Then ', after_context: ' ran.' })
    const placement = resolveAnnotationAnchors(doc, [second], { contentHash: 'x' }).get('a')
    expect(placement?.state).toBe('located')
    expect(doc.textBetween(0, placement?.state === 'located' ? placement.to : 0, ' ')).toContain('Then the cat')
    const tie = annotation('b', 'cat', {})
    expect(resolveAnnotationAnchors(doc, [tie], { contentHash: 'x' }).get('b')).toEqual({ state: 'unlocated', reason: 'ambiguous' })
  })

  it('reports a quote that no longer occurs as unlocated', () => {
    const doc = docFrom('Completely new text.')
    expect(resolveAnnotationAnchors(doc, [annotation('a', 'old sentence')], { contentHash: 'x' }).get('a')).toEqual({ state: 'unlocated', reason: 'missing' })
  })

  it('maps UTF-16 offsets one-to-one across emoji and CJK text', () => {
    const doc = docFrom('前文 🙂🙂 中间的句子 🙂 后文')
    const placement = resolveAnnotationAnchors(doc, [annotation('a', '中间的句子', { before_context: '🙂🙂 ', after_context: ' 🙂' })], { contentHash: 'x' }).get('a')
    expect(textAt(doc, placement)).toBe('中间的句子')
  })

  it('matches across whitespace differences between the stored text and the editor text', () => {
    const doc = docFrom('- first item\n- second item')
    expect(textAt(doc, resolveAnnotationAnchors(doc, [annotation('a', 'first item second')], { contentHash: 'x' }).get('a'))).toBe('first item second')
  })

  it('leaves a summary-level annotation without a quote out entirely', () => {
    const doc = docFrom('Text.')
    const withheld = { ...annotation('a', ''), anchor_json: {} } as unknown as ReaderAnnotation
    expect(resolveAnnotationAnchors(doc, [withheld], { contentHash: 'x' }).has('a')).toBe(false)
  })
})

describe('resolveAnnotationAnchors: proofs for repeated quotes and old anchors', () => {
  const p = (text: string) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })
  const qAt = (doc: ProseMirrorNode) => { const positions: number[] = []; doc.descendants((node, pos) => { if (node.text === 'Q') positions.push(pos) }); return positions }

  it('never trusts an old anchor’s range by text hash: same text in a new tree goes to the context proof', () => {
    // The text stays "a Q Q"; an empty block and a rule shift every position after "a".
    const after = ProseMirrorNode.fromJSON(schema, { type: 'doc', content: [p('a'), { type: 'horizontalRule' }, p(''), p('Q'), p('Q')] })
    expect(after.textBetween(7, 8)).toBe('Q')
    const second = annotation('a', 'Q', { content_hash: 'same-text', tiptap_range: { from: 7, to: 8 }, before_context: 'a Q ', after_context: '' })
    const placement = resolveAnnotationAnchors(after, [second], { contentHash: 'same-text', structureHash: 'new-tree' }).get('a')
    expect(placement).toEqual({ state: 'located', from: qAt(after)[1], to: qAt(after)[1]! + 1, by: 'text' })
  })

  it('does not trust a range whose structure hash matches but no longer holds the quote', () => {
    const doc = docFrom('Alpha beta.')
    expect(resolveAnnotationAnchors(doc, [annotation('a', 'beta', { structure_hash: 's', tiptap_range: { from: 1, to: 5 } })], { contentHash: 'c', structureHash: 's' }).get('a'))
      .toMatchObject({ state: 'located', by: 'text' })
  })

  it('leaves a repeated quote unlocated when a single shared character is all that agrees', () => {
    const doc = docFrom('zzz Q foo. xxx Q bar.')
    const placement = resolveAnnotationAnchors(doc, [annotation('a', 'Q', { before_context: 'totally different historical prefixz', after_context: 'unrelated suffix' })], { contentHash: 'new' }).get('a')
    expect(placement).toEqual({ state: 'unlocated', reason: 'ambiguous' })
  })

  it('leaves a repeated quote unlocated when the context supports one side of one occurrence and the other side of another', () => {
    const doc = docFrom('left Q one. other Q right.')
    const placement = resolveAnnotationAnchors(doc, [annotation('a', 'Q', { before_context: 'left ', after_context: ' right.' })], { contentHash: 'x' }).get('a')
    expect(placement).toEqual({ state: 'unlocated', reason: 'ambiguous' })
  })

  it('places a repeated quote at the document edges only when the stored context says it was there', () => {
    const doc = docFrom('Q middle Q')
    const first = resolveAnnotationAnchors(doc, [annotation('a', 'Q', { before_context: '', after_context: ' middle Q' })], { contentHash: 'x' }).get('a')
    expect(first).toMatchObject({ state: 'located', from: 1, to: 2 })
    const last = resolveAnnotationAnchors(doc, [annotation('b', 'Q', { before_context: 'Q middle ', after_context: '' })], { contentHash: 'x' }).get('b')
    expect(last).toMatchObject({ state: 'located', from: 10, to: 11 })
    // An empty stored side is a claim about the edge, not a wildcard.
    expect(resolveAnnotationAnchors(doc, [annotation('c', 'Q', { before_context: '', after_context: '' })], { contentHash: 'x' }).get('c'))
      .toEqual({ state: 'unlocated', reason: 'ambiguous' })
  })

  it('proves a repeated quote across emoji and across block boundaries, whitespace-insensitively', () => {
    const doc = docFrom('前文 🙂 词\n\n另一段 🙂🙂 词\n\n结尾')
    const placement = resolveAnnotationAnchors(doc, [annotation('a', '词', { before_context: '前文 🙂 词 另一段 🙂🙂  ', after_context: '  结尾' })], { contentHash: 'x' }).get('a')
    expect(placement?.state).toBe('located')
    expect(doc.textBetween(0, placement?.state === 'located' ? placement.from : 0, ' ')).toContain('另一段')
  })

  it('places a quote that occurs once even when its surroundings were rewritten (e.g. Markdown syntax parsed away)', () => {
    const doc = docFrom('# Title\n\nThe **unique phrase** stays.')
    const placement = resolveAnnotationAnchors(doc, [annotation('a', 'unique phrase', { before_context: '# Title The **', after_context: '** stays.' })], { contentHash: 'x' }).get('a')
    expect(textAt(doc, placement)).toBe('unique phrase')
  })
})
