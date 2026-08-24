import { describe, expect, it } from 'vitest'
import type { ProjectOperation, ProjectResearchReport, ProjectResearchCheckpoint, ProjectResearchInitialIntakeInput, ProjectResearchScanSummary, ProjectResearchWorkflow } from '../../types/api'
import { researchFailurePresentation, researchResultState, savedSetupDiffersFromOperation } from './researchResultState'

const workflow = (state: Record<string, unknown> = {}): ProjectResearchWorkflow => ({
  id: 'workflow-1', project_id: 'project-1', current_stage: 'complete', status: 'active',
  state_json: { research_question: 'Old question', monitoring: { active: true }, ...state }, primary_thread_id: null, started_by_user_id: null, started_run_id: null,
  created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-18T08:00:00Z',
})

const operation = (status: ProjectOperation['status'], createdAt: string, progress: Record<string, unknown> = {}): ProjectOperation => ({
  id: `${status}-${createdAt}`, project_id: 'project-1', kind: 'research', title: 'Research', status,
  progress_json: { current_stage: 'screening', ...progress }, created_at: createdAt, updated_at: createdAt,
})

const checkpoint = (): ProjectResearchCheckpoint => ({
  id: 'checkpoint-1', project_id: 'project-1', workflow_id: 'workflow-1', stage_key: 'screening', checkpoint_type: 'screening_gate', status: 'pending',
  machine_result_json: null, review: null, user_decision: null, decision_reason: null, decided_by_user_id: null, decided_at: null,
  created_at: '2026-07-18T09:00:00Z', updated_at: '2026-07-18T09:00:00Z',
})

const report = (): ProjectResearchReport => ({
  id: 'report-1', project_id: 'project-1', workflow_id: 'workflow-1', operation_id: 'operation-1', synthesis_run_id: 'run-1',
  run_kind: 'baseline', research_question: 'Old question', research_question_version: 1, status: 'complete',
  created_at: '2026-07-18T07:00:00Z', updated_at: '2026-07-18T07:00:00Z',
})

function state(overrides: Partial<Parameters<typeof researchResultState>[0]> = {}) {
  return researchResultState({ projectQuestion: 'Old question', workflow: workflow(), checkpoints: [], operations: [], reports: [report()], scanSummaries: [], materialCount: 12, includedCount: 4, ...overrides })
}

