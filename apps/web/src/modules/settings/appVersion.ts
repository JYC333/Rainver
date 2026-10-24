export interface AppBuild { id: string; builtAt: string }
export const currentBuild: AppBuild = typeof __APP_BUILD__ === 'undefined'
  ? { id: 'development', builtAt: '' } : __APP_BUILD__

export async function fetchLatestBuild(): Promise<AppBuild> {
  const response = await fetch(`/version.json?check=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('Version check failed')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || !('id' in value) || !('builtAt' in value)
    || typeof value.id !== 'string' || !value.id || typeof value.builtAt !== 'string') throw new Error('Invalid build version')
  return { id: value.id, builtAt: value.builtAt }
}

/** Keep the existing auto-update owner in main.tsx; request a fresh SW check. */
export async function reloadLatestBuild() {
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration()
    if (registration) {
      await registration.update()
      const worker = registration.installing ?? registration.waiting
      if (worker && worker.state !== 'activated') {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed) }
          const changed = () => {
            if (worker.state === 'activated') { cleanup(); resolve() }
            else if (worker.state === 'redundant') { cleanup(); reject(new Error('Update failed')) }
          }
          const timer = setTimeout(() => { cleanup(); reject(new Error('Update timed out')) }, 20000)
          worker.addEventListener('statechange', changed)
          if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' })
          changed()
        })
      }
    }
  }
  window.location.reload()
}

export function readLayoutDiagnostics() {
  const rect = (element: Element | null) => {
    if (!element) return null
    const { x, y, width, height, bottom } = element.getBoundingClientRect()
    return { x, y, width, height, bottom }
  }
  const rootStyle = getComputedStyle(document.documentElement)
  const shell = document.querySelector('.app-safe-shell')
  const nav = Array.from(shell?.querySelectorAll('nav') ?? []).find(element => element.classList.contains('md:hidden'))
  // Resolve env() variables to pixels: custom properties alone retain env() text.
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:var(--app-safe-top) var(--app-safe-right) var(--app-safe-bottom) var(--app-safe-left)'
  document.body.append(probe)
  const style = getComputedStyle(probe)
  const safeArea = { top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft }
  probe.remove()
  const viewport = window.visualViewport
  return { build: currentBuild.id, userAgent: navigator.userAgent,
    standalone: matchMedia('(display-mode: standalone)').matches,
    screen: { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio },
    window: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    document: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
    visualViewport: viewport ? { width: viewport.width, height: viewport.height, offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft, scale: viewport.scale } : null,
    safeArea, shell: rect(shell), navigation: rect(nav ?? null), background: rootStyle.backgroundColor }
}
