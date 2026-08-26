import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { setAuth } from '../api/client'
import { authApi } from '../api/client'
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
const API_KEY_STORAGE = 'rainver:api-key'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [isLoading, setIsLoading]     = useState(true)
  const [apiKey, setApiKeyState]      = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? '')

  useEffect(() => { setAuth(apiKey || null) }, [apiKey])

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
    function handleAuthRequired() {
      setCurrentUser(null)
      setIsLoading(false)
    }

    window.addEventListener('auth:required', handleAuthRequired)
    return () => window.removeEventListener('auth:required', handleAuthRequired)
  }, [])

  async function logout() {
    try { await authApi.logout() } catch { /* ignore */ }
    setCurrentUser(null)
  }

  function saveApiKey(key: string) {
    const trimmed = key.trim()
    setApiKeyState(trimmed)
    if (trimmed) localStorage.setItem(API_KEY_STORAGE, trimmed)
    else localStorage.removeItem(API_KEY_STORAGE)
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
