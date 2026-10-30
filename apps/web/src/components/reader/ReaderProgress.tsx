import { useEffect, useState, type RefObject } from 'react'
import { useAppTranslation } from '../../i18n'
import { Button } from '../ui/button'
import type { ReaderPositionState } from './useReaderPosition'

function useScrollFraction(shellRef: RefObject<HTMLElement | null>): number {
  const [fraction, setFraction] = useState(0)
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    let frame = 0
    const update = () => {
      frame = 0
      const max = shell.scrollHeight - shell.clientHeight
      setFraction(max > 4 ? Math.min(1, Math.max(0, shell.scrollTop / max)) : 1)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    shell.addEventListener('scroll', schedule, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(shell)
    return () => { if (frame) cancelAnimationFrame(frame); shell.removeEventListener('scroll', schedule); observer?.disconnect() }
  }, [shellRef])
  return fraction
}

/** A thin bar over the text: where the view is, and how far the person has read (furthest). */
export function ReaderProgressBar({ shellRef, furthest }: { shellRef: RefObject<HTMLElement | null>; furthest: number | null }) {
  const { t } = useAppTranslation()
  const fraction = useScrollFraction(shellRef)
  const percent = Math.round(fraction * 100)
  return <div className="reader-progress" role="progressbar" aria-label={t('reading.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    aria-valuetext={furthest != null ? t('reading.progressValueFurthest', { current: percent, furthest: Math.round(furthest * 100) }) : t('reading.progressValue', { current: percent })}>
    <div className="reader-progress-current" style={{ transform: `scaleX(${fraction})` }} />
    {furthest != null && furthest > 0 && <div className="reader-progress-furthest" style={{ left: `${furthest * 100}%` }} title={t('reading.progressFurthest', { furthest: Math.round(furthest * 100) })} />}
  </div>
}

/** What happened to the saved place when the document opened; offers the way back or a retry where it applies. */
export function ReaderRestoreNotice({ position, onDone }: { position: ReaderPositionState; onDone: () => void }) {
  const { t } = useAppTranslation()
  const { restore } = position
  if (!['relocated', 'approximate', 'skipped', 'lost', 'error'].includes(restore)) return null
  return <div role={restore === 'error' ? 'alert' : 'status'} className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs">
    <span className="min-w-0 flex-1">{t(`reading.restore_${restore}`)}</span>
    {restore === 'skipped' && <Button size="sm" variant="outline" onClick={() => { position.returnToOpened(); onDone() }}>{t('reading.returnToPosition')}</Button>}
    {restore === 'lost' && <Button size="sm" variant="outline" onClick={() => { position.jumpApproximately(); onDone() }}>{t('reading.jumpApproximately')}</Button>}
    {restore === 'error' && <Button size="sm" variant="outline" onClick={position.retryLoad}>{t('reading.retry')}</Button>}
    <Button size="sm" variant="ghost" onClick={onDone}>{t(restore === 'lost' ? 'reading.readFromStart' : 'reading.dismissNotice')}</Button>
  </div>
}

/** Whether the reading position reached the server; a failed save can be retried. */
export function ReaderSyncStatus({ position }: { position: ReaderPositionState }) {
  const { t } = useAppTranslation()
  if (position.sync !== 'error') return null
  return <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
    {t('reading.syncError')}
    <Button size="sm" variant="ghost" onClick={() => void position.retrySync()}>{t('reading.retry')}</Button>
  </span>
}

/** Progress panel: back to where the reading was left, and a deliberate reset of the furthest position. */
export function ReaderProgressPanel({ shellRef, position, close }: {
  shellRef: RefObject<HTMLElement | null>
  position: ReaderPositionState
  close: () => void
}) {
  const { t } = useAppTranslation()
  const fraction = useScrollFraction(shellRef)
  const { furthest, sync } = position
  const usable = sync !== 'denied' && position.restore !== 'unavailable'
  return <div className="w-full space-y-3 text-sm">
    <p>{t('reading.progressHere', { current: Math.round(fraction * 100) })}</p>
    <p className="text-muted-foreground">{furthest != null ? t('reading.progressFurthest', { furthest: Math.round(furthest * 100) }) : t('reading.progressNone')}</p>
    <p className="text-xs text-muted-foreground" role="status">{t(`reading.sync_${sync}`)}</p>
    {sync === 'error' && <Button size="sm" variant="outline" onClick={() => void position.retrySync()}>{t('reading.retry')}</Button>}
    <p className="text-xs text-muted-foreground">{t('reading.progressPrivate')}</p>
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" disabled={!usable || position.opened === null} onClick={() => { position.returnToOpened(); close() }}>{t('reading.returnToPosition')}</Button>
      <Button size="sm" variant="ghost" disabled={!usable} onClick={() => { void position.resetFurthest(); close() }}>{t('reading.resetProgress')}</Button>
      <p className="text-xs text-muted-foreground">{t('reading.resetProgressHint')}</p>
    </div>
  </div>
}
