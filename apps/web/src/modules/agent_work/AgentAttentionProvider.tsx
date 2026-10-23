import { createContext, useCallback, useContext, useEffect, useState, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import type { AgentAttentionNotice } from '@rainver/protocol'
import { AgentAttentionStreamFrameSchema } from '@rainver/protocol'
import { agentAttentionApi } from '../../api/client'
import { AttentionStore, failureKind, PERSONAL_QUERY } from './attentionStore'
import { AttentionDelivery } from './attentionDelivery'
import { shownVersion, ViewReporter } from './viewReports'
import { useAppTranslation } from '../../i18n'

type AttentionContext = { store: AttentionStore; delivery: AttentionDelivery | null; views: ViewReporter; sound: boolean; desktop: boolean
  /** Sound is on but this delivery tab needs a user gesture before it can play. */
  soundPending: boolean
  /** Alert delivery failed or permission was refused; separate from data freshness. */
  deliveryLimited: boolean
  enableSound: () => Promise<void>; enableDesktop: () => Promise<void> }
const Context = createContext<AttentionContext | null>(null)
/** The explicit open whose manual decision may pause the conversation surfaces below it. */
const ViewingGroup = createContext<object | undefined>(undefined)
export const AttentionViewingGroup = ViewingGroup.Provider
export const useOptionalAttention = () => useContext(Context)
export function useAttention() { const value = useContext(Context); if (!value) throw new Error('AgentAttentionProvider is required'); return value }
export const RECONNECT_BASE_MS = 5000
export const RECONNECT_MAX_MS = 60_000
/** Capped exponential backoff with equal jitter, so failed tabs do not retry in lockstep. */
export function reconnectDelay(failures: number, random: () => number = Math.random) {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** failures)
  return Math.round(ceiling / 2 + random() * ceiling / 2)
}
export function AgentAttentionProvider({ userId, children }: { userId: string; children: ReactNode }) {
  return <AccountAttention key={userId} userId={userId}>{children}</AccountAttention>
}
function AccountAttention({ userId, children }: { userId: string; children: ReactNode }) {
  const [store] = useState(() => new AttentionStore())
  const [views] = useState(() => new ViewReporter((body, signal) => agentAttentionApi.recordViews(body, { signal })))
  const [delivery, setDelivery] = useState<AttentionDelivery | null>(null)
  const [, render] = useState(0)
  const [deliveryLimited, setDeliveryLimited] = useState(false)
  const audio = useRef<AudioContext | null>(null)
  const { t } = useAppTranslation()
  const navigate = useNavigate()
  const display = useRef({ t, navigate }); display.current = { t, navigate }
  useEffect(() => {
    store.closed = false
    views.start()
    for (const entry of store.entries.values()) if (entry.key !== PERSONAL_QUERY && entry.listeners.size && !entry.state.page && !entry.state.loading) void store.refresh(entry)
    let alive = true
    let connection: AbortController | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const coordinator = new AttentionDelivery(userId, () => { if (alive) render(value => value + 1) })
    setDelivery(coordinator)
    const notifications = new Set<Notification>()
    const showToast = (notice: AgentAttentionNotice) => {
      const { t, navigate } = display.current
      toast(t(`agent_work.alerts.${notice.kind}`), { action: { label: t('agent_work.title'), onClick: () => navigate('/agent-work') } })
      coordinator.toasted(notice.key)
    }
    const deliver = (notice: AgentAttentionNotice) => {
      if (coordinator.acceptToast(notice)) showToast(notice)
      const canNotify = coordinator.preferences.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted'
      const sound = audio.current
      const canSound = coordinator.preferences.sound && sound?.state === 'running'
      if ((!canNotify && !canSound) || !coordinator.acceptExternal(notice)) return
      const { t, navigate } = display.current
      const title = t(`agent_work.alerts.${notice.kind}`)
      if (canNotify) {
        try { const notification = new Notification(title, { tag: notice.key }); notifications.add(notification); notification.onclose = () => notifications.delete(notification); notification.onclick = () => { window.focus(); navigate('/agent-work'); notification.close() } } catch { setDeliveryLimited(true) }
      }
      if (canSound && sound) {
        try {
          const oscillator = sound.createOscillator(); const gain = sound.createGain()
          gain.gain.value = 0.06; oscillator.connect(gain); gain.connect(sound.destination)
          oscillator.start(); oscillator.stop(sound.currentTime + 0.15)
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
        } catch { setDeliveryLimited(true) }
      }
    }
    const connect = async () => {
      if (!alive) return
      connection?.abort(); const request = new AbortController(); connection = request
      store.begin()
      try {
        // Resolves only when aborted; a server disconnect rejects.
        await agentAttentionApi.stream(frame => {
          if (!alive || request.signal.aborted) return
          if (!store.apply(frame)) { if (frame.seq > store.state.seq) throw new Error('Attention resync required'); return }
          failures = 0
          if (frame.type === 'attention.denied') { coordinator.clearPending(); request.abort(); return }
          if (frame.type === 'attention.snapshot' || frame.type === 'attention.resync') coordinator.clearPending()
          if (frame.type === 'attention.invalidation') frame.notices.forEach(deliver)
        }, { signal: request.signal })
      } catch (cause) {
        if (!alive || request.signal.aborted) return
        if (failureKind(cause) === 'denied') { coordinator.clearPending(); store.deny(); return }
        store.status('stale', failureKind(cause))
        try {
          const snapshot = AgentAttentionStreamFrameSchema.parse(await agentAttentionApi.snapshot({ signal: request.signal }))
          if (alive && !request.signal.aborted) { coordinator.clearPending(); store.apply(snapshot, false) }
        } catch (error) { if (alive && !request.signal.aborted && failureKind(error) === 'denied') { coordinator.clearPending(); store.deny(); return } }
        if (alive && !request.signal.aborted) retry = setTimeout(() => { void connect() }, reconnectDelay(failures++))
      }
    }
    const online = () => { views.resume(); clearTimeout(retry); void store.refresh(store.entry(PERSONAL_QUERY), undefined, true); void connect() }
    const offline = () => { connection?.abort(); clearTimeout(retry); store.status('offline', 'offline') }
    const visible = () => {
      if (document.visibilityState === 'visible') {
        views.resume()
        coordinator.flushToasts(notice => !store.isWorkRead(notice.work_key)).forEach(showToast)
        if (store.state.freshness !== 'live') { clearTimeout(retry); void connect() }
      }
    }
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    document.addEventListener('visibilitychange', visible)
    void connect()
    return () => {
      alive = false; for (const notification of notifications) notification.close(); connection?.abort(); clearTimeout(retry); coordinator.close(); views.close(); store.close()
      window.removeEventListener('online', online); window.removeEventListener('offline', offline); document.removeEventListener('visibilitychange', visible)
      void audio.current?.close().catch(() => {}); audio.current = null
    }
  }, [store, views, userId])
  // Every same-account tab shows the shared choice; only the delivery tab changes or uses it.
  const coordinated = Boolean(delivery?.supported)
  const ready = coordinated && Boolean(delivery?.leader)
  const sound = coordinated && Boolean(delivery?.preferences.sound)
  const desktop = coordinated && Boolean(delivery?.preferences.desktop) && typeof Notification !== 'undefined' && Notification.permission === 'granted'
  const soundPending = ready && sound && audio.current?.state !== 'running'
  /** Browsers start audio only from a user gesture in this tab. */
  const startAudio = useCallback(async () => {
    const context = audio.current ?? new AudioContext()
    await context.resume()
    if (store.closed) { await context.close(); return false }
    audio.current = context; render(value => value + 1)
    return true
  }, [store])
  // A delivery tab that inherited "sound on" arms itself on its next gesture.
  useEffect(() => {
    if (!soundPending) return
    let active = true
    const stop = () => { window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true) }
    const unlock = () => { stop(); void startAudio().catch(() => { if (active) setDeliveryLimited(true) }) }
    window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true)
    return () => { active = false; stop() }
  }, [soundPending, startAudio])
  const enableSound = async () => {
    if (!delivery || !ready) return
    if (sound) { delivery.setPreferences({ ...delivery.preferences, sound: false }); return }
    try { if (await startAudio()) { delivery.setPreferences({ ...delivery.preferences, sound: true }); setDeliveryLimited(false) } }
    catch { setDeliveryLimited(true) }
  }
  const enableDesktop = async () => {
    if (!delivery || !ready || typeof Notification === 'undefined') { setDeliveryLimited(true); return }
    if (desktop) { delivery.setPreferences({ ...delivery.preferences, desktop: false }); return }
    try {
      const allowed = await Notification.requestPermission(); if (store.closed) return
      delivery.setPreferences({ ...delivery.preferences, desktop: allowed === 'granted' }); setDeliveryLimited(allowed !== 'granted')
    } catch { setDeliveryLimited(true) }
  }
  return <Context.Provider value={{ store, delivery, views, sound, desktop, soundPending, deliveryLimited, enableSound, enableDesktop }}>{children}</Context.Provider>
}
export function useAttentionState() {
  const { store } = useAttention()
  return useSyncExternalStore(store.subscribe, () => store.state)
}

