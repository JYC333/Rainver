import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useSpaceNavigate } from '../../core/spaceNav'
import {
  inquiryApi, projectResearchApi, projectsApi, providersApi, sourcesApi,
} from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  InquiryThread, Project, ProjectOperation, ProjectResearchCheckpoint,
  ProjectResearchEvidenceMatrixItem, ProjectResearchInitialIntakeInput, ProjectResearchQuestionResolutionStrategy,
  ProjectResearchReport, ProjectResearchScanSummary, ProjectResearchWorkflow, ProjectSourceBinding,
  SourceChannel, SourceItem,
} from '../../types/api'
import type { FocusResearchWorkbenchProps } from './FocusResearchWorkbench'
import { numberValue, objectValue, researchOperationStage } from './FocusResearchWorkbench'
import { isResearchHumanReviewCheckpoint, researchCheckpointLabel, researchReviewToastId } from './researchReviewAttention'
import { researchSetupDraftFromWorkflow } from './researchSetupDraft'
import { researchWorkflowForDisplayFrom } from './researchWorkflowView'

function researchWorkflowThreadId(workflow: ProjectResearchWorkflow): string | null {
  return workflow.primary_thread_id || null
}

function researchWorkflowForThread(
  workflows: ProjectResearchWorkflow[],
  threadId: string,
): ProjectResearchWorkflow | null {
  return workflows
    .filter(workflow => workflow.status !== 'archived' && researchWorkflowThreadId(workflow) === threadId)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0] ?? null
}

function upsertById<T extends { id: string }>(current: T[], next: T): T[] {
  const index = current.findIndex(item => item.id === next.id)
  if (index === -1) return [next, ...current]
  return current.map(item => item.id === next.id ? next : item)
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return incoming.reduce((result, item) => upsertById(result, item), current)
}

/** Which research lifecycle facts a poll must react to, collapsed to a string
 *  so an unchanged poll costs nothing beyond the operations request itself. */
function researchLifecycleSignature(operations: ProjectOperation[]): string {
  return operations
    .filter(operation => operation.kind === 'research')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(operation => [
      operation.id,
      operation.status,
      String(operation.progress_json.current_stage ?? ''),
      String(operation.progress_json.failed_stage ?? ''),
      String(operation.progress_json.partial ?? ''),
    ].join(':'))
    .join('|')
}

/** Research item limit is a Research setting, independent of question and
 *  monitor setup — surfaced by the Research Area, not by Project settings. */
export interface ProjectResearchSettings {
  currentItemLimit: number | null
  hasLiveOperation: boolean
  busy: boolean
  onUpdateItemLimit: (newLimit: number) => void
  snapshot: {
    question: string
    monitors: string[]
    history: string
    maxItems: number | null
    monitoringField: string
  }
}

export interface NewSearchDialogState {
  open: boolean
  setOpen: (open: boolean) => void
  thread: InquiryThread | undefined
  workflowId: string | null
  draft: ReturnType<typeof researchSetupDraftFromWorkflow>
}

export interface ProjectResearchController {
  project: Project | null
  loading: boolean
  actionBusy: string | null
  focusProps: FocusResearchWorkbenchProps | null
  newSearch: NewSearchDialogState
  settings: ProjectResearchSettings | null
  saveInitialIntake: (config: ProjectResearchInitialIntakeInput, workflowIdOverride?: string | null) => Promise<boolean>
  startInitialIntake: (config: ProjectResearchInitialIntakeInput, workflowIdOverride?: string | null) => Promise<void>
}

/**
 * Every piece of Project Research state, its handlers, and its polling.
 *
 * This used to live inside ProjectDetailPage, which meant the Project Overview
 * fetched workflows, checkpoints, the evidence matrix, reports, scan summaries,
 * providers and Inquiry Threads on every visit in order to render a workbench
 * that the Research Area already owned a route for. Research is an Area; the
 * Overview is an aggregation layer over Areas and does not host one.
 */
