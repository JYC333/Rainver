import { useEffect, useState } from 'react'
import { Gauge, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import { sessionEpoch } from '../../lib/sessionResidue'
import { useAppTranslation } from '../../i18n'
import type { RoomConversationQuota } from '../../types/api'
import { quotaWindowText, resetLabel } from './DiscussionGroup'
import {
  dismissalsFor,
  isDismissable,
  isSuppressed,
  nextDismissalChange,
  QUOTA_READING_STALE_MS,
  readingFreshness,
  readQuotaDismissals,
  writeQuotaDismissals,
  type QuotaDismissal,
  type QuotaDismissalScope,
} from './quotaDismissal'

/**
 * The subscription line above the composer (`modules/rooms.md`, "Subscription
 * quota gate"). A login past the Space's warning line is named with its
 * window and when it was last read; Agent-triggered turns held at the
 * reserve line are said to wait, with "continue anyway" for whoever may
 * decide to spend (a Project writer). A person's own message is never held,
 * so nothing here stops them sending.
 *
 * An ordinary warning can be put away for three hours (`quotaDismissal.ts`);
 * held turns and an exhausted window always show. Dismissing is this
 * person's display choice only.
 */
export function ConversationQuotaLine({
  quota,
  onContinueAnyway,
  dismissalScope = null,
}: {
  quota: RoomConversationQuota | null
  /** Absent for a reader who may not continue anyway. */
  onContinueAnyway?: () => Promise<void>
  /** The signed-in user and Space a dismissal is remembered for; without one it lasts until reload. */
  dismissalScope?: QuotaDismissalScope | null
}) {
  const { t } = useAppTranslation()
  const [busy, setBusy] = useState(false)
  const scopeKey = dismissalScope ? `${dismissalScope.userId}\u0000${dismissalScope.spaceId}` : ''
  const [dismissals, setDismissals] = useState<{ scopeKey: string; epoch: number; items: Record<string, QuotaDismissal> }>(
    () => ({ scopeKey, epoch: sessionEpoch(), items: readQuotaDismissals(dismissalScope) }))
  const [now, setNow] = useState(() => Date.now())
  // Another person, Space or session: their dismissals, never the previous ones.
  const current = dismissals.scopeKey === scopeKey && dismissals.epoch === sessionEpoch()
    ? dismissals
    : { scopeKey, epoch: sessionEpoch(), items: readQuotaDismissals(dismissalScope) }
  if (current !== dismissals) setDismissals(current)

  // Each new reading is judged at its own time; a lapse in between re-renders on its own.
  useEffect(() => { setNow(Date.now()) }, [quota])
  const lapses = [
    nextDismissalChange(current.items, now),
    ...(quota?.logins ?? []).map(login => login.checked_at ? Date.parse(login.checked_at) + QUOTA_READING_STALE_MS : NaN),
  ].filter((at): at is number => at !== null && Number.isFinite(at) && at > now)
  const nextChange = lapses.length ? Math.min(...lapses) : null
  useEffect(() => {
    if (nextChange === null) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, nextChange - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [nextChange])

  if (!quota) return null
  const warned = quota.logins.filter(login => login.window && login.window.utilization >= quota.warn_pct)
  const shown = warned.filter(login => !isSuppressed(login, quota, current.items[login.login_key], now))
  if (shown.length === 0 && quota.holds.length === 0) return null
  const dismissable = shown.filter(isDismissable)
  const resets = quota.holds
    .map(hold => resetLabel(hold.resets_at))
    .filter((label): label is string => Boolean(label))
  // Only a hold on a login the viewer may spend is theirs to continue anyway.
  const continuable = onContinueAnyway && quota.holds.some(hold => hold.can_continue)
  const dismiss = () => {
    const at = Date.now()
    const added = dismissalsFor(quota, dismissable, at)
    const items = dismissalScope
      ? writeQuotaDismissals(dismissalScope, added, current.epoch, at)
      : { ...current.items, ...Object.fromEntries(added.map(item => [item.login_key, item])) }
    setDismissals({ scopeKey, epoch: current.epoch, items })
    setNow(at)
  }
  const checkedText = (checkedAt: string | null) => {
    const freshness = readingFreshness(checkedAt, now)
    if (freshness === 'unknown') return t('conversation_ui.quota.not_checked')
    const time = resetLabel(checkedAt, new Date(now)) ?? ''
    return t(freshness === 'stale' ? 'conversation_ui.quota.checked_stale' : 'conversation_ui.quota.checked_at', { time })
  }
  return (
    <div className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 py-1 pl-2 pr-1 text-xs text-amber-800 dark:text-amber-300" data-testid="conversation-quota-line">
      <div className="min-w-0 flex-1 space-y-0.5 py-0.5">
        {shown.map(login => (
          <p key={login.login_key} className="flex items-start gap-1.5" data-testid="conversation-quota-login">
            <Gauge className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              {t('conversation_ui.quota.login_at', { account: login.account_label, window: quotaWindowText(login.window!) })}
              {' '}
              <span
                className={readingFreshness(login.checked_at, now) === 'stale' ? 'font-medium' : 'opacity-80'}
                data-testid="conversation-quota-checked"
                title={login.checked_at ?? undefined}
              >
                · {checkedText(login.checked_at)}
              </span>
            </span>
          </p>
        ))}
        {quota.holds.length > 0 && (
          <p className={`flex flex-wrap items-center gap-1 ${shown.length > 0 ? 'pl-5' : ''}`}>
            <span>
              {resets.length > 0
                ? t('conversation_ui.quota.agents_waiting_resets', { reset: resets[0] })
                : t('conversation_ui.quota.agents_waiting')}
            </span>
            {continuable && <span aria-hidden="true">·</span>}
            {continuable && <button
              type="button"
              className="underline underline-offset-2 disabled:opacity-50"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onContinueAnyway!()
                } catch (error) {
                  toast.error(errMsg(error))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('conversation_ui.quota.continue_anyway')}
            </button>}
          </p>
        )}
      </div>
      {dismissable.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-current hover:bg-amber-500/20 hover:text-current"
          aria-label={t('conversation_ui.quota.dismiss')}
          title={t('conversation_ui.quota.dismiss_hint')}
          onClick={dismiss}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