/** One message a conversation surface displays, with the body it shows. */
export type DisplayedMessage = { id: string; content: string; awaitingAnswer?: boolean | null }
const ENTRY = '\u0001', SEPARATOR = '\u0002'

/**
 * A mounted conversation surface, wherever it is in the product. The messages
 * it reports as displayed are what the person has seen; the server records the
 * reads. A reply updated in place (same id, new body) is a new view of it.
 * The surface never learns revisions or work identities or suppresses alerts.
 */
export function useAttentionViewing(spaceId: string | undefined, sessionId: string | null | undefined, displayed?: { messages: DisplayedMessage[]; ready: boolean }) {
  const context = useOptionalAttention()
  const views = context?.views
  const group = useContext(ViewingGroup)
  // Each mounted surface registers separately; two surfaces of one Session report their union.
  const [surface] = useState(() => ({}))
  useEffect(() => {
    if (!views || !spaceId || !sessionId) return
    return () => views.left(surface, spaceId, sessionId)
  }, [views, spaceId, sessionId, surface])
  // Fingerprint each body once; an unchanged string is not rehashed on rerender.
  const fingerprints = useRef(new Map<string, { content: string; awaiting: boolean; shown: string }>())
  const shown = displayed?.ready ? displayed.messages.map(message => {
    const awaiting = message.awaitingAnswer === true
    const cached = fingerprints.current.get(message.id)
    if (cached && cached.content === message.content && cached.awaiting === awaiting) return `${message.id}${ENTRY}${cached.shown}`
    const next = { content: message.content, awaiting, shown: shownVersion(message.content, awaiting) }
    fingerprints.current.set(message.id, next)
    return `${message.id}${ENTRY}${next.shown}`
  }).join(SEPARATOR) : ''
  useEffect(() => {
    if (!views || !spaceId || !sessionId || !shown) return
    views.displayed(surface, spaceId, sessionId, shown.split(SEPARATOR).map(entry => {
      const [id = '', version = ''] = entry.split(ENTRY)
      return { id, shown: version }
    }), group)
  }, [views, spaceId, sessionId, shown, surface, group])
}
