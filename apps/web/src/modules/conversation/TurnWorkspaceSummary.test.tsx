import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Run } from '../../types/api'
import { run as fixture } from '../agent_work/fixtures.test-support'
import { workspaceChange } from '../runs/workspaceFixtures.test-support'

vi.mock('../../api/client', async () => {
  const { ApiRequestError } = await import('../../test/apiClientMock')
  return {
    ApiRequestError,
    runsApi: { get: vi.fn(), artifacts: vi.fn() },
    artifactsApi: { get: vi.fn() },
    callOperation: vi.fn(),
    agentWorkspacesApi: { conversationChanges: vi.fn() },
  }
})
vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

import { agentWorkspacesApi, runsApi, ApiRequestError } from '../../api/client'
import { TurnWorkspaceSummary } from './TurnWorkspaceSummary'
import { ConversationPendingWork } from './ConversationPendingWork'
import { ConversationScope } from './ConversationScope'

const workspaceRun = (overrides: Partial<Run> = {}) => fixture({ contract_snapshot_json: { execution_workspace_version: 1 }, ...overrides })
const show = (runs: Run[], exclude?: Set<string>, onPresented?: (ids: readonly string[]) => void) => render(<MemoryRouter><TurnWorkspaceSummary runs={runs} projectId="project" exclude={exclude} onPresented={onPresented} agentName={run => run.agent_id === 'agent-b' ? 'Builder' : 'Reviewer'} /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runsApi.artifacts).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
})

it('shows nothing for a read-only turn that saved no changes', async () => {
  const readOnly = workspaceRun({ workspace_changes: [workspaceChange({ state: 'no_changes', cleanup_state: 'cleaned', source_commit: null })] })
  vi.mocked(runsApi.get).mockResolvedValue(readOnly)
  const view = show([readOnly])
  await waitFor(() => expect(runsApi.get).toHaveBeenCalled())
  expect(view.container).toBeEmptyDOMElement()
})

it('reports a failed workspace read instead of treating it as no changes', async () => {
  const unread = workspaceRun({ workspace_changes: [] })
  vi.mocked(runsApi.get).mockRejectedValue(new ApiRequestError('Bad gateway', 502))
  show([unread])
  const summary = await screen.findByTestId('turn-workspace-summary')
  expect(summary.querySelector('summary')).toHaveTextContent('Status unavailable')
  expect(screen.getByText(/This is not the same as no changes/)).toBeInTheDocument()
})

it('collapses one request group into a single line and lists a shared batch once', async () => {
  const parentChange = workspaceChange({ change_set_id: 'parent-change', state: 'integrated', landing: 'target' })
  const childChange = workspaceChange({ change_set_id: 'child-change', workspace_id: 'child-ws', parent_workspace_id: 'workspace', target_ref: 'refs/heads/rainver/workspace-workspace-g1', state: 'integrated', landing: 'parent' })
  const parent = workspaceRun({ id: 'parent', workspace_changes: [parentChange] })
  const child = workspaceRun({ id: 'child', agent_id: 'agent-c', parent_run_id: 'parent', workspace_changes: [childChange, parentChange] })
  vi.mocked(runsApi.get).mockImplementation(async id => id === 'parent' ? parent : child)
  show([parent, child])
  const summary = await screen.findByTestId('turn-workspace-summary')
  expect(summary).not.toHaveAttribute('open')
  expect(summary.querySelector('summary')).toHaveTextContent(/Merged into dev · Adopted by parent/)
  expect(screen.getAllByTestId(/^workspace-change-/).map(row => row.dataset.testid)).toEqual(['workspace-change-parent-change', 'workspace-change-child-change'])
  // Technical identifiers live in their own disclosure, not the summary line.
  expect(summary.querySelector('summary')).not.toHaveTextContent('refs/heads')
})

