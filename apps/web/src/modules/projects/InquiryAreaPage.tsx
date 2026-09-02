import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useSpace } from '../../contexts/SpaceContext'
import {
  inquiryApi, notesApi, projectsApi, projectResearchApi, spacesApi,
} from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  InquiryCandidate, InquiryEvidenceSignal, InquiryIteration, InquiryThread, InquiryThreadAdvice,
  InquiryThreadDetail, InquiryThreadStep, NoteSummary, Project, ProjectCorpusItem,
  ProjectResearchWorkflow, SpaceMember,
} from '../../types/api'
import { Button } from '../../components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { StageWorkspace } from './inquiryArea/StageWorkspace'
import { MapView } from './inquiryArea/MapView'
import { ReviewView } from './inquiryArea/ReviewView'
import { ThreadHeader } from './inquiryArea/ThreadHeader'
import { ThreadNavigator } from './inquiryArea/ThreadNavigator'
import { ThreadTabs } from './inquiryArea/ThreadTabs'
import { CreateThreadDialog } from './inquiryArea/dialogs'
import { draftWorkflowFor, isQuestionRefined, startedWorkflowFor, type ThreadTabId } from './inquiryArea/nextFocus'
import { deriveStages } from './inquiryArea/stages'
import { useDeclareProjectCaptureTarget } from '../../contexts/CaptureContext'
import KnowledgeReviewPage from './KnowledgeReviewPage'
import ExperimentAreaPage from './ExperimentAreaPage'

type ViewId = 'focus' | 'map' | 'review' | 'experiments'

const VIEWS: ViewId[] = ['focus', 'map', 'review', 'experiments']
const EMPTY_CORPUS = new Map<string, ProjectCorpusItem>()

