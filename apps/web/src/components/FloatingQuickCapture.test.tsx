import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { FloatingQuickCapture } from './FloatingQuickCapture'

const fixtures = vi.hoisted(() => ({
  spaceId: 'space-a',
  projectId: 'project-a',
  create: vi.fn(),
}))

vi.mock('../api/client', () => ({ captureApi: { create: fixtures.create } }))
vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaces: [], activeSpaceId: fixtures.spaceId, personalSpaceId: 'personal' }),
}))
vi.mock('../contexts/CaptureContext', () => ({
  useProjectCaptureContext: () => ({ projectId: fixtures.projectId, target: null }),
}))

it('restores the draft only in its original Space and Project', async () => {
  fixtures.create.mockResolvedValue({ space_id: 'space-a', activity_id: 'capture-1' })
  const page = () => <MemoryRouter><FloatingQuickCapture /></MemoryRouter>
  const { rerender } = render(page())
  fireEvent.click(screen.getByRole('button', { name: 'Quick capture' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://example.test/research' } })

  fixtures.spaceId = 'space-b'
  fixtures.projectId = 'project-b'
  rerender(page())
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(screen.getByRole('button', { name: 'Capture' })).toBeDisabled()

  fixtures.spaceId = 'space-a'
  fixtures.projectId = 'project-a'
  rerender(page())
  expect(screen.getByRole('textbox')).toHaveValue('https://example.test/research')
  fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
  await waitFor(() => expect(fixtures.create).toHaveBeenCalledWith({
    text: 'https://example.test/research', destination: 'project_raw', project_id: 'project-a',
  }, undefined, 'space-a'))
})
