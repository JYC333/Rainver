import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ArtifactDetailPage from '../ArtifactDetailPage'
import { ApiRequestError, artifactsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Research Space' }) }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link> }
})
vi.mock('../../../components/ContentAccessControl', () => ({ ContentAccessControl: () => <button>Permissions</button> }))
vi.mock('../../../api/client', async importOriginal => ({
  ApiRequestError: (await importOriginal<typeof import('../../../api/client')>()).ApiRequestError,
  artifactsApi: { get: vi.fn(), export: vi.fn() },
}))

describe('ArtifactDetailPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(artifactsApi.get).mockResolvedValue({
      id: 'archive-1', space_id: 'space-1', run_id: 'run-1', proposal_id: null,
      artifact_type: 'research_report.archive.v1', surface_role: 'system_archive', title: 'Research report archive', mime_type: 'application/json',
      exportable: true, preview: false, storage_ref: null, storage_path: null, has_inline_content: true,
      content: '{"summary":"This must not be rendered"}', project_id: 'project-1', project_folder_id: null,
      created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T01:00:00.000Z',
    })
  })

  it('shows only audit, permission, run, and export information for a system archive', async () => {
    render(<MemoryRouter initialEntries={['/artifacts/archive-1']}><Routes><Route path="/artifacts/:artifactId" element={<ArtifactDetailPage/>}/></Routes></MemoryRouter>)
    expect(await screen.findByText('Research report archive')).toBeInTheDocument()
    expect(screen.getByText('system archive')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', '/runs/run-1')
    expect(screen.getByRole('button', { name: 'Permissions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
    expect(screen.queryByText('This must not be rendered')).not.toBeInTheDocument()
  })

  it('clears the stale artifact when export reports revoked access', async () => {
    vi.mocked(artifactsApi.export).mockRejectedValue(new ApiRequestError('Access denied', 404))
    render(<MemoryRouter initialEntries={['/artifacts/archive-1']}><Routes><Route path="/artifacts/:artifactId" element={<ArtifactDetailPage/>}/></Routes></MemoryRouter>)
    const button = await screen.findByRole('button', { name: 'Export' })
    vi.mocked(artifactsApi.get).mockRejectedValue(new ApiRequestError('Access denied', 404))
    fireEvent.click(button)
    expect(await screen.findByText('Artifact not found or not accessible.')).toBeInTheDocument()
    expect(screen.queryByText('Research report archive')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument()
  })

  it('refreshes a downgraded artifact to readable summary metadata with export disabled', async () => {
    vi.mocked(artifactsApi.export).mockRejectedValue(Object.assign(new Error('Access denied'), { status: 404 }))
    render(<MemoryRouter initialEntries={['/artifacts/archive-1']}><Routes><Route path="/artifacts/:artifactId" element={<ArtifactDetailPage/>}/></Routes></MemoryRouter>)
    const button = await screen.findByRole('button', { name: 'Export' })
    const initial = await vi.mocked(artifactsApi.get).mock.results[0]!.value
    vi.mocked(artifactsApi.get).mockResolvedValue({ ...initial, exportable: false, content: null })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled())
    expect(screen.getByText('Research report archive')).toBeInTheDocument()
  })

  it('ignores an old export rejection after navigating to another artifact', async () => {
    let reject!: (reason: Error) => void
    vi.mocked(artifactsApi.export).mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    const router = createMemoryRouter([{ path: '/artifacts/:artifactId', element: <ArtifactDetailPage /> }], { initialEntries: ['/artifacts/archive-1'] })
    render(<RouterProvider router={router} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }))
    const initial = await vi.mocked(artifactsApi.get).mock.results[0]!.value
    vi.mocked(artifactsApi.get).mockResolvedValue({ ...initial, id: 'archive-2', title: 'Current archive' })
    await act(async () => { await router.navigate('/artifacts/archive-2') })
    expect(await screen.findByText('Current archive')).toBeInTheDocument()
    await act(async () => { reject(Object.assign(new Error('Access denied'), { status: 404 })) })
    expect(screen.getByText('Current archive')).toBeInTheDocument()
    expect(artifactsApi.get).toHaveBeenCalledTimes(2)
  })

  it('distinguishes an unavailable detail read from an inaccessible artifact', async () => {
    vi.mocked(artifactsApi.get).mockRejectedValue(new Error('Service unavailable'))
    render(<MemoryRouter initialEntries={['/artifacts/archive-1']}><Routes><Route path="/artifacts/:artifactId" element={<ArtifactDetailPage/>}/></Routes></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Artifact unavailable: Service unavailable')
    expect(screen.queryByText('Artifact not found.')).not.toBeInTheDocument()
  })
})
