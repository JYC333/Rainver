import { describe, expect, it } from 'vitest'
import type {
  InquiryEvidenceSignal, InquiryNextFocusKind, InquiryThreadDetail, ProjectResearchWorkflow,
} from '../../../../types/api'
import {
  NEXT_FOCUS_KINDS, isQuestionRefined, nextFocusDestination, startedWorkflowFor, suggestNextFocus,
} from '../nextFocus'

const THREAD: InquiryThreadDetail = {
  id: 'thread-1', space_id: 'space-1', project_id: 'project-1',
  kind: 'question', statement: 'Does caching help?',
  lifecycle_status: 'active', attention_state: 'backlog', priority: 1,
  primary_parent_id: null, owner_user_id: null,
  next_focus_kind: null, next_focus_note: null, blocked_reason: null,
  version: 1, created_from: 'user', created_by_user_id: 'user-1',
  created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
  question_state: { current_answer_summary: null, answer_state: 'open', known_gaps: null, answerability: null, resolution_criteria: null },
  hypothesis_state: null,
  relations: [], note_links: [], in_personal_focus: false,
}

function workflow(overrides: Partial<ProjectResearchWorkflow> = {}): ProjectResearchWorkflow {
  return {
    id: 'workflow-1', project_id: 'project-1', workflow_type: 'literature_review',
    current_stage: 'screening', status: 'active', mode: 'autonomous',
    state_json: {}, primary_thread_id: 'thread-1',
    started_by_user_id: null, started_run_id: null,
    created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    ...overrides,
  } as ProjectResearchWorkflow
}

function signal(classification: string): InquiryEvidenceSignal {
  return {
    id: `signal-${classification}`, space_id: 'space-1', project_id: 'project-1', thread_id: 'thread-1',
    corpus_item_id: 'corpus-1', classification, is_material: false, confidence: 0.8,
    model_version: 'v1', source_provenance: {}, dedupe_key: 'k', producer_idempotency_key: null,
    status: 'auto_attached', candidate_id: null, created_by_user_id: null, created_by_run_id: null,
    created_at: '2026-07-23T00:00:00.000Z',
  }
}

describe('nextFocusDestination', () => {
  const context = { projectId: 'project-1', threadId: 'thread-1', startedWorkflow: null }

  it('gives every Next Focus a destination except the one that is a state', () => {
    for (const kind of NEXT_FOCUS_KINDS) {
      const destination = nextFocusDestination(kind, context)
      if (kind === 'pause') expect(destination.kind).toBe('none')
      else expect(destination.kind).not.toBe('none')
    }
  })

  it('sends search_acquisition to Research Setup before a search runs and to Operations after', () => {
    expect(nextFocusDestination('search_acquisition', context)).toEqual({
      kind: 'link',
      to: '/projects/project-1?research=new&thread=thread-1',
      cta: 'Start literature search',
    })
    expect(nextFocusDestination('search_acquisition', { ...context, startedWorkflow: workflow() })).toEqual({
      kind: 'link',
      to: '/projects/project-1/operations',
      cta: 'Watch the running search',
    })
  })

  it('keeps read_evidence on this page instead of leaving for a Project-wide list', () => {
    expect(nextFocusDestination('read_evidence', context)).toEqual({
      kind: 'tab', tab: 'evidence', cta: 'Review this Thread’s evidence',
    })
  })

  it('routes each remaining Focus to the Area that owns that work', () => {
    const expected: Partial<Record<InquiryNextFocusKind, string>> = {
      clarify_or_decompose: '/projects/project-1/inquiry/thread-1/assess',
      design_run_experiment: '/projects/project-1/experiments',
      create_decision_case: '/projects/project-1/decisions',
      create_delivery_task: '/projects/project-1/delivery',
      wait_for_monitoring: '/projects/project-1/operations',
      promote_knowledge: '/projects/project-1/knowledge-review',
      synthesize: '/projects/project-1/research',
    }
    for (const [kind, to] of Object.entries(expected)) {
      const destination = nextFocusDestination(kind as InquiryNextFocusKind, context)
      expect(destination).toMatchObject({ kind: 'link', to })
    }
  })
})

