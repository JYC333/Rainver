import { useEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

/** Only pop entries this mounted owner pushed. Deep links are closed in place. */
export function useConversationOverlay(parameter: string) {
  const location = useLocation()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const owner = useRef<{ token: string; parent: string; entry?: string } | null>(null)
  const pending = useRef<{ parent: string; action?: () => void } | null>(null)
  const stateKey = `conversation-overlay:${parameter}`
  const marker = location.state?.[stateKey] as { owner: string; parent: string } | undefined
  const open = search.get(parameter) === '1'
  if (open && marker?.owner === owner.current?.token && owner.current && !owner.current.entry && location.key !== owner.current.parent) {
    owner.current.entry = location.key
  }
  useEffect(() => {
    const waiting = pending.current
    if (!waiting || location.key !== waiting.parent) return
    pending.current = null
    waiting.action?.()
  }, [location.key])
  const close = (action?: () => void) => {
    if (pending.current) return
    if (marker && marker.owner === owner.current?.token && location.key === owner.current.entry) {
      pending.current = { parent: marker.parent, action }
      navigate(-1)
    } else {
      const state = { ...location.state }
      delete state[stateKey]
      setSearch(current => {
        const next = new URLSearchParams(current)
        next.delete(parameter)
        return next
      }, { replace: true, state })
      action?.()
    }
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
