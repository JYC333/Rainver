import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ArtifactDetailPage from '../ArtifactDetailPage'
import { artifactsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Research Space' }) }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link> }
})
vi.mock('../../../components/ContentAccessControl', () => ({ ContentAccessControl: () => <button>Permissions</button> }))
vi.mock('../../../api/client', () => ({ artifactsApi: { get: vi.fn(), export: vi.fn() } }))

describe('ArtifactDetailPage', () => {
  beforeEach(() => {
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
})
