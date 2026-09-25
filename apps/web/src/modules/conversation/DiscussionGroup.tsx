import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'
import { ROOM_DISCUSSION_DEFAULT_ROUND_CAP } from '@rainver/protocol'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import type {
  RoomDiscussion,
  RoomDiscussionDetail,
  RoomDiscussionNotice,
  RoomDiscussionStatus,
  RoomMessage,
  SubscriptionQuotaWindow,
  SubscriptionUsageLine,
} from '../../types/api'

/**
 * A discussion, folded into the one timeline it lives in (`architecture/CONVERSATION.md`, "Rendering").
 *
 * Storage and replay keep a single order; the discussion is only a wrapper
 * around the messages that carry its id, so there is no second navigation
 * level and every message inside still renders exactly as it would outside.
 */

type AgentLabel = { id: string; name: string }

export type DiscussionTimelineItem =
  | { kind: 'message'; message: RoomMessage }
  | { kind: 'discussion'; discussionId: string; segment: number; messages: RoomMessage[] }

/** The discussion a notice in the transcript is about, when it is one. */
export function discussionNoticeOf(message: RoomMessage): RoomDiscussionNotice | null {
  const metadata = message.metadata_json
  if (!metadata || metadata.room_display !== 'system_notice') return null
  return metadata.discussion_notice ?? null
}

/**
 * Which discussion a message belongs to.
 *
 * The column when set; a notice's own reference otherwise; and, for an
 * emergent discussion, the person's message that started it — the row names it
 * as its origin, and the replies to it are what carry the id.
 */
export function messageDiscussionId(message: RoomMessage, originIds: ReadonlyMap<string, string>): string | null {
  return message.discussion_id ?? discussionNoticeOf(message)?.discussion_id ?? originIds.get(message.id) ?? null
}

/**
 * The timeline with each discussion's consecutive messages folded into one
 * entry. The conversation keeps one order: when other messages come between
 * two stretches of a discussion — it was concluded, the person talked on,
 * someone added rounds — its later stretch is a block of its own where it
 * happened, not appended above what came after.
 */
export function groupDiscussionMessages(
  messages: readonly RoomMessage[],
  discussions: Readonly<Record<string, RoomDiscussion>>,
): DiscussionTimelineItem[] {
  const originIds = new Map(Object.values(discussions).map(discussion => [discussion.origin_message_id, discussion.id]))
  const items: DiscussionTimelineItem[] = []
  const segments = new Map<string, number>()
  for (const message of messages) {
    const discussionId = messageDiscussionId(message, originIds)
    if (!discussionId) {
      items.push({ kind: 'message', message })
      continue
    }
    const last = items[items.length - 1]
    if (last?.kind === 'discussion' && last.discussionId === discussionId) {
      last.messages.push(message)
      continue
    }
    const segment = segments.get(discussionId) ?? 0
    segments.set(discussionId, segment + 1)
    items.push({ kind: 'discussion', discussionId, segment, messages: [message] })
  }
  return items
}

/** Every discussion id this page of messages names, for deciding whether to re-read them. */
export function referencedDiscussionIds(messages: readonly RoomMessage[]): string[] {
  return [...new Set(messages.flatMap(message => {
    const id = message.discussion_id ?? discussionNoticeOf(message)?.discussion_id
    return id ? [id] : []
  }))]
}

/** How many rounds one "add rounds" action asks for: a fresh discussion's default for its shape. */
export function discussionExtensionRounds(discussion: Pick<RoomDiscussion, 'shape'>): number {
  return ROOM_DISCUSSION_DEFAULT_ROUND_CAP[discussion.shape]
}

/**
 * What the extend action is called. On an emergent discussion held at its cap
 * the same call upgrades it into an explicit one, so it says that.
 */
export function discussionExtendLabel(discussion: Pick<RoomDiscussion, 'kind' | 'shape'>): string {
  if (discussion.kind === 'emergent') return 'Open a discussion'
  const rounds = discussionExtensionRounds(discussion)
  return `Add ${rounds} ${rounds === 1 ? 'round' : 'rounds'}`
}

