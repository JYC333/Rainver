import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { QuestionRefinementPanel } from './QuestionRefinementPanel'
import { inquiryApi, projectResearchApi } from '../../api/client'
import type { ProviderVendorOut } from '../../api/client'
import type { InquiryThread, ProjectResearchQuestionRefinementResponse } from '../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

function makeThread(overrides: Partial<InquiryThread> = {}): InquiryThread {
  return {
    id: 'thread-1', space_id: 'space-1', project_id: 'project-1', kind: 'question', statement: 'How should agent tools be evaluated?',
    lifecycle_status: 'active', attention_state: 'focused', priority: 0, primary_parent_id: null,
    owner_user_id: null, next_focus_kind: null, next_focus_note: null, blocked_reason: null,
    version: 1, created_from: 'user', created_by_user_id: 'user-1', created_at: '', updated_at: '',
    ...overrides,
  } as InquiryThread
}

const providers = [{ id: 'provider-1', name: 'Provider', provider_type: 'openai', enabled: true } as never]
const providerVendors = [{
  id: 'openai', display_name: 'OpenAI', protocol: 'openai_completions',
  supports_chat: true, supports_runtime_tools: true, supports_structured_output: true,
  supports_embedding: true, supports_rerank: false, default_base_url: 'https://api.openai.com/v1',
  api_key_required: true, subscription_only: false,
}] satisfies ProviderVendorOut[]

function result(overrides: Partial<ProjectResearchQuestionRefinementResponse> = {}): ProjectResearchQuestionRefinementResponse {
  const base = {
    research_context_version_id: '11111111-1111-4111-8111-111111111111',
    reply: 'The framework is updated. Which evaluation setting matters most?',
    recommended_question: 'How do failed tool calls affect coding-agent task completion?',
    assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 4, ethical: 4, relevant: 4 }, issues: [] },
    suggested_questions: ['How do failed tool calls affect coding-agent task completion?'],
    sub_questions: ['Which failures are recoverable?'],
    scope: { in: ['Coding agents'], out: ['Human-only workflows'] },
    clarifying_questions: [{ question: 'Which setting?', options: ['Repository tasks', 'Browser tasks'], allow_multiple: false }],
  }
  return {
    ...base,
    assessment_session: {
      id: 'assessment-1',
      thread_id: 'thread-1',
      recommended_question: base.recommended_question,
      latest_refinement: null,
      assessment_baseline: null,
      research_context_version_id: base.research_context_version_id,
      messages: [
        { id: 'message-1', turn_index: 1, role: 'user', content: 'Assess this research question.', status: 'complete', created_by_user_id: 'user-1', created_at: '' },
        { id: 'message-2', turn_index: 1, role: 'assistant', content: base.reply, status: 'complete', created_by_user_id: null, created_at: '' },
      ],
      created_at: '',
      updated_at: '',
    },
    ...overrides,
  }
}

