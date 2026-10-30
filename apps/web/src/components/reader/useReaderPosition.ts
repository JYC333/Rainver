import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import type { ReaderPosition, ReaderPositionMark } from '@rainver/protocol'
import { readerApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { registerInMemoryResidue, sessionEpoch } from '../../lib/sessionResidue'
import type { ReadOnlyTiptapReaderHandle } from '../editor/ReadOnlyTiptapReader'
import { isReaderAccessError } from './useReaderAnnotations'

/** A report is sent once scrolling has stopped this long. */
export const POSITION_IDLE_MS = 1500
/** Staying this long at a place counts as reading it (moves the furthest position). */
export const POSITION_DWELL_MS = 5000
/** Layout changes this soon after a restore (images, late fonts) move the view back to the place. */
const SETTLE_MS = 4000

export type RestoreState =
  | 'loading'
  /** Nothing saved, or saved at the very start. */
  | 'none'
  /** Back at the saved place in this version. */
  | 'restored'
  /** The document changed; the saved text was found again. */
  | 'relocated'
  /** Same version, the saved place could not be resolved: placed at the same fraction. */
  | 'approximate'
  /** The document changed and the saved text is not (or not uniquely) in it: nothing moved; the person chooses. */
  | 'lost'
  /** The person started moving before the saved place arrived; they were not moved. */
  | 'skipped'
  /** The position could not be loaded (not a refusal); it can be retried, and nothing is saved meanwhile. */
  | 'error'
  /** No access to the position (refused, or the session ended): nothing is shown or saved. */
  | 'unavailable'

/** Whether the last place reached the server. A keepalive send on leaving is best effort and not reported. */
export type PositionSync = 'idle' | 'saving' | 'saved' | 'error' | 'denied'

interface PositionDocument {
  space_id: string
  document_type: string
  document_id: string
  content_hash: string
  structure_hash?: string
}

/**
 * One measured place, with everything that says where it belongs: the
 * document, its version and the session it was measured in. Sending uses only
 * this, never what the Reader shows by the time the request goes out.
 */
interface Measured {
  spaceId: string
  type: string
  id: string
  content_hash: string
  structure_hash: string
  epoch: number
  mark: ReaderPositionMark
  at: string
}

type SendResult = 'accepted' | 'not_accepted' | 'failed' | 'denied' | 'skipped'

function clamp(value: number): number { return Math.max(0, Math.min(1, value)) }

/**
 * The person's private reading position in the document shown: restored when
 * it opens, saved while they read and when they leave. "Current" is where they
 * are; "furthest" is how far they have read and only grows when they stay at
 * a place (see POSITION_DWELL_MS), so scrolling to the end and back does not
 * mark a document as read through. Neither touches read status.
 *
 * Ordering is the server's (see ReaderPositionWriteSchema): reports on another
 * version are not applied, and every stored change has a revision; this hook
 * shows only the highest revision it has been told about, so replies arriving
 * out of order cannot roll the display back. A refusal (401/403/404) or the end
 * of the session clears what is shown, ends the actions and makes every reply
 * still in flight change nothing. Nothing is reported until the restore has
 * been decided, so opening a document never saves "the top" over the place
 * the person left it.
 */
export function useReaderPosition({ document, readerRef, shellRef, enabled = true }: {
  document: PositionDocument
  /** False while the document has no readable text (metadata only, not prepared, failed): no place to keep, load or show. */
  enabled?: boolean
  readerRef: RefObject<ReadOnlyTiptapReaderHandle | null>
  shellRef: RefObject<HTMLElement | null>
}) {
  const { t } = useAppTranslation()
  const structureHash = document.structure_hash || document.content_hash
  const key = `${document.space_id}:${document.document_type}:${document.document_id}`
  const versionKey = `${document.content_hash}|${structureHash}`
  const [attempt, setAttempt] = useState(0)
  const [restore, setRestore] = useState<RestoreState>('loading')
  const [sync, setSync] = useState<PositionSync>('idle')
  // Where the person was when this document opened, for "back to where I was".
  const [opened, setOpened] = useState<ReaderPosition | null>(null)
  const [furthest, setFurthest] = useState<number | null>(null)
  // The run serving the document shown; null once it ended or lost access.
  const api = useRef<{
    measure: () => Measured | null
    send: (measured: Measured, dwelled: boolean, options?: { keepalive?: boolean; reset?: boolean }) => Promise<SendResult>
    jump: (mark: ReaderPositionMark, saved: ReaderPosition | null, approximate?: boolean) => RestoreState
    retrySync: () => Promise<{ result: SendResult; reset: boolean } | null>
  } | null>(null)

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    if (!enabled) {
      api.current = null
      setRestore('none'); setSync('idle'); setOpened(null); setFurthest(null)
      return
    }
    const epoch = sessionEpoch()
    const ident = { spaceId: document.space_id, type: document.document_type, id: document.document_id, content_hash: document.content_hash, structure_hash: structureHash }
    let alive = true
    let revoked = false
    let decided = false
    let userMoved = false
    let lastSent = ''
    let confirmed = -1
    let latest: Measured | null = null
    // The whole write that failed (measurement, its time, dwell and reset), retried as it was.
    let unsynced: { measured: Measured; dwelled: boolean; reset: boolean } | null = null
    let idle = 0, dwell = 0, settleUntil = 0, lastMeasure = 0
    let settleObserver: ResizeObserver | null = null
    let layoutObserver: ResizeObserver | null = null
    let layoutWidth = shell.clientWidth
    let layoutMark: ReaderPositionMark | null = null
    let layoutFrame = 0
    setRestore('loading'); setSync('idle'); setOpened(null); setFurthest(null)

    /** Replies count only for this run, under its session and while access holds. */
    const valid = () => alive && !revoked && sessionEpoch() === epoch
    const revoke = () => {
      if (revoked) return
      revoked = true
      api.current = null
      settleObserver?.disconnect(); layoutObserver?.disconnect()
      if (layoutFrame) cancelAnimationFrame(layoutFrame)
      window.clearTimeout(idle); window.clearTimeout(dwell)
      latest = null; unsynced = null
      if (alive) { setOpened(null); setFurthest(null); setRestore('unavailable'); setSync('denied') }
    }
    // Logout, a 401 or another tab's logout: the saved place goes, and nothing more is sent.
    const unregister = registerInMemoryResidue(revoke)
    /** Shows a stored position only if it is newer than anything shown already. */
    const confirm = (position: ReaderPosition | null) => {
      if (!position || position.revision <= confirmed) return
      confirmed = position.revision
      setFurthest(position.furthest?.progress ?? null)
    }

    const measure = (): Measured | null => {
      if (!shell.isConnected || revoked) return null
      const anchor = readerRef.current?.readingAnchor(shell)
      if (!anchor) return null
      const max = shell.scrollHeight - shell.clientHeight
      return { ...ident, epoch, mark: { anchor, progress: max > 4 ? clamp(shell.scrollTop / max) : 1 }, at: new Date().toISOString() }
    }
    const send = async (measured: Measured, dwelled: boolean, options: { keepalive?: boolean; reset?: boolean } = {}): Promise<SendResult> => {
      // A place from another session is never sent with this one's credentials.
      if (revoked || measured.epoch !== sessionEpoch()) return 'skipped'
      const body = { content_hash: measured.content_hash, structure_hash: measured.structure_hash, current: measured.mark, dwelled, reset_furthest: options.reset ?? false, client_at: measured.at }
      const signature = JSON.stringify([measured.id, body.content_hash, body.structure_hash, measured.mark.anchor.pm_pos, Math.round(measured.mark.progress * 1000), dwelled])
      if (!options.reset && signature === lastSent) return 'accepted'
      lastSent = signature
      if (alive && !options.keepalive) setSync('saving')
      try {
        const result = await readerApi.putPosition(measured.spaceId, measured.type, measured.id, body, { keepalive: options.keepalive })
        if (!valid()) return 'skipped'
        confirm(result.position)
        if (unsynced?.measured === measured) unsynced = null
        // A failed reset still waiting for its retry keeps the state visible.
        if (!options.keepalive) setSync(unsynced ? 'error' : 'saved')
        return result.accepted ? 'accepted' : 'not_accepted'
      } catch (error) {
        if (!valid()) return 'skipped'
        if (isReaderAccessError(error)) { revoke(); return 'denied' }
        // An ordinary failure keeps the place for the next chance or an explicit retry.
        lastSent = ''
        if (!options.keepalive) {
          // A failed reset is not replaced by a later ordinary failure: the reset is what the person asked for.
          if (!unsynced?.reset || options.reset) unsynced = { measured, dwelled, reset: options.reset ?? false }
          setSync('error')
        }
        return 'failed'
      }
    }
    const retrySync = async () => {
      const pending = unsynced
      if (!pending) return null
      return { result: await send(pending.measured, pending.dwelled, { reset: pending.reset }), reset: pending.reset }
    }
    const jump = (mark: ReaderPositionMark, saved: ReaderPosition | null, approximate = false): RestoreState => {
      const reader = readerRef.current
      const sameVersion = !saved || (saved.content_hash === ident.content_hash && saved.structure_hash === ident.structure_hash)
      const located = reader?.locate(mark.anchor, sameVersion)
      if (reader && located) { reader.scrollToPos(located.pos, shell); return sameVersion ? 'restored' : 'relocated' }
      // A fraction is a layout aid within one version; across versions it would land on unrelated text, so only on request.
      if (!sameVersion && !approximate) return 'lost'
      shell.scrollTop = mark.progress * Math.max(0, shell.scrollHeight - shell.clientHeight)
      return 'approximate'
    }
    api.current = { measure, send, jump, retrySync }

    const moved = () => { userMoved = true; settleUntil = 0 }
    const onKey = (event: KeyboardEvent) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) moved() }
    shell.addEventListener('wheel', moved, { passive: true })
    shell.addEventListener('touchmove', moved, { passive: true })
    shell.addEventListener('pointerdown', moved)
    window.addEventListener('keydown', onKey)

    const onScroll = () => {
      if (!decided || !valid()) return
      // Keep a text anchor before a width reflow, not the same pixel offset
      // afterwards. A resize-generated scroll must not overwrite that anchor.
      if (!layoutFrame && shell.clientWidth === layoutWidth) layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0
        if (valid() && shell.clientWidth === layoutWidth) layoutMark = measure()?.mark ?? layoutMark
      })
      const now = Date.now()
      if (now - lastMeasure > 300) { lastMeasure = now; latest = measure() ?? latest }
      window.clearTimeout(idle); window.clearTimeout(dwell)
      idle = window.setTimeout(() => {
        latest = measure() ?? latest
        if (!latest) return
        void send(latest, false)
        dwell = window.setTimeout(() => { const still = measure(); if (still) { latest = still; void send(still, true) } }, POSITION_DWELL_MS - POSITION_IDLE_MS)
      }, POSITION_IDLE_MS)
    }
    shell.addEventListener('scroll', onScroll, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      layoutObserver = new ResizeObserver(() => {
        const width = shell.clientWidth
        if (width === layoutWidth) return
        layoutWidth = width
        const mark = layoutMark ?? latest?.mark
        if (!valid() || !decided || !mark) return
        window.clearTimeout(idle); window.clearTimeout(dwell)
        // This effect belongs to exactly one document structure. Its PM
        // position is exact across wrapping/rotation, unlike a percentage.
        readerRef.current?.scrollToPos(mark.anchor.pm_pos, shell)
        latest = measure() ?? latest
        layoutMark = latest?.mark ?? mark
      })
      layoutObserver.observe(shell)
    }

    // Leaving: the last place goes in a request the browser may finish after the page is gone (best effort).
    const leave = () => {
      if (!decided || !valid()) return
      const measured = measure() ?? latest
      if (measured) void send(measured, false, { keepalive: true })
    }
    const onVisibility = () => { if (window.document.visibilityState === 'hidden') leave() }
    window.addEventListener('pagehide', leave)
    window.document.addEventListener('visibilitychange', onVisibility)

    // Images and fonts that load after the jump move the text; follow the place until the person moves.
    const follow = (mark: ReaderPositionMark, saved: ReaderPosition) => {
      const surface = shell.querySelector('.reader-surface')
      if (!surface || typeof ResizeObserver === 'undefined') return
      settleUntil = Date.now() + SETTLE_MS
      settleObserver = new ResizeObserver(() => {
        if (!valid() || userMoved || Date.now() > settleUntil) { settleObserver?.disconnect(); return }
        jump(mark, saved)
      })
      settleObserver.observe(surface)
    }

    readerApi.getPosition(ident.spaceId, ident.type, ident.id).then(async result => {
      if (!valid()) return
      const saved = result.position
      confirm(saved)
      setOpened(saved)
      if (!saved || (saved.current.progress === 0 && saved.current.anchor.text_offset === 0)) { decided = true; setRestore('none'); return }
      // Fonts change line breaks; jump once they are in.
      await Promise.race([window.document.fonts?.ready ?? Promise.resolve(), new Promise(resolve => window.setTimeout(resolve, 1000))])
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
      if (!valid()) return
      decided = true
      if (userMoved) { setRestore('skipped'); return }
      const placed = jump(saved.current, saved)
      setRestore(placed)
      if (placed !== 'lost') follow(saved.current, saved)
    }).catch(error => {
      if (!valid()) return
      // Refused: as revoked. Failed: reading goes on, nothing is saved until the position is loaded.
      if (isReaderAccessError(error)) revoke(); else setRestore('error')
    })

    return () => {
      // The DOM may already show the next document or version: send what was measured here, as it was measured.
      if (decided && !revoked && latest) void send(latest, false, { keepalive: true })
      alive = false
      if (api.current?.measure === measure) api.current = null
      unregister()
      window.clearTimeout(idle); window.clearTimeout(dwell)
      settleObserver?.disconnect(); layoutObserver?.disconnect()
      if (layoutFrame) cancelAnimationFrame(layoutFrame)
      shell.removeEventListener('wheel', moved); shell.removeEventListener('touchmove', moved); shell.removeEventListener('pointerdown', moved)
      shell.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', onKey); window.removeEventListener('pagehide', leave)
      window.document.removeEventListener('visibilitychange', onVisibility)
    }
    // One run per document version and attempt; callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, versionKey, attempt, enabled])

  /** Back to where the person was when the document opened. */
  const returnToOpened = useCallback(() => {
    if (opened && api.current) setRestore(api.current.jump(opened.current, opened))
  }, [opened])

  /** After a version change left the place unlocated: the same fraction of the new text, on purpose. */
  const jumpApproximately = useCallback(() => {
    if (opened && api.current) setRestore(api.current.jump(opened.current, opened, true))
  }, [opened])

  /** Makes the place shown now the reading progress (also backwards), on purpose. */
  const resetFurthest = useCallback(async () => {
    const run = api.current
    const measured = run?.measure()
    if (!run || !measured) return
    const result = await run.send(measured, false, { reset: true })
    if (result === 'accepted') toast.success(t('reading.progressReset'))
    else if (result === 'not_accepted') toast.error(t('reading.progressResetNotAccepted'))
    else if (result === 'failed') toast.error(t('reading.progressResetFailed'))
  }, [t])

  /** Retries the failed write as it was; a retried reset reports its outcome like the reset itself. */
  const retrySync = useCallback(async () => {
    const retried = await api.current?.retrySync()
    if (!retried?.reset) return
    if (retried.result === 'accepted') toast.success(t('reading.progressReset'))
    else if (retried.result === 'not_accepted') toast.error(t('reading.progressResetNotAccepted'))
    else if (retried.result === 'failed') toast.error(t('reading.progressResetFailed'))
  }, [t])
  const retryLoad = useCallback(() => setAttempt(value => value + 1), [])

  return { restore, sync, opened, furthest, returnToOpened, jumpApproximately, resetFurthest, retrySync, retryLoad }
}

export type ReaderPositionState = ReturnType<typeof useReaderPosition>
