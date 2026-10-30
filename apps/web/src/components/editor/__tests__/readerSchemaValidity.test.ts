import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { markdownToReaderDocument, normalizeReaderDocument, type ReaderNode } from '@rainver/reader-document'
import { readerContentExtensions } from '../ReadOnlyTiptapReader'

// The schema the Reader actually renders with, not a JSON shape.
const schema = getSchema(readerContentExtensions())
const check = (json: unknown) => { const doc = ProseMirrorNode.fromJSON(schema, json); doc.check(); return doc }

describe('stored Reader documents are valid for the Reader schema', () => {
  it.each([
    ['list item opening with a heading', '- ## Title\n\n  body'],
    ['list item opening with a nested list', '- - inner'],
    ['list item opening with code', '- ```\n  code\n  ```'],
    ['list item opening with an image', '- ![a](https://example.test/a.png)'],
    ['code inside a link', '[`code`](https://example.test/x)'],
    ['emphasis around code', '***`x`*** and ~~`y`~~'],
    ['table with marks and code', '| **a** | `b` |\n|---|---|\n| [c](https://e.test) | ~~d~~ |'],
    ['headings with images', '# Title ![a](https://e.test/a.png) tail'],
    ['blockquote with list and code', '> - a\n>\n> ```\n> x\n> ```'],
    ['empty and whitespace', '   \n\n  '],
  ])('Markdown: %s', (_case, markdown) => {
    expect(() => check(markdownToReaderDocument(markdown))).not.toThrow()
  })

  it.each([
    ['code with a link mark (HTML <a><code>)', { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://e.test' } }] }] }],
    ['list item opening with heading', { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'T' }] }] }] }],
    ['list item opening with a list', { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] }] }],
    ['list item opening with an image', { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'image', attrs: { src: 'https://e.test/a.png' } }] }] }],
    ['marks on code block text', { type: 'codeBlock', content: [{ type: 'text', text: '  x', marks: [{ type: 'bold' }] }] }],
    ['empty text nodes', { type: 'paragraph', content: [{ type: 'text', text: '' }] }],
    ['empty list, table and blockquote', { type: 'doc', content: [{ type: 'bulletList' }, { type: 'table' }, { type: 'blockquote' }] }],
  ])('normalized: %s', (_case, node) => {
    expect(() => check(normalizeReaderDocument({ type: 'doc', content: [node] }))).not.toThrow()
  })

  it('degrades any nesting of supported and unsupported nodes to a valid tree (deterministic random structures)', () => {
    let seed = 7
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const types = ['paragraph', 'heading', 'codeBlock', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell', 'tableHeader', 'image', 'horizontalRule', 'text', 'hardBreak', 'mention', 'mathBlock']
    const markTypes = ['bold', 'italic', 'strike', 'code', 'link', 'highlight']
    const node = (depth: number): ReaderNode => {
      const type = types[Math.floor(random() * types.length)]!
      if (type === 'text') return { type, text: random() < 0.1 ? '' : 'w', marks: markTypes.filter(() => random() < 0.3).map(mark => mark === 'link' ? { type: mark, attrs: { href: 'https://e.test' } } : { type: mark }) }
      if (type === 'image') return { type, attrs: { src: random() < 0.8 ? 'https://e.test/i.png' : '' } }
      const children = depth > 3 ? [] : Array.from({ length: Math.floor(random() * 4) }, () => node(depth + 1))
      return { type, attrs: { level: Math.floor(random() * 9) }, content: children }
    }
    for (let round = 0; round < 400; round += 1) {
      const input = { type: 'doc', content: Array.from({ length: 1 + Math.floor(random() * 4) }, () => node(0)) }
      expect(() => check(normalizeReaderDocument(input)), JSON.stringify(input)).not.toThrow()
    }
  })

  it('normalizing a valid document changes nothing (stored trees are a fixed point)', () => {
    const doc = markdownToReaderDocument('# T\n\n- a\n  - b\n\n```\n  x\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(normalizeReaderDocument(doc)).toEqual(doc)
  })
})