describe('startedWorkflowFor', () => {
  it('ignores a not_started Workflow because intake is setup, not a running search', () => {
    expect(startedWorkflowFor('thread-1', [workflow({ status: 'not_started' })])).toBeNull()
    expect(startedWorkflowFor('thread-1', [workflow({ status: 'active' })])).not.toBeNull()
  })

  it('ignores Workflows belonging to another Thread', () => {
    expect(startedWorkflowFor('thread-2', [workflow()])).toBeNull()
  })
})

describe('isQuestionRefined', () => {
  it('treats wording as refined only when the draft explicitly records that refinement ran', () => {
    expect(isQuestionRefined(null)).toBe(false)
    expect(isQuestionRefined(workflow({ state_json: {} }))).toBe(false)
    expect(isQuestionRefined(workflow({ state_json: { question_refine_skipped: true } }))).toBe(false)
    expect(isQuestionRefined(workflow({ state_json: { question_refine_skipped: false } }))).toBe(true)
  })
})

describe('suggestNextFocus', () => {
  const base = { detail: THREAD, signals: [], pendingCandidateCount: 0, startedWorkflow: null, questionRefined: true }

  it('suggests assessing the wording when it has never been through refinement', () => {
    const suggestions = suggestNextFocus({ ...base, questionRefined: false })
    expect(suggestions.map(item => item.kind)).toContain('clarify_or_decompose')
  })

  it('suggests a search when no evidence has reached the Thread', () => {
    expect(suggestNextFocus(base).map(item => item.kind)).toContain('search_acquisition')
  })

  it('suggests waiting rather than searching again while a search is running', () => {
    const suggestions = suggestNextFocus({ ...base, startedWorkflow: workflow() })
    expect(suggestions.map(item => item.kind)).toContain('wait_for_monitoring')
    expect(suggestions.map(item => item.kind)).not.toContain('search_acquisition')
  })

  it('surfaces pending review as a reason to read evidence, with the count in the reason', () => {
    const suggestions = suggestNextFocus({ ...base, pendingCandidateCount: 2 })
    const readEvidence = suggestions.find(item => item.kind === 'read_evidence')
    expect(readEvidence?.reason).toContain('2 material changes')
  })

  it('suggests an experiment for an untested Hypothesis', () => {
    const hypothesis: InquiryThreadDetail = {
      ...THREAD,
      kind: 'hypothesis',
      question_state: null,
      hypothesis_state: {
        proposed_claim: 'Caching halves p95 latency',
        predictions: null,
        falsification_criteria: null,
        evaluation_state: 'untested',
        confidence: null,
        confidence_method: null,
      },
    }
    expect(suggestNextFocus({ ...base, detail: hypothesis }).map(item => item.kind)).toContain('design_run_experiment')
  })

  it('suggests synthesizing once a partial answer has evidence behind it', () => {
    const partial: InquiryThreadDetail = {
      ...THREAD,
      question_state: { ...THREAD.question_state!, answer_state: 'partial' },
    }
    const suggestions = suggestNextFocus({ ...base, detail: partial, signals: [signal('supports')] })
    expect(suggestions.map(item => item.kind)).toContain('synthesize')
  })

  it('stays a short list of distinct suggestions', () => {
    const answered: InquiryThreadDetail = {
      ...THREAD,
      question_state: { ...THREAD.question_state!, answer_state: 'answered' },
    }
    const suggestions = suggestNextFocus({
      ...base, detail: answered, questionRefined: false, pendingCandidateCount: 3, signals: [signal('supports')],
    })
    expect(suggestions.length).toBeLessThanOrEqual(3)
    expect(new Set(suggestions.map(item => item.kind)).size).toBe(suggestions.length)
  })
})