it('surfaces a decision in the collapsed line and leaves later-owned batches to their own turn', async () => {
  const blocked = workspaceChange({ change_set_id: 'blocked', state: 'blocked', integration_id: 'integration', integration_revision: 3, integration_status: 'conflict', integration_detail: { conflicted_files: ['a.ts'] } })
  const later = workspaceChange({ change_set_id: 'later', state: 'open' })
  const turn = workspaceRun({ workspace_changes: [blocked, later] })
  vi.mocked(runsApi.get).mockResolvedValue(turn)
  show([turn], new Set(['later']))
  const line = (await screen.findByTestId('turn-workspace-summary')).querySelector('summary')!
  expect(line).toHaveTextContent('Needs your decision')
  expect(line).not.toHaveTextContent('Saved privately')
  expect(screen.queryByTestId('workspace-change-later')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Check whether already integrated' })).toBeInTheDocument()
})

it('lists conversation pending work not already shown by a loaded turn, and reports a failed check', async () => {
  vi.mocked(agentWorkspacesApi.conversationChanges).mockResolvedValue({ items: [
    { change: workspaceChange({ change_set_id: 'shown' }), run: { id: 'r1', status: 'succeeded', agent_id: 'agent-b' } },
    { change: workspaceChange({ change_set_id: 'retained', state: 'blocked', workspace_state: 'blocked' }), run: { id: 'r0', status: 'failed', agent_id: 'agent-b' } },
  ], next_cursor: null })
  const view = render(<MemoryRouter><ConversationPendingWork conversationId="c" presented={new Set(['shown'])} refreshToken="1" agentName={() => 'Builder'} /></MemoryRouter>)
  const entry = await screen.findByTestId('conversation-pending-work')
  expect(entry.querySelector('summary')).toHaveTextContent('1 unfinished workspace change in this conversation')
  expect(entry.querySelector('summary')).toHaveTextContent('Needs your decision')
  expect(screen.queryByTestId('workspace-change-shown')).not.toBeInTheDocument()
  view.unmount()
  vi.mocked(agentWorkspacesApi.conversationChanges).mockRejectedValue(new ApiRequestError('down', 503))
  render(<MemoryRouter><ConversationPendingWork conversationId="c" presented={new Set()} refreshToken="1" agentName={() => undefined} /></MemoryRouter>)
  expect(await screen.findByText('Could not check this conversation for unfinished workspace changes.')).toBeInTheDocument()
})

it('claims only the batches it displays: nothing while checking or after a failed read of that Run', async () => {
  const shown = workspaceChange({ change_set_id: 'shown', state: 'open' })
  const blocked = workspaceChange({ change_set_id: 'blocked', state: 'blocked' })
  const readable = workspaceRun({ id: 'readable', workspace_changes: [shown] })
  // The loaded record lists a blocked batch, but this Run cannot be read now.
  const unreadable = workspaceRun({ id: 'unreadable', agent_id: 'agent-b', workspace_changes: [] })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(runsApi.get).mockImplementation(async id => { await gate; if (id === 'unreadable') throw new ApiRequestError('down', 503); return readable })
  const reports: string[][] = []
  const view = show([readable, unreadable], undefined, ids => reports.push([...ids]))
  await waitFor(() => expect(reports.length).toBeGreaterThan(0))
  expect(reports[reports.length - 1]).toEqual([])
  release()
  await screen.findByTestId('turn-workspace-summary')
  await waitFor(() => expect(reports[reports.length - 1]).toEqual(['shown']))
  expect(reports.flat()).not.toContain(blocked.change_set_id)
  view.unmount()
  expect(reports[reports.length - 1]).toEqual([])
})

it('continues to later pending pages, including when the first page is all shown elsewhere', async () => {
  vi.mocked(agentWorkspacesApi.conversationChanges).mockImplementation(async (_id, page) => page?.cursor === 'p2'
    ? { items: [{ change: workspaceChange({ change_set_id: 'late', state: 'blocked' }), run: { id: 'r9', status: 'failed', agent_id: null } }], next_cursor: 'p3' }
    : page?.cursor === 'p3'
      ? { items: [{ change: workspaceChange({ change_set_id: 'last', state: 'open' }), run: { id: 'r10', status: 'succeeded', agent_id: null } }], next_cursor: null }
      : { items: [{ change: workspaceChange({ change_set_id: 'shown' }), run: { id: 'r1', status: 'succeeded', agent_id: null } }], next_cursor: 'p2' })
  render(<MemoryRouter><ConversationPendingWork conversationId="c" presented={new Set(['shown'])} refreshToken="1" agentName={() => undefined} /></MemoryRouter>)
  const entry = await screen.findByTestId('conversation-pending-work')
  expect(entry.querySelector('summary')).toHaveTextContent('1+ unfinished workspace change in this conversation')
  expect(agentWorkspacesApi.conversationChanges).toHaveBeenCalledWith('c', { cursor: 'p2' }, expect.anything())
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(entry.querySelector('summary')).toHaveTextContent('2 unfinished workspace changes in this conversation'))
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
})

