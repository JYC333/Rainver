import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ContextArtifactPicker } from '../ContextArtifactPicker'
import { artifactsApi, contextApi } from '../../../api/client'
import type { Artifact } from '../../../types/api'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    activeSpaceName: 'Space One',
  }),
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../api/client', () => ({
  artifactsApi: {
    list: vi.fn(),
  },
  contextApi: {
    listArtifactRevocations: vi.fn(),
    revokeArtifact: vi.fn(),
    unrevokeArtifact: vi.fn(),
  },
}))

const briefArtifact: Artifact = {
  id: 'brief-1',
  space_id: 'space-1',
  run_id: null,
  proposal_id: null,
  artifact_type: 'retrieval_brief',
  surface_role: 'user_output',
  title: 'Brief artifact',
  mime_type: 'application/json',
  exportable: true,
  preview: false,
  storage_ref: null,
  storage_path: null,
  metadata_json: {},
  has_inline_content: true,
  visibility: 'private',
  owner_user_id: 'user-1',
  content: null,
  project_id: null,
  project_folder_id: 'workspace-1',
  created_at: '2026-06-26T10:00:00.000Z',
  updated_at: '2026-06-26T10:00:00.000Z',
}

describe('ContextArtifactPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(artifactsApi.list).mockImplementation(async (params = {}) => ({
      items: params.artifact_type === 'retrieval_brief' ? [briefArtifact] : [],
      total: params.artifact_type === 'retrieval_brief' ? 1 : 0,
      limit: 100,
      offset: 0,
    }))
    vi.mocked(contextApi.listArtifactRevocations).mockResolvedValue({ items: [] })
    vi.mocked(contextApi.revokeArtifact).mockResolvedValue({
      id: 'revocation-1',
      space_id: 'space-1',
      artifact_id: 'brief-1',
      scope_type: 'project_folder',
      scope_id: 'workspace-1',
      reason: null,
      created_by_user_id: 'user-1',
      created_at: '2026-06-26T10:00:00.000Z',
    })
  })

  it('attaches artifacts and revokes future Folder attachment', async () => {
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <ContextArtifactPicker
          selectedArtifactIds={['brief-1']}
          onChange={onChange}
          projectFolderId="workspace-1"
        />
      </MemoryRouter>,
    )

    expect((await screen.findAllByText('Brief artifact')).length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(contextApi.listArtifactRevocations).toHaveBeenCalledWith(expect.objectContaining({
        project_folder_id: 'workspace-1',
        artifact_ids: expect.arrayContaining(['brief-1']),
      }))
    })

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))

    await waitFor(() => {
      expect(contextApi.revokeArtifact).toHaveBeenCalledWith({
        artifact_id: 'brief-1',
        scope_type: 'project_folder',
        scope_id: 'workspace-1',
      })
    })
    expect(onChange).toHaveBeenCalledWith([])
  })
})