/** A reset time as the reader's clock shows it: the time today, the date too when it is not today. */
export function resetLabel(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** "5-hour window" or "weekly window", at a percentage, with its reset. */
export function quotaWindowText(window: SubscriptionQuotaWindow): string {
  const reset = resetLabel(window.resets_at)
  return `${Math.round(window.utilization)}% of its ${window.kind === 'week' ? 'weekly' : '5-hour'} window${reset ? ` (resets ${reset})` : ''}`
}

/**
 * What the discussion cost, one line per funding source:
 * money on priced Runs; per subscription its tokens here and the account's
 * window, which is account-wide and cannot be charged to the discussion.
 */
export function discussionCostLines(
  usage: RoomDiscussionDetail['usage'],
  discussion?: Pick<RoomDiscussion, 'spend_cap_usd'>,
): string[] {
  const priced = pricedCostLine(usage, discussion)
  return [...(priced ? [priced] : []), ...usage.subscription.map(subscriptionCostLine)]
}

function pricedCostLine(usage: RoomDiscussionDetail['usage'], discussion?: Pick<RoomDiscussion, 'spend_cap_usd'>): string | null {
  if (usage.priced_usd <= 0 && !discussion?.spend_cap_usd) return null
  const cap = discussion?.spend_cap_usd ? ` of $${discussion.spend_cap_usd.toFixed(2)}` : ''
  return `Priced models · $${usage.priced_usd.toFixed(2)}${cap}`
}

function subscriptionCostLine(line: SubscriptionUsageLine): string {
  return `${line.account_label} · ${line.tokens.toLocaleString()} tokens here${line.window ? ` · account at ${quotaWindowText(line.window)}` : ''}`
}

const STATUS_LABEL: Record<RoomDiscussionStatus, string> = {
  active: 'In progress',
  converged: 'Converged',
  cap_reached: 'Round cap reached',
  stopped: 'Stopped',
  closed: 'Concluded',
}

/** Which cap stopped a discussion, as the server records it in `stop_reason`. */
const CAP_LABEL: Record<string, string> = {
  round_cap: 'Round cap reached',
  spend_cap: 'Spend cap reached',
  fanout_budget: 'Turn budget reached',
  quota_exhausted: 'Subscription limit reached',
}

function statusLabel(discussion: Pick<RoomDiscussion, 'status' | 'stop_reason'>): string {
  if (discussion.status === 'cap_reached') return CAP_LABEL[discussion.stop_reason ?? ''] ?? STATUS_LABEL.cap_reached
  return STATUS_LABEL[discussion.status]
}

export function DiscussionGroup({
  discussionId,
  discussion,
  detail,
  warnPct,
  messages,
  agents,
  onStop,
  onExtend,
  onContinueAnyway,
  children,
}: {
  discussionId: string
  /** Absent until the discussion list has been read; the group still folds its messages. */
  discussion?: RoomDiscussion
  /** Its cost lines and quota hold, read when the record changes; absent until then. */
  detail?: Pick<RoomDiscussionDetail, 'usage' | 'quota_hold'>
  /** The Space's warning line: a subscription at or past it is marked. */
  warnPct?: number
  messages: readonly RoomMessage[]
  agents: readonly AgentLabel[]
  onStop: (discussionId: string) => Promise<void>
  /** Absent for a reader who may not add rounds (not a Project writer). */
  onExtend?: (discussionId: string, rounds: number) => Promise<void>
  /** Admit the turns held at the subscription reserve line. */
  onContinueAnyway?: () => Promise<void>
  children: ReactNode
}) {
  // A concluded discussion folds to its header and conclusion; one still
  // running stays open. Once the person toggles it, their choice holds.
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const open = expanded ?? discussion?.status !== 'closed'
  const topic = discussion?.topic?.trim() || messages[0]?.content.trim() || 'Discussion'
  const participants = (discussion?.participant_agent_ids ?? [])
    .map(agentId => agents.find(agent => agent.id === agentId)?.name ?? 'Agent')
  const conclusion = discussion?.conclusion_message_id
    ? messages.find(message => message.id === discussion.conclusion_message_id)?.content.trim()
    : undefined
  const hold = detail?.quota_hold ?? null
  const holdReset = resetLabel(hold?.resets_at)
  const pricedLine = detail ? pricedCostLine(detail.usage, discussion) : null

  async function act(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded-lg border border-border bg-muted/20"
      data-testid={`discussion-${discussionId}`}
      aria-label={`Discussion: ${topic}`}
    >
      <header className="flex flex-wrap items-start gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
        >
          {open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />}
          <MessagesSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{topic}</span>
            {discussion && (
              <span className="block text-[11px] text-muted-foreground">
                {participants.length > 0 && <>{participants.join(', ')} · </>}
                Round {discussion.rounds_used - discussion.round_base}/{discussion.round_cap} · {statusLabel(discussion)}
              </span>
            )}
          </span>
        </button>
        {(discussion?.status === 'active' || discussion?.status === 'cap_reached') && (
          <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void act(() => onStop(discussionId))}>
            Stop
          </Button>
        )}
        {discussion?.status === 'cap_reached' && onExtend && canContinue(discussion) && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={busy}
            onClick={() => void act(() => onExtend(discussionId, discussionExtensionRounds(discussion)))}
          >
            {discussionExtendLabel(discussion)}
          </Button>
        )}
        {detail && (pricedLine || detail.usage.subscription.length > 0) && (
          <ul className="w-full space-y-0.5 pl-9 text-[11px] text-muted-foreground" data-testid={`discussion-cost-${discussionId}`}>
            {pricedLine && <li>{pricedLine}</li>}
            {detail.usage.subscription.map(line => (
              <li
                key={line.account_label}
                className={warnPct !== undefined && line.window && line.window.utilization >= warnPct ? 'text-amber-600 dark:text-amber-400' : undefined}
              >
                {subscriptionCostLine(line)}
              </li>
            ))}
          </ul>
        )}
        {hold && (
          <p className="flex w-full flex-wrap items-center gap-1 pl-9 text-xs text-amber-700 dark:text-amber-400" data-testid={`discussion-quota-hold-${discussionId}`}>
            <span>
              {hold.can_continue ? 'Waiting for the window' : `Waiting for ${hold.account_label}'s window`}
              {holdReset ? ` (resets ${holdReset})` : ''}
            </span>
            {/* Only whoever may spend the login is offered to spend its reserve. */}
            {onContinueAnyway && hold.can_continue && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  className="underline underline-offset-2 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void act(onContinueAnyway)}
                >
                  continue anyway
                </button>
              </>
            )}
          </p>
        )}
        {conclusion && (
          <p className="line-clamp-2 w-full pl-9 text-xs text-muted-foreground" data-testid={`discussion-conclusion-${discussionId}`}>
            Conclusion: {conclusion}
          </p>
        )}
      </header>
      {open && <div className="space-y-4 border-t border-border px-3 py-3">{children}</div>}
    </section>
  )
}

