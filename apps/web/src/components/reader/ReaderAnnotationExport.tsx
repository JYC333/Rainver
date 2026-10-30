import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { readerApi } from '../../api/client'
import { sessionEpoch } from '../../lib/sessionResidue'
import { useAppTranslation } from '../../i18n'
import { Button } from '../ui/button'
import { activeAnnotationsInDocumentOrder, annotationBodyWithheld, type ReaderAnnotationAuthority } from './readerModel'

/** A fresh authorized list, never the Reader's cached text or comment threads. */
export function ReaderAnnotationExport({ documentType, documentId, authority }: {
  documentType: string; documentId: string; authority?: ReaderAnnotationAuthority
}) {
  const { t } = useAppTranslation()
  const [pending, setPending] = useState(false)
  const owner = useRef<object | null>(null)
  const scope = `${documentType}:${documentId}`
  const current = useRef(scope)
  current.current = scope
  const inFlight = useRef(false)
  useEffect(() => {
    const token = {}
    owner.current = token
    inFlight.current = false; setPending(false)
    return () => { if (owner.current === token) owner.current = null }
  }, [scope])
  const exportQuotes = async () => {
    if (inFlight.current || !owner.current) return
    const token = owner.current
    const epoch = sessionEpoch()
    const change = authority?.begin()
    const live = () => owner.current === token && current.current === scope && sessionEpoch() === epoch && (!change || authority?.accepts(change))
    inFlight.current = true; setPending(true)
    try {
      const response = await readerApi.listAnnotations(documentType, documentId)
      if (!live()) return
      const quotes = activeAnnotationsInDocumentOrder(response.items)
        .filter(item => item.document_type === documentType && item.document_id === documentId && !annotationBodyWithheld(item))
        .map(item => ({ type: item.annotation_type, quote: item.quote_text, label: item.label, color: item.color, created_at: item.created_at }))
      if (!quotes.length) { toast.message(t('reading.exportQuotesEmpty')); return }
      const blob = new Blob([JSON.stringify({ format: 'rainver-reader-quotes', version: 1, quotes }, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      try {
        const link = window.document.createElement('a')
        link.href = url; link.download = 'reader-quotes.json'
        window.document.body.appendChild(link)
        try { link.click() } finally { link.remove() }
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000) }
    } catch {
      if (live()) toast.error(t('reading.exportQuotesFailed'))
    } finally {
      if (owner.current === token) { inFlight.current = false; setPending(false) }
    }
  }
  return <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={t('reading.exportQuotes')} title={t('reading.exportQuotesHint')} onClick={() => void exportQuotes()}><Download className="size-4" /></Button>
}
