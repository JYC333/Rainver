import type { AgentAttentionReadState, AgentAttentionViewRequest, AgentAttentionViewResult } from '@rainver/protocol'
import { readingSubjectKey } from './readingSubjectKey'

export const VIEW_REPORT_DELAY_MS = 300
export const VIEW_REPORT_BATCH = 200
/**
 * One displayed message: its id and a fingerprint of the body shown. A reply
 * updated in place keeps its id, and the server reads it as a new revision, so
 * a changed fingerprint is a new view of that message. A bare id has none.
 */
export type ShownMessage = string | { id: string; shown: string }
/**
 * Fingerprint of what a surface shows of a message: the same inputs the server
 * revision covers (body and open-question flag), never the revision itself.
 */
export function shownVersion(content: string, awaitingAnswer = false): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 0x01000193)
  return `${content.length.toString(36)}.${(hash >>> 0).toString(36)}${awaitingAnswer ? '.q' : ''}`
}
/** One mounted surface: displayed id → fingerprint; `reported` holds id+fingerprint evidence. `group` names the explicit open (if any) that may pause it. */
type Surface = { shown: Map<string, string>; reported: Set<string>; group?: object }
const evidence = (id: string, shown: string) => `${id}\u0000${shown}`
const shownMap = (messages: ShownMessage[]) => new Map(messages.map(message => typeof message === 'string' ? [message, ''] : [message.id, message.shown]))
/** One issued request; a manual decision checks only the requests it awaited. */
type Report = { done: Promise<void>; failed: boolean; failure?: unknown }
type Viewing = { spaceId: string; sessionId: string; surfaces: Map<object, Surface>; paused: Set<object>;
  pending: Set<Report>; reads: Map<string, AgentAttentionReadState>; flushing: boolean; timer?: ReturnType<typeof setTimeout> }
const viewingKey = (spaceId: string, sessionId: string) => `${spaceId}:${sessionId}`

/**
 * One account's "I displayed these messages" reports, from every conversation
 * surface alike. Reports are best effort and idempotent: the server records a
 * read only for a message still unread. Each surface reports a displayed
 * message once per shown body while the tab is visible (an in-place update is
 * shown again) and again when the tab returns; a Session sends one batch
 * at a time for the union of its unpaused surfaces.
 */
