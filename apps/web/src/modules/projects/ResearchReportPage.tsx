import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, ExternalLink, PanelRight, ShieldCheck } from 'lucide-react'
import { projectResearchApi, readerApi } from '../../api/client'
import { ReaderWorkspace } from '../../components/reader/ReaderWorkspace'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { SpaceLink as Link } from '../../core/spaceNav'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { ProjectResearchReport, ReaderAnnotation, ReaderDocumentPayload } from '../../types/api'

const statusLabel = { awaiting_review: 'Awaiting review', complete: 'Complete', rejected: 'Rejected' } as const

export default function ResearchReportPage() {
  const { projectId = '', reportId = '' } = useParams<{ projectId: string; reportId: string }>()
  const [report, setReport] = useState<ProjectResearchReport | null>(null)
  const [readerDocument, setReaderDocument] = useState<ReaderDocumentPayload | null>(null)
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>([])
  const [loading, setLoading] = useState(true)
  const [checkingIntegrity, setCheckingIntegrity] = useState(false)
  const [expandedRefs, setExpandedRefs] = useState<Set<string>>(new Set())
  const [focusTarget, setFocusTarget] = useState<string | null>(null)

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

  useEffect(() => {
    let cancelled = false; setLoading(true)
    Promise.all([
      projectResearchApi.report(projectId, reportId),
      readerApi.getDocument('research_report', reportId),
      readerApi.listAnnotations('research_report', reportId),
    ]).then(([nextReport, nextDocument, nextAnnotations]) => {
      if (!cancelled) { setReport(nextReport); setReaderDocument(nextDocument); setAnnotations(nextAnnotations.items) }
    }).catch(error => { if (!cancelled && !isNotFoundError(error)) toast.error(errMsg(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, reportId])

  if (loading) return <div className="space-y-4 p-6"><Skeleton className="h-8 w-64"/><Skeleton className="h-[32rem] w-full"/></div>
  if (!report || !readerDocument) return <div className="p-6"><EmptyState title="Not found or not accessible" description="This research report is unavailable."/></div>

  const stale = Boolean(report.current_research_question?.trim() && report.current_research_question.trim() !== report.research_question.trim())
  const formatKind = (value: string) => value.replace(/_/g, ' ')
  const scrollToSection = (label: string) => {
    const headings = document.querySelectorAll<HTMLElement>('.reader-document-shell h2')
    Array.from(headings).find(heading => heading.textContent?.trim() === label)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const focusReference = (referenceId: string) => {
    const group = /^(ref-\d+)/.exec(referenceId)?.[1] ?? referenceId
    if (group !== referenceId) setExpandedRefs(prev => new Set(prev).add(group))
    setFocusTarget(referenceId)
  }
  const checkIntegrity = async () => {
    setCheckingIntegrity(true)
    try {
      await projectResearchApi.runReportIntegrity(projectId, reportId)
      setReport(await projectResearchApi.report(projectId, reportId))
      toast.success('Integrity check completed')
    } catch (error) { toast.error(errMsg(error)) } finally { setCheckingIntegrity(false) }
  }
  return <div className="grid h-full min-h-0 grid-cols-1 xl:grid-cols-[14rem_minmax(0,1fr)]">
    <aside className="hidden overflow-y-auto border-r p-4 xl:block">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contents</p>
      <nav className="mt-3 space-y-2 text-sm">
        {['Executive summary', 'Findings', 'Sources', 'Limitations', 'Research ideas'].map(item => <button className="block text-left hover:text-foreground" key={item} onClick={() => scrollToSection(item)}>{item}</button>)}
      </nav>
      <div className="mt-6 border-t pt-4 text-xs text-muted-foreground">
        <p>Question version {report.research_question_version}</p><p className="mt-1 capitalize">{formatKind(report.run_kind)}</p>
      </div>
      <div className="mt-6 border-t pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">References</p>
        <ol className="mt-3 space-y-3 text-xs">
          {report.resolved_references?.map(reference => <li key={reference.id} id={`reference-${reference.id}`} className="rounded-sm px-1 -mx-1">
            <p className="font-mono text-muted-foreground">[{reference.id}]</p>
            {reference.availability === 'unavailable' ? <p>Unavailable</p> : <>
              <p className="font-medium">{reference.title ?? 'External source'}</p>
              {(reference.authors?.length || reference.year) && <p className="text-muted-foreground">{[reference.authors?.join(', '), reference.year].filter(Boolean).join(' · ')}</p>}
              <div className="mt-1 flex gap-2">
                {reference.library_path && <Link to={reference.library_path}>Library</Link>}
                {reference.academic_path && <Link to={reference.academic_path}>Academic</Link>}
                {reference.external_url && <a href={reference.external_url} target="_blank" rel="noopener noreferrer">External</a>}
              </div>
            </>}
            {(reference.excerpts?.length ?? 0) > 0 && <div className="mt-1">
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setExpandedRefs(prev => { const next = new Set(prev); if (!next.delete(reference.id)) next.add(reference.id); return next })}>
                {expandedRefs.has(reference.id) ? 'Hide excerpts' : `${reference.excerpts!.length} excerpts`}
              </button>
              {expandedRefs.has(reference.id) && <ol className="mt-1 space-y-1">
                {reference.excerpts!.map(excerpt => <li key={excerpt.id} id={`reference-${excerpt.id}`} className="truncate rounded-sm px-1 -mx-1 text-muted-foreground" title={excerpt.title}>
                  <span className="font-mono">{excerpt.id.slice(reference.id.length)}.</span> {excerpt.title ?? 'Excerpt'}
                </li>)}
              </ol>}
            </div>}
          </li>)}
        </ol>
      </div>
    </aside>
    <ReaderWorkspace document={readerDocument} annotations={annotations} onAnnotationsChange={setAnnotations} onReferenceClick={focusReference}
      header={({ panelOpen, togglePanel }) => <header className="border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild><Link to={`/projects/${projectId}/research?tab=reports`}><ArrowLeft className="mr-1 size-4"/>Reports</Link></Button>
          <div className="min-w-0 flex-1"><h1 className="truncate font-semibold">Research report</h1><p className="truncate text-xs text-muted-foreground">{report.research_question}</p></div>
          <Badge variant={report.status === 'rejected' ? 'destructive' : report.status === 'awaiting_review' ? 'warning' : 'success'}>{statusLabel[report.status]}</Badge>
          <Button variant="ghost" size="icon" onClick={togglePanel} aria-label={panelOpen ? 'Hide inspector' : 'Show inspector'}><PanelRight className="size-4"/></Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>Generated {new Date(report.created_at).toLocaleString()}</span><span>·</span><span>Question v{report.research_question_version}</span><span>·</span><span className="capitalize">{formatKind(report.run_kind)}</span>
          {stale && <Badge variant="warning">Previous question</Badge>}
          <span>·</span><span>Integrity: {report.integrity?.status === 'available' ? 'available' : 'not checked'}</span>
        </div>
        {report.status === 'awaiting_review' && <div className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs">This report is ready to read and awaiting idea review. <Link className="font-medium underline" to={`/projects/${projectId}#research-checkpoints`}>Return to idea review</Link></div>}
        <details className="mt-3 text-xs"><summary className="cursor-pointer font-medium">Advanced</summary>
          <div className="mt-2 flex flex-wrap gap-3 text-muted-foreground">
            <Link to={`/runs/${report.synthesis_run_id}`}>Synthesis run</Link>
            {report.archive_descriptors?.map(item => <Link key={`${item.kind}:${item.artifact_id}`} to={`/artifacts/${item.artifact_id}`}>{formatKind(item.kind)} export <ExternalLink className="inline size-3"/></Link>)}
            <button disabled={checkingIntegrity} onClick={() => void checkIntegrity()} className="disabled:opacity-50"><ShieldCheck className="mr-1 inline size-3"/>{checkingIntegrity ? 'Checking…' : 'Run integrity check'}</button>
          </div>
        </details>
      </header>}
    />
  </div>
}
