import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft, HelpCircle, FlaskConical, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { inquiryApi, notesApi, projectsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  InquiryCandidate, InquiryReviewPacket, InquiryThread, InquiryThreadDetail, InquiryIteration, InquiryNextFocusKind, NoteSummary, Project,
} from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Select, type SelectOption } from '../../components/ui/select'
import { EmptyState } from '../../components/ui/empty-state'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog'

const NEXT_FOCUS_OPTIONS: SelectOption[] = [
  { value: 'search_acquisition', label: 'Search / acquisition' },
  { value: 'read_evidence', label: 'Read evidence' },
  { value: 'synthesize', label: 'Synthesize' },
  { value: 'clarify_or_decompose', label: 'Clarify or decompose' },
  { value: 'design_run_experiment', label: 'Design/run an experiment' },
  { value: 'create_decision_case', label: 'Create a Decision Case' },
  { value: 'create_delivery_task', label: 'Create/execute a Delivery Task' },
  { value: 'wait_for_monitoring', label: 'Wait for monitoring' },
  { value: 'promote_knowledge', label: 'Promote Knowledge' },
  { value: 'pause', label: 'Pause' },
]
const ATTENTION_OPTIONS: SelectOption[] = [
  { value: 'focused', label: 'Focused' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'blocked', label: 'Blocked' },
]