type PendingPage = Awaited<ReturnType<typeof agentWorkspacesApi.conversationChanges>>
function deferred() {
  let resolve!: (page: PendingPage) => void
  const promise = new Promise<PendingPage>(done => { resolve = done })
  return { promise, resolve }
}
const pendingEntry = (id: string) => ({ change: workspaceChange({ change_set_id: id, state: 'blocked' }), run: { id: `run-${id}`, status: 'failed', agent_id: null } })
const pendingWork = (props: { conversationId?: string; presented?: string[]; refreshToken?: string; actionUserId?: string }) => <MemoryRouter><ConversationScope actionUserId={props.actionUserId}>
  <ConversationPendingWork conversationId={props.conversationId ?? 'c'} presented={new Set(props.presented ?? [])} refreshToken={props.refreshToken ?? '1'} agentName={() => undefined} />
</ConversationScope></MemoryRouter>
/** Every request waits for the test to answer it, keyed by cursor in call order. */
function answerable() {
  const calls: { conversationId: string; cursor?: string; reply: ReturnType<typeof deferred> }[] = []
  vi.mocked(agentWorkspacesApi.conversationChanges).mockImplementation((conversationId, page) => {
    const reply = deferred()
    calls.push({ conversationId, cursor: page?.cursor ?? undefined, reply })
    return reply.promise
  })
  return calls
}

it('a refresh during Load more re-enables paging from the new first page and drops the late older page', async () => {
  const calls = answerable()
  const view = render(pendingWork({}))
  await waitFor(() => expect(calls).toHaveLength(1))
  calls[0]!.reply.resolve({ items: [pendingEntry('first')], next_cursor: 'old-2' })
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]!.cursor).toBe('old-2')
  // The conversation refreshes while that page is still in flight.
  view.rerender(pendingWork({ refreshToken: '2' }))
  await waitFor(() => expect(calls).toHaveLength(3))
  expect(calls[2]!.cursor).toBeUndefined()
  // Until the new first page settles, the older cursor cannot be continued.
  expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled()
  calls[2]!.reply.resolve({ items: [pendingEntry('fresh')], next_cursor: 'new-2' })
  await screen.findByTestId('workspace-change-fresh')
  calls[1]!.reply.resolve({ items: [pendingEntry('stale')], next_cursor: null })
  const more = await screen.findByRole('button', { name: 'Load more' })
  await waitFor(() => expect(more).toBeEnabled())
  expect(screen.queryByTestId('workspace-change-stale')).not.toBeInTheDocument()
  fireEvent.click(more)
  await waitFor(() => expect(calls).toHaveLength(4))
  expect(calls[3]!.cursor).toBe('new-2')
  calls[3]!.reply.resolve({ items: [pendingEntry('later')], next_cursor: null })
  expect(await screen.findByTestId('workspace-change-later')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
})

it('restarts the automatic continuation after a refresh when the first page is all shown elsewhere', async () => {
  const calls = answerable()
  const view = render(pendingWork({ presented: ['shown'] }))
  await waitFor(() => expect(calls).toHaveLength(1))
  calls[0]!.reply.resolve({ items: [pendingEntry('shown')], next_cursor: 'old-2' })
  // Nothing on the first page is left to show: it continues on its own.
  await waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]!.cursor).toBe('old-2')
  view.rerender(pendingWork({ presented: ['shown'], refreshToken: '2' }))
  await waitFor(() => expect(calls).toHaveLength(3))
  calls[2]!.reply.resolve({ items: [pendingEntry('shown')], next_cursor: 'new-2' })
  await waitFor(() => expect(calls).toHaveLength(4))
  expect(calls[3]!.cursor).toBe('new-2')
  calls[1]!.reply.resolve({ items: [pendingEntry('stale')], next_cursor: null })
  calls[3]!.reply.resolve({ items: [pendingEntry('later')], next_cursor: null })
  expect(await screen.findByTestId('workspace-change-later')).toBeInTheDocument()
  expect(screen.queryByTestId('workspace-change-stale')).not.toBeInTheDocument()
  expect(calls).toHaveLength(4)
})

