import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, ExternalLink, ShieldCheck } from 'lucide-react'
import { projectResearchApi, readerApi } from '../../api/client'
import { ReaderWorkspace } from '../../components/reader/ReaderWorkspace'
import { ReaderDocumentLead } from '../../components/reader/ReaderDocumentLead'
import { ReaderPanelToggle } from '../../components/reader/ReaderPanelToggle'
import { isReaderAccessError, useReaderAnnotations } from '../../components/reader/useReaderAnnotations'
import { clearDocumentCommentDrafts } from '../../components/reader/commentDrafts'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { SpaceLink as Link } from '../../core/spaceNav'
import { SafeExternalLink } from '../../components/SafeExternalLink'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'
import { errMsg } from '../../lib/utils'
import type { ProjectResearchReport, ReaderDocumentPayload } from '../../types/api'

// `match` is the heading text the synthesis writes into the report body;
// the visible label is localized.
const SECTIONS = [
  { match: 'Executive summary', label: 'research_report.section_summary' },
  { match: 'Findings', label: 'research_report.section_findings' },
  { match: 'Sources', label: 'research_report.section_sources' },
  { match: 'Limitations', label: 'research_report.section_limitations' },
  { match: 'Research ideas', label: 'research_report.section_ideas' },
] as const

const statusOf = (error: unknown) => error && typeof error === 'object' && 'status' in error ? (error as { status: unknown }).status : null

