import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReadOnlyTiptapReader } from '../ReadOnlyTiptapReader'

describe('ReadOnlyTiptapReader', () => {
  it('reports a block selection and block focus without selecting DOM text when a paragraph is clicked', async () => {
    const onTextSelected = vi.fn()
    const onBlockFocused = vi.fn()
    render(
      <ReadOnlyTiptapReader
        contentJson={{
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph.' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph.' }] },
          ],
        }}
        normalizedText="First paragraph. Second paragraph."
        onTextSelected={onTextSelected}
        onBlockFocused={onBlockFocused}
      />,
    )

    fireEvent.click(await screen.findByText('Second paragraph.'))

    await waitFor(() => {
      expect(onBlockFocused).toHaveBeenLastCalledWith(1)
      expect(onTextSelected).toHaveBeenLastCalledWith(expect.objectContaining({
        quoteText: 'Second paragraph.',
        anchorDraft: expect.objectContaining({
          quote_text: 'Second paragraph.',
          block_ref: expect.objectContaining({ index: 1, node_type: 'paragraph' }),
        }),
      }))
    })
    expect(window.getSelection()?.toString()).toBe('')
  })

  it('draws an annotation in its stored color but never lets the color add CSS', async () => {
    const annotation = (id: string, color: string, from: number, to: number) => ({
      id, space_id: 'space-1', project_id: null, document_type: 'source_item' as const, document_id: 'doc-1',
      annotation_type: 'highlight' as const, quote_text: '', color, label: null,
      visibility: 'space_shared' as const, status: 'active' as const, anchor_state: 'verified' as const,
      created_by_user_id: 'user-2', created_at: '', updated_at: '',
      anchor_json: {
        schema_version: 1 as const, normalizer: 'v1', quote_text: '', before_context: '', after_context: '',
        text_range: { start: 0, end: 0, unit: 'utf16' as const }, tiptap_range: { from, to },
      },
    })
    const { container } = render(
      <ReadOnlyTiptapReader
        contentJson={{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha beta' }] }] }}
        normalizedText="Alpha beta"
        annotations={[
          annotation('ann-safe', '#a1b2c3', 1, 6),
          annotation('ann-hostile', 'red;background:url(//t.example/a)', 7, 11),
        ]}
      />,
    )

    await waitFor(() => expect(container.querySelector('[data-annotation-id="ann-hostile"]')).not.toBeNull())
    const safe = container.querySelector('[data-annotation-id="ann-safe"]') as HTMLElement
    const hostile = container.querySelector('[data-annotation-id="ann-hostile"]') as HTMLElement
    expect(safe.getAttribute('style')).toContain('--reader-annotation-color: #a1b2c3')
    expect(hostile.getAttribute('style') ?? '').not.toContain('url(')
    expect(hostile.style.background).toBe('')
  })

  it('renders reader table nodes', async () => {
    render(
      <ReadOnlyTiptapReader
        contentJson={{
          type: 'doc',
          content: [{
            type: 'table',
            content: [{
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'No.' }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '行程概览' }] }] },
              ],
            }, {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Day 1' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '北京大兴→乌鲁木齐' }] }] },
              ],
            }],
          }],
        }}
        normalizedText="No. 行程概览 Day 1 北京大兴→乌鲁木齐"
      />,
    )

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'No.' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Day 1' })).toBeInTheDocument()
  })

  it('does not render javascript: links or data: images', async () => {
    render(
      <ReadOnlyTiptapReader
        contentJson={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
            },
            { type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'bad' } },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'safe', marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }] }],
            },
          ],
        }}
        normalizedText="evil safe"
      />,
    )

    expect(await screen.findByText('evil')).toBeInTheDocument()
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(document.querySelector('img[src^="javascript:"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'safe' })).toHaveAttribute('href', 'https://example.com/a')
  })
})