describe('researchResultState', () => {
  it('uses the documented precedence and keeps concurrent states as notices', () => {
    const result = state({
      projectQuestion: 'New question', checkpoints: [checkpoint()],
      operations: [operation('failed', '2026-07-18T08:00:00Z'), operation('active', '2026-07-18T10:00:00Z')],
    })
    expect(result.kind).toBe('question_drift')
    expect(result.primaryAction?.key).toBe('resolve_question')
    expect(result.notices).toHaveLength(4)
  })

  it('does not promote a newer rejected report over a readable report', () => {
    const readable = report()
    const rejected = { ...report(), id: 'rejected', status: 'rejected' as const, created_at: '2026-07-19T07:00:00Z' }
    expect(state({ reports: [readable, rejected] }).latestReport?.id).toBe(readable.id)
  })

  it('puts a blocking checkpoint before failed and running operations', () => {
    const result = state({ checkpoints: [checkpoint()], operations: [operation('failed', '2026-07-18T08:00:00Z'), operation('active', '2026-07-18T10:00:00Z')] })
    expect(result.kind).toBe('checkpoint')
    expect(result.primaryAction?.key).toBe('review_results')
  })

  it('keeps research usable while a source history window retries in the background', () => {
    const result = state({
      operations: [operation('active', '2026-07-18T10:00:00Z', {
        current_stage: 'screening',
        backfill_progress: {
          deferred_sources: [{ provider_key: 'arxiv', next_retry_at: '2026-07-18T10:05:00Z' }],
        },
      })],
    })
    expect(result.kind).toBe('running')
    expect(result.notices).toContain('arxiv history (1 window) is temporarily unavailable and retrying in the background; collected material can continue through research.')
  })

  it('puts any failed auxiliary operation before a newer running operation', () => {
    const result = state({ operations: [operation('failed', '2026-07-18T08:00:00Z', { run_kind: 'historical_backfill' }), operation('active', '2026-07-18T10:00:00Z')] })
    expect(result.kind).toBe('failure')
    expect(result.primaryAction?.key).toBe('retry')
    expect(result.notices).toContain('1 research operation is still running.')
  })

  it('presents a cancelled operation as stopped instead of completed', () => {
    const result = state({
      workflow: workflow({ monitoring: { active: false } }),
      operations: [operation('cancelled', '2026-07-18T10:00:00Z')],
      reports: [],
    })
    expect(result.kind).toBe('cancelled')
    expect(result.eyebrow).toBe('Research stopped')
    expect(result.conclusion).toContain('cancelled')
    expect(result.operation?.status).toBe('cancelled')
  })

  it('does not show a pending checkpoint that belongs to a cancelled operation', () => {
    const cancelled = operation('cancelled', '2026-07-18T10:00:00Z')
    const pending = checkpoint()
    pending.machine_result_json = { operation_id: cancelled.id }
    const result = state({
      workflow: workflow({ monitoring: { active: false } }),
      operations: [cancelled],
      checkpoints: [pending],
      reports: [],
    })
    expect(result.kind).toBe('cancelled')
    expect(result.checkpoint).toBeNull()
  })

  it('shows the newer running operation, not a stale failed one for the same workflow', () => {
    // A retry (or an auto-created incremental scan) creates a fresh operation
    // for the same workflow rather than reusing the old one — the old one
    // stays "failed" forever in history. This must not be surfaced as the
    // retriable failure once a newer operation for that same workflow is
    // already running: the backend allows only one active operation per
    // workflow, so a "Retry" pointed at the stale one would 409.
    const result = state({
      operations: [
        operation('failed', '2026-07-18T08:00:00Z', { workflow_id: 'workflow-1', current_stage: 'failed', failed_stage: 'comparison' }),
        operation('active', '2026-07-18T10:00:00Z', { workflow_id: 'workflow-1', current_stage: 'comparison' }),
      ],
    })
    expect(result.kind).toBe('running')
    expect(result.operation?.status).toBe('active')
    expect(result.primaryAction).toBeNull()
    expect(result.notices).not.toContain('1 research operation failed and can be retried.')
  })

  it('does not call an unscanned monitoring day empty', () => {
    const result = state({ workflow: workflow({ monitoring: { active: true } }) })
    expect(result.kind).toBe('monitoring')
    expect(result.detail).toContain('Last project scan:')
    expect(result.conclusion).not.toContain('No relevant updates')
  })

  it('promotes a persisted scan from today into the result position', () => {
    const scannedAt = new Date().toISOString()
    const summary: ProjectResearchScanSummary = {
      workflow_id: 'workflow-1', scan_date: scannedAt.slice(0, 10), scanned_at: scannedAt,
      new_item_count: 7, relevant_count: 2, maybe_count: 1, excluded_count: 4, scan_count: 1,
      supports_count: 1, contradicts_count: 1, new_direction_count: 1, comparisons: [], integrity_alerts: [],
    }
    const result = state({ scanSummaries: [summary] })
    expect(result.kind).toBe('monitoring_update')
    expect(result.conclusion).toContain('7 new items')
    expect(result.primaryAction).toEqual({ key: 'view_corpus', label: 'View update' })
  })

  it('gives a zero-result search a direct search-again action plus a settings entry', () => {
    const result = state({
      workflow: workflow({ monitoring: { active: false } }),
      operations: [operation('completed', '2026-07-18T10:00:00Z', {
        current_stage: 'complete', empty_result: { kind: 'no_source_items' },
        history: { mode: 'bounded_range', from: '2024-01-01T00:00:00Z', to: '2026-07-18T00:00:00Z', max_items: 1000 },
        channel_ids: ['channel-1', 'channel-2'],
      })],
      reports: [],
    })
    expect(result.kind).toBe('completed')
    expect(result.primaryAction).toEqual({ key: 'rescan', label: 'Search again' })
    expect(result.secondaryAction).toEqual({ key: 'configure', label: 'Review search settings' })
    expect(result.metrics).toEqual([
      { label: 'History window', value: expect.stringContaining('2024') },
      { label: 'Monitors', value: '2' },
      { label: 'Item limit', value: (1000).toLocaleString() },
    ])
  })

  it('switches search-again to a fresh start when the saved setup changed after the empty search', () => {
    const result = state({
      workflow: workflow({ monitoring: { active: false } }),
      operations: [operation('completed', '2026-07-18T10:00:00Z', { current_stage: 'complete', empty_result: { kind: 'no_source_items' } })],
      reports: [],
      savedSetupDiffers: true,
    })
    expect(result.primaryAction).toEqual({ key: 'start_search', label: 'Search again' })
    expect(result.detail).toContain('updated dates')
  })

  it('presents an empty approved corpus as a completed research outcome', () => {
    const result = state({
      operations: [operation('completed', '2026-07-18T10:00:00Z', {
        current_stage: 'complete',
        empty_result: {
          kind: 'no_relevant_sources', source_item_count: 8, relevant_source_count: 0,
          message: 'No screened papers remained.', suggestions: ['Broaden the inclusion scope.'],
        },
      })],
      reports: [],
    })
    expect(result.kind).toBe('completed')
    expect(result.conclusion).toContain('no relevant evidence')
    expect(result.detail).toBe('Broaden the inclusion scope.')
    expect(result.primaryAction).toEqual({ key: 'view_corpus', label: 'Review collected material' })
    expect(result.failure).toBeNull()
  })

  it('detects when the saved setup differs from what the search executed', () => {
    const executed = operation('completed', '2026-07-18T10:00:00Z', {
      current_stage: 'complete', empty_result: { kind: 'no_source_items' },
      history: { mode: 'bounded_range', from: '2026-07-15T00:00:00Z', to: '2026-07-18T00:00:00Z', max_items: 1000 },
      query: { sort_by: 'submittedDate' },
      channel_ids: ['channel-1'],
      query_strategy_id: 'strategy-1',
    })
    const saved: ProjectResearchInitialIntakeInput = {
      research_question: 'Old question', query_strategy_id: 'strategy-1', history_mode: 'bounded_range',
      from: '2026-07-15', to: '2026-07-18', max_items: 1000, monitoring_field: 'submittedDate', report_depth: 'quick', question_refine_skipped: false, execution: {},
    }
    expect(savedSetupDiffersFromOperation(saved, executed)).toBe(false)
    expect(savedSetupDiffersFromOperation({ ...saved, from: '2024-01-01' }, executed)).toBe(true)
    expect(savedSetupDiffersFromOperation({ ...saved, max_items: 500 }, executed)).toBe(true)
    expect(savedSetupDiffersFromOperation({ ...saved, query_strategy_id: 'strategy-2' }, executed)).toBe(true)
    expect(savedSetupDiffersFromOperation(saved, null)).toBe(false)
  })

  it('shows the executed history window while a search is running', () => {
    const result = state({
      operations: [operation('active', '2026-07-18T10:00:00Z', {
        current_stage: 'backfill',
        history: { mode: 'all_available', max_items: 1000 },
        channel_ids: ['channel-1'],
      })],
      reports: [],
    })
    expect(result.kind).toBe('running')
    expect(result.metrics[0]).toEqual({ label: 'History window', value: 'All available history' })
  })

  it('maps structured-output failures to a plain-language action and keeps diagnostics', () => {
    const failed = operation('failed', '2026-07-18T10:00:00Z', {
      failed_stage: 'synthesis',
      error: { code: 'synthesis_output_invalid', message: 'strict JSON schema mismatch', diagnostics: { path: '$.findings' } },
    })
    const presentation = researchFailurePresentation(failed)
    expect(presentation.conclusion).toContain('unusable structured research result')
    expect(presentation.suggestion).toContain('strict JSON')
    expect(presentation.technical).toContain('$.findings')
  })

  it('explains exhausted source backfill retries and preserves the actionable diagnostics', () => {
    const failed = operation('failed', '2026-07-30T20:25:55Z', {
      failed_stage: 'backfill',
      error: {
        code: 'source_history_backfill_failed',
        message: 'History import from arXiv failed after 2 automatic attempts because the provider returned HTTP 500.',
        diagnostics: {
          retryable: true,
          failed_sources: [{
            provider_key: 'arxiv',
            provider_display_name: 'arXiv',
            upstream_status: 500,
            automatic_attempts: 2,
          }],
        },
      },
    })
    const presentation = researchFailurePresentation(failed)
    expect(presentation.conclusion).toBe('History import from arXiv did not complete.')
    expect(presentation.suggestion).toContain('already retried automatically')
    expect(presentation.suggestion).toContain('completed material and results will be kept')
    expect(presentation.technical).toContain('"upstream_status": 500')
  })

  it('treats a legacy source 429 as transient even when its stored retryable flag is false', () => {
    const failed = operation('failed', '2026-08-03T10:00:00Z', {
      failed_stage: 'backfill',
      error: {
        code: 'source_history_backfill_failed',
        message: 'History import from Semantic Scholar failed because the provider returned HTTP 429.',
        diagnostics: {
          retryable: false,
          failed_sources: [{ provider_display_name: 'Semantic Scholar', upstream_status: 429 }],
        },
      },
    })

    const presentation = researchFailurePresentation(failed)
    expect(presentation.conclusion).toBe('History import from Semantic Scholar did not complete.')
    expect(presentation.suggestion).toContain('background backoff')
    expect(presentation.suggestion).not.toContain('correct the source setup')
  })

  it('explains exhausted model-provider retries without hiding the underlying run diagnostics', () => {
    const failed = operation('failed', '2026-07-30T21:28:13Z', {
      failed_stage: 'synthesis',
      error: {
        code: 'provider_network_error',
        message: 'MiniMax request failed: Connect Timeout Error',
        diagnostics: {
          execution_id: 'execution-1',
          run_id: 'run-1',
          stage: 'synthesis_critique',
          retryable: true,
          automatic_retry_exhausted: true,
        },
      },
    })
    const presentation = researchFailurePresentation(failed)
    expect(presentation.conclusion).toContain('automatic retries were exhausted')
    expect(presentation.suggestion).toContain('completed research data was kept')
    expect(presentation.technical).toContain('"stage": "synthesis_critique"')
    expect(presentation.technical).toContain('"run_id": "run-1"')
  })
})
