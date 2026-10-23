import type { AgentAttentionPage, AgentAttentionQueryInput, AgentAttentionReadState, AgentAttentionStreamFrame } from '@rainver/protocol'
import { AgentAttentionQuerySchema } from '@rainver/protocol'
import { agentAttentionApi, ApiRequestError } from '../../api/client'
import { sameReadingRevision } from './readingSubjectKey'
export type AttentionError = 'denied' | 'offline' | 'failed'
export function failureKind(error: unknown): AttentionError {
  if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) return 'denied'
  return !navigator.onLine || error instanceof TypeError ? 'offline' : 'failed'
}
export const queryKey = (query: AgentAttentionQueryInput) => JSON.stringify(AgentAttentionQuerySchema.parse(query))
export const PERSONAL_QUERY = queryKey({})
type ListState = { page: AgentAttentionPage | null; error: AttentionError | null; loading: boolean }
export type AttentionEntry = { key: string; state: ListState; pages: number; listeners: Set<() => void>; request?: AbortController; token: number; dirty: boolean; lastRefresh: number; timer?: ReturnType<typeof setTimeout> }
export const FILTER_REFRESH_MS = 5000

/** One account lifetime: a personal stream window and only mounted filtered windows. */
export class AttentionStore {
  entries = new Map<string, AttentionEntry>()
  listeners = new Set<() => void>()
  state = { unread: 0, needsYou: 0, freshness: 'connecting', version: '', seq: 0 }
  closed = false
  entry(key: string) {
    let entry = this.entries.get(key)
    if (!entry) { entry = { key, state: { page: null, error: null, loading: false }, pages: 1, listeners: new Set(), token: 0, dirty: false, lastRefresh: 0 }; this.entries.set(key, entry) }
    return entry
  }
  /** Work-level positive knowledge only; unsettled/multipage windows mean unknown. */
  isWorkRead(workKey: string) {
    const current = (entry: AttentionEntry) => entry.pages === 1 && !entry.state.loading && !entry.state.error && !entry.timer && !entry.dirty
    const personal = this.entries.get(PERSONAL_QUERY)
    if (personal && !current(personal)) return false
    const item = personal?.state.page?.items.find(item => item.work_key === workKey)
    if (item) return !item.unread
    return [...this.entries.values()].some(entry => entry.listeners.size && current(entry) && entry.state.page?.items.some(item => item.work_key === workKey && !item.unread))
  }
  emit(entry?: AttentionEntry) { for (const listener of entry?.listeners ?? this.listeners) listener() }
  set(entry: AttentionEntry, next: Partial<ListState>) { entry.state = { ...entry.state, ...next }; this.emit(entry) }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  begin() { this.state = { ...this.state, seq: 0, freshness: 'connecting' }; this.emit() }
  status(freshness: string, error?: AttentionError) {
    this.state = { ...this.state, freshness }; this.emit()
    if (error) for (const entry of this.entries.values()) this.set(entry, { error })
  }
  deny() {
    this.state = { unread: 0, needsYou: 0, freshness: 'denied', version: '', seq: 0 }; this.emit()
    for (const entry of this.entries.values()) { clearTimeout(entry.timer); entry.timer = undefined; entry.request?.abort(); entry.token++; this.set(entry, { page: null, loading: false, error: 'denied' }) }
  }
  apply(frame: AgentAttentionStreamFrame, live = true): boolean {
    if (this.closed || live && frame.seq <= this.state.seq) return false
    if (live && frame.seq !== this.state.seq + 1) return false
    if (frame.type === 'attention.denied') { this.deny(); return true }
    const changed = frame.version !== this.state.version
    this.state = { unread: frame.unread_count, needsYou: frame.counts?.needs_you ?? frame.page?.counts.needs_you ?? this.state.needsYou,
      freshness: live ? 'live' : 'snapshot', version: frame.version, seq: live ? frame.seq : 0 }; this.emit()
    const personal = this.entry(PERSONAL_QUERY)
    if (!frame.page && frame.counts && personal.state.page) this.set(personal, { page: { ...personal.state.page, counts: frame.counts } })
    if (frame.page && !personal.listeners.size) {
      // Off-page pagination is disposable; keep the Shell window authoritative and
      // invalidate any older list response before replacing it with the stream page.
      clearTimeout(personal.timer); personal.timer = undefined; personal.request?.abort(); personal.token++
      personal.pages = 1; personal.dirty = false
      this.set(personal, { page: frame.page, loading: false, error: null })
    } else if (frame.page && personal.pages === 1 && !personal.state.loading) this.set(personal, { page: frame.page, error: null })
    else if ((frame.page || personal.state.error || changed && personal.pages > 1) && personal.listeners.size) this.invalidate(personal)
    if (changed || frame.type === 'attention.snapshot' || frame.type === 'attention.resync') for (const entry of this.entries.values()) if (entry.key !== PERSONAL_QUERY && entry.listeners.size) {
      if (frame.type === 'attention.snapshot' || frame.type === 'attention.resync') void this.refresh(entry)
      else this.invalidate(entry)
    }
    return true
  }
  /** Coalesced invalidation, never a periodic reader; explicit/reconnect reads bypass it. */
  invalidate(entry: AttentionEntry) {
    if (this.closed || entry.timer) return
    if (entry.state.loading) { entry.dirty = true; return }
    const remaining = Math.max(0, FILTER_REFRESH_MS - (Date.now() - entry.lastRefresh))
    if (!remaining) { void this.refresh(entry); return }
    entry.timer = setTimeout(() => { entry.timer = undefined; if (!this.closed && entry.listeners.size) void this.refresh(entry) }, remaining)
  }
  async refresh(entry: AttentionEntry, cursor?: string, explicit = false) {
    if (this.closed) return
    if (entry.state.loading && !explicit) { entry.dirty = true; return }
    clearTimeout(entry.timer); entry.timer = undefined; entry.lastRefresh = Date.now()
    entry.request?.abort()
    const request = new AbortController(); entry.request = request
    const token = ++entry.token
    this.set(entry, { loading: true, error: null })
    const current = () => !this.closed && !request.signal.aborted && token === entry.token
    try {
      const query = JSON.parse(entry.key)
      let next = await agentAttentionApi.list({ ...query, cursor }, { signal: request.signal })
      const items = [...next.items]; const seen = new Set(items.map(item => item.work_key)); let pages = 1
      while (current() && !cursor && pages < entry.pages && next.next_cursor) {
        next = await agentAttentionApi.list({ ...query, cursor: next.next_cursor }, { signal: request.signal })
        for (const item of next.items) if (!seen.has(item.work_key)) { seen.add(item.work_key); items.push(item) }
        pages++
      }
      if (!current()) return
      entry.pages = cursor ? entry.pages + 1 : pages
      this.set(entry, { page: { ...next, items: cursor && entry.state.page ? [...entry.state.page.items, ...items.filter(item => !entry.state.page!.items.some(old => old.work_key === item.work_key))] : items } })
    } catch (cause) {
      if (current()) { const error = failureKind(cause); this.set(entry, { error, ...(error === 'denied' ? { page: null } : {}) }) }
    } finally {
      if (current()) {
        this.set(entry, { loading: false })
        if (entry.dirty) { entry.dirty = false; this.invalidate(entry) }
      }
    }
  }
  update(workKey: string, state: AgentAttentionReadState) {
    for (const entry of this.entries.values()) if (entry.state.page) this.set(entry, { page: { ...entry.state.page, items: entry.state.page.items.map(item => {
      if (item.work_key !== workKey) return item
      // PATCH may finish after a newer source revision or reading decision has
      // already arrived through the stream. Neither may be replaced by it.
      const reads = item.read_states.map(old => sameReadingRevision(old.subject, state.subject)
        && old.state_version < state.state_version ? state : old)
      if (reads.every((read, index) => read === item.read_states[index])) return item
      return { ...item, read_states: reads, unread: reads.some(read => read.unread) || Boolean(item.runs_next_cursor && item.unread) }
    }) } })
  }
  close() { this.closed = true; for (const entry of this.entries.values()) { clearTimeout(entry.timer); entry.timer = undefined; entry.request?.abort(); entry.token++ }; for (const entry of this.entries.values()) entry.state = { page: null, error: null, loading: false }; this.listeners.clear(); this.state = { unread: 0, needsYou: 0, freshness: 'connecting', version: '', seq: 0 } }
}
