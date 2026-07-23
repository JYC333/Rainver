import type {
  ProjectOperation,
  ProjectResearchReport,
  ProjectResearchCheckpoint,
  ProjectResearchInitialIntakeInput,
  ProjectResearchScanSummary,
  ProjectResearchWorkflow,
} from '../../types/api'
import { latestReadableResearchReport } from './researchReports'
import { isResearchHumanReviewCheckpoint } from './researchReviewAttention'

export type ResearchResultStateKind =
  | 'setup'
  | 'question_drift'
  | 'checkpoint'
  | 'failure'
  | 'running'
  | 'monitoring_update'
  | 'monitoring'
  | 'completed'

export type ResearchResultAction =
  | 'configure'
  | 'resolve_question'
  | 'review_results'
  | 'retry'
  | 'rescan'
  | 'start_search'
  | 'open_report'
  | 'view_corpus'

export interface ResearchResultState {
  kind: ResearchResultStateKind
  eyebrow: string
  conclusion: string
  detail: string
  metrics: Array<{ label: string; value: string }>
  primaryAction: { key: ResearchResultAction; label: string } | null
  secondaryAction: { key: ResearchResultAction; label: string } | null
  operation: ProjectOperation | null
  checkpoint: ProjectResearchCheckpoint | null
  latestReport: ProjectResearchReport | null
  notices: string[]
  failure: { suggestion: string; technical: string } | null
}

