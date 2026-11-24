import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { authApi } from '../api/client'
import {
  announceLogout, API_KEY_STORAGE, beginPendingLogout, clearAuthenticatedBrowserState,
  finishPendingLogout, hasPendingLogout, sessionEpoch, watchCrossTabLogout,
} from '../lib/sessionResidue'
import type { CurrentUser } from '../types/api'

interface AuthContextValue {
  currentUser: CurrentUser | null
  isLoading: boolean
  logout: () => Promise<void>
  reloadUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [isLoading, setIsLoading]     = useState(true)
  const userRequest = useRef(0)
  const signingOut = useRef(false)
  const retryUserOnReconnect = useRef(false)

  useEffect(() => {
    try { localStorage.removeItem(API_KEY_STORAGE) } catch { /* private mode */ }
  }, [])

  const reloadUser = useCallback(async () => {
    if (signingOut.current) return
    const request = ++userRequest.current
    const epoch = sessionEpoch()
    const isCurrent = () => request === userRequest.current && epoch === sessionEpoch()
    try {
      if (hasPendingLogout()) {
        setCurrentUser(null)
        await finishPendingLogout(authApi.logout)
        return
      }
      const user = await authApi.me()
      if (isCurrent() && !hasPendingLogout()) {
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
    const onOnline = () => {
      if (retryUserOnReconnect.current || hasPendingLogout()) void reloadUser()
    }
    window.addEventListener('online', onOnline)
    void reloadUser()
    return () => {
      userRequest.current += 1
      window.removeEventListener('auth:required', onAuthRequired)
      window.removeEventListener('online', onOnline)
      stopWatching()
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

  return (
    <AuthContext.Provider value={{
      currentUser, isLoading, logout, reloadUser,
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
