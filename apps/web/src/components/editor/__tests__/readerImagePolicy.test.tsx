import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadOnlyTiptapReader } from '../ReadOnlyTiptapReader'

// A browser starts fetching as soon as `src` is set on an <img>, attached or
// not, so the test records every src ever assigned to an image element.
let requested: string[] = []
const original = Element.prototype.setAttribute
beforeEach(() => {
  requested = []
  vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, value: string) {
    if (this.tagName === 'IMG' && name === 'src') requested.push(value)
    return original.call(this, name, value)
  })
})
afterEach(() => { vi.restoreAllMocks() })

const image = (src: string) => ({ type: 'image', attrs: { src, alt: '', title: null } })
const doc = (...srcs: string[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }, ...srcs.map(image)] })
const shownImages = (container: HTMLElement) => [...container.querySelectorAll('img[src]')].map(img => img.getAttribute('src')).filter(src => src && !src.startsWith('data:'))
const reader = (contentJson: Record<string, unknown>, remoteImages: boolean) =>
  <ReadOnlyTiptapReader contentJson={contentJson} normalizedText="Body" remoteImages={remoteImages} />

describe('ReadOnlyTiptapReader image policy changes', () => {
  it('never requests an image of new content that arrives with a stricter policy (allowed → none)', async () => {
    const { container, rerender } = render(reader(doc('https://news.example/old.jpg'), true))
    await waitFor(() => expect(container.querySelector('img[src="https://news.example/old.jpg"]')).not.toBeNull())
    rerender(reader(doc('https://news.example/old.jpg', 'https://tracker.example/new-agent.jpg'), false))
    await waitFor(() => expect(container.querySelector('a[data-external-image][href="https://tracker.example/new-agent.jpg"]')).not.toBeNull())
    expect(requested).not.toContain('https://tracker.example/new-agent.jpg')
    // Nothing rendered under the previous policy stays on screen either.
    expect(shownImages(container)).toEqual([])
  })

  it('shows the same document’s images once the policy allows them (none → allowed)', async () => {
    const content = doc('https://news.example/a.jpg')
    const { container, rerender } = render(reader(content, false))
    await waitFor(() => expect(container.querySelector('a[data-external-image]')).not.toBeNull())
    expect(requested).toEqual([])
    rerender(reader(content, true))
    await waitFor(() => expect(container.querySelector('img[src="https://news.example/a.jpg"]')).not.toBeNull())
    expect(container.querySelector('a[data-external-image]')).toBeNull()
  })

  it('drops loaded images when the same document is reprocessed under a stricter policy', async () => {
    const content = doc('https://news.example/a.jpg')
    const { container, rerender } = render(reader(content, true))
    await waitFor(() => expect(shownImages(container)).toEqual(['https://news.example/a.jpg']))
    const before = requested.length
    rerender(reader({ ...content }, false))
    await waitFor(() => expect(shownImages(container)).toEqual([]))
    expect(container.querySelector('a[data-external-image][href="https://news.example/a.jpg"]')).not.toBeNull()
    expect(requested.length).toBe(before)
  })

  it('never requests an image of the previous document when new content arrives with a looser policy (none → allowed)', async () => {
    const { container, rerender } = render(reader(doc('https://tracker.example/old-agent.jpg'), false))
    await waitFor(() => expect(container.querySelector('a[data-external-image]')).not.toBeNull())
    expect(requested).toEqual([])
    rerender(reader(doc('https://news.example/new-source.jpg'), true))
    await waitFor(() => expect(shownImages(container)).toEqual(['https://news.example/new-source.jpg']))
    expect(requested).not.toContain('https://tracker.example/old-agent.jpg')
    expect(requested).toEqual(['https://news.example/new-source.jpg'])
  })

  it('draws a content-only change under the unchanged policy', async () => {
    const { container, rerender } = render(reader(doc('https://tracker.example/a.jpg'), false))
    rerender(reader(doc('https://tracker.example/b.jpg'), false))
    await waitFor(() => expect(container.querySelector('a[data-external-image][href="https://tracker.example/b.jpg"]')).not.toBeNull())
    expect(requested).toEqual([])
    const allowed = render(reader(doc('https://news.example/a.jpg'), true))
    allowed.rerender(reader(doc('https://news.example/b.jpg'), true))
    await waitFor(() => expect(shownImages(allowed.container)).toEqual(['https://news.example/b.jpg']))
    expect(requested).toEqual(['https://news.example/a.jpg', 'https://news.example/b.jpg'])
  })

  it('clears the reader’s selection when the policy alone changes, as a content change does', async () => {
    const onTextSelected = vi.fn()
    const content = doc('https://news.example/a.jpg')
    const { rerender } = render(<ReadOnlyTiptapReader contentJson={content} normalizedText="Body" remoteImages onTextSelected={onTextSelected} />)
    onTextSelected.mockClear()
    rerender(<ReadOnlyTiptapReader contentJson={content} normalizedText="Body" remoteImages={false} onTextSelected={onTextSelected} />)
    await waitFor(() => expect(onTextSelected).toHaveBeenCalled())
    expect(onTextSelected).toHaveBeenLastCalledWith(null)
  })
})
