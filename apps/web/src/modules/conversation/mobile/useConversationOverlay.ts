import { useEffect, useRef } from 'react'
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'

/**
 * Only pop entries this mounted owner pushed. Deep links are closed in place.
 * `close(action, { with })` also closes the named overlays that are open over
 * this one, in one step: two separate closes would each write the URL from the
 * same stale search. When this owner pushed its entry and the overlay over it
 * was pushed directly on that entry, both entries are popped, so Back after the
 * close leaves the page rather than landing on a stale overlay entry that closes
 * itself again. Otherwise the overlay above is popped when it was pushed and
 * the rest is closed in place. A pop that lands on another entry than the one
 * expected (an overlay marker copied onto a later entry) closes what is still
 * open there in place, so a close never stays pending.
 */
export function useConversationOverlay(parameter: string) {
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const [search, setSearch] = useSearchParams()
  const owner = useRef<{ token: string; parent: string; entry?: string } | null>(null)
  const pending = useRef<{ parent: string; action?: () => void; names: string[] } | null>(null)
  const stateKey = `conversation-overlay:${parameter}`
  const markerOf = (name: string) => location.state?.[`conversation-overlay:${name}`] as { owner: string; parent: string } | undefined
  const marker = markerOf(parameter)
  const open = search.get(parameter) === '1'
  if (open && marker?.owner === owner.current?.token && owner.current && !owner.current.entry && location.key !== owner.current.parent) {
    owner.current.entry = location.key
  }
  // Close the named overlays without a history entry of their own.
  const removeInPlace = (names: string[], action?: () => void) => {
    const state = { ...location.state }
    for (const name of names) delete state[`conversation-overlay:${name}`]
    setSearch(current => {
      const next = new URLSearchParams(current)
      for (const name of names) next.delete(name)
      return next
    }, { replace: true, state })
    action?.()
  }
  useEffect(() => {
    const waiting = pending.current
    // Only this close's own pop settles it; another hook's in-place replace does not.
    if (!waiting || (location.key !== waiting.parent && navigationType !== 'POP')) return
    pending.current = null
    // Popped back to an entry that still carries overlays to close: the
    // expected one below an overlay that was not ours, or an unexpected one.
    const remaining = waiting.names.filter(name => search.get(name) === '1')
    if (remaining.length) removeInPlace(remaining, waiting.action)
    else waiting.action?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])
  const close = (action?: () => void, options: { with?: string[] } = {}) => {
    if (pending.current) return
    const together = (options.with ?? []).filter(name => name !== parameter && search.get(name) === '1')
    const pushed = marker && marker.owner === owner.current?.token ? owner.current?.entry : undefined
    if (!together.length) {
      if (pushed && location.key === pushed) {
        pending.current = { parent: marker!.parent, action, names: [parameter] }
        navigate(-1)
      } else removeInPlace([parameter], action)
      return
    }
    // One overlay over this one, pushed on the entry below it (its marker names that parent).
    const above = together.length === 1 ? markerOf(together[0]!) : undefined
    if (above && pushed && above.parent === pushed) {
      pending.current = { parent: marker!.parent, action, names: [parameter, ...together] }
      navigate(-2)
    } else if (above) {
      pending.current = { parent: above.parent, action, names: [parameter, ...together] }
      navigate(-1)
    } else removeInPlace([parameter, ...together], action)
  }
  return { open, close, show: () => {
    if (open) return
    owner.current = { token: `${location.key}:${parameter}`, parent: location.key }
    setSearch(current => {
      const next = new URLSearchParams(current)
      next.set(parameter, '1')
      return next
    }, { state: { ...location.state, [stateKey]: { owner: owner.current?.token, parent: location.key } } })
  } }
}
