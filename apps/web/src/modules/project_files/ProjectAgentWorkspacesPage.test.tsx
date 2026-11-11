import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentWorkspaceGroup, AgentWorkspaceItem } from '@rainver/protocol'
import { workspaceChange } from '../runs/workspaceFixtures.test-support'

vi.mock('../../api/client', async () => {
  const { ApiRequestError } = await import('../../test/apiClientMock')
  return { ApiRequestError, projectsApi: { streamUpdates:vi.fn(()=>new Promise<void>(()=>{})) }, agentWorkspacesApi: { groups: vi.fn(), list: vi.fn(), detail: vi.fn() }, callOperation: vi.fn(), runsApi: { get: vi.fn() } }
})
vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

import { projectsApi, agentWorkspacesApi, ApiRequestError } from '../../api/client'
import ProjectAgentWorkspacesPage from './ProjectAgentWorkspacesPage'

const item = (overrides: Partial<AgentWorkspaceItem> = {}): AgentWorkspaceItem => ({
  workspace_id: 'ws-1', generation: 1, owner_kind: 'conversation', work_state: 'attention',
  folder: { id: 'folder', name: 'repo' }, host: { name: 'Laptop', online: true },
  conversation: { id: 'session', title: 'Refactor login', room_id: 'room' }, task: null,
  agent: { id: 'agent', name: 'Builder' }, run: { id: 'run-1', status: 'failed' }, parent_workspace_id: null, batch_count: 2, retention: null,
  created_at: '2026-11-08T10:00:00Z', activity_at: '2026-11-08T12:00:00Z', ...overrides,
})
const group = (overrides: Partial<AgentWorkspaceGroup> = {}, current: AgentWorkspaceItem = item()): AgentWorkspaceGroup => ({
  group_key: `c:${current.conversation?.id ?? 'session'}:loc`, conversation: current.conversation, task: null, folder: current.folder, host: current.host,
  work_state: current.work_state, current, latest_result: null, issues: [], unconfirmed: [], unconfirmed_more: false, proven_duplicates: 0,
  workspace_count: 1, delegation_count: 0, batch_count: current.batch_count, activity_at: current.activity_at, ...overrides,
})
/** Serve groups from rows: one group per row, and the row as that group's history. */
function groupsFromRows(rows: AgentWorkspaceItem[]) {
  vi.mocked(agentWorkspacesApi.groups).mockResolvedValue({ items: [group({}, rows[0]!)], next_cursor: null })
  vi.mocked(agentWorkspacesApi.list).mockResolvedValue({ items: rows, next_cursor: null })
}
async function openHistory() { fireEvent.click(await screen.findByRole('button', { name: /Execution history/ })) }
const page = (path = '/projects/p/files/workspaces') => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/projects/:projectId/files/workspaces" element={<ProjectAgentWorkspacesPage />} /></Routes></MemoryRouter>)

beforeEach(() => { vi.clearAllMocks() })