export function useProjectResearch(projectId: string | undefined): ProjectResearchController {
  const navigate = useSpaceNavigate()
  const { activeSpaceId } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [project, setProject] = useState<Project | null>(null)
  const [sourceChannels, setSourceChannels] = useState<SourceChannel[]>([])
  const [sourceBindings, setSourceBindings] = useState<ProjectSourceBinding[]>([])
  const [recentSourceItems, setRecentSourceItems] = useState<SourceItem[]>([])
  const [operations, setOperations] = useState<ProjectOperation[]>([])
  const [researchWorkflows, setResearchWorkflows] = useState<ProjectResearchWorkflow[]>([])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  const [researchScanSummaries, setResearchScanSummaries] = useState<ProjectResearchScanSummary[]>([])
  const [researchCheckpoints, setResearchCheckpoints] = useState<ProjectResearchCheckpoint[]>([])
  const [evidenceMatrix, setEvidenceMatrix] = useState<ProjectResearchEvidenceMatrixItem[]>([])
  const [researchReports, setResearchReports] = useState<ProjectResearchReport[]>([])
  const [modelProviders, setModelProviders] = useState<Awaited<ReturnType<typeof providersApi.list>>>([])
  const [providerVendors, setProviderVendors] = useState<Awaited<ReturnType<typeof providersApi.vendors>>>([])
  const [inquiryThreads, setInquiryThreads] = useState<InquiryThread[]>([])
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Independent from the "edit the currently selected workflow" dialog that
  // the focus workbench owns internally: this Project can have several
  // concurrently active research workflows (one per Inquiry Thread that wants
  // its own search), so "start another one" must never reuse whichever
  // workflow happens to be selected right now.
  const [newSearchDialogOpen, setNewSearchDialogOpen] = useState(false)
  const [newSearchThreadId, setNewSearchThreadId] = useState<string | null>(null)

  // React StrictMode (dev only) intentionally double-invokes the mount effect
  // below, and that effect has no cleanup to cancel the first call — without
  // this guard every visit fires this twelve-call waterfall twice
  // concurrently, which does nothing useful and doubles real load on the
  // backend. Collapse a second call for the same project into the load
  // already in flight; a call after the previous one finished still runs.
  const loadInFlightRef = useRef<{ key: string; promise: Promise<void> } | null>(null)

  const loadImpl = useCallback(async () => {
    if (!projectId || !activeSpaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      let workflows: ProjectResearchWorkflow[] = []
      await Promise.all([
        projectsApi.get(projectId).then(setProject),
        sourcesApi.channels().then(setSourceChannels),
        sourcesApi.projectSourceBindings({ project_id: projectId }).then(setSourceBindings),
        sourcesApi.projectItems({ project_id: projectId, limit: 5 })
          .then(items => setRecentSourceItems(items.items.map(projectItem => projectItem.item))),
        projectsApi.operations(projectId).catch(() => [] as ProjectOperation[]).then(setOperations),
        projectResearchApi.workflows(projectId).then(value => { workflows = value; setResearchWorkflows(value) }),
        projectResearchApi.evidenceMatrix(projectId).then(setEvidenceMatrix),
        projectResearchApi.reports(projectId).then(setResearchReports),
        projectResearchApi.scanSummaries(projectId).then(setResearchScanSummaries),
        providersApi.list().catch(() => []).then(setModelProviders),
        providersApi.vendors().catch(() => []).then(setProviderVendors),
        inquiryApi.listThreads(projectId).then(setInquiryThreads),
      ])
      const storedWorkflowId = window.localStorage.getItem(`project:${projectId}:research-workflow`)
      const activeWorkflow = researchWorkflowForDisplayFrom(workflows, storedWorkflowId)
      setSelectedWorkflowId(activeWorkflow?.id ?? null)
      setResearchCheckpoints(
        activeWorkflow ? await projectResearchApi.checkpoints(projectId, activeWorkflow.id) : [],
      )
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [projectId, activeSpaceId])

  const load = useCallback(async () => {
    const key = `${projectId ?? ''}:${activeSpaceId ?? ''}`
    if (loadInFlightRef.current?.key === key) return loadInFlightRef.current.promise
    const promise = loadImpl()
    loadInFlightRef.current = { key, promise }
    try {
      await promise
    } finally {
      if (loadInFlightRef.current?.promise === promise) loadInFlightRef.current = null
    }
  }, [projectId, activeSpaceId, loadImpl])

  useEffect(() => { void load() }, [load])

  const refreshOperations = useCallback(async (): Promise<ProjectOperation[] | null> => {
    if (!projectId) return null
    try {
      const nextOperations = await projectsApi.operations(projectId)
      setOperations(nextOperations)
      return nextOperations
    } catch {
      // Keep the last known operation state visible on a transient failure.
      return null
    }
  }, [projectId])

  const refreshResearchState = useCallback(async () => {
    if (!projectId) return
    try {
      const [operationRows, workflows] = await Promise.all([
        projectsApi.operations(projectId),
        projectResearchApi.workflows(projectId),
      ])
      const activeWorkflow = researchWorkflowForDisplayFrom(workflows, selectedWorkflowId)
      setOperations(operationRows)
      setResearchWorkflows(workflows)
      const [checkpoints, matrix, reports, scanSummaries] = await Promise.all([
        activeWorkflow
          ? projectResearchApi.checkpoints(projectId, activeWorkflow.id).catch(() => [] as ProjectResearchCheckpoint[])
          : Promise.resolve([] as ProjectResearchCheckpoint[]),
        projectResearchApi.evidenceMatrix(projectId).catch(() => [] as ProjectResearchEvidenceMatrixItem[]),
        projectResearchApi.reports(projectId).catch(() => [] as ProjectResearchReport[]),
        projectResearchApi.scanSummaries(projectId).catch(() => [] as ProjectResearchScanSummary[]),
      ])
      setResearchCheckpoints(checkpoints)
      setEvidenceMatrix(matrix)
      setResearchReports(reports)
      setResearchScanSummaries(scanSummaries)
    } catch {
      // Keep the last known research state visible on a transient failure.
    }
  }, [projectId, selectedWorkflowId])

  const refreshSourceSelection = useCallback(async () => {
    if (!projectId) return
    try {
      const [channels, bindings] = await Promise.all([
        sourcesApi.channels(),
        sourcesApi.projectSourceBindings({ project_id: projectId }),
      ])
      setSourceChannels(channels)
      setSourceBindings(bindings)
    } catch {
      // Keep the current source selection visible on a transient failure.
    }
  }, [projectId])

  const hasActiveResearchOperation = operations.some(
    operation => operation.kind === 'research' && ['active', 'waiting_review'].includes(operation.status),
  )

  const researchLifecycleSignatureRef = useRef<string | null>(null)
  const researchProgressPollBusy = useRef(false)
  const refreshResearchProgress = useCallback(async () => {
    const nextOperations = await refreshOperations()
    if (!nextOperations) return
    const nextSignature = researchLifecycleSignature(nextOperations)
    const previousSignature = researchLifecycleSignatureRef.current
    researchLifecycleSignatureRef.current = nextSignature
    if (previousSignature !== null && previousSignature !== nextSignature) {
      await refreshResearchState()
    }
  }, [refreshOperations, refreshResearchState])

  useEffect(() => {
    if (!hasActiveResearchOperation) return
    const refresh = async () => {
      if (researchProgressPollBusy.current) return
      researchProgressPollBusy.current = true
      try {
        await refreshResearchProgress()
      } finally {
        researchProgressPollBusy.current = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5_000)
    return () => window.clearInterval(timer)
  }, [hasActiveResearchOperation, refreshResearchProgress])

  const researchReviewToastIdsRef = useRef(new Map<string, string>())
  useEffect(() => {
    if (!projectId) return
    const pendingIds = new Set(
      researchCheckpoints
        .filter(checkpoint => checkpoint.status === 'pending' && isResearchHumanReviewCheckpoint(checkpoint))
        .map(checkpoint => checkpoint.id),
    )

    for (const checkpoint of researchCheckpoints) {
      if (
        checkpoint.status !== 'pending'
        || !isResearchHumanReviewCheckpoint(checkpoint)
        || researchReviewToastIdsRef.current.has(checkpoint.id)
      ) continue
      const toastId = researchReviewToastId(projectId, checkpoint.id)
      researchReviewToastIdsRef.current.set(checkpoint.id, toastId)
      toast.warning('Research review required', {
        id: toastId,
        duration: Infinity,
        description: `${researchCheckpointLabel(checkpoint)} is ready for your review. The workflow is paused until you decide.`,
        action: {
          label: 'Review now',
          onClick: () => navigate(`/projects/${projectId}/operations`),
        },
      })
    }

    for (const [checkpointId, toastId] of researchReviewToastIdsRef.current) {
      if (pendingIds.has(checkpointId)) continue
      toast.dismiss(toastId)
      researchReviewToastIdsRef.current.delete(checkpointId)
    }
  }, [navigate, projectId, researchCheckpoints])

  const newSearchThread = inquiryThreads.find(thread => thread.id === newSearchThreadId)
  const newSearchWorkflow = useMemo(() => newSearchThread
    ? researchWorkflowForThread(researchWorkflows, newSearchThread.id)
    : null, [newSearchThread, researchWorkflows])
  const newSearchDraft = useMemo(() => {
    // Question definition happens on the Thread's own Inquiry page — whatever
    // wording/assessment was confirmed there lives on a `not_started` draft
    // Workflow already linked to this Thread by its canonical
    // `primary_thread_id`. Without finding it, this dialog would reopen as if
    // nothing had been refined yet.
    const base = researchSetupDraftFromWorkflow(newSearchWorkflow, newSearchThread?.statement ?? '', [], evidenceMatrix.length)
    return newSearchThread ? { ...base, thread_id: newSearchThread.id } : base
  }, [newSearchThread, newSearchWorkflow, evidenceMatrix.length])

  useEffect(() => {
    if (searchParams.get('research') !== 'new') return
    if (loading) return
    const threadId = searchParams.get('thread')
    // The setup dialog always configures a search for an already-defined
    // Thread — without one to target, send the user to Inquiry to pick or
    // create one instead of opening a dialog with nothing to configure.
    if (!threadId) {
      navigate(`/projects/${projectId}/inquiry?research_intent=1`, { replace: true })
      return
    }
    const targetThread = inquiryThreads.find(thread => thread.id === threadId)
    if (!targetThread) {
      navigate(`/projects/${projectId}/inquiry`, { replace: true })
      return
    }
    const existingWorkflow = researchWorkflowForThread(researchWorkflows, threadId)
    if (existingWorkflow && !['not_started', 'paused'].includes(existingWorkflow.status)) {
      setSelectedWorkflowId(existingWorkflow.id)
      window.localStorage.setItem(`project:${projectId}:research-workflow`, existingWorkflow.id)
      toast.info('Research has already started for this Inquiry. Opening its operation instead.')
      navigate(`/projects/${projectId}/operations`, { replace: true })
      return
    }
    setNewSearchThreadId(threadId)
    setNewSearchDialogOpen(true)
    setSearchParams(previous => {
      const next = new URLSearchParams(previous)
      next.delete('research')
      next.delete('thread')
      return next
    }, { replace: true })
  }, [inquiryThreads, loading, navigate, projectId, researchWorkflows, searchParams, setSearchParams])

  const selectWorkflow = useCallback((workflowId: string) => {
    if (!projectId) return
    setSelectedWorkflowId(workflowId)
    window.localStorage.setItem(`project:${projectId}:research-workflow`, workflowId)
    projectResearchApi.checkpoints(projectId, workflowId)
      .then(setResearchCheckpoints)
      .catch(error => toast.error(errMsg(error)))
  }, [projectId])

  // `workflowIdOverride` lets a caller force which workflow (if any) this
  // targets instead of the one currently selected — the independent "start
  // another search" dialog always passes `null` so it can never silently
  // overwrite whichever workflow the user has open.
  async function startInitialIntake(config: ProjectResearchInitialIntakeInput, workflowIdOverride?: string | null) {
    if (!project) return
    setActionBusy('start-initial-intake')
    try {
      const workflowId = workflowIdOverride !== undefined ? workflowIdOverride : selectedWorkflowId
      const response = await projectResearchApi.startInitialIntake(project.id, {
        ...config,
        ...(workflowId ? { workflow_id: workflowId } : {}),
      })
      if (response.workflow) setResearchWorkflows(current => upsertById(current, response.workflow!))
      setOperations(current => upsertById(current, response.operation))
      setSourceChannels(current => mergeById(current, response.source_channels))
      setSourceBindings(current => mergeById(current, response.source_bindings))
      toast.success('Evidence search started')
      if (response.workflow) {
        setSelectedWorkflowId(response.workflow.id)
        window.localStorage.setItem(`project:${project.id}:research-workflow`, response.workflow.id)
      }
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActionBusy(null)
    }
  }

  async function saveInitialIntake(config: ProjectResearchInitialIntakeInput, workflowIdOverride?: string | null): Promise<boolean> {
    if (!project) return false
    setActionBusy('save-initial-intake')
    try {
      const workflowId = workflowIdOverride !== undefined ? workflowIdOverride : selectedWorkflowId
      const workflow = await projectResearchApi.saveInitialIntakeDraft(project.id, {
        ...config,
        ...(workflowId ? { workflow_id: workflowId } : {}),
      })
      setResearchWorkflows(current => upsertById(current, workflow))
      toast.success('Initial material intake setup saved')
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    } finally {
      setActionBusy(null)
    }
  }

  async function loadQuestionImpact() {
    if (!project) throw new Error('Project is not loaded')
    if (!selectedWorkflowId) throw new Error('Select a research question first')
    return projectResearchApi.questionChangeImpact(project.id, selectedWorkflowId)
  }

  async function resolveQuestion(strategy: ProjectResearchQuestionResolutionStrategy): Promise<boolean> {
    if (!project) return false
    setActionBusy('apply-question')
    try {
      if (!selectedWorkflowId) throw new Error('Select a research question first')
      await projectResearchApi.resolveQuestionChange(project.id, selectedWorkflowId, strategy)
      toast.success(strategy === 'rescreen' ? 'Corpus re-screening started' : strategy === 'synthesis_only' ? 'New synthesis started' : 'Research question applied to future runs')
      await load()
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    } finally {
      setActionBusy(null)
    }
  }

  async function extendHistory(config: { from: string; to?: string; max_items: number }) {
    if (!project) return
    const workflow = researchWorkflowForDisplayFrom(researchWorkflows, selectedWorkflowId)
    if (!workflow) {
      toast.error('Start and complete the initial material intake before extending history')
      return
    }
    setActionBusy('extend-history')
    try {
      await projectResearchApi.historyBackfill(project.id, workflow.id, config)
      toast.success('Historical backfill started')
      await refreshOperations()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActionBusy(null)
    }
  }

  async function triggerIncremental() {
    if (!project) return
    const workflow = researchWorkflowForDisplayFrom(researchWorkflows, selectedWorkflowId)
    if (!workflow) {
      toast.error('Start the initial material intake before running an incremental scan')
      return
    }
    setActionBusy('incremental')
    try {
      await projectResearchApi.triggerIncremental(project.id, workflow.id)
      toast.success('Incremental research scan started')
      await refreshOperations()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActionBusy(null)
    }
  }

  async function retryOperation(operationId: string) {
    if (!project) return
    const operation = operations.find(item => item.id === operationId && item.kind === 'research' && item.status === 'failed')
    if (!operation) return
    setActionBusy('retry-operation')
    try {
      await projectResearchApi.retryOperation(project.id, operation.id)
      toast.success('Research operation retry queued')
      await Promise.all([
        refreshOperations(),
        operation.progress_json.failed_stage === 'monitor_setup' ? refreshSourceSelection() : Promise.resolve(),
      ])
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActionBusy(null)
    }
  }

  async function rescanBackfill() {
    if (!project) return
    const operation = operations.find(item => item.kind === 'research'
      && item.progress_json.workflow_id === selectedWorkflowId
      && ['baseline', 'historical_backfill'].includes(String(item.progress_json.run_kind))
      && researchOperationStage(item) !== 'monitor_setup'
      && item.progress_json.partial !== true)
    if (!operation) return
    setActionBusy('rescan-backfill')
    try {
      await projectResearchApi.rescanBackfill(project.id, operation.id)
      toast.success('Rescan queued using the current monitor query')
      await refreshOperations()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActionBusy(null)
    }
  }

  // Item limit is a Research setting: independent of the question and monitor
  // setup. Once a backfill operation has plans, editing raises the live plans'
  // budget; before that, it updates only the saved limit draft.
  const operationForSettings = operations.find(item => item.kind === 'research'
    && item.progress_json.workflow_id === selectedWorkflowId
    && ['baseline', 'historical_backfill'].includes(String(item.progress_json.run_kind))
    && numberValue(objectValue(item.progress_json.history).max_items) > 0)

  const selectedWorkflow = researchWorkflowForDisplayFrom(researchWorkflows, selectedWorkflowId)
  const setupDraft = researchSetupDraftFromWorkflow(
    selectedWorkflow,
    String(selectedWorkflow?.state_json.research_question ?? ''),
    sourceBindings.filter(binding => binding.status === 'active').map(binding => binding.source_channel_id),
  )
  const sourceChannelById = Object.fromEntries(sourceChannels.map(channel => [channel.id, channel])) as Record<string, SourceChannel>
  const linkedSourceChannels = sourceBindings
    .map(binding => sourceChannelById[binding.source_channel_id])
    .filter((channel): channel is SourceChannel => Boolean(channel))
  const monitorLabels = linkedSourceChannels.length
    ? linkedSourceChannels.map(channel => channel.name)
    : setupDraft.query_strategy_id
      ? [`Adaptive strategy ${setupDraft.query_strategy_id.slice(0, 8)}`]
      : []

  async function updateItemLimit(newLimit: number) {
    if (!project) return
    if (operationForSettings) {
      setActionBusy('update-item-limit')
      try {
        await projectResearchApi.updateItemLimit(project.id, operationForSettings.id, newLimit)
        toast.success('Research item limit updated')
        await refreshResearchState()
      } catch (e) {
        toast.error(errMsg(e))
      } finally {
        setActionBusy(null)
      }
      return
    }
    setActionBusy('update-item-limit')
    try {
      const workflow = await projectResearchApi.updateInitialItemLimit(project.id, newLimit, selectedWorkflowId)
      setResearchWorkflows(current => upsertById(current, workflow))
      toast.success('Research item limit updated')
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setActionBusy(null)
    }
  }

  const focusProps: FocusResearchWorkbenchProps | null = project ? {
    project,
    sourceChannels,
    sourceBindings,
    recentSourceItems,
    researchWorkflows,
    selectedWorkflowId,
    onSelectWorkflow: selectWorkflow,
    researchScanSummaries: researchScanSummaries.filter(item => item.workflow_id === selectedWorkflowId),
    researchCheckpoints,
    evidenceMatrix,
    researchReports: researchReports.filter(item => item.workflow_id === selectedWorkflowId),
    researchOperations: operations,
    researchDataLoading: loading,
    modelProviders,
    providerVendors,
    questionThreads: inquiryThreads,
    researchActionBusy: actionBusy,
    onSaveInitialIntake: saveInitialIntake,
    onStartInitialIntake: startInitialIntake,
    onExtendHistory: extendHistory,
    onTriggerIncremental: triggerIncremental,
    onLoadQuestionImpact: loadQuestionImpact,
    onResolveQuestion: resolveQuestion,
    onRetryOperation: retryOperation,
    onRescanBackfill: rescanBackfill,
    onEditQuestion: () => navigate(`/projects/${projectId}/inquiry`),
  } : null

  return {
    project,
    loading,
    actionBusy,
    focusProps,
    newSearch: {
      open: newSearchDialogOpen,
      setOpen: setNewSearchDialogOpen,
      thread: newSearchThread,
      workflowId: newSearchWorkflow && ['not_started', 'paused'].includes(newSearchWorkflow.status)
        ? newSearchWorkflow.id
        : null,
      draft: newSearchDraft,
    },
    settings: project ? {
      currentItemLimit: operationForSettings
        ? numberValue(objectValue(operationForSettings.progress_json.history).max_items) || null
        : Number(setupDraft.max_items) || null,
      hasLiveOperation: operationForSettings !== undefined,
      busy: actionBusy !== null,
      onUpdateItemLimit: updateItemLimit,
      snapshot: {
        question: setupDraft.research_question,
        monitors: monitorLabels,
        history: setupDraft.history_mode === 'all_available'
          ? 'All available history'
          : `${setupDraft.from || '—'} to ${setupDraft.to || '—'}`,
        maxItems: Number(setupDraft.max_items) || null,
        monitoringField: setupDraft.monitoring_field === 'lastUpdatedDate' ? 'Last update date' : 'Submission date',
      },
    } : null,
    saveInitialIntake,
    startInitialIntake,
  }
}
