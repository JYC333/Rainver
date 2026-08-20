import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Edit2, RefreshCw } from 'lucide-react'
import { SpaceLink as Link } from '../../core/spaceNav'
import type {
  Project, ProjectResearchReport, ProjectResearchInitialIntakeInput, ProjectResearchCheckpoint,
  ProjectResearchEvidenceMatrixItem,
  ProjectResearchWorkflow, ProjectSourceBinding, SourceItem,
  SourceChannel,
  ProjectOperation,
  ProjectResearchQuestionImpact, ProjectResearchQuestionResolutionStrategy,
  ProjectResearchScanSummary,
  InquiryThread,
} from '../../types/api'
import type { ModelProviderOut, ProviderVendorOut } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { DatePicker } from '../../components/ui/date-picker'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { researchWorkflowForDisplayFrom } from './researchWorkflowView'
import { researchSetupDraftFromWorkflow, serializeResearchSetupDraft } from './researchSetupDraft'
import { ResearchSetupDialog } from './ResearchSetupDialog'
import { ResearchSetupSummary } from './ResearchSetupSummary'
import { defaultResearchSetupGuideSteps, ResearchSetupGuide } from './ResearchSetupGuide'
import { ResearchTabsLegend } from './ResearchTabsLegend'
import { isResearchHumanReviewCheckpoint } from './researchReviewAttention'
import { ResearchResultCard } from './ResearchResultCard'
import { researchResultState, savedSetupDiffersFromOperation, type ResearchResultAction } from './researchResultState'
import { ResearchScanTimeline } from './ResearchScanTimeline'

export function activeResearchWorkflowFrom(workflows: ProjectResearchWorkflow[]): ProjectResearchWorkflow | null {
  return workflows.find(workflow => workflow.status === 'active') ?? null
}

function historyCoverageRanges(workflow: ProjectResearchWorkflow | null): Array<{ from: string; to: string; operation_id: string; status: string }> {
  const value = workflow?.state_json.coverage_ranges
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    return typeof row.from === 'string' && typeof row.to === 'string' && typeof row.operation_id === 'string' && typeof row.status === 'string'
      ? [{ from: row.from, to: row.to, operation_id: row.operation_id, status: row.status }]
      : []
  })
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function researchStageLabel(value: unknown): string {
  switch (value) {
    case 'monitor_setup': return 'Preparing source monitors'
    case 'backfill': return 'Importing source history'
    case 'screening': return 'Screening materials'
    case 'comparison': return 'Comparing new evidence'
    case 'synthesis': return 'Generating synthesis'
    case 'idea_review': return 'Waiting for idea review'
    case 'complete': return 'Research complete'
    case 'failed': return 'Research failed'
    default: return 'Preparing research'
  }
}

function isEmptySearchOperation(operation: ProjectOperation | null): boolean {
  if (!operation) return false
  const emptyResult = objectValue(operation.progress_json.empty_result)
  return emptyResult.kind === 'no_source_items'
}

/**
 * Whether a source failed to contribute at all. The operation records this, but
 * the completion wording ignored it — so "no relevant evidence" was reported
 * with equal confidence whether every provider had been read or one of them had
 * never answered. Those are different claims and the reader has to be able to
 * tell them apart before acting on the suggestion to broaden the query.
 */
function coverageIncomplete(operation: ProjectOperation): boolean {
  if (operation.progress_json.coverage_degraded === true) return true
  const backfill = objectValue(operation.progress_json.backfill_progress)
  return numberValue(backfill.deferred_segments) > 0 || numberValue(backfill.failed_segments) > 0
}

function deferredProviderNames(operation: ProjectOperation): string[] {
  const backfill = objectValue(operation.progress_json.backfill_progress)
  const deferred = Array.isArray(backfill.deferred_sources) ? backfill.deferred_sources : []
  return deferred
    .map(entry => {
      const source = objectValue(entry)
      const name = source.provider_display_name ?? source.provider_key
      return typeof name === 'string' && name.trim() ? name.trim() : null
    })
    .filter((name): name is string => name !== null)
}

function noReportOutcome(operation: ProjectOperation | null): Record<string, unknown> | null {
  if (!operation) return null
  const outcome = objectValue(operation.progress_json.empty_result)
  return outcome.kind === 'no_relevant_sources' || outcome.kind === 'no_coherent_synthesis' ? outcome : null
}

