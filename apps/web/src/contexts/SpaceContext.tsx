import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { setSpaceContext } from '../api/client'
import { authApi } from '../api/client'
import { useAuth } from './AuthContext'
import { spacePath } from '../core/navigation'
import type { SpaceWithMembership } from '../types/api'

/**
 * Space context — the user's set of real Spaces plus which one is currently active.
 *
 * The active Space is derived from the URL: space-scoped routes live at `/spaces/:spaceId/…`,
 * so `activeSpaceId` is read from the route params, not from local state. This makes Space a
 * first-class, deep-linkable, per-tab dimension. There is no imperative "set active space" —
 * to switch Space you navigate to its URL (see SpaceSwitcher / useSpaceNavigate).
 *
 * Home is a user-level surface that lives outside any Space; on it `activeSpaceId` is null and
 * must never filter the cross-space aggregates. `preferredSpaceId` is the Space to target when
 * building a space link from a user-scoped surface (active → last visited → default → personal).
 */
interface SpaceContextValue {
  spaces: SpaceWithMembership[]
  userId: string
  personalSpaceId: string | null

  /** The active Space for the current route, read from the URL. Null on user-scoped routes. */
  activeSpaceId: string | null
  activeSpaceName: string | null

  /** Best Space to target when navigating into a Space from a user-scoped surface. */
  preferredSpaceId: string | null

  reloadSpaces: () => Promise<void>
}

const SpaceContext = createContext<SpaceContextValue | null>(null)

export function SpaceProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth()
  const navigate = useNavigate()

  // Active Space comes straight from the URL — `/spaces/:spaceId/...`.
  const spaceMatch = useMatch('/spaces/:spaceId/*')
  const activeSpaceId = spaceMatch?.params.spaceId ?? null

  const [lastSpaceId, setLastSpaceId] = useState<string | null>(null)
  const [spaces, setSpaces] = useState<SpaceWithMembership[]>([])
  const [ready, setReady] = useState(false)
  const userId = currentUser?.id ?? ''

  const personalSpaceId = useMemo(
    () => spaces.find(s => s.type === 'personal')?.id ?? null,
    [spaces],
  )
  const activeSpaceName = useMemo(
    () => spaces.find(s => s.id === activeSpaceId)?.name ?? null,
    [spaces, activeSpaceId],
  )

  const has = useCallback(
    (id: string | null | undefined) => Boolean(id && spaces.some(s => s.id === id)),
    [spaces],
  )

  // The Space to target when entering a Space from a user-scoped surface.
  const preferredSpaceId = useMemo(() => {
    if (activeSpaceId) return activeSpaceId
    if (has(lastSpaceId)) return lastSpaceId
    if (has(currentUser?.default_space_id)) return currentUser?.default_space_id ?? null
    return personalSpaceId ?? spaces[0]?.id ?? lastSpaceId ?? null
  }, [activeSpaceId, lastSpaceId, currentUser?.default_space_id, personalSpaceId, spaces, has])

  // Keep the API client's space header in sync BEFORE child effects run. Setting it during
  // render (parents render before children) guarantees space-scoped pages issue requests against
  // the correct Space on the first render after navigation, not a stale one.
  const apiSpace = activeSpaceId ?? preferredSpaceId
  const lastApiSync = useRef<string>('')
  if (apiSpace && apiSpace !== lastApiSync.current) {
    setSpaceContext(apiSpace)
    lastApiSync.current = apiSpace
  }

  useEffect(() => {
    setReady(true)
  }, [currentUser?.id])

  const reloadSpaces = useCallback(async () => {
    if (!currentUser) { setSpaces([]); return }
    try {
      const list = await authApi.mySpaces()
      setSpaces(list)
    } catch {
      setSpaces([])
    }
  }, [currentUser?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reloadSpaces() }, [reloadSpaces])

  // Remember the last real Space visited (used to resolve preferredSpaceId off space routes).
  useEffect(() => {
    if (activeSpaceId && activeSpaceId !== lastSpaceId) setLastSpaceId(activeSpaceId)
  }, [activeSpaceId, lastSpaceId])

  // If the URL names a Space the user can't see (or that doesn't exist), fall back cleanly.
  useEffect(() => {
    if (!ready || !currentUser || spaces.length === 0) return
    if (activeSpaceId && !has(activeSpaceId) && preferredSpaceId) {
      navigate(spacePath(preferredSpaceId, '/today'), { replace: true })
    }
  }, [ready, currentUser, spaces, activeSpaceId, preferredSpaceId, has, navigate])

  if (!ready) return null

  const value: SpaceContextValue = {
    spaces,
    userId,
    personalSpaceId,
    activeSpaceId,
    activeSpaceName,
    preferredSpaceId,
    reloadSpaces,
  }

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>
}

export function useSpace(): SpaceContextValue {
  const ctx = useContext(SpaceContext)
  if (!ctx) throw new Error('useSpace must be used inside SpaceProvider')
  return ctx
}
