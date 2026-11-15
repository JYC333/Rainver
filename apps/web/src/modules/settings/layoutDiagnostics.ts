/** Deliberately content-free: no location, element text, ids or workspace data. */
export function collectLayoutDiagnostics() {
  const rect = (element: Element | null) => {
    if (!element) return null
    const { x, y, width, height, bottom, right } = element.getBoundingClientRect()
    return { x, y, width, height, bottom, right }
  }
  const box = (element: Element | null) => {
    if (!element) return null
    const style = getComputedStyle(element)
    return { rect: rect(element), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
      position: style.position, display: style.display, boxSizing: style.boxSizing,
      height: style.height, minHeight: style.minHeight, maxHeight: style.maxHeight,
      top: style.top, bottom: style.bottom, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
      overflow: style.overflow, background: style.backgroundColor }
  }
  const meta = (name: string) => Array.from(document.querySelectorAll('meta')).filter(item => item.name.toLowerCase() === name).map(item => item.content)
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:0;padding:var(--app-safe-top) var(--app-safe-right) var(--app-safe-bottom) var(--app-safe-left)'
  document.body.append(probe)
  let safeArea, units
  try {
    const style = getComputedStyle(probe)
    safeArea = { top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft }
    probe.style.padding = '0'
    units = Object.fromEntries(['100vh', '100dvh', '100svh', '-webkit-fill-available'].map(value => {
      probe.style.height = ''
      probe.style.height = value
      return [value, { supported: CSS.supports('height', value), rect: rect(probe), computedHeight: getComputedStyle(probe).height }]
    }))
  } finally { probe.remove() }
  const viewport = window.visualViewport
  const shell = document.querySelector('.app-safe-shell')
  return {
    userAgent: navigator.userAgent,
    standalone: { displayMode: matchMedia('(display-mode: standalone)').matches,
      navigator: (navigator as Navigator & { standalone?: boolean }).standalone ?? null },
    meta: { viewport: meta('viewport'), statusBarStyle: meta('apple-mobile-web-app-status-bar-style'),
      appleWebAppCapable: meta('apple-mobile-web-app-capable'), webAppCapable: meta('mobile-web-app-capable'),
      buildInputs: meta('rainver-build-inputs') },
    screen: { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio },
    window: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    document: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
    visualViewport: viewport ? { width: viewport.width, height: viewport.height, offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft, scale: viewport.scale } : null,
    safeArea, viewportUnits: units, root: box(document.documentElement), body: box(document.body),
    appRoot: box(document.getElementById('root')), shell: box(shell),
    navigation: box(shell?.querySelector('nav.md\\:hidden') ?? null),
    mobileConversation: document.documentElement.hasAttribute('data-mobile-conversation'),
    iPhonePwaLayout: document.documentElement.hasAttribute('data-iphone-pwa'),
    focusedEditor: document.activeElement?.matches('input,textarea,[contenteditable="true"]') ?? false,
  }
}

/** Optional read, only same origin, bounded bytes/time, no retained URLs or text. */
export async function readManifestDisplay(): Promise<{ status: string; display?: string; displayOverride?: string[] }> {
  const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href
  if (!href) return { status: 'absent' }
  try {
    const url = new URL(href, location.href)
    if (url.origin !== location.origin) return { status: 'cross-origin-skipped' }
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok || !response.body) return { status: 'unavailable' }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 65536) { await reader.cancel(); return { status: 'too-large' } }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const value = JSON.parse(new TextDecoder().decode(bytes))
    const allowed = new Set(['fullscreen', 'standalone', 'minimal-ui', 'browser', 'window-controls-overlay', 'tabbed', 'unframed'])
    return { status: 'read', ...(allowed.has(value.display) ? { display: value.display as string } : {}),
      ...(Array.isArray(value.display_override) ? { displayOverride: value.display_override.filter((mode: unknown) => typeof mode === 'string' && allowed.has(mode)).slice(0, 8) } : {}) }
  } catch { return { status: 'unavailable' } }
}
