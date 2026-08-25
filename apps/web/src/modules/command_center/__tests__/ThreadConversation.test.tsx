import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import ThreadConversation from '../ThreadConversation'
import { hostsApi, runsApi, type ModelProviderOut } from '../../../api/client'
import type { HostThreadEvent } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({
  hostsApi: { listMessages: vi.fn(), listEvents: vi.fn(), cancel: vi.fn(), resumeQueue: vi.fn(), withdrawMessage: vi.fn() },
  artifactsApi: { list: vi.fn(), get: vi.fn() },
  runsApi: { resume: vi.fn(), abandon: vi.fn() },
}))

const THREAD = {
  id: 'thread-1', project_folder_id: 'folder-1', host_id: 'host-1', adapter_type: 'claude_code',
  vendor_session_id: null, last_run_id: 'run-1', status: 'active' as const,
  created_by_user_id: 'user-1', created_at: '', updated_at: '', queue_paused_at: null,
}
const RUNNING_RUN = {
  id: 'run-1', space_id: 'space-1', agent_id: 'agent-1', agent_version_id: 'v1', run_role: 'execution' as const,
  project_folder_id: 'folder-1', host_task_thread_id: 'thread-1', session_id: null, parent_run_id: null,
  run_type: 'system', trigger_origin: 'manual', status: 'running', mode: 'live', prompt: 'do the thing',
  instruction: null, scheduled_at: null, started_at: '2026-08-21T00:00:00.000Z', ended_at: null,
  created_at: '2026-08-21T00:00:00.000Z', updated_at: '2026-08-21T00:00:00.000Z', error_message: null,
  error_json: null, output_json: null, usage: null, project_id: 'project-1',
}
const MESSAGE = {
  id: 'message-1', host_task_thread_id: 'thread-1', prompt: 'do the thing', status: 'dispatched' as const,
  model_provider_id: null, model: null, run_id: 'run-1', created_by_user_id: 'user-1', created_at: '2026-08-21T00:00:00.000Z', updated_at: '2026-08-21T00:00:00.000Z',
}

function eventFixture(overrides: Partial<HostThreadEvent> & { event_type: HostThreadEvent['event_type'] }): HostThreadEvent {
  return {
    id: `e-${Math.random()}`, host_task_thread_id: 'thread-1', run_id: 'run-1', event_index: 0,
    text: null, tool_call_id: null, tool_name: null, tool_input_summary: null,
    tool_kind: null, tool_result_summary: null, status: null, created_at: '',
    ...overrides,
  }
}

/** Passed in by the screen; the conversation no longer fetches it. */
let PROVIDERS: ModelProviderOut[] | null = []

beforeEach(() => {
  vi.mocked(hostsApi.listMessages).mockResolvedValue({ items: [MESSAGE] })
  PROVIDERS = []
})

