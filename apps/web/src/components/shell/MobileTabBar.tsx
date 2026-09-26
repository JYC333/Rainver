import { Link, useLocation } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { MOBILE_TAB_ITEMS, sceneForPath, spacePath, stripSpacePrefix, type RailItem } from '../../core/navigation'
import { ReviewAttentionIndicator } from './ReviewAttentionIndicator'
import { useAppTranslation } from '../../i18n'

function tabActive(item: RailItem, pathname: string): boolean {
  const logical = stripSpacePrefix(pathname)
  if (item.id === 'home') return logical === '/' || logical === '/home' || logical.startsWith('/home/')
  const scene = sceneForPath(pathname)
  if (scene && scene.id === item.id) return true
  return logical === item.to || logical.startsWith(`${item.to}/`)
}

/** Mobile bottom navigation for the key destinations. Home is always first. */
export function MobileTabBar({ spaceId, pendingReviewCount = 0 }: { spaceId: string | null; pendingReviewCount?: number }) {
  const { pathname } = useLocation()
  const { t } = useAppTranslation()
  return (
    <nav
      aria-label={t('shell.primary_navigation')}
      className="md:hidden shrink-0 flex items-stretch border-t border-border bg-card"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {MOBILE_TAB_ITEMS.map(item => {
        const Icon = item.icon
        const active = tabActive(item, pathname)
        return (
          <Link
            key={item.id}
            to={item.scope === 'space' ? spacePath(spaceId, item.to) : item.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative',
              'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
              active ? 'text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-[18px]" />
            {t(`nav.${item.id.replace(/-/g, '_')}`, { defaultValue: item.label })}
            {item.id === 'review' && <ReviewAttentionIndicator count={pendingReviewCount} compact />}
          </Link>
        )
      })}
    </nav>
  )
}
