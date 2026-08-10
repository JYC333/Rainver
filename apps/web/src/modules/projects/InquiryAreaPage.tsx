import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import {
  inquiryApi, notesApi, projectsApi, projectResearchApi, spacesApi,
} from '../../api/client'
import { errMsg } from '../../lib/utils'
import { currentPendingContextVersion } from './currentPendingContextVersion'
import type {
  InquiryCandidate, InquiryEvidenceSignal, InquiryIteration, InquiryThread, InquiryThreadAdvice,
  InquiryThreadDetail, NoteSummary, Project, ProjectBriefVersion, ProjectCorpusItem,
  ProjectResearchWorkflow, SpaceMember,
} from '../../types/api'
import { Button } from '../../components/ui/button'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog'
import { AdvanceCard } from './inquiryArea/AdvanceCard'
import { MapView } from './inquiryArea/MapView'
import { ReviewView } from './inquiryArea/ReviewView'
import { ThreadHeader } from './inquiryArea/ThreadHeader'
import { ThreadNavigator } from './inquiryArea/ThreadNavigator'
import { ThreadTabs } from './inquiryArea/ThreadTabs'
import { CreateThreadDialog } from './inquiryArea/dialogs'
import { draftWorkflowFor, isQuestionRefined, startedWorkflowFor, type ThreadTabId } from './inquiryArea/nextFocus'
import { useDeclareProjectCaptureTarget } from './notes/projectCaptureTarget'

type ViewId = 'focus' | 'map' | 'review'

const VIEWS: ViewId[] = ['focus', 'map', 'review']
const EMPTY_CORPUS = new Map<string, ProjectCorpusItem>()

