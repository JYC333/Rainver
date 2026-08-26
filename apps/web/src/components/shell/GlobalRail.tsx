import { Link, useLocation } from 'react-router-dom'
import { PanelLeftOpen, PanelLeftClose, Puzzle, BookOpen, Landmark, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { RAIL_ITEMS, sceneForPath, spacePath, stripSpacePrefix, type RailItem } from '../../core/navigation'
import { ReviewAttentionIndicator } from './ReviewAttentionIndicator'

/** Map lucide icon names (kebab-case) used by official plugins to icon components. */
const PLUGIN_ICON_MAP: Record<string, LucideIcon> = {
  book: BookOpen,
  landmark: Landmark,
}
function pluginIcon(name: string): LucideIcon {
  return PLUGIN_ICON_MAP[name] ?? Puzzle
}

export interface PluginNavItem {
  id: string
  label: string
  /** Logical path, e.g. '/diary' or '/finance'. Space-scoped items are composed with the active Space. */
  path: string
  icon: string
  /** Whether the destination lives inside a Space (`/spaces/:id/…`) or at the top level. */
  scope: 'personal' | 'space'
}

function ApertureMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" style={{ flexShrink: 0 }}>
      <rect width="512" height="512" rx="96" fill="var(--card)" />
      <rect x="80" y="80" width="352" height="352" rx="48" fill="var(--background)" stroke="var(--border)" strokeWidth="8" />
      <path d="M 176 360 L 232 184 Q 256 132 280 184 L 336 360" fill="none" stroke="var(--primary)" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="212" y1="288" x2="300" y2="288" stroke="var(--primary)" strokeWidth="44" strokeLinecap="round" />
      <circle cx="256" cy="288" r="18" fill="var(--accent-foreground)" />
    </svg>
  )
}

function railItemActive(item: RailItem, pathname: string): boolean {
  const logical = stripSpacePrefix(pathname)
  if (item.id === 'home') return logical === '/' || logical === '/home' || logical.startsWith('/home/')
  const scene = sceneForPath(pathname)
  if (scene && scene.id === item.id) return true
  if (item.activePaths?.some(path => logical === path || logical.startsWith(`${path}/`))) return true
  return logical === item.to || logical.startsWith(`${item.to}/`)
}

/**
 * Narrow, stable Global Rail for desktop. Icon-only by default; Home is always first.
 * Carries only major app-level destinations — never scene-specific navigation. Space-scoped
 * items target the active/preferred Space; Home and Settings are user-level.
 */
export function GlobalRail({
  expanded,
  onToggle,
  spaceId,
  canManageSpace = false,
  canManageInstance = false,
  pendingReviewCount = 0,
  pluginModules = [],
}: {
  expanded: boolean
  onToggle: () => void
  spaceId: string | null
  canManageSpace?: boolean
  canManageInstance?: boolean
  pendingReviewCount?: number
  /** Enabled official plugin modules — shown dynamically below core nav. */
  pluginModules?: PluginNavItem[]
}) {
  const { pathname } = useLocation()
  const visibleItems = RAIL_ITEMS.filter(i =>
    (!i.requiresSpaceAdmin || canManageSpace) &&
    (!i.requiresInstanceAdmin || canManageInstance),
  )
  const main = visibleItems.filter(i => !i.footer)
  const footer = visibleItems.filter(i => i.footer)

  function renderItem(item: RailItem) {
    const Icon = item.icon
    const active = railItemActive(item, pathname)
    return (
      <Link
        key={item.id}
        to={item.scope === 'space' ? spacePath(spaceId, item.to) : item.to}
        title={item.label}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex items-center rounded-md transition-colors h-9',
          expanded ? 'gap-3 px-2.5 mx-1.5' : 'justify-center mx-auto w-9',
          active
            ? 'bg-primary/10 text-accent-foreground border border-primary/30'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent',
        )}
      >
        <Icon className="size-[18px] shrink-0" />
        {expanded && <span className="text-[13px] font-medium truncate">{item.label}</span>}
        {item.id === 'review' && (
          <ReviewAttentionIndicator count={pendingReviewCount} compact={!expanded} />
        )}
      </Link>
    )
  }

  return (
    <nav
      aria-label="Global navigation"
      className={cn('hidden md:flex shrink-0 flex-col border-r border-border bg-card py-2.5', expanded ? 'w-[180px]' : 'w-[60px]')}
    >
      <Link
        to="/home"
        className={cn('flex items-center h-9 mb-1.5', expanded ? 'gap-2.5 px-3' : 'justify-center')}
        style={{ textDecoration: 'none' }}
        title="rainver — Home"
      >
        <ApertureMark size={22} />
        {expanded && <span className="font-bold text-[13px] tracking-tight text-accent-foreground">rainver</span>}
      </Link>

      <div className="flex flex-col gap-0.5 mt-1">
        {main.map(renderItem)}
      </div>

      {pluginModules.length > 0 && (
        <>
          <div className="mx-3 my-1.5 border-t border-border/50" />
          <div className="flex flex-col gap-0.5">
            {pluginModules.map(m => {
              const Icon = pluginIcon(m.icon)
              const logical = stripSpacePrefix(pathname)
              const active = logical === m.path || logical.startsWith(`${m.path}/`)
              return (
                <Link
                  key={m.id}
                  to={m.scope === 'space' ? spacePath(spaceId, m.path) : m.path}
                  title={m.label}
                  aria-label={m.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center rounded-md transition-colors h-9',
                    expanded ? 'gap-3 px-2.5 mx-1.5' : 'justify-center mx-auto w-9',
                    active
                      ? 'bg-primary/10 text-accent-foreground border border-primary/30'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent',
                  )}
                >
                  <Icon className="size-[18px] shrink-0" />
                  {expanded && <span className="text-[13px] font-medium truncate">{m.label}</span>}
                </Link>
              )
            })}
          </div>
        </>
      )}

      <div className="flex-1" />

      <div className="flex flex-col gap-0.5">
        {footer.map(renderItem)}
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse rail' : 'Expand rail'}
          title={expanded ? 'Collapse rail' : 'Expand rail'}
          className={cn(
            'flex items-center rounded-md transition-colors h-9 text-muted-foreground hover:text-foreground hover:bg-accent',
            expanded ? 'gap-3 px-2.5 mx-1.5' : 'justify-center mx-auto w-9',
          )}
        >
          {expanded ? <PanelLeftClose className="size-[18px] shrink-0" /> : <PanelLeftOpen className="size-[18px] shrink-0" />}
          {expanded && <span className="text-[13px] font-medium">Collapse</span>}
        </button>
      </div>
    </nav>
  )
}
