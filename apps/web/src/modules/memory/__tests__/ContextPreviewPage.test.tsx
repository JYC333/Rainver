import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import ContextPreviewPage from '../ContextPreviewPage'
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
    build: vi.fn(),
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/context?artifact_id=brief-1&project_folder_id=workspace-1']}>
      <ContextPreviewPage />
    </MemoryRouter>,
  )
}

describe('ContextPreviewPage artifact attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(artifactsApi.list).mockImplementation(async (params = {}) => ({
      items: params.artifact_type === 'retrieval_brief' ? [briefArtifact] : [],
      total: params.artifact_type === 'retrieval_brief' ? 1 : 0,
      limit: 100,
      offset: 0,
    }))
    vi.mocked(contextApi.build).mockResolvedValue({
      user_memory: [],
      project_folder_memory: [],
      capability_memory: [],
      agent_memory: [],
      system_policy: [],
      relevant_episodes: [],
      recent_session_summary: [],
      attachments: [
        {
          attachment_type: 'artifact_evidence_pack',
          artifact_id: 'brief-1',
          artifact_type: 'retrieval_brief',
          label: 'Brief artifact',
          approved: true,
          source_policy_snapshot: {
            source_connection_ids: ['source-1'],
            current_reader_gate: { allowed: true },
          },
        },
      ],
    })
    vi.mocked(contextApi.listArtifactRevocations).mockResolvedValue({ items: [] })
  })

  it('loads attachable artifacts by type and sends selected ids into context build', async () => {
    renderPage()

    expect((await screen.findAllByText('Brief artifact')).length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(artifactsApi.list).toHaveBeenCalledWith(expect.objectContaining({
        artifact_type: 'retrieval_brief',
        project_folder_id: 'workspace-1',
      }))
    })

    fireEvent.click(screen.getByRole('button', { name: /build context/i }))

    await waitFor(() => {
      expect(contextApi.build).toHaveBeenCalledWith(expect.objectContaining({
        project_folder_id: 'workspace-1',
        project_id: null,
        context_artifact_ids: ['brief-1'],
      }))
    })
    expect(await screen.findByText('Source policy snapshot')).toBeInTheDocument()
    expect(screen.getAllByText(/source-1/).length).toBeGreaterThan(0)
  })
})