it('lists current work with its conversation, Agent and state, and opens details with the safe controls', async () => {
  groupsFromRows([item()])
  vi.mocked(agentWorkspacesApi.detail).mockResolvedValue({ workspace_id: 'ws-1', items: [
    { change: workspaceChange({ state: 'blocked', integration_id: 'i', integration_revision: 2, integration_status: 'failed' }), run: { id: 'run-1', status: 'failed', agent_id: 'agent' } },
  ], next_cursor: null })
  page()
  expect(await screen.findByText('Refactor login')).toBeInTheDocument()
  expect(agentWorkspacesApi.groups).toHaveBeenCalledWith('p', { view: 'current' })
  expect(screen.getByText(/Builder · repo · Updated/)).toBeInTheDocument()
  expect(screen.getByText('Needs attention')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Conversation' })).toHaveAttribute('href', '/rooms/room?conversation=session')
  expect(screen.getByRole('link', { name: 'Run' })).toHaveAttribute('href', '/runs/run-1')
  // Batches and generations stay folded until the history is opened.
  expect(agentWorkspacesApi.list).not.toHaveBeenCalled()
  await openHistory()
  expect(agentWorkspacesApi.list).toHaveBeenCalledWith('p', { view: 'all', group: 'c:session:loc' })
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
  expect(await screen.findByRole('button', { name: 'Check whether already integrated' })).toBeInTheDocument()
  expect(agentWorkspacesApi.detail).toHaveBeenCalledWith('p', 'ws-1', {})
  expect(screen.getByText('Technical details')).toBeInTheDocument()
})

it('keeps history separate, pages with the server cursor and distinguishes empty, denied and failed reads', async () => {
  vi.mocked(agentWorkspacesApi.groups).mockImplementation(async (_project, params) => params.view === 'current'
    ? { items: [], next_cursor: null }
    : params.cursor ? { items: [group({}, item({ workspace_id: 'ws-2', work_state: 'merged', conversation: { id: 's2', title: 'Second', room_id: 'room' } }))], next_cursor: null }
    : { items: [group({}, item({ work_state: 'merged' }))], next_cursor: 'next' })
  page()
  expect(await screen.findByText('Nothing active or pending')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  expect(await screen.findByText('Refactor login')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  expect(await screen.findByText('Second')).toBeInTheDocument()
  expect(agentWorkspacesApi.groups).toHaveBeenLastCalledWith('p', { view: 'history', cursor: 'next' })
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
})

it('withdraws rows after a refusal and offers retry only for an ordinary failure', async () => {
  vi.mocked(agentWorkspacesApi.groups).mockRejectedValueOnce(new ApiRequestError('forbidden', 403))
  const view = page()
  expect(await screen.findByText('Not available')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  view.unmount()
  vi.mocked(agentWorkspacesApi.groups).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ items: [group()], next_cursor: null })
  page()
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.getByText('Refactor login')).toBeInTheDocument())
})

it('continues past an empty page that still has a cursor instead of reporting nothing', async () => {
  vi.mocked(agentWorkspacesApi.groups).mockImplementation(async (_project, params) => params.cursor
    ? { items: [group({}, item({ workspace_id: 'ws-9', conversation: { id: 's9', title: 'Later work', room_id: 'room' } }))], next_cursor: null }
    : { items: [], next_cursor: 'next' })
  page()
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
  expect(screen.queryByText('Nothing active or pending')).not.toBeInTheDocument()
  expect(await screen.findByText('Later work')).toBeInTheDocument()
})

it('pages a workspace detail with its cursor', async () => {
  groupsFromRows([item()])
  vi.mocked(agentWorkspacesApi.detail).mockImplementation(async (_p, _w, pageArgs) => pageArgs?.cursor
    ? { workspace_id: 'ws-1', items: [{ change: workspaceChange({ change_set_id: 'older', state: 'abandoned' }), run: { id: 'run-0', status: 'failed', agent_id: null } }], next_cursor: null }
    : { workspace_id: 'ws-1', items: [{ change: workspaceChange({ change_set_id: 'newer', state: 'open' }), run: { id: 'run-1', status: 'succeeded', agent_id: null } }], next_cursor: 'd2' })
  page()
  await openHistory()
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
  await screen.findByTestId('workspace-change-newer')
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  expect(await screen.findByTestId('workspace-change-older')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-change-newer')).toBeInTheDocument()
  expect(agentWorkspacesApi.detail).toHaveBeenLastCalledWith('p', 'ws-1', { cursor: 'd2' })
})

type GroupPage = Awaited<ReturnType<typeof agentWorkspacesApi.groups>>
function answerableList() {
  const calls: { view: string; cursor?: string; resolve: (page: { items: AgentWorkspaceItem[]; next_cursor: string | null }) => void }[] = []
  vi.mocked(agentWorkspacesApi.groups).mockImplementation((_project, params) => new Promise<GroupPage>(resolve => { calls.push({ view: params.view, cursor: params.cursor ?? undefined, resolve: rows => resolve({ items: rows.items.map(row => group({}, row)), next_cursor: rows.next_cursor }) }) }))
  return calls
}
const named = (id: string, title: string) => item({ workspace_id: id, conversation: { id: `s-${id}`, title, room_id: 'room' } })

it('switching view during Load more starts clean, re-enables paging and drops the late page of the old view', async () => {
  const calls = answerableList()
  page()
  await waitFor(() => expect(calls).toHaveLength(1))
  calls[0]!.resolve({ items: [named('c1', 'Current one')], next_cursor: 'cur-2' })
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]).toMatchObject({ view: 'current', cursor: 'cur-2' })
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'History' }), { button: 0 })
  await waitFor(() => expect(calls).toHaveLength(3))
  expect(calls[2]).toMatchObject({ view: 'history', cursor: undefined })
  // The current view's rows and cursor are not shown under History.
  expect(screen.queryByText('Current one')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  calls[2]!.resolve({ items: [named('h1', 'History one')], next_cursor: 'his-2' })
  await screen.findByText('History one')
  calls[1]!.resolve({ items: [named('c2', 'Current late')], next_cursor: null })
  const more = await screen.findByRole('button', { name: 'Load more' })
  await waitFor(() => expect(more).toBeEnabled())
  expect(screen.queryByText('Current late')).not.toBeInTheDocument()
  fireEvent.click(more)
  await waitFor(() => expect(calls).toHaveLength(4))
  expect(calls[3]).toMatchObject({ view: 'history', cursor: 'his-2' })
  calls[3]!.resolve({ items: [named('h2', 'History two')], next_cursor: null })
  expect(await screen.findByText('History two')).toBeInTheDocument()
})

