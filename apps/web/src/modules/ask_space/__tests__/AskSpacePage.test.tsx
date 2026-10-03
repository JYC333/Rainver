import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AskSpacePage from '../AskSpacePage'
import { askSpaceApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', preferredSpaceId: 'space-1' }),
}))

vi.mock('../../../api/client', () => ({
  askSpaceApi: { think: vi.fn() },
  knowledgeApi: { claimCandidatePacket: vi.fn(), maintenanceScan: vi.fn() },
}))

describe('AskSpacePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends one question while it is in flight, however often Enter is pressed', () => {
    vi.mocked(askSpaceApi.think).mockImplementation(() => new Promise(() => {}))
    render(<MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}><AskSpacePage /></MemoryRouter>)
    const question = screen.getByPlaceholderText(/What do you want to know/)
    fireEvent.change(question, { target: { value: 'What did we decide?' } })

    fireEvent.keyDown(question, { key: 'Enter' })
    fireEvent.keyDown(question, { key: 'Enter' })

    expect(askSpaceApi.think).toHaveBeenCalledTimes(1)
  })
})
