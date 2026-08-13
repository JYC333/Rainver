import { describe, expect, it } from 'vitest'
import type { InquiryNextFocusKind, ProjectResearchWorkflow } from '../../../../types/api'
import {
  NEXT_FOCUS_LABELS, isQuestionRefined, nextFocusDestination, startedWorkflowFor,
} from '../nextFocus'

function workflow(overrides: Partial<ProjectResearchWorkflow> = {}): ProjectResearchWorkflow {
  return {
    id: 'workflow-1', project_id: 'project-1',
    current_stage: 'screening', status: 'active', mode: 'autonomous',
    state_json: {}, primary_thread_id: 'thread-1',
    started_by_user_id: null, started_run_id: null,
    created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    ...overrides,
  } as ProjectResearchWorkflow
}

describe('nextFocusDestination', () => {
  const context = { projectId: 'project-1', threadId: 'thread-1', startedWorkflow: null }

  it('gives every step somewhere to go, now that no state is left in the vocabulary', () => {
    for (const kind of Object.keys(NEXT_FOCUS_LABELS) as InquiryNextFocusKind[]) {
      expect(['link', 'tab']).toContain(nextFocusDestination(kind, context).kind)
    }
  })

  it('sends search_acquisition to Research Setup before a search runs and to Operations after', () => {
    expect(nextFocusDestination('search_acquisition', context)).toEqual({
      kind: 'link',
      to: '/projects/project-1/research?research=new&thread=thread-1',
      cta: 'Start evidence search',
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
      promote_knowledge: '/projects/project-1/knowledge-review',
      synthesize: '/projects/project-1/notes',
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
