import { useRef, useState } from 'react'
import { sourcesApi } from '../../api/client'
import type { SourceItem } from '../../types/api'
import { useAppTranslation } from '../../i18n'
import { SpaceLink } from '../../core/spaceNav'
import { spacePath } from '../../core/navigation'
import { safeHttpUrl } from '../../lib/safeHttpUrl'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { readingHref } from './readingLinks'

/** Save once, then extract/retry the saved item through the canonical Sources jobs. */
export function SaveReadingUrlDialog({ spaceId, projectId, onClose }: { spaceId: string; projectId?: string; onClose: (changed: boolean) => void }) {
  const { t } = useAppTranslation()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [saved, setSaved] = useState<SourceItem | null>(null)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'extracting'>('idle')
  const [error, setError] = useState<unknown>(null)
  const locked = useRef(false)
  const busy = phase !== 'idle'
  const close = () => onClose(saved !== null)
  const ready = saved?.content_state === 'content_saved' || saved?.content_state === 'snapshot_saved'
  const materials = projectId ? `/projects/${projectId}/sources?view=all` : '/library/reading?view=all'

  async function save() {
    if (locked.current || !safeHttpUrl(url)) return
    locked.current = true; setError(null); setPhase(saved ? 'extracting' : 'saving')
    let row = saved
    const jobType = row?.content_state === 'content_queued' ? undefined : row ? 'extract_text' : 'manual_url'
    try {
      if (!row) {
        row = await sourcesApi.createManualUrl({ url: url.trim(), title: title.trim() || undefined, ...(projectId ? { project_id: projectId } : {}), queue_content: true }, { spaceId })
        setSaved(row)
      } else if (row.content_state !== 'content_queued') {
        row = await sourcesApi.itemAction(row.id, 'queue_content', { spaceId: row.space_id })
        setSaved(row)
      }
      setPhase('extracting')
      // The server may have already picked up the job. Never create another URL
      // or claim success when extraction is still pending or has failed.
      const options = { spaceId: row.space_id }
      const jobs = await sourcesApi.jobs({ source_item_id: row.id, job_type: jobType, status: 'pending', limit: 1 }, options)
      if (jobs.items[0]) {
        const result = await sourcesApi.runJob(jobs.items[0].id, options)
        if (result.status === 'failed') throw new Error(result.error_message ?? t('reading.startExtractionFailed'))
      }
      setSaved(await sourcesApi.getItem(row.id, options))
    } catch (failure) {
      setError(failure)
      if (row) {
        try { const latest = await sourcesApi.getItem(row.id, { spaceId: row.space_id }); if (latest) setSaved(latest) }
        catch { /* The successful save remains visible even when refresh also fails. */ }
      }
    }
    finally { locked.current = false; setPhase('idle') }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto" showClose={!busy}>
      <DialogHeader><DialogTitle>{t(saved ? 'reading.startArticleSaved' : 'reading.startSaveArticle')}</DialogTitle><DialogDescription>{t(projectId ? 'reading.startProjectSaveHint' : 'reading.startPersonalSaveHint')}</DialogDescription></DialogHeader>
      {!saved ? <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save() }}>
        <label className="block space-y-1 text-sm"><span>{t('reading.startArticleUrl')}</span><Input aria-label={t('reading.startArticleUrl')} type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/article" disabled={busy} /></label>
        <label className="block space-y-1 text-sm"><span>{t('reading.startArticleTitle')}</span><Input aria-label={t('reading.startArticleTitle')} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} /></label>
        {error != null && <p role="alert" className="break-words text-sm text-destructive">{errMsg(error)}</p>}
        <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={close}>{t('reading.startCancel')}</Button><Button type="submit" disabled={busy || !safeHttpUrl(url)}>{t(busy ? 'reading.startSaving' : 'reading.startSaveExtract')}</Button></DialogFooter>
      </form> : <div className="space-y-4">
        <p className="break-words text-sm font-medium">{saved.title}</p>
        <p role="status" className="text-sm text-muted-foreground">{t(busy ? 'reading.startExtracting' : ready ? 'reading.startArticleReady' : 'reading.startArticlePending')}</p>
        {error != null && <p role="alert" className="break-words text-sm text-destructive">{t('reading.startSavedButFailed')} {errMsg(error)}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}>{t('reading.startClose')}</Button>
          <Button variant="outline" asChild><SpaceLink onClick={close} to={spacePath(saved.space_id, materials)}>{t('reading.startViewMaterials')}</SpaceLink></Button>
          {ready ? <Button asChild><SpaceLink onClick={close} to={spacePath(saved.space_id, readingHref({ source_item_id: saved.id, reader_origin: projectId ? 'project' : 'library' }, projectId))}>{t('reading.open')}</SpaceLink></Button> : <Button disabled={busy} onClick={() => void save()}>{t(busy ? 'reading.startExtracting' : 'reading.startRetryExtract')}</Button>}
        </DialogFooter>
      </div>}
    </DialogContent>
  </Dialog>
}