export default function InquiryAreaPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { activeSpaceId } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [project, setProject] = useState<Project | null>(null)
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
  const [steps, setSteps] = useState<InquiryThreadStep[]>([])
  const [signals, setSignals] = useState<InquiryEvidenceSignal[]>([])
  const [advice, setAdvice] = useState<InquiryThreadAdvice | null>(null)
  const threadScopeGeneration = useRef(0)
  const selectedThreadScope = `${projectId ?? ''}:${selectedId ?? ''}`
  const selectedThreadScopeRef = useRef(selectedThreadScope)
  selectedThreadScopeRef.current = selectedThreadScope
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

  const loadResearchWorkflows = useCallback(async () => {
    if (!projectId) return
    try {
      setResearchWorkflows(await projectResearchApi.workflows(projectId))
    } catch { /* Keep the last successful snapshot; active work may still be running. */ }
  }, [projectId])

  // Best-effort and separate from the main load: whether a Thread has an
  // evidence search isn't part of the Inquiry read model, and a failure here
  // must not block Thread loading.
  useEffect(() => {
    // A previous Project's snapshot is not useful, but a transient failure
    // while refreshing this Project must not turn active work into idle work.
    setResearchWorkflows([])
    void loadResearchWorkflows()
  }, [loadResearchWorkflows])

  useEffect(() => {
    if (!activeSpaceId) return
    void spacesApi.members(activeSpaceId).then(setMembers).catch(() => setMembers([]))
  }, [activeSpaceId])

  const loadProjectScope = useCallback(async (showLoading = true) => {
    if (!projectId) return
    if (showLoading) setLoading(true)
    try {
      const [proj, list, focus, pending, deferred, notePage] = await Promise.all([
        projectsApi.get(projectId),
        inquiryApi.listThreads(projectId),
        inquiryApi.getFocus(projectId),
        inquiryApi.listCandidates(projectId),
        inquiryApi.listCandidates(projectId, 'deferred'),
        notesApi.list({ project_id: projectId, status: 'active', limit: 100 }),
      ])
      setProject(proj)
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
      if (showLoading) setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void loadProjectScope() }, [loadProjectScope])

  const loadThreadScope = useCallback(async () => {
    const generation = ++threadScopeGeneration.current
    const scope = `${projectId ?? ''}:${selectedId ?? ''}`
    const isCurrent = () => generation === threadScopeGeneration.current
      && scope === selectedThreadScopeRef.current
    if (!projectId || !selectedId) {
      setDetail(null)
      setIterations([])
      setSteps([])
      setSignals([])
      setAdvice(null)
      return
    }
    try {
      const [nextDetail, nextIterations, nextSteps, nextSignals] = await Promise.all([
        inquiryApi.getThread(projectId, selectedId),
        inquiryApi.listIterations(projectId, selectedId),
        inquiryApi.listSteps(projectId, selectedId),
        inquiryApi.listSignals(projectId, selectedId),
      ])
      if (!isCurrent()) return
      setDetail(nextDetail)
      setIterations(nextIterations)
      setSteps(nextSteps)
      setSignals(nextSignals)
    } catch (error) {
      if (isCurrent()) toast.error(errMsg(error))
      return
    }
    // Advice is an aid, not part of the Thread read model: a failure here must
    // not blank out the Thread the user came to work on.
    try {
      const nextAdvice = await inquiryApi.getAdvice(projectId, selectedId)
      if (isCurrent()) setAdvice(nextAdvice)
    } catch {
      if (isCurrent()) setAdvice(null)
    }
  }, [projectId, selectedId])

  useEffect(() => {
    void loadThreadScope()
    // Invalidate every request owned by the Thread being left before the next
    // effect starts. An older poll must never repoint B's workspace back to A.
    return () => { threadScopeGeneration.current += 1 }
  }, [loadThreadScope])

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

  const refreshInFlight = useRef(new Map<string, { promise: Promise<void>; queued: boolean }>())
  const refresh = useCallback(async () => {
    const scope = `${projectId ?? ''}:${selectedId ?? ''}`
    const existing = refreshInFlight.current.get(scope)
    if (existing) {
      existing.queued = true
      return existing.promise
    }
    const flight = { promise: Promise.resolve(), queued: false }
    const request = (async () => {
      do {
        flight.queued = false
        await Promise.all([
          loadProjectScope(false), loadThreadScope(), loadResearchWorkflows(),
        ])
      } while (flight.queued)
    })().finally(() => {
      if (refreshInFlight.current.get(scope) === flight) refreshInFlight.current.delete(scope)
    })
    flight.promise = request
    refreshInFlight.current.set(scope, flight)
    return request
  }, [loadProjectScope, loadResearchWorkflows, loadThreadScope, projectId, selectedId])

  const startedWorkflow = useMemo(
    () => (detail ? startedWorkflowFor(detail.id, researchWorkflows) : null),
    [detail, researchWorkflows],
  )
  const questionRefined = useMemo(
    () => (detail ? isQuestionRefined(draftWorkflowFor(detail.id, researchWorkflows)) : false),
    [detail, researchWorkflows],
  )
  const pendingForThread = detail ? candidates.filter(candidate => candidate.thread_id === detail.id) : []
  const stageSummary = detail
    ? deriveStages({
      detail,
      signals,
      pendingCandidateCount: pendingForThread.length,
      startedWorkflow,
      questionRefined,
      roundSteps: steps.filter(step => step.iteration_id === null),
      closedRounds: iterations.length,
      roundStartedAt: iterations[0]?.created_at ?? null,
    })
    : null
  // Only work the server can finish on its own. A primary step stays open for
  // as long as the user holds it, so counting one kept the page polling every
  // five seconds for the rest of the round with nothing on the server able to
  // change.
  const hasLiveWork = steps.some(step => step.slot === 'background' && step.status === 'in_progress')
    || startedWorkflow !== null

  // Returning to a backgrounded tab should never leave a completed search or
  // newly generated recommendation looking stale, even when no polling loop is
  // active for this Thread.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [refresh])

  // Five seconds is a read refresh cadence only. Model analysis remains
  // event-driven on the server; idle Threads install no interval at all.
  useEffect(() => {
    if (!hasLiveWork) return
    const interval = window.setInterval(() => { void refresh() }, 5_000)
    return () => window.clearInterval(interval)
  }, [hasLiveWork, refresh])

  if (!projectId) return null

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
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
            {/* An Experiment tests a hypothesis Thread and reports back into
                Inquiry; it was a separate Area only by accident of history. */}
            <TabsTrigger value="experiments">Experiments</TabsTrigger>
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
                  <ThreadHeader
                    projectId={projectId}
                    detail={detail}
                    members={members}
                    round={stageSummary?.round ?? iterations.length + 1}
                    allowEarlyClose={stageSummary?.current !== 'land'}
                    onChanged={refresh}
                  />
                  <StageWorkspace
                    projectId={projectId}
                    detail={detail}
                    signals={signals}
                    pendingCandidateCount={pendingForThread.length}
                    startedWorkflow={startedWorkflow}
                    questionRefined={questionRefined}
                    advice={advice}
                    steps={steps}
                    closedRounds={iterations.length}
                    roundStartedAt={iterations[0]?.created_at ?? null}
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
        <Tabs
          value={searchParams.get('tab') === 'candidates' ? 'candidates' : 'inquiry'}
          onValueChange={value => {
            const params = new URLSearchParams(searchParams)
            if (value === 'candidates') params.set('tab', 'candidates')
            else params.delete('tab')
            setSearchParams(params, { replace: true })
          }}
        >
          {/* Two review queues, one place. Knowledge candidates were a separate
              Area whose page linked back here; they are what Review is for. */}
          <TabsList className="mb-3">
            <TabsTrigger value="inquiry">Inquiry</TabsTrigger>
            <TabsTrigger value="candidates">Knowledge candidates</TabsTrigger>
          </TabsList>
          <TabsContent value="inquiry">
            <ReviewView
              projectId={projectId}
              threads={threads}
              candidates={candidates}
              deferredCandidates={deferredCandidates}
              onOpenThread={selectThread}
              onChanged={refresh}
            />
          </TabsContent>
          <TabsContent value="candidates">
            <KnowledgeReviewPage embedded />
          </TabsContent>
        </Tabs>
      )}

      {view === 'experiments' && <ExperimentAreaPage embedded />}

      <CreateThreadDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async id => { setCreateOpen(false); await loadProjectScope(); setSelectedId(id); setView('focus') }}
        projectId={projectId}
        defaultKind={createKind}
      />

    </div>
  )
}

/**
 * The Project goal lives on the Overview, but Pulse's goal prompt deep-links
 * here to fill it in, so this Area keeps the editor without giving the goal a
 * permanent card that competes with Thread work.
 */
