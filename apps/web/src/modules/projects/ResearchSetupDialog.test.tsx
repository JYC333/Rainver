import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ResearchSetupDialog } from './ResearchSetupDialog'
import { projectResearchApi, researchDiscoveryApi, sourcesApi } from '../../api/client'
import type { ProviderVendorOut } from '../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

// Question/hypothesis definition now happens entirely on the Inquiry Thread
// page (see QuestionRefinementPanel.test.tsx) — by the time this dialog
// opens, `research_question`/`research_context_version_id` already reflect
// whatever was confirmed there. These drafts model that already-refined state.
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

const providerVendors = [
  {
    id: 'openai', display_name: 'OpenAI', protocol: 'openai_completions',
    supports_chat: true, supports_runtime_tools: true, supports_structured_output: true,
    supports_embedding: true, supports_rerank: false, default_base_url: 'https://api.openai.com/v1',
    api_key_required: true, subscription_only: false,
  },
  {
    id: 'openai_codex', display_name: 'OpenAI Codex', protocol: 'openai_codex_responses',
    supports_chat: true, supports_runtime_tools: true, supports_structured_output: true,
    supports_embedding: false, supports_rerank: false, default_base_url: 'https://chatgpt.com/backend-api',
    api_key_required: false, subscription_only: true,
  },
] satisfies ProviderVendorOut[]

