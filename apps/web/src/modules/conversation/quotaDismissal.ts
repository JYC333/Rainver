import type { ConversationSubscriptionLogin, RoomConversationQuota, SubscriptionQuotaWindow } from '@rainver/protocol'
import { scopedUserStorageKey, sessionEpoch } from '../../lib/sessionResidue'

/**
 * A person's "not now" on the composer's subscription warning
 * (`modules/rooms.md`, "Subscription quota gate").
 *
 * Presentation only: it hides an ordinary warning line in this person's
 * browser tab and changes nothing the server decides — no budget, no
 * reserve line, no hold, no "continue anyway" authority. Held turns and an
 * exhausted window are never hidden. Stored in `sessionStorage` under a key
 * scoped to the signed-in user and the Space, so it is cleared with every
 * other session leftover at logout (`lib/sessionResidue.ts`) and is never
 * seen by another person.
 */

/** A dismissal lasts this long unless the situation worsens first. */
export const QUOTA_DISMISS_MS = 3 * 60 * 60_000
/** Usage this many points above the dismissed reading shows the line again. */
export const QUOTA_DISMISS_RISE_PCT = 5
/**
 * Two readings of one window may report slightly different reset times;
 * resets further apart than this are different windows.
 */
const SAME_WINDOW_RESET_TOLERANCE_MS = 30 * 60_000
/** The server sweeps every 15 minutes; a reading older than two sweeps is called out as stale. */
export const QUOTA_READING_STALE_MS = 30 * 60_000
const MAX_DISMISSALS = 50

export interface QuotaDismissal {
  login_key: string
  kind: SubscriptionQuotaWindow['kind']
  resets_at: string | null
  utilization: number
  severity: QuotaSeverity
  dismissed_at: number
}

/** 0 below the warning line, 1 warned, 2 at the reserve line, 3 exhausted. */
export type QuotaSeverity = 0 | 1 | 2 | 3

export function quotaSeverity(utilization: number, policy: Pick<RoomConversationQuota, 'warn_pct' | 'reserve_pct'>): QuotaSeverity {
  if (utilization >= 100) return 3
  if (utilization >= policy.reserve_pct) return 2
  if (utilization >= policy.warn_pct) return 1
  return 0
}

/** A warned login whose line may be dismissed: not exhausted. */
export function isDismissable(login: ConversationSubscriptionLogin): boolean {
  return Boolean(login.window && login.window.utilization < 100)
}

function sameWindow(dismissal: QuotaDismissal, window: SubscriptionQuotaWindow): boolean {
  if (dismissal.kind !== window.kind) return false
  if (!dismissal.resets_at || !window.resets_at) return dismissal.resets_at === window.resets_at
  return Math.abs(Date.parse(dismissal.resets_at) - Date.parse(window.resets_at)) <= SAME_WINDOW_RESET_TOLERANCE_MS
}

/**
 * Whether a dismissal still hides this login's line. It stops when it
 * expires, when the dismissed window has reset or another window/account is
 * read, when usage rises 5 points above the dismissed reading, when a more
 * severe line is crossed, or when the window is exhausted.
 */
export function isSuppressed(
  login: ConversationSubscriptionLogin,
  policy: Pick<RoomConversationQuota, 'warn_pct' | 'reserve_pct'>,
  dismissal: QuotaDismissal | undefined,
  now: number,
): boolean {
  const window = login.window
  if (!dismissal || !window || !isDismissable(login)) return false
  if (dismissal.login_key !== login.login_key) return false
  if (now - dismissal.dismissed_at >= QUOTA_DISMISS_MS) return false
  if (dismissal.resets_at && Date.parse(dismissal.resets_at) <= now) return false
  if (!sameWindow(dismissal, window)) return false
  if (window.utilization >= dismissal.utilization + QUOTA_DISMISS_RISE_PCT) return false
  return quotaSeverity(window.utilization, policy) <= dismissal.severity
}

/** The earliest moment a dismissal of these logins could lapse on its own, for a re-render. */
export function nextDismissalChange(dismissals: Record<string, QuotaDismissal>, now: number): number | null {
  let next: number | null = null
  for (const dismissal of Object.values(dismissals)) {
    for (const at of [dismissal.dismissed_at + QUOTA_DISMISS_MS, dismissal.resets_at ? Date.parse(dismissal.resets_at) : NaN]) {
      if (Number.isFinite(at) && at > now && (next === null || at < next)) next = at
    }
  }
  return next
}

export function dismissalsFor(
  quota: RoomConversationQuota,
  logins: ConversationSubscriptionLogin[],
  now: number,
): QuotaDismissal[] {
  return logins.filter(isDismissable).map(login => ({
    login_key: login.login_key,
    kind: login.window!.kind,
    resets_at: login.window!.resets_at,
    utilization: login.window!.utilization,
    severity: quotaSeverity(login.window!.utilization, quota),
    dismissed_at: now,
  }))
}

export interface QuotaDismissalScope {
  userId: string
  spaceId: string
}

export function quotaDismissalStorageKey(scope: QuotaDismissalScope): string {
  return scopedUserStorageKey('conversation-quota-dismissals', scope.userId, scope.spaceId)
}

function storage(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

function validDismissal(value: unknown, now: number): value is QuotaDismissal {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.login_key === 'string'
    && (item.kind === 'session' || item.kind === 'week')
    && (item.resets_at === null || typeof item.resets_at === 'string')
    && typeof item.utilization === 'number'
    && (item.severity === 0 || item.severity === 1 || item.severity === 2 || item.severity === 3)
    && typeof item.dismissed_at === 'number'
    && now - item.dismissed_at < QUOTA_DISMISS_MS
    // A clock that moved backwards must not make a dismissal last longer.
    && item.dismissed_at - now < 5 * 60_000
}

/** This person's live dismissals in this Space, keyed by login; expired ones are dropped. */
export function readQuotaDismissals(scope: QuotaDismissalScope | null, now: number = Date.now()): Record<string, QuotaDismissal> {
  const store = scope ? storage() : null
  if (!store || !scope) return {}
  try {
    const parsed: unknown = JSON.parse(store.getItem(quotaDismissalStorageKey(scope)) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, QuotaDismissal] => validDismissal(entry[1], now) && entry[0] === entry[1].login_key))
  } catch {
    return {}
  }
}

/**
 * Records dismissals for this person and Space. `epoch` is the session the
 * caller read in; after a logout (a new epoch) nothing is written.
 */
export function writeQuotaDismissals(
  scope: QuotaDismissalScope | null,
  added: QuotaDismissal[],
  epoch: number,
  now: number = Date.now(),
): Record<string, QuotaDismissal> {
  const current = readQuotaDismissals(scope, now)
  for (const dismissal of added) current[dismissal.login_key] = dismissal
  const kept = Object.fromEntries(Object.entries(current)
    .sort((a, b) => b[1].dismissed_at - a[1].dismissed_at)
    .slice(0, MAX_DISMISSALS))
  const store = scope ? storage() : null
  if (store && scope && epoch === sessionEpoch()) {
    try { store.setItem(quotaDismissalStorageKey(scope), JSON.stringify(kept)) } catch { /* private mode or full */ }
  }
  return kept
}

/** "fresh", "stale" or "unknown": how much to trust a login's percentage now. */
export function readingFreshness(checkedAt: string | null, now: number): 'fresh' | 'stale' | 'unknown' {
  if (!checkedAt) return 'unknown'
  const at = Date.parse(checkedAt)
  if (!Number.isFinite(at)) return 'unknown'
  return now - at > QUOTA_READING_STALE_MS ? 'stale' : 'fresh'
}