export default function ResearchReportPage() {
  const { t } = useAppTranslation()
  const { projectId = '', reportId = '' } = useParams<{ projectId: string; reportId: string }>()
  const { activeSpaceId } = useSpace()
  // Everything shown belongs to exactly this Space, Project and report. A
  // reply for any other scope, or an older request for this one, is dropped,
  // and changing scope clears the previous report before anything else shows.
  const scopeKey = `${activeSpaceId ?? ''}|${projectId}|${reportId}`
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey
  const request = useRef(0)
  const [report, setReport] = useState<ProjectResearchReport | null>(null)
  const [readerDocument, setReaderDocument] = useState<ReaderDocumentPayload | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [checkingIntegrity, setCheckingIntegrity] = useState(false)
  const [expandedRefs, setExpandedRefs] = useState<Set<string>>(new Set())
  const [focusTarget, setFocusTarget] = useState<string | null>(null)
  const draftScope = useMemo(() => activeSpaceId && reportId ? { spaceId: activeSpaceId, documentType: 'research_report', documentId: reportId } : null, [activeSpaceId, reportId])
  // Annotations load and fail on their own: a list failure never hides the report.
  const { annotations, onAnnotationsChange, status: annotationsStatus, authority: annotationAuthority } = useReaderAnnotations(draftScope)

  // Scrolls after render so a just-expanded excerpt row exists in the DOM.
  useEffect(() => {
    if (!focusTarget) return
    const entry = document.getElementById(`reference-${focusTarget}`)
    if (entry) {
      entry.scrollIntoView({ behavior: 'smooth', block: 'center' })
      entry.classList.add('reference-flash')
      window.setTimeout(() => entry.classList.remove('reference-flash'), 1600)
    }
    setFocusTarget(null)
  }, [focusTarget])

  const load = useCallback(() => {
    const id = ++request.current
    const scope = scopeRef.current
    const current = () => request.current === id && scopeRef.current === scope
    setLoading(true); setLoadError(null); setReport(null); setReaderDocument(null)
    Promise.all([projectResearchApi.report(projectId, reportId), readerApi.getDocument('research_report', reportId)])
      .then(([nextReport, nextDocument]) => { if (current()) { setReport(nextReport); setReaderDocument(nextDocument) } })
      .catch(error => {
        if (!current()) return
        setLoadError(error)
        if (isReaderAccessError(error) && activeSpaceId) clearDocumentCommentDrafts({ spaceId: activeSpaceId, documentType: 'research_report', documentId: reportId })
      })
      .finally(() => { if (current()) setLoading(false) })
  }, [activeSpaceId, projectId, reportId])

  useEffect(() => {
    setCheckingIntegrity(false); setExpandedRefs(new Set())
    load()
    return () => { request.current += 1 }
  }, [scopeKey, load])

  if (loading) return <div className="space-y-4 p-6"><Skeleton className="h-8 w-64"/><Skeleton className="h-[32rem] w-full"/></div>
  if (!report || !readerDocument) {
    const status = statusOf(loadError)
    const back = <Button variant="ghost" size="sm" asChild><Link to={`/projects/${projectId}/research?tab=reports`}><ArrowLeft className="mr-1 size-4"/>{t('research_report.back')}</Link></Button>
    // Missing, not permitted and failed are different answers; only a failure invites a retry.
    if (status === 401 || status === 403) return <div className="p-6">{back}<EmptyState title={t('research_report.forbidden')} description={t('research_report.forbidden_hint')}/></div>
    if (!loadError || status === 404) return <div className="p-6">{back}<EmptyState title={t('research_report.missing')} description={t('research_report.missing_hint')}/></div>
    return <div className="p-6">{back}<div role="alert" className="mt-4 space-y-3 rounded-lg border border-border p-4">
      <p className="text-sm font-medium">{t('research_report.failed')}</p>
      <p className="break-words text-sm text-muted-foreground">{errMsg(loadError)}</p>
      <Button size="sm" variant="outline" onClick={load}>{t('research_report.retry')}</Button>
    </div></div>
  }

  const stale = Boolean(report.current_research_question?.trim() && report.current_research_question.trim() !== report.research_question.trim())
  const formatKind = (value: string) => value.replace(/_/g, ' ')
  const scrollToSection = (match: string) => {
    const headings = document.querySelectorAll<HTMLElement>('.reader-document-shell h2')
    Array.from(headings).find(heading => heading.textContent?.trim() === match)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const focusReference = (referenceId: string) => {
    const group = /^(ref-\d+)/.exec(referenceId)?.[1] ?? referenceId
    if (group !== referenceId) setExpandedRefs(prev => new Set(prev).add(group))
    setFocusTarget(referenceId)
  }
  const checkIntegrity = async () => {
    // The check and its refreshed report belong to the report it started on.
    const scope = scopeRef.current
    const startedFor = request.current
    const current = () => scopeRef.current === scope && request.current === startedFor
    setCheckingIntegrity(true)
    try {
      await projectResearchApi.runReportIntegrity(projectId, reportId)
      const refreshed = await projectResearchApi.report(projectId, reportId)
      if (!current()) return
      setReport(refreshed)
      toast.success(t('research_report.integrity_done'))
    } catch (error) { if (current()) toast.error(errMsg(error)) } finally { if (current()) setCheckingIntegrity(false) }
  }
  const statusBadge = <Badge variant={report.status === 'rejected' ? 'destructive' : report.status === 'awaiting_review' ? 'warning' : 'success'}>{t(`research_report.status_${report.status}`)}</Badge>
  return <div className="grid h-full min-h-0 grid-cols-1 xl:grid-cols-[14rem_minmax(0,1fr)]">
    <aside className="hidden overflow-y-auto border-r p-4 xl:block">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('research_report.contents')}</p>
      <nav className="mt-3 space-y-2 text-sm">
        {SECTIONS.map(item => <button className="block text-left hover:text-foreground" key={item.match} onClick={() => scrollToSection(item.match)}>{t(item.label)}</button>)}
      </nav>
      <div className="mt-6 border-t pt-4 text-xs text-muted-foreground">
        <p>{t('research_report.question_version_long', { version: report.research_question_version })}</p><p className="mt-1 capitalize">{formatKind(report.run_kind)}</p>
      </div>
      <div className="mt-6 border-t pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('research_report.references')}</p>
        <ol className="mt-3 space-y-3 text-xs">
          {report.resolved_references?.map(reference => <li key={reference.id} id={`reference-${reference.id}`} className="rounded-sm px-1 -mx-1">
            <p className="font-mono text-muted-foreground">[{reference.id}]</p>
            {reference.availability === 'unavailable' ? <p>{t('research_report.unavailable')}</p> : <>
              <p className="font-medium">{reference.title ?? t('research_report.external_source')}</p>
              {(reference.authors?.length || reference.year) && <p className="text-muted-foreground">{[reference.authors?.join(', '), reference.year].filter(Boolean).join(' · ')}</p>}
              <div className="mt-1 flex gap-2">
                {reference.library_path && <Link to={reference.library_path}>{t('research_report.library')}</Link>}
                {reference.academic_path && <Link to={reference.academic_path}>{t('research_report.academic')}</Link>}
                {reference.external_url && <SafeExternalLink href={reference.external_url}>{t('research_report.external')}</SafeExternalLink>}
              </div>
            </>}
            {(reference.excerpts?.length ?? 0) > 0 && <div className="mt-1">
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setExpandedRefs(prev => { const next = new Set(prev); if (!next.delete(reference.id)) next.add(reference.id); return next })}>
                {expandedRefs.has(reference.id) ? t('research_report.hide_excerpts') : t('research_report.excerpts', { count: reference.excerpts!.length })}
              </button>
              {expandedRefs.has(reference.id) && <ol className="mt-1 space-y-1">
                {reference.excerpts!.map(excerpt => <li key={excerpt.id} id={`reference-${excerpt.id}`} className="truncate rounded-sm px-1 -mx-1 text-muted-foreground" title={excerpt.title}>
                  <span className="font-mono">{excerpt.id.slice(reference.id.length)}.</span> {excerpt.title ?? t('research_report.excerpt')}
                </li>)}
              </ol>}
            </div>}
          </li>)}
        </ol>
      </div>
    </aside>
    <ReaderWorkspace document={readerDocument} annotations={annotations} onAnnotationsChange={onAnnotationsChange} annotationsStatus={annotationsStatus} annotationAuthority={annotationAuthority} onReferenceClick={focusReference}
      header={({ panelOpen, togglePanel, unsentComments }) => <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <Button variant="ghost" size="sm" asChild><Link to={`/projects/${projectId}/research?tab=reports`}><ArrowLeft className="mr-1 size-4"/>{t('research_report.back')}</Link></Button>
        {/* A short label for orientation; the research question is the page heading. */}
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{t('research_report.title')}</p>
        <ReaderPanelToggle panelOpen={panelOpen} togglePanel={togglePanel} unsentComments={unsentComments}/>
      </header>}
      lead={<ReaderDocumentLead title={report.research_question} contentJson={readerDocument.content_json} meta={<>
        {statusBadge}
        <span>{t('research_report.generated', { date: formatDateTime(report.created_at) })}</span>
        <span>{t('research_report.question_version', { version: report.research_question_version })}</span>
        <span className="capitalize">{formatKind(report.run_kind)}</span>
        {stale && <Badge variant="warning">{t('research_report.previous_question')}</Badge>}
        <span>{t(report.integrity?.status === 'available' ? 'research_report.integrity_available' : 'research_report.integrity_not_checked')}</span>
      </>}/>}
      banner={<div className="mx-4 mt-3 space-y-2 text-xs">
        {report.status === 'awaiting_review' && <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2">{t('research_report.awaiting_review_notice')} <Link className="font-medium underline" to={`/projects/${projectId}#research-checkpoints`}>{t('research_report.return_to_review')}</Link></div>}
        <details><summary className="cursor-pointer font-medium">{t('research_report.advanced')}</summary>
          <div className="mt-2 flex flex-wrap gap-3 text-muted-foreground">
            <Link to={`/runs/${report.synthesis_run_id}`}>{t('research_report.synthesis_run')}</Link>
            {report.archive_descriptors?.map(item => <Link key={`${item.kind}:${item.artifact_id}`} to={`/artifacts/${item.artifact_id}`}>{t('research_report.export', { kind: formatKind(item.kind) })} <ExternalLink className="inline size-3"/></Link>)}
            <button disabled={checkingIntegrity} onClick={() => void checkIntegrity()} className="disabled:opacity-50"><ShieldCheck className="mr-1 inline size-3"/>{checkingIntegrity ? t('research_report.checking_integrity') : t('research_report.run_integrity')}</button>
          </div>
        </details>
      </div>}
    />
  </div>
}