export default function InquiryAreaPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const focusedCandidateId = searchParams.get('candidate')
  const [project, setProject] = useState<Project | null>(null)
  const [threads, setThreads] = useState<InquiryThread[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createKind, setCreateKind] = useState<'question' | 'hypothesis'>('question')
  const [detail, setDetail] = useState<InquiryThreadDetail | null>(null)
  const [iterationHistory, setIterationHistory] = useState<InquiryIteration[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [candidates, setCandidates] = useState<InquiryCandidate[]>([])
  const [deferredCandidates, setDeferredCandidates] = useState<InquiryCandidate[]>([])
  const [reviewPacket, setReviewPacket] = useState<InquiryReviewPacket | null>(null)
  const reviewPacketRef = useRef<InquiryReviewPacket | null>(null)
  const [candidateDetails, setCandidateDetails] = useState<Record<string, InquiryCandidate>>({})
  const [deltaContent, setDeltaContent] = useState<Record<string, unknown> | null>(null)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [mergeCandidateId, setMergeCandidateId] = useState<string | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState('')

  const loadThreads = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [proj, list, pending, deferred, notePage] = await Promise.all([
        projectsApi.get(projectId),
        inquiryApi.listThreads(projectId),
        inquiryApi.listCandidates(projectId),
        inquiryApi.listCandidates(projectId, 'deferred'),
        notesApi.list({ project_id: projectId, status: 'active', limit: 100 }),
      ])
      setProject(proj)
      setThreads(list)
      setCandidates(pending)
      setDeferredCandidates(deferred)
      setNotes(notePage.items)
      if (!selectedId && list.length > 0) setSelectedId(list[0]!.id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => { loadThreads() }, [loadThreads])

  useEffect(() => {
    if (searchParams.get('new') !== 'hypothesis') return
    setCreateKind('hypothesis')
    setCreateOpen(true)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('new')
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    reviewPacketRef.current = reviewPacket
  }, [reviewPacket])

  useEffect(() => () => {
    const packet = reviewPacketRef.current
    if (projectId && packet?.status === 'open' && packet.id) {
      void inquiryApi.closeReviewPacket(projectId, packet.id)
    }
  }, [projectId])

  const loadDetail = useCallback(async () => {
    if (!projectId || !selectedId) {
      setDetail(null)
      setIterationHistory([])
      return
    }
    try {
      const [d, history] = await Promise.all([
        inquiryApi.getThread(projectId, selectedId),
        inquiryApi.listIterations(projectId, selectedId),
      ])
      setDetail(d)
      setIterationHistory(history)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }, [projectId, selectedId])

  useEffect(() => { loadDetail() }, [loadDetail])

  async function refreshAfterMutation() {
    await Promise.all([loadThreads(), loadDetail()])
  }

  if (!projectId) return null
  const treeRows = flattenThreadTree(threads)
  const reviewCandidates = reviewPacket?.status === 'open' ? reviewPacket.candidates : candidates

  async function decide(candidate: InquiryCandidate, decision: 'accept' | 'merge' | 'defer' | 'dismiss' | 'gap') {
    if (!projectId) return
    const body: Record<string, unknown> = { decision }
    if (decision === 'accept') {
      const editsText = window.prompt('Optional reviewer edits as JSON', '{}')
      if (editsText === null) return
      try { body.edits = JSON.parse(editsText) } catch { toast.error('Reviewer edits must be valid JSON'); return }
      body.change_summary = window.prompt('Change summary', candidate.summary ?? candidate.title) ?? undefined
    }
    if (decision === 'merge') {
      if (!mergeTargetId || mergeTargetId === candidate.id) {
        toast.error('Select another pending Candidate to merge into')
        return
      }
      body.target_candidate_id = mergeTargetId
    }
    if (decision === 'defer') {
      const reason = window.prompt('Why defer this Candidate?')
      const until = window.prompt('Review again at (ISO timestamp)', new Date(Date.now() + 86_400_000).toISOString())
      if (!reason || !until) return
      body.reason = reason
      body.defer_until = until
    }
    if (decision === 'gap') {
      const statement = window.prompt('New gap Question')
      if (!statement) return
      body.gap_statement = statement
    }
    try {
      await inquiryApi.decideCandidate(projectId, candidate.id, body)
      setMergeCandidateId(null)
      setMergeTargetId('')
      if (reviewPacket?.status === 'open') {
        const remaining = reviewPacket.candidates.filter(item => item.id !== candidate.id)
        if (remaining.length === 0 && reviewPacket.id) {
          await inquiryApi.closeReviewPacket(projectId, reviewPacket.id)
          setReviewPacket(null)
        } else {
          setReviewPacket({ ...reviewPacket, candidates: remaining })
        }
      }
      await loadThreads()
    } catch (e) { toast.error(errMsg(e)) }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3 pb-4 border-b border-border">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/projects/${projectId}`}><ArrowLeft className="size-4" /></Link>
        </Button>
        <div>
          <h1 className="text-lg font-semibold">Inquiry</h1>
          <p className="text-xs text-muted-foreground">{project?.name ?? 'Loading…'}</p>
        </div>
        <div className="flex-1" />
        <Button onClick={() => { setCreateKind('question'); setCreateOpen(true) }}><Plus className="size-4" />New Thread</Button>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-sm font-medium">Review checkpoint</p>
            <p className="text-xs text-muted-foreground">
              {candidates.length === 0 ? 'No material changes need review.' : `${candidates.length} material change${candidates.length === 1 ? '' : 's'} need review.`}
            </p>
          </div>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const brief = await inquiryApi.generateDeltaBrief(projectId)
                const content = brief.content
                setDeltaContent(content)
              } catch (e) { toast.error(errMsg(e)) }
            }}
          >
            Summarize new information
          </Button>
          {reviewPacket?.status === 'open'
            ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    if (reviewPacket.id) await inquiryApi.closeReviewPacket(projectId, reviewPacket.id)
                    setReviewPacket(null)
                  } catch (e) { toast.error(errMsg(e)) }
                }}
              >
                View all
              </Button>
            )
            : (
              <Button
                size="sm"
                disabled={candidates.length === 0}
                onClick={async () => {
                  try { setReviewPacket(await inquiryApi.openReviewPacket(projectId, 5)) } catch (e) { toast.error(errMsg(e)) }
                }}
              >
                Start checkpoint
              </Button>
            )}
        </div>
        {deltaContent && (
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-md bg-muted p-2"><strong>Reinforced</strong><pre className="whitespace-pre-wrap">{JSON.stringify(deltaContent.reinforced_positions ?? [], null, 2)}</pre></div>
            <div className="rounded-md bg-muted p-2"><strong>Challenged</strong><pre className="whitespace-pre-wrap">{JSON.stringify(deltaContent.challenged_positions ?? [], null, 2)}</pre></div>
            <div className="rounded-md bg-muted p-2"><strong>Gap changes</strong><pre className="whitespace-pre-wrap">{JSON.stringify(deltaContent.gap_changes ?? [], null, 2)}</pre></div>
            <div className="rounded-md bg-muted p-2"><strong>References</strong><pre className="whitespace-pre-wrap">{JSON.stringify(deltaContent.source_and_thread_refs ?? [], null, 2)}</pre></div>
          </div>
        )}
        {reviewCandidates.map(candidate => (
          <div key={candidate.id} className={`flex flex-wrap items-start gap-3 rounded-md border p-3 ${focusedCandidateId === candidate.id ? 'border-primary ring-2 ring-primary/20' : ''}`}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{candidate.title}</p>
              <p className="text-xs text-muted-foreground">{candidate.summary}</p>
              {Object.keys(candidate.proposed_change).length > 0
                ? <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(candidate.proposed_change, null, 2)}</pre>
                : <p className="mt-1 text-xs text-amber-700">No concrete position change was proposed, so this item cannot be accepted yet.</p>}
              {candidateDetails[candidate.id]?.signals && (
                <div className="mt-2 text-xs text-muted-foreground">
                  {candidateDetails[candidate.id]!.signals!.map(signal => (
                    <p key={signal.id}>{signal.classification} · corpus {signal.corpus_item_id} · {signal.model_version ?? 'manual'}</p>
                  ))}
                </div>
              )}
            </div>
            <div className="flex max-w-[260px] flex-wrap justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={async () => {
                try {
                  const detail = await inquiryApi.getCandidate(projectId, candidate.id)
                  setCandidateDetails(current => ({ ...current, [candidate.id]: detail }))
                } catch (e) { toast.error(errMsg(e)) }
              }}>Evidence</Button>
              <Button size="sm" onClick={() => decide(candidate, 'accept')}>Accept / edit</Button>
              <Button size="sm" variant="outline" onClick={() => { setMergeCandidateId(candidate.id); setMergeTargetId('') }}>Merge</Button>
              <Button size="sm" variant="outline" onClick={() => decide(candidate, 'gap')}>Gap</Button>
              <Button size="sm" variant="outline" onClick={() => decide(candidate, 'defer')}>Defer</Button>
              <Button size="sm" variant="ghost" onClick={() => decide(candidate, 'dismiss')}>Dismiss</Button>
            </div>
            {mergeCandidateId === candidate.id && (
              <div className="mt-3 flex items-center gap-2">
                <Select ariaLabel="Merge target Candidate" value={mergeTargetId} onChange={setMergeTargetId} options={[
                  { value: '', label: 'Select the Candidate that should remain' },
                  ...candidates.filter(item => item.id !== candidate.id).map(item => ({ value: item.id, label: item.title })),
                ]} />
                <Button size="sm" disabled={!mergeTargetId} onClick={() => decide(candidate, 'merge')}>Confirm merge</Button>
                <Button size="sm" variant="ghost" onClick={() => setMergeCandidateId(null)}>Cancel</Button>
              </div>
            )}
          </div>
        ))}
        {deferredCandidates.length > 0 && (
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-medium">Deferred for later review</p>
            <div className="space-y-2">
              {deferredCandidates.map(candidate => (
                <div key={candidate.id} className="flex items-center gap-3 rounded-md border p-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{candidate.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {candidate.decision_reason ?? 'No reason recorded'}
                      {candidate.defer_until ? ` · review after ${new Date(candidate.defer_until).toLocaleString()}` : ''}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await inquiryApi.reopenCandidate(projectId, candidate.id)
                        await loadThreads()
                      } catch (e) { toast.error(errMsg(e)) }
                    }}
                  >
                    Reopen
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-2">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && threads.length === 0 && (
            <EmptyState
              title="No Questions or Hypotheses yet"
              description="Start by creating a Question or Hypothesis Thread."
            />
          )}
          {treeRows.map(({ thread: t, depth }) => (
            <Card
              key={t.id}
              className={`p-3 cursor-pointer transition-colors ${selectedId === t.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'}`}
              onClick={() => setSelectedId(t.id)}
              style={{ marginLeft: `${Math.min(depth, 4) * 12}px` }}
            >
              <div className="flex items-center gap-2 mb-1">
                {t.kind === 'question' ? <HelpCircle className="size-3.5 text-muted-foreground" /> : <FlaskConical className="size-3.5 text-accent-foreground" />}
                <Badge variant="outline" className="text-[10px]">{t.attention_state}</Badge>
                {t.lifecycle_status !== 'active' && <Badge variant="secondary" className="text-[10px]">{t.lifecycle_status}</Badge>}
              </div>
              <p className="text-sm line-clamp-2">{t.statement}</p>
            </Card>
          ))}
        </div>

        <div>
          {detail
            ? (
              <ThreadDetailPanel
                projectId={projectId}
                detail={detail}
                iterationHistory={iterationHistory}
                allThreads={threads}
                notes={notes}
                onChanged={refreshAfterMutation}
              />
            )
            : <p className="text-sm text-muted-foreground">Select a Thread to see its detail.</p>}
        </div>
      </div>

      <CreateThreadDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async (id) => { setCreateOpen(false); await loadThreads(); setSelectedId(id) }}
        projectId={projectId}
        defaultKind={createKind}
      />
    </div>
  )
}