describe('ResearchSetupDialog', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(sourcesApi, 'customSourceCredentials').mockReturnValue(new Promise(() => {}))
    vi.spyOn(projectResearchApi, 'saveInitialIntakeDraft').mockResolvedValue({} as never)
  })

  it('locks discovery and start until the question passes refinement, with a link back to Inquiry to fix it', async () => {
    const user = userEvent.setup()
    render(
      <ResearchSetupDialog
        open
        threadId="thread-1"
        draft={{ ...initialDraft, question_refine_skipped: true }}
        busyAction={null}
        providerVendors={providerVendors}
        modelProviders={[{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onStart={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /start initial research/i })).toBeDisabled()
    expect(screen.getByText(/hasn.t passed refinement yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Refine in Inquiry' })).toHaveAttribute('href', '/projects/project-1/inquiry?thread=thread-1')
    // Already on the Sources step (step 0) — no in-dialog way left to fix
    // this; the only affordance is the link back to Inquiry above.
    expect(screen.getByRole('button', { name: 'Evaluate search coverage' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Initial import/ }))
    expect(screen.getByRole('button', { name: /start initial research/i })).toBeDisabled()
  })

  it('preselects the space default provider and its default model when the draft has none', async () => {
    render(
      <ResearchSetupDialog
        open
        threadId="thread-1"
        draft={{ ...initialDraft, execution: { model_provider_id: '', model_name: '' } }}
        busyAction={null}
        providerVendors={providerVendors}
        modelProviders={[
          { id: 'provider-1', name: 'First provider', provider_type: 'openai', enabled: true } as never,
          { id: 'provider-2', name: 'Default provider', provider_type: 'openai', enabled: true, is_default: true, default_model: 'MiniMax-M3' } as never,
        ]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onStart={vi.fn()}
      />,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: /Execution/ }))
    expect(await screen.findByText('Default provider (default)')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('MiniMax-M3')).toBeInTheDocument()
  })

  it('allows an OpenAI Codex subscription for structured research execution', async () => {
    render(
      <ResearchSetupDialog
        open
        threadId="thread-1"
        draft={{ ...initialDraft, execution: { model_provider_id: '', model_name: '' } }}
        busyAction={null}
        providerVendors={providerVendors}
        modelProviders={[
          {
            id: 'codex-provider',
            name: 'Codex subscription',
            provider_type: 'openai_codex',
            enabled: true,
            is_default: true,
            default_model: 'gpt-5.6-sol',
          } as never,
        ]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onStart={vi.fn()}
      />,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: /Execution/ }))
    expect(await screen.findByText('Codex subscription (default)')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('gpt-5.6-sol')).toBeInTheDocument()
  })

  it('saves the draft with a visible confirmation when stepping forward', async () => {
    const user = userEvent.setup()
    render(
      <ResearchSetupDialog
        open
        threadId="thread-1"
        draft={initialDraft}
        busyAction={null}
        providerVendors={providerVendors}
        modelProviders={[]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onStart={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenCalledWith('project-1', expect.objectContaining({
      research_question: initialDraft.research_question,
    }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Setup progress saved to the project'))
  })

  it('reuses the same draft Workflow for every autosave in one session instead of creating a new one each time', async () => {
    const user = userEvent.setup()
    let nextWorkflowId = 0
    vi.spyOn(projectResearchApi, 'saveInitialIntakeDraft').mockImplementation(async () => {
      nextWorkflowId += 1
      return { id: `workflow-${nextWorkflowId}` } as never
    })
    render(
      <ResearchSetupDialog
        open
        threadId="thread-1"
        draft={initialDraft}
        busyAction={null}
        providerVendors={providerVendors}
        modelProviders={[]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onStart={vi.fn()}
      />,
    )

    // First autosave ("Next" on Sources) creates workflow-1 with no
    // workflow_id in the request — this dialog opened with none of its own.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenCalledTimes(1))
    expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenCalledWith('project-1', expect.not.objectContaining({ workflow_id: expect.anything() }))

    // Second autosave ("Next" on Initial import) must target workflow-1 again, not create workflow-2.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenCalledTimes(2))
    expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenLastCalledWith('project-1', expect.objectContaining({ workflow_id: 'workflow-1' }))
  })

  it('renders adaptive provider attempts and materializes selected queries', async () => {
    const user = userEvent.setup()
    vi.spyOn(researchDiscoveryApi, 'evaluate').mockResolvedValue({ strategy: {
      id: '22222222-2222-4222-8222-222222222222', project_id: 'project-1', research_context_version_id: '11111111-1111-4111-8111-111111111111', question_snapshot: initialDraft.research_question, status: 'selected',
      version: 1, parent_strategy_id: null, adaptation_direction: null,
      policy_version: 'research_query_policy.v1', policy: {}, execution_budget: {},
      created_at: '2026-08-13T09:00:00.000Z', selected_at: '2026-08-13T09:00:10.000Z', materialized_at: null,
      provider_plans: [{ id: 'plan-1', provider_key: 'arxiv', status: 'selected', selected_attempt_id: 'attempt-1', terminal_decision: 'accept', decision_reason: 'Target range', coverage_warning: 'The accessible preview is smaller than the provider estimate.', attempts: [{ id: 'attempt-1', provider_plan_id: 'plan-1', round: 0, sequence: 1, direction: 'initial', semantic_query: { schema_version: 'research_semantic_query.v1', core: [{ value: 'coding agent memory', synonyms: ['agent memory module'], weight: 1 }], expansions: [], qualifiers: [{ value: 'recovery benchmark', synonyms: [], weight: 0.8 }], exclusions: [{ value: 'human-only studies', synonyms: [], weight: 1 }], time_window: null }, compiled_query: { schema_version: 'research_compiled_query.v1', provider_key: 'arxiv', query: { search_query: 'coding agent recovery' }, fingerprint: '1234567890abcdef' }, observation: { schema_version: 'research_preview_observation.v1', provider_hit_count: 42, accessible_hit_count: 42, relevance_rate: 0.8, relevance_lower_bound: 0.6, diversity_score: 0.7, duplicate_rate: 0, samples: [{ sample_id: 'sample-1', title: 'Agent paper', source_uri: null, occurred_at: null, excerpt: null, relevance: 'relevant', matched_core_concepts: ['coding agent'] }] }, score: 0.8, decision: 'accept', decision_reason: 'Target range', error_class: null, created_at: '2026-08-13T09:00:00.000Z', completed_at: '2026-08-13T09:00:05.000Z' }] }],
    } })
    vi.spyOn(researchDiscoveryApi, 'materialize').mockResolvedValue({ query_strategy_id: '22222222-2222-4222-8222-222222222222', project_id: 'project-1', status: 'materialized', sources: [{ provider_key: 'arxiv', research_query_attempt_id: 'attempt-1', source_channel_id: 'channel-1', project_source_binding_id: 'binding-1', query_fingerprint: '1234567890abcdef' }] })
    render(
      <ResearchSetupDialog
        open
        threadId="thread-1"
        draft={{ ...initialDraft, query_strategy_id: '' }}
        busyAction={null}
        providerVendors={providerVendors}
        modelProviders={[{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onStart={vi.fn()}
      />,
    )

    expect(screen.getByRole('checkbox', { name: /arXiv Public academic API/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /OpenAlex Public academic API/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Semantic Scholar Anonymous access/i })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Evaluate search coverage' }))
    expect(researchDiscoveryApi.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      research_context_version_id: '11111111-1111-4111-8111-111111111111',
      providers: ['arxiv', 'openalex'],
    }))
    expect(await screen.findByText(/42 provider hits/)).toBeInTheDocument()
    expect(screen.getAllByText('coding agent memory')).toHaveLength(2)
    expect(screen.getAllByText('recovery benchmark')).toHaveLength(2)
    expect(screen.getAllByText('human-only studies')).toHaveLength(2)
    expect(screen.getAllByText(/agent memory module/)).toHaveLength(2)
    expect(screen.getByText(/accessible preview is smaller/)).toBeInTheDocument()
    expect(screen.getByText(/View 1 evaluation attempt/)).toBeInTheDocument()
    expect(screen.getByText(/Provider counts are independent estimates and may overlap/)).toBeInTheDocument()
    const evaluatedArxiv = screen.getAllByRole('checkbox', { name: /arxiv/i }).slice(-1)[0]
    expect(evaluatedArxiv).toBeChecked()
    await user.click(evaluatedArxiv!)
    expect(evaluatedArxiv).not.toBeChecked()
    await user.click(evaluatedArxiv!)
    await user.click(screen.getByRole('button', { name: 'Confirm selected queries' }))
    expect(await screen.findByText(/Ready/)).toBeInTheDocument()
    expect(researchDiscoveryApi.materialize).toHaveBeenCalled()
  })

  it('preserves edited values across equivalent parent refreshes and starts with them', () => {
    const onStart = vi.fn()
    const { rerender } = render(
      <ResearchSetupDialog
        open
        threadId="thread-1"
        draft={initialDraft}
        busyAction={null}
        providerVendors={providerVendors}
        modelProviders={[]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onStart={onStart}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Initial import/ }))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } })
    rerender(
      <ResearchSetupDialog
        open
        threadId="thread-1"
        draft={{ ...initialDraft, execution: { ...initialDraft.execution } }}
        busyAction={null}
        providerVendors={providerVendors}
        modelProviders={[]}
        canAct
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onStart={onStart}
      />,
    )

    expect(screen.getByRole('spinbutton')).toHaveValue(5)
    fireEvent.click(screen.getByRole('button', { name: /start initial research/i }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ max_items: 5 }), null)
  })
})
