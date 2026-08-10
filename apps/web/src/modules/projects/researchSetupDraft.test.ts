import { describe, expect, it } from 'vitest'
import { researchSetupDraftFromWorkflow, serializeResearchSetupDraft } from './researchSetupDraft'

describe('research setup draft', () => {
  it('reads the materialized query strategy from workflow state', () => {
    const draft = researchSetupDraftFromWorkflow({
      id: 'workflow-1',
      project_id: 'project-1',
      current_stage: 'initial_intake_setup',
      status: 'not_started',
      state_json: {
        research_question: 'How should agents remember?',
        query_strategy_id: '22222222-2222-4222-8222-222222222222',
        initial_intake: { history_mode: 'all_available', max_items: 10000 },
        execution: {},
      },
      primary_thread_id: null,
      started_by_user_id: null,
      started_run_id: null,
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z',
    }, 'Fallback question')

    expect(draft.research_question).toBe('How should agents remember?')
    expect(draft.query_strategy_id).toBe('22222222-2222-4222-8222-222222222222')
    expect(draft.history_mode).toBe('all_available')
  })

  it('serializes an initial intake without duplicating monitor query configuration', () => {
    const input = serializeResearchSetupDraft({
      research_question: 'How should agents remember?',
      query_strategy_id: '22222222-2222-4222-8222-222222222222',
      history_mode: 'bounded_range',
      from: '2020-01-01',
      to: '2026-01-01',
      max_items: '1000',
      monitoring_field: 'submittedDate',
      report_depth: 'quick',
      question_refine_skipped: true,
      execution: {
        model_provider_id: 'provider-1',
        model_name: '',
      },
    })

    expect(input).toMatchObject({
      research_question: 'How should agents remember?',
      query_strategy_id: '22222222-2222-4222-8222-222222222222',
      history_mode: 'bounded_range',
      from: '2020-01-01',
      to: '2026-01-01',
    })
    expect(input).not.toHaveProperty('search_directions')
  })

  it('round-trips the refinement assessment through workflow state', () => {
    const refinement = {
      research_context_version_id: '11111111-1111-4111-8111-111111111111',
      assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 4 }, issues: [] },
      suggested_questions: ['q'], sub_questions: [], scope: { in: [], out: [] }, clarifying_questions: [],
    }
    const draft = researchSetupDraftFromWorkflow({
      id: 'workflow-1', project_id: 'project-1',
      current_stage: 'initial_intake_setup', status: 'not_started',
      state_json: { research_question: 'Q', question_refinement: refinement, execution: {} },
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    } as never, 'Q')
    expect(draft.question_refinement).toEqual(refinement)
    expect(serializeResearchSetupDraft(draft)).toMatchObject({ question_refinement: refinement })
  })
})