// Mirrors the backend's canonical stage-index table (operationProjection.ts's
// researchStageIndex) — comparison and synthesis share one visual step
// ("Compare or synthesize evidence").
function researchStageIndex(value: unknown): number {
  switch (value) {
    case 'monitor_setup': return 0
    case 'backfill': return 1
    case 'screening': return 2
    case 'comparison': case 'synthesis': return 3
    case 'idea_review': return 4
    default: return 0
  }
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function researchOperationStage(operation: ProjectOperation): unknown {
  if (operation.status === 'failed' && typeof operation.progress_json.failed_stage === 'string') {
    return operation.progress_json.failed_stage
  }
  return operation.progress_json.current_stage
}

/**
 * Comparison has no dedicated progress read model (unlike screening_progress
 * / synthesis_progress) — everything here is derived from the pending/
 * failed/results pools already on progress_json (see
 * ProjectResearchMonitoringCoordinator.queueComparison) plus the
 * remaining-batch count the backend already computes into
 * steps[3].detail_json on every dispatch.
 */
function comparisonProgress(operation: ProjectOperation): { done: number; total: number; remainingBatches: number | null } {
  const progress = operation.progress_json
  const results = Array.isArray(progress.comparison_results_json) ? progress.comparison_results_json.length : 0
  const pending = Array.isArray(progress.comparison_pending_source_item_ids) ? progress.comparison_pending_source_item_ids.length : 0
  const failed = Array.isArray(progress.comparison_failed_source_item_ids) ? progress.comparison_failed_source_item_ids.length : 0
  const inFlight = typeof progress.comparison_run_id === 'string' && Array.isArray(progress.comparison_source_item_ids)
    ? progress.comparison_source_item_ids.length
    : 0
  const detail = operation.steps?.find(step => step.seq === 3)?.detail_json
  const remainingBatches = typeof detail?.remaining_batches === 'number' ? detail.remaining_batches : null
  return { done: results, total: results + pending + failed + inFlight, remainingBatches }
}

export function researchOperationPercent(operation: ProjectOperation): number {
  if (isEmptySearchOperation(operation)) return 40
  if (operation.status === 'completed') return 100
  const stage = researchOperationStage(operation)
  const index = researchStageIndex(stage)
  const backfill = objectValue(operation.progress_json.backfill_progress)
  const totalSegments = numberValue(backfill.total_segments)
  const completedSegments = numberValue(backfill.completed_segments)
  const runningSegments = numberValue(backfill.running_segments)
  const screening = objectValue(operation.progress_json.screening_progress)
  const totalScreeningItems = numberValue(screening.total_items)
  const classifiedScreeningItems = numberValue(screening.classified_items)
  const totalBatches = numberValue(screening.total_batches)
  const completedBatches = numberValue(screening.completed_batches)
  const screeningFraction = screening.phase === 'ready_for_review'
    ? 0.98
    : totalScreeningItems > 0
      ? Math.min(0.94, 0.08 + (classifiedScreeningItems / totalScreeningItems) * 0.86)
      : totalBatches > 0
        ? Math.min(0.94, 0.08 + (completedBatches / totalBatches) * 0.86)
        : 0.08
  const comparison = comparisonProgress(operation)
  const comparisonFraction = comparison.total > 0
    ? Math.min(0.94, 0.08 + (comparison.done / comparison.total) * 0.86)
    : 0.08
  const stageFraction = stage === 'backfill'
    ? totalSegments > 0 ? Math.min(0.98, (completedSegments + runningSegments * 0.35) / totalSegments) : 0.08
    : stage === 'screening'
      ? screeningFraction
    : stage === 'comparison'
      ? comparisonFraction
    : operation.status === 'waiting_review' ? 0.9 : 0.15
  return Math.min(99, Math.max(3, Math.round(((index + stageFraction) / 5) * 100)))
}

export function researchOperationDetail(operation: ProjectOperation): string {
  if (isEmptySearchOperation(operation)) return 'Search returned 0 materials · setup required'
  const outcome = noReportOutcome(operation)
  if (outcome) {
    const base = outcome.kind === 'no_relevant_sources'
      ? 'Screening complete · no relevant evidence for synthesis'
      : 'Research complete · no coherent citation-backed report'
    return coverageIncomplete(operation) ? `${base} · incomplete source coverage` : base
  }
  const stage = researchOperationStage(operation)
  const backfill = objectValue(operation.progress_json.backfill_progress)
  const total = numberValue(backfill.total_segments)
  const completed = numberValue(backfill.completed_segments)
  const deferred = numberValue(backfill.deferred_segments)
  const ingestionRecords = numberValue(backfill.items_ingested)
  const sourceItemIds = Array.isArray(operation.progress_json.source_item_ids)
    ? operation.progress_json.source_item_ids.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  const uniqueItems = new Set(sourceItemIds).size
  const screening = objectValue(operation.progress_json.screening_progress)
  const screeningTotal = numberValue(screening.total_items)
  if (stage === 'screening' && screeningTotal === 0 && operation.status === 'waiting_review') {
    return 'No materials matched this search window · rescan required'
  }
  if (stage === 'screening' && screeningTotal > 0) {
    const classified = numberValue(screening.classified_items)
    const totalBatches = numberValue(screening.total_batches)
    const completedBatches = numberValue(screening.completed_batches)
    const queuedBatches = numberValue(screening.queued_batches)
    const runningBatches = numberValue(screening.running_batches)
    const batchDetail = totalBatches > 0
      ? runningBatches > 0
        ? `${completedBatches}/${totalBatches} screening batches · model processing`
        : queuedBatches > 0
          ? `${completedBatches}/${totalBatches} screening batches · queued`
          : `${completedBatches}/${totalBatches} screening batches`
      : screening.phase === 'ready_for_review' ? 'Screening complete' : 'Preparing screening batches'
    return `${batchDetail} · ${classified}/${screeningTotal} materials classified${deferred > 0 ? ` · ${deferred} source window${deferred === 1 ? '' : 's'} retrying in background` : ''}`
  }
  if (stage === 'comparison') {
    const { done, total: comparisonTotal, remainingBatches } = comparisonProgress(operation)
    const batchDetail = remainingBatches === null
      ? 'Preparing comparison batches'
      : remainingBatches === 0 ? 'Finishing comparison' : `${remainingBatches} batch${remainingBatches === 1 ? '' : 'es'} remaining`
    return comparisonTotal > 0 ? `${batchDetail} · ${done}/${comparisonTotal} materials compared` : batchDetail
  }
  const synthesis = objectValue(operation.progress_json.synthesis_progress)
  if (stage === 'synthesis' && typeof synthesis.run_status === 'string') {
    const since = typeof synthesis.started_at === 'string'
      ? ` · started ${relativeTime(synthesis.started_at)}`
      : typeof synthesis.queued_at === 'string' ? ` · queued ${relativeTime(synthesis.queued_at)}` : ''
    return `Synthesis run ${synthesis.run_status}${since}`
  }
  return stage === 'backfill' && total > 0
    ? `${completed}/${total} history windows · ${uniqueItems > 0 ? `${uniqueItems.toLocaleString()} unique materials · ` : ''}${ingestionRecords.toLocaleString()} ingestion records${deferred > 0 ? ` · ${deferred} retrying in background` : ''}`
    : `Stage ${researchStageIndex(stage) + 1} of 5`
}

export function researchOperationNextStep(operation: ProjectOperation): string {
  if (isEmptySearchOperation(operation)) return 'Next: adjust the saved setup, then start the initial research search again. Screening and synthesis were skipped.'
  const outcome = noReportOutcome(operation)
  if (outcome) {
    if (coverageIncomplete(operation)) {
      const names = deferredProviderNames(operation)
      const who = names.length > 0 ? names.join(', ') : 'At least one source'
      // Named before the advice, because "broaden the query" is the wrong move
      // when the real gap is a provider that contributed nothing.
      return `${who} did not finish importing, so this conclusion is drawn from an incomplete corpus. Next: let the background retry finish, or retry the import, before broadening the search settings.`
    }
    return 'Next: review the collected materials and adjust the research scope or search settings. This is a completed research outcome, not an execution failure.'
  }
  const stage = researchOperationStage(operation)
  const backfill = objectValue(operation.progress_json.backfill_progress)
  const deferred = numberValue(backfill.deferred_segments)
  const ingested = numberValue(backfill.items_ingested)
  const screening = objectValue(operation.progress_json.screening_progress)
  if (operation.status === 'failed') {
    return `Failed during ${researchStageLabel(stage).toLowerCase()}. Retry is available for this stage.`
  }
  if (stage === 'backfill' && deferred > 0) {
    return ingested > 0
      ? 'A source window is temporarily unavailable and will retry automatically. Other successful sources can continue without waiting.'
      : 'The source is temporarily unavailable and will retry automatically in the background. You can leave this page; research will continue when materials become available.'
  }
  if (stage === 'backfill') return 'Next: finish the history import, then screen the collected materials in batches.'
  if (stage === 'screening' && numberValue(screening.total_items) === 0) return 'Next: revise the search query or date range, then rescan the empty windows. Synthesis is paused until materials are found.'
  if (stage === 'screening' && screening.phase === 'ready_for_review') return 'Next: review the screening summary; approval will build the matrix and queue synthesis.'
  if (stage === 'screening') return 'Next: finish all screening batches; the screening review opens automatically when every material is classified.'
  if (stage === 'comparison') return 'Next: finish comparing newly screened materials against the current understanding; synthesis starts automatically once done.'
  if (stage === 'synthesis') return 'Next: read the generated research report; its idea candidates will then enter review.'
  if (stage === 'idea_review') return 'Next: review the idea batch; approval completes this run and activates monitoring.'
  if (stage === 'monitor_setup') return 'Next: finish monitor setup, then import the selected history range.'
  return 'The research workflow is progressing automatically.'
}

export function researchOperationSteps(operation: ProjectOperation): Array<{ title: string; status: string }> {
  const fallback = ['Resolve source monitors', 'Import history or scan delta', 'Review screening', 'Synthesize approved corpus', 'Review idea candidates']
  const stage = researchOperationStage(operation)
  const currentIndex = researchStageIndex(stage)
  return fallback.map((fallbackTitle, index) => {
    const persisted = operation.steps?.find(step => step.seq === index)
    // Classification is model work, not yet the human screening review.
    // Keep legacy persisted step titles, but clarify the live phase.
    const title = index === 2 && stage === 'screening' && operation.status !== 'waiting_review'
      ? 'Screen materials'
      : persisted?.title ?? fallbackTitle
    return {
      title,
      status: operation.status === 'failed' && index === currentIndex
        ? 'failed'
        : persisted?.status ?? (
          index < currentIndex ? 'done'
            : index === currentIndex ? operation.status === 'waiting_review' ? 'blocked' : 'active'
              : 'pending'
        ),
    }
  })
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function timestampValue(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return value
}

export function synthesisHealth(progress: Record<string, unknown>): {
  label: string
  detail: string
  variant: 'success' | 'warning' | 'destructive' | 'muted'
} {
  const runStatus = typeof progress.run_status === 'string' ? progress.run_status : 'unknown'
  const jobStatus = typeof progress.job_status === 'string' ? progress.job_status : null
  const heartbeatAt = timestampValue(progress.job_heartbeat_at)
  const jobUpdatedAt = timestampValue(progress.job_updated_at)
  const lastActivityAt = heartbeatAt ?? jobUpdatedAt
  const ageSeconds = lastActivityAt ? Math.max(0, (Date.now() - Date.parse(lastActivityAt)) / 1_000) : null

  if (runStatus === 'queued' || runStatus === 'pending') {
    if (jobStatus === 'pending' && ageSeconds !== null && ageSeconds > 120) {
      return { label: 'Worker has not picked it up', detail: `queue has been waiting ${relativeTime(lastActivityAt ?? '')}`, variant: 'warning' }
    }
    if (jobStatus === 'claimed') {
      return { label: 'Worker claimed the job', detail: 'starting the synthesis run', variant: 'warning' }
    }
    return { label: 'Waiting for a worker', detail: jobStatus ? `job is ${jobStatus}` : 'worker status is not available', variant: 'muted' }
  }

  if (runStatus === 'running') {
    if (jobStatus === 'failed') {
      return { label: 'Agent job failed', detail: 'the run has not reported a terminal result yet', variant: 'destructive' }
    }
    if (jobStatus === 'completed') {
      return { label: 'Worker finished', detail: 'waiting for synthesis results to be reconciled', variant: 'warning' }
    }
    if (jobStatus === 'running' && ageSeconds !== null && ageSeconds > 120) {
      return { label: 'No recent worker heartbeat', detail: `last heartbeat ${relativeTime(lastActivityAt ?? '')}`, variant: 'destructive' }
    }
    if (jobStatus === 'running') {
      return { label: 'Worker is active', detail: heartbeatAt ? `last heartbeat ${relativeTime(heartbeatAt)}` : 'heartbeat not received yet', variant: 'success' }
    }
    return { label: 'Run is active', detail: 'worker status is not available', variant: 'warning' }
  }

  return { label: `Run ${runStatus}`, detail: jobStatus ? `job is ${jobStatus}` : 'checking run details', variant: runStatus === 'failed' ? 'destructive' : 'muted' }
}

export interface FocusResearchWorkbenchProps {
  project: Project
  sourceBindings: ProjectSourceBinding[]
  sourceChannels: SourceChannel[]
  recentSourceItems: SourceItem[]
  researchWorkflows: ProjectResearchWorkflow[]
  selectedWorkflowId: string | null
  onSelectWorkflow: (workflowId: string) => void
  researchScanSummaries: ProjectResearchScanSummary[]
  researchCheckpoints: ProjectResearchCheckpoint[]
  evidenceMatrix: ProjectResearchEvidenceMatrixItem[]
  researchReports: ProjectResearchReport[]
  researchOperations: ProjectOperation[]
  researchDataLoading: boolean
  modelProviders: ModelProviderOut[]
  providerVendors?: ProviderVendorOut[]
  questionThreads?: InquiryThread[]
  researchActionBusy: string | null
  onSaveInitialIntake: (config: ProjectResearchInitialIntakeInput) => Promise<boolean>
  onStartInitialIntake: (config: ProjectResearchInitialIntakeInput) => Promise<boolean>
  onExtendHistory: (config: { from: string; to?: string; max_items: number }) => void
  onTriggerIncremental: () => void
  onLoadQuestionImpact: () => Promise<ProjectResearchQuestionImpact>
  onResolveQuestion: (strategy: ProjectResearchQuestionResolutionStrategy) => Promise<boolean>
  onRetryOperation: (operationId: string) => void
  onRescanBackfill: () => void
  onEditQuestion: () => void
}

export function FocusResearchWorkbench({
  project,
  sourceBindings,
  sourceChannels,
  recentSourceItems,
  researchWorkflows,
  selectedWorkflowId,
  onSelectWorkflow,
  researchScanSummaries,
  researchCheckpoints,
  evidenceMatrix,
  researchReports,
  researchOperations,
  researchDataLoading,
  modelProviders,
  providerVendors = [],
  questionThreads = [],
  researchActionBusy,
  onSaveInitialIntake,
  onStartInitialIntake,
  onExtendHistory,
  onTriggerIncremental,
  onLoadQuestionImpact,
  onResolveQuestion,
  onRetryOperation,
  onRescanBackfill,
  onEditQuestion,
}: FocusResearchWorkbenchProps) {
  const [researchSetupOpen, setResearchSetupOpen] = useState(false)
  const [extendHistoryOpen, setExtendHistoryOpen] = useState(false)
  const [extendFrom, setExtendFrom] = useState('')
  const [extendTo, setExtendTo] = useState('')
  const [extendMaxItems, setExtendMaxItems] = useState('10000')
  const [questionResolutionOpen, setQuestionResolutionOpen] = useState(false)
  const [questionImpact, setQuestionImpact] = useState<ProjectResearchQuestionImpact | null>(null)
  const [questionImpactError, setQuestionImpactError] = useState<string | null>(null)
  const sourceHref = `/projects/${project.id}/sources`
  const displayWorkflow = researchWorkflowForDisplayFrom(researchWorkflows, selectedWorkflowId)
  const activeWorkflow = displayWorkflow?.status === 'active' ? displayWorkflow : null
  const activeScanSummaries = activeWorkflow
    ? researchScanSummaries.filter(summary => summary.workflow_id === activeWorkflow.id)
    : []
  const scopedOperations = researchOperations.filter(operation =>
    operation.kind === 'research' && operation.progress_json.workflow_id === displayWorkflow?.id)
  const currentResearchOperation = scopedOperations.find(operation => ['active', 'waiting_review'].includes(operation.status))
    ?? scopedOperations[0]
    ?? null
  // Relative timestamps ("Last update 12s ago", "running since 3m ago") are
  // computed at render time; without a clock tick they would only move when a
  // poll response happens to re-render the card. A 1s tick keeps second-level
  // values counting every second and flips minute-level values exactly on the
  // minute boundary.
  const [, setClockTick] = useState(0)
  const showOperationCard = currentResearchOperation !== null
  useEffect(() => {
    if (!showOperationCard) return
    const timer = window.setInterval(() => setClockTick(tick => tick + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [showOperationCard])
  const initialSearchOperations = scopedOperations
    .filter(operation => operation.progress_json.run_kind === 'baseline')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const initialSearchOperation = initialSearchOperations[0] ?? null
  const emptyInitialSearchOperation = isEmptySearchOperation(initialSearchOperation) ? initialSearchOperation : null
  const initialIntakeStarted = initialSearchOperation !== null
  const coverageRanges = historyCoverageRanges(activeWorkflow)
  const earliestCoverage = coverageRanges.filter(range => range.status === 'completed').sort((a, b) => a.from.localeCompare(b.from))[0] ?? null
  const historicalBackfillActive = scopedOperations.some(operation => operation.progress_json.run_kind === 'historical_backfill' && ['active', 'waiting_review'].includes(operation.status))
  const monitoring = objectValue(activeWorkflow?.state_json.monitoring)
  const projectBindingChannelIds = useMemo(
    () => new Set(sourceBindings.filter(binding => binding.status === 'active').map(binding => binding.source_channel_id)),
    [sourceBindings],
  )
  const initialIntakeConfig = objectValue(activeWorkflow?.state_json.initial_intake)
  const initialIntakeDraft = objectValue(displayWorkflow?.state_json.draft)
  const initialIntakeSaved = initialIntakeDraft.status === 'saved' || emptyInitialSearchOperation !== null
  const canExtendHistory = Boolean(activeWorkflow && !historicalBackfillActive && initialSearchOperation?.status === 'completed' && monitoring.active === true && initialIntakeConfig.history_mode !== 'all_available' && earliestCoverage)
  const pinnedThread = Array.isArray(activeWorkflow?.state_json.thread_scope)
    ? activeWorkflow?.state_json.thread_scope[0] as Record<string, unknown> | undefined
    : undefined
  const currentThread = typeof pinnedThread?.thread_id === 'string'
    ? questionThreads.find(thread => thread.id === pinnedThread.thread_id)
    : undefined
  const syncNeeded = Boolean(currentThread
    && (currentThread.version !== pinnedThread?.version || currentThread.statement !== pinnedThread?.statement))
  const projectQuestion = currentThread?.statement.trim()
    ?? (typeof displayWorkflow?.state_json.research_question === 'string'
      ? displayWorkflow.state_json.research_question.trim()
      : '')
  const researchSetupDraft = useMemo(
    () => researchSetupDraftFromWorkflow(displayWorkflow, projectQuestion, [...projectBindingChannelIds], evidenceMatrix.length),
    [displayWorkflow, projectBindingChannelIds, projectQuestion, evidenceMatrix.length],
  )
  const pendingCheckpoints = researchCheckpoints.filter(checkpoint => {
    if (checkpoint.status !== 'pending' || !isResearchHumanReviewCheckpoint(checkpoint)) return false
    const operationId = typeof checkpoint.machine_result_json?.operation_id === 'string'
      ? checkpoint.machine_result_json.operation_id
      : null
    if (!operationId) return true
    const operation = researchOperations.find(item => item.id === operationId)
    return !operation || ['active', 'waiting_review'].includes(operation.status)
  })
  const canAct = project.status === 'active'
  // Project-wide, not scoped to displayWorkflow — this Project can have
  // several concurrently active searches (one per Question/Hypothesis
  // Thread), and Operations Area is where all of them are actually visible;
  // this is only a pointer there, not a second render of each one.
  const allResearchOperations = researchOperations.filter(item => item.kind === 'research')
  const runningResearchCount = allResearchOperations.filter(item => item.status === 'active').length
  const waitingReviewResearchCount = allResearchOperations.filter(item => item.status === 'waiting_review').length
  const includedMaterialCount = evidenceMatrix.filter(row => row.triage_status === 'included').length
  // Before the matrix is built, the materials actually in scope live on the
  // current operation; the capped recent-items list is not a material count.
  const operationMaterialCount = new Set(
    Array.isArray(currentResearchOperation?.progress_json.source_item_ids)
      ? currentResearchOperation.progress_json.source_item_ids.filter((value): value is string => typeof value === 'string')
      : [],
  ).size
  const resultState = researchResultState({
    projectQuestion,
    workflow: activeWorkflow,
    checkpoints: pendingCheckpoints,
    operations: scopedOperations,
    reports: researchReports,
    scanSummaries: activeScanSummaries,
    materialCount: Math.max(evidenceMatrix.length, operationMaterialCount),
    includedCount: includedMaterialCount,
    savedSetupDiffers: emptyInitialSearchOperation !== null
      && savedSetupDiffersFromOperation(serializeResearchSetupDraft(researchSetupDraft), emptyInitialSearchOperation),
  })
  // The search-setup Modal now always targets a specific, already-defined
  // Inquiry Thread — without one linked yet there is nothing valid to
  // configure inside it, so every entry point that used to open it routes to
  // Inquiry instead, the same way a missing question already did.
  function openSetup() {
    if (!currentThread) onEditQuestion()
    else setResearchSetupOpen(true)
  }
  function handleResultAction(action: ResearchResultAction) {
    if (action === 'configure') {
      openSetup()
    } else if (action === 'resolve_question') void openQuestionResolution()
    else if (action === 'retry' && resultState.operation) onRetryOperation(resultState.operation.id)
    else if (action === 'rescan') onRescanBackfill()
    else if (action === 'start_search') startSavedResearch()
  }
  async function openQuestionResolution() {
    setQuestionResolutionOpen(true)
    setQuestionImpact(null)
    setQuestionImpactError(null)
    try {
      setQuestionImpact(await onLoadQuestionImpact())
    } catch (error) {
      setQuestionImpactError(error instanceof Error ? error.message : 'Could not load question-change impact')
    }
  }
  async function resolveQuestion(strategy: ProjectResearchQuestionResolutionStrategy) {
    if (await onResolveQuestion(strategy)) setQuestionResolutionOpen(false)
  }
  function startSavedResearch() {
    if (!initialIntakeSaved) {
      openSetup()
      return
    }
    onStartInitialIntake(serializeResearchSetupDraft(researchSetupDraft))
  }
  const setupGuideSteps = defaultResearchSetupGuideSteps({
    hasResearchQuestion: Boolean(projectQuestion),
    hasInitialIntake: initialIntakeSaved,
    onEditQuestion,
    onConfigureInitialIntake: openSetup,
  })
  const nextAction = !projectQuestion
    ? 'Set the research question before starting auto research.'
    : emptyInitialSearchOperation
      ? 'Adjust the saved intake setup and start the initial research search again.'
    : !activeWorkflow
      ? 'Start the research workflow.'
      : evidenceMatrix.length === 0 && recentSourceItems.length > 0
        ? 'Rebuild the evidence matrix from the project corpus.'
        : 'Run the integrity gate before relying on the report or draft outputs.'

  if (researchDataLoading) {
    return (
      <section aria-label="Loading Project Research" className="rounded-lg border border-border bg-card p-4 lg:p-5">
        <div className="flex items-center gap-2">
          <div className="size-4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-48 animate-pulse rounded bg-muted" />
        </div>
        <div className="mt-3 h-3 w-3/4 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-24 animate-pulse rounded-md bg-muted/60" />
      </section>
    )
  }

  return (
    <>
      <ResearchResultCard
        state={resultState}
        projectId={project.id}
        busy={researchActionBusy !== null}
        running={resultState.kind === 'running' && resultState.operation ? {
          percent: researchOperationPercent(resultState.operation),
          detail: `${researchOperationDetail(resultState.operation)} · ${researchOperationNextStep(resultState.operation)}`,
          steps: researchOperationSteps(resultState.operation),
        } : null}
        onAction={handleResultAction}
      />
      <ResearchScanTimeline
        projectId={project.id}
        summaries={activeScanSummaries}
        monitoringActive={monitoring.active === true}
      />
      <nav aria-label="Project Research links" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-muted-foreground">
        <Link className="hover:text-foreground hover:underline" to={sourceHref}>Manage sources</Link>
        <span aria-hidden="true">·</span>
        <Link className="hover:text-foreground hover:underline" to={`/projects/${project.id}/research`}>Open reading list, checklist, and reports</Link>
      </nav>
      {(runningResearchCount > 0 || waitingReviewResearchCount > 0) && (
        <Link
          to={`/projects/${project.id}/operations`}
          className="block rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
        >
          {runningResearchCount > 0 && `${runningResearchCount} search${runningResearchCount === 1 ? '' : 'es'} running`}
          {runningResearchCount > 0 && waitingReviewResearchCount > 0 && ' · '}
          {waitingReviewResearchCount > 0 && `${waitingReviewResearchCount} waiting for your review`}
          {' — view all in Operations'}
        </Link>
      )}
      {initialIntakeStarted && <ResearchTabsLegend projectId={project.id} />}
      {!initialIntakeStarted && (
        <ResearchSetupGuide steps={setupGuideSteps} />
      )}
      {!initialIntakeStarted && (
        <ResearchSetupSummary
          draft={researchSetupDraft}
          sourceChannels={sourceChannels}
          saved={initialIntakeSaved}
          busyAction={researchActionBusy}
          canAct={canAct}
          onEdit={openSetup}
          onStart={startSavedResearch}
        />
      )}
      {currentThread && <ResearchSetupDialog
        projectId={project.id}
        workflowId={selectedWorkflowId}
        threadId={currentThread.id}
        open={researchSetupOpen}
        draft={researchSetupDraft}
        busyAction={researchActionBusy}
        modelProviders={modelProviders}
        providerVendors={providerVendors}
        canAct={canAct}
        onOpenChange={setResearchSetupOpen}
        onSave={onSaveInitialIntake}
        onStart={onStartInitialIntake}
      />}
      <section className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="border-b border-border p-4 lg:p-5 flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <BookOpen className="size-4 text-accent-foreground" />
            Project Research
            <Badge variant="secondary">Auto research</Badge>
          </div>
          <h2 className="text-lg font-semibold tracking-tight">Research status</h2>
          <p className={`text-sm max-w-3xl line-clamp-2 ${projectQuestion ? '' : 'text-muted-foreground'}`}>
            {projectQuestion || 'Set the research question that screening and synthesis should answer.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {researchWorkflows.length > 0 && <Select
            ariaLabel="Selected research question workflow"
            value={displayWorkflow?.id ?? ''}
            options={researchWorkflows
              .filter(workflow => workflow.status !== 'archived')
              .map(workflow => ({
                value: workflow.id,
                label: `${typeof workflow.state_json.research_question === 'string' ? workflow.state_json.research_question : 'Untitled question'} · ${workflow.status}`,
              }))}
            onChange={onSelectWorkflow}
          />}
          <Link to={`/projects/${project.id}/research`}><Button size="sm"><BookOpen className="size-3.5" />Open research Area</Button></Link>
          <Button size="sm" variant={projectQuestion ? 'ghost' : 'secondary'} onClick={onEditQuestion}>
            <Edit2 className="size-3.5" />
            {projectQuestion ? 'Edit question' : 'Set research question'}
          </Button>
          {!initialIntakeStarted && <Button size="sm" variant="outline" onClick={openSetup}>
            Set up intake
          </Button>}
        </div>
      </div>


      <div className="p-4 lg:p-5">
        <div className="space-y-4 min-w-0">
          <div className="rounded-md border border-border p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">Research controls</h3>
                <p className="text-sm text-muted-foreground">{activeWorkflow ? 'Run monitoring or extend historical coverage. Living documents and report review are in the research Area.' : nextAction}</p>
              </div>
              {displayWorkflow ? (
                <Badge variant={displayWorkflow.status === 'not_started' ? 'outline' : 'muted'}>
                  {displayWorkflow.status === 'not_started' ? 'Draft' : displayWorkflow.status}
                </Badge>
              ) : (
                <Badge variant="muted">No workflow</Badge>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {activeWorkflow && (
                <Button size="sm" variant="outline" onClick={onTriggerIncremental} disabled={!canAct || researchActionBusy !== null || syncNeeded}>
                  <RefreshCw className="size-3.5" />
                  {researchActionBusy === 'incremental' ? 'Scanning...' : 'Run incremental now'}
                </Button>
              )}
              {canExtendHistory && earliestCoverage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setExtendTo(earliestCoverage.from.slice(0, 10))
                    setExtendFrom('')
                    setExtendMaxItems('10000')
                    setExtendHistoryOpen(true)
                  }}
                  disabled={!canAct || researchActionBusy !== null || syncNeeded}
                >
                  <BookOpen className="size-3.5" />
                  Extend history
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      <Dialog open={questionResolutionOpen} onOpenChange={setQuestionResolutionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve research question change</DialogTitle>
            <DialogDescription>
              The corpus and monitor queries stay intact. Choose which judgement stages should run again for the revised question.
            </DialogDescription>
          </DialogHeader>
          {questionImpactError ? (
            <p role="alert" className="text-sm text-destructive">{questionImpactError}</p>
          ) : questionImpact ? (
            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
                <p className="font-medium">{questionImpact.screened_items.toLocaleString()} materials screened against the previous question · {questionImpact.reports.toLocaleString()} reports</p>
                <p className="mt-1 text-xs text-muted-foreground">Question version {questionImpact.previous_version} → {questionImpact.previous_version + 1}</p>
              </div>
              <div className="grid gap-2">
                <Button className="h-auto justify-start px-4 py-3 text-left" disabled={researchActionBusy !== null} onClick={() => void resolveQuestion('rescreen')}>
                  <span><span className="block">Re-screen against the new question</span><span className="block text-xs font-normal opacity-80">Refresh criteria, preserve human-confirmed triage, re-screen AI decisions, then run the normal review and synthesis gates.</span></span>
                </Button>
                <Button variant="outline" className="h-auto justify-start px-4 py-3 text-left" disabled={researchActionBusy !== null} onClick={() => void resolveQuestion('synthesis_only')}>
                  <span><span className="block">Re-run synthesis only</span><span className="block text-xs font-normal text-muted-foreground">Reuse the current corpus and screening projection, then generate a new report for the revised question.</span></span>
                </Button>
                <Button variant="ghost" className="h-auto justify-start px-4 py-3 text-left" disabled={researchActionBusy !== null} onClick={() => void resolveQuestion('apply_forward')}>
                  <span><span className="block">Apply to future runs only</span><span className="block text-xs font-normal text-muted-foreground">Keep existing decisions and reports unchanged; use the revised question only for future monitoring.</span></span>
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Calculating affected materials and reports…</p>
          )}
          <DialogFooter><Button variant="outline" onClick={() => setQuestionResolutionOpen(false)}>Cancel</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={extendHistoryOpen} onOpenChange={setExtendHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extend research history</DialogTitle>
            <DialogDescription>Import materials earlier than the current historical coverage. Existing source items and confirmed triage are preserved.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">Earlier from</span><DatePicker value={extendFrom} onChange={setExtendFrom} ariaLabel="Earlier from" /></label>
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">To (current earliest)</span><DatePicker value={extendTo} onChange={setExtendTo} ariaLabel="To current earliest" /></label>
            <label className="space-y-1 text-xs md:col-span-2"><span className="text-muted-foreground">Max items</span><Input type="number" min={1} max={10000} value={extendMaxItems} onChange={event => setExtendMaxItems(event.target.value)} /></label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendHistoryOpen(false)}>Cancel</Button>
            <Button
              disabled={!extendFrom || !extendTo || Number(extendMaxItems) < 1 || Number(extendMaxItems) > 10000 || researchActionBusy !== null}
              onClick={() => {
                onExtendHistory({ from: extendFrom, to: extendTo, max_items: Number(extendMaxItems) })
                setExtendHistoryOpen(false)
              }}
            >
              {researchActionBusy === 'extend-history' ? 'Starting...' : 'Start historical backfill'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </section>
    </>
  )
}