function flattenThreadTree(threads: InquiryThread[]): Array<{ thread: InquiryThread; depth: number }> {
  const children = new Map<string | null, InquiryThread[]>()
  for (const thread of threads) {
    const key = thread.primary_parent_id && threads.some(candidate => candidate.id === thread.primary_parent_id)
      ? thread.primary_parent_id
      : null
    children.set(key, [...(children.get(key) ?? []), thread])
  }
  const rows: Array<{ thread: InquiryThread; depth: number }> = []
  const visit = (parent: string | null, depth: number) => {
    for (const thread of children.get(parent) ?? []) {
      rows.push({ thread, depth })
      visit(thread.id, depth + 1)
    }
  }
  visit(null, 0)
  return rows
}

function CreateThreadDialog({ open, onOpenChange, onCreated, projectId, defaultKind }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (id: string) => void
  projectId: string
  defaultKind: 'question' | 'hypothesis'
}) {
  const [kind, setKind] = useState<'question' | 'hypothesis'>(defaultKind)
  const [statement, setStatement] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (open) setKind(defaultKind)
  }, [defaultKind, open])

  async function create() {
    if (!statement.trim()) { toast.error('Statement is required'); return }
    setCreating(true)
    try {
      const created = await inquiryApi.createThread(projectId, { kind, statement: statement.trim() })
      setStatement('')
      onCreated(created.id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Thread</DialogTitle>
          <DialogDescription className="sr-only">Create a Question or Hypothesis Thread.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex gap-2">
            <Button variant={kind === 'question' ? 'default' : 'outline'} size="sm" onClick={() => setKind('question')}>Question</Button>
            <Button variant={kind === 'hypothesis' ? 'default' : 'outline'} size="sm" onClick={() => setKind('hypothesis')}>Hypothesis</Button>
          </div>
          <div className="space-y-1.5">
            <Label>Statement <span className="text-destructive">*</span></Label>
            <Textarea
              value={statement}
              onChange={e => setStatement(e.target.value)}
              placeholder={kind === 'question' ? 'What is the current question?' : 'What is the proposed claim?'}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={creating}>{creating ? 'Creating…' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ThreadDetailPanel({ projectId, detail, iterationHistory, allThreads, notes, onChanged }: {
  projectId: string
  detail: InquiryThreadDetail
  iterationHistory: InquiryIteration[]
  allThreads: InquiryThread[]
  notes: NoteSummary[]
  onChanged: () => Promise<void>
}) {
  const [changeSummary, setChangeSummary] = useState('')
  const [answerState, setAnswerState] = useState(detail.question_state?.answer_state ?? 'open')
  const [answerSummary, setAnswerSummary] = useState(detail.question_state?.current_answer_summary ?? '')
  const [evaluationState, setEvaluationState] = useState(detail.hypothesis_state?.evaluation_state ?? 'untested')
  const [confidence, setConfidence] = useState(detail.hypothesis_state?.confidence ?? 0)
  const [nextFocusKind, setNextFocusKind] = useState<InquiryNextFocusKind | ''>(detail.next_focus_kind ?? '')
  const [savingIteration, setSavingIteration] = useState(false)
  const [priority, setPriority] = useState(detail.priority)
  const [attentionState, setAttentionState] = useState(detail.attention_state)
  const [blockedReason, setBlockedReason] = useState(detail.blocked_reason ?? '')
  const [savingWork, setSavingWork] = useState(false)
  const [noteObjectId, setNoteObjectId] = useState('')
  const [relationTarget, setRelationTarget] = useState('')
  const [relationKind, setRelationKind] = useState('related_to')
  const [primaryParentId, setPrimaryParentId] = useState(detail.primary_parent_id ?? '')
  const [revisedStatement, setRevisedStatement] = useState(detail.statement)
  const [revisionKind, setRevisionKind] = useState('wording_only')
  const [structureAction, setStructureAction] = useState('narrow')
  const [savingDefinition, setSavingDefinition] = useState(false)
  const [savingLifecycle, setSavingLifecycle] = useState(false)

  useEffect(() => {
    setAnswerState(detail.question_state?.answer_state ?? 'open')
    setAnswerSummary(detail.question_state?.current_answer_summary ?? '')
    setEvaluationState(detail.hypothesis_state?.evaluation_state ?? 'untested')
    setConfidence(detail.hypothesis_state?.confidence ?? 0)
    setNextFocusKind(detail.next_focus_kind ?? '')
    setPriority(detail.priority)
    setAttentionState(detail.attention_state)
    setBlockedReason(detail.blocked_reason ?? '')
    setPrimaryParentId(detail.primary_parent_id ?? '')
    setRevisedStatement(detail.statement)
  }, [detail])

  async function recordIteration() {
    if (!changeSummary.trim()) { toast.error('A change summary is required to record an Iteration'); return }
    setSavingIteration(true)
    try {
      const body: Record<string, unknown> = {
        change_summary: changeSummary.trim(),
        confirmed_next_focus: nextFocusKind || undefined,
      }
      if (detail.kind === 'question') {
        body.answer_state = answerState
        body.current_answer_summary = answerSummary
      } else {
        body.evaluation_state = evaluationState
        body.confidence = confidence
      }
      await inquiryApi.recordIteration(projectId, detail.id, body)
      setChangeSummary('')
      toast.success('Iteration recorded')
      await onChanged()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingIteration(false)
    }
  }

  async function saveWork() {
    setSavingWork(true)
    try {
      const result = await inquiryApi.updateWork(projectId, detail.id, {
        priority,
        attention_state: attentionState,
        next_focus_kind: blockedReason.trim() ? null : nextFocusKind || null,
        blocked_reason: blockedReason || null,
      })
      if (result.wip_limit_exceeded) toast.warning('Shared Focus WIP limit exceeded — consider moving another Thread to Monitoring')
      await onChanged()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingWork(false)
    }
  }

  async function linkNote() {
    if (!noteObjectId.trim()) return
    try {
      await inquiryApi.linkNote(projectId, detail.id, noteObjectId.trim())
      setNoteObjectId('')
      await onChanged()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function addRelation() {
    if (!relationTarget) return
    try {
      await inquiryApi.addRelation(projectId, { from_thread_id: detail.id, to_thread_id: relationTarget, relation_kind: relationKind })
      await onChanged()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function savePrimaryParent() {
    try {
      await inquiryApi.setPrimaryParent(projectId, detail.id, primaryParentId || null)
      await onChanged()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function reviseDefinition() {
    if (!revisedStatement.trim()) { toast.error('A revised statement is required'); return }
    setSavingDefinition(true)
    try {
      await inquiryApi.reviseDefinition(projectId, detail.id, {
        revision_kind: revisionKind,
        new_statement: revisedStatement.trim(),
        ...(revisionKind === 'semantic_change' ? { structure_action: structureAction } : {}),
      })
      await onChanged()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingDefinition(false)
    }
  }

  async function transitionLifecycle(status: 'active' | 'resolved' | 'rejected' | 'archived') {
    const reason = window.prompt(`Reason for marking this Thread ${status} (optional)`) ?? undefined
    setSavingLifecycle(true)
    try {
      await inquiryApi.transitionLifecycle(projectId, detail.id, status, reason)
      await onChanged()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setSavingLifecycle(false)
    }
  }

  const otherThreads = allThreads.filter(t => t.id !== detail.id)

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{detail.kind}</Badge>
          <Badge variant="outline">{detail.lifecycle_status}</Badge>
          <Badge variant="secondary">v{detail.version}</Badge>
        </div>
        <p className="text-base font-medium">{detail.statement}</p>
        {detail.kind === 'question' && detail.question_state && (
          <p className="text-sm text-muted-foreground">Answer ({detail.question_state.answer_state}): {detail.question_state.current_answer_summary || '—'}</p>
        )}
        {detail.kind === 'hypothesis' && detail.hypothesis_state && (
          <p className="text-sm text-muted-foreground">
            Evaluation: {detail.hypothesis_state.evaluation_state} {detail.hypothesis_state.confidence !== null ? `(confidence ${detail.hypothesis_state.confidence})` : ''}
          </p>
        )}
        {detail.next_focus_kind && <p className="text-xs text-accent-foreground">Next focus: {detail.next_focus_kind}</p>}
        {detail.blocked_reason && <p className="text-xs text-destructive">Blocked: {detail.blocked_reason}</p>}
      </Card>

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-semibold">Record Iteration</h2>
        {detail.kind === 'question'
          ? (
            <>
              <Select ariaLabel="Answer state" value={answerState} onChange={v => setAnswerState(v as typeof answerState)} options={[
                { value: 'open', label: 'Open' }, { value: 'partial', label: 'Partial' },
                { value: 'answered', label: 'Answered' }, { value: 'unanswerable', label: 'Unanswerable' },
              ]} />
              <Textarea value={answerSummary} onChange={e => setAnswerSummary(e.target.value)} placeholder="Current answer summary" rows={2} />
            </>
          )
          : (
            <>
              <Select ariaLabel="Evaluation state" value={evaluationState} onChange={v => setEvaluationState(v as typeof evaluationState)} options={[
                { value: 'untested', label: 'Untested' }, { value: 'supported', label: 'Supported' },
                { value: 'challenged', label: 'Challenged' }, { value: 'contradicted', label: 'Contradicted' },
                { value: 'inconclusive', label: 'Inconclusive' },
              ]} />
              <Input type="number" min={0} max={100} value={confidence} onChange={e => setConfidence(Number(e.target.value))} placeholder="Confidence (0-100)" />
            </>
          )}
        <Select ariaLabel="Confirmed next focus" value={nextFocusKind} onChange={v => setNextFocusKind(v as InquiryNextFocusKind)} options={[{ value: '', label: 'No change to Next Focus' }, ...NEXT_FOCUS_OPTIONS]} />
        <Textarea value={changeSummary} onChange={e => setChangeSummary(e.target.value)} placeholder="What changed and why? (required)" rows={2} />
        <Button onClick={recordIteration} disabled={savingIteration} size="sm">{savingIteration ? 'Recording…' : 'Record Iteration'}</Button>
      </Card>

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-semibold">Work state</h2>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Priority</Label>
            <Input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} />
          </div>
          <div>
            <Label>Attention</Label>
            <Select ariaLabel="Attention state" value={attentionState} onChange={v => setAttentionState(v as typeof attentionState)} options={ATTENTION_OPTIONS} />
          </div>
        </div>
        <Textarea value={blockedReason} onChange={e => setBlockedReason(e.target.value)} placeholder="Blocked/waiting reason (when set, this replaces Next Focus)" rows={2} />
        <Button onClick={saveWork} disabled={savingWork} size="sm" variant="outline">{savingWork ? 'Saving…' : 'Save work state'}</Button>
      </Card>

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-semibold">Definition and structure</h2>
        <Textarea value={revisedStatement} onChange={e => setRevisedStatement(e.target.value)} rows={2} />
        <div className="flex flex-wrap gap-2">
          <Select ariaLabel="Revision kind" value={revisionKind} onChange={setRevisionKind} options={[
            { value: 'wording_only', label: 'Wording only' },
            { value: 'semantic_change', label: 'Semantic change' },
          ]} />
          {revisionKind === 'semantic_change' && (
            <Select ariaLabel="Structure action" value={structureAction} onChange={setStructureAction} options={[
              { value: 'narrow', label: 'Narrow in place' },
              { value: 'child', label: 'Create child Thread' },
              { value: 'supersede', label: 'Supersede with new Thread' },
            ]} />
          )}
          <Button size="sm" variant="outline" onClick={reviseDefinition} disabled={savingDefinition || detail.lifecycle_status !== 'active'}>
            {savingDefinition ? 'Revising…' : 'Revise definition'}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Select
            ariaLabel="Primary parent"
            value={primaryParentId}
            onChange={setPrimaryParentId}
            options={[{ value: '', label: 'No primary parent' }, ...otherThreads.map(t => ({ value: t.id, label: t.statement.slice(0, 40) }))]}
          />
          <Button size="sm" variant="outline" onClick={savePrimaryParent}>Save primary parent</Button>
        </div>
      </Card>

      <Card className="p-4 space-y-2">
        <h2 className="text-sm font-semibold">Lifecycle</h2>
        <div className="flex flex-wrap gap-2">
          {detail.lifecycle_status === 'active'
            ? (
              <>
                <Button size="sm" variant="outline" disabled={savingLifecycle} onClick={() => transitionLifecycle('resolved')}>Resolve</Button>
                <Button size="sm" variant="outline" disabled={savingLifecycle} onClick={() => transitionLifecycle('rejected')}>Reject</Button>
                <Button size="sm" variant="outline" disabled={savingLifecycle} onClick={() => transitionLifecycle('archived')}>Archive</Button>
              </>
            )
            : detail.lifecycle_status !== 'superseded' && (
              <Button size="sm" variant="outline" disabled={savingLifecycle} onClick={() => transitionLifecycle('active')}>Reopen</Button>
            )}
        </div>
      </Card>

      <Card className="p-4 space-y-2">
        <h2 className="text-sm font-semibold">Notes</h2>
        {detail.note_links.map(link => <p key={link.id} className="text-xs text-muted-foreground">{link.link_kind}: {notes.find(note => note.id === link.note_object_id)?.title ?? 'Linked note'}</p>)}
        <div className="flex gap-2">
          <Select ariaLabel="Note to link" value={noteObjectId} onChange={setNoteObjectId} options={[
            { value: '', label: notes.length ? 'Select a Project note' : 'No Project notes available' },
            ...notes.map(note => ({ value: note.id, label: note.title })),
          ]} />
          <Button size="sm" variant="outline" onClick={linkNote}>Link</Button>
        </div>
      </Card>

      <Card className="p-4 space-y-2">
        <h2 className="text-sm font-semibold">Decisions</h2>
        {(detail.decision_cases?.length ?? 0) === 0
          ? <p className="text-xs text-muted-foreground">No Decision Cases reference this Thread.</p>
          : <div className="flex flex-wrap gap-2">{detail.decision_cases?.map(item => <Button key={item.id} size="sm" variant="outline" asChild><Link to={`/projects/${projectId}/decisions?open=${item.id}`}>{item.title} · {item.status}</Link></Button>)}</div>}
      </Card>

      <Card className="p-4 space-y-2">
        <h2 className="text-sm font-semibold">Relations</h2>
        {detail.relations.map(r => (
          <p key={r.id} className="text-xs text-muted-foreground">
            {r.from_thread_id === detail.id ? `→ ${r.relation_kind} → ${r.to_thread_id}` : `${r.from_thread_id} → ${r.relation_kind} →`}
          </p>
        ))}
        {otherThreads.length > 0 && (
          <div className="flex gap-2 items-end flex-wrap">
            <Select ariaLabel="Relation kind" value={relationKind} onChange={setRelationKind} options={[
              { value: 'related_to', label: 'related_to' }, { value: 'depends_on', label: 'depends_on' },
              { value: 'supports', label: 'supports' }, { value: 'contradicts', label: 'contradicts' },
              { value: 'decomposes_into', label: 'decomposes_into' }, { value: 'proposes', label: 'proposes' },
            ]} />
            <Select ariaLabel="Relation target" value={relationTarget} onChange={setRelationTarget} options={[{ value: '', label: 'Select a Thread…' }, ...otherThreads.map(t => ({ value: t.id, label: t.statement.slice(0, 40) }))]} />
            <Button size="sm" variant="outline" onClick={addRelation}>Add relation</Button>
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-2">
        <h2 className="text-sm font-semibold">Iteration history</h2>
        {iterationHistory.length === 0 && <p className="text-xs text-muted-foreground">No confirmed Iterations yet.</p>}
        {iterationHistory.map(it => (
          <div key={it.id} className="text-xs border-l-2 border-border pl-2 py-1">
            <p className="font-medium">{it.change_summary}</p>
            <p className="text-muted-foreground">{new Date(it.created_at).toLocaleString()}</p>
          </div>
        ))}
      </Card>
    </div>
  )
}
