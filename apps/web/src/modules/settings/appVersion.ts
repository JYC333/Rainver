import { collectLayoutDiagnostics } from './layoutDiagnostics'
export interface AppBuild { id: string; builtAt: string; inputsHash?: string }
/** The running build, from the meta tags the production build writes into its HTML. */
export function readCurrentBuild(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): AppBuild {
  const meta = (name: string) => doc?.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? ''
  const id = meta('rainver-build-id')
  if (!id) return { id: 'development', builtAt: '' }
  const inputsHash = meta('rainver-build-inputs')
  return { id, builtAt: meta('rainver-build-at'), ...(/^[a-f0-9]{64}$/.test(inputsHash) ? { inputsHash } : {}) }
}
export const currentBuild: AppBuild = readCurrentBuild()

export async function fetchLatestBuild(): Promise<AppBuild> {
  const response = await fetch(`/version.json?check=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('Version check failed')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || !('id' in value) || !('builtAt' in value)
    || typeof value.id !== 'string' || !value.id || typeof value.builtAt !== 'string') throw new Error('Invalid build version')
  return { id: value.id, builtAt: value.builtAt, ...('inputsHash' in value && typeof value.inputsHash === 'string' && /^[a-f0-9]{64}$/.test(value.inputsHash) ? { inputsHash: value.inputsHash } : {}) }
}

// Set in this tab's sessionStorage when it reloads to apply an update that
// it could not activate first, because unsaved input held the page.
const UPDATE_AFTER_RELOAD = 'rainver:update-after-reload'
// After a prevented beforeunload, a page still alive this long kept its input:
// a confirmed reload is served by the worker and unloads well within it.
const KEPT_AFTER_MS = 2000

/**
 * Whether this page's own beforeunload guards (an unsaved editor or comment
 * draft) would hold a reload. They only read their own state, so a synthetic,
 * cancelable event asks them without any prompt.
 */
export function pageHoldsUnsavedWork(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

/**
 * Reload this tab. Resolves 'kept' when the reload did not replace this
 * document: the person stayed at the browser's unsaved-work prompt, no reload
 * started, or the page left into the back/forward cache and was restored.
 * Resolves 'reloaded' once the page hides for good; this document then goes.
 * Chromium holds the prompt inside the dispatch and WebKit in the task after
 * it, so the timer below starts counting only once the person has answered.
 */
function reloadUnlessKept(): Promise<'kept' | 'reloaded'> {
  return new Promise(resolve => {
    let leaving = false
    let kept: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      clearTimeout(started); clearTimeout(kept)
      window.removeEventListener('beforeunload', asked)
      window.removeEventListener('pagehide', left)
    }
    const stayed = () => { if (!leaving) { stop(); resolve('kept') } }
    const restored = (event: Event) => {
      if (!(event as PageTransitionEvent).persisted) return
      window.removeEventListener('pageshow', restored)
      resolve('kept')
    }
    const left = (event: Event) => {
      leaving = true; stop()
      if ((event as PageTransitionEvent).persisted) window.addEventListener('pageshow', restored)
      else resolve('reloaded')
    }
    const asked = (event: Event) => {
      clearTimeout(started)
      window.removeEventListener('beforeunload', asked)
      // Registered last, so every guard has already answered.
      if (event.defaultPrevented) kept = setTimeout(stayed, KEPT_AFTER_MS)
    }
    const started = setTimeout(stayed, 10_000)
    window.addEventListener('beforeunload', asked)
    window.addEventListener('pagehide', left)
    window.location.reload()
  })
}

function activate(worker: ServiceWorker): Promise<void> {
  if (worker.state === 'activated') return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed) }
    const changed = () => {
      if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' })
      else if (worker.state === 'activated') { cleanup(); resolve() }
      else if (worker.state === 'redundant') { cleanup(); reject(new Error('Update failed')) }
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Update timed out')) }, 20000)
    worker.addEventListener('statechange', changed)
    changed()
  })
}

// Whether the update this tab reloaded for could not be activated afterwards
// (the worker timed out or became redundant). The mark that asked for it is
// already gone, so this is the only trace: the app shows it with the same
// explicit action, and nothing retries by itself.
let updateNotApplied = false
const updateNotAppliedListeners = new Set<() => void>()
function setUpdateNotApplied(on: boolean) {
  if (updateNotApplied === on) return
  updateNotApplied = on
  for (const listener of updateNotAppliedListeners) listener()
}
export const readUpdateNotApplied = () => updateNotApplied
export function subscribeUpdateNotApplied(listener: () => void) {
  updateNotAppliedListeners.add(listener)
  return () => { updateNotAppliedListeners.delete(listener) }
}
export const dismissUpdateNotApplied = () => setUpdateNotApplied(false)

function rememberUpdate(on: boolean) {
  try { if (on) sessionStorage.setItem(UPDATE_AFTER_RELOAD, '1'); else sessionStorage.removeItem(UPDATE_AFTER_RELOAD) } catch { /* storage unavailable */ }
}

/**
 * How an update run ended: nothing to apply (only the start-up continuation),
 * the reload was kept off at the prompt (cancelled), or this document is being
 * replaced. A failure rejects instead.
 */
type RunOutcome = 'nothing' | 'kept' | 'reloaded'
export type UpdateOutcome = RunOutcome | 'failed'

/**
 * Apply the served build and reload, only on explicit request. While the tab
 * reloads this never settles; it resolves 'kept' when the reload was cancelled
 * (the person stayed at the unsaved-work prompt), and the same action can then
 * be retried. A waiting worker is activated only once no unsaved input holds
 * this tab: activation also moves this tab off its own worker and cached build.
 */
export function reloadLatestBuild(): Promise<'kept'> {
  return explicitRun().then(outcome => outcome === 'reloaded' ? new Promise<never>(() => {}) : 'kept')
}

// The one update run this document has in progress. Settings, the module-load
// panel, the not-applied notice and the start-up continuation share it, so
// overlapping requests join it instead of activating or reloading again. It is
// released only when the run settles: a page that hides into the
// back/forward cache keeps its check or activation and resumes with it.
let updateRun: { explicit: boolean, run: Promise<RunOutcome>, then?: Promise<RunOutcome> } | undefined
function runUpdateOnce(explicit: boolean, start: () => Promise<RunOutcome>): Promise<RunOutcome> {
  const current = { explicit, run: start() }
  updateRun = current
  const release = () => { if (updateRun === current) updateRun = undefined }
  current.run.then(release, release)
  return current.run
}

// Explicit requests made during a start-up continuation share its outcome,
// except when it had nothing to apply: then they run one explicit update
// together.
function explicitRun(): Promise<RunOutcome> {
  if (!updateRun) return runUpdateOnce(true, requestUpdate)
  if (updateRun.explicit) return updateRun.run
  updateRun.then ??= updateRun.run.then(outcome => outcome === 'nothing' ? explicitRun() : outcome)
  return updateRun.then
}

async function requestUpdate(): Promise<RunOutcome> {
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
  if (registration) {
    await registration.update()
    const worker = registration.installing ?? registration.waiting
    if (worker && pageHoldsUnsavedWork()) {
      // The fresh document, which holds no input, activates it.
      rememberUpdate(true)
      const outcome = await reloadUnlessKept()
      if (outcome === 'kept') rememberUpdate(false)
      return outcome
    }
    if (worker) await activate(worker)
  }
  return reloadUnlessKept()
}

/**
 * At start, after this document's worker registration settled: finish an
 * update this tab reloaded for without activating it. In Chromium a worker
 * asked to skip waiting right after a reload, while the registration's own
 * update checks run, was seen to stay installed for good, so this completes an
 * update check of its own first. Never rejects.
 */
export function finishUpdateAfterReload(): Promise<UpdateOutcome> {
  return (updateRun ? updateRun.run : runUpdateOnce(false, continueUpdate)).catch(() => 'failed' as const)
}

async function continueUpdate(): Promise<RunOutcome> {
  let requested = false
  try { requested = sessionStorage.getItem(UPDATE_AFTER_RELOAD) !== null } catch { return 'nothing' }
  if (!requested || !('serviceWorker' in navigator)) return 'nothing'
  rememberUpdate(false)
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration?.installing && !registration?.waiting) return 'nothing'
  try {
    // Offline, the worker that already installed still applies.
    await registration.update().catch(() => {})
    const worker = registration.installing ?? registration.waiting
    if (!worker) return 'nothing'
    await activate(worker)
  } catch (error) {
    // Timed out or redundant: stay on this build and say so.
    setUpdateNotApplied(true)
    throw error
  }
  return reloadUnlessKept()
}

export function readLayoutDiagnostics() {
  return { build: currentBuild.id, ...collectLayoutDiagnostics() }
}
