import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownReader } from '../MarkdownReader'

/**
 * Mounts the converter's output through the real Tiptap/ProseMirror editor
 * (not just asserting the JSON shape) — ProseMirror throws at doc
 * construction if a node's content violates its schema, so this is the real
 * check that the converter's node/mark names and nesting are valid for
 * `ReadOnlyTiptapReader`'s actual schema (tables, code blocks, blockquotes,
 * images, and every inline mark included).
 */
describe('MarkdownReader', () => {
  it('mounts a table, code fence, blockquote, image, and every inline mark without throwing', async () => {
    const markdown = [
      '# Digest',
      '',
      '> quoted context',
      '',
      '| Item | Relevance |',
      '| --- | --- |',
      '| Paper one | relevant |',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      'Body with **bold**, *em*, ~~strike~~, and `code`.',
      '',
      '![alt text](https://example.com/img.png)',
      '',
    ].join('\n')

    render(<MarkdownReader markdown={markdown} />)

    expect(await screen.findByRole('heading', { name: 'Digest' })).toBeInTheDocument()
    expect(screen.getByText('quoted context')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Item' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Paper one' })).toBeInTheDocument()
    expect(screen.getByText('const x = 1')).toBeInTheDocument()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('em').tagName).toBe('EM')
    expect(screen.getByText('strike').tagName).toBe('S')
    expect(screen.getByText('code').tagName).toBe('CODE')
    // A cross-origin image in model-authored markdown is a link, not an
    // `<img>` the browser fetches — see `readerImages.test.tsx`. What this
    // case is about is that the node type mounts at all.
    expect(screen.getByRole('link', { name: /alt text/ })).toHaveAttribute('href', 'https://example.com/img.png')
  })

  it('renders an empty document without throwing', async () => {
    render(<MarkdownReader markdown="" />)
    expect(await screen.findByText('', { selector: 'p' })).toBeInTheDocument()
  })
})
