import {
  Home, Inbox, CheckCircle, BookOpen, ListTodo, Bot, Folder, FolderKanban, Settings,
  GitBranch, Building2, ServerCog, Server,
  Library, Rss, Share2,
  type LucideIcon,
} from 'lucide-react'

/**
 * Navigation model — two stable tiers:
 *
 *  1. Global Rail   — major app-level destinations, always present (icon-only by default).
 *                     Home is first and stable. Space-scoped rail destinations operate on
 *                     the active Space; Home is user-scoped and lives outside any Space.
 *  2. Scene Sidebar — second-level navigation for the current module/scene. Changes by scene.
 *                     Collapsible; Home requires no scene sidebar.
 *
 * The Right Inspector is intentionally NOT modelled here — it is scene/object-specific and
 * owned by individual pages, never an app-level feature menu.
 */

export interface RailItem {
  id: string
  label: string
  /**
   * Logical destination. For `scope: 'space'` items this is the in-space path (e.g. `/proposals`)
   * and the actual href is composed with the active/preferred Space via `spacePath`. For
   * `scope: 'user'` items (Home, Settings) it is the literal top-level path.
   */
  to: string
  icon: LucideIcon
  /** Whether this destination lives inside a Space (`/spaces/:id/…`) or at the user/top level. */
  scope: RouteScope
  /** Render in the rail footer (e.g. Settings) instead of the main list. */
  footer?: boolean
  /** Surface in the mobile bottom tab bar. */
  mobile?: boolean
  /** Hide this item unless the current user can administer the active Space. */
  requiresSpaceAdmin?: boolean
  /** Hide this item unless the current user is the instance admin. */
  requiresInstanceAdmin?: boolean
  /** Additional logical paths that should make this item active. */
  activePaths?: string[]
}

/** Major destinations. Home is always first and stable. */
export const RAIL_ITEMS: RailItem[] = [
  { id: 'home',       label: 'Home',       to: '/home',        icon: Home,        scope: 'home',  mobile: true },
  // ADR 0016 D11: Command Center is the default landing page for a Space
  // (see App.tsx's `spaces/:spaceId` index redirect) — placed first among
  // the space-scoped rail items so it reads as the space's home surface.
  { id: 'command-center', label: 'Command Center', to: '/command-center', icon: Server, scope: 'space', mobile: true },
  { id: 'inbox',      label: 'Inbox',      to: '/activity',    icon: Inbox,       scope: 'space', mobile: true },
  { id: 'library',    label: 'Library',    to: '/library',     icon: Library,     scope: 'space', mobile: true },
  { id: 'source',     label: 'Sources',    to: '/sources',      icon: Rss,         scope: 'space' },
  { id: 'review',     label: 'Review',     to: '/proposals',   icon: CheckCircle, scope: 'space', mobile: true },
  { id: 'knowledge',  label: 'Knowledge',  to: '/knowledge',   icon: BookOpen,    scope: 'space' },
  { id: 'publications', label: 'Shared', to: '/publications', icon: Share2, scope: 'space' },
  { id: 'tasks',      label: 'Tasks',      to: '/tasks',       icon: ListTodo,    scope: 'space', mobile: true },
  { id: 'projects',   label: 'Projects',   to: '/projects',    icon: FolderKanban, scope: 'space' },
  { id: 'agents',     label: 'Agents',     to: '/agents',      icon: Bot,         scope: 'space' },
  { id: 'evolution',  label: 'Evolution',  to: '/evolution',   icon: GitBranch,   scope: 'home' },
  { id: 'instance-settings', label: 'Instance Settings', to: '/instance-settings', icon: ServerCog, scope: 'home', footer: true, requiresInstanceAdmin: true, activePaths: ['/runtime-tools'] },
  { id: 'space-settings', label: 'Space Settings', to: '/space-settings', icon: Building2, scope: 'space', footer: true, requiresSpaceAdmin: true, activePaths: ['/network-profiles', '/plugins', '/retrieval-settings', '/prompts'] },
  { id: 'settings',   label: 'Settings',   to: '/settings',    icon: Settings,    scope: 'home',  footer: true },
]

export const MOBILE_TAB_ITEMS = RAIL_ITEMS.filter(i => i.mobile)

/**
 * A scene's second-level navigation.
 *
 * - "filter" scenes drive a single query param the page already honours (no faked views).
 * - "route" scenes link to real sibling routes that belong to the same product area.
 */
export interface FilterSceneItem { label: string; value: string }
export interface RouteSceneItem {
  label: string
  to: string
  children?: RouteSceneItem[]
}

interface SceneBase {
  id: string
  title: string
  icon: LucideIcon
  /** First path segments (after the leading slash) that belong to this scene. */
  segments: string[]
}

