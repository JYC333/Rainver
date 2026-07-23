import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ResearchSetupDialog } from './ResearchSetupDialog'
import { projectResearchApi, researchDiscoveryApi, sourcesApi } from '../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const initialDraft = {
  research_question: 'How should agent tools be evaluated?',
  research_context_version_id: '11111111-1111-4111-8111-111111111111',
  query_strategy_id: '22222222-2222-4222-8222-222222222222',
  history_mode: 'bounded_range' as const,
  from: '2025-01-01',
  to: '2025-12-31',
  max_items: '15',
  monitoring_field: 'submittedDate' as const,
  report_depth: 'quick' as const,
  question_refine_skipped: false,
  execution: { model_provider_id: 'provider-1', model_name: '' },
}

describe('ResearchSetupDialog', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(sourcesApi, 'customSourceCredentials').mockReturnValue(new Promise(() => {}))
    vi.spyOn(projectResearchApi, 'saveInitialIntakeDraft').mockResolvedValue({} as never)
  })

  it('assesses an unanswerable question and lets the user adopt an actionable rewrite', async () => {
    const user = userEvent.setup()
    const onRefineQuestion = vi.fn().mockResolvedValue({
      research_context_version_id: '11111111-1111-4111-8111-111111111111',
      assessment: { answerable: false, finer: { feasible: 1, interesting: 3, novel: 1, ethical: 3, relevant: 1 }, issues: ['Too broad'] },
      suggested_questions: ['How do tool-using agents recover from failed calls?'],
      sub_questions: [],
      scope: { in: ['tool use'], out: ['all agents'] },
      clarifying_questions: [{ question: 'Which agent environment?', options: ['Coding agents', 'Assistant agents'], allow_multiple: true }],
    })
    render(
      <ResearchSetupDialog
        open
        draft={{ ...initialDraft, research_question: 'agent' }}
        busyAction={null}
        modelProviders={[{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={onRefineQuestion}
        onStart={vi.fn()}
        onEditQuestion={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Assess question' }))
    expect(await screen.findByText('Not yet answerable')).toBeInTheDocument()
    // Refinement milestones are durably auto-saved to the server-side draft.
    expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenCalledWith('project-1', expect.objectContaining({
      question_refinement: expect.objectContaining({ assessment: expect.objectContaining({ answerable: false }) }),
    }))
    await user.click(screen.getByRole('button', { name: 'How do tool-using agents recover from failed calls?' }))
    expect(screen.getByDisplayValue('How do tool-using agents recover from failed calls?')).toBeInTheDocument()
    expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      research_question: 'How do tool-using agents recover from failed calls?',
      question_refine_skipped: true,
    }))
    // Adopting a rewrite must retain the current assessment as the context for
    // its clarifying questions. Only the approved context/strategy is invalidated.
    expect(screen.getByText('Which agent environment?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Coding agents' }))
    expect(screen.getByRole('button', { name: 'Coding agents' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Reassess with answers' }))
    expect(onRefineQuestion).toHaveBeenLastCalledWith(expect.objectContaining({
      research_question: 'How do tool-using agents recover from failed calls?',
      history: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('Coding agents') }),
      ]),
    }))
    expect(toast.info).toHaveBeenCalled()
  })

  it('locks discovery and start until the question passes refinement, and unlocks after adoption', async () => {
    const user = userEvent.setup()
    const onRefineQuestion = vi.fn().mockResolvedValue({
      research_context_version_id: '11111111-1111-4111-8111-111111111111',
      assessment: { answerable: false, finer: { feasible: 1, interesting: 3, novel: 1, ethical: 3, relevant: 1 }, issues: ['Too broad'] },
      suggested_questions: ['How do tool-using agents recover from failed calls?'],
      sub_questions: [],
      scope: { in: [], out: [] },
      clarifying_questions: [],
    })
    render(
      <ResearchSetupDialog
        open
        draft={{ ...initialDraft, research_question: 'agent', question_refine_skipped: true }}
        busyAction={null}
        modelProviders={[{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={onRefineQuestion}
        onStart={vi.fn()}
        onEditQuestion={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /start initial research/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Sources/ }))
    expect(screen.getByRole('button', { name: 'Evaluate search coverage' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Question/ }))
    await user.click(screen.getByRole('button', { name: 'Assess question' }))
    // Still failing after assessment: the gate stays closed until a rewrite is adopted.
    expect(await screen.findByText('Not yet answerable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start initial research/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'How do tool-using agents recover from failed calls?' }))
    await user.click(screen.getByRole('button', { name: /Sources/ }))
    expect(screen.getByRole('button', { name: 'Evaluate search coverage' })).toBeDisabled()
  })

  it('keeps start locked when clarification answers invalidate the materialized strategy', async () => {
    const user = userEvent.setup()
    const onStart = vi.fn()
    const onRefineQuestion = vi.fn().mockResolvedValue({
      research_context_version_id: '11111111-1111-4111-8111-111111111111',
      assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 4 }, issues: [] },
      suggested_questions: ['How do tool-using agents recover from failed calls?'],
      sub_questions: [],
      scope: { in: [], out: [] },
      clarifying_questions: [{ question: 'Which agent environment?', options: ['Coding agents'], allow_multiple: false }],
    })
    render(
      <ResearchSetupDialog
        open
        draft={initialDraft}
        busyAction={null}
        modelProviders={[{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={onRefineQuestion}
        onStart={onStart}
        onEditQuestion={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Assess question' }))
    await user.click(await screen.findByRole('button', { name: 'Coding agents' }))
    expect(screen.getByRole('button', { name: /start initial research/i })).toBeDisabled()
    expect(onStart).not.toHaveBeenCalled()
  })

  it('invalidates a persisted context and materialized strategy when clarification answers change', async () => {
    const user = userEvent.setup()
    render(
      <ResearchSetupDialog
        open
        draft={{
          ...initialDraft,
          question_refinement: {
            research_context_version_id: initialDraft.research_context_version_id,
            assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 4 }, issues: [] },
            suggested_questions: [initialDraft.research_question],
            sub_questions: [],
            scope: { in: [], out: [] },
            clarifying_questions: [{ question: 'Which agent environment?', options: ['Coding agents'], allow_multiple: false }],
          },
        }}
        busyAction={null}
        modelProviders={[{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={vi.fn()}
        onStart={vi.fn()}
        onEditQuestion={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /start initial research/i })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Coding agents' }))
    expect(screen.getByRole('button', { name: /start initial research/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Sources/ }))
    expect(screen.getByRole('button', { name: 'Evaluate search coverage' })).toBeDisabled()
  })

  it('preselects the space default provider and its default model when the draft has none', async () => {
    render(
      <ResearchSetupDialog
        open
        draft={{ ...initialDraft, execution: { model_provider_id: '', model_name: '' } }}
        busyAction={null}
        modelProviders={[
          { id: 'provider-1', name: 'First provider', provider_type: 'openai', enabled: true } as never,
          { id: 'provider-2', name: 'Default provider', provider_type: 'openai', enabled: true, is_default: true, default_model: 'MiniMax-M3' } as never,
        ]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={vi.fn()}
        onStart={vi.fn()}
        onEditQuestion={vi.fn()}
      />,
    )

    expect(await screen.findByText('Default provider (default)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assess question' })).toBeEnabled()
    await userEvent.setup().click(screen.getByRole('button', { name: /Execution/ }))
    expect(await screen.findByDisplayValue('MiniMax-M3')).toBeInTheDocument()
  })

  it('saves the draft with a visible confirmation when stepping forward', async () => {
    const user = userEvent.setup()
    render(
      <ResearchSetupDialog
        open
        draft={initialDraft}
        busyAction={null}
        modelProviders={[]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={vi.fn()}
        onStart={vi.fn()}
        onEditQuestion={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenCalledWith('project-1', expect.objectContaining({
      research_question: initialDraft.research_question,
    }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Setup progress saved to the project'))
  })

  it('keeps the refinement session when the dialog is closed and reopened', async () => {
    const user = userEvent.setup()
    const onRefineQuestion = vi.fn().mockResolvedValue({
      research_context_version_id: '11111111-1111-4111-8111-111111111111',
      assessment: { answerable: false, finer: { feasible: 1, interesting: 3, novel: 1, ethical: 3, relevant: 1 }, issues: ['Too broad'] },
      suggested_questions: ['How do tool-using agents recover from failed calls?'],
      sub_questions: [],
      scope: { in: ['tool use'], out: ['all agents'] },
      clarifying_questions: [{ question: 'Which agent environment?', options: [], allow_multiple: false }],
    })
    const props = {
      draft: { ...initialDraft, research_question: 'agent' },
      busyAction: null,
      modelProviders: [{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never],
      canAct: true,
      onOpenChange: vi.fn(),
      onSave: vi.fn().mockResolvedValue(true),
      onRefineQuestion,
      onStart: vi.fn(),
      onEditQuestion: vi.fn(),
    }
    const { rerender } = render(<ResearchSetupDialog open {...props} />)
    await user.click(screen.getByRole('button', { name: 'Assess question' }))
    expect(await screen.findByText('Not yet answerable')).toBeInTheDocument()

    rerender(<ResearchSetupDialog open={false} {...props} />)
    rerender(<ResearchSetupDialog open {...props} />)

    expect(await screen.findByText('Not yet answerable')).toBeInTheDocument()
    expect(screen.getByText('Too broad')).toBeInTheDocument()
    expect(screen.getByDisplayValue('agent')).toBeInTheDocument()
    expect(onRefineQuestion).toHaveBeenCalledTimes(1)
  })

  it('keeps the in-progress refinement when the parent draft changes while the dialog stays open', async () => {
    const user = userEvent.setup()
    const onRefineQuestion = vi.fn().mockResolvedValue({
      research_context_version_id: '11111111-1111-4111-8111-111111111111',
      assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 4 }, issues: [] },
      suggested_questions: ['How do tool-using agents recover from failed calls?'],
      sub_questions: [],
      scope: { in: [], out: [] },
      clarifying_questions: [],
    })
    const props = {
      busyAction: null,
      modelProviders: [{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never],
      canAct: true,
      onOpenChange: vi.fn(),
      onSave: vi.fn().mockResolvedValue(true),
      onRefineQuestion,
      onStart: vi.fn(),
      onEditQuestion: vi.fn(),
    }
    const { rerender } = render(<ResearchSetupDialog open draft={{ ...initialDraft, research_question: 'agent', question_refine_skipped: true }} {...props} />)
    await user.click(screen.getByRole('button', { name: 'Assess question' }))
    expect(await screen.findByText('Answerable')).toBeInTheDocument()

    // A monitor confirmation refreshes the parent, which rebuilds the incoming
    // draft (different fingerprint) while the dialog is still open.
    rerender(<ResearchSetupDialog open draft={{ ...initialDraft, query_strategy_id: '33333333-3333-4333-8333-333333333333' }} {...props} />)

    expect(screen.getByDisplayValue('agent')).toBeInTheDocument()
    expect(screen.getByText('Answerable')).toBeInTheDocument()
  })

  it('renders adaptive provider attempts and materializes selected queries', async () => {
    const user = userEvent.setup()
    vi.spyOn(researchDiscoveryApi, 'evaluate').mockResolvedValue({ strategy: {
      id: '22222222-2222-4222-8222-222222222222', project_id: 'project-1', research_context_version_id: '11111111-1111-4111-8111-111111111111', question_snapshot: initialDraft.research_question, status: 'selected',
      version: 1, parent_strategy_id: null, adaptation_direction: null,
      provider_plans: [{ id: 'plan-1', provider_key: 'arxiv', status: 'selected', selected_attempt_id: 'attempt-1', terminal_decision: 'accept', decision_reason: 'Target range', coverage_warning: 'The accessible preview is smaller than the provider estimate.', attempts: [{ id: 'attempt-1', provider_plan_id: 'plan-1', round: 0, sequence: 1, direction: 'initial', semantic_query: { schema_version: 'research_semantic_query.v1', core: [{ value: 'coding agent memory', synonyms: ['agent memory module'], weight: 1 }], expansions: [], qualifiers: [{ value: 'recovery benchmark', synonyms: [], weight: 0.8 }], exclusions: [{ value: 'human-only studies', synonyms: [], weight: 1 }], time_window: null }, compiled_query: { schema_version: 'research_compiled_query.v1', provider_key: 'arxiv', query: { search_query: 'coding agent recovery' }, fingerprint: '1234567890abcdef' }, observation: { provider_hit_count: 42, accessible_hit_count: 42, relevance_rate: 0.8, relevance_lower_bound: 0.6, diversity_score: 0.7, duplicate_rate: 0, samples: [{ sample_id: 'sample-1', title: 'Agent paper', source_uri: null, occurred_at: null, excerpt: null, relevance: 'relevant', matched_core_concepts: ['coding agent'] }] }, score: 0.8, decision: 'accept', decision_reason: 'Target range', error_class: null }] }],
    } })
    vi.spyOn(researchDiscoveryApi, 'materialize').mockResolvedValue({ query_strategy_id: '22222222-2222-4222-8222-222222222222', project_id: 'project-1', status: 'materialized', sources: [{ provider_key: 'arxiv', research_query_attempt_id: 'attempt-1', source_channel_id: 'channel-1', project_source_binding_id: 'binding-1', query_fingerprint: '1234567890abcdef' }] })
    render(
      <ResearchSetupDialog
        open
        draft={{
          ...initialDraft,
          query_strategy_id: '',
          question_refinement: {
            research_context_version_id: '11111111-1111-4111-8111-111111111111',
            assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 5 }, issues: [] },
            suggested_questions: [initialDraft.research_question],
            sub_questions: ['Which benchmarks measure recovery?'],
            scope: { in: ['Tool-using coding agents'], out: ['Human-only studies'] },
            clarifying_questions: [],
          },
        }}
        busyAction={null}
        modelProviders={[{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={vi.fn()}
        onStart={vi.fn()}
        onEditQuestion={vi.fn()}
      />,
    )

    expect(screen.getByText('Tool-using coding agents')).toBeInTheDocument()
    expect(screen.getByText('Human-only studies')).toBeInTheDocument()
    expect(screen.getByText('Which benchmarks measure recovery?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Sources/ }))
    await user.click(screen.getByRole('button', { name: 'Evaluate search coverage' }))
    expect(researchDiscoveryApi.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      research_context_version_id: '11111111-1111-4111-8111-111111111111',
    }))
    expect(await screen.findByText(/42 provider hits/)).toBeInTheDocument()
    expect(screen.getAllByText('coding agent memory')).toHaveLength(2)
    expect(screen.getAllByText('recovery benchmark')).toHaveLength(2)
    expect(screen.getAllByText('human-only studies')).toHaveLength(2)
    expect(screen.getAllByText(/agent memory module/)).toHaveLength(2)
    expect(screen.getByText(/accessible preview is smaller/)).toBeInTheDocument()
    expect(screen.getByText(/View 1 evaluation attempt/)).toBeInTheDocument()
    expect(screen.getByText(/Provider counts are independent estimates and may overlap/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm selected queries' }))
    expect(await screen.findByText(/Ready/)).toBeInTheDocument()
    expect(researchDiscoveryApi.materialize).toHaveBeenCalled()
  })

  it('preserves edited values across equivalent parent refreshes and starts with them', () => {
    const onStart = vi.fn()
    const { rerender } = render(
      <ResearchSetupDialog
        open
        draft={initialDraft}
        busyAction={null}
        modelProviders={[]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={vi.fn()}
        onStart={onStart}
        onEditQuestion={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Initial import/ }))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } })
    rerender(
      <ResearchSetupDialog
        open
        draft={{ ...initialDraft, execution: { ...initialDraft.execution } }}
        busyAction={null}
        modelProviders={[]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onRefineQuestion={vi.fn()}
        onStart={onStart}
        onEditQuestion={vi.fn()}
      />,
    )

    expect(screen.getByRole('spinbutton')).toHaveValue(5)
    fireEvent.click(screen.getByRole('button', { name: /start initial research/i }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ max_items: 5 }))
  })
})
