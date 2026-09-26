import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { PanelLeftClose } from 'lucide-react'
import { cn } from '../../lib/utils'
import { spacePath, stripSpacePrefix, type RouteSceneItem, type Scene } from '../../core/navigation'
import { useAppTranslation } from '../../i18n'

/** Build the in-space destination for a filter-scene item (value '' clears the filter). */
function filterItemTo(spaceId: string | null, base: string, filterKey: string, value: string): string {
  const logical = value ? `${base}?${filterKey}=${encodeURIComponent(value)}` : base
  return spacePath(spaceId, logical)
}

interface ActiveItem {
  to: string
  label: string
  active: boolean
  depth: number
}

interface FlatRouteSceneItem {
  to: string
  label: string
  depth: number
}

function flattenRouteItems(items: RouteSceneItem[], depth = 0): FlatRouteSceneItem[] {
  return items.flatMap(item => [
    { to: item.to, label: item.label, depth },
    ...flattenRouteItems(item.children ?? [], depth + 1),
  ])
}

function sceneItems(
  scene: Scene,
  pathname: string,
  searchValue: string | null,
  spaceId: string | null,
): ActiveItem[] {
  const logical = stripSpacePrefix(pathname)
  if (scene.kind === 'filter') {
    const current = searchValue ?? scene.defaultValue
    return scene.items.map(it => ({
      to: filterItemTo(spaceId, scene.base, scene.filterKey, it.value),
      label: it.label,
      depth: 0,
      active: logical.startsWith(scene.base) && it.value === current,
    }))
  }
  // route scene: the active item is the one whose path is the longest prefix of pathname
  const routeItems = flattenRouteItems(scene.items)
  let bestLen = -1
  routeItems.forEach(it => {
    if (logical === it.to || logical.startsWith(`${it.to}/`)) bestLen = Math.max(bestLen, it.to.length)
  })
  return routeItems.map(it => ({
    to: spacePath(spaceId, it.to),
    label: it.label,
    depth: it.depth,
    active: (logical === it.to || logical.startsWith(`${it.to}/`)) && it.to.length === bestLen,
  }))
}

/** Desktop second-level navigation for the current scene. Collapsible. */
export function SceneSidebar({
  scene,
  onCollapse,
  spaceId,
}: {
  scene: Scene
  onCollapse: () => void
  spaceId: string | null
}) {
  const { pathname } = useLocation()
  const { t } = useAppTranslation()
  const [searchParams] = useSearchParams()
  const searchValue = scene.kind === 'filter' ? searchParams.get(scene.filterKey) : null
  const items = sceneItems(scene, pathname, searchValue, spaceId)
  const title = t(`nav.${scene.id}`, { defaultValue: t(`modules.${scene.id}`, { defaultValue: scene.title }) })
  const Icon = scene.icon

  return (
    <aside aria-label={t('shell.navigation', { name: title })} className="hidden md:flex shrink-0 w-[200px] flex-col border-r border-border bg-card/60">
      <div className="flex items-center justify-between h-11 px-3 border-b border-border">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-foreground">
          <Icon className="size-3.5" /> {title}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t('shell.collapse_sidebar')}
          title={t('shell.collapse_sidebar')}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <PanelLeftClose className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-0.5 p-2 overflow-y-auto">
        {items.map(it => (
          <Link
            key={it.label}
            to={it.to}
            aria-current={it.active ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
              it.depth > 0 && 'ml-4 text-[12px]',
              it.active
                ? 'bg-primary/10 text-accent-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent',
            )}
          >
            {t(`scene.${it.label.toLowerCase().replace(/ /g, '_')}`, { defaultValue: it.label })}
          </Link>
        ))}
      </div>
    </aside>
  )
}

/** Mobile second-level navigation — a horizontal scrollable tab strip (no dual sidebars). */
export function SceneTabs({
  scene,
  spaceId,
}: {
  scene: Scene
  spaceId: string | null
}) {
  const { pathname } = useLocation()
  const { t } = useAppTranslation()
  const [searchParams] = useSearchParams()
  const searchValue = scene.kind === 'filter' ? searchParams.get(scene.filterKey) : null
  const items = sceneItems(scene, pathname, searchValue, spaceId)

  return (
    <div className="md:hidden flex gap-1.5 overflow-x-auto border-b border-border bg-card px-3 py-2">
      {items.map(it => (
        <Link
          key={it.label}
          to={it.to}
          aria-current={it.active ? 'page' : undefined}
          className={cn(
            'shrink-0 rounded-full px-3 py-1 text-[12px] transition-colors border',
            it.depth > 0 && 'pl-2',
            it.active
              ? 'bg-primary/10 text-accent-foreground border-primary/30 font-medium'
              : 'text-muted-foreground border-border hover:text-foreground',
          )}
        >
          {t(`scene.${it.label.toLowerCase().replace(/ /g, '_')}`, { defaultValue: it.label })}
        </Link>
      ))}
    </div>
  )
}
