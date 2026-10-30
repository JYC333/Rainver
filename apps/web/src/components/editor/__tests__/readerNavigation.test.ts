import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { readerContentExtensions } from '../ReadOnlyTiptapReader'
import { anchorAt, documentHeadings, findInDocument, flattenDocument, locateAnchor } from '../readerNavigation'

const schema = getSchema(readerContentExtensions())
const p = (...content: Array<Record<string, unknown>>) => ({ type: 'paragraph', content })
const text = (value: string, marks?: Array<{ type: string }>) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const doc = (...content: Array<Record<string, unknown>>) => ProseMirrorNode.fromJSON(schema, { type: 'doc', content })

describe('reading anchors', () => {
  const article = doc(
    { type: 'heading', attrs: { level: 2 }, content: [text('Introduction')] },
    p(text('The first paragraph explains the setting.')),
    p(text('A second paragraph has '), text('bold', [{ type: 'bold' }]), text(' words in it.')),
  )

  it('records the block, tree position, text offset and surrounding text of a place', () => {
    const flat = flattenDocument(article)
    const pos = 1 + article.child(0).nodeSize + article.child(1).nodeSize // start of the second paragraph's text
    const anchor = anchorAt(article, flat, pos)
    expect(anchor).toMatchObject({ block_index: 2, pm_pos: pos })
    expect(anchor.quote.startsWith('A second paragraph has bold words')).toBe(true)
    expect(anchor.before_context.endsWith('explains the setting. ')).toBe(true)
    expect(flat.text.slice(anchor.text_offset).startsWith('A second')).toBe(true)
  })

  it('uses the saved position on the same structure and finds the text again in another version', () => {
    const flat = flattenDocument(article)
    const pos = 1 + article.child(0).nodeSize + article.child(1).nodeSize
    const anchor = anchorAt(article, flat, pos)
    expect(locateAnchor(article, flat, anchor, true)).toEqual({ pos, how: 'exact' })
    // A new version with a paragraph inserted before: the text moved, the quote finds it.
    const revised = doc(p(text('An added opening paragraph.')), ...article.toJSON().content)
    const located = locateAnchor(revised, flattenDocument(revised), anchor, false)
    expect(located?.how).toBe('quote')
    expect(revised.textBetween(located!.pos, located!.pos + 8)).toBe('A second')
  })

  it('accepts repeated text only where the text before it matches, and otherwise does not guess', () => {
    const repeated = doc(p(text('Intro one.')), p(text('Repeated passage here.')), p(text('Intro two.')), p(text('Repeated passage here.')))
    const flat = flattenDocument(repeated)
    const second = flat.text.lastIndexOf('Repeated')
    const anchor = anchorAt(repeated, flat, flat.positions[second])
    const located = locateAnchor(repeated, flat, anchor, false)
    expect(located?.pos).toBe(flat.positions[second])
    expect(locateAnchor(repeated, flat, { ...anchor, before_context: 'something else ' }, false)).toBeNull()
    expect(locateAnchor(repeated, flat, { ...anchor, quote: 'Not in this document at all' }, false)).toBeNull()
  })
})

describe('relocating a place in another version, conservatively', () => {
  const same = 'The same passage repeated across the document, word for word.'
  it('looks at every occurrence: a 51st one with the same text before it makes the place ambiguous', () => {
    // Paragraph 0 and paragraph 50 open the same way and follow identical text,
    // so the 40 characters before them match; every other paragraph differs.
    const line = (n: number) => `${n === 0 || n === 50 ? 'samecontext' : `ctx${n}`} ${same}`
    const many = doc(p(text(line(49))), ...Array.from({ length: 51 }, (_, n) => p(text(line(n)))))
    const flat = flattenDocument(many)
    const last = flat.text.lastIndexOf(same)
    const anchor = anchorAt(many, flat, flat.positions[last])
    expect(anchor.before_context.endsWith('samecontext ')).toBe(true)
    expect(locateAnchor(many, flat, anchor, false)).toBeNull()
  })

  it('reads a short saved context as "this close to the start": only that occurrence qualifies', () => {
    const repeated = doc(p(text(same)), p(text(same)), p(text(same)))
    const flat = flattenDocument(repeated)
    const anchor = anchorAt(repeated, flat, 1)
    expect(anchor.before_context).toBe('')
    // In another version the passage repeats and none is at the very start: not placed.
    const revised = doc(p(text('Intro.')), p(text(same)), p(text(same)), p(text(same)))
    expect(locateAnchor(revised, flattenDocument(revised), anchor, false)).toBeNull()
    // Where it is at the start, that occurrence is the place.
    const kept = doc(p(text(same)), p(text(same)), p(text(same)), p(text('Outro.')))
    expect(locateAnchor(kept, flattenDocument(kept), anchor, false)).toEqual({ pos: 1, how: 'quote' })
  })

  it('places a unique passage with emoji and CJK text', () => {
    const original = doc(p(text('前言。')), p(text('🙂 第二段的独特内容，包含 emoji 与中文。')))
    const flat = flattenDocument(original)
    const anchor = anchorAt(original, flat, original.child(0).nodeSize + 1)
    const revised = doc(p(text('新增导言。')), p(text('前言。')), p(text('🙂 第二段的独特内容，包含 emoji 与中文。')))
    const located = locateAnchor(revised, flattenDocument(revised), anchor, false)
    expect(revised.textBetween(located!.pos, located!.pos + 2)).toBe('🙂')
  })
})

describe('headings and find', () => {
  const article = doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
    p(text('Alpha beta '), text('Gamma', [{ type: 'italic' }]), text(' delta.')),
    { type: 'heading', attrs: { level: 3 }, content: [text('Details')] },
    p(text('gamma ends here')),
  )

  it('lists the headings with their level and block', () => {
    expect(documentHeadings(article).map(({ level, text: value, blockIndex }) => ({ level, value, blockIndex })))
      .toEqual([{ level: 1, value: 'Title', blockIndex: 0 }, { level: 3, value: 'Details', blockIndex: 2 }])
  })

  it('finds text case-insensitively across marks, never across blocks', () => {
    const flat = flattenDocument(article)
    const matches = findInDocument(flat, 'GAMMA')
    expect(matches).toHaveLength(2)
    expect(matches.map(match => article.textBetween(match.from, match.to))).toEqual(['Gamma', 'gamma'])
    expect(findInDocument(flat, 'beta gamma')).toHaveLength(1)
    expect(findInDocument(flat, 'delta. Details')).toHaveLength(0)
    expect(findInDocument(flat, '   ')).toEqual([])
  })
})