it('groups delegated work under its main workspace in the history and keeps an orphaned delegation visible on its own', async () => {
  vi.mocked(agentWorkspacesApi.groups).mockResolvedValue({ items: [group({ workspace_count: 3, delegation_count: 2 }, item({ workspace_id: 'main', work_state: 'saved' }))], next_cursor: null })
  vi.mocked(agentWorkspacesApi.list).mockResolvedValue({ items: [
    item({ workspace_id: 'main', work_state: 'saved' }),
    item({ workspace_id: 'child', owner_kind: 'delegation', parent_workspace_id: 'main', work_state: 'unsaved', conversation: null, agent: { id: 'a2', name: 'Helper' } }),
    item({ workspace_id: 'orphan', owner_kind: 'delegation', parent_workspace_id: 'elsewhere', work_state: 'saved', conversation: null, agent: { id: 'a3', name: 'Reviewer' } }),
  ], next_cursor: null })
  page()
  await openHistory()
  const delegated = await screen.findByTestId('agent-workspace-delegations-main')
  expect(delegated).toContainElement(screen.getByTestId('agent-workspace-child'))
  expect(screen.getByText('1 delegated workspace')).toBeInTheDocument()
  expect(delegated).not.toContainElement(screen.getByTestId('agent-workspace-orphan'))
})

