import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { authApi } from '../api/client'
import { ACCOUNT_SWITCHED_EVENT, currentAccountHandle, endAccountStreams, SIGNED_OUT_ACCOUNT_HANDLE, setAccountHandle } from '../api/transport'
import {
  announceLogout, API_KEY_STORAGE, becameAnotherAccountHere, beginPendingLogout, clearAuthenticatedBrowserState,
  clearTabResidue, finishPendingLogout, hasPendingLogout, rememberAccountAddOrigin, sessionEpoch,
  takeAccountAddOrigin, takeSignInPending, watchCrossTabAccountChange, watchCrossTabLogout, watchCrossTabSignedOut,
} from '../lib/sessionResidue'
import type { CurrentUser } from '../types/api'

interface AuthContextValue {
  currentUser: CurrentUser | null
  isLoading: boolean
  logout: () => Promise<void>
  reloadUser: () => Promise<void>
  /** Makes another of this browser's accounts active for every tab, then reloads. */
  switchAccount: (userId: string) => Promise<void>
  /** Signs in to an existing account beside the current one, then reloads as it. Throws, changing nothing, on refusal. */
  addPasswordAccount: (body: { email: string; password: string; rememberMe: boolean }) => Promise<void>
  /** Leaves for Google to add an account; returns here, as before, if it is cancelled or fails. */
  addGoogleAccount: () => Promise<void>
  /** This load came back from adding an account with Google, and the browser is still who it was. */
  accountAddReturned: boolean
  acknowledgeAccountAdd: () => void
}

/**
 * The browser now acts as another account. Every tab reloads rather than
 * keep rendering, streaming or writing as the person it was loaded for.
 *
 * The account handle is never cleared on the way out. Until the page is gone
 * every request it still makes — a `keepalive` write on `pagehide`, or
 * anything after the person cancelled the unload — names the old account and
 * is refused, never run as the new one. Each tab drops its own residue and
 * ends its streams first. The tab that switched also clears the shared
 * storage, before telling the others, so a tab that reloads on its message
 * never reads the previous person's state nor loses the next person's.
 */
let leaving = false
/** This tab's own switch or addition is in flight: a switch it hears meanwhile waits for that change to end. */
let changingAccount = false
/** Another tab's switch, or a refusal of this tab as stale, heard while this tab's own change was in flight. */
let switchedMeanwhile = false
async function becomeAnotherAccount(): Promise<void> {
  leaving = true
  endAccountStreams()
  await becameAnotherAccountHere()
  window.location.reload()
}
function reloadForAnotherAccount(): void {
  // Once: after a cancelled unload the page stays, refused, instead of asking again on every request.
  if (leaving) return
  if (changingAccount) {
    switchedMeanwhile = true
    return
  }
  leaving = true
  endAccountStreams()
  clearTabResidue()
  window.location.reload()
}
/** Exported for tests: a fresh page, as after the reload this module asks for. */
export function __resetAccountChangeForTests(): void {
  leaving = false
  changingAccount = false
  switchedMeanwhile = false
}
/**
 * Runs this tab's own switch or addition. Succeeding, the tab reloads as the
 * account it chose. Failing because another tab switched first (or this tab
 * was already stale and refused), it reloads as the browser's account now:
 * that failure says nothing about the change itself, so it is not reported,
 * and the page that is leaving waits for the reload.
 */
