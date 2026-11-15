import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectAgentChatPage from '../agents/ProjectAgentChatPage'
import { agentsApi, ApiRequestError, projectsApi } from '../../../api/client'

vi.mock('../../../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
  },
  agentsApi: { get: vi.fn() },
  projectsApi: { get: vi.fn(), agent: vi.fn(), agents: vi.fn() },
}))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', userId: 'user-1' }),
}))
vi.mock('../../agents/ChatPanel', () => ({ default: () => <p>Chat panel</p> }))

const notOnList = 'This Agent is not on this Project’s list. Add it on the Agents page first.'

function renderChat() {
  return render(
    <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/agents/agent-250/chat']}>
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/agents/:agentId/chat" element={<ProjectAgentChatPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Project Agent chat page', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(agentsApi.get).mockResolvedValue({ id: 'agent-250', name: 'Late Reviewer' } as never)
    vi.mocked(projectsApi.get).mockResolvedValue({ id: 'project-1', name: 'Atlas' } as never)
  })

  it('asks the server about this one link, so an Agent past any first page is not refused', async () => {
    vi.mocked(projectsApi.agent).mockResolvedValue({ agent_id: 'agent-250' } as never)
    renderChat()
    expect(await screen.findByText('Chat panel')).toBeInTheDocument()
    expect(projectsApi.agent).toHaveBeenCalledWith('project-1', 'agent-250')
    expect(projectsApi.agents).not.toHaveBeenCalled()
    expect(screen.queryByText(notOnList)).not.toBeInTheDocument()
  })

  it('warns only when the server says the Agent is not on the list', async () => {
    vi.mocked(projectsApi.agent).mockRejectedValue(new ApiRequestError('Agent not found', 404))
    renderChat()
    expect(await screen.findByText(notOnList)).toBeInTheDocument()
  })

  it('does not claim the Agent is missing when the check itself failed', async () => {
    vi.mocked(projectsApi.agent).mockRejectedValue(new ApiRequestError('Bad gateway', 502))
    renderChat()
    expect(await screen.findByText('Chat panel')).toBeInTheDocument()
    expect(screen.queryByText(notOnList)).not.toBeInTheDocument()
  })
})
