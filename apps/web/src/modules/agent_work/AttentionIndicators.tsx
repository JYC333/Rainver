import { useAppTranslation } from '../../i18n'
import { formatNumber } from '../../i18n/format'
import { Badge, type BadgeProps } from '../../components/ui/badge'
import { useAttention, useAttentionState, useOptionalAttention } from './AgentAttentionProvider'

export function AttentionBadge({ compact = false, dot = false }: { compact?: boolean; dot?: boolean }) { return useOptionalAttention() ? <BadgeContent compact={compact} dot={dot} /> : null }
function BadgeContent({ compact, dot }: { compact: boolean; dot: boolean }) {
  const state = useAttentionState(); const { t } = useAppTranslation()
  if (dot) return state.unread > 0 || state.needsYou > 0
    ? <span className="absolute -right-1 -top-1 size-2 rounded-full bg-destructive ring-2 ring-card" role="status" aria-label={t('agent_work.badge', { unread: formatNumber(state.unread), needs: formatNumber(state.needsYou) })} />
    : null
  return <span className={`${compact ? 'absolute -right-2 -top-1' : 'ml-1'} rounded bg-primary/10 px-1 text-[10px]`} role="status" title={t(`agent_work.freshness.${state.freshness}`)} aria-label={t('agent_work.badge', { unread: formatNumber(state.unread), needs: formatNumber(state.needsYou) })}>
    {formatNumber(state.needsYou)} / {formatNumber(state.unread)}
  </span>
}
const FRESHNESS_VARIANT: Record<string, BadgeProps['variant']> = {
  live: 'success', connecting: 'muted', snapshot: 'warning', stale: 'warning', offline: 'warning', denied: 'destructive',
}
export function AttentionControls() {
  const { delivery, sound, desktop, soundPending, deliveryLimited, enableSound, enableDesktop } = useAttention()
  const state = useAttentionState(); const { t } = useAppTranslation()
  const available = Boolean(delivery?.supported && delivery.leader)
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
    <Badge role="status" variant={FRESHNESS_VARIANT[state.freshness] ?? 'muted'}>{t(`agent_work.freshness.${state.freshness}`)}</Badge>
    <span>{t(!delivery?.supported ? 'agent_work.coordination_limited' : delivery.leader ? 'agent_work.delivery_here' : 'agent_work.delivery_elsewhere')}</span>
    <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-primary" checked={sound} disabled={!available} onChange={() => void enableSound()} />{t('agent_work.enable_sound')}</label>
    <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-primary" checked={desktop} disabled={!available} onChange={() => void enableDesktop()} />{t('agent_work.enable_desktop')}</label>
    {soundPending && <span>{t('agent_work.sound_pending')}</span>}
    {deliveryLimited && <Badge role="status" variant="destructive">{t('agent_work.delivery_limited')}</Badge>}
    <span>{t('agent_work.background_limit')}</span>
  </div>
}