interface ResearchResultStateInput {
  projectQuestion: string
  workflow: ProjectResearchWorkflow | null
  checkpoints: ProjectResearchCheckpoint[]
  operations: ProjectOperation[]
  reports: ProjectResearchReport[]
  scanSummaries: ProjectResearchScanSummary[]
  paperCount: number
  includedCount: number
  /** The saved setup no longer matches what the latest search executed; searching again must start fresh, not rescan. */
  savedSetupDiffers?: boolean
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isEmptySearch(operation: ProjectOperation): boolean {
  return objectValue(operation.progress_json.empty_result).kind === 'no_source_items'
}

function completedWithoutReport(operation: ProjectOperation | null): Record<string, unknown> | null {
  if (!operation) return null
  const outcome = objectValue(operation.progress_json.empty_result)
  return outcome.kind === 'no_relevant_sources' || outcome.kind === 'no_coherent_synthesis' ? outcome : null
}

function newest<T extends { created_at: string }>(rows: T[]): T | null {
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
}

function workflowIdOf(operation: ProjectOperation): string {
  const value = operation.progress_json.workflow_id
  return typeof value === 'string' && value ? value : operation.id
}

/**
 * The backend allows at most one active operation per workflow — a retry (or
 * an auto-created incremental scan) creates a fresh operation for the same
 * workflow rather than reusing the old one, leaving the superseded operation
 * permanently "failed" in history. Without this, `failedOperations` still
 * counted that stale operation as retriable — the panel showed "failed,
 * Retry" pointing at it while a newer operation for the same workflow was
 * actually running, and clicking Retry 409'd ("another operation is already
 * active for this workflow") with no way to see or act on the real one. Only
 * the newest operation per workflow is ever "current"; older ones for the
 * same workflow are history, not something to retry or report as running.
 */
function currentOperations(operations: ProjectOperation[]): ProjectOperation[] {
  const byWorkflow = new Map<string, ProjectOperation>()
  for (const operation of operations) {
    const key = workflowIdOf(operation)
    const existing = byWorkflow.get(key)
    if (!existing || operation.created_at.localeCompare(existing.created_at) > 0) byWorkflow.set(key, operation)
  }
  return [...byWorkflow.values()]
}

function workflowQuestion(workflow: ProjectResearchWorkflow | null): string {
  return typeof workflow?.state_json.research_question === 'string'
    ? workflow.state_json.research_question.trim()
    : ''
}

function monitoringActive(workflow: ProjectResearchWorkflow | null): boolean {
  return objectValue(workflow?.state_json.monitoring).active === true
}

function latestScanAt(workflow: ProjectResearchWorkflow | null): string | null {
  const monitoring = objectValue(workflow?.state_json.monitoring)
  for (const value of [monitoring.last_scan_at, monitoring.last_run_at, workflow?.updated_at]) {
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value
  }
  return null
}

function operationStage(operation: ProjectOperation): string {
  const value = operation.status === 'failed'
    ? operation.progress_json.failed_stage ?? operation.progress_json.current_stage
    : operation.progress_json.current_stage
  return typeof value === 'string' ? value.replace(/_/g, ' ') : 'research'
}

export function researchFailurePresentation(operation: ProjectOperation): { conclusion: string; suggestion: string; technical: string } {
  const error = objectValue(operation.progress_json.error)
  const code = typeof error.code === 'string' ? error.code : ''
  const message = typeof error.message === 'string' ? error.message : 'The operation failed before the server returned an error message.'
  const searchable = `${code} ${message}`.toLowerCase()
  let conclusion = `The ${operationStage(operation)} step did not complete.`
  let suggestion = 'Retry the operation. If it fails again, review the technical details before changing the research setup.'
  if (/quota|rate.limit|429/.test(searchable)) {
    conclusion = 'The research provider temporarily reached its request limit.'
    suggestion = 'Wait for the quota window to reset, then retry. No completed research data was changed.'
  } else if (/query|syntax|date.range|validation/.test(searchable)) {
    conclusion = 'The saved literature search could not be accepted.'
    suggestion = 'Review the monitor query and date range, save the correction, then retry.'
  } else if (/credential|unauthori|forbidden|api.key|authentication/.test(searchable)) {
    conclusion = 'The configured provider could not authenticate this research run.'
    suggestion = 'Check the provider credential in Settings, then retry the operation.'
  } else if (/strict.json|schema|invalid.json|output.invalid|synthesis_output_invalid/.test(searchable)) {
    conclusion = 'The model returned an unusable structured research result.'
    suggestion = 'Use a model that reliably follows strict JSON output, then retry synthesis.'
  } else if (/timeout|timed.out|network|connection|unavailable|503/.test(searchable)) {
    conclusion = 'A research service stopped responding before this step completed.'
    suggestion = 'Retry now. If the service remains unavailable, wait and try again later.'
  }
  const diagnostics = objectValue(error.diagnostics)
  const technical = JSON.stringify({ code: code || null, message, diagnostics }, null, 2)
  return { conclusion, suggestion, technical }
}

function formatDate(value: string | null): string {
  if (!value) return 'No scan has completed yet'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatDay(value: string): string {
  return value.slice(0, 10)
}

/**
 * The window the operation actually executed with (frozen at start), not the
 * editable draft — shown so a user can verify their configured dates were
 * really applied.
 */
function operationScopeMetrics(operation: ProjectOperation | null): Array<{ label: string; value: string }> {
  if (!operation) return []
  const history = objectValue(operation.progress_json.history)
  const channelIds = Array.isArray(operation.progress_json.channel_ids)
    ? operation.progress_json.channel_ids.filter(value => typeof value === 'string')
    : []
  const metrics: Array<{ label: string; value: string }> = []
  if (history.mode === 'all_available') {
    metrics.push({ label: 'History window', value: 'All available history' })
  } else if (typeof history.from === 'string' && typeof history.to === 'string') {
    metrics.push({ label: 'History window', value: `${formatDay(history.from)} – ${formatDay(history.to)}` })
  }
  if (channelIds.length > 0) metrics.push({ label: 'Monitors', value: String(channelIds.length) })
  if (typeof history.max_items === 'number' && Number.isFinite(history.max_items)) {
    metrics.push({ label: 'Item limit', value: history.max_items.toLocaleString() })
  }
  return metrics
}

function todaySummary(rows: ProjectResearchScanSummary[]): ProjectResearchScanSummary | null {
  // Rows are already aggregated per (workflow, UTC day); match on the same
  // UTC day boundary the backend groups by.
  const today = new Date().toISOString().slice(0, 10)
  return rows.find(row => row.scan_date === today) ?? null
}

/**
 * A rescan re-runs the windows frozen into the operation at start; it never
 * reads the saved draft. When the saved setup differs from what actually
 * executed, "search again" must start a fresh intake instead.
 */
export function savedSetupDiffersFromOperation(
  input: ProjectResearchInitialIntakeInput,
  operation: ProjectOperation | null,
): boolean {
  if (!operation) return false
  const history = objectValue(operation.progress_json.history)
  const query = objectValue(operation.progress_json.query)
  const day = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 10) : null)
  const executedMode = history.mode === 'all_available' ? 'all_available' : 'bounded_range'
  if (input.history_mode !== executedMode) return true
  if (input.history_mode === 'bounded_range'
    && (day(input.from) !== day(history.from) || day(input.to) !== day(history.to))) return true
  if (typeof history.max_items === 'number' && typeof input.max_items === 'number' && input.max_items !== history.max_items) return true
  if (typeof query.sort_by === 'string' && typeof input.monitoring_field === 'string' && input.monitoring_field !== query.sort_by) return true
  const executedStrategyId = typeof operation.progress_json.query_strategy_id === 'string'
    ? operation.progress_json.query_strategy_id
    : null
  return Boolean(input.query_strategy_id) && input.query_strategy_id !== executedStrategyId
}