export class ViewReporter {
  private viewing = new Map<string, Viewing>()
  private departed = new Set<Viewing>()
  private closed = false
  private lifetime = new AbortController()
  constructor(private readonly send: (body: AgentAttentionViewRequest, signal: AbortSignal) => Promise<AgentAttentionViewResult>, private readonly visible: () => boolean = () => document.visibilityState === 'visible') {}
  /** Reopen after React's effect cleanup/replay and schedule the mounted surfaces. */
  start() { this.closed = false; if (this.lifetime.signal.aborted) this.lifetime = new AbortController(); for (const current of this.viewing.values()) this.schedule(current) }
  /** One mounted surface's current displayed set; an empty set only stops its earlier reports. */
  displayed(surface: object, spaceId: string, sessionId: string, messages: ShownMessage[], group?: object) {
    const current = this.entry(spaceId, sessionId)
    const existing = current.surfaces.get(surface)
    if (existing) { existing.shown = shownMap(messages); existing.group = group }
    else current.surfaces.set(surface, { shown: shownMap(messages), reported: new Set(), group })
    this.schedule(current)
  }
  /** The surface unmounted; other surfaces of the same Session keep reporting. */
  left(surface: object, spaceId: string, sessionId: string) {
    const current = this.viewing.get(viewingKey(spaceId, sessionId))
    if (!current?.surfaces.delete(surface)) return
    this.vacate(current)
  }
  /** The explicit open that paused its surfaces ended. */
  release(group: object, spaceId: string, sessionId: string) {
    const current = this.viewing.get(viewingKey(spaceId, sessionId))
    if (!current?.paused.delete(group)) return
    this.vacate(current)
  }
  /** The tab became visible: what is on screen now has been seen now. */
  resume() { for (const current of this.viewing.values()) { for (const surface of current.surfaces.values()) surface.reported.clear(); this.schedule(current) } }
  /**
   * Stop one explicit open's surfaces before an explicit unread and wait for
   * every report already issued for that Session. Only those awaited requests
   * can fail the decision; return the Session's committed reads.
   */
  async pause(group: object, spaceId: string, sessionId: string): Promise<AgentAttentionReadState[]> {
    if (this.closed) throw new DOMException('Attention account closed', 'AbortError')
    // The summary can be open before its transcript finishes loading. Reserve
    // the paused group now so its later displayed set cannot race the decision.
    const current = this.entry(spaceId, sessionId)
    current.paused.add(group)
    const related = [...this.departed].filter(view => view.spaceId === spaceId && view.sessionId === sessionId)
    related.push(current)
    const awaited = related.flatMap(view => [...view.pending])
    await Promise.all(awaited.map(report => report.done))
    if (this.closed || this.viewing.get(viewingKey(spaceId, sessionId)) !== current) throw new DOMException('Conversation view closed', 'AbortError')
    const failed = awaited.find(report => report.failed)
    if (failed) throw failed.failure
    return related.flatMap(view => [...view.reads.values()])
  }
  close() { this.closed = true; this.lifetime.abort(); for (const current of this.viewing.values()) clearTimeout(current.timer); this.viewing.clear(); this.departed.clear() }
  private entry(spaceId: string, sessionId: string) {
    const key = viewingKey(spaceId, sessionId)
    let current = this.viewing.get(key)
    if (!current) { current = { spaceId, sessionId, surfaces: new Map(), paused: new Set(), pending: new Set(), reads: new Map(), flushing: false }; this.viewing.set(key, current) }
    return current
  }
  private vacate(current: Viewing) {
    if (current.surfaces.size || current.paused.size) return
    clearTimeout(current.timer); current.timer = undefined
    this.viewing.delete(viewingKey(current.spaceId, current.sessionId))
    // Closing a surface cannot undo a report the server may already be writing.
    // A quick reopen must still order its manual decision after that request.
    if (current.pending.size) this.departed.add(current)
  }
  private unsent(current: Viewing) {
    const ids = new Set<string>()
    for (const surface of current.surfaces.values()) {
      if (surface.group && current.paused.has(surface.group)) continue
      for (const [id, shown] of surface.shown) if (!surface.reported.has(evidence(id, shown))) ids.add(id)
    }
    return [...ids]
  }
  private live(current: Viewing) { return !this.closed && this.visible() && this.viewing.get(viewingKey(current.spaceId, current.sessionId)) === current }
  private schedule(current: Viewing) {
    if (current.timer || current.flushing || !this.live(current) || !this.unsent(current).length) return
    current.timer = setTimeout(() => { current.timer = undefined; void this.flush(current) }, VIEW_REPORT_DELAY_MS)
  }
  /** One serialized loop per Session; each batch recomputes what is still unreported. */
  private async flush(current: Viewing) {
    if (current.flushing) return
    current.flushing = true
    const signal = this.lifetime.signal
    try {
      while (!signal.aborted && this.live(current)) {
        const ids = this.unsent(current).slice(0, VIEW_REPORT_BATCH)
        if (!ids.length) return
        const batch = new Set(ids)
        // The evidence this batch covers, as displayed when it was sent: a body
        // that changes while the request is in flight remains unreported.
        const sent = [...current.surfaces.values()].map(surface => ({ surface,
          keys: [...surface.shown].filter(([id]) => batch.has(id)).map(([id, shown]) => evidence(id, shown)) }))
        const report: Report = { done: Promise.resolve(), failed: false }
        report.done = this.send({ space_id: current.spaceId, session_id: current.sessionId, message_ids: ids }, signal).then(result => {
          if (signal.aborted) return
          for (const { surface, keys } of sent) for (const key of keys) surface.reported.add(key)
          for (const state of result.read_states) {
            const key = readingSubjectKey(state.subject)
            if ((current.reads.get(key)?.state_version ?? -1) < state.state_version) current.reads.set(key, state)
          }
        }, failure => { report.failed = true; report.failure = failure })
        current.pending.add(report)
        await report.done
        current.pending.delete(report)
        if (!current.pending.size) this.departed.delete(current)
        // A failed batch stays unreported; the next display change or return retries it.
        if (report.failed) return
      }
    } finally { current.flushing = false }
  }
}