it('never shows or continues the previous conversation or permission scope after a switch', async () => {
  const calls = answerable()
  const view = render(pendingWork({ actionUserId: 'reader' }))
  await waitFor(() => expect(calls).toHaveLength(1))
  calls[0]!.reply.resolve({ items: [pendingEntry('theirs')], next_cursor: 'c-2' })
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(calls).toHaveLength(2))
  // Acting identity changes: the shown work and its cursor belong to the old scope.
  view.rerender(pendingWork({ actionUserId: 'other' }))
  await waitFor(() => expect(calls).toHaveLength(3))
  expect(screen.queryByTestId('conversation-pending-work')).not.toBeInTheDocument()
  calls[1]!.reply.resolve({ items: [pendingEntry('old-scope')], next_cursor: null })
  calls[2]!.reply.resolve({ items: [], next_cursor: null })
  await waitFor(() => expect(screen.queryByTestId('conversation-pending-work')).not.toBeInTheDocument())
  // Another conversation likewise starts empty while its own first page loads.
  view.rerender(pendingWork({ actionUserId: 'other', conversationId: 'd' }))
  await waitFor(() => expect(calls).toHaveLength(4))
  expect(calls[3]!.conversationId).toBe('d')
  calls[3]!.reply.resolve({ items: [pendingEntry('mine')], next_cursor: null })
  expect(await screen.findByTestId('workspace-change-mine')).toBeInTheDocument()
  expect(screen.queryByTestId('workspace-change-theirs')).not.toBeInTheDocument()
  expect(screen.queryByTestId('workspace-change-old-scope')).not.toBeInTheDocument()
})

it('does not call an empty open batch saved and names removed-branch work exactly', async () => {
  const empty = workspaceRun({ id: 'empty-run', workspace_changes: [workspaceChange({ state: 'open', source_commit: 'a'.repeat(40), base_commit: 'a'.repeat(40) })] })
  vi.mocked(runsApi.get).mockResolvedValue(empty)
  const view = show([empty])
  expect(await screen.findByText('No saved difference')).toBeInTheDocument()
  expect(screen.queryByText(/Saved privately/)).not.toBeInTheDocument()
  view.unmount()
  const missing = { state: 'missing' as const, reason: 'branch_missing', reclaim_after: null, hold_until: null, reclaimed_at: null, assessed_at: null, retained_refs: 0, unclaimed_refs: 0 }
  const settled = workspaceRun({ id: 'settled-run', workspace_changes: [
    workspaceChange({ change_set_id: 'gone', workspace_id: 'other', state: 'open', retention: missing }),
  ] })
  vi.mocked(runsApi.get).mockResolvedValue(settled)
  show([settled])
  expect(await screen.findByText(/Branch removed · not merged/)).toBeInTheDocument()
  expect(screen.queryByText(/Saved privately/)).not.toBeInTheDocument()
})

it('lets live Run and batch facts outrank a recorded missing branch (restored, re-run, merging or blocked)', async () => {
  const missing = { state: 'missing' as const, reason: 'branch_missing', reclaim_after: null, hold_until: null, reclaimed_at: null, assessed_at: '2026-11-08T12:00:00Z', retained_refs: 0, unclaimed_refs: 0 }
  const cases: Array<[Partial<Run>, NonNullable<Parameters<typeof workspaceChange>[0]>, RegExp]> = [
    [{ status: 'running' }, { state: 'open', source_commit: null, retention: missing }, /Not saved yet/],
    [{}, { state: 'integrating', retention: missing }, /Merging/],
    [{}, { state: 'blocked', retention: missing }, /Needs your decision/],
  ]
  for (const [runFields, change, phrase] of cases) {
    const run = workspaceRun({ id: `stale-${change.state}`, ...runFields, workspace_changes: [workspaceChange(change)] })
    vi.mocked(runsApi.get).mockResolvedValue(run)
    const view = show([run])
    expect((await screen.findAllByText(phrase)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Branch removed · not merged/)).not.toBeInTheDocument()
    // A blocked batch keeps the record's explanation and its close action; live work does not repeat it.
    if (change.state !== 'blocked') expect(screen.queryByText(/Branch removed/)).not.toBeInTheDocument()
    view.unmount()
  }
})