/**
 * A notice about a discussion, as a card rather than a line of system prose:
 * a paused discussion offers the one thing that continues it, and an Agent
 * that could not be admitted is named with the reason and nothing to press.
 */
export function DiscussionNoticeCard({
  message,
  notice,
  discussion,
  agents,
  onExtend,
}: {
  message: RoomMessage
  notice: RoomDiscussionNotice
  discussion?: RoomDiscussion
  agents: readonly AgentLabel[]
  /** Absent for a reader who may not add rounds (not a Project writer). */
  onExtend?: (discussionId: string, rounds: number) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const names = notice.agent_ids.map(agentId => agents.find(agent => agent.id === agentId)?.name ?? 'Agent')
  // Offered only while the discussion is still held at its cap; a notice read
  // after someone already continued it would otherwise offer a refused action.
  const actionable = notice.kind === 'cap_reached' && discussion?.status === 'cap_reached' && onExtend !== undefined
    && canContinue(discussion)
  // A cap or subscription notice explains itself in its message (its reason
  // is a code); the others carry their reason, in words, on the notice.
  const selfExplained = notice.kind === 'quota_hold' || notice.kind === 'cap_reached'
  return (
    <div className="flex justify-start pr-6" data-role="system" data-testid={`discussion-notice-${message.id}`}>
      <div className="max-w-[82%] rounded-md border border-border bg-background p-3 text-foreground">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">
            {noticeTitle(notice)}
          </span>
          {names.length > 0 && <span className="truncate text-[11px] text-muted-foreground">{names.join(', ')}</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{selfExplained ? message.content : notice.reason}</p>
        {actionable && (
          <div className="mt-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onExtend?.(notice.discussion_id, discussionExtensionRounds(discussion))
                } catch (error) {
                  toast.error(errMsg(error))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {discussionExtendLabel(discussion)}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Whether adding rounds has anything to continue with: a debate's next round, or Agents held at the cap. */
function canContinue(discussion: Pick<RoomDiscussion, 'shape' | 'held_mentions'>): boolean {
  return discussion.shape === 'debate' || discussion.held_mentions.length > 0
}

function noticeTitle(notice: RoomDiscussionNotice): string {
  if (notice.kind === 'quota_hold') return 'Waiting for the subscription window'
  if (notice.kind === 'cap_reached') return CAP_LABEL[notice.reason] ?? STATUS_LABEL.cap_reached
  return notice.kind === 'failed' ? 'Discussion ended' : 'Not admitted'
}
