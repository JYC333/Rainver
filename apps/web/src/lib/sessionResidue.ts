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
const PENDING_LOGOUT = 'rainver:pending-logout'

/**
 * Keys that survive a logout, because they describe the browser rather than
 * the person: appearance, layout, and which panes were open. Nothing here
 * names a Space, a Project, a note, or anything a person wrote.
 */
const KEEP_LOCAL_EXACT = [
  PENDING_LOGOUT,
  'rainver:theme',
  'rainver:locale',
  'rainver:rail-expanded',
  // A map keyed by scene id. Safe while scene ids come from the static module
  // registry; if one ever became a Space or Project id, a content key would be
  // on this list with nothing to catch it.
  'rainver:scene-collapsed',
  'rainver:knowledge-section',
  'project.areas.open',
  'project.sidecar.width',
  // Which Reader panels were open (two booleans), and the Reading list density.
  'rainver:reader-layout',
  'rainver:reading-density',
]
/**
 * Do not keep a prefix wholesale. `project.sidecar.`
 * covers both a pane width and `project.sidecar.room.<id>.conversation`, and
 * `rainver:` covers both the theme and every notebook chat session. A new
 * preference is listed by name, and anything nobody listed is cleared.
 */
const KEEP_LOCAL_PREFIXES: string[] = []

/** `sessionStorage` is per-tab and holds only open-pane state; none of it is kept. */
const KEEP_SESSION_EXACT: string[] = []
const KEEP_SESSION_PREFIXES: string[] = []

/** Tells the other tabs of this browser that the session is over. */
const LOGOUT_CHANNEL = 'rainver:auth'
const LOGOUT_MESSAGE = 'logged-out'
const ACCOUNT_CHANGED_MESSAGE = 'account-changed'
const SIGNED_OUT_MESSAGE = 'signed-out'

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

/**
 * Authenticated state held only in this tab's memory (never in browser
 * storage), such as unsent Reader comments. Each owner registers how to drop
 * it; logout, a 401 and another tab's logout all run these.
 */
const inMemoryResidue = new Set<() => void>()

export function registerInMemoryResidue(clear: () => void): () => void {
  inMemoryResidue.add(clear)
  return () => { inMemoryResidue.delete(clear) }
}

// Advanced by every clear (logout, 401, another tab's logout): work started in
// an earlier session compares its epoch and changes nothing afterwards.
let epoch = 0
export function sessionEpoch(): number { return epoch }

let unstoredLogout: string | null = null
let logoutRequest: Promise<void> | null = null

function pendingLogout(): string | null {
  try { return localStorage.getItem(PENDING_LOGOUT) ?? unstoredLogout } catch { return unstoredLogout }
}

export function hasPendingLogout(): boolean { return pendingLogout() !== null }

/**
 * Advanced each time this tab learns a sign-out reached the server (its own
 * or another tab's). A response to a request sent before then may still
 * write back a session that sign-out revoked; see `authApi.changePassword`.
 */
let signOuts = 0
export function signOutCount(): number { return signOuts }
export function noteSignedOut(): void { signOuts += 1 }

export function beginPendingLogout(): void {
  const intent = crypto.getRandomValues(new Uint32Array(4)).join('-')
  try { localStorage.setItem(PENDING_LOGOUT, intent) } catch { unstoredLogout = intent }
}

/** Retry the cookie-backed sign-out before any new session can be opened. */
export function finishPendingLogout(send: () => Promise<unknown>): Promise<void> {
  if (logoutRequest) return logoutRequest
  if (!hasPendingLogout()) return Promise.resolve()

  async function finish() {
    const intent = pendingLogout()
    if (intent === null) return
    await send()
    if (pendingLogout() !== intent) return
    try { localStorage.removeItem(PENDING_LOGOUT) } catch { /* private mode */ }
    if (unstoredLogout === intent) unstoredLogout = null
  }

  // Another tab can retry the same cookie-backed request. Serialize those retries
  // so a slow duplicate response cannot clear the cookie after the next sign-in.
  const request = navigator.locks ? navigator.locks.request(PENDING_LOGOUT, finish) : finish()
  logoutRequest = request.finally(() => { logoutRequest = null })
  return logoutRequest
}

/**
 * What only this tab holds: its `sessionStorage` (drafts, open panes), its
 * in-memory residue (which also closes its live streams), and its epoch.
 * Run by a tab told that the browser became another account. The shared
 * `localStorage` is left to the tab that switched, which clears it before it
 * tells anyone, so a reload here cannot race it and lose the new account's state.
 */
export function clearTabResidue(): void {
  epoch += 1
  try { clearExcept(window.sessionStorage, keptKeys(KEEP_SESSION_EXACT, KEEP_SESSION_PREFIXES)) } catch { /* private mode */ }
  for (const clear of inMemoryResidue) {
    try { clear() } catch { /* one owner's failure must not keep the rest */ }
  }
}

export function clearSessionResidue(): void {
  try { clearExcept(window.localStorage, keptKeys(KEEP_LOCAL_EXACT, KEEP_LOCAL_PREFIXES)) } catch { /* private mode */ }
  clearTabResidue()
}

