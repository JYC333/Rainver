import { cjk } from '@streamdown/cjk'
import type { ComponentProps } from 'react'
import { defaultRehypePlugins, type StreamdownProps } from 'streamdown'
import { safeHttpUrl, safeAppPath } from '../../lib/safeHttpUrl'

/**
 * What a chat renderer is allowed to do with model-written markdown.
 *
 * One config, spread by every Streamdown in the app, because the interesting
 * question is not what any single surface renders — it is that a new surface
 * cannot render more than the others by forgetting a prop.
 */

/**
 * The image source, or nothing.
 *
 * Same-origin sources survive as a path; an absolute `http(s)` URL survives as
 * itself and {@link MarkdownImage} decides whether it may load. Everything else
 * — `data:`, `blob:`, `javascript:`, protocol-relative — is blanked here, so a
 * renderer that bypasses the component still cannot fetch one.
 */
export function safeMarkdownImageSource(url: string): string {
  return safeAppPath(url) ?? safeHttpUrl(url) ?? ''
}

/**
 * Streamdown's default harden config allows every protocol. Pin ours.
 *
 * `src` is the only image key that reaches here: the transform runs for the
 * keys in `html-url-attributes`, and `srcSet` is not one of them — which is
 * why {@link SAFE_SANITIZE_SCHEMA} has to take `<source>` away rather than
 * this function cleaning it. `poster` belongs to `<video>`, which sanitize
 * strips. Listing them here read as coverage of three vectors and was
 * coverage of one.
 */
export function safeMarkdownUrlTransform(url: string, key: string): string {
  if (key === 'src') return safeMarkdownImageSource(url)
  // An in-app path is a real destination in this product, and blanking it gave
  // `href=""`, which reloads the page on click.
  if (key === 'href') return safeAppPath(url) ?? safeHttpUrl(url) ?? ''
  return safeHttpUrl(url) ?? ''
}

/**
 * The sanitize schema, minus the one element that fetches behind the image
 * component's back.
 *
 * `<picture><source srcset="https://…"><img src="/ours.png"></picture>` fetches
 * the *source* — zero-click, to a host the model named — and the same-origin
 * `<img>` we render is what activates it, because a `<picture>` with no `<img>`
 * fetches nothing. `srcSet` is not a key `urlTransform` is called for and
 * `components` only governs elements we name, so neither of this file's other
 * two defences sees it. Taking `source` out of the allowed tags is what closes
 * it; `<picture>` stays, and with no `<source>` inside it is just its `<img>`.
 */
const sanitizeEntry = defaultRehypePlugins.sanitize as [unknown, Record<string, unknown>]
const defaultSchema = sanitizeEntry[1]
export const SAFE_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames as string[]).filter(tag => tag !== 'source'),
  // Taking the tag out is what matters — with `source` gone from `tagNames` the
  // element is unwrapped before its attributes are read, so this entry never
  // fires. It stays so that a future schema that allows `source` again for some
  // other reason does not also hand it back its `srcSet`.
  attributes: { ...(defaultSchema.attributes as Record<string, unknown>), source: [] },
}

const safeRehypePlugins = Object.entries(defaultRehypePlugins).map(([name, plugin]) =>
  name === 'sanitize' ? [sanitizeEntry[0], SAFE_SANITIZE_SCHEMA] : plugin,
) as StreamdownProps['rehypePlugins']

/** Whether this source is served by us, and may therefore load inline. */
export function isSameOriginImage(src: string | undefined): boolean {
  if (!src) return false
  if (safeAppPath(src)) return true
  const href = safeHttpUrl(src)
  if (!href) return false
  try {
    return new URL(href).origin === window.location.origin
  } catch {
    return false
  }
}

/**
 * An image the model asked for.
 *
 * A cross-origin `<img>` in a conversation is a read receipt at best and an
 * exfiltration channel at worst: the browser fetches it with no click, and the
 * URL it fetches can carry whatever the model was induced to put in it. So an
 * external image is never loaded — it renders as an ordinary link, with the
 * domain visible, the full URL on hover, and a new tab if the person decides to
 * open it (D5). Click-to-load was rejected: the click sends the same URL, so it
 * only turns zero-click into one-click.
 *
 * This catches raw `<img>` HTML as well as markdown: Streamdown's default
 * pipeline *is* `rehype-raw` → `rehype-sanitize` → `rehype-harden`, so model-
 * written HTML is parsed into real elements and both kinds of image arrive
 * here. `skipHtml` does not catch it — it visits `raw` nodes after the unified
 * run, and `rehype-raw` has already consumed them into elements, so it finds
 * none and silently does nothing. That is why the prop was removed rather than
 * trusted, and why what stands between model-written HTML and the DOM is the
 * sanitize schema (see {@link SAFE_SANITIZE_SCHEMA}), not a skip flag.
 */
export function MarkdownImage({ src, alt, title, node: _node, ...props }: ComponentProps<'img'> & { node?: unknown }) {
  const source = typeof src === 'string' ? src : undefined
  if (isSameOriginImage(source)) {
    // biome-ignore lint/a11y/useAltText: alt comes from the markdown; `''` is the correct decorative default.
    return <img {...props} src={source} alt={alt ?? ''} title={title} className="max-w-full rounded-lg" />
  }
  const href = source ? safeHttpUrl(source) : null
  if (!href) return null
  let domain = href
  try {
    domain = new URL(href).hostname
  } catch {
    /* safeHttpUrl already parsed it; keep the href as the label */
  }
  const label = typeof alt === 'string' && alt.trim() ? `${alt.trim()} — ${domain}` : domain
  return (
    <a
      href={href}
      title={href}
      target="_blank"
      rel="noopener noreferrer"
      className="wrap-anywhere font-medium text-primary underline"
      data-external-image="true"
    >
      {label}
    </a>
  )
}

/**
 * Syntax plugins.
 *
 * CJK spacing only. Mermaid, Shiki and LaTeX are absent for the same kind of
 * reason: a second of import time each per test file, and a large chunk in a
 * bundle every visitor downloads, to render something nobody has asked a
 * conversation to do. Add one back when a surface needs it — and pin its
 * grammar set if it is `code`.
 */
const streamdownPlugins = { cjk }

/**
 * Which links need the person to confirm before they are followed.
 *
 * Streamdown asks this at click time and shows its confirmation modal when the
 * answer is no. An in-app path does not need it — it is this instance — and
 * without the check every `[x](/projects/abc)` a model wrote put a confirmation
 * dialog in front of an ordinary piece of navigation. Everything else keeps the
 * modal, which is what an external link in a conversation should get, since the
 * URL was written by a model that may have read someone else's text.
 */
const linkSafety = {
  enabled: true,
  onLinkCheck: (url: string) => safeAppPath(url) !== null,
}

export const safeStreamdownProps = {
  plugins: streamdownPlugins,
  rehypePlugins: safeRehypePlugins,
  urlTransform: safeMarkdownUrlTransform,
  components: { img: MarkdownImage },
  linkSafety,
}
