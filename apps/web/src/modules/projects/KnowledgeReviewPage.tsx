import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Check, Clock3, X } from 'lucide-react'
import {
  agentsApi,
  experimentsApi,
  inquiryApi,
  knowledgePromotionApi,
  notesApi,
  projectReviewApi,
  type KnowledgePromotionCandidate,
  type ProjectReviewSession,
} from '../../api/client'
import type { AgentOut, ExperimentInterpretation, InquiryThread, NoteSummary } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Badge } from '../../components/ui/badge'
import { Select } from '../../components/ui/select'
import { toast } from 'sonner'
import { ThreadOriginBar } from './inquiryArea/ThreadOriginBar'

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default function KnowledgeReviewPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { projectId = '' } = useParams()
  const [status, setStatus] = useState<'pending' | 'deferred'>('pending')
  const [showAll, setShowAll] = useState(false)
  const [packetId, setPacketId] = useState<string | null>(null)
  const [items, setItems] = useState<KnowledgePromotionCandidate[]>([])
  const [summary, setSummary] = useState('')
  const [selected, setSelected] = useState<KnowledgePromotionCandidate | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [projectReview, setProjectReview] = useState<ProjectReviewSession | null>(null)
  const [extractKind, setExtractKind] = useState<'note' | 'inquiry_thread' | 'experiment_interpretation'>('inquiry_thread')
  const [extractSourceId, setExtractSourceId] = useState('')
  const [extractAgentId, setExtractAgentId] = useState('')
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [threads, setThreads] = useState<InquiryThread[]>([])
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [interpretations, setInterpretations] = useState<ExperimentInterpretation[]>([])

  const load = useCallback(async () => {
    const review = await knowledgePromotionApi.summary(projectId)
    const packet = status === 'pending' && !showAll ? await knowledgePromotionApi.openPacket(projectId, 10) : null
    const rows = packet?.candidates ?? await knowledgePromotionApi.list(projectId, status)
    setPacketId(packet?.id ?? null)
    setItems(rows)
    setSummary(review.summary)
    setSelected(current => rows.find(item => item.id === current?.id) ?? rows[0] ?? null)
  }, [projectId, showAll, status])

  useEffect(() => { load().catch(error => toast.error(message(error))) }, [load])
  useEffect(() => {
    async function loadExtractionChoices() {
      const [agentRows, threadRows, notePage, definitions] = await Promise.all([
        agentsApi.list({ status: 'active' }),
        inquiryApi.listThreads(projectId),
        notesApi.list({ project_id: projectId, status: 'active', limit: 100 }),
        experimentsApi.listDefinitions(projectId),
      ])
      const interpretationRows = (await Promise.all(
        definitions.map(definition => experimentsApi.listInterpretations(projectId, definition.id)),
      )).flat()
      setAgents(agentRows.filter(agent => agent.status === 'active' && agent.current_version_id))
      setThreads(threadRows)
      setNotes(notePage.items)
      setInterpretations(interpretationRows)
    }
    loadExtractionChoices().catch(error => toast.error(message(error)))
  }, [projectId])
  useEffect(() => {
    setTitle(selected?.proposed_title ?? '')
    setContent(selected?.proposed_content ?? '')
  }, [selected])
  const sourceOptions = useMemo(() => {
    if (extractKind === 'inquiry_thread') {
      return threads.map(thread => ({ value: thread.id, label: `${thread.kind === 'hypothesis' ? 'Hypothesis' : 'Question'} · ${thread.statement}` }))
    }
    if (extractKind === 'note') {
      return notes.map(note => ({ value: note.id, label: note.title }))
    }
    return interpretations.map(item => ({
      value: item.id,
      label: `${item.verdict} · ${item.conclusion || 'No conclusion recorded'}`,
    }))
  }, [extractKind, interpretations, notes, threads])

  async function decide(decision: 'promote' | 'dismiss' | 'defer') {
    if (!selected) return
    setBusy(true)
    try {
      await knowledgePromotionApi.decide(projectId, selected.id, {
        decision,
        ...(decision === 'promote' ? { proposed_title: title, proposed_content: content } : {}),
      })
      await load()
      toast.success(decision === 'promote'
        ? 'Proposal created for review'
        : decision === 'defer' ? 'Candidate deferred' : 'Candidate dismissed')
    } catch (error) {
      toast.error(message(error))
    } finally {
      setBusy(false)
    }
  }

  async function reopen() {
    if (!selected) return
    setBusy(true)
    try {
      await knowledgePromotionApi.reopen(projectId, selected.id)
      await load()
    } catch (error) {
      toast.error(message(error))
    } finally {
      setBusy(false)
    }
  }

  return <div className={embedded ? 'space-y-5' : 'p-6 space-y-5'}>
    <ThreadOriginBar projectId={projectId} kinds={['promote_knowledge']} />
    <div>
      {/* Inside Inquiry's Review view it is a section, not a page: the shell
          is the way back, and the heading is the tab's. */}
      <h2 className={embedded ? 'text-base font-semibold' : 'text-xl font-semibold'}>Knowledge candidates</h2>
      <p className="text-sm text-muted-foreground">{summary || 'Checking new source information…'}</p>
    </div>
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div><p className="font-medium">Project review checkpoint</p><p className="text-sm text-muted-foreground">{projectReview?.summary ?? 'Open one bounded checkpoint across Inquiry and Knowledge.'}</p></div>
      <div className="flex gap-2">
        {projectReview && <Button size="sm" variant="outline" asChild><Link to={`/projects/${projectId}/inquiry`}>Review {projectReview.sections.inquiry.packet.candidates.length} Inquiry</Link></Button>}
        <Button size="sm" onClick={() => projectReviewApi.open(projectId).then(setProjectReview).catch(error => toast.error(message(error)))}>Open project review</Button>
      </div>
    </Card>
    <Card className="grid gap-2 p-4 md:grid-cols-[180px_1fr_1fr_auto]">
      <Select ariaLabel="Extraction source type" value={extractKind} options={[
        { value: 'inquiry_thread', label: 'Inquiry Thread' },
        { value: 'note', label: 'Note' },
        { value: 'experiment_interpretation', label: 'Interpretation' },
      ]} onChange={value => { setExtractKind(value as typeof extractKind); setExtractSourceId('') }} />
      <Select ariaLabel="Extraction source" value={extractSourceId} onChange={setExtractSourceId} options={[
        { value: '', label: sourceOptions.length ? 'Select a source' : `No ${extractKind.replace(/_/g, ' ')} sources available` },
        ...sourceOptions,
      ]} />
      <Select ariaLabel="Extraction agent" value={extractAgentId} onChange={setExtractAgentId} options={[
        { value: '', label: agents.length ? 'Select an Agent' : 'No active Agent available' },
        ...agents.map(agent => ({ value: agent.id, label: `${agent.name}${agent.adapter_type ? ` · ${agent.adapter_type.replace(/_/g, ' ')}` : ''}` })),
      ]} />
      <Button disabled={!extractSourceId || !extractAgentId} onClick={() => knowledgePromotionApi.extract(projectId, {
        source_kind: extractKind,
        source_id: extractSourceId,
        agent_id: extractAgentId,
      }).then(result => toast.success(`Extraction Run ${result.run_id} queued`)).catch(error => toast.error(message(error)))}>Extract with AI</Button>
    </Card>
    <div className="flex gap-2">
      <Button size="sm" variant={status === 'pending' ? 'default' : 'outline'} onClick={() => setStatus('pending')}>Needs review</Button>
      <Button size="sm" variant={status === 'deferred' ? 'default' : 'outline'} onClick={() => setStatus('deferred')}>Deferred</Button>
      {status === 'pending' && <Button size="sm" variant="outline" onClick={() => setShowAll(value => !value)}>{showAll ? 'Use checkpoint batch' : 'View all'}</Button>}
      {packetId && <Button size="sm" variant="outline" onClick={async () => { await knowledgePromotionApi.closePacket(projectId, packetId); await load() }}>Next checkpoint</Button>}
    </div>
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <Card className="p-3 space-y-2">
        {items.length === 0 && <p className="p-3 text-sm text-muted-foreground">Nothing in this checkpoint.</p>}
        {items.map(item => <button key={item.id} onClick={() => setSelected(item)}
          className={`w-full rounded-md border p-3 text-left ${selected?.id === item.id ? 'border-primary bg-muted' : 'border-border'}`}>
          <div className="flex justify-between gap-2"><span className="font-medium text-sm">{item.proposed_title}</span><Badge variant="outline">{item.trigger}</Badge></div>
          <p className="mt-1 text-xs text-muted-foreground">{item.source_kind}</p>
        </button>)}
      </Card>
      <Card className="p-5 space-y-4">
        {!selected ? <p className="text-sm text-muted-foreground">Select a Candidate to review.</p> : <>
          <div className="flex items-center gap-2"><Badge>{selected.candidate_kind}</Badge><span className="text-xs text-muted-foreground">Pinned to {selected.source_kind.replace(/_/g, ' ')} · {sourceLabel(selected.source_kind, selected.source_id, threads, notes, interpretations)}</span></div>
          <Input value={title} onChange={event => setTitle(event.target.value)} aria-label="Candidate title" />
          <Textarea value={content} onChange={event => setContent(event.target.value)} rows={14} aria-label="Candidate content" />
          <div className="flex gap-2 flex-wrap">
            {status === 'pending' ? <>
              <Button disabled={busy || !title.trim() || !content.trim()} onClick={() => decide('promote')}><Check className="size-4" />Edit and promote</Button>
              <Button disabled={busy} variant="outline" onClick={() => decide('defer')}><Clock3 className="size-4" />Defer</Button>
              <Button disabled={busy} variant="destructive" onClick={() => decide('dismiss')}><X className="size-4" />Dismiss</Button>
            </> : <Button disabled={busy} onClick={reopen}>Return to review</Button>}
          </div>
        </>}
      </Card>
    </div>
  </div>
}

function sourceLabel(
  kind: string,
  id: string,
  threads: InquiryThread[],
  notes: NoteSummary[],
  interpretations: ExperimentInterpretation[],
): string {
  if (kind === 'inquiry_thread') return threads.find(item => item.id === id)?.statement ?? 'Unavailable Inquiry Thread'
  if (kind === 'note') return notes.find(item => item.id === id)?.title ?? 'Unavailable note'
  const interpretation = interpretations.find(item => item.id === id)
  return interpretation?.conclusion || (interpretation ? `${interpretation.verdict} interpretation` : 'Unavailable interpretation')
}
