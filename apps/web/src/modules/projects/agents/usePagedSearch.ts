import { useCallback, useEffect, useRef, useState } from 'react'

export const PAGE_SIZE = 50

/**
 * One generation of an offset-paged list: the scope (Project, Room, …) and the
 * search text its rows were loaded for. A page — first or "load more" — is
 * applied only when the list still belongs to the generation that asked for it.
 */
export function usePageGeneration(scopeKey: string) {
  const generation = useRef(0)
  const loaded = useRef<{ scope: string; query: string } | null>(null)
  return {
    /** Starts a new first-page load, invalidating every request still in flight. */
    begin: () => ++generation.current,
    /** Invalidates every request in flight and forgets what was loaded (a scope change or a closed dialog). */
    reset: () => { generation.current += 1; loaded.current = null },
    current: () => generation.current,
    isCurrent: (token: number) => token === generation.current,
    /** Records what the rows now on screen were loaded for. */
    loadedFor: (query: string) => { loaded.current = { scope: scopeKey, query } },
    /** The search text the rows on screen belong to, if they belong to this scope. */
    loadedQuery: () => loaded.current?.scope === scopeKey ? loaded.current.query : null,
  }
}

/**
 * A server-searched, offset-paged candidate list for a dialog.
 *
 * The search runs on the server over the whole eligible set, not over the page
 * already loaded. A late response for an earlier query, an earlier opening or
 * another scope is dropped, so typing quickly never shows results for text no
 * longer in the box, and a "load more" never appends rows of another search or
 * scope. Loading, failure and "nothing matched" are distinct states.
 */
export function usePagedSearch<T>(
  active: boolean,
  fetchPage: (query: string, offset: number) => Promise<{ items: T[]; total: number }>,
  scopeKey = '',
) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const pages = usePageGeneration(scopeKey)
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  const itemsRef = useRef(items)
  itemsRef.current = items
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const inFlight = useRef<number | null>(null)

  const load = useCallback(async (text: string, offset: number) => {
    const generation = pagesRef.current
    // A first page starts a generation; a later page continues the current one.
    const token = offset === 0 ? generation.begin() : generation.current()
    inFlight.current = token
    setLoading(true)
    setFailed(false)
    try {
      const page = await fetchRef.current(text.trim(), offset)
      if (!pagesRef.current.isCurrent(token)) return
      if (offset === 0) pagesRef.current.loadedFor(text)
      setItems(previous => offset === 0 ? page.items : [...previous, ...page.items])
      setTotal(page.total)
    } catch {
      if (!pagesRef.current.isCurrent(token)) return
      setFailed(true)
      if (offset === 0) setItems([])
    } finally {
      if (pagesRef.current.isCurrent(token)) {
        setLoading(false)
        inFlight.current = null
      }
    }
  }, [])

  useEffect(() => {
    // A closed dialog or another scope: nothing on screen or in flight belongs to the next one.
    pagesRef.current.reset()
    setItems([])
    setTotal(0)
    setFailed(false)
    setLoading(false)
    if (!active) {
      setQuery('')
    }
  }, [active, scopeKey])

  useEffect(() => {
    if (!active) return
    // The text or scope changed: whatever is still in flight answers a search no
    // longer asked, so it is invalidated now — not when the debounced request
    // leaves — and a "load more" waits for the new first page.
    inFlight.current = pagesRef.current.begin()
    setLoading(true)
    const timer = setTimeout(() => { void load(query, 0) }, query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [active, query, scopeKey, load])

  return {
    query,
    setQuery,
    items,
    total,
    loading,
    failed,
    hasMore: items.length < total,
    // Only continues the rows on screen, for the search they were loaded for; a pending new search wins.
    loadMore: () => {
      const loadedQuery = pagesRef.current.loadedQuery()
      // One page at a time: a second click while a page is loading would request the same offset again.
      if (loadedQuery === null || loadedQuery !== query || inFlight.current === pagesRef.current.current()) return Promise.resolve()
      return load(loadedQuery, itemsRef.current.length)
    },
    reload: () => load(query, 0),
  }
}