describe('ThreadConversation — run-completion detection (discovery review, P3)', () => {
  it('notifies the parent when a status event arrives on the poll, instead of staying stuck on the initial run snapshot', async () => {
    vi.mocked(hostsApi.listEvents)
      .mockResolvedValueOnce({ items: [{ id: 'e0', host_task_thread_id: 'thread-1', run_id: 'run-1', event_index: 0, event_type: 'status', text: null, tool_call_id: null, tool_name: null, tool_input_summary: null, tool_kind: null, tool_result_summary: null, status: 'run_started', created_at: '' }] })
      .mockResolvedValueOnce({ items: [{ id: 'e1', host_task_thread_id: 'thread-1', run_id: 'run-1', event_index: 1, event_type: 'status', text: null, tool_call_id: null, tool_name: null, tool_input_summary: null, tool_kind: null, tool_result_summary: null, status: 'run_succeeded', created_at: '' }] })

    const onThreadChanged = vi.fn()
    vi.useFakeTimers()
    try {
      render(<ThreadConversation thread={THREAD} runs={[RUNNING_RUN]} providers={PROVIDERS} onThreadChanged={onThreadChanged} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
      expect(onThreadChanged).not.toHaveBeenCalled()

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

      expect(onThreadChanged).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not poll or show Cancel once the run snapshot the parent passed in is already terminal', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({ items: [] })
    const onThreadChanged = vi.fn()
    render(<ThreadConversation thread={THREAD} runs={[{ ...RUNNING_RUN, status: 'succeeded' }]} providers={PROVIDERS} onThreadChanged={onThreadChanged} />)
    await waitFor(() => expect(hostsApi.listMessages).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument()
  })
})

describe('ThreadConversation — message visibility (real-usage feedback)', () => {
  it('shows a newly dispatched message as soon as the parent\'s `runs` prop reflects it, without waiting for the run to finish', async () => {
    const callsBefore = vi.mocked(hostsApi.listMessages).mock.calls.length
    vi.mocked(hostsApi.listMessages).mockResolvedValueOnce({ items: [] })
    vi.mocked(hostsApi.listEvents).mockResolvedValue({ items: [] })
    const { rerender } = render(<ThreadConversation thread={THREAD} runs={[]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    await waitFor(() => expect(vi.mocked(hostsApi.listMessages).mock.calls.length).toBe(callsBefore + 1))
    expect(screen.queryByText('do the thing')).not.toBeInTheDocument()

    // A message was just dispatched: it exists server-side, but its run is
    // still `queued` (not terminal) — the parent's next `load()` reflects
    // this by passing a new `runs` array down.
    vi.mocked(hostsApi.listMessages).mockResolvedValueOnce({ items: [MESSAGE] })
    rerender(<ThreadConversation thread={THREAD} runs={[{ ...RUNNING_RUN, status: 'queued' }]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)

    expect(await screen.findByText('do the thing')).toBeInTheDocument()
    // A queued (not yet running) turn still gets the "Working…" indicator.
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })
})

describe('ThreadConversation — interleaved rendering and markdown (real-usage feedback)', () => {
  it('collapses everything before the final answer once the run finishes, preserving the real text/tool interleaving', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [
        eventFixture({ event_index: 0, event_type: 'assistant_text', text: 'Checking the repo first.' }),
        eventFixture({ event_index: 1, event_type: 'tool_activity_started', tool_call_id: 'call-1', tool_name: 'Bash' }),
        eventFixture({ event_index: 2, event_type: 'tool_activity_finished', tool_call_id: 'call-1', status: 'succeeded' }),
        eventFixture({ event_index: 3, event_type: 'assistant_text', text: 'All done, here is the summary.' }),
      ],
    })
    render(<ThreadConversation thread={THREAD} runs={[{ ...RUNNING_RUN, status: 'succeeded' }]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)

    // Final answer is immediately visible; the reasoning trail is not.
    expect(await screen.findByText('All done, here is the summary.')).toBeInTheDocument()
    expect(screen.queryByText('Checking the repo first.')).not.toBeInTheDocument()
    expect(screen.queryByText('Bash')).not.toBeInTheDocument()
    const toggle = screen.getByText(/earlier step/)
    expect(toggle.textContent).toContain('2 earlier steps')
    expect(toggle.textContent).toContain('1 tool call')

    // Expanding reveals the true order: text, then the tool it preceded.
    await userEvent.click(toggle)
    const priorText = screen.getByText('Checking the repo first.')
    const toolRow = screen.getByText('Bash')
    expect(priorText.compareDocumentPosition(toolRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not collapse anything while the run is still active, even with a trailing text block', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [eventFixture({ event_index: 0, event_type: 'assistant_text', text: 'Still working on it.' })],
    })
    render(<ThreadConversation thread={THREAD} runs={[RUNNING_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText('Still working on it.')).toBeInTheDocument()
    expect(screen.queryByText(/earlier step/)).not.toBeInTheDocument()
  })

  it('renders assistant text as markdown instead of raw syntax', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [eventFixture({ event_index: 0, event_type: 'assistant_text', text: '## Summary\nThe fix is **done**.' })],
    })
    const { container } = render(
      <ThreadConversation thread={THREAD} runs={[{ ...RUNNING_RUN, status: 'succeeded' }]} providers={PROVIDERS} onThreadChanged={vi.fn()} />,
    )
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument()
    expect(container.querySelector('strong')).toHaveTextContent('done')
    expect(screen.queryByText(/\*\*done\*\*/)).not.toBeInTheDocument()
  })
})

describe('ThreadConversation — ACP schema absorption (ACP runtime replatform P3, A9)', () => {
  it('renders a tool call\'s kind badge and its bounded result content once expanded', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [
        eventFixture({ event_index: 0, event_type: 'tool_activity_started', tool_call_id: 'call-1', tool_name: 'Read file', tool_kind: 'read' }),
        eventFixture({ event_index: 1, event_type: 'tool_activity_finished', tool_call_id: 'call-1', status: 'succeeded', tool_result_summary: 'file contents here' }),
      ],
    })
    render(<ThreadConversation thread={THREAD} runs={[RUNNING_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)

    expect(await screen.findByText('read')).toBeInTheDocument()
    expect(screen.queryByText('file contents here')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Read file'))
    expect(await screen.findByText('file contents here')).toBeInTheDocument()
  })

  it('shows a tool call as still running (not succeeded/failed) on a non-terminal in_progress update', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [
        eventFixture({ event_index: 0, event_type: 'tool_activity_started', tool_call_id: 'call-1', tool_name: 'Bash' }),
        eventFixture({ event_index: 1, event_type: 'tool_activity_finished', tool_call_id: 'call-1', status: 'in_progress' }),
      ],
    })
    render(<ThreadConversation thread={THREAD} runs={[RUNNING_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText('Bash')).toBeInTheDocument()
    expect(screen.queryByText('succeeded')).not.toBeInTheDocument()
    expect(screen.queryByText('failed')).not.toBeInTheDocument()
  })

  it('renders the thread\'s latest plan snapshot as a checklist, ignoring an earlier revision', async () => {
    const firstPlan = JSON.stringify([{ content: 'Write tests', status: 'in_progress' }])
    const latestPlan = JSON.stringify([
      { content: 'Write tests', status: 'completed' },
      { content: 'Ship the fix', status: 'in_progress' },
    ])
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [
        eventFixture({ event_index: 0, event_type: 'plan_updated', text: firstPlan }),
        eventFixture({ event_index: 1, event_type: 'plan_updated', text: latestPlan }),
      ],
    })
    render(<ThreadConversation thread={THREAD} runs={[RUNNING_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)

    expect(await screen.findByText('Write tests')).toBeInTheDocument()
    expect(await screen.findByText('Ship the fix')).toBeInTheDocument()
  })
})

describe('ThreadConversation — real-time feel', () => {
  it('shows a "Working…" indicator while a run is active, and none once it has finished', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({ items: [] })
    const { rerender } = render(<ThreadConversation thread={THREAD} runs={[RUNNING_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText('Working…')).toBeInTheDocument()

    rerender(<ThreadConversation thread={THREAD} runs={[{ ...RUNNING_RUN, status: 'succeeded' }]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('Working…')).not.toBeInTheDocument())
  })

  it('renders the assistant reply left-aligned (chat-bubble layout) and the user turn right-aligned', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [{ id: 'e0', host_task_thread_id: 'thread-1', run_id: 'run-1', event_index: 0, event_type: 'assistant_text', text: 'On it.', tool_call_id: null, tool_name: null, tool_input_summary: null, tool_kind: null, tool_result_summary: null, status: null, created_at: '' }],
    })
    render(<ThreadConversation thread={THREAD} runs={[{ ...RUNNING_RUN, status: 'succeeded' }]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    const userBubble = await screen.findByText('do the thing')
    const assistantBubble = await screen.findByText('On it.')
    expect(userBubble.closest('.flex.justify-end')).toBeTruthy()
    expect(assistantBubble.closest('.flex.justify-start')).toBeTruthy()
  })
})


describe('ThreadConversation — a run held for review', () => {
  const HELD_RUN = {
    ...RUNNING_RUN,
    status: 'waiting_for_review',
    ended_at: '2026-08-21T00:01:00.000Z',
    error_message: 'Supervisor requires human review after attempt 1: runtime_stall_timeout.',
  }

  beforeEach(() => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({ items: [] })
    vi.mocked(runsApi.resume).mockResolvedValue({ id: 'run-1', status: 'queued', resumed_at: '', resume_kind: 'retry' } as never)
    vi.mocked(runsApi.abandon).mockResolvedValue({ id: 'run-1', status: 'cancelled', abandoned_at: '' } as never)
  })

  it('shows why the run is held and offers the review actions inline', async () => {
    // These actions existed only on the Run detail page, so a thread whose run
    // was held simply stopped, with the reason shown nowhere on this screen.
    render(<ThreadConversation thread={THREAD} runs={[HELD_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText(/Waiting for your review/)).toBeInTheDocument()
    expect(screen.getByText(/runtime_stall_timeout/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('retries the held run and tells the parent to refresh', async () => {
    const onThreadChanged = vi.fn()
    render(<ThreadConversation thread={THREAD} runs={[HELD_RUN]} providers={PROVIDERS} onThreadChanged={onThreadChanged} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(runsApi.resume).toHaveBeenCalledWith('run-1'))
    await waitFor(() => expect(onThreadChanged).toHaveBeenCalled())
  })

  it('requires a second click before abandoning', async () => {
    render(<ThreadConversation thread={THREAD} runs={[HELD_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Abandon' }))
    expect(runsApi.abandon).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm abandon' }))
    await waitFor(() => expect(runsApi.abandon).toHaveBeenCalledWith('run-1'))
  })

  it('does not show a held run as still working', async () => {
    // waiting_for_review is not in ACTIVE_RUN_STATUSES, so the typing
    // indicator must not claim the runtime is still producing output.
    const { container } = render(<ThreadConversation thread={THREAD} runs={[HELD_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    await screen.findByText(/Waiting for your review/)
    expect(container.querySelector('.animate-bounce')).toBeNull()
  })
})

describe('ThreadConversation — reasoning', () => {
  const ENDED_RUN = { ...RUNNING_RUN, status: 'succeeded', ended_at: '2026-08-21T00:01:00.000Z' }

  it('collapses reasoning instead of showing it as the answer', async () => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [
        eventFixture({ event_type: 'assistant_thought', text: 'the user is asking what model I am', event_index: 0 }),
        eventFixture({ event_type: 'assistant_text', text: '我是 MiniMax-M3。', event_index: 1 }),
      ],
    })
    render(<ThreadConversation thread={THREAD} runs={[ENDED_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)

    expect(await screen.findByText('我是 MiniMax-M3。')).toBeInTheDocument()
    // Present but behind a disclosure, not rendered alongside the reply.
    expect(screen.getByRole('button', { name: /Reasoning/ })).toBeInTheDocument()
    expect(screen.queryByText(/the user is asking what model I am/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Reasoning/ }))
    expect(screen.getByText(/the user is asking what model I am/)).toBeInTheDocument()
  })

  it("does not treat a trailing reasoning block as the turn's answer", async () => {
    // A turn that ends on reasoning must not have it promoted into the
    // final-answer slot that collapses everything before it.
    vi.mocked(hostsApi.listEvents).mockResolvedValue({
      items: [
        eventFixture({ event_type: 'assistant_text', text: 'done', event_index: 0 }),
        eventFixture({ event_type: 'assistant_thought', text: 'trailing thought', event_index: 1 }),
      ],
    })
    render(<ThreadConversation thread={THREAD} runs={[ENDED_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText('done')).toBeInTheDocument()
    expect(screen.queryByText(/trailing thought/)).not.toBeInTheDocument()
  })
})

describe('ThreadConversation — which backend answered', () => {
  const ENDED_RUN = { ...RUNNING_RUN, status: 'succeeded', ended_at: '2026-08-21T00:01:00.000Z' }

  beforeEach(() => {
    vi.mocked(hostsApi.listEvents).mockResolvedValue({ items: [] })
    PROVIDERS = [
      { id: 'prov-1', name: 'MiniMax', default_model: 'MiniMax-M3', available_models: ['MiniMax-M3'], enabled: true } as ModelProviderOut,
    ]
  })

  it('names the provider and model a turn ran against', async () => {
    vi.mocked(hostsApi.listMessages).mockResolvedValue({
      items: [{ ...MESSAGE, model_provider_id: 'prov-1', model: 'MiniMax-M3' }],
    })
    render(<ThreadConversation thread={THREAD} runs={[ENDED_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText(/MiniMax · MiniMax-M3/)).toBeInTheDocument()
  })

  it("says so when a turn ran on the machine's own login", async () => {
    vi.mocked(hostsApi.listMessages).mockResolvedValue({
      items: [{ ...MESSAGE, model_provider_id: null, model: null }],
    })
    render(<ThreadConversation thread={THREAD} runs={[ENDED_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText(/This machine's login/)).toBeInTheDocument()
  })

  it('shows the backend a queued message will run on, before it dispatches', async () => {
    // The window between sending and dispatch is otherwise the one place a
    // backend change is invisible.
    vi.mocked(hostsApi.listMessages).mockResolvedValue({
      items: [{ ...MESSAGE, status: 'queued', run_id: null, model_provider_id: 'prov-1', model: 'MiniMax-M3' }],
    })
    render(<ThreadConversation thread={THREAD} runs={[]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText(/MiniMax · MiniMax-M3/)).toBeInTheDocument()
  })

  it('says nothing about the backend while the provider list has not loaded', async () => {
    // Null is "not loaded (or failed)", empty is "loaded, and the provider is
    // really gone". Collapsing them made a failed fetch label every turn in
    // the thread as running on a deleted provider.
    PROVIDERS = null
    vi.mocked(hostsApi.listMessages).mockResolvedValue({
      items: [{ ...MESSAGE, model_provider_id: 'prov-1', model: 'MiniMax-M3' }],
    })
    render(<ThreadConversation thread={THREAD} runs={[ENDED_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    await waitFor(() => expect(hostsApi.listMessages).toHaveBeenCalled())
    expect(screen.queryByText(/Unavailable provider/)).not.toBeInTheDocument()
    expect(screen.queryByText(/MiniMax/)).not.toBeInTheDocument()
  })

  it('names a provider that has since been removed instead of dropping it', async () => {
    // The binding outlives a deleted provider, and the id is what the run
    // actually used — more useful than silence.
    PROVIDERS = []
    vi.mocked(hostsApi.listMessages).mockResolvedValue({
      items: [{ ...MESSAGE, model_provider_id: 'prov-gone', model: 'X-1' }],
    })
    render(<ThreadConversation thread={THREAD} runs={[ENDED_RUN]} providers={PROVIDERS} onThreadChanged={vi.fn()} />)
    expect(await screen.findByText(/Unavailable provider/)).toBeInTheDocument()
  })
})
