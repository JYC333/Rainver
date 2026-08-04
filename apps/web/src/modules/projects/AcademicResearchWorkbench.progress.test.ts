import { describe, expect, it } from 'vitest'
import type { ProjectOperation } from '../../types/api'
import { researchOperationDetail, researchOperationPercent, researchOperationSteps, synthesisHealth } from './AcademicResearchWorkbench'

function operation(overrides: Partial<ProjectOperation['progress_json']> = {}): ProjectOperation {
  return {
    id: 'operation-1',
    project_id: 'project-1',
    kind: 'research',
    title: 'Initial literature intake',
    status: 'active',
    progress_json: {
      run_kind: 'baseline',
      current_stage: 'backfill',
      ...overrides,
    },
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
  }
}

describe('AcademicResearchWorkbench operation progress', () => {
  it('reports backfill windows and ingestion records', () => {
    expect(researchOperationDetail(operation({
      backfill_progress: {
        total_segments: 20,
        completed_segments: 8,
        failed_segments: 0,
        running_segments: 1,
        pending_segments: 11,
        items_ingested: 437,
        plans: [],
        updated_at: '2026-07-15T00:00:00.000Z',
      },
    }))).toBe('8/20 history windows · 437 ingestion records')
  })

  it('shows deferred source windows as background recovery instead of failure', () => {
    expect(researchOperationDetail(operation({
      backfill_progress: {
        total_segments: 2,
        completed_segments: 1,
        failed_segments: 0,
        deferred_segments: 1,
        running_segments: 0,
        pending_segments: 1,
        items_ingested: 10,
        plans: [],
        updated_at: '2026-07-15T00:00:00.000Z',
      },
    }))).toBe('1/2 history windows · 10 ingestion records · 1 retrying in background')
  })

  it('shows unique papers separately from ingestion records', () => {
    expect(researchOperationDetail(operation({
      source_item_ids: ['paper-1', 'paper-1', 'paper-2'],
      backfill_progress: {
        total_segments: 20,
        completed_segments: 20,
        failed_segments: 0,
        running_segments: 0,
        pending_segments: 0,
        items_ingested: 150,
        plans: [],
        updated_at: '2026-07-15T00:00:00.000Z',
      },
    }))).toBe('20/20 history windows · 2 unique papers · 150 ingestion records')
  })

  it('advances the visible progress as backfill windows complete', () => {
    const before = researchOperationPercent(operation({
      backfill_progress: {
        total_segments: 20,
        completed_segments: 2,
        failed_segments: 0,
        running_segments: 1,
        pending_segments: 17,
        items_ingested: 20,
        plans: [],
        updated_at: '2026-07-15T00:00:00.000Z',
      },
    }))
    const after = researchOperationPercent(operation({
      backfill_progress: {
        total_segments: 20,
        completed_segments: 12,
        failed_segments: 0,
        running_segments: 1,
        pending_segments: 7,
        items_ingested: 120,
        plans: [],
        updated_at: '2026-07-15T00:00:00.000Z',
      },
    }))
    expect(after).toBeGreaterThan(before)
  })

  it('reports screening batches and classified papers', () => {
    const value = operation({
      current_stage: 'screening',
      screening_progress: {
        phase: 'screening_batches',
        total_items: 87,
        classified_items: 20,
        unclassified_items: 67,
        relevant_items: 12,
        maybe_items: 8,
        excluded_items: 0,
        missing_full_text: 10,
        evidence_count: 20,
        failed_items: 0,
        batch_size: 10,
        total_batches: 9,
        completed_batches: 2,
        active_batches: 1,
        queued_batches: 0,
        running_batches: 1,
        failed_batches: 0,
        started_at: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-15T00:05:00.000Z',
        message: 'Screening batch 3 of 9 is in progress · 20/87 papers classified.',
      },
    })
    expect(researchOperationDetail(value)).toBe('2/9 screening batches · model processing · 20/87 papers classified')
    expect(researchOperationPercent(value)).toBeGreaterThan(40)
  })

  it('distinguishes a screening batch waiting in the queue from model processing', () => {
    const value = operation({
      current_stage: 'screening',
      screening_progress: {
        phase: 'screening_batches',
        total_items: 4,
        classified_items: 0,
        total_batches: 1,
        completed_batches: 0,
        active_batches: 1,
        queued_batches: 1,
        running_batches: 0,
      },
    })
    expect(researchOperationDetail(value)).toBe('0/1 screening batches · queued · 0/4 papers classified')
    expect(researchOperationSteps(value)[2]?.title).toBe('Screen papers')
    value.status = 'waiting_review'
    expect(researchOperationSteps(value)[2]?.title).toBe('Review screening')
  })

  it('reports comparison batches remaining and papers compared', () => {
    const value = operation({
      current_stage: 'comparison',
      comparison_run_id: 'run-1',
      comparison_source_item_ids: ['paper-7'],
      comparison_pending_source_item_ids: ['paper-8', 'paper-9', 'paper-10', 'paper-11', 'paper-12', 'paper-13'],
      comparison_failed_source_item_ids: ['paper-14'],
      comparison_results_json: [
        { source_item_id: 'paper-1', stance: 'supports', detail: 'x', affected_sections: [] },
        { source_item_id: 'paper-2', stance: 'supports', detail: 'x', affected_sections: [] },
      ],
    })
    value.steps = [
      { id: 's0', operation_id: 'operation-1', seq: 0, title: '', status: 'done' },
      { id: 's1', operation_id: 'operation-1', seq: 1, title: '', status: 'done' },
      { id: 's2', operation_id: 'operation-1', seq: 2, title: '', status: 'done' },
      { id: 's3', operation_id: 'operation-1', seq: 3, title: '', status: 'active', detail_json: { run_id: 'run-1', remaining_batches: 2 } },
      { id: 's4', operation_id: 'operation-1', seq: 4, title: '', status: 'pending' },
    ]
    // 2 done + 1 in flight + 6 pending + 1 failed = 10 total papers.
    expect(researchOperationDetail(value)).toBe('2 batches remaining · 2/10 papers compared')
    expect(researchOperationPercent(value)).toBeGreaterThan(40)
  })

  it('shows a preparing state for comparison before the first batch has been dispatched', () => {
    const value = operation({
      current_stage: 'comparison',
      comparison_pending_source_item_ids: ['paper-1', 'paper-2'],
      comparison_failed_source_item_ids: [],
      comparison_results_json: [],
    })
    expect(researchOperationDetail(value)).toBe('Preparing comparison batches · 0/2 papers compared')
  })

  it('stops at setup when the source search completed with no papers', () => {
    const value = operation({
      current_stage: 'complete',
      stage_state: 'skipped',
      empty_result: {
        kind: 'no_source_items',
        source_item_count: 0,
        detected_at: '2026-07-15T00:05:00.000Z',
        message: 'Search completed, but no papers matched the selected source and history window.',
      },
    })
    value.status = 'completed'
    expect(researchOperationDetail(value)).toBe('Search returned 0 papers · setup required')
    expect(researchOperationPercent(value)).toBe(40)
  })

  it('distinguishes a live worker heartbeat from a stale running job', () => {
    const now = new Date().toISOString()
    expect(synthesisHealth({ run_status: 'running', job_status: 'running', job_heartbeat_at: now })).toMatchObject({
      label: 'Worker is active',
      variant: 'success',
    })
    expect(synthesisHealth({
      run_status: 'running',
      job_status: 'running',
      job_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    })).toMatchObject({
      label: 'No recent worker heartbeat',
      variant: 'destructive',
    })
  })

  it('keeps a failed operation on the stage that actually failed', () => {
    const value = operation({
      current_stage: 'failed',
      failed_stage: 'screening',
      screening_progress: {
        phase: 'failed',
        total_items: 87,
        classified_items: 18,
        unclassified_items: 69,
        relevant_items: 10,
        maybe_items: 8,
        excluded_items: 0,
        missing_full_text: 10,
        evidence_count: 18,
        failed_items: 0,
        batch_size: 10,
        total_batches: 9,
        completed_batches: 2,
        active_batches: 0,
        failed_batches: 1,
        started_at: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-15T00:05:00.000Z',
        message: 'A screening batch failed.',
      },
    })
    value.status = 'failed'
    expect(researchOperationDetail(value)).toBe('2/9 screening batches · 18/87 papers classified')
    expect(researchOperationPercent(value)).toBeGreaterThan(40)
  })
})
