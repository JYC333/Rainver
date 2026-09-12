/**
 * Browser-side counterpart of the note reader's protocol check.
 * Only http(s) URLs become hrefs or window.open targets. javascript:,
 * data:, and embedded-credential URLs stay inert.
 *
 * In-app destinations use {@link safeAppPath}: a single leading slash,
 * never `//` (protocol-relative) or a backslash.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export function openSafeHttpUrl(raw: string | null | undefined): void {
  const href = safeHttpUrl(raw)
  if (!href) return
  window.open(href, '_blank', 'noopener,noreferrer')
}

/**
 * Same-origin app path for React Router / SpaceLink. Rejects off-site schemes.
 *
 * Resolved through `URL` rather than judged as text, because the browser
 * resolves it too and the two have to agree. `/..//evil.example` passes every
 * textual rule — one leading slash, no backslash, no control characters — and
 * the browser then collapses it to `//evil.example`, a protocol-relative URL
 * that leaves the site. Anything whose resolved origin is not this one is
 * refused, and what comes back is the resolved path so a later reader cannot
 * re-derive a different answer.
 */
export function safeAppPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null
  if (trimmed.includes('\\') || /[\u0000-\u001F\u007F]/.test(trimmed)) return null
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  try {
    const url = new URL(trimmed, origin)
    if (url.origin !== origin) return null
    const resolved = `${url.pathname}${url.search}${url.hash}`
    return resolved.startsWith('//') ? null : resolved
  } catch {
    return null
  }
}
