import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomsIndex } from '../RoomsIndex'
import { projectsApi } from '../../../api/client'
import type { ProjectRoomSummary, Room } from '../../../types/api'

vi.mock('../../../api/client', () => ({
  projectsApi: { rooms: vi.fn(), conversations: vi.fn() },
}))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', userId: 'user-1' }),
}))

type RoomsPage = Awaited<ReturnType<typeof projectsApi.rooms>>
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const room = (id: string, projectId: string, title: string): ProjectRoomSummary => ({
  room: {
    id, space_id: 'space-1', project_id: projectId, project_folder_id: null, created_by_user_id: 'user-1', title,
    status: 'active', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', archived_at: null, is_mainline: false,
  } as Room,
  other_member_names: [], person_count: 1, agent_count: 0, conversation_count: 0, last_activity_at: null,
})
const page = (items: ProjectRoomSummary[], total: number): RoomsPage => ({ items, total, limit: 50, offset: 0, viewer_can_write: false })
const view = (projectId: string) => (
  <MemoryRouter><RoomsIndex projectId={projectId} projectName="Atlas" onRoomOpened={() => undefined} /></MemoryRouter>
)

describe('Rooms index paging', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(projectsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 3, offset: 0 } as never)
  })

  it('clears the previous Project at once and never appends its late page to the next one', async () => {
    const lateMore = deferred<RoomsPage>()
    const next = deferred<RoomsPage>()
    vi.mocked(projectsApi.rooms).mockImplementation(async (projectId, params = {}) => {
      if (projectId === 'project-2') return next.promise
      if (params.offset) return lateMore.promise
      return page([room('room-a', 'project-1', 'Alpha')], 2)
    })
    const { rerender } = render(view('project-1'))
    expect(await screen.findByTestId('room-card-room-a')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    rerender(view('project-2'))
    await waitFor(() => expect(screen.queryByTestId('room-card-room-a')).not.toBeInTheDocument())
    lateMore.resolve(page([room('room-late', 'project-1', 'Late')], 2))
    next.resolve(page([room('room-b', 'project-2', 'Beta')], 1))
    expect(await screen.findByTestId('room-card-room-b')).toBeInTheDocument()
    expect(screen.queryByTestId('room-card-room-late')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('appends the next page of the same Project once, even when asked twice', async () => {
    const more = deferred<RoomsPage>()
    vi.mocked(projectsApi.rooms).mockImplementation(async (_projectId, params = {}) =>
      params.offset ? more.promise : page([room('room-a', 'project-1', 'Alpha')], 2))
    render(view('project-1'))
    await screen.findByTestId('room-card-room-a')
    const button = screen.getByRole('button', { name: 'Load more' })
    fireEvent.click(button)
    fireEvent.click(button)
    more.resolve(page([room('room-b', 'project-1', 'Beta')], 2))
    expect(await screen.findByTestId('room-card-room-b')).toBeInTheDocument()
    expect(vi.mocked(projectsApi.rooms).mock.calls.filter(([, params]) => params?.offset)).toHaveLength(1)
  })
})