async function ownAccountChange(change: () => Promise<unknown>): Promise<void> {
  changingAccount = true
  switchedMeanwhile = false
  try {
    await change()
  } catch (error) {
    changingAccount = false
    if (!switchedMeanwhile) throw error
    reloadForAnotherAccount()
    return new Promise<void>(() => {})
  }
  await becomeAnotherAccount()
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [isLoading, setIsLoading]     = useState(true)
  const userRequest = useRef(0)
  const signingOut = useRef(false)
  /** The handle this tab had when it was signed out, until it adopts another one. */
  const signedOutAs = useRef<string | null | undefined>(undefined)
  const retryUserOnReconnect = useRef(false)
  const [accountAddReturned, setAccountAddReturned] = useState(false)
  const acknowledgeAccountAdd = useCallback(() => setAccountAddReturned(false), [])

  useEffect(() => {
    try { localStorage.removeItem(API_KEY_STORAGE) } catch { /* private mode */ }
  }, [])

  const reloadUser = useCallback(async () => {
    if (signingOut.current) return
    const request = ++userRequest.current
    let epoch = sessionEpoch()
    const isCurrent = () => request === userRequest.current && epoch === sessionEpoch()
    try {
      if (hasPendingLogout()) {
        setCurrentUser(null)
        await finishPendingLogout(authApi.logout)
        return
      }
      const user = await authApi.me()
      if (isCurrent() && !hasPendingLogout()) {
        // Back from adding an account with Google: when it succeeded the
        // browser is someone else now, and every other tab must hear it.
        const addedFrom = takeAccountAddOrigin()
        if (addedFrom !== null && user.account_handle && addedFrom !== user.account_handle) {
          await becomeAnotherAccount()
          return
        }
        if (addedFrom !== null) setAccountAddReturned(true)
        // Back from signing in with Google on a public page.
        if (takeSignInPending()) {
          await becameAnotherAccountHere()
          // The residue cleared was the previous person's; this load is the new one's.
          epoch = sessionEpoch()
          if (request !== userRequest.current) return
        }
        setAccountHandle(user.account_handle ?? null)
        setCurrentUser(user)
        retryUserOnReconnect.current = false
      }
    } catch {
      // The client dispatches auth:required for an expired session. An
      // unavailable server cannot tell us whether a loaded session expired.
      if (isCurrent()) retryUserOnReconnect.current = true
    } finally {
      if (isCurrent()) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    function handleAuthRequired(fromAnotherTab = false) {
      // Kept: a session that ended server-side leaves the browser's account
      // selected. Only a sign-out that reached the server changes it.
      signedOutAs.current = currentAccountHandle()
      userRequest.current += 1
      retryUserOnReconnect.current = false
      setCurrentUser(null)
      setIsLoading(false)
      void clearAuthenticatedBrowserState()
      // A session revoked server-side reaches only whichever tab happens to
      // make the next API call; the rest keep a rendered page full of the
      // previous person's content until something makes them ask. Announced
      // before the clearing finishes, and never re-announced for an
      // announcement we just received.
      if (!fromAnotherTab) announceLogout()
    }

    const onAuthRequired = () => handleAuthRequired()
    window.addEventListener('auth:required', onAuthRequired)
    // Another tab of this browser signing out is this tab's session ending
    // too. Without it, the other tabs kept a rendered page full of the
    // previous person's content until something made them call the API.
    const stopWatching = watchCrossTabLogout(() => handleAuthRequired(true))
    // That sign-out reached the server: this tab, still unchanged since it
    // was signed out, now names the browser's lack of an account.
    const stopWatchingSignedOut = watchCrossTabSignedOut(() => {
      if (signedOutAs.current !== undefined && currentAccountHandle() === signedOutAs.current) setAccountHandle(SIGNED_OUT_ACCOUNT_HANDLE)
    })
    // Another tab switched account, or this tab's request was refused as stale.
    const stopWatchingAccount = watchCrossTabAccountChange(reloadForAnotherAccount)
    window.addEventListener(ACCOUNT_SWITCHED_EVENT, reloadForAnotherAccount)
    const onOnline = () => {
      if (retryUserOnReconnect.current || hasPendingLogout()) void reloadUser()
    }
    window.addEventListener('online', onOnline)
    void reloadUser()
    return () => {
      userRequest.current += 1
      window.removeEventListener('auth:required', onAuthRequired)
      window.removeEventListener('online', onOnline)
      window.removeEventListener(ACCOUNT_SWITCHED_EVENT, reloadForAnotherAccount)
      stopWatching()
      stopWatchingSignedOut()
      stopWatchingAccount()
    }
  }, [reloadUser])

  async function logout() {
    if (signingOut.current) return
    signingOut.current = true
    userRequest.current += 1
    retryUserOnReconnect.current = false
    beginPendingLogout()
    setCurrentUser(null)
    setIsLoading(false)
    // Told first: clearing awaits `caches.delete`, and a tab closed during
    // that await would have told nobody.
    announceLogout()
    const clearing = clearAuthenticatedBrowserState()
    try {
      await finishPendingLogout(authApi.logout)
    } catch {
      // A fresh tab or a reconnect will retry before reading the old cookie.
      retryUserOnReconnect.current = true
    } finally {
      await clearing
      signingOut.current = false
    }
  }

  async function switchAccount(userId: string) {
    userRequest.current += 1
    await ownAccountChange(() => authApi.switchAccount(userId))
  }

  async function addPasswordAccount(body: { email: string; password: string; rememberMe: boolean }) {
    await ownAccountChange(async () => {
      await authApi.addPasswordAccount(body)
      userRequest.current += 1
    })
  }

  async function addGoogleAccount() {
    // The handle this tab acts as now, which a password change may have rotated since `/me`.
    const handle = currentAccountHandle() ?? currentUser?.account_handle
    if (handle) rememberAccountAddOrigin(handle)
    await authApi.addGoogleAccount(`${window.location.pathname}${window.location.search}${window.location.hash}`)
  }

  return (
    <AuthContext.Provider value={{
      currentUser, isLoading, logout, reloadUser, switchAccount, addPasswordAccount, addGoogleAccount,
      accountAddReturned, acknowledgeAccountAdd,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
