// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { markdownToPlainText, markdownToProseMirrorJson } from '../markdownToProseMirror'

describe('markdownToProseMirrorJson', () => {
  it('converts headings, paragraphs, and inline marks', () => {
    const doc = markdownToProseMirrorJson('# Title\n\nHello **bold** and *em* and `code` and ~~strike~~.\n')
    expect(doc.type).toBe('doc')
    expect(doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    const paragraph = doc.content?.[1]
    expect(paragraph?.type).toBe('paragraph')
    const marksByText = Object.fromEntries(
      (paragraph?.content ?? []).map(n => [n.text, (n.marks ?? []).map(m => m.type)]),
    )
    expect(marksByText['bold']).toEqual(['bold'])
    expect(marksByText['em']).toEqual(['italic'])
    expect(marksByText['code']).toEqual(['code'])
    expect(marksByText['strike']).toEqual(['strike'])
  })

  it('converts links and images with attrs', () => {
    const doc = markdownToProseMirrorJson('[a link](https://example.com/x)\n\n![alt text](https://example.com/img.png)\n')
    const linkPara = doc.content?.[0]
    const linkText = linkPara?.content?.find(n => n.text === 'a link')
    expect(linkText?.marks).toEqual([{ type: 'link', attrs: { href: 'https://example.com/x' } }])
    const imagePara = doc.content?.[1]
    expect(imagePara?.content?.[0]).toMatchObject({
      type: 'image',
      attrs: { src: 'https://example.com/img.png', alt: 'alt text' },
    })
  })

  it('converts bullet and ordered lists', () => {
    const doc = markdownToProseMirrorJson('- one\n- two\n\n1. first\n2. second\n')
    expect(doc.content?.[0]?.type).toBe('bulletList')
    expect(doc.content?.[0]?.content?.length).toBe(2)
    expect(doc.content?.[0]?.content?.[0]).toMatchObject({ type: 'listItem' })
    expect(doc.content?.[1]?.type).toBe('orderedList')
  })

  it('converts blockquotes, code fences, and horizontal rules', () => {
    const doc = markdownToProseMirrorJson('> quoted text\n\n```ts\nconst x = 1\n```\n\n---\n')
    expect(doc.content?.[0]).toMatchObject({ type: 'blockquote' })
    expect(doc.content?.[1]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const x = 1' }],
    })
    expect(doc.content?.[2]).toMatchObject({ type: 'horizontalRule' })
  })

  it('converts GFM tables into the reader\'s table/tableRow/tableHeader/tableCell nodes', () => {
    const doc = markdownToProseMirrorJson('| A | B |\n| - | - |\n| 1 | 2 |\n')
    const table = doc.content?.[0]
    expect(table?.type).toBe('table')
    expect(table?.content).toHaveLength(2)
    const [headerRow, bodyRow] = table!.content!
    expect(headerRow.content?.[0]).toMatchObject({ type: 'tableHeader' })
    expect(bodyRow.content?.[0]).toMatchObject({ type: 'tableCell' })
  })

  it('never produces an empty content array for an empty document', () => {
    const doc = markdownToProseMirrorJson('')
    expect(doc).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it('extracts plain text for the reader\'s normalizedText prop', () => {
    const doc = markdownToProseMirrorJson('# Title\n\nSome **bold** text.\n')
    expect(markdownToPlainText(doc)).toBe('Title\n\nSome bold text.')
  })
})
