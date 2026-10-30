import { useEffect, useRef, useState } from 'react'
import type { ReaderDocumentNoteResponse } from '@rainver/protocol'
import { NotebookPen } from 'lucide-react'
import { readerApi } from '../../api/client'
import { sessionEpoch } from '../../lib/sessionResidue'
import { errMsg } from '../../lib/utils'
import { spacePath } from '../../core/navigation'
import { useAppTranslation } from '../../i18n'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

/** Reader only owns the private association; actual editing stays in Notes. */
export function ReaderDocumentNote({ spaceId, documentType, documentId }: { spaceId: string; documentType: string; documentId: string }) {
  const { t } = useAppTranslation()
  const scope = `${spaceId}:${documentType}:${documentId}`
  const current = useRef(scope); current.current = scope
  const owner = useRef<object | null>(null)
  const request = useRef(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ scope: string; value: ReaderDocumentNoteResponse } | null>(null)
  useEffect(() => {
    const token = {}; owner.current = token
    setOpen(false); setBusy(false); setResult(null); setError('')
    return () => { if (owner.current === token) owner.current = null }
  }, [scope])
  const load = async (create: boolean) => {
    if (!owner.current || current.current !== scope) return
    const token = owner.current, id = ++request.current, epoch = sessionEpoch()
    const live = () => owner.current === token && current.current === scope && request.current === id && sessionEpoch() === epoch
    setOpen(true); setBusy(true); setError(''); setResult(null)
    try {
      const value = create ? await readerApi.createDocumentNote(documentType, documentId, t('reading.documentNoteTitle')) : await readerApi.documentNote(documentType, documentId)
      if (live()) setResult({ scope, value })
    } catch (failure) { if (live()) setError(errMsg(failure)) }
    finally { if (owner.current === token && request.current === id) setBusy(false) }
  }
  const value = result?.scope === scope ? result.value : null
  return <>
    <Button size="icon-sm" variant="ghost" disabled={busy} aria-label={t('reading.documentNote')} title={t('reading.documentNote')} onClick={() => void load(false)}><NotebookPen className="size-4" /></Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto">
        <DialogTitle>{t('reading.documentNote')}</DialogTitle>
        <DialogDescription>{t('reading.documentNoteHint')}</DialogDescription>
        {busy && <p role="status">{t('reading.documentNoteLoading')}</p>}
        {error && <div role="alert" className="space-y-2"><p>{error}</p><Button className="min-h-[44px]" variant="outline" onClick={() => void load(false)}>{t('reading.retry')}</Button></div>}
        {!busy && !error && value?.note && <a className="inline-flex min-h-[44px] items-center rounded border border-border px-3 text-sm" href={spacePath(value.note.space_id, `/knowledge/notes/${encodeURIComponent(value.note.id)}`)}>{t('reading.openDocumentNote')}</a>}
        {!busy && !error && value && !value.note && <Button className="min-h-[44px]" onClick={() => void load(true)}>{t('reading.createDocumentNote')}</Button>}
      </DialogContent>
    </Dialog>
  </>
}
