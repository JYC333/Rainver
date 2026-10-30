import { ReaderDocumentTypeSchema } from "@rainver/protocol"
import { useEffect, useRef, useState } from 'react'
import { readerApi } from '../../api/client'
import { sessionEpoch } from '../../lib/sessionResidue'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import type { ReaderAnnotation, ReaderDocumentPayload } from '../../types/api'
import type { ReadOnlyTiptapReaderHandle, TextSelection } from '../editor/ReadOnlyTiptapReader'
import type { ReaderAnnotationAuthority } from './readerModel'
import { Button } from '../ui/button'

export function ReaderRangeEditor({ annotation, document, initial, reader, authority, live, onSaved, onCancel, onPendingChange }: {
  annotation: ReaderAnnotation; document: ReaderDocumentPayload; initial: TextSelection
  reader: ReadOnlyTiptapReaderHandle; authority?: ReaderAnnotationAuthority
  onPendingChange?: (pending: boolean) => void
  live: () => boolean; onSaved: (annotation: ReaderAnnotation) => void; onCancel: () => void
}) {
  const { t } = useAppTranslation()
  const [preview, setPreview] = useState(initial)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const sending = useRef(false)
  const owner = useRef<object | null>(null)
  useEffect(() => { const token = {}; owner.current = token; return () => { if (owner.current === token) owner.current = null } }, [])
  const range = preview.anchorDraft.tiptap_range!
  const change = (from: number, to: number) => {
    const selected = reader.rangeSelection(from, to, range)
    if (selected) { setPreview(selected); setError('') }
  }
  const save = async () => {
    if (sending.current || !live() || !owner.current) return
    const token = owner.current
    sending.current = true; setPending(true); onPendingChange?.(true); setError('')
    const epoch = sessionEpoch(), ticket = authority?.begin()
    const current = () => owner.current === token && live() && sessionEpoch() === epoch && (!ticket || authority?.accepts(ticket))
    try {
      const anchor = preview.anchorDraft
      const updated = await readerApi.updateAnnotationRange(annotation.id, {
        expected_quote_text: annotation.quote_text, expected_anchor_json: annotation.anchor_json,
        content_hash: document.content_hash, structure_hash: document.structure_hash!, quote_text: preview.quoteText,
        anchor_json: { ...anchor, schema_version: 1, normalizer: 'plain_text_v1', content_hash: document.content_hash,
          structure_hash: document.structure_hash!, document_ref: { document_type: ReaderDocumentTypeSchema.parse(document.document_type), document_id: document.document_id } },
      })
      if (current()) onSaved(updated)
    } catch (failure) { if (current()) setError(errMsg(failure)) }
    finally { if (owner.current === token) { sending.current = false; setPending(false); onPendingChange?.(false) } }
  }
  return <section aria-label={t('reading.adjustRange')} className="space-y-2 border-b border-border bg-muted/30 p-3">
    <p className="text-sm">{t('reading.rangeEditHint')}</p>
    <blockquote className="max-h-28 overflow-y-auto whitespace-pre-wrap text-sm">{preview.selectedText}</blockquote>
    <div className="flex items-center gap-2 text-sm">
      <span>{t('reading.rangeStart')}</span>
      <Button className="min-h-[44px] min-w-[44px]" size="icon-sm" variant="outline" disabled={pending || range.from === 0} aria-label={t('reading.rangeStartEarlier')} onClick={() => change(range.from - 1, range.to)}>−</Button>
      <input aria-label={t('reading.rangeStart')} className="min-h-[44px] min-w-0 flex-1" type="range" min={0} max={range.to - 1} step={1} value={range.from} disabled={pending} onChange={event => change(Number(event.target.value), range.to)} />
      <Button className="min-h-[44px] min-w-[44px]" size="icon-sm" variant="outline" disabled={pending || range.from >= range.to - 1} aria-label={t('reading.rangeStartLater')} onClick={() => change(range.from + 1, range.to)}>+</Button>
    </div>
    <div className="flex items-center gap-2 text-sm">
      <span>{t('reading.rangeEnd')}</span>
      <Button className="min-h-[44px] min-w-[44px]" size="icon-sm" variant="outline" disabled={pending || range.to <= range.from + 1} aria-label={t('reading.rangeEndEarlier')} onClick={() => change(range.from, range.to - 1)}>−</Button>
      <input aria-label={t('reading.rangeEnd')} className="min-h-[44px] min-w-0 flex-1" type="range" min={range.from + 1} max={reader.documentSize()} step={1} value={range.to} disabled={pending} onChange={event => change(range.from, Number(event.target.value))} />
      <Button className="min-h-[44px] min-w-[44px]" size="icon-sm" variant="outline" disabled={pending || range.to >= reader.documentSize()} aria-label={t('reading.rangeEndLater')} onClick={() => change(range.from, range.to + 1)}>+</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><Button className="min-h-[44px]" size="sm" disabled={pending} onClick={() => void save()}>{t('reading.saveRange')}</Button><Button className="min-h-[44px]" size="sm" variant="outline" disabled={pending} onClick={onCancel}>{t('reading.cancelRange')}</Button></div>
  </section>
}