describe('QuestionRefinementPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.spyOn(projectResearchApi, 'saveInitialIntakeDraft').mockResolvedValue({ id: 'workflow-1' } as never)
    vi.spyOn(inquiryApi, 'updateWork').mockResolvedValue({} as never)
    vi.spyOn(projectResearchApi, 'questionAssessment').mockResolvedValue(null)
    vi.spyOn(projectResearchApi, 'questionAssessmentConfirmations').mockResolvedValue([])
    vi.spyOn(projectResearchApi, 'confirmQuestionAssessment').mockImplementation(async (_projectId, body) => ({
      ...body.refinement,
      research_context_version_id: 'confirmed-context-1',
      confirmation: {
        id: 'confirmed-context-1',
        version: 3,
        question: body.refinement.recommended_question ?? '',
        assessment: body.refinement.assessment,
        scope: body.refinement.scope,
        sub_questions: body.refinement.sub_questions,
        manually_adjusted: body.manually_adjusted,
        created_at: '2026-07-30T12:00:00.000Z',
      },
    }))
  })

  it('renders a split framework and conversation and updates the framework from a turn', async () => {
    const user = userEvent.setup()
    vi.spyOn(projectResearchApi, 'refineQuestion').mockResolvedValue(result())
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread()}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={null}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByRole('region', { name: 'Structured assessment' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Assessment conversation' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start assessment' }))

    expect(await screen.findByText('The framework is updated. Which evaluation setting matters most?')).toBeInTheDocument()
    expect(screen.getByDisplayValue('How do failed tool calls affect coding-agent task completion?')).toBeInTheDocument()
    expect(screen.getByText('Coding agents')).toBeInTheDocument()
    expect(screen.getByText('Which failures are recoverable?')).toBeInTheDocument()
    expect(screen.getByText('Which setting?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Repository tasks' }))
    await user.type(screen.getByLabelText('Answer: Which setting?'), 'Long-running maintenance tasks')
    await user.click(screen.getByRole('button', { name: 'Send clarification answers' }))
    await waitFor(() => expect(projectResearchApi.refineQuestion).toHaveBeenCalledTimes(2))
    expect(projectResearchApi.refineQuestion).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      thread_id: 'thread-1',
      message: expect.stringContaining('Repository tasks; Long-running maintenance tasks'),
    }))
    expect(projectResearchApi.saveInitialIntakeDraft).not.toHaveBeenCalled()
  })

  it('shows durable repair progress while the assessment request is still running', async () => {
    const user = userEvent.setup()
    let finishRefinement!: (value: ProjectResearchQuestionRefinementResponse) => void
    vi.spyOn(projectResearchApi, 'refineQuestion').mockImplementation(() => new Promise(resolve => {
      finishRefinement = resolve
    }))
    const pending = result().assessment_session
    vi.mocked(projectResearchApi.questionAssessment).mockResolvedValue({
      ...pending,
      messages: [{
        id: 'pending-user',
        turn_index: 1,
        role: 'user',
        content: 'Assess this research question and identify what needs clarification.',
        status: 'pending',
        processing_events: [{
          stage: 'subquestion_repair',
          status: 'running',
          message: 'Sending a separate structured request to split the long items.',
          created_at: '2026-08-01T12:00:00.000Z',
        }],
        created_by_user_id: 'user-1',
        created_at: '2026-08-01T12:00:00.000Z',
      }],
    })
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread()}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={null}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const conversation = screen.getByRole('log', { name: 'Assessment conversation messages' })
    const scrollTo = vi.fn()
    Object.defineProperties(conversation, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 600 },
      scrollTo: { configurable: true, value: scrollTo },
    })

    await user.click(screen.getByRole('button', { name: 'Start assessment' }))

    expect(await screen.findByText('Sending a separate structured request to split the long items.', {}, { timeout: 2_000 })).toBeInTheDocument()
    expect(screen.getByText('System process · running')).toBeInTheDocument()

    scrollTo.mockClear()
    conversation.scrollTop = 100
    fireEvent.scroll(conversation)
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 650))
    })
    expect(scrollTo).not.toHaveBeenCalled()

    const completed = result({ reply: 'I split the overlong item into 2 concise sub-questions.' })
    completed.assessment_session.messages = [
      {
        id: 'pending-user',
        turn_index: 1,
        role: 'user',
        content: 'Assess this research question and identify what needs clarification.',
        status: 'complete',
        processing_events: [
          {
            stage: 'subquestion_repair',
            status: 'detected',
            message: 'One long item was detected.',
            created_at: '2026-08-01T12:00:00.000Z',
          },
          {
            stage: 'subquestion_repair',
            status: 'running',
            message: 'Sending a separate structured request to split the long items.',
            created_at: '2026-08-01T12:00:01.000Z',
          },
          {
            stage: 'subquestion_repair',
            status: 'completed',
            message: 'Repair complete: the long item was split into 2 concise sub-questions.',
            created_at: '2026-08-01T12:00:02.000Z',
          },
        ],
        created_by_user_id: 'user-1',
        created_at: '2026-08-01T12:00:00.000Z',
      },
      {
        id: 'completed-assistant',
        turn_index: 1,
        role: 'assistant',
        content: completed.reply ?? '',
        status: 'complete',
        created_by_user_id: null,
        created_at: '2026-08-01T12:00:03.000Z',
      },
    ]
    await act(async () => finishRefinement(completed))
    await waitFor(() => expect(screen.queryByText('Updating the assessment…')).not.toBeInTheDocument())
    expect(screen.queryByText('System process · running')).not.toBeInTheDocument()
    expect(screen.getByText('System process · completed')).toBeInTheDocument()
    expect(screen.getByText('I split the overlong item into 2 concise sub-questions.')).toBeInTheDocument()
  })

  it('keeps the conversation continuous from the server-returned session', async () => {
    const user = userEvent.setup()
    vi.spyOn(projectResearchApi, 'refineQuestion')
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({
        reply: 'Repository tasks are now in scope.',
        scope: { in: ['Coding agents', 'Repository tasks'], out: [] },
        assessment_session: {
          ...result().assessment_session,
          messages: [
            ...result().assessment_session.messages,
            { id: 'message-3', turn_index: 2, role: 'user', content: 'Focus on repository tasks', status: 'complete', created_by_user_id: 'user-1', created_at: '' },
            { id: 'message-4', turn_index: 2, role: 'assistant', content: 'Repository tasks are now in scope.', status: 'complete', created_by_user_id: null, created_at: '' },
          ],
        },
      }))
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread()}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={null}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Start assessment' }))
    await screen.findByText('The framework is updated. Which evaluation setting matters most?')
    await user.type(screen.getByLabelText('Message'), 'Focus on repository tasks')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByText('Repository tasks are now in scope.')).toBeInTheDocument()
    expect(screen.getByText('Focus on repository tasks')).toBeInTheDocument()
    expect(screen.getAllByText('Repository tasks').length).toBeGreaterThan(0)
    expect(projectResearchApi.refineQuestion).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      thread_id: 'thread-1',
      message: 'Focus on repository tasks',
    }))
  })

  it('sends selected clarification answers together with main composer context', async () => {
    const user = userEvent.setup()
    vi.spyOn(projectResearchApi, 'refineQuestion').mockResolvedValue(result())
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread()}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={null}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Start assessment' }))
    await screen.findByText('Which setting?')
    await user.click(screen.getByRole('button', { name: 'Repository tasks' }))
    await user.click(screen.getByRole('button', { name: 'Browser tasks' }))
    await user.type(screen.getByLabelText('Message'), 'Prioritize long-running maintenance work.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(projectResearchApi.refineQuestion).toHaveBeenCalledTimes(2))
    expect(projectResearchApi.refineQuestion).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      thread_id: 'thread-1',
      message: [
        'My clarification answers:',
        '',
        'Which setting?',
        'Repository tasks; Browser tasks',
        '',
        'Additional context:',
        '',
        'Prioritize long-running maintenance work.',
      ].join('\n'),
    }))
  })

  it('uses each reassessment result as the baseline for later framework changes', async () => {
    const user = userEvent.setup()
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    const changed = result({
      scope: { in: ['Coding agents', 'Repository tasks'], out: ['Human-only workflows'] },
      reply: 'Repository tasks are now included.',
      assessment_session: {
        ...persisted.assessment_session,
        assessment_baseline: latestRefinement,
      },
    })
    const { assessment_session: _changedSession, ...changedRefinement } = changed
    const reassessed = {
      ...changed,
      assessment_session: {
        ...changed.assessment_session,
        assessment_baseline: changedRefinement,
      },
    }
    const changedAgain = result({
      scope: { in: ['Coding agents', 'Repository tasks', 'Browser tasks'], out: ['Human-only workflows'] },
      reply: 'Browser tasks are now included too.',
      assessment_session: {
        ...persisted.assessment_session,
        assessment_baseline: changedRefinement,
      },
    })
    vi.spyOn(projectResearchApi, 'refineQuestion')
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(reassessed)
      .mockResolvedValueOnce(changedAgain)
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread({ statement: persisted.recommended_question })}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{ ...persisted.assessment_session, latest_refinement: latestRefinement }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.type(screen.getByLabelText('Message'), 'Include repository tasks in scope.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('button', { name: 'Reassess changes' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reassess changes' }))
    await waitFor(() => expect(projectResearchApi.refineQuestion).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reassess changes' })).not.toBeInTheDocument())

    await user.type(screen.getByLabelText('Message'), 'Also include browser tasks in scope.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('button', { name: 'Reassess changes' })).toBeInTheDocument()
    expect(projectResearchApi.refineQuestion).toHaveBeenCalledTimes(3)
  })

  it('restores an unassessed framework change against the persisted assessment baseline', async () => {
    const baseline = result()
    const { assessment_session: _baselineSession, ...baselineRefinement } = baseline
    const latest = result({
      scope: { in: ['Coding agents', 'Repository tasks'], out: ['Human-only workflows'] },
    })
    const { assessment_session: _latestSession, ...latestRefinement } = latest

    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread({ statement: latest.recommended_question })}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{
          ...latest.assessment_session,
          latest_refinement: latestRefinement,
          assessment_baseline: baselineRefinement,
        }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(await screen.findByRole('button', { name: 'Reassess changes' })).toBeInTheDocument()
    await waitFor(() => expect(projectResearchApi.questionAssessmentConfirmations).toHaveBeenCalled())
  })

  it('restores persisted messages and the latest framework without calling the model', async () => {
    const refineQuestion = vi.spyOn(projectResearchApi, 'refineQuestion')
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread()}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{
          ...persisted.assessment_session,
          recommended_question: persisted.recommended_question ?? null,
          latest_refinement: latestRefinement,
          messages: [
            { id: 'persisted-user', turn_index: 1, role: 'user', content: 'Persisted question context', status: 'complete', created_by_user_id: 'user-1', created_at: '' },
            { id: 'persisted-assistant', turn_index: 1, role: 'assistant', content: 'Persisted assessment reply', status: 'complete', created_by_user_id: null, created_at: '' },
          ],
        }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByText('Persisted question context')).toBeInTheDocument()
    expect(screen.getByText('Persisted assessment reply')).toBeInTheDocument()
    expect(screen.getByDisplayValue('How do failed tool calls affect coding-agent task completion?')).toBeInTheDocument()
    expect(refineQuestion).not.toHaveBeenCalled()
    expect(projectResearchApi.saveInitialIntakeDraft).not.toHaveBeenCalled()
    await waitFor(() => expect(projectResearchApi.questionAssessmentConfirmations).toHaveBeenCalled())
  })

  it('hides stale clarifying questions while waiting and only shows questions from the new response', async () => {
    const user = userEvent.setup()
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    let resolveResponse!: (value: ProjectResearchQuestionRefinementResponse) => void
    vi.spyOn(projectResearchApi, 'refineQuestion').mockReturnValue(new Promise(resolve => {
      resolveResponse = resolve
    }))
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread()}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{
          ...persisted.assessment_session,
          latest_refinement: latestRefinement,
        }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByText('Clarifying questions')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Repository tasks' }))
    await user.click(screen.getByRole('button', { name: 'Send clarification answers' }))

    expect(screen.getByText('Updating the assessment…')).toBeInTheDocument()
    expect(screen.queryByText('Clarifying questions')).not.toBeInTheDocument()

    resolveResponse(result({
      reply: 'No further clarification is needed.',
      clarifying_questions: [],
      assessment_session: {
        ...persisted.assessment_session,
        messages: [
          ...persisted.assessment_session.messages,
          { id: 'message-3', turn_index: 2, role: 'user', content: 'Repository tasks', status: 'complete', created_by_user_id: 'user-1', created_at: '' },
          { id: 'message-4', turn_index: 2, role: 'assistant', content: 'No further clarification is needed.', status: 'complete', created_by_user_id: null, created_at: '' },
        ],
      },
    }))

    expect(await screen.findByText('No further clarification is needed.')).toBeInTheDocument()
    expect(screen.queryByText('Clarifying questions')).not.toBeInTheDocument()
  })

  it('keeps edited wording temporary until reassessment and persists it only on confirm', async () => {
    const user = userEvent.setup()
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    vi.spyOn(projectResearchApi, 'refineQuestion').mockResolvedValue(result({
      recommended_question: 'How do coding agents recover from failed repository tool calls?',
    }))
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread()}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{ ...persisted.assessment_session, latest_refinement: latestRefinement }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const wording = screen.getByLabelText('Current recommended wording')
    await user.clear(wording)
    await user.type(wording, 'How do coding agents recover from failed repository tool calls?')

    expect(screen.getByText('Unassessed changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm research question' })).toBeDisabled()
    expect(projectResearchApi.saveInitialIntakeDraft).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Assess changes' }))
    await waitFor(() => expect(projectResearchApi.refineQuestion).toHaveBeenCalledWith('project-1', expect.objectContaining({
      research_question: 'How do coding agents recover from failed repository tool calls?',
    })))
    expect(projectResearchApi.saveInitialIntakeDraft).not.toHaveBeenCalled()
  })

  it('confirms the framework wording back to the Inquiry Thread', async () => {
    const user = userEvent.setup()
    vi.spyOn(projectResearchApi, 'refineQuestion').mockResolvedValue(result())
    vi.spyOn(inquiryApi, 'reviseDefinition').mockResolvedValue({} as never)
    const onChanged = vi.fn().mockResolvedValue(undefined)
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread({ next_focus_kind: 'clarify_or_decompose' })}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={null}
        canAct
        onChanged={onChanged}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Start assessment' }))
    await screen.findByText('Ready to confirm')
    await user.click(screen.getByRole('button', { name: 'Confirm research question' }))

    await waitFor(() => expect(inquiryApi.reviseDefinition).toHaveBeenCalledWith('project-1', 'thread-1', {
      revision_kind: 'semantic_change',
      structure_action: 'narrow',
      new_statement: 'How do failed tool calls affect coding-agent task completion?',
    }))
    expect(projectResearchApi.saveInitialIntakeDraft).toHaveBeenCalledWith('project-1', expect.objectContaining({
      thread_id: 'thread-1',
      research_question: 'How do failed tool calls affect coding-agent task completion?',
      research_context_version_id: 'confirmed-context-1',
      question_refine_skipped: false,
    }))
    expect(inquiryApi.updateWork).toHaveBeenCalledWith('project-1', 'thread-1', {
      next_focus_kind: null,
      blocked_reason: null,
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('edits, deletes, and adds framework items inline before confirming them as a manual adjustment', async () => {
    const user = userEvent.setup()
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    vi.spyOn(inquiryApi, 'reviseDefinition').mockResolvedValue({} as never)
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread({ statement: persisted.recommended_question })}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{ ...persisted.assessment_session, latest_refinement: latestRefinement }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Edit In scope item 1' }))
    const scopeInput = screen.getByLabelText('Edit In scope item 1')
    await user.clear(scopeInput)
    await user.type(scopeInput, 'Repository coding agents')
    await user.click(screen.getByRole('button', { name: 'Save In scope item 1' }))

    await user.click(screen.getByRole('button', { name: 'Delete Out of scope item 1' }))
    await user.click(screen.getByRole('button', { name: 'Add In scope item' }))
    await user.type(screen.getByLabelText('New In scope item'), 'Long-running tasks')
    await user.click(screen.getByRole('button', { name: 'Save new In scope item' }))

    expect(screen.getByText('Manually adjusted')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm research question' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Confirm research question' }))

    await waitFor(() => expect(projectResearchApi.confirmQuestionAssessment).toHaveBeenCalledWith('project-1', expect.objectContaining({
      manually_adjusted: true,
      refinement: expect.objectContaining({
        scope: {
          in: ['Repository coding agents', 'Long-running tasks'],
          out: [],
        },
      }),
    })))
  })

  it('clears the manual-change state when framework edits return to the assessed content', async () => {
    const user = userEvent.setup()
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread({ statement: persisted.recommended_question })}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{ ...persisted.assessment_session, latest_refinement: latestRefinement }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Add In scope item' }))
    await user.type(screen.getByLabelText('New In scope item'), 'Temporary scope')
    await user.click(screen.getByRole('button', { name: 'Save new In scope item' }))

    expect(screen.getByText('Manually adjusted')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reassess changes' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete In scope item 2' }))

    expect(screen.queryByText('Manually adjusted')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reassess changes' })).not.toBeInTheDocument()
  })

  it('disables an unchanged confirmed snapshot and re-enables confirmation only for a net change', async () => {
    const user = userEvent.setup()
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread({ statement: persisted.recommended_question })}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{ ...persisted.assessment_session, latest_refinement: latestRefinement }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const confirm = await screen.findByRole('button', { name: 'Confirm research question' })
    await user.click(confirm)
    expect(await screen.findByRole('button', { name: 'Confirmed' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Add In scope item' }))
    await user.type(screen.getByLabelText('New In scope item'), 'Temporary scope')
    await user.click(screen.getByRole('button', { name: 'Save new In scope item' }))
    expect(screen.getByRole('button', { name: 'Confirm research question' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Delete In scope item 2' }))
    expect(screen.getByRole('button', { name: 'Confirmed' })).toBeDisabled()
  })

  it('restores the confirmed button state from the durable confirmation snapshot', async () => {
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    vi.mocked(projectResearchApi.questionAssessmentConfirmations).mockResolvedValueOnce([{
      id: persisted.research_context_version_id,
      version: 4,
      question: persisted.recommended_question ?? '',
      assessment: persisted.assessment,
      scope: persisted.scope,
      sub_questions: persisted.sub_questions,
      manually_adjusted: false,
      created_at: '2026-07-30T12:00:00.000Z',
    }])
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread({ statement: persisted.recommended_question })}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{ ...persisted.assessment_session, latest_refinement: latestRefinement }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(await screen.findByRole('button', { name: 'Confirmed' })).toBeDisabled()
  })

  it('keeps a successful confirmation when the later workflow save fails and reports the failing stage', async () => {
    const user = userEvent.setup()
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    vi.mocked(projectResearchApi.saveInitialIntakeDraft).mockRejectedValueOnce(new Error('save unavailable'))
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread({ statement: persisted.recommended_question })}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{ ...persisted.assessment_session, latest_refinement: latestRefinement }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Confirm research question' }))

    expect(await screen.findByRole('button', { name: 'Confirmed' })).toBeDisabled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('research draft could not be saved'))
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('Could not confirm this assessment'))
  })

  it('shows confirmed framework and wording history without overwriting the working draft', async () => {
    const user = userEvent.setup()
    const persisted = result()
    const { assessment_session: _ignored, ...latestRefinement } = persisted
    vi.spyOn(projectResearchApi, 'questionAssessmentConfirmations').mockResolvedValue([{
      id: 'confirmation-old',
      version: 2,
      question: 'Earlier confirmed question',
      assessment: persisted.assessment,
      scope: { in: ['Earlier scope'], out: [] },
      sub_questions: [],
      manually_adjusted: false,
      created_at: '2026-07-29T12:00:00.000Z',
    }])
    vi.spyOn(inquiryApi, 'listRevisions').mockResolvedValue([{
      id: 'revision-1',
      thread_id: 'thread-1',
      version: 1,
      kind: 'question',
      statement: 'Original question wording',
      answer_state: 'open',
      evaluation_state: null,
      confidence: null,
      state_snapshot_json: {},
      change_significance: 'material',
      created_by_user_id: 'user-1',
      created_at: '2026-07-28T12:00:00.000Z',
    }])
    render(
      <QuestionRefinementPanel
        projectId="project-1"
        thread={makeThread()}
        linkedDraftWorkflow={null}
        modelProviders={providers}
        providerVendors={providerVendors}
        assessmentSession={{ ...persisted.assessment_session, latest_refinement: latestRefinement }}
        canAct
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'History' }))
    expect(await screen.findByText('Earlier confirmed question')).toBeInTheDocument()
    expect(screen.getByText('Original question wording')).toBeInTheDocument()
    expect(screen.getByDisplayValue('How do failed tool calls affect coding-agent task completion?')).toBeInTheDocument()
  })
})
