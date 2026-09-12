import { forwardRef, useCallback } from 'react'
import { Link, useNavigate, type LinkProps, type NavigateOptions, type To } from 'react-router-dom'
import { useSpace } from '../contexts/SpaceContext'
import { safeAppPath } from '../lib/safeHttpUrl'
import { spacePath } from './navigation'

/**
 * Space-aware navigation. In the URL-scoped routing model every in-space destination lives at
 * `/spaces/:spaceId/…`. These wrappers let pages keep writing logical paths (`/proposals`,
 * `/tasks/${id}`) while the current Space is injected automatically. Top-level paths (`/home`,
 * `/settings`) and already-scoped paths pass through (see `spacePath`). Off-site or
 * protocol-relative strings are dropped — use `SafeExternalLink` for http(s) URLs.
 *
 * Use the active Space (from the URL) when on a space route; fall back to the preferred Space so
 * a stray space-link from a user-scoped surface still resolves to a real Space.
 */
function useNavSpaceId(): string | null {
  const { activeSpaceId, preferredSpaceId } = useSpace()
  return activeSpaceId ?? preferredSpaceId
}

export function useSpaceNavigate() {
  const navigate = useNavigate()
  const spaceId = useNavSpaceId()
  return useCallback(
    ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === 'number') return navigate(to)
      if (typeof to === 'string') {
        const safe = safeAppPath(to)
        if (!safe) return
        return navigate(spacePath(spaceId, safe), options)
      }
      return navigate(to, options)
    }) as ReturnType<typeof useNavigate>,
    [navigate, spaceId],
  )
}

/** Drop-in replacement for react-router `Link` that resolves logical paths to the current Space. */
export const SpaceLink = forwardRef<HTMLAnchorElement, LinkProps>(function SpaceLink({ to, ...rest }, ref) {
  const spaceId = useNavSpaceId()
  if (typeof to === 'string') {
    const safe = safeAppPath(to)
    if (!safe) {
      return <span className={typeof rest.className === 'string' ? rest.className : undefined}>{rest.children}</span>
    }
    return <Link ref={ref} to={spacePath(spaceId, safe)} {...rest} />
  }
  return <Link ref={ref} to={to} {...rest} />
})
