import type { AgentAttentionNotice } from '@rainver/protocol'
import { scopedUserStorageKey } from '../../lib/sessionResidue'

/** The person's sound/desktop choice, shared by every same-account tab. */
export type AlertPreferences = { sound: boolean; desktop: boolean }
type Message = { type: 'delivered' | 'toasted'; key: string } | ({ type: 'preferences' } & AlertPreferences)
const OFF: AlertPreferences = { sound: false, desktop: false }
const parsePreferences = (value: unknown): AlertPreferences | null => {
  const record = value && typeof value === 'object' ? value as Partial<AlertPreferences> : null
  return record && typeof record.sound === 'boolean' && typeof record.desktop === 'boolean' ? { sound: record.sound, desktop: record.desktop } : null
}
/**
 * Coordination carries opaque delivery/work identities and the alert on/off
 * choice only, never content, permission grants or active views.
 */
export class AttentionDelivery {
  leader = false
  supported = typeof navigator.locks?.request === 'function' && typeof BroadcastChannel !== 'undefined'
  /** Survives a delivery-tab handoff; cleared with the other residue at logout. */
  preferences: AlertPreferences = OFF
  seen = new Set<string>()
  private toastSeen = new Set<string>()
  private pendingToasts = new Map<string, AgentAttentionNotice>()
  private closed = false
  private channel?: BroadcastChannel
  private lifetime = new AbortController()
  private release?: () => void
  private readonly storageKey: string
  constructor(userId: string, private readonly changed: () => void) {
    this.storageKey = scopedUserStorageKey('agent-attention-alerts', userId)
    if (!this.supported) return
    try { this.channel = new BroadcastChannel(`rainver:agent-attention:${userId}`) }
    catch { this.supported = false; return }
    try { this.preferences = parsePreferences(JSON.parse(localStorage.getItem(this.storageKey) ?? 'null')) ?? OFF } catch { /* private mode or malformed */ }
    this.channel.onmessage = event => {
      if (this.closed || !event.data || typeof event.data !== 'object') return
      const value = event.data as Partial<{ type: Message['type']; key: unknown }>
      if (value.type === 'delivered' && typeof value.key === 'string' && value.key.length <= 256) this.remember(value.key)
      if (value.type === 'toasted' && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= 256) this.rememberToast(value.key)
      const preferences = value.type === 'preferences' ? parsePreferences(value) : null
      if (preferences) { this.preferences = preferences; changed() }
    }
    void navigator.locks.request(`rainver:agent-attention:${userId}`, { signal: this.lifetime.signal }, async () => {
      if (this.lifetime.signal.aborted) return
      this.leader = true; changed()
      await new Promise<void>(resolve => { this.release = resolve; if (this.lifetime.signal.aborted) resolve() })
      this.leader = false; changed()
    }).catch(() => { if (!this.lifetime.signal.aborted) { this.supported = false; changed() } })
  }
  /** Record and share an explicit choice; a later delivery tab inherits it. */
  setPreferences(next: AlertPreferences) {
    if (this.closed || !this.supported) return
    this.preferences = { sound: next.sound, desktop: next.desktop }
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.preferences)) } catch { /* private mode */ }
    this.channel?.postMessage({ type: 'preferences', ...this.preferences } satisfies Message)
    this.changed()
  }
  remember(key: string) { this.seen.add(key); if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!) }
  private rememberToast(key: string) {
    this.pendingToasts.delete(key)
    this.toastSeen.add(key)
    if (this.toastSeen.size > 2000) this.toastSeen.delete(this.toastSeen.values().next().value!)
  }
  /** Publish only after a visible toast has actually been shown. */
  toasted(key: string) {
    if (this.closed) return
    this.rememberToast(key)
    this.channel?.postMessage({ type: 'toasted', key } satisfies Message)
  }
  /** In-app delivery shares shown identities, independently of external ownership. */
  acceptToast(notice: AgentAttentionNotice): boolean {
    if (this.closed || this.toastSeen.has(notice.key)) return false
    if (document.visibilityState !== 'visible') {
      this.pendingToasts.set(notice.key, notice)
      if (this.pendingToasts.size > 100) this.pendingToasts.delete(this.pendingToasts.keys().next().value!)
      return false
    }
    this.rememberToast(notice.key)
    return true
  }
  flushToasts(isUnread: (notice: AgentAttentionNotice) => boolean = () => true) {
    if (document.visibilityState !== 'visible') return []
    return [...this.pendingToasts.values()].filter(notice => {
      if (!isUnread(notice)) { this.rememberToast(notice.key); return false }
      return this.acceptToast(notice)
    })
  }
  clearPending() { this.pendingToasts.clear() }
  /** Call only when an explicitly enabled sound/system path can actually deliver. */
  acceptExternal(notice: AgentAttentionNotice): boolean {
    if (this.closed || !this.supported || !this.leader || this.seen.has(notice.key)) return false
    this.remember(notice.key)
    this.channel?.postMessage({ type: 'delivered', key: notice.key } satisfies Message)
    return true
  }
  close() { if (this.closed) return; this.closed = true; this.lifetime.abort(); this.release?.(); this.channel?.close(); this.seen.clear(); this.toastSeen.clear(); this.pendingToasts.clear() }
}
