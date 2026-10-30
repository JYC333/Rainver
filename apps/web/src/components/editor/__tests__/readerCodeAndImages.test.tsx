import { createRef } from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadOnlyTiptapReader, type ReadOnlyTiptapReaderHandle } from '../ReadOnlyTiptapReader'

const labels = { copy: 'Copy code', copied: 'Copied', failed: 'Copy failed' }
const code = '  def f(x):\n\treturn x  # “quoted” <tag> & 中文\n'
const doc = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
  { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: code }] },
] }

afterEach(() => { Reflect.deleteProperty(navigator, 'clipboard') })

describe('code blocks', () => {
  it('copies the block’s text exactly, and the button is not part of the document’s text', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const ref = createRef<ReadOnlyTiptapReaderHandle>()
    const { container } = render(<ReadOnlyTiptapReader ref={ref} contentJson={doc} normalizedText={`Intro ${code}`} codeCopyLabels={labels} />)
    const button = await waitFor(() => { const found = container.querySelector<HTMLButtonElement>('button[data-copy-code]'); expect(found).not.toBeNull(); return found! })
    // The button adds no block of its own: top-level DOM children still match the document's blocks.
    expect(container.querySelectorAll('.reader-surface > *')).toHaveLength(ref.current!.blockCount())
    fireEvent.click(button)
    expect(writeText).toHaveBeenCalledWith(code)
    await waitFor(() => expect(button).toHaveTextContent('Copied'))
    // A quote of the whole block (keyboard annotate) has the code only.
    expect(ref.current?.blockSelection(1)?.quoteText).not.toContain('Copy code')
  })

  it('has no copy button where no labels are given', () => {
    const { container } = render(<ReadOnlyTiptapReader contentJson={doc} normalizedText={`Intro ${code}`} />)
    expect(container.querySelector('button[data-copy-code]')).toBeNull()
  })
})

describe('opening images', () => {
  const withImage = { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://news.example/chart.png', alt: 'Chart', title: null } }] }

  it('opens an image the policy shows, with the address it loaded', async () => {
    const onImageOpen = vi.fn()
    const { container } = render(<ReadOnlyTiptapReader contentJson={withImage} normalizedText="" remoteImages onImageOpen={onImageOpen} />)
    const image = await waitFor(() => { const found = container.querySelector('img[data-reader-image]'); expect(found).not.toBeNull(); return found! })
    fireEvent.click(image)
    expect(onImageOpen).toHaveBeenCalledWith({ src: 'https://news.example/chart.png', alt: 'Chart' })
    fireEvent.keyDown(image, { key: 'Enter' })
    expect(onImageOpen).toHaveBeenCalledTimes(2)
  })

  it('leaves an image the policy withholds as a link: nothing to enlarge, nothing requested', async () => {
    const onImageOpen = vi.fn()
    const { container } = render(<ReadOnlyTiptapReader contentJson={withImage} normalizedText="" onImageOpen={onImageOpen} />)
    const link = await waitFor(() => { const found = container.querySelector('a[data-external-image]'); expect(found).not.toBeNull(); return found! })
    expect(container.querySelector('img')).toBeNull()
    link.addEventListener('click', event => event.preventDefault())
    fireEvent.click(link)
    expect(onImageOpen).not.toHaveBeenCalled()
  })
})
