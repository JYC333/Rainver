import {MaterialProcessingPanel} from './MaterialProcessingPanel'
import {AgentSearchProvenance} from './AgentSearchProvenance'
import { readingReturnTo } from './readingLinks'
import { ReadingSequenceNav } from './ReadingSequenceNav'
import { AgentMarkdownChoice } from './AgentMarkdownChoice'
import { useAppTranslation } from '../../i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { readerApi, sourcesApi, informationDigestsApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { ReaderDocumentPayload, SourcePostProcessingBriefingDetail, SourcePostProcessingItemRelevance } from '../../types/api'
import { ReaderWorkspace } from '../../components/reader/ReaderWorkspace'
import { ReaderDocumentLead } from '../../components/reader/ReaderDocumentLead'
import { ReaderPanelToggle } from '../../components/reader/ReaderPanelToggle'
import { isReaderAccessError, useReaderAnnotations } from '../../components/reader/useReaderAnnotations'
import { clearDocumentCommentDrafts } from '../../components/reader/commentDrafts'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { Button } from '../../components/ui/button'
import { SafeExternalLink } from '../../components/SafeExternalLink'
import { safeHttpUrl } from '../../lib/safeHttpUrl'
import { sessionEpoch } from '../../lib/sessionResidue'

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
  const changeId=searchParams.get('change');const [changeAcknowledged,setChangeAcknowledged]=useState(false);const [changeBusy,setChangeBusy]=useState(false);
  const readOrigin = searchParams.get('from') === 'project' ? 'project' as const : searchParams.get('from') === 'serendipity' ? 'serendipity' as const : undefined
  const { activeSpaceId } = useSpace()
  const changeScope=`${activeSpaceId}:${itemId}:${changeId}`;const currentChange=useRef(changeScope);currentChange.current=changeScope;
  useEffect(()=>{setChangeAcknowledged(false);setChangeBusy(false)},[changeScope]);
  const [briefing, setBriefing] = useState<SourcePostProcessingBriefingDetail | null>(null)
  const [document, setDocument] = useState<ReaderDocumentPayload | null>(null)
  const [documentError, setDocumentError] = useState<unknown>(null)
  // The document and its annotations load and fail independently: an
  // annotation outage must not hide text the reader is allowed to read.
  const draftScope = useMemo(() => activeSpaceId && itemId ? { spaceId: activeSpaceId, documentType: 'source_item', documentId: itemId } : null, [activeSpaceId, itemId])
  const { annotations, onAnnotationsChange, status: annotationsStatus, reload: reloadAnnotations, authority: annotationAuthority } = useReaderAnnotations(draftScope)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const currentScope=useRef('');currentScope.current=activeSpaceId+':'+itemId;
  // Every document request takes a number; only the latest one, for this item and session, may show its reply.
  const documentRequest=useRef(0)
  // The page that asked: one token per mounted page and item, dropped on cleanup, so a reload
  // answering after the page left (or after A→B→A) changes nothing.
  const pageOwner=useRef<object|null>(null)
  useEffect(()=>{const token={};pageOwner.current=token;return()=>{if(pageOwner.current===token)pageOwner.current=null}},[activeSpaceId,itemId])
  /**
   * Reloads the document after a change made here (prepared, shown as Markdown).
   * `shown`: the reply is on screen. `superseded`: the page, item, session or a newer
   * load moved on; nothing changed. `denied`: reading it was refused (401/403/404):
   * the text, its drafts and its annotations are gone, as on first load. An ordinary
   * failure is thrown and the text shown stays.
   */
  const reloadDocument=useCallback(async():Promise<'shown'|'superseded'|'denied'>=>{
    const request=++documentRequest.current,scope=activeSpaceId+':'+itemId,epoch=sessionEpoch(),owner=pageOwner.current
    const current=()=>owner!==null&&pageOwner.current===owner&&documentRequest.current===request&&currentScope.current===scope&&sessionEpoch()===epoch
    let doc:ReaderDocumentPayload
    try{doc=await readerApi.getDocument('source_item',itemId,{origin:readOrigin})}
    catch(error){
      if(!current())return 'superseded'
      if(isReaderAccessError(error)||isNotFoundError(error)){
        setDocument(null);setDocumentError(error)
        if(activeSpaceId)clearDocumentCommentDrafts({spaceId:activeSpaceId,documentType:'source_item',documentId:itemId})
        // The annotation list is read again under the same refusal, which clears it.
        reloadAnnotations()
        return 'denied'
      }
      throw error
    }
    if(!current())return 'superseded'
    setDocument(doc);reloadAnnotations();return 'shown'
  },[activeSpaceId,itemId,readOrigin,reloadAnnotations])
  useEffect(() => {
    if (!activeSpaceId || !connectionId || !date) return setBriefing(null)
    let cancelled = false; const epoch = sessionEpoch(); setBriefing(null)
    const current = () => !cancelled && sessionEpoch() === epoch
    sourcesApi.briefing(connectionId, date).then(value => { if (current()) setBriefing(value) }).catch(() => { if (current()) setBriefing(null) })
    return () => { cancelled = true }
  }, [activeSpaceId, connectionId, date])

  useEffect(() => {
    if (!itemId || !activeSpaceId) { setDocument(null); setLoading(false); return }
    let cancelled = false; setLoading(true); setDocument(null); setDocumentError(null)
    // A newer load supersedes any reload still in flight.
    const request = ++documentRequest.current, epoch = sessionEpoch()
    const current = () => !cancelled && documentRequest.current === request && sessionEpoch() === epoch
    readerApi.getDocument('source_item', itemId, { origin: readOrigin })
      .then(doc => { if (current()) setDocument(doc) })
      .catch(error => {
        if (!current()) return
        setDocument(null); setDocumentError(error)
        // No longer readable: unsent comments on it must not linger in memory.
        if (isReaderAccessError(error) || isNotFoundError(error)) clearDocumentCommentDrafts({ spaceId: activeSpaceId, documentType: 'source_item', documentId: itemId })
      })
      .finally(() => { if (current()) setLoading(false) })
    return () => { cancelled = true }
  }, [activeSpaceId, itemId, readOrigin, reloadKey])

  const ids = useMemo(() => briefing ? orderedItemIds(briefing) : [], [briefing]); const index = ids.indexOf(itemId)
  const previous = index > 0 ? ids[index - 1] : null; const next = index >= 0 && index < ids.length - 1 ? ids[index + 1] : null
  const dayScoped = Boolean(connectionId && date)
  // The Reading list this was opened from, if any (validated like the back link).
  const listReturn = readingReturnTo(searchParams.get('returnTo'), searchParams.get('projectId')); const backTo = dayScoped ? `/library/digests/${connectionId}/${date}` : (readingReturnTo(searchParams.get('returnTo'), searchParams.get('projectId')) ?? '/library/items')
  const backLabel = dayScoped ? (briefing?.connection_name ?? t('reading.day')) : t(/\/goals\/[\w-]+(?:\?|$)/.test(backTo) ? 'topics.backToTopic' : backTo.startsWith('/library/digests') || /[?]tab=digest(?:&date=\d{4}-\d{2}-\d{2})?$/.test(backTo) ? 'reading.editions' : backTo.includes('/research?') ? 'reading.researchReturn' : /[?]tab=(candidates|settings)$/.test(backTo) ? 'reading.sources' : backTo.startsWith('/projects/') ? 'reading.project' : 'nav.library'); const itemPath = (id: string) => `/library/digests/${connectionId}/${date}/items/${id}`

  if (loading) return <div className="max-w-3xl space-y-4 p-6"><Skeleton className="h-6 w-32"/><Skeleton className="h-8 w-64"/><Skeleton className="h-96 w-full"/></div>
  if (!document) {
    const status = documentError && typeof documentError === 'object' && 'status' in documentError ? documentError.status : null
    // Missing, not permitted and failed are different answers; only a failure invites a retry.
    const missing = !documentError || status === 404 || isNotFoundError(documentError)
    return <div className="p-6"><Button variant="ghost" size="sm" asChild><Link to={backTo}><ArrowLeft className="mr-1 size-4"/>{backLabel}</Link></Button>
      {missing ? <EmptyState title={t('reading.documentMissing')} description={t('reading.documentMissingHint')}/>
        : status === 403 ? <EmptyState title={t('reading.noAccess')} description={t('reading.documentForbiddenHint')}/>
        : <div role="alert" className="mt-4 space-y-3 rounded-lg border border-border p-4"><p className="text-sm font-medium">{t('reading.documentLoadFailed')}</p><p className="break-words text-sm text-muted-foreground">{errMsg(documentError)}</p><Button size="sm" variant="outline" onClick={() => setReloadKey(key => key + 1)}>{t('reading.retry')}</Button></div>}
    </div>
  }
  const sourceHost = safeHttpUrl(document.source_uri) ? new URL(document.source_uri as string).hostname : null

  // `remoteImages`: a captured article's images are part of the article the
  // person chose to read (`image_policy: "remote_reference"`). The other caller
  // of `ReaderWorkspace` renders a synthesis Run's output — model-authored over
  // ingested third-party items — and deliberately does not pass it.
  // A document whose stored policy is `none` (Agent-authored reading) never
  // loads remote images inline; older documents without a policy keep the
  // captured-page behaviour.
  return <ReaderWorkspace remoteImages={document.image_policy !== 'none'} document={document} annotations={annotations} onAnnotationsChange={onAnnotationsChange} annotationsStatus={annotationsStatus} annotationAuthority={annotationAuthority}
    lead={<ReaderDocumentLead title={document.title} contentJson={document.content_json} meta={<>
      <AgentSearchProvenance value={document.result_provenance}/>
      {document.content_state && <span>{t(`reading.document_${document.document_type}`)} · {t(`reading.content_${document.content_state}`, { defaultValue: document.content_state })}</span>}
      {sourceHost && <span>{sourceHost}</span>}
    </>}/>}
    header={({ panelOpen, togglePanel, unsentComments }) => <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
      <Button variant="ghost" size="sm" asChild><Link to={backTo}><ArrowLeft className="mr-1 size-4"/>{backLabel}</Link></Button>
      {dayScoped && <div className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" disabled={!previous} asChild={Boolean(previous)}>{previous ? <Link to={itemPath(previous)} aria-label={t('reading.previousItem')}><ChevronLeft className="size-4"/></Link> : <ChevronLeft className="size-4"/>}</Button>
        <Button variant="ghost" size="icon-sm" disabled={!next} asChild={Boolean(next)}>{next ? <Link to={itemPath(next)} aria-label={t('reading.nextItem')}><ChevronRight className="size-4"/></Link> : <ChevronRight className="size-4"/>}</Button>
      </div>}
      {!dayScoped && activeSpaceId && listReturn && <ReadingSequenceNav spaceId={activeSpaceId} itemId={itemId} changeId={changeId} returnTo={listReturn} />}
      {/* A short title for orientation; the full title is the body's heading. */}
      <p className="min-w-0 flex-1 truncate text-sm font-medium" title={document.title}>{document.title}</p>
      {safeHttpUrl(document.source_uri) && <Button variant="ghost" size="icon-sm" asChild><SafeExternalLink href={document.source_uri} aria-label={t('reading.openSource')}><ExternalLink className="size-4"/></SafeExternalLink></Button>}
      <ReaderPanelToggle panelOpen={panelOpen} togglePanel={togglePanel} unsentComments={unsentComments}/>
    </header>}
    banner={<>{changeId&&<div className="mx-4 mt-3 rounded-lg border p-3"><Button disabled={changeBusy||changeAcknowledged} onClick={async()=>{if(!activeSpaceId)return;const scope=currentChange.current;setChangeBusy(true);try{await informationDigestsApi.readingState(activeSpaceId,itemId,{topic_change_id:changeId,read_status:'read'},searchParams.get('projectId')??undefined);if(currentChange.current===scope)setChangeAcknowledged(true)}catch(e){if(currentChange.current===scope)toast.error(errMsg(e))}finally{if(currentChange.current===scope)setChangeBusy(false)}}}>{t(changeAcknowledged?'reading.changeRead':'reading.markChangeRead')}</Button></div>}<MaterialProcessingPanel className="mx-4 mt-3" key={activeSpaceId+':'+itemId} itemId={itemId} spaceId={activeSpaceId??undefined} hasContent={!!document.plain_text.trim()} onReady={async()=>{await reloadDocument()}}/>{(document.reading_info||document.result_provenance==='agent_provided_unverified'||!document.plain_text.trim()) && <div role="status" className="mx-4 mt-3 space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <p>{document.plain_text.trim()?t(document.reading_info?.format==='agent_summary'?'reading.agentSummaryContent':document.reading_info?.method==='extractor'?'reading.sourceTextContent':'reading.agentRetrievedContent'):t('reading.agentNoContent')}</p>
      {!document.plain_text.trim() && document.content_unavailable_reason && <p>{t(`reading.agentContentReason_${document.content_unavailable_reason}`)}</p>}
      {document.reading_info?.kind==='repository' && <p className="text-muted-foreground">{t('reading.agentRepositoryContent')}</p>}
      {(document.agent_text_syntax==='undeclared'||document.agent_text_syntax==='plain') && activeSpaceId && document.artifact_id && <AgentMarkdownChoice itemId={itemId} spaceId={activeSpaceId} syntax={document.agent_text_syntax} shown={{artifact_id:document.artifact_id,source_snapshot_id:document.source_snapshot_id??null}} reload={reloadDocument}/>}
      {(document.reading_info?.sources?.length??0)>0&&<details className="text-muted-foreground"><summary className="w-fit cursor-pointer hover:text-foreground">{t('reading.agentSources',{count:document.reading_info!.sources.length})}</summary>{document.reading_info!.sources.map(source=><p key={source} className="break-all"><SafeExternalLink href={source}>{source}</SafeExternalLink></p>)}</details>}
      {!document.plain_text.trim() && safeHttpUrl(document.source_uri) && <SafeExternalLink href={document.source_uri}>{t('reading.openSource')}</SafeExternalLink>}
    </div>}</>}
  />
}
