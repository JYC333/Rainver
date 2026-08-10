import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'personal-1', preferredSpaceId: 'personal-1' }),
}))
vi.mock('../../../../api/client', () => ({
  notesApi: { jot: vi.fn() },
}))

import { ProjectQuickCapture } from '../ProjectQuickCapture'
import {
  ProjectCaptureTargetProvider,
  useDeclareProjectCaptureTarget,
  type ProjectCaptureTarget,
} from '../projectCaptureTarget'
import { notesApi } from '../../../../api/client'

function Area({ target }: { target: ProjectCaptureTarget | null }) {
  useDeclareProjectCaptureTarget(target)
  return <div>area</div>
}

function renderCapture(target: ProjectCaptureTarget | null = null) {
  return render(
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <ProjectCaptureTargetProvider>
        <Area target={target} />
        <ProjectQuickCapture projectId="project-1" />
      </ProjectCaptureTargetProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(notesApi.jot).mockResolvedValue({ id: 'note-1', title: 'Project inbox' } as never)
})

/**
 * U11's two shapes. What matters is not that the box exists but that the user
 * is told *where the text lands* before typing — a capture affordance whose
 * destination is a guess is one people stop trusting.
 */
describe('project quick capture', () => {
  it('captures to the project inbox when the Area is about nothing in particular', async () => {
    renderCapture(null)

    fireEvent.click(screen.getByRole('button', { name: 'Capture a note' }))
    expect(screen.getByText(/inbox note/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Capture a note'), { target: { value: 'Batching is suspect.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))

    await waitFor(() => expect(notesApi.jot).toHaveBeenCalledWith({
      text: 'Batching is suspect.',
      project_id: 'project-1',
    }))
    // No target_id at all, rather than a null one: the server reads its absence.
    expect(vi.mocked(notesApi.jot).mock.calls[0]![0]).not.toHaveProperty('target_id')
  })

  it('hangs the capture on what the Area declared it is about', async () => {
    renderCapture({ objectId: 'thread-7', title: 'Does batching help?' })

    fireEvent.click(screen.getByRole('button', { name: 'Capture a note' }))
    expect(screen.getByText('Does batching help?')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Capture a note'), { target: { value: 'Check the p99.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))

    await waitFor(() => expect(notesApi.jot).toHaveBeenCalledWith({
      text: 'Check the p99.',
      project_id: 'project-1',
      target_id: 'thread-7',
    }))
  })

  it('sends on Enter and keeps Shift+Enter for a newline', async () => {
    renderCapture(null)
    fireEvent.click(screen.getByRole('button', { name: 'Capture a note' }))
    const input = screen.getByLabelText('Capture a note')
    fireEvent.change(input, { target: { value: 'Quick one.' } })

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(notesApi.jot).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(notesApi.jot).toHaveBeenCalledTimes(1))
  })

  it('says where the capture went, so it is not a write into the void', async () => {
    renderCapture(null)
    fireEvent.click(screen.getByRole('button', { name: 'Capture a note' }))
    fireEvent.change(screen.getByLabelText('Capture a note'), { target: { value: 'A thought.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))

    const link = await screen.findByRole('link', { name: 'Project inbox' })
    expect(link).toHaveAttribute('href', '/spaces/personal-1/projects/project-1/notes/note-1')
  })

  it('stops declaring a target when the Area that declared it goes away', async () => {
    const { rerender } = renderCapture({ objectId: 'thread-7', title: 'Does batching help?' })
    rerender(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <ProjectCaptureTargetProvider>
          <ProjectQuickCapture projectId="project-1" />
        </ProjectCaptureTargetProvider>
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Capture a note' }))
    expect(screen.getByText(/inbox note/i)).toBeInTheDocument()
    expect(screen.queryByText('Does batching help?')).not.toBeInTheDocument()
  })
})