export interface FilterScene extends SceneBase {
  kind: 'filter'
  base: string
  filterKey: string
  /** Value treated as active when the filter param is absent (matches the page's own default). */
  defaultValue: string
  items: FilterSceneItem[]
}

export interface RouteScene extends SceneBase {
  kind: 'route'
  items: RouteSceneItem[]
}

export type Scene = FilterScene | RouteScene

/**
 * Scene definitions. Every sidebar item maps to a real route or a real, API-backed filter
 * the target page reads from the URL — nothing fabricated.
 */
export const SCENES: Scene[] = [
  {
    kind: 'filter',
    id: 'inbox',
    title: 'Inbox',
    icon: Inbox,
    segments: ['activity'],
    base: '/activity',
    filterKey: 'status',
    defaultValue: 'raw',
    items: [
      { label: 'All',                value: 'all' },
      { label: 'Raw',                value: 'raw' },
      { label: 'Proposals generated', value: 'proposals_generated' },
      { label: 'Processed',          value: 'processed' },
      { label: 'Archived',           value: 'archived' },
    ],
  },
  {
    kind: 'route',
    id: 'library',
    title: 'Library',
    icon: Library,
    segments: ['library'],
    items: [
      {
        label: 'All Items',
        to: '/library/items',
        children: [
          { label: 'Articles', to: '/library/items/articles' },
          { label: 'Emails',   to: '/library/items/emails' },
          { label: 'Videos',   to: '/library/items/videos' },
          { label: 'Podcasts', to: '/library/items/podcasts' },
          { label: 'PDFs',     to: '/library/items/pdfs' },
        ],
      },
      { label: 'Digests', to: '/library/digests' },
    ],
  },
  // Knowledge intentionally has NO scene: cross-section navigation is the lightweight
  // breadcrumb switcher in each page header (KnowledgeSectionHeader), and each destination
  // owns its own layout (e.g. the Notes collection tree). A persistent section sidebar/tab
  // strip here would collide with that — see .agent/modules/knowledge-base.md.
  {
    kind: 'route',
    id: 'review',
    title: 'Review',
    icon: CheckCircle,
    segments: ['proposals', 'memory'],
    items: [
      { label: 'Proposals', to: '/proposals' },
      { label: 'Memory',    to: '/memory' },
    ],
  },
  {
    kind: 'route',
    id: 'agents',
    title: 'Agents',
    icon: Bot,
    segments: ['agents', 'rooms', 'sessions', 'runs', 'automations', 'capabilities'],
    items: [
      { label: 'My agents',  to: '/agents' },
      { label: 'Rooms',      to: '/rooms' },
      { label: 'Chat history', to: '/sessions' },
      { label: 'Templates',  to: '/agents/templates' },
      { label: 'Runs',       to: '/runs' },
      { label: 'Plans',      to: '/plans' },
      { label: 'Automations', to: '/automations' },
      { label: 'Capabilities', to: '/capabilities' },
    ],
  },
  {
    kind: 'route',
    id: 'artifacts',
    title: 'Artifacts',
    icon: Folder,
    segments: ['artifacts'],
    items: [
      { label: 'Artifacts',  to: '/artifacts' },
    ],
  },
]

export type RouteScope = 'home' | 'space'

/**
 * Top-level paths that are NOT inside a Space, so they never get a `/spaces/:id` prefix.
 * Home is user-scoped (cross-space); Settings/Time/Cards are neutral system surfaces.
 */
const USER_SCOPED_PREFIXES = ['/home', '/settings', '/instance-settings', '/runtime-tools', '/cli-profiles', '/time', '/cards', '/evolution', '/login']

function isUserScopedPath(path: string): boolean {
  return USER_SCOPED_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))
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
 * Inverse of {@link spacePath} for matching: strip a leading `/spaces/:id` so a real pathname
 * can be compared against logical nav targets. `/spaces/x/proposals` → `/proposals`,
 * `/spaces/x` → `/`, and non-space paths are returned unchanged.
 */
export function stripSpacePrefix(pathname: string): string {
  const m = pathname.match(/^\/spaces\/[^/]+(\/.*)?$/)
  if (m) return m[1] ?? '/'
  return pathname
}

function firstSegment(pathname: string): string {
  return pathname.replace(/^\/+/, '').split('/')[0] ?? ''
}

export function sceneForPath(pathname: string): Scene | null {
  const seg = firstSegment(stripSpacePrefix(pathname))
  if (!seg) return null
  return SCENES.find(s => s.segments.includes(seg)) ?? null
}

/**
 * A route is space-scoped iff its URL carries a Space (`/spaces/:id/…`). Everything else —
 * Home and the neutral system surfaces — is user-scoped. `activeSpaceId` must never filter Home.
 */
export function routeScopeForPath(pathname: string): RouteScope {
  return pathname.startsWith('/spaces/') ? 'space' : 'home'
}
