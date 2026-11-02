import { useEffect, useRef, useState } from 'react'
import type { ReaderSourceVersions } from '@rainver/protocol'
import { History } from 'lucide-react'
import { readerApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { formatDateParts } from '../../i18n/format'
import { sessionEpoch } from '../../lib/sessionResidue'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'

export function ReaderVersionHistory({ itemId, onChoose, onDenied }: { itemId: string; onChoose: (snapshotId: string | null) => void; onDenied: (error: unknown) => void }) {
  const { t } = useAppTranslation()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<ReaderSourceVersions | null>(null)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const denied = useRef(onDenied); denied.current = onDenied
  useEffect(() => {
    if (!open) return
    let live = true; const epoch = sessionEpoch()
    setBusy(true); setError(null)
    if (!offset) setPage(null)
    readerApi.sourceVersions(itemId, offset).then(value => {
      if (live && epoch === sessionEpoch()) setPage(previous => ({ ...value, items: offset ? [...(previous?.items ?? []), ...value.items] : value.items }))
    }).catch(reason => {
      if (!live || epoch !== sessionEpoch()) return
      setError(reason)
      if ([401, 403, 404].includes(reason?.status)) { setPage(null); denied.current(reason) }
    }).finally(() => { if (live && epoch === sessionEpoch()) setBusy(false) })
    return () => { live = false }
  }, [open, itemId, offset, retry])
  const choose = (id: string | null) => { setOpen(false); onChoose(id) }
  return <>
    <Button variant="ghost" size="icon-sm" title={t('reading.versionHistory')} aria-label={t('reading.versionHistory')} onClick={() => { setOffset(0); setOpen(true) }}><History className="size-4" /></Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('reading.versionHistory')}</DialogTitle><DialogDescription>{t('reading.versionHistoryHint')}</DialogDescription></DialogHeader>
        <Button size="sm" variant="outline" onClick={() => choose(null)}>{t('reading.latestVersion')}</Button>
        {error ? <div role="alert" className="mt-3 space-y-2 text-sm"><p>{errMsg(error)}</p><Button size="sm" variant="outline" onClick={() => setRetry(value => value + 1)}>{t('reading.retry')}</Button></div> : null}
        {page && <ul className="mt-3 divide-y divide-border">{page.items.map(version => <li key={version.snapshot_id}>
          <Button className="my-1 h-auto w-full justify-between gap-3 whitespace-normal py-3 text-left" variant="ghost" onClick={() => choose(version.is_current ? null : version.snapshot_id)}>
            <time dateTime={version.captured_at}>{formatDateParts(version.captured_at, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>
            {version.is_current && <span className="shrink-0 text-xs text-muted-foreground">{t('reading.currentVersion')}</span>}
          </Button>
        </li>)}</ul>}
        {!busy && !error && page?.items.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t('reading.noRetainedVersions')}</p>}
        {busy && <p role="status" className="mt-3 text-sm text-muted-foreground">{t('reading.loadingVersions')}</p>}
        {page?.next_offset !== null && page?.next_offset !== undefined && !error && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOffset(page.next_offset!)}>{t('reading.moreVersions')}</Button>}
      </DialogContent>
    </Dialog>
  </>
}