export default function InquiryAreaPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { activeSpaceId, spaces, userId } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [project, setProject] = useState<Project | null>(null)
  const [briefVersion, setBriefVersion] = useState<ProjectBriefVersion | null>(null)
  const [threads, setThreads] = useState<InquiryThread[]>([])
  const [personalFocus, setPersonalFocus] = useState<InquiryThread[]>([])
  const [wipLimit, setWipLimit] = useState(3)
  const [candidates, setCandidates] = useState<InquiryCandidate[]>([])
  const [deferredCandidates, setDeferredCandidates] = useState<InquiryCandidate[]>([])
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [members, setMembers] = useState<SpaceMember[]>([])
  const [researchWorkflows, setResearchWorkflows] = useState<ProjectResearchWorkflow[]>([])
  const [loading, setLoading] = useState(true)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<InquiryThreadDetail | null>(null)
  const [iterations, setIterations] = useState<InquiryIteration[]>([])
  const [signals, setSignals] = useState<InquiryEvidenceSignal[]>([])
  const [advice, setAdvice] = useState<InquiryThreadAdvice | null>(null)
  // Keyed by Project: this route keeps its component instance when the
  // Project changes, so an unkeyed cache would keep serving the previous
  // Project's titles.
  const [corpus, setCorpus] = useState<{ projectId: string; items: Map<string, ProjectCorpusItem> } | null>(null)

  // What this Area is currently about, so a capture made from here hangs on the
  // Thread rather than falling into the Project inbox (U11).
  useDeclareProjectCaptureTarget(detail ? { objectId: detail.id, title: detail.statement } : null)

  const [threadTab, setThreadTab] = useState<ThreadTabId>('evidence')
  const [createOpen, setCreateOpen] = useState(false)
  const [createKind, setCreateKind] = useState<'question' | 'hypothesis'>('question')
  const [goalDialogOpen, setGoalDialogOpen] = useState(false)
  const [searchIntent, setSearchIntent] = useState(false)

  const view: ViewId = VIEWS.includes(searchParams.get('view') as ViewId)
    ? searchParams.get('view') as ViewId
    : 'focus'

  const setView = useCallback((next: ViewId) => {
    setSearchParams(current => {
      const params = new URLSearchParams(current)
      if (next === 'focus') params.delete('view')
      else params.set('view', next)
      return params
    }, { replace: true })
  }, [setSearchParams])

  // Best-effort and separate from the main load: whether a Thread has a
  // evidence search isn't part of the Inquiry read model, and a failure
  // here must not block Thread loading.
  useEffect(() => {
    if (!projectId) return
    void projectResearchApi.workflows(projectId).then(setResearchWorkflows).catch(() => setResearchWorkflows([]))
  }, [projectId])

  useEffect(() => {
    if (!activeSpaceId) return
    void spacesApi.members(activeSpaceId).then(setMembers).catch(() => setMembers([]))
  }, [activeSpaceId])

  const loadProjectScope = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [proj, brief, list, focus, pending, deferred, notePage] = await Promise.all([
        projectsApi.get(projectId),
        projectsApi.getActiveBriefVersion(projectId),
        inquiryApi.listThreads(projectId),
        inquiryApi.getFocus(projectId),
        inquiryApi.listCandidates(projectId),
        inquiryApi.listCandidates(projectId, 'deferred'),
        notesApi.list({ project_id: projectId, status: 'active', limit: 100 }),
      ])
      setProject(proj)
      setBriefVersion(brief)
      setThreads(list)
      setPersonalFocus(focus.personal_focus)
      setWipLimit(focus.shared_focus_wip_limit)
      setCandidates(pending)
      setDeferredCandidates(deferred)
      setNotes(notePage.items)
      setSelectedId(current => current ?? list[0]?.id ?? null)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void loadProjectScope() }, [loadProjectScope])

  const loadThreadScope = useCallback(async () => {
    if (!projectId || !selectedId) {
      setDetail(null)
      setIterations([])
      setSignals([])
      setAdvice(null)
      return
    }
    try {
      const [nextDetail, nextIterations, nextSignals] = await Promise.all([
        inquiryApi.getThread(projectId, selectedId),
        inquiryApi.listIterations(projectId, selectedId),
        inquiryApi.listSignals(projectId, selectedId),
      ])
      setDetail(nextDetail)
      setIterations(nextIterations)
      setSignals(nextSignals)
    } catch (error) {
      toast.error(errMsg(error))
    }
    // Advice is an aid, not part of the Thread read model: a failure here must
    // not blank out the Thread the user came to work on.
    try {
      setAdvice(await inquiryApi.getAdvice(projectId, selectedId))
    } catch {
      setAdvice(null)
    }
  }, [projectId, selectedId])

  useEffect(() => { void loadThreadScope() }, [loadThreadScope])

  // Corpus titles turn Signal rows from opaque ids into readable evidence, so
  // fetch it only once and only when a Thread actually has Signals.
  useEffect(() => {
    if (!projectId || signals.length === 0 || corpus?.projectId === projectId) return
    void projectsApi.corpus(projectId, { limit: 200 })
      .then(page => setCorpus({ projectId, items: new Map(page.items.map(item => [item.id, item])) }))
      .catch(() => undefined)
  }, [corpus?.projectId, projectId, signals.length])

  const selectThread = useCallback((id: string) => {
    setSelectedId(id)
    setView('focus')
  }, [setView])

  // Inbound deep links from other Areas. Every parameter is consumed in one
  // atomic rewrite: separate `setSearchParams` calls in a single effect batch
  // overwrite each other, which would silently drop the view switch.
  useEffect(() => {
    const params = new URLSearchParams(searchParams)
    let changed = false
    const consume = (key: string) => { params.delete(key); changed = true }

    if (searchParams.get('new') === 'hypothesis') {
      setCreateKind('hypothesis')
      setCreateOpen(true)
      consume('new')
    }
    if (searchParams.get('setup') === 'goal') {
      setGoalDialogOpen(true)
      consume('setup')
    }
    if (searchParams.get('research_intent') === '1') {
      setSearchIntent(true)
      consume('research_intent')
    }
    const threadParam = searchParams.get('thread')
    if (threadParam) {
      setSelectedId(threadParam)
      consume('thread')
    }
    if (searchParams.get('candidate')) {
      params.set('view', 'review')
      consume('candidate')
    }
    if (changed) setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  const refresh = useCallback(async () => {
    await Promise.all([loadProjectScope(), loadThreadScope()])
  }, [loadProjectScope, loadThreadScope])

  const startedWorkflow = useMemo(
    () => (detail ? startedWorkflowFor(detail.id, researchWorkflows) : null),
    [detail, researchWorkflows],
  )
  const questionRefined = useMemo(
    () => (detail ? isQuestionRefined(draftWorkflowFor(detail.id, researchWorkflows)) : false),
    [detail, researchWorkflows],
  )
  const pendingForThread = detail ? candidates.filter(candidate => candidate.thread_id === detail.id) : []

  if (!projectId) return null

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/projects/${projectId}`}><ArrowLeft className="size-4" /></Link>
        </Button>
        <div>
          <h1 className="text-lg font-semibold">Inquiry</h1>
          <p className="text-xs text-muted-foreground">{project?.name ?? 'Loading…'}</p>
        </div>
        <div className="flex-1" />
        <Tabs value={view} onValueChange={value => setView(value as ViewId)}>
          <TabsList>
            <TabsTrigger value="focus">Focus</TabsTrigger>
            <TabsTrigger value="map">Map</TabsTrigger>
            <TabsTrigger value="review">
              Review{candidates.length > 0 ? ` (${candidates.length})` : ''}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button onClick={() => { setCreateKind('question'); setCreateOpen(true) }}>
          <Plus className="size-4" />New Thread
        </Button>
      </div>

      {searchIntent && view === 'focus' && (
        <div className="flex items-center gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
          <p className="flex-1 text-sm">
            Pick the Question or Hypothesis you want to search for, then use its next step to start evidence collection.
          </p>
          <Button size="sm" variant="ghost" onClick={() => setSearchIntent(false)} aria-label="Dismiss">
            <X className="size-4" />
          </Button>
        </div>
      )}

      {view === 'focus' && (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <div>
            {loading
              ? <p className="text-sm text-muted-foreground">Loading…</p>
              : (
                <ThreadNavigator
                  threads={threads}
                  personalFocus={personalFocus}
                  wipLimit={wipLimit}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              )}
          </div>
          <div className="space-y-4">
            {detail
              ? (
                <>
                  <ThreadHeader projectId={projectId} detail={detail} members={members} onChanged={refresh} />
                  <AdvanceCard
                    projectId={projectId}
                    detail={detail}
                    signals={signals}
                    pendingCandidateCount={pendingForThread.length}
                    startedWorkflow={startedWorkflow}
                    questionRefined={questionRefined}
                    advice={advice}
                    onOpenTab={setThreadTab}
                    onChanged={refresh}
                  />
                  {pendingForThread.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setView('review')}
                      className="flex w-full items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-left text-sm"
                    >
                      <span className="flex-1">
                        {pendingForThread.length === 1
                          ? '1 material change on this Thread awaits your decision.'
                          : `${pendingForThread.length} material changes on this Thread await your decision.`}
                      </span>
                      <span className="text-xs underline">Go to Review</span>
                    </button>
                  )}
                  <ThreadTabs
                    projectId={projectId}
                    detail={detail}
                    allThreads={threads}
                    notes={notes}
                    signals={signals}
                    corpus={corpus?.items ?? EMPTY_CORPUS}
                    iterations={iterations}
                    activeTab={threadTab}
                    onTabChange={setThreadTab}
                    onChanged={refresh}
                  />
                </>
              )
              : <p className="text-sm text-muted-foreground">Select a Thread to see its detail.</p>}
          </div>
        </div>
      )}

      {view === 'map' && (
        <MapView
          projectId={projectId}
          threads={threads}
          candidates={candidates}
          selectedId={selectedId}
          onSelect={selectThread}
        />
      )}

      {view === 'review' && (
        <ReviewView
          projectId={projectId}
          threads={threads}
          candidates={candidates}
          deferredCandidates={deferredCandidates}
          onOpenThread={selectThread}
          onChanged={refresh}
        />
      )}

      <CreateThreadDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async id => { setCreateOpen(false); await loadProjectScope(); setSelectedId(id); setView('focus') }}
        projectId={projectId}
        defaultKind={createKind}
      />

      <GoalEditDialog
        open={goalDialogOpen}
        onOpenChange={setGoalDialogOpen}
        projectId={projectId}
        briefVersion={briefVersion}
        canPublish={project?.current_user_can_approve_context === true || project?.owner_user_id === userId || ['owner', 'admin'].includes(spaces.find(space => space.id === activeSpaceId)?.role ?? '')}
        onSaved={async () => { setGoalDialogOpen(false); await loadProjectScope() }}
      />
    </div>
  )
}

/**
 * The Project goal lives on the Overview, but the setup checklist deep-links
 * here to fill it in, so this Area keeps the editor without giving the goal a
 * permanent card that competes with Thread work.
 */
function GoalEditDialog({ open, onOpenChange, projectId, briefVersion, canPublish, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  briefVersion: ProjectBriefVersion | null
  canPublish: boolean
  onSaved: () => void
}) {
  const [goal, setGoal] = useState(briefVersion?.goal ?? '')
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<ProjectBriefVersion | null>(null)
  const [correctionSource, setCorrectionSource] = useState<ProjectBriefVersion | null>(null)

  useEffect(() => {
    if (!open) return
    setGoal(briefVersion?.goal ?? '')
    setDraft(null)
    setCorrectionSource(null)
    void projectsApi.listBriefVersions(projectId)
      .then(versions => {
        const pending = currentPendingContextVersion(versions)
        setDraft(pending)
        if (pending) setGoal(pending.goal ?? '')
      })
      .catch(error => toast.error(errMsg(error)))
  }, [open, briefVersion, projectId])

  async function save() {
    setSaving(true)
    try {
      // Brief Versions are immutable snapshots — carry the rest of the version
      // being corrected (or the active version for a fresh edit) so editing the goal cannot blank out
      // scope/success/constraints/assumptions set by an earlier version.
      const source = correctionSource ?? briefVersion
      const created = await projectsApi.createBriefVersion(projectId, {
        goal: goal.trim() || null,
        scope_included: source?.scope_included ?? null,
        scope_excluded: source?.scope_excluded ?? null,
        success_definition: source?.success_definition ?? null,
        constraints: source?.constraints ?? null,
        assumptions: source?.assumptions ?? null,
        confirmed_decisions: source?.confirmed_decisions ?? [],
        workspace_identity: source?.workspace_identity ?? {},
        workspace_boundary: source?.workspace_boundary ?? {},
        source_refs: source?.source_refs ?? [],
      })
      setDraft(created)
      setCorrectionSource(null)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  async function transition(publish: boolean) {
    if (!draft) return
    setSaving(true)
    try {
      const updated = publish
        ? await projectsApi.publishBrief(projectId, draft.id)
        : await projectsApi.submitBriefForReview(projectId, draft.id)
      setDraft(updated)
      if (updated.status === 'published') onSaved()
    } catch (error) { toast.error(errMsg(error)) } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit project goal</DialogTitle>
          <DialogDescription>
            The goal is the project&apos;s durable why. Inquiry Threads are where that goal gets pursued question by question.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label>Goal</Label>
          <Textarea value={goal} onChange={event => setGoal(event.target.value)} disabled={Boolean(draft)} placeholder="What is this project ultimately trying to achieve?" rows={4} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {draft && <Button variant="outline" onClick={() => { setCorrectionSource(draft); setDraft(null); setGoal(draft.goal ?? '') }} disabled={saving}>Create corrected version</Button>}
          {!draft && <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>}
          {draft?.status === 'draft' && <Button onClick={() => void transition(false)} disabled={saving}>Submit for review</Button>}
          {draft?.status === 'in_review' && canPublish && <Button onClick={() => void transition(true)} disabled={saving}>Publish</Button>}
          {draft?.status === 'in_review' && !canPublish && <span className="text-sm text-muted-foreground">Awaiting Project owner review</span>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
