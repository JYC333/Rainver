import { useState } from 'react'
import { Gauge } from 'lucide-react'
import { toast } from 'sonner'
import { errMsg } from '../../lib/utils'
import type { RoomConversationQuota } from '../../types/api'
import { quotaWindowText, resetLabel } from './DiscussionGroup'

/**
 * The subscription line above the composer (`modules/rooms.md`, "Subscription
 * quota gate"). A login past the Space's warning line is named with its
 * window; Agent-triggered turns held at the reserve line are said to wait,
 * with "continue anyway" for whoever may decide to spend (a Project writer).
 * A person's own message is never held, so nothing here stops them sending.
 */
export function ConversationQuotaLine({
  quota,
  onContinueAnyway,
}: {
  quota: RoomConversationQuota | null
  /** Absent for a reader who may not continue anyway. */
  onContinueAnyway?: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  if (!quota) return null
  const warned = quota.logins.filter(login => login.window && login.window.utilization >= quota.warn_pct)
  if (warned.length === 0 && quota.holds.length === 0) return null
  const resets = quota.holds
    .map(hold => resetLabel(hold.resets_at))
    .filter((label): label is string => Boolean(label))
  // Only a hold on a login the viewer may spend is theirs to continue anyway.
  const continuable = onContinueAnyway && quota.holds.some(hold => hold.can_continue)
  return (
    <div className="space-y-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300" data-testid="conversation-quota-line">
      {warned.map(login => (
        <p key={login.account_label} className="flex items-center gap-1.5">
          <Gauge className="size-3.5 shrink-0" />
          <span>{login.account_label} is at {quotaWindowText(login.window!)}</span>
        </p>
      ))}
      {quota.holds.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 pl-5">
          <span>
            Agents are waiting for the window{resets.length > 0 ? ` (resets ${resets[0]})` : ''}
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
            continue anyway
          </button>}
        </p>
      )}
    </div>
  )
}
