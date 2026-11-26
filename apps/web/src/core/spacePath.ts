/**
 * Top-level paths that are NOT inside a Space, so they never get a `/spaces/:id` prefix.
 * Home is user-scoped (cross-space); Settings/Time/Cards are neutral system surfaces.
 */
const USER_SCOPED_PREFIXES = ['/home', '/agent-work', '/my-agents', '/settings', '/instance-settings', '/time', '/cards', '/evolution', '/login']

function isUserScopedPath(path: string): boolean {
  // A query or fragment (`/evolution?asset=…`) does not move a path into a Space.
  const pathname = path.split(/[?#]/, 1)[0]
  return USER_SCOPED_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * Compose the actual href for a logical in-space path, e.g. `spacePath('team-1', '/proposals')`
 * → `/spaces/team-1/proposals`. Query strings are preserved. Top-level paths (Home, Settings),
 * already-scoped paths, relative paths, and external URLs are returned unchanged. When no Space
 * id is available the logical path is returned as-is (callers fall back gracefully).
 */
export function spacePath(spaceId: string | null | undefined, to: string): string {
  if (typeof to !== 'string' || !to.startsWith('/')) return to
  if (to.startsWith('/spaces/')) return to
  if (isUserScopedPath(to)) return to
  if (!spaceId) return to
  return `/spaces/${spaceId}${to}`
}

/**
 * The href for a logical path, or `null` when it is an in-space path and no Space is known
 * (a cold start before `/me/spaces` answers, or a person with no active Space). An unscoped
 * in-space path matches no route and lands on Home, so navigation renders it inert instead.
 */
export function spaceHref(spaceId: string | null | undefined, to: string): string | null {
  if (!spaceId && typeof to === 'string' && to.startsWith('/') && !to.startsWith('/spaces/') && !isUserScopedPath(to)) return null
  return spacePath(spaceId, to)
}
