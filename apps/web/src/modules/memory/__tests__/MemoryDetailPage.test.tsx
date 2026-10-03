import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import MemoryDetailPage from '../MemoryDetailPage'
import { memoryApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))
vi.mock('../../../api/client', () => ({
  memoryApi: { get: vi.fn(), versions: vi.fn(), delete: vi.fn(), restore: vi.fn() },
}))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'user-1' } }),
}))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('../../../components/ContentAccessControl', () => ({ ContentAccessControl: () => null }))

function memoryRow(over: Record<string, unknown>) {
  return {
    id: 'memory-2', space_id: 'space-1', owner_user_id: 'user-1', title: 'Meeting times',
    content: 'Prefers morning meetings', type: 'semantic', scope: 'user', namespace: 'user.default',
    status: 'active', visibility: 'private', access_level: 'full', confidence: 1, importance: 0.5,
    created_by: 'user', agent_id: null, version: 2, tags: null,
    created_at: '2026-08-26T00:00:00.000Z', updated_at: '2026-08-26T00:00:00.000Z', deleted_at: null,
    ...over,
  }
}
const version = (memory: Record<string, unknown>) => ({
  memory, rationale: null, session_id: null, run_id: null, written_by_agent_id: null,
})
const v1 = memoryRow({ id: 'memory-1', version: 1, status: 'superseded', content: 'Prefers afternoons' })
const v2 = memoryRow({})

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/memory/memory-2']}>
      <Routes>
        <Route path="/memory/:memoryId" element={<MemoryDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

// ADR 0003 §2: once the newer version is archived, one action restores the
// older one. That action lives in this page's history, so archiving here
// must show it without a reload.
describe('MemoryDetailPage history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(memoryApi.get).mockResolvedValue(v2 as never)
    vi.mocked(memoryApi.versions).mockResolvedValue({ items: [version(v1), version(v2)] } as never)
  })

  it('offers to restore the earlier version as soon as the current one is archived', async () => {
    const archived = memoryRow({ status: 'archived' })
    vi.mocked(memoryApi.delete).mockImplementation(async () => {
      vi.mocked(memoryApi.get).mockResolvedValue(archived as never)
      vi.mocked(memoryApi.versions).mockResolvedValue({ items: [version(v1), version(archived)] } as never)
      return archived as never
    })
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Meeting times' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore this version' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }))

    expect(await screen.findByRole('button', { name: 'Restore this version' })).toBeInTheDocument()
    expect(memoryApi.delete).toHaveBeenCalledWith('memory-2')
  })
})