export function researchResultState(input: ResearchResultStateInput): ResearchResultState {
  const pendingCheckpoints = input.checkpoints.filter(checkpoint =>
    checkpoint.status === 'pending' && isResearchHumanReviewCheckpoint(checkpoint),
  )
  const current = currentOperations(input.operations.filter(operation => operation.kind === 'research'))
  const failedOperations = current.filter(operation => operation.status === 'failed')
  const runningOperations = current.filter(operation => ['active', 'waiting_review'].includes(operation.status))
  const latestOperation = newest(current)
  const failedOperation = newest(failedOperations)
  const runningOperation = newest(runningOperations)
  const checkpoint = newest(pendingCheckpoints)
  const latestReport = latestReadableResearchReport(input.reports)
  const drift = Boolean(input.projectQuestion && workflowQuestion(input.workflow) && input.projectQuestion !== workflowQuestion(input.workflow))
  const monitoring = monitoringActive(input.workflow)
  const latestTodaySummary = todaySummary(input.scanSummaries)
  const noReportOutcome = completedWithoutReport(latestOperation)

  const candidates: Array<{ active: boolean; notice: string }> = [
    { active: drift, notice: 'The research question changed; existing judgements and reports still use the previous question.' },
    { active: pendingCheckpoints.length > 0, notice: `${pendingCheckpoints.length} research review${pendingCheckpoints.length === 1 ? '' : 's'} waiting for a decision.` },
    { active: failedOperations.length > 0, notice: `${failedOperations.length} research operation${failedOperations.length === 1 ? '' : 's'} failed and can be retried.` },
    { active: runningOperations.length > 0, notice: `${runningOperations.length} research operation${runningOperations.length === 1 ? ' is' : 's are'} still running.` },
    { active: monitoring, notice: `Monitoring is active. Last project scan: ${formatDate(latestScanAt(input.workflow))}.` },
  ]
  const noticesFor = (excluded: number) => candidates.flatMap((candidate, index) => candidate.active && index !== excluded ? [candidate.notice] : [])
  const corpusMetrics = [
    { label: 'Papers', value: input.paperCount.toLocaleString() },
    { label: 'Included', value: input.includedCount.toLocaleString() },
    { label: 'Reports', value: input.reports.length.toLocaleString() },
  ]

  if (!input.workflow && !latestOperation) {
    return {
      kind: 'setup', eyebrow: 'Ready to begin',
      conclusion: input.projectQuestion ? 'Set up the literature search to start this review.' : 'Add a research question to start this review.',
      detail: 'Choose the literature monitors and history window that will seed the first screening pass.',
      metrics: corpusMetrics, primaryAction: { key: 'configure', label: 'Set up research' }, secondaryAction: null,
      operation: null, checkpoint: null, latestReport, notices: [], failure: null,
    }
  }
  if (drift) {
    return {
      kind: 'question_drift', eyebrow: 'Decision needed',
      conclusion: 'The research question changed after this workflow started.',
      detail: 'Choose how the new question should apply before another judgement run starts.',
      metrics: corpusMetrics, primaryAction: { key: 'resolve_question', label: 'Resolve question change' }, secondaryAction: latestReport ? { key: 'open_report', label: 'Open previous report' } : null,
      operation: null, checkpoint: null, latestReport, notices: noticesFor(0), failure: null,
    }
  }
  if (checkpoint) {
    return {
      kind: 'checkpoint', eyebrow: 'Review required',
      conclusion: checkpoint.checkpoint_type === 'idea_review' ? 'Idea candidates are ready for your decision.' : 'Screening results are ready for your decision.',
      detail: 'Your decision controls what enters the formal research outputs.',
      metrics: corpusMetrics, primaryAction: { key: 'review_results', label: 'Review results' }, secondaryAction: latestReport ? { key: 'open_report', label: 'Open latest report' } : null,
      operation: runningOperation, checkpoint, latestReport, notices: noticesFor(1), failure: null,
    }
  }
  if (failedOperation) {
    const failure = researchFailurePresentation(failedOperation)
    return {
      kind: 'failure', eyebrow: 'Research interrupted',
      conclusion: failure.conclusion,
      detail: 'Your completed research data is unchanged.',
      metrics: corpusMetrics, primaryAction: { key: 'retry', label: 'Retry' }, secondaryAction: latestReport ? { key: 'open_report', label: 'Open latest report' } : null,
      operation: failedOperation, checkpoint: null, latestReport, notices: noticesFor(2), failure,
    }
  }
  if (runningOperation) {
    return {
      kind: 'running', eyebrow: 'Research in progress',
      conclusion: `${operationStage(runningOperation).replace(/^./, value => value.toUpperCase())} is in progress.`,
      detail: 'This page updates as the operation advances.',
      metrics: [...operationScopeMetrics(runningOperation), ...corpusMetrics],
      primaryAction: null, secondaryAction: latestReport ? { key: 'open_report', label: 'Open latest report' } : null,
      operation: runningOperation, checkpoint: null, latestReport, notices: noticesFor(3), failure: null,
    }
  }
  if (latestOperation && isEmptySearch(latestOperation)) {
    const scopeMetrics = operationScopeMetrics(latestOperation)
    return {
      kind: 'completed', eyebrow: 'Search complete',
      conclusion: 'No papers matched the selected query strategy and history window.',
      detail: input.savedSetupDiffers
        ? 'The saved setup changed after this search. Search again starts a new search with the updated dates, monitors, and limits.'
        : 'Search again re-runs the same history windows with the monitor queries as saved now. Adjust the setup first if the date range, monitors, or item limit need to change.',
      metrics: scopeMetrics.length > 0 ? scopeMetrics : corpusMetrics,
      primaryAction: { key: input.savedSetupDiffers ? 'start_search' : 'rescan', label: 'Search again' },
      secondaryAction: { key: 'configure', label: 'Review search settings' },
      operation: latestOperation, checkpoint: null, latestReport, notices: monitoring ? noticesFor(-1) : [], failure: null,
    }
  }
  if (latestOperation && noReportOutcome) {
    const suggestions = Array.isArray(noReportOutcome.suggestions)
      ? noReportOutcome.suggestions.filter((item): item is string => typeof item === 'string')
      : []
    const noRelevant = noReportOutcome.kind === 'no_relevant_sources'
    return {
      kind: 'completed', eyebrow: 'Research result',
      conclusion: noRelevant
        ? 'The search and screening completed, but no relevant evidence remained for a report.'
        : 'The evidence did not support a coherent citation-backed report.',
      detail: suggestions[0]
        ?? (typeof noReportOutcome.message === 'string' ? noReportOutcome.message : 'Review the corpus and research scope before starting another search.'),
      metrics: corpusMetrics,
      primaryAction: { key: 'view_corpus', label: 'Review collected papers' },
      secondaryAction: { key: 'configure', label: 'Adjust research scope' },
      operation: latestOperation, checkpoint: null, latestReport, notices: monitoring ? noticesFor(-1) : [], failure: null,
    }
  }
  if (monitoring && latestTodaySummary) {
    const relevantUpdates = latestTodaySummary.relevant_count + latestTodaySummary.maybe_count
    return {
      kind: 'monitoring_update', eyebrow: 'Today’s monitoring update',
      conclusion: latestTodaySummary.new_item_count === 0
        ? 'Today’s scans found no new papers.'
        : relevantUpdates === 0
          ? `${latestTodaySummary.new_item_count.toLocaleString()} new paper${latestTodaySummary.new_item_count === 1 ? '' : 's'} found, with no relevant updates.`
          : `${latestTodaySummary.new_item_count.toLocaleString()} new paper${latestTodaySummary.new_item_count === 1 ? '' : 's'} found today.`,
      detail: `Latest scan: ${formatDate(latestTodaySummary.scanned_at)}.`,
      metrics: [
        { label: 'New', value: latestTodaySummary.new_item_count.toLocaleString() },
        { label: 'Relevant', value: latestTodaySummary.relevant_count.toLocaleString() },
        { label: 'Maybe', value: latestTodaySummary.maybe_count.toLocaleString() },
      ],
      primaryAction: { key: 'view_corpus', label: 'View update' },
      secondaryAction: latestReport ? { key: 'open_report', label: 'Open report' } : null,
      operation: latestOperation, checkpoint: null, latestReport, notices: [], failure: null,
    }
  }
  if (monitoring) {
    return {
      kind: 'monitoring', eyebrow: 'Monitoring active',
      conclusion: latestReport ? 'The latest research report is ready.' : 'The initial review is complete and monitoring is running.',
      detail: `Last project scan: ${formatDate(latestScanAt(input.workflow))}.`,
      metrics: corpusMetrics, primaryAction: latestReport ? { key: 'open_report', label: 'Open report' } : { key: 'view_corpus', label: 'View corpus' }, secondaryAction: latestReport ? { key: 'view_corpus', label: 'View corpus' } : null,
      operation: latestOperation, checkpoint: null, latestReport, notices: [], failure: null,
    }
  }
  return {
    kind: 'completed', eyebrow: 'Research complete',
    conclusion: latestReport ? 'Your latest research report is ready.' : 'The current research run is complete.',
    detail: latestReport ? `Generated for: ${latestReport.research_question}` : 'Review the collected corpus and start another run when needed.',
    metrics: corpusMetrics, primaryAction: latestReport ? { key: 'open_report', label: 'Open report' } : { key: 'view_corpus', label: 'View corpus' }, secondaryAction: latestReport ? { key: 'view_corpus', label: 'View corpus' } : null,
    operation: latestOperation, checkpoint: null, latestReport, notices: [], failure: null,
  }
}