/** Removes the API response cache, whatever state the app thinks it is in. */
export async function clearApiCache(): Promise<void> {
  if (typeof caches === 'undefined') return
  try { await caches.delete(API_CACHE_NAME) } catch { /* unsupported */ }
}

export async function clearAuthenticatedBrowserState(): Promise<void> {
  clearSessionResidue()
  await clearApiCache()
}

/**
 * Runs once at boot, before the app asks who is signed in.
 *
 * The service worker must not cache authenticated API bodies, and does not.
 * A cache from an older build, or from a tab closed mid-logout, can still be
 * there. Deleting it unconditionally costs one cache miss on something that
 * should not be there.
 */
export function dropApiCacheAtBoot(): void {
  void clearApiCache()
}

/**
 * The one channel this tab both listens on and announces through.
 *
 * One object on purpose: a `BroadcastChannel` never delivers to itself, but it
 * does deliver to every *other* channel object — including another one in the
 * same tab. Do not announce through a second object. The tab that signed out
 * would hear its own logout and run the remote handler on itself.
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
 * Another tab's sign-out clears this tab. Do not keep rendering the previous
 * person's page until the next API call. Returns a stop function.
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

/**
 * Runs `onRemote` once another tab's sign-out has reached the server: the
 * browser now holds no account. A sign-out announced (`announceLogout`) may
 * still be on its way, and a session that merely expired leaves the browser's
 * account selected, so only this says the browser has none.
 */
export function watchCrossTabSignedOut(onRemote: () => void): () => void {
  const channel = openLogoutChannel()
  if (!channel) return () => {}
  const handler = (event: MessageEvent) => {
    if (event.data !== SIGNED_OUT_MESSAGE) return
    noteSignedOut()
    onRemote()
  }
  channel.addEventListener('message', handler)
  return () => channel.removeEventListener('message', handler)
}

/** Tells this browser's other tabs that its sign-out reached the server. */
export function announceSignedOut(): void {
  openLogoutChannel()?.postMessage(SIGNED_OUT_MESSAGE)
}

/**
 * This tab made the browser act as another account (a switch, an addition,
 * or a sign-in or registration from a public page). The shared storage is
 * cleared before the other tabs are told, so a tab that reloads on the
 * message never reads the previous person's state nor loses the next one's.
 */
export async function becameAnotherAccountHere(): Promise<void> {
  clearSessionResidue()
  announceAccountChange()
  await clearApiCache()
}

/**
 * Runs `onRemote` when another tab of this browser switches or adds an
 * account. The browser now acts as someone else for every tab; this one must
 * not keep rendering, streaming or writing as the person it was loaded for.
 */
export function watchCrossTabAccountChange(onRemote: () => void): () => void {
  const channel = openLogoutChannel()
  if (!channel) return () => {}
  const handler = (event: MessageEvent) => {
    if (event.data === ACCOUNT_CHANGED_MESSAGE) onRemote()
  }
  channel.addEventListener('message', handler)
  return () => channel.removeEventListener('message', handler)
}

/**
 * Tells this browser's other tabs that it now acts as another account: after
 * a switch, an addition, or a sign-in or registration from a public page
 * while other tabs were signed in.
 */
export function announceAccountChange(): void {
  openLogoutChannel()?.postMessage(ACCOUNT_CHANGED_MESSAGE)
}

/**
 * The handle of the account an "add with Google" left from, kept for the one
 * load that returns from Google. Per tab and never a credential.
 */
const ACCOUNT_ADD_ORIGIN = 'rainver:account-add-origin'
export function rememberAccountAddOrigin(handle: string): void {
  try { sessionStorage.setItem(ACCOUNT_ADD_ORIGIN, handle) } catch { /* private mode */ }
}
export function takeAccountAddOrigin(): string | null {
  try {
    const handle = sessionStorage.getItem(ACCOUNT_ADD_ORIGIN)
    sessionStorage.removeItem(ACCOUNT_ADD_ORIGIN)
    return handle
  } catch { return null }
}

/**
 * Marks this tab as leaving for a sign-in on Google's page, so the load that
 * returns signed in tells the other tabs (`announceAccountChange`). Per tab.
 */
const SIGN_IN_PENDING = 'rainver:sign-in-pending'
export function rememberSignInPending(): void {
  try { sessionStorage.setItem(SIGN_IN_PENDING, '1') } catch { /* private mode */ }
}
export function takeSignInPending(): boolean {
  try {
    const pending = sessionStorage.getItem(SIGN_IN_PENDING) !== null
    sessionStorage.removeItem(SIGN_IN_PENDING)
    return pending
  } catch { return false }
}

/** Exported for tests: forget the channel so the next open makes a new one. */
export function __resetLogoutChannelForTests(): void {
  try { logoutChannel?.close() } catch { /* already closed */ }
  logoutChannel = null
}

export function scopedUserStorageKey(kind: string, userId: string, ...parts: string[]): string {
  return [`rainver:${kind}`, userId, ...parts].join(':')
}
