import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { setAuth } from '../api/client'
import { authApi } from '../api/client'
import { announceLogout, API_KEY_STORAGE, clearAuthenticatedBrowserState, watchCrossTabLogout } from '../lib/sessionResidue'
import type { CurrentUser } from '../types/api'

interface AuthContextValue {
  currentUser: CurrentUser | null
  isLoading: boolean
  logout: () => Promise<void>
  reloadUser: () => Promise<void>

  apiKey: string
  saveApiKey: (key: string) => void
  clearApiKey: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [isLoading, setIsLoading]     = useState(true)
  // API keys are feature-gated and must not survive in localStorage across
  // accounts. Keep the setter for the unused in-memory path only.
  const [apiKey, setApiKeyState]      = useState('')

  useEffect(() => { setAuth(apiKey || null) }, [apiKey])
  useEffect(() => {
    try { localStorage.removeItem(API_KEY_STORAGE) } catch { /* private mode */ }
  }, [])

  const reloadUser = useCallback(async () => {
    try {
      const user = await authApi.me()
      setCurrentUser(user)
    } catch {
      setCurrentUser(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { reloadUser() }, [reloadUser])

  useEffect(() => {
    function handleAuthRequired(fromAnotherTab = false) {
      setCurrentUser(null)
      setApiKeyState('')
      setAuth(null)
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
    return () => {
      window.removeEventListener('auth:required', onAuthRequired)
      stopWatching()
    }
  }, [])

  async function logout() {
    try { await authApi.logout() } catch { /* ignore */ }
    setCurrentUser(null)
    setApiKeyState('')
    setAuth(null)
    // Told first: clearing awaits `caches.delete`, and a tab closed during
    // that await would have told nobody.
    announceLogout()
    await clearAuthenticatedBrowserState()
  }

  function saveApiKey(key: string) {
    setApiKeyState(key.trim())
  }

  return (
    <AuthContext.Provider value={{
      currentUser, isLoading, logout, reloadUser,
      apiKey, saveApiKey, clearApiKey: () => saveApiKey(''),
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
