import { readingReturnTo } from './readingLinks'
import { useAppTranslation } from '../../i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, FileText, PanelRight, RefreshCw } from 'lucide-react'
import { readerApi, sourcesApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { ExtractionJob, ReaderAnnotation, ReaderDocumentPayload, SourcePostProcessingBriefingDetail, SourcePostProcessingItemRelevance } from '../../types/api'
import { ReaderWorkspace } from '../../components/reader/ReaderWorkspace'
import { runPendingItemJob } from '../sources/sourceActions'
import { textExtractionDisabledReason } from '../sources/sourcePageModel'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { Button } from '../../components/ui/button'
import { SafeExternalLink } from '../../components/SafeExternalLink'
import { safeHttpUrl } from '../../lib/safeHttpUrl'

const RELEVANCE_ORDER: SourcePostProcessingItemRelevance[] = ['relevant', 'maybe', 'not_relevant']
function orderedItemIds(briefing: SourcePostProcessingBriefingDetail): string[] {
  const seen = new Set<string>(); const ids: string[] = []
  for (const relevance of RELEVANCE_ORDER) for (const item of briefing.item_decisions) {
    if (item.relevance === relevance && !seen.has(item.source_item_id)) { seen.add(item.source_item_id); ids.push(item.source_item_id) }
  }
  return ids
}

export default function LibraryItemReaderPage() {
  const { t } = useAppTranslation()
  const { itemId = '', connectionId, date } = useParams<{ itemId: string; connectionId?: string; date?: string }>()
  const [searchParams] = useSearchParams()
  // Reached from the digest's serendipity section: the open is reading, not interest evidence.
  const readOrigin = searchParams.get('from') === 'project' ? 'project' as const : searchParams.get('from') === 'serendipity' ? 'serendipity' as const : undefined
  const { activeSpaceId } = useSpace()
  const [briefing, setBriefing] = useState<SourcePostProcessingBriefingDetail | null>(null)
  const [document, setDocument] = useState<ReaderDocumentPayload | null>(null)
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>([])
  const [failedJob, setFailedJob] = useState<ExtractionJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [reextracting, setReextracting] = useState(false)
  // Prev/next stay clickable while an extraction runs, and the route then
  // re-renders this same instance for another item; the result that comes
  // back belongs to the item the reader has left.
  const currentItemId = useRef(itemId)
  currentItemId.current = itemId

  useEffect(() => {
    if (!connectionId || !date) return setBriefing(null)
    let cancelled = false; setBriefing(null)
    sourcesApi.briefing(connectionId, date).then(value => { if (!cancelled) setBriefing(value) }).catch(() => { if (!cancelled) setBriefing(null) })
    return () => { cancelled = true }
  }, [connectionId, date])

  useEffect(() => {
    if (!itemId || !activeSpaceId) { setDocument(null); setAnnotations([]); setLoading(false); return }
    let cancelled = false; setLoading(true); setDocument(null); setAnnotations([]); setFailedJob(null)
    Promise.all([
      readerApi.getDocument('source_item', itemId, { origin: readOrigin }), readerApi.listAnnotations('source_item', itemId),
      sourcesApi.jobs({ source_item_id: itemId, job_type: 'extract_text', limit: 1 }).catch(() => ({ items: [] as ExtractionJob[] })),
    ]).then(([doc, result, jobs]) => { if (!cancelled) { setDocument(doc); setAnnotations(result.items); setFailedJob(jobs.items[0]?.status === 'failed' ? jobs.items[0] : null) } })
      .catch(error => { if (!cancelled) { if (!isNotFoundError(error)) toast.error(errMsg(error)); setDocument(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [activeSpaceId, itemId, readOrigin])

  const ids = useMemo(() => briefing ? orderedItemIds(briefing) : [], [briefing]); const index = ids.indexOf(itemId)
  const previous = index > 0 ? ids[index - 1] : null; const next = index >= 0 && index < ids.length - 1 ? ids[index + 1] : null
  const dayScoped = Boolean(connectionId && date); const backTo = dayScoped ? `/library/digests/${connectionId}/${date}` : (readingReturnTo(searchParams.get('returnTo'), searchParams.get('projectId')) ?? '/library/items')
  const backLabel = dayScoped ? (briefing?.connection_name ?? t('reading.day')) : t(backTo.startsWith('/library/digests') || /[?]tab=digest(?:&date=\d{4}-\d{2}-\d{2})?$/.test(backTo) ? 'reading.editions' : backTo.includes('/research?') ? 'reading.researchReturn' : /[?]tab=(candidates|settings)$/.test(backTo) ? 'reading.sources' : backTo.startsWith('/projects/') ? 'reading.project' : 'nav.library'); const itemPath = (id: string) => `/library/digests/${connectionId}/${date}/items/${id}`

  async function reextract() {
    if (!document || document.document_type !== 'source_item' || !document.content_state) return
    const reason = textExtractionDisabledReason({ content_state: document.content_state, source_uri: document.source_uri }); if (reason) return toast.error(reason)
    const id = document.document_id
    setReextracting(true)
    try {
      await sourcesApi.itemAction(id, 'queue_content'); const job = await runPendingItemJob(id, 'extract_text')
      const [doc, result] = await Promise.all([readerApi.getDocument('source_item', id, { origin: readOrigin }), readerApi.listAnnotations('source_item', id)])
      toast.success(t(`reading.extractionResult_${job?.status ?? 'queued'}`))
      if (currentItemId.current !== id) return
      setFailedJob(job?.status === 'failed' ? job : null); setDocument(doc); setAnnotations(result.items)
    } catch (error) { toast.error(errMsg(error)) } finally { setReextracting(false) }
  }

  if (loading) return <div className="max-w-3xl space-y-4 p-6"><Skeleton className="h-6 w-32"/><Skeleton className="h-8 w-64"/><Skeleton className="h-96 w-full"/></div>
  if (!document) return <div className="p-6"><Button variant="ghost" size="sm" asChild><Link to={backTo}><ArrowLeft className="mr-1 size-4"/>{backLabel}</Link></Button><EmptyState title={t('reading.documentMissing')} description={t('reading.documentMissingHint')}/></div>

  const disabledReason = document.content_state ? textExtractionDisabledReason({ content_state: document.content_state, source_uri: document.source_uri }) : t('reading.extractSourceOnly')
  // `remoteImages`: a captured article's images are part of the article the
  // person chose to read (`image_policy: "remote_reference"`). The other caller
  // of `ReaderWorkspace` renders a synthesis Run's output — model-authored over
  // ingested third-party items — and deliberately does not pass it.
  return <ReaderWorkspace remoteImages document={document} annotations={annotations} onAnnotationsChange={setAnnotations}
    header={({ panelOpen, togglePanel }) => <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
      <Button variant="ghost" size="sm" asChild><Link to={backTo}><ArrowLeft className="mr-1 size-4"/>{backLabel}</Link></Button>
      {dayScoped && <div className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" disabled={!previous} asChild={Boolean(previous)}>{previous ? <Link to={itemPath(previous)} aria-label={t('reading.previousItem')}><ChevronLeft className="size-4"/></Link> : <ChevronLeft className="size-4"/>}</Button>
        <Button variant="ghost" size="icon-sm" disabled={!next} asChild={Boolean(next)}>{next ? <Link to={itemPath(next)} aria-label={t('reading.nextItem')}><ChevronRight className="size-4"/></Link> : <ChevronRight className="size-4"/>}</Button>
      </div>}
      <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-medium">{document.title}</h1>{document.content_state && <p className="truncate text-xs text-muted-foreground">{t(`reading.document_${document.document_type}`)} · {t(`reading.content_${document.content_state}`, { defaultValue: document.content_state })}</p>}</div>
      {safeHttpUrl(document.source_uri) && <Button variant="ghost" size="icon-sm" asChild><SafeExternalLink href={document.source_uri} aria-label={t('reading.openSource')}><ExternalLink className="size-4"/></SafeExternalLink></Button>}
      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={reextracting || disabledReason !== null} title={disabledReason ?? undefined} onClick={reextract}>
        {document.content_state === 'content_saved' ? <RefreshCw className="size-3.5"/> : <FileText className="size-3.5"/>}{t(reextracting ? 'reading.extracting' : document.content_state === 'content_saved' ? 'reading.reextract' : 'reading.extract')}
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={togglePanel} aria-label={t(panelOpen ? 'reading.hideInspector' : 'reading.showInspector')}><PanelRight className="size-4"/></Button>
    </header>}
    banner={failedJob && <div role="alert" className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"><AlertTriangle className="mt-0.5 size-4 text-destructive"/><div><p className="font-medium text-destructive">{t('reading.extractionResult_failed')}</p><p className="text-muted-foreground">{failedJob.error_message ?? failedJob.error_code ?? t('reading.noErrorDetail')}</p></div></div>}
  />
}