it('shows a removed branch as missing, never merged, and closes its records only after confirmation', async () => {
  const retention = { state: 'missing' as const, reason: 'branch_missing', reclaim_after: null, hold_until: null, reclaimed_at: null, assessed_at: '2026-11-08T12:00:00Z', retained_refs: 0, unclaimed_refs: 0 }
  groupsFromRows([item({ work_state: 'missing', retention })])
  vi.mocked(agentWorkspacesApi.detail).mockResolvedValue({ workspace_id: 'ws-1', items: [
    { change: workspaceChange({ state: 'open', source_commit: 'b'.repeat(40), base_commit: 'a'.repeat(40), retention, can_manage: true }), run: { id: 'run-1', status: 'succeeded', agent_id: 'agent' } },
  ], next_cursor: null })
  const { callOperation } = await import('../../api/client')
  vi.mocked(callOperation).mockResolvedValue({ status: 'succeeded', data: {} } as never)
  page()
  expect(await screen.findByText('Branch removed · not merged')).toBeInTheDocument()
  expect(screen.queryByText('Merged')).not.toBeInTheDocument()
  await openHistory()
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Close missing records' }))
  expect(callOperation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close records' }))
  await waitFor(() => expect(callOperation).toHaveBeenCalledWith('workspace.retention.update', { change_set_id: expect.any(String), action: 'acknowledge_missing' }, expect.any(String), expect.anything()))
})

it('updates added and closed workspaces on events, preserving paged rows and open details',async()=>{
 let changed:(frame:{type:'changed'})=>void=()=>{}
 vi.mocked(projectsApi.streamUpdates).mockImplementation(async(_p,emit)=>{changed=emit;await new Promise<void>(()=>{})})
 let updated=false
 vi.mocked(agentWorkspacesApi.groups).mockImplementation(async(_p,args)=>args.cursor
  ?{items:[group({},named('second','Second'))],next_cursor:null}
  :{items:[group({},named(updated?'new':'first',updated?'New work':'First'))],next_cursor:'page-2'})
 vi.mocked(agentWorkspacesApi.list).mockImplementation(async(_p,args)=>({items:[args.group==='c:s-second:loc'?named('second','Second'):named('first','First')],next_cursor:null}))
 vi.mocked(agentWorkspacesApi.detail).mockImplementation(async(_p,id)=>({workspace_id:id,items:[{change:workspaceChange({change_set_id:'second-change',workspace_id:id,summary:updated?'Changed in another tab':'Old summary'}),run:{id:'run-2',status:'succeeded',agent_id:null}}],next_cursor:null}))
 page();await screen.findByText('First');fireEvent.click(screen.getByRole('button',{name:'Load more'}));await screen.findByText('Second')
 fireEvent.click(screen.getAllByRole('button',{name:/Execution history/})[1]!)
 fireEvent.click(await screen.findByRole('button',{name:'Details'}));await screen.findByText('Old summary')
 updated=true;changed({type:'changed'})
 await screen.findByText('New work');await screen.findByText('Changed in another tab')
 expect(screen.queryByText('First')).not.toBeInTheDocument();expect(screen.getAllByText('Second').length).toBeGreaterThan(0)
 expect(screen.getByRole('button',{name:'Hide details'})).toBeInTheDocument()
})
it('labels acknowledged removed branches as closed history rather than not-merged attention',async()=>{
 const retention={state:'missing' as const,reason:'missing_acknowledged',reclaim_after:null,hold_until:null,reclaimed_at:null,assessed_at:null,retained_refs:0,unclaimed_refs:0}
 groupsFromRows([item({work_state:'missing_closed',retention})])
 page('/projects/p/files/workspaces?view=history')
 await screen.findByText('Refactor login')
 await openHistory()
 await screen.findByTestId('agent-workspace-ws-1')
 expect(screen.getAllByText('Closed · branch was removed').length).toBeGreaterThan(0)
 expect(screen.queryByText(/Branch removed outside Rainver/)).not.toBeInTheDocument()
 expect(screen.getByText(/Closed and reclaimed workspaces are no longer active/)).toBeInTheDocument()
})

it('shows the latest result, the open problems and unconfirmed saved work, folding only proven duplicates', async () => {
  const commit = 'c'.repeat(40)
  vi.mocked(agentWorkspacesApi.groups).mockResolvedValue({ items: [group({
    work_state: 'saved', workspace_count: 4, delegation_count: 2, batch_count: 7, proven_duplicates: 2,
    latest_result: { change_set_id: 'cs-1', workspace_id: 'ws-1', state: 'integrated', landing: 'target', source_commit: 'a'.repeat(40), agent: { id: 'agent', name: 'Builder' }, run: { id: 'run-1', status: 'succeeded' }, activity_at: '2026-11-08T12:00:00Z' },
    issues: [{ kind: 'unconfirmed', count: 1 }],
    unconfirmed: [{ change_set_id: 'cs-2', workspace_id: 'ws-child', generation: 1, owner_kind: 'delegation', reason: 'saved_not_merged', source_commit: commit, same_commit_count: 1, agent: { id: 'a2', name: 'Helper' }, run: { id: 'run-child', status: 'succeeded' }, activity_at: '2026-11-08T11:00:00Z' }],
  }, item({ work_state: 'saved' }))], next_cursor: null })
  page()
  expect(await screen.findByTestId('agent-workspace-latest-result')).toHaveTextContent(/Latest result:\s*Merged\s*aaaaaaa/)
  expect(screen.getByText('1 saved change to check')).toBeInTheDocument()
  const unconfirmed = screen.getByRole('region', { name: '1 saved change not confirmed as merged' })
  expect(unconfirmed).toHaveTextContent('Saved, not merged')
  expect(unconfirmed).toHaveTextContent('ccccccc')
  expect(unconfirmed).toHaveTextContent('+1 at the same commit')
  expect(screen.getByText('2 saved batches are folded away: the same commit already landed.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Execution history (4 workspaces · 7 batches)' })).toHaveAttribute('aria-expanded', 'false')
})
