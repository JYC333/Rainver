import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { NavLinkOrInert } from '../../core/spaceNav'
import { Ellipsis, Puzzle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MOBILE_TAB_ITEMS, RAIL_ITEMS, railItemActive, spaceHref } from '../../core/navigation'
import { ReviewAttentionIndicator } from './ReviewAttentionIndicator'
import { AttentionBadge } from '../../modules/agent_work/AttentionIndicators'
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogClose } from '../ui/dialog'
import type { PluginNavItem } from './GlobalRail'
import { useAppTranslation } from '../../i18n'


/** Three primary destinations plus a permission-aware More menu. */
export function MobileTabBar({ spaceId, pendingReviewCount = 0, canManageSpace = false, canManageInstance = false, pluginModules = [] }: {
  spaceId: string | null
  pendingReviewCount?: number
  canManageSpace?: boolean
  canManageInstance?: boolean
  pluginModules?: PluginNavItem[]
}) {
  const { pathname } = useLocation()
  const { t } = useAppTranslation()
  const [open, setOpen] = useState(false)
  const moreItems = RAIL_ITEMS.filter(item => !item.mobile &&
    (!item.requiresSpaceAdmin || canManageSpace) && (!item.requiresInstanceAdmin || canManageInstance))
  const moreActive = !MOBILE_TAB_ITEMS.some(item => railItemActive(item, pathname))
  return <nav aria-label={t('shell.primary_navigation')}
    className="md:hidden shrink-0 flex items-stretch border-t border-border bg-card" style={{ paddingBottom: 'max(0px, calc(var(--app-safe-bottom) - var(--app-pwa-keyboard-inset, 0px)))' }}>
    {MOBILE_TAB_ITEMS.map(item => {
      const Icon = item.icon
      return <NavLinkOrInert key={item.id} to={item.scope === 'space' ? spaceHref(spaceId, item.to) : item.to}
        aria-current={railItemActive(item, pathname) ? 'page' : undefined}
        className={cn('flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors', railItemActive(item, pathname) ? 'text-accent-foreground' : 'text-muted-foreground hover:text-foreground')}>
        <span className="relative"><Icon className="size-[18px]" />{item.id === 'agent-work' && <AttentionBadge dot />}</span>
        {t(`nav.${item.id.replace(/-/g, '_')}`, { defaultValue: item.label })}
      </NavLinkOrInert>
    })}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" aria-current={moreActive ? 'true' : undefined}
          className={cn('relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium', moreActive ? 'text-accent-foreground' : 'text-muted-foreground hover:text-foreground')}>
          <Ellipsis className="size-[18px]" />{t('nav.more')}
          <ReviewAttentionIndicator count={pendingReviewCount} compact />
        </button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="max-h-[80dvh] w-[calc(100%-2rem)] overflow-y-auto">
        <DialogTitle className="mb-4">{t('nav.more')}</DialogTitle>
        <nav aria-label={t('nav.more')} className="flex flex-col gap-1">
          {moreItems.map(item => {
            const Icon = item.icon
            return <DialogClose asChild key={item.id}>
              <NavLinkOrInert to={item.scope === 'space' ? spaceHref(spaceId, item.to) : item.to}
                aria-current={railItemActive(item, pathname) ? 'page' : undefined}
                className="relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm hover:bg-accent aria-[current=page]:bg-accent">
                <Icon className="size-[18px] shrink-0" />
                {t(`nav.${item.id.replace(/-/g, '_')}`, { defaultValue: item.label })}
                {item.id === 'review' && <ReviewAttentionIndicator count={pendingReviewCount} />}
              </NavLinkOrInert>
            </DialogClose>
          })}
          {pluginModules.map(item => <DialogClose asChild key={item.id}>
            <NavLinkOrInert to={item.scope === 'space' ? spaceHref(spaceId, item.path) : item.path}
              className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm hover:bg-accent">
              <Puzzle className="size-[18px] shrink-0" />{item.label}
            </NavLinkOrInert>
          </DialogClose>)}
        </nav>
      </DialogContent>
    </Dialog>
  </nav>
}
