import { collectLayoutDiagnostics } from './layoutDiagnostics'
export interface AppBuild { id: string; builtAt: string; inputsHash?: string }
export const currentBuild: AppBuild = typeof __APP_BUILD__ === 'undefined'
  ? { id: 'development', builtAt: '' } : __APP_BUILD__

export async function fetchLatestBuild(): Promise<AppBuild> {
  const response = await fetch(`/version.json?check=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('Version check failed')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || !('id' in value) || !('builtAt' in value)
    || typeof value.id !== 'string' || !value.id || typeof value.builtAt !== 'string') throw new Error('Invalid build version')
  return { id: value.id, builtAt: value.builtAt, ...('inputsHash' in value && typeof value.inputsHash === 'string' && /^[a-f0-9]{64}$/.test(value.inputsHash) ? { inputsHash: value.inputsHash } : {}) }
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
  return { build: currentBuild.id, ...collectLayoutDiagnostics() }
}
