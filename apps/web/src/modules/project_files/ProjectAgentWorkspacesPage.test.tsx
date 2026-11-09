import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentWorkspaceItem } from '@rainver/protocol'
import { workspaceChange } from '../runs/workspaceFixtures.test-support'

vi.mock('../../api/client', async () => {
  const { ApiRequestError } = await import('../../test/apiClientMock')
  return { ApiRequestError, agentWorkspacesApi: { list: vi.fn(), detail: vi.fn() }, callOperation: vi.fn(), runsApi: { get: vi.fn() } }
})
vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

import { agentWorkspacesApi, ApiRequestError } from '../../api/client'
import ProjectAgentWorkspacesPage from './ProjectAgentWorkspacesPage'

const item = (overrides: Partial<AgentWorkspaceItem> = {}): AgentWorkspaceItem => ({
  workspace_id: 'ws-1', generation: 1, owner_kind: 'conversation', work_state: 'attention',
  folder: { id: 'folder', name: 'repo' }, host: { name: 'Laptop', online: true },
  conversation: { id: 'session', title: 'Refactor login', room_id: 'room' }, task: null,
  agent: { id: 'agent', name: 'Builder' }, run: { id: 'run-1', status: 'failed' }, batch_count: 2, retention: null,
  created_at: '2026-11-08T10:00:00Z', activity_at: '2026-11-08T12:00:00Z', ...overrides,
})
const page = (path = '/projects/p/files/workspaces') => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/projects/:projectId/files/workspaces" element={<ProjectAgentWorkspacesPage />} /></Routes></MemoryRouter>)

beforeEach(() => { vi.clearAllMocks() })

it('lists current work with its conversation, Agent and state, and opens details with the safe controls', async () => {
  vi.mocked(agentWorkspacesApi.list).mockResolvedValue({ items: [item()], next_cursor: null })
  vi.mocked(agentWorkspacesApi.detail).mockResolvedValue({ workspace_id: 'ws-1', items: [
    { change: workspaceChange({ state: 'blocked', integration_id: 'i', integration_revision: 2, integration_status: 'failed' }), run: { id: 'run-1', status: 'failed', agent_id: 'agent' } },
  ], next_cursor: null })
  page()
  expect(await screen.findByText('Refactor login')).toBeInTheDocument()
  expect(agentWorkspacesApi.list).toHaveBeenCalledWith('p', { view: 'current' })
  expect(screen.getByText(/Builder · repo · Updated/)).toBeInTheDocument()
  expect(screen.getByText('Needs attention')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Conversation' })).toHaveAttribute('href', '/rooms/room?conversation=session')
  expect(screen.getByRole('link', { name: 'Run' })).toHaveAttribute('href', '/runs/run-1')
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(await screen.findByRole('button', { name: 'Check whether already integrated' })).toBeInTheDocument()
  expect(agentWorkspacesApi.detail).toHaveBeenCalledWith('p', 'ws-1', {})
  expect(screen.getByText('Technical details')).toBeInTheDocument()
})

it('keeps history separate, pages with the server cursor and distinguishes empty, denied and failed reads', async () => {
  vi.mocked(agentWorkspacesApi.list).mockImplementation(async (_project, params) => params.view === 'current'
    ? { items: [], next_cursor: null }
    : params.cursor ? { items: [item({ workspace_id: 'ws-2', work_state: 'merged', conversation: { id: 's2', title: 'Second', room_id: 'room' } })], next_cursor: null }
    : { items: [item({ work_state: 'merged' })], next_cursor: 'next' })
  page()
  expect(await screen.findByText('Nothing active or pending')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  expect(await screen.findByText('Refactor login')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  expect(await screen.findByText('Second')).toBeInTheDocument()
  expect(agentWorkspacesApi.list).toHaveBeenLastCalledWith('p', { view: 'history', cursor: 'next' })
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
})

it('withdraws rows after a refusal and offers retry only for an ordinary failure', async () => {
  vi.mocked(agentWorkspacesApi.list).mockRejectedValueOnce(new ApiRequestError('forbidden', 403))
  const view = page()
  expect(await screen.findByText('Not available')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  view.unmount()
  vi.mocked(agentWorkspacesApi.list).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ items: [item()], next_cursor: null })
  page()
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.getByText('Refactor login')).toBeInTheDocument())
})

it('continues past an empty page that still has a cursor instead of reporting nothing', async () => {
  vi.mocked(agentWorkspacesApi.list).mockImplementation(async (_project, params) => params.cursor
    ? { items: [item({ workspace_id: 'ws-9', conversation: { id: 's9', title: 'Later work', room_id: 'room' } })], next_cursor: null }
    : { items: [], next_cursor: 'next' })
  page()
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
  expect(screen.queryByText('Nothing active or pending')).not.toBeInTheDocument()
  expect(await screen.findByText('Later work')).toBeInTheDocument()
})

it('pages a workspace detail with its cursor', async () => {
  vi.mocked(agentWorkspacesApi.list).mockResolvedValue({ items: [item()], next_cursor: null })
  vi.mocked(agentWorkspacesApi.detail).mockImplementation(async (_p, _w, pageArgs) => pageArgs?.cursor
    ? { workspace_id: 'ws-1', items: [{ change: workspaceChange({ change_set_id: 'older', state: 'abandoned' }), run: { id: 'run-0', status: 'failed', agent_id: null } }], next_cursor: null }
    : { workspace_id: 'ws-1', items: [{ change: workspaceChange({ change_set_id: 'newer', state: 'open' }), run: { id: 'run-1', status: 'succeeded', agent_id: null } }], next_cursor: 'd2' })
  page()
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
  await screen.findByTestId('workspace-change-newer')
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  expect(await screen.findByTestId('workspace-change-older')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-change-newer')).toBeInTheDocument()
  expect(agentWorkspacesApi.detail).toHaveBeenLastCalledWith('p', 'ws-1', { cursor: 'd2' })
})

type ListPage = Awaited<ReturnType<typeof agentWorkspacesApi.list>>
function answerableList() {
  const calls: { view: string; cursor?: string; resolve: (page: ListPage) => void }[] = []
  vi.mocked(agentWorkspacesApi.list).mockImplementation((_project, params) => new Promise<ListPage>(resolve => { calls.push({ view: params.view, cursor: params.cursor ?? undefined, resolve }) }))
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
