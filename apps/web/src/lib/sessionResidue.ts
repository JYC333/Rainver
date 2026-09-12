/**
 * Authenticated browser leftovers that must not survive logout or a 401.
 *
 * Stated as what to **keep**, not what to delete. A delete-list is wrong by
 * default: every new feature that stores a note id, a thread, a draft or a
 * chat session is retained across logout until somebody remembers to add its
 * prefix here, and nobody finds out until the next person on that machine sees
 * it. A keep-list is wrong in the harmless direction — a forgotten preference
 * is re-chosen, not disclosed.
 */
export const API_CACHE_NAME = 'api-cache'
export const API_KEY_STORAGE = 'rainver:api-key'

/**
 * Keys that survive a logout, because they describe the browser rather than
 * the person: appearance, layout, and which panes were open. Nothing here
 * names a Space, a Project, a note, or anything a person wrote.
 */
const KEEP_LOCAL_EXACT = [
  'rainver:theme',
  'rainver:rail-expanded',
  // A map keyed by scene id. Safe while scene ids come from the static module
  // registry; if one ever became a Space or Project id, a content key would be
  // on this list with nothing to catch it.
  'rainver:scene-collapsed',
  'rainver:knowledge-section',
  'project.areas.open',
  'project.sidecar.width',
]
/**
 * No prefix is safe to keep wholesale, which is the point. `project.sidecar.`
 * covers both a pane width and `project.sidecar.room.<id>.conversation`, and
 * `rainver:` covers both the theme and every notebook chat session — so a new
 * preference is listed by name, and anything nobody listed is cleared.
 */
const KEEP_LOCAL_PREFIXES: string[] = []

/** `sessionStorage` is per-tab and holds only open-pane state; none of it is kept. */
const KEEP_SESSION_EXACT: string[] = []
const KEEP_SESSION_PREFIXES: string[] = []

/** Tells the other tabs of this browser that the session is over. */
const LOGOUT_CHANNEL = 'rainver:auth'
const LOGOUT_MESSAGE = 'logged-out'

function keptKeys(exact: string[], prefixes: string[]): (key: string) => boolean {
  return (key: string) => exact.includes(key) || prefixes.some(prefix => key.startsWith(prefix))
}

function clearExcept(storage: Storage, keep: (key: string) => boolean): void {
  const doomed: string[] = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key && !keep(key)) doomed.push(key)
  }
  for (const key of doomed) storage.removeItem(key)
}

export function dropStorageKey(storage: Storage, key: string): void {
  try { storage.removeItem(key) } catch { /* private mode */ }
}

export function clearSessionResidue(): void {
  try { clearExcept(window.localStorage, keptKeys(KEEP_LOCAL_EXACT, KEEP_LOCAL_PREFIXES)) } catch { /* private mode */ }
  try { clearExcept(window.sessionStorage, keptKeys(KEEP_SESSION_EXACT, KEEP_SESSION_PREFIXES)) } catch { /* private mode */ }
}

/** Removes the API response cache, whatever state the app thinks it is in. */
export async function dropApiCache(): Promise<void> {
  if (typeof caches === 'undefined') return
  try { await caches.delete(API_CACHE_NAME) } catch { /* unsupported */ }
}

export async function clearAuthenticatedBrowserState(): Promise<void> {
  clearSessionResidue()
  await dropApiCache()
}

/**
 * Runs once at boot, before the app asks who is signed in.
 *
 * The service worker must not cache authenticated API bodies, and does not —
 * but a cache written by an older build, or left behind when a tab was closed
 * mid-logout, outlives the code that stopped writing it. Deleting it
 * unconditionally costs one cache miss on something that was never
 * supposed to be there.
 */
export function dropApiCacheAtBoot(): void {
  void dropApiCache()
}

/**
 * The one channel this tab both listens on and announces through.
 *
 * One object on purpose: a `BroadcastChannel` never delivers to itself, but it
 * does deliver to every *other* channel object — including another one in the
 * same tab. Announcing through a second object made the tab that signed out
 * hear its own logout and run the remote handler on itself.
 */
let logoutChannel: BroadcastChannel | null = null

function openLogoutChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (logoutChannel) return logoutChannel
  try {
    logoutChannel = new BroadcastChannel(LOGOUT_CHANNEL)
  } catch {
    return null
  }
  return logoutChannel
}

/**
 * Runs `onRemote` when another tab of this browser signs out.
 *
 * Without it, signing out in one tab left every other tab holding a rendered
 * page full of the previous person's content until something happened to make
 * it call the API. Returns a stop function.
 */
export function watchCrossTabLogout(onRemote: () => void): () => void {
  const channel = openLogoutChannel()
  if (!channel) return () => {}
  const handler = (event: MessageEvent) => {
    if (event.data === LOGOUT_MESSAGE) onRemote()
  }
  channel.addEventListener('message', handler)
  return () => channel.removeEventListener('message', handler)
}

/** Tells this browser's other tabs that the session is over. */
export function announceLogout(): void {
  openLogoutChannel()?.postMessage(LOGOUT_MESSAGE)
}

/** Exported for tests: forget the channel so the next open makes a new one. */
export function __resetLogoutChannelForTests(): void {
  try { logoutChannel?.close() } catch { /* already closed */ }
  logoutChannel = null
}

export function scopedUserStorageKey(kind: string, userId: string, ...parts: string[]): string {
  return [`rainver:${kind}`, userId, ...parts].join(':')
}
