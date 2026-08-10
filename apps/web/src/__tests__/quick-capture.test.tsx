import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { createActivity } = vi.hoisted(() => ({ createActivity: vi.fn().mockResolvedValue({}) }))

vi.mock('../api/client', () => ({
  activityApi: { create: createActivity },
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [
      { id: 'personal-1', name: 'My Personal', type: 'personal', role: 'owner', created_at: '', updated_at: '' },
      { id: 'team-1', name: 'Acme Team', type: 'team', role: 'member', created_at: '', updated_at: '' },
    ],
    personalSpaceId: 'personal-1',
    activeSpaceId: 'team-1',
    activeSpaceName: 'Acme Team',
  }),
}))

import { FloatingQuickCapture } from '../components/FloatingQuickCapture'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

describe('FloatingQuickCapture', () => {
  it('posts to the Personal Space independently of the active browsing Space', async () => {
    render(<MemoryRouter future={routerFuture}><FloatingQuickCapture /></MemoryRouter>)
    // Opens from the floating button.
    fireEvent.click(screen.getByLabelText('Quick capture'))
    expect(screen.getByText('Save to:')).toBeInTheDocument()
    expect(screen.getByText('Personal Space')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Capture a thought or paste a link…'), {
      target: { value: 'A private thought' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await waitFor(() => {
      expect(createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'A private thought' }),
        { spaceId: 'personal-1' },
      )
    })
  })
})
